// An offline stand-in for NEAR testnet RPC, the v2 market contract, the
// mock token and the exchange server, sufficient to drive the controller.
// Market rules follow src/lib.rs; proofs are replaced by a deterministic
// digest of the public inputs so binding mistakes still fail.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions';
import { fromBase58, fromBase64, fromUtf8, sha256, toBase58, toBase64, utf8 } from '../bytes.js';
import { decryptWitness, rawToSpki } from '../envelope.js';
import * as M from '../model.js';
import { TESTNET_RPC } from '../rpc.js';

export const IDS = {
  market: 'market.demo.testnet', token: 'token.demo.testnet', trader: 'trader-1.demo.testnet',
  maker: 'maker.demo.testnet', oracle: 'oracle.demo.testnet', keeperA: 'keeper-a.demo.testnet',
  keeperB: 'keeper-b.demo.testnet',
};

export const fakeProof = async (...parts) => toBase64(await sha256(utf8('proof:' + JSON.stringify(parts))));

class Fail extends Error {}
const require = (cond, code) => {
  if (!cond) throw new Fail(code);
};

export async function createWorld() {
  const deploymentId = new Uint8Array(32).fill(9);
  const market = await M.marketId(deploymentId, IDS.market);
  const keepers = [0, 1].map(() => {
    const enc = x25519.utils.randomSecretKey();
    const ack = ed25519.utils.randomSecretKey();
    return { enc, encSpki: toBase64(rawToSpki(x25519.getPublicKey(enc))), ack, ackPub: ed25519.getPublicKey(ack) };
  });
  const w = {
    height: 1000,
    txs: new Map(),
    keys: new Map(), // `${account}|${pk}` -> nonce
    balances: new Map([[IDS.market, 0], [IDS.maker, 0]]),
    ledger: {
      trader_available: 0, trader_locked: 0, maker_vault: 200_000, maker_reserved: 0,
      keeper_available: [0, 0], pending_withdrawals: 0, bad_debt: 0, halted: false, next_nonce: 1,
    },
    oracle: null, pending: null, active: null,
    keepers, market, deploymentId,
    calls: [], serverBodies: [], hooks: {},
  };
  w.balances.set(IDS.market, 200_000);

  const config = {
    token_id: IDS.token, trader_id: IDS.trader, maker_id: IDS.maker, oracle_id: IDS.oracle,
    keepers: [
      { account_id: IDS.keeperA, ack_key: toBase64(keepers[0].ackPub) },
      { account_id: IDS.keeperB, ack_key: toBase64(keepers[1].ackPub) },
    ],
    deployment_id: toBase64(deploymentId), key_version: 1,
    open_vk_sha256: toBase64(new Uint8Array(32).fill(1)),
    liquidation_vk_sha256: toBase64(new Uint8Array(32).fill(2)),
    close_vk_sha256: toBase64(new Uint8Array(32).fill(3)),
  };
  w.config = config;

  const slotView = (s) => s && ({
    nonce: s.nonce, commitment: s.commitment, quote_terms: s.quote_terms,
    open_price_ticks: s.open_price_ticks, funding_checkpoint: s.funding_checkpoint, ciphertexts: s.ciphertexts,
  });
  const fresh = () => {
    require(w.oracle, 'ERR_NO_ORACLE');
    require(w.height - w.oracle.height <= M.ORACLE_FRESHNESS_BLOCKS, 'ERR_ORACLE_STALE');
    return w.oracle;
  };
  const context = async (slot) => toBase64(await M.positionContext(market, slot.nonce, slot.funding_checkpoint, IDS.trader));

  const views = {
    [IDS.market]: {
      get_config: () => config,
      get_market: () => toBase64(market),
      get_ledger: () => structuredClone(w.ledger),
      get_oracle: () => w.oracle && { ...w.oracle },
      get_active: () => slotView(w.active),
      get_pending: () => slotView(w.pending),
      get_quote: () => (w.pending?.expires_at ? { ...slotView(w.pending), ciphertexts: undefined, expires_at: w.pending.expires_at } : null),
    },
    [IDS.token]: {
      ft_balance_of: ({ account_id }) => String(w.balances.get(account_id) ?? 0),
      ft_metadata: () => ({ symbol: 'mUSDC', decimals: 2 }),
    },
  };

  async function settle(kind, caller, { nonce, root, round, refund, bad_debt, proof }) {
    require(w.active, 'ERR_NO_ACTIVE');
    require(w.active.nonce === nonce && w.active.commitment === root, 'ERR_ACTIVE_MISMATCH');
    const o = fresh();
    require(o.round === round, 'ERR_ROUND_MISMATCH');
    const delta = o.funding_cents - w.active.funding_checkpoint;
    require(proof === await fakeProof(kind, root, await context(w.active), round, o.price_ticks, delta, refund, bad_debt),
      'ERR_PROOF_INVALID');
    const bounty = kind === 'liquidation' ? M.BOUNTY_CENTS : 0;
    const l = w.ledger;
    l.trader_locked -= M.ESCROW_CENTS;
    l.trader_available += refund;
    l.maker_vault = l.maker_vault + M.ESCROW_CENTS - refund - bounty;
    l.maker_reserved -= M.MAKER_RESERVE_CENTS;
    if (bounty) l.keeper_available[caller === IDS.keeperA ? 0 : 1] += bounty;
    w.active = null;
  }

  const methods = {
    [IDS.token]: {
      async ft_transfer_call(caller, { receiver_id, amount, msg }, deposit) {
        require(deposit === 1n, 'ERR_ONE_YOCTO');
        const cents = Number(amount);
        require((w.balances.get(caller) ?? 0) >= cents, 'ERR_BALANCE');
        require(receiver_id === IDS.market, 'ERR_RECEIVER');
        if (msg === 'trader' && caller === IDS.trader) {
          w.balances.set(caller, w.balances.get(caller) - cents);
          w.balances.set(IDS.market, w.balances.get(IDS.market) + cents);
          w.ledger.trader_available += cents;
          return String(cents);
        }
        return '0';
      },
    },
    [IDS.market]: {
      async stage_position(caller, { nonce, commitment, quote_terms, ciphertexts }) {
        require(caller === IDS.trader, 'ERR_NOT_TRADER');
        require(!w.active, 'ERR_SLOT_OCCUPIED');
        require(nonce === w.ledger.next_nonce, 'ERR_BAD_NONCE');
        require(ciphertexts.length === 2 && ciphertexts.every((c) => fromBase64(c).length === 144), 'ERR_CIPHERTEXT_LEN');
        const o = fresh();
        w.pending = { nonce, commitment, quote_terms, ciphertexts, open_price_ticks: o.price_ticks,
          funding_checkpoint: o.funding_cents, expires_at: null };
      },
      async approve_quote(caller, { nonce, commitment, quote_terms, open_price_ticks, expires_at }) {
        require(caller === IDS.maker, 'ERR_NOT_MAKER');
        require(expires_at > w.height, 'ERR_EXPIRY_NOT_FUTURE');
        const p = w.pending;
        require(p, 'ERR_NO_PENDING');
        require(p.nonce === nonce && p.commitment === commitment && p.quote_terms === quote_terms
          && p.open_price_ticks === open_price_ticks, 'ERR_PENDING_MISMATCH');
        p.expires_at = expires_at;
      },
      async open(caller, { nonce, commitment, acknowledgments, proof }) {
        require(caller === IDS.trader, 'ERR_NOT_TRADER');
        require(!w.active, 'ERR_SLOT_OCCUPIED');
        const p = w.pending;
        require(p && p.nonce === nonce && p.commitment === commitment, 'ERR_PENDING_MISMATCH');
        require(p.expires_at, 'ERR_NO_QUOTE');
        require(w.height <= p.expires_at, 'ERR_QUOTE_EXPIRED');
        const o = fresh();
        require(o.price_ticks === p.open_price_ticks && o.funding_cents === p.funding_checkpoint, 'ERR_OPENING_CHANGED');
        require(w.ledger.trader_available >= M.ESCROW_CENTS, 'ERR_INSUFFICIENT_ESCROW');
        require(w.ledger.maker_vault - w.ledger.maker_reserved >= M.MAKER_RESERVE_CENTS, 'ERR_INSUFFICIENT_RESERVE');
        require(acknowledgments.length === 2, 'ERR_ACK_COUNT');
        for (let i = 0; i < 2; i += 1) {
          const msg = await M.ackMessage(market, nonce, fromBase64(commitment), fromBase64(p.ciphertexts[i]), i);
          require(ed25519.verify(fromBase64(acknowledgments[i]), msg, keepers[i].ackPub), 'ERR_ACK_INVALID');
        }
        require(proof === await fakeProof('open', commitment, await context(p), p.quote_terms, p.open_price_ticks),
          'ERR_PROOF_INVALID');
        w.ledger.trader_available -= M.ESCROW_CENTS;
        w.ledger.trader_locked += M.ESCROW_CENTS;
        w.ledger.maker_reserved += M.MAKER_RESERVE_CENTS;
        w.ledger.next_nonce += 1;
        w.active = p;
        w.pending = null;
      },
      close: (caller, args) => {
        require(caller === IDS.trader, 'ERR_NOT_TRADER');
        return settle('close', caller, args);
      },
      liquidate: (caller, args) => settle('liquidation', caller, args),
      async publish_oracle(caller, { round, price_ticks, funding_cents }) {
        require(caller === IDS.oracle, 'ERR_NOT_ORACLE');
        require(!w.oracle || round > w.oracle.round, 'ERR_ROUND_NOT_INCREASING');
        w.oracle = { round, price_ticks, funding_cents, height: w.height };
      },
      async withdraw(caller, { amount }, deposit) {
        require(deposit === 1n, 'ERR_ONE_YOCTO');
        require(caller === IDS.trader, 'ERR_NOT_CLAIMANT');
        const cents = Number(amount);
        require(w.ledger.trader_available >= cents, 'ERR_INSUFFICIENT_BALANCE');
        w.ledger.trader_available -= cents;
        w.balances.set(IDS.market, w.balances.get(IDS.market) - cents);
        w.balances.set(IDS.trader, (w.balances.get(IDS.trader) ?? 0) + cents);
        return true;
      },
    },
  };

  /** Executes one call; records an outcome under `hash`. */
  async function execute(hash, signer, receiver, method, args, deposit) {
    w.height += 3;
    w.calls.push({ signer, receiver, method, args });
    let status;
    try {
      const fn = methods[receiver]?.[method];
      if (!fn) throw new Fail('MethodNotFound');
      const value = await fn(signer, args, deposit);
      status = { SuccessValue: value === undefined ? '' : toBase64(utf8(JSON.stringify(value))) };
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ' + error.message } } } } };
    }
    const outcome = {
      final_execution_status: 'FINAL', status,
      transaction: { signer_id: signer, receiver_id: receiver, hash, actions: [{ FunctionCall: { method_name: method } }] },
      transaction_outcome: { id: hash }, receipts_outcome: [],
    };
    w.txs.set(hash, outcome);
    return outcome;
  }

  let serverHashes = 0;
  const serverTx = async (signer, method, args) => {
    const hash = toBase58(await sha256(utf8('server-' + (serverHashes += 1))));
    const outcome = await execute(hash, signer, IDS.market, method, args, 0n);
    if (outcome.status.Failure) throw new Error('server tx failed: ' + JSON.stringify(outcome.status));
    return hash;
  };

  // -------------------------------------------------------------- RPC
  async function rpc(method, params) {
    if (w.hooks.rpc) {
      const hooked = await w.hooks.rpc(method, params);
      if (hooked !== undefined) return hooked;
    }
    if (method === 'status') return { result: { chain_id: 'testnet' } };
    if (method === 'block') return { result: { header: { height: w.height, hash: toBase58(new Uint8Array(32).fill(7)) } } };
    if (method === 'query' && params.request_type === 'call_function') {
      const view = views[params.account_id]?.[params.method_name];
      if (!view) return { error: { name: 'HANDLER_ERROR', cause: { name: 'CONTRACT_EXECUTION_ERROR' } } };
      const args = JSON.parse(fromUtf8(fromBase64(params.args_base64)));
      return { result: { result: Array.from(utf8(JSON.stringify(view(args) ?? null))) } };
    }
    if (method === 'query' && params.request_type === 'view_access_key') {
      const nonce = w.keys.get(params.account_id + '|' + params.public_key);
      if (nonce === undefined) return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } };
      return { result: { nonce, permission: 'FullAccess' } };
    }
    if (method === 'send_tx') {
      const raw = fromBase64(params.signed_tx_base64);
      const signed = decodeSignedTransaction(raw);
      const tx = signed.transaction;
      const digest = await sha256(encodeTransaction(tx));
      const hash = toBase58(digest);
      if (w.txs.has(hash)) return { result: { final_execution_status: 'NONE' } };
      const pk = 'ed25519:' + toBase58(Uint8Array.from(tx.publicKey.ed25519Key.data));
      const key = w.keys.get(tx.signerId + '|' + pk);
      const invalid = (what) => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: { [what]: {} } } } });
      if (key === undefined) return invalid('InvalidAccessKeyError');
      if (!ed25519.verify(Uint8Array.from(signed.signature.ed25519Signature.data), digest,
        Uint8Array.from(tx.publicKey.ed25519Key.data))) return invalid('InvalidSignature');
      if (BigInt(key) >= tx.nonce) return invalid('InvalidNonce');
      w.keys.set(tx.signerId + '|' + pk, Number(tx.nonce));
      const call = tx.actions[0].functionCall;
      await execute(hash, tx.signerId, tx.receiverId, call.methodName,
        JSON.parse(fromUtf8(Uint8Array.from(call.args))), BigInt(call.deposit));
      return { result: { final_execution_status: 'NONE' } };
    }
    if (method === 'tx') {
      const outcome = w.txs.get(params.tx_hash);
      if (!outcome) return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } };
      return { result: outcome };
    }
    throw new Error('fake rpc: unsupported ' + method);
  }

  const rpcFetch = async (url, init) => {
    if (url !== TESTNET_RPC) throw new Error('unexpected RPC url ' + url);
    const { method, params, id } = JSON.parse(init.body);
    const out = await rpc(method, params);
    if (w.hooks.dropResponse?.(method)) throw new TypeError('network connection lost');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...out }), { status: 200 });
  };

  // ----------------------------------------------------------- server
  const session = { id: 'session-0123456789abcdef', armed: false, receipts: [] };
  const sessionBody = () => ({
    session_id: session.id, trader_id: IDS.trader, market_id: IDS.market, token_id: IDS.token,
    chain_id: 'testnet', rpc_url: TESTNET_RPC,
    keeper_encryption_keys: keepers.map((k) => k.encSpki), keeper_armed: session.armed,
    receipts: session.receipts, ...(w.hooks.session?.() ?? {}),
  });
  let oracleRound = 0;
  const server = {
    async 'POST /sessions'({ public_key, proof, ...extra }) {
      if (Object.keys(extra).length) throw Object.assign(new Error('unexpected fields'), { status: 400 });
      const message = utf8('xythum:exchange:session:v1:testnet:' + public_key);
      if (!ed25519.verify(fromBase64(proof, 64), message, fromBase58(public_key.slice(8)), { zip215: false })) {
        throw Object.assign(new Error('bad session proof'), { status: 401 });
      }
      w.keys.set(IDS.trader + '|' + public_key, 0);
      if (!w.balances.has(IDS.trader)) w.balances.set(IDS.trader, 100_000);
      return sessionBody();
    },
    async 'GET /session'() { return sessionBody(); },
    async 'POST /session/mark'({ price_ticks }) {
      oracleRound += 1;
      const hash = await serverTx(IDS.oracle, 'publish_oracle', {
        round: oracleRound, price_ticks, funding_cents: w.oracle?.funding_cents ?? 0,
      });
      return { oracle: { ...w.oracle }, receipt: { label: 'mark', hash } };
    },
    async 'POST /session/approve'(body) {
      const p = w.pending;
      if (!p || p.nonce !== body.nonce || p.commitment !== body.commitment) throw Object.assign(new Error('no pending'), { status: 409 });
      const ctx = await context(p);
      if (p.quote_terms !== toBase64(await M.quoteTerms({ context: ctx, ...body }))) throw Object.assign(new Error('terms'), { status: 409 });
      const hash = await serverTx(IDS.maker, 'approve_quote', {
        nonce: p.nonce, commitment: p.commitment, quote_terms: p.quote_terms,
        open_price_ticks: p.open_price_ticks, expires_at: w.height + 500,
      });
      const acknowledgments = [];
      for (let i = 0; i < 2; i += 1) {
        const witness = await decryptWitness(p.ciphertexts[i], keepers[i].enc, p.commitment);
        if (witness.context !== ctx || toBase64(await M.commitment(witness)) !== p.commitment) throw new Error('keeper witness mismatch');
        w.keeperWitness = witness;
        const msg = await M.ackMessage(market, p.nonce, fromBase64(p.commitment), fromBase64(p.ciphertexts[i]), i);
        acknowledgments.push(toBase64(ed25519.sign(msg, keepers[i].ack)));
      }
      return { acknowledgments, receipt: { label: 'maker approval', hash } };
    },
    async 'POST /session/keeper'() {
      session.armed = true;
      return { keeper_armed: true };
    },
  };

  const apiFetch = async (url, init) => {
    const path = url.replace(/^\/api/, '');
    const route = init.method + ' ' + path;
    const body = init.body ? JSON.parse(init.body) : undefined;
    w.serverBodies.push({ route, body, headers: init.headers });
    if (route !== 'POST /sessions' && init.headers.authorization !== 'Bearer ' + session.id) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    if (w.hooks.api) {
      const hooked = await w.hooks.api(route, body);
      if (hooked) return hooked;
    }
    try {
      return new Response(JSON.stringify(await server[route](body)), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.status ?? 500 });
    }
  };

  /** Keeper B liquidation using its decrypted witness (out of band). */
  async function keeperLiquidate() {
    const witness = w.keeperWitness;
    const o = w.oracle;
    const delta = o.funding_cents - w.active.funding_checkpoint;
    const s = M.settlement('liquidation', witness, o.price_ticks, delta);
    const proof = await fakeProof('liquidation', w.active.commitment, await context(w.active), o.round, o.price_ticks, delta, s.refund, s.bad_debt);
    const hash = toBase58(await sha256(utf8('keeper-' + o.round)));
    return execute(hash, IDS.keeperB, IDS.market, 'liquidate', {
      nonce: w.active.nonce, root: w.active.commitment, round: o.round, ...s, proof,
    }, 0n);
  }

  const prover = {
    jobs: [],
    async prove(kind, vk, input) {
      this.jobs.push({ kind, vk, input });
      if (w.hooks.prove) await w.hooks.prove(kind, input);
      const commitment = toBase64(await M.commitment(input));
      if (kind === 'open') {
        const quote_terms = toBase64(await M.quoteTerms(input));
        return { commitment, quote_terms, proof: await fakeProof('open', commitment, input.context, quote_terms, input.open_price_ticks), proving_ms: 1 };
      }
      const s = M.settlement('close', input, input.price_ticks, input.funding_cents);
      return { commitment, ...s, proof: await fakeProof('close', commitment, input.context, input.round, input.price_ticks, input.funding_cents, s.refund, s.bad_debt), proving_ms: 1 };
    },
  };

  return { w, rpcFetch, apiFetch, prover, keeperLiquidate, session };
}
