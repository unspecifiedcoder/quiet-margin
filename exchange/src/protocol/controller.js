// Exchange controller: the browser is the trader. It owns its signing key,
// its private position opening, its proofs and its keeper envelopes, and it
// reads every displayed balance and position from finalized chain state.
//
// Every multi-step action is derived from finalized chain state plus the
// local opening record, so a retry after a lost response, a failed request or
// a reload continues from wherever the chain actually is, never re-sending a
// step that already landed and never reporting a step that did not.

import { ApiError } from './api.js';
import { equalBytes, fromBase64, fromUtf8, randomBytes, sha256, toBase64, toHex, utf8 } from './bytes.js';
import { Chain, TxFailedError } from './chain.js';
import { encryptWitness } from './envelope.js';
import * as M from './model.js';
import { interpretOutcome, pinRpcUrl, Rpc, RpcError } from './rpc.js';
import { loadSigner, sessionProof, storedSigner, verifyEd25519 } from './signer.js';
import { CALL_GAS, functionCall, ONE_YOCTO } from './tx.js';

const SESSION = 'session';
const OPENING = 'opening';
const MARKS = 'marks';
const RECEIPTS = 'receipts';
/** Public `{market_id, nonce, commitment}` of the slot this browser asked Keeper B to guard. */
const KEEPER = 'keeper';
/** Coordinator receipt label for a Keeper B liquidation of position `<nonce>`. */
const LIQUIDATION_LABEL = /^liquidation_([1-9]\d{0,9})$/;
/** Liquidation receipts verified on chain per coordinator view, at most. */
const MAX_KEEPER_CHECKS = 4;
const MAX_MARKS = 200;
const MAX_RECEIPTS = 100;
/** Refresh the oracle before staging when it is older than this. */
const STAGE_FRESHNESS_BLOCKS = 600;
/** Oracle validity a close proof must still have at the final height after proving. */
const CLOSE_MARGIN_BLOCKS = 30;
/** Prove-and-send attempts for one close while the oracle round moves. */
const CLOSE_ATTEMPTS = 3;
/** Required remaining quote validity before submitting `open`. */
const QUOTE_MARGIN_BLOCKS = 20;
const POLL_MS = 8_000;

export const explorerUrl = (network, hash) => (network === 'testnet'
  ? 'https://testnet.nearblocks.io/txns/' + encodeURIComponent(hash)
  : null);

const usd = (cents) => cents / 100;

function initialState() {
  return {
    network: null,
    busy: null,
    error: null,
    notice: null,
    session: null,
    oracle: null,
    balances: { wallet: null, available: null, locked: null, maker: null },
    position: null,
    active: null,
    keeperArmed: false,
    markHistory: [],
    receipts: [],
    proofStatus: null,
  };
}

/** Accepts USD (number or decimal string) or `{ cents }`. */
function centsArg(value, name, max) {
  if (value && typeof value === 'object' && 'cents' in value) {
    if (!Number.isSafeInteger(value.cents) || value.cents <= 0 || value.cents > max) {
      throw new RangeError(`${name} must be in 1..=${max} cents`);
    }
    return value.cents;
  }
  return M.usdToCents(value, { max, name });
}

function lotsArg(open) {
  if (Number.isSafeInteger(open?.lots)) {
    if (open.lots < M.MIN_LOTS || open.lots > M.MAX_LOTS) throw new RangeError('size must be 1..=50 lots');
    return open.lots;
  }
  return M.btcToLots(open?.sizeBtc);
}

function ticksArg(value) {
  if (value && typeof value === 'object' && 'ticks' in value) {
    if (!Number.isSafeInteger(value.ticks) || value.ticks < 1 || value.ticks > M.MAX_TICKS) {
      throw new RangeError('mark must be 1..=20000 ticks');
    }
    return value.ticks;
  }
  return M.usdToTicks(value);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export class ExchangeController {
  constructor({ api, store, prover, rpcFactory = (url) => new Rpc(url), allowSandbox = false,
    onState = () => {}, pollMs = POLL_MS, locks = globalThis.navigator?.locks, sleep, finalWaitMs } = {}) {
    Object.assign(this, { api, store, prover, rpcFactory, allowSandbox, onState, pollMs, locks, sleep, finalWaitMs });
    this.state = initialState();
    this.ctx = null;
    this.timer = null;
    this.refreshing = null;
    this.keeperSyncing = null;
    /** Liquidation receipt hashes that definitively failed on-chain verification. */
    this.keeperRejected = new Set();
    /** Liquidation receipt hashes whose verification hit a transient RPC error. */
    this.keeperPending = new Set();
  }

  // ------------------------------------------------------------------
  // State plumbing.
  // ------------------------------------------------------------------

  emit(patch) {
    if (patch) this.state = { ...this.state, ...patch };
    this.onState(this.snapshot());
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async addReceipt({ label, hash, status, reason }) {
    if (!hash) return;
    const tag = status === 'pending' ? ' (pending finality)'
      : status === 'failed' ? ' (failed' + (reason ? ': ' + reason : '') + ')'
        : status === 'rejected' ? ' (not executed)'
          : status === 'unverified' ? ' (server-reported)'
            : status === 'invalid' ? ' (failed on-chain verification)' : '';
    const entry = { label: label + tag, hash, explorerUrl: explorerUrl(this.state.network, hash) };
    const list = this.state.receipts.filter((r) => r.hash !== hash);
    list.push(entry);
    const receipts = list.slice(-MAX_RECEIPTS);
    this.state = { ...this.state, receipts };
    await this.store.put(RECEIPTS, receipts);
    this.emit();
  }

  /**
   * Runs one user action exclusively (in this tab and, where the Web Locks
   * API exists, across tabs). A second action while one is in flight is
   * refused rather than queued.
   */
  async run(name, fn, { requireSession = true } = {}) {
    if (this.state.busy) {
      this.emit({ error: `"${this.state.busy}" is still in progress` });
      return false;
    }
    if (requireSession && !this.ctx) {
      this.emit({ error: 'Start a session first' });
      return false;
    }
    this.emit({ busy: name, error: null, notice: null });
    let ok = false;
    const body = async () => {
      // A background keeper sync must not interleave with the keeper record writes below.
      await this.keeperSyncing;
      // Settle any transaction an earlier attempt left in flight first.
      if (this.ctx) await this.ctx.chain.resolveJournal();
      await fn();
      ok = true;
    };
    try {
      if (this.locks?.request) {
        await this.locks.request('xythum-exchange-action', { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error('another tab of this exchange is running an action');
          await body();
        });
      } else {
        await body();
      }
    } catch (error) {
      this.state = { ...this.state, error: describe(error) };
    } finally {
      this.state = { ...this.state, busy: null, proofStatus: ok ? null : this.state.proofStatus };
      if (this.ctx) {
        await this.refresh().catch((e) => {
          this.state = { ...this.state, error: this.state.error ?? describe(e) };
        });
      }
      this.emit();
    }
    return ok;
  }

  // ------------------------------------------------------------------
  // Session.
  // ------------------------------------------------------------------

  /** Explicit user action: restores the saved session or enrolls this browser key. */
  onStart() {
    // A click during the automatic restore waits for it instead of racing it.
    if (this.restoring) return this.restoring.then(() => (this.ctx ? true : this.onStart()));
    return this.run('Starting session', () => this.start(), { requireSession: false });
  }

  /**
   * Automatic page-load restore. Only reattaches a session this browser
   * already saved, with the signer that saved it; it never creates a signer,
   * never enrolls and never provisions anything server-side.
   */
  onResume() {
    this.restoring ??= this.run('Restoring session', () => this.start({ restoreOnly: true }), { requireSession: false })
      .finally(() => {
        this.restoring = null;
      });
    return this.restoring;
  }

  async start({ restoreOnly = false } = {}) {
    const signer = restoreOnly ? await storedSigner(this.store) : await loadSigner(this.store);
    if (!signer) return;
    const saved = await this.store.get(SESSION);
    let session;
    if (saved && saved.public_key === signer.publicKey) {
      try {
        session = await this.api.getSession(saved.session_id);
      } catch (error) {
        if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) throw error;
      }
    }
    if (!session && restoreOnly) {
      if (saved) this.state = { ...this.state, notice: 'The saved session is no longer valid; click Start session to continue' };
      return;
    }
    // Enrollment proves possession of the browser key before the server
    // provisions anything; the same proof is valid for a retried request.
    session ??= await this.api.createSession(signer.publicKey, await sessionProof(signer));

    const rpcUrl = pinRpcUrl(session.chain_id, session.rpc_url, { allowSandbox: this.allowSandbox });
    const rpc = this.rpcFactory(rpcUrl);
    const status = await rpc.status();
    if (status.chain_id !== session.chain_id) {
      throw new Error(`RPC chain_id ${status.chain_id} does not match session ${session.chain_id}`);
    }
    const network = session.chain_id === 'testnet' ? 'testnet' : 'sandbox';

    const config = await rpc.view(session.market_id, 'get_config');
    const verified = await this.verifyConfig(rpc, session, config);
    // The browser key must control the trader account at final finality.
    const key = await this.waitFor('browser access key on ' + session.trader_id, async () => {
      try {
        return await rpc.viewAccessKey(session.trader_id, signer.publicKey);
      } catch {
        return null;
      }
    });
    if (key.permission !== 'FullAccess') {
      throw new Error('the browser key must be a full-access key to sign 1 yocto deposits and withdrawals');
    }

    const fingerprint = toHex(await sha256(utf8(canonical(config))));
    const pin = {
      market_id: session.market_id, trader_id: session.trader_id, token_id: session.token_id,
      config_fingerprint: fingerprint, keeper_encryption_keys: session.keeper_encryption_keys,
    };
    if (saved?.pin && saved.pin.market_id === session.market_id) {
      if (canonical(saved.pin) !== canonical(pin)) {
        throw new Error('market configuration or keeper keys changed since this browser last verified them');
      }
    }
    await this.store.put(SESSION, { session_id: session.session_id, public_key: signer.publicKey, pin });

    const chain = new Chain({
      rpc, store: this.store, signer, accountId: session.trader_id,
      onReceipt: (r) => this.addReceipt(r),
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(this.finalWaitMs ? { finalWaitMs: this.finalWaitMs } : {}),
    });
    this.ctx = { session, signer, rpc, chain, config, network, ...verified, fingerprint };
    this.state = {
      ...this.state,
      network,
      session: {
        traderId: session.trader_id, marketId: session.market_id, tokenId: session.token_id,
        publicKey: signer.publicKey, custody: signer.custody, configFingerprint: fingerprint,
      },
      // Derived below from the coordinator view and the finalized active slot.
      keeperArmed: false,
      markHistory: (await this.store.get(MARKS)) ?? [],
      receipts: (await this.store.get(RECEIPTS)) ?? [],
    };
    // Liquidation receipts are verified on chain by applyKeeperView; a
    // receipt this browser already holds is never downgraded.
    for (const r of session.receipts) {
      if (LIQUIDATION_LABEL.test(r.label) || this.state.receipts.some((x) => x.hash === r.hash)) continue;
      await this.addReceipt({ ...r, status: 'unverified' });
    }
    this.startPolling();
    // A transaction journaled before a reload is followed to FINAL now.
    await chain.resolveJournal();
    // Resume: a Keeper B result that landed while this browser was away is
    // picked up from the view already fetched. Failure here never blocks the
    // restore; the poll retries while a keeper slot is watched.
    try {
      await this.refresh();
      await this.applyKeeperView(session);
    } catch (error) {
      this.state = { ...this.state, notice: 'Keeper status could not be confirmed yet: ' + describe(error) };
    }
  }

  /** Route and fingerprint checks performed before any signing. */
  async verifyConfig(rpc, session, config) {
    const fail = (what) => {
      throw new Error('market configuration check failed: ' + what);
    };
    if (config.trader_id !== session.trader_id) fail('trader_id differs from the session');
    if (config.token_id !== session.token_id) fail('token_id differs from the session');
    if (config.key_version !== M.KEY_VERSION) fail('key_version');
    if (!Array.isArray(config.keepers) || config.keepers.length !== M.KEEPER_COUNT) fail('keepers');
    const ackKeys = config.keepers.map((k) => fromBase64(k.ack_key, 32));
    if (equalBytes(ackKeys[0], ackKeys[1])) fail('keeper ack keys are not distinct');
    const deploymentId = fromBase64(config.deployment_id, 32);
    const vk = {
      open: config.open_vk_sha256, close: config.close_vk_sha256, liquidation: config.liquidation_vk_sha256,
    };
    for (const value of Object.values(vk)) fromBase64(value, 32);
    const market = await M.marketId(deploymentId, session.market_id);
    const onChain = fromBase64(await rpc.view(session.market_id, 'get_market'), 32);
    if (!equalBytes(market, onChain)) fail('market id does not match deployment_id and contract account');
    const roles = [session.market_id, config.token_id, config.trader_id, config.maker_id, config.oracle_id,
      ...config.keepers.map((k) => k.account_id)];
    if (new Set(roles).size !== roles.length) fail('roles are not distinct');
    const metadata = await rpc.view(session.token_id, 'ft_metadata');
    if (metadata?.decimals !== 2) fail('collateral token must use 2 decimals (cents)');
    return { market, ackKeys, vk };
  }

  async waitFor(what, probe, { attempts = 15, delayMs = 2_000 } = {}) {
    const sleep = this.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i += 1) {
      const value = await probe();
      if (value) return value;
      await sleep(delayMs);
    }
    throw new Error('timed out waiting for finalized ' + what);
  }

  startPolling() {
    if (this.timer || !this.pollMs) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  /**
   * One background tick: the finalized chain read, then (only while a keeper
   * slot or a liquidation receipt is outstanding) the coordinator view. The
   * chain refresh is applied and emitted even when the coordinator is down.
   */
  async poll() {
    if (this.state.busy || !this.ctx) return;
    try {
      await this.refresh();
    } catch {
      return;
    }
    this.emit();
    if (await this.watchKeeper()) this.emit();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------
  // Finalized reads.
  // ------------------------------------------------------------------

  async read() {
    const { rpc, session } = this.ctx;
    const m = session.market_id;
    const [ledger, oracle, active, pending, quote, wallet, block] = await Promise.all([
      rpc.view(m, 'get_ledger'), rpc.view(m, 'get_oracle'), rpc.view(m, 'get_active'),
      rpc.view(m, 'get_pending'), rpc.view(m, 'get_quote'),
      rpc.view(session.token_id, 'ft_balance_of', { account_id: session.trader_id }), rpc.finalBlock(),
    ]);
    return { ledger, oracle, active, pending, quote, wallet: Number(wallet), height: block.header.height };
  }

  refresh() {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async doRefresh() {
    const chain = await this.read();
    this.chainState = chain;
    const { ledger, oracle, active } = chain;
    let markHistory = this.state.markHistory;
    if (oracle && !markHistory.some((p) => p.round === oracle.round)) {
      markHistory = [...markHistory, { price_ticks: oracle.price_ticks, round: oracle.round }]
        .sort((a, b) => a.round - b.round).slice(-MAX_MARKS);
      await this.store.put(MARKS, markHistory);
    }
    const record = await this.openingRecord();
    let position = null;
    let notice = this.state.notice;
    if (active && record && record.commitment === active.commitment && oracle) {
      position = this.describePosition(record, active, oracle);
    } else if (record?.phase === 'active' && !active && ledger.next_nonce > record.nonce) {
      // The position this browser opened is no longer active on chain.
      await this.store.delete(OPENING);
      notice = `Position nonce ${record.nonce} was settled on chain; its local secret opening was erased`;
    }
    // Keeper B guards one slot; the flag never outlives it on chain.
    const keeperArmed = this.state.keeperArmed && this.slotLive(await this.keeperRecord(), active);
    this.state = {
      ...this.state,
      oracle: oracle ? { price_ticks: oracle.price_ticks, round: oracle.round, funding_cents: oracle.funding_cents } : null,
      balances: {
        wallet: chain.wallet,
        available: ledger.trader_available,
        locked: ledger.trader_locked,
        maker: ledger.maker_vault - ledger.maker_reserved,
      },
      active: active ? { nonce: active.nonce, commitment: active.commitment } : null,
      position,
      keeperArmed,
      markHistory,
      notice,
      halted: ledger.halted,
    };
    return chain;
  }

  describePosition(record, active, oracle) {
    const w = record.witness;
    const delta = oracle.funding_cents - active.funding_checkpoint;
    const close = M.settlement('close', w, oracle.price_ticks, Math.min(Math.max(delta, 0), M.MAX_FUNDING_DELTA_CENTS));
    return {
      sizeBtc: w.size_lots / 1000,
      marginUsd: usd(w.margin_cents),
      entryUsd: w.entry_ticks * M.TICK_USD,
      liquidationUsd: M.liquidationTicks(w, delta) * M.TICK_USD,
      // Realized result of closing now: close refund minus the locked escrow.
      pnlUsd: usd(close.refund - M.ESCROW_CENTS),
      fundingUsd: usd(delta),
      liquidatable: M.isLiquidatable(w, oracle.price_ticks, delta),
      nonce: active.nonce,
      commitment: active.commitment,
    };
  }

  async openingRecord() {
    return this.store.getSealed(OPENING);
  }

  // ------------------------------------------------------------------
  // Wallet funding.
  // ------------------------------------------------------------------

  onDeposit(amount) {
    return this.run('Depositing', async () => {
      const cents = centsArg(amount, 'deposit', 1e12);
      const { wallet } = await this.refresh();
      if (cents > wallet) throw new Error(`wallet holds only ${usd(wallet)} mUSDC`);
      const { session } = this.ctx;
      const result = await this.ctx.chain.call('deposit', session.token_id, [functionCall('ft_transfer_call', {
        receiver_id: session.market_id, amount: String(cents), msg: 'trader',
      }, { gas: CALL_GAS, deposit: ONE_YOCTO })]);
      if (String(result.value) !== String(cents)) {
        throw new Error(`deposit ${result.hash} was refunded by the market (credited ${result.value ?? 0} of ${cents})`);
      }
    });
  }

  onWithdraw(amount) {
    return this.run('Withdrawing', async () => {
      const cents = centsArg(amount, 'withdrawal', 1e12);
      const { ledger } = await this.refresh();
      if (cents > ledger.trader_available) {
        throw new Error(`only ${usd(ledger.trader_available)} mUSDC is available to withdraw`);
      }
      const result = await this.ctx.chain.call('withdraw', this.ctx.session.market_id, [functionCall('withdraw', {
        amount: String(cents),
      }, { gas: CALL_GAS, deposit: ONE_YOCTO })]);
      if (result.value !== true) {
        throw new Error(`withdrawal ${result.hash} transfer failed; the market restored the balance`);
      }
    });
  }

  // ------------------------------------------------------------------
  // Test market controls.
  // ------------------------------------------------------------------

  onSetMark(priceUsd) {
    return this.run('Publishing mark', async () => {
      await this.publishMark(ticksArg(priceUsd));
    });
  }

  async publishMark(ticks) {
    const { oracle, receipt } = await this.api.mark(ticks);
    await this.verifyServerReceipt(receipt, this.ctx.config.oracle_id, 'publish_oracle');
    const final = await this.waitFor('oracle round ' + oracle.round, async () => {
      const o = await this.ctx.rpc.view(this.ctx.session.market_id, 'get_oracle');
      return o && o.round >= oracle.round ? o : null;
    });
    await this.refresh();
    return final;
  }

  /**
   * Finalized chain state whose oracle is at most `maxAge` blocks old. A
   * sufficiently fresh final oracle is used as it is; an old one is renewed
   * through the server's liveness refresh (same price and funding under a
   * new round, outside the user mark quota), never through a test mark.
   */
  async freshChain(chain = null, maxAge = STAGE_FRESHNESS_BLOCKS) {
    chain ??= await this.refresh();
    if (!chain.oracle) throw new Error('no oracle mark yet; publish a test mark first');
    if (chain.height - chain.oracle.height <= maxAge) return chain;
    this.progress('Refreshing the stale oracle round');
    const { oracle, receipt } = await this.api.refreshOracle();
    if (receipt) await this.verifyServerReceipt(receipt, this.ctx.config.oracle_id, 'publish_oracle');
    await this.waitFor('oracle round ' + oracle.round, async () => {
      const o = await this.ctx.rpc.view(this.ctx.session.market_id, 'get_oracle');
      return o && o.round >= oracle.round ? o : null;
    });
    chain = await this.refresh();
    if (!chain.oracle || chain.height - chain.oracle.height > maxAge) {
      throw new Error('the finalized oracle is still stale after a liveness refresh; try again shortly');
    }
    return chain;
  }

  onArmKeeper() {
    return this.run('Arming Keeper B', async () => {
      const { active } = await this.refresh();
      if (!active) throw new Error('there is no active position for Keeper B to guard');
      // Recorded before the request, so a lost response is still resolved
      // by the coordinator view instead of being forgotten.
      const slot = { market_id: this.ctx.session.market_id, nonce: active.nonce, commitment: active.commitment };
      await this.store.put(KEEPER, slot);
      let response;
      try {
        response = await this.api.armKeeper();
      } catch (error) {
        // A definitive refusal arms nothing; an unreachable server may have.
        if (error instanceof ApiError && error.status) await this.store.delete(KEEPER);
        throw error;
      }
      const { keeper_armed: armed, receipt } = response;
      if (receipt) {
        // Arming can settle a position that is already distressed at once.
        let verified = true;
        try {
          await this.verifyLiquidationReceipt(receipt, slot.nonce);
        } catch (error) {
          if (!armed) throw new Error('Keeper B reported a liquidation that does not verify on chain: ' + describe(error));
          verified = false;
          if (error instanceof RpcError) this.keeperPending.add(receipt.hash);
          await this.addReceipt({ ...receipt, status: 'unverified' });
        }
        await this.refresh();
        if (verified) {
          await this.settleKeeper(slot, receipt);
          return;
        }
      }
      if (!armed) {
        await this.store.delete(KEEPER);
        throw new Error('the server did not arm Keeper B');
      }
      this.state = { ...this.state, keeperArmed: this.slotLive(slot, this.chainState?.active) };
    });
  }

  // ------------------------------------------------------------------
  // Keeper B status (coordinator view, verified on chain).
  // ------------------------------------------------------------------

  async keeperRecord() {
    const slot = await this.store.get(KEEPER);
    return slot && slot.market_id === this.ctx?.session.market_id ? slot : null;
  }

  slotLive(slot, active) {
    return Boolean(slot && active && active.nonce === slot.nonce && active.commitment === slot.commitment);
  }

  /** Clears the guarded slot after its verified liquidation. */
  async settleKeeper(slot, receipt) {
    await this.store.delete(KEEPER);
    this.state = {
      ...this.state,
      keeperArmed: false,
      notice: `Keeper B liquidated position nonce ${slot.nonce} on chain in ${receipt.hash}`,
    };
  }

  /**
   * Same-session coordinator read, only while a guarded slot or an
   * unconfirmed liquidation receipt is outstanding. Never throws: a
   * coordinator outage leaves the chain-derived state as it is. Returns
   * whether the coordinator was consulted.
   */
  watchKeeper() {
    this.keeperSyncing ??= (async () => {
      if (!this.ctx) return false;
      if (!(await this.keeperRecord()) && this.keeperPending.size === 0) return false;
      let view;
      try {
        view = await this.api.getSession(this.ctx.session.session_id);
      } catch {
        return false;
      }
      await this.applyKeeperView(view);
      return true;
    })().catch((error) => {
      this.state = { ...this.state, error: this.state.error ?? 'Keeper status: ' + describe(error) };
      return true;
    }).finally(() => {
      this.keeperSyncing = null;
    });
    return this.keeperSyncing;
  }

  /** Applies a coordinator session view to the keeper state of this session. */
  async applyKeeperView(view) {
    const { session } = this.ctx;
    for (const field of ['session_id', 'trader_id', 'market_id', 'token_id', 'chain_id', 'rpc_url']) {
      if (view[field] !== session[field]) throw new Error('the coordinator view changed ' + field + '; ignored');
    }
    if (canonical(view.keeper_encryption_keys) !== canonical(session.keeper_encryption_keys)) {
      throw new Error('the coordinator view changed the keeper keys; ignored');
    }

    const slot = await this.keeperRecord();
    let settled = null;
    let fresh = false;
    let checks = 0;
    const seen = new Set();
    for (const receipt of view.receipts) {
      const nonce = Number(LIQUIDATION_LABEL.exec(receipt.label)?.[1] ?? NaN);
      if (!Number.isSafeInteger(nonce) || seen.has(receipt.hash) || this.keeperRejected.has(receipt.hash)) continue;
      seen.add(receipt.hash);
      let ok = this.state.receipts.some((r) => r.hash === receipt.hash && r.label === receipt.label);
      if (!ok && checks < MAX_KEEPER_CHECKS) {
        checks += 1;
        try {
          await this.verifyLiquidationReceipt(receipt, nonce);
          this.keeperPending.delete(receipt.hash);
          ok = true;
          fresh = true;
        } catch (error) {
          if (error instanceof RpcError) {
            // Not final or RPC unavailable yet: shown as reported, retried.
            this.keeperPending.add(receipt.hash);
            if (!this.state.receipts.some((r) => r.hash === receipt.hash)) {
              await this.addReceipt({ ...receipt, status: 'unverified' });
            }
          } else {
            this.keeperPending.delete(receipt.hash);
            this.keeperRejected.add(receipt.hash);
            // Never relabels a receipt this browser already holds under that hash.
            if (!this.state.receipts.some((r) => r.hash === receipt.hash)) {
              await this.addReceipt({ ...receipt, status: 'invalid' });
            }
          }
        }
      }
      if (ok && slot && nonce === slot.nonce) settled = receipt;
    }
    // A verified liquidation moves the finalized position view with it.
    const chain = fresh ? await this.refresh() : (this.chainState ?? await this.refresh());

    if (!slot) {
      this.state = { ...this.state, keeperArmed: false };
      return;
    }
    if (settled) {
      await this.settleKeeper(slot, settled);
      return;
    }
    const live = this.slotLive(slot, chain.active);
    const reported = view.receipts.some((r) => r.label === 'liquidation_' + slot.nonce && !this.keeperRejected.has(r.hash));
    if (!view.keeper_armed && (live || !reported)) {
      // Disarmed with the slot still open, or settled with no liquidation
      // receipt for it: nothing more will arrive for this slot.
      await this.store.delete(KEEPER);
    }
    this.state = { ...this.state, keeperArmed: Boolean(view.keeper_armed) && live };
  }

  /**
   * A Keeper B liquidation receipt: FINAL and successful, signed by Keeper B,
   * a single `liquidate` call on this market for position `nonce`.
   */
  verifyLiquidationReceipt(receipt, nonce) {
    if (receipt.label !== 'liquidation_' + nonce) throw new Error(receipt.label + ': not the liquidation of nonce ' + nonce);
    return this.verifyServerReceipt(receipt, this.ctx.config.keepers[1].account_id, 'liquidate', (tx) => {
      let args;
      try {
        args = JSON.parse(fromUtf8(fromBase64(tx.actions[0].FunctionCall.args)));
      } catch {
        args = null;
      }
      if (tx.actions.length !== 1 || args?.nonce !== nonce) {
        throw new Error(receipt.label + ': receipt does not liquidate nonce ' + nonce);
      }
    });
  }

  /**
   * Confirms a server-signed transaction on chain: FINAL, successful,
   * signed by the expected role and sent to this market.
   */
  async verifyServerReceipt(receipt, signerId, method, check) {
    const outcome = await this.ctx.rpc.txFinal(receipt.hash, signerId);
    const tx = outcome.transaction;
    const { ok } = interpretOutcome(outcome);
    if (tx?.signer_id !== signerId) throw new Error(receipt.label + ': unexpected signer ' + tx?.signer_id);
    if (tx.hash !== undefined && tx.hash !== receipt.hash) throw new Error(receipt.label + ': RPC returned another transaction');
    if (method) {
      const call = tx.actions?.[0]?.FunctionCall;
      if (tx.receiver_id !== this.ctx.session.market_id || call?.method_name !== method) {
        throw new Error(receipt.label + ': receipt is not ' + method + ' on this market');
      }
    }
    check?.(tx);
    if (!ok) throw new Error(receipt.label + ' failed on chain in ' + receipt.hash);
    await this.addReceipt({ label: receipt.label, hash: receipt.hash, status: 'final' });
    return outcome;
  }

  // ------------------------------------------------------------------
  // Open.
  // ------------------------------------------------------------------

  onOpen(params) {
    return this.run('Opening position', async () => {
      const lots = lotsArg(params);
      const margin = centsArg(Number.isSafeInteger(params?.marginCents) ? { cents: params.marginCents } : params?.marginUsd,
        'margin', M.MAX_MARGIN_CENTS);
      await this.open(lots, margin);
    });
  }

  progress(proofStatus) {
    this.emit({ proofStatus });
  }

  async open(lots, margin) {
    let chain = await this.refresh();
    this.assertCanOpen(chain);
    let record = await this.resumableOpening(chain, lots, margin);

    if (!record) {
      // Stage against a fresh round so the opening survives proving time.
      chain = await this.freshChain(chain);
      this.assertCanOpen(chain);
      record = await this.prepareOpening(chain, lots, margin);
    }

    if (record.phase === 'prepared') {
      this.progress('Proving open locally');
      const out = await this.prover.prove('open', this.ctx.vk.open, {
        ...record.witness, quote_blinder: record.quote_blinder, open_price_ticks: record.open_price_ticks,
      }, (s) => this.progress(s));
      if (out.commitment !== record.commitment || out.quote_terms !== record.quote_terms) {
        throw new Error('the prover output does not match the local commitment');
      }
      this.progress('Encrypting the opening for both keepers');
      const ciphertexts = [];
      for (const key of this.ctx.session.keeper_encryption_keys) {
        ciphertexts.push(await encryptWitness(record.witness, key, record.commitment));
      }
      record = { ...record, proof: out.proof, ciphertexts, phase: 'proved' };
      await this.store.putSealed(OPENING, record);
    }

    chain = await this.refresh();
    if (!this.pendingMatches(chain.pending, record)) {
      const o = chain.oracle;
      if (!o || o.price_ticks !== record.open_price_ticks || o.funding_cents !== record.funding_checkpoint) {
        await this.store.delete(OPENING);
        throw new Error('the oracle moved after proving; open again to prove against the new mark');
      }
      this.progress('Staging the commitment');
      await this.ctx.chain.call('stage', this.ctx.session.market_id, [functionCall('stage_position', {
        nonce: record.nonce, commitment: record.commitment, quote_terms: record.quote_terms,
        ciphertexts: record.ciphertexts,
      })]);
      chain = await this.refresh();
      if (!this.pendingMatches(chain.pending, record)) {
        await this.store.delete(OPENING);
        throw new Error('the staged opening differs from this proof (oracle moved during staging); open again');
      }
    }

    let acks = record.acknowledgments;
    if (!this.quoteMatches(chain.quote, record, chain.height) || !acks) {
      this.progress('Requesting maker quote and keeper acknowledgments');
      const approval = await this.api.approve({
        nonce: record.nonce, commitment: record.commitment, quote_blinder: record.quote_blinder,
        size_lots: record.witness.size_lots, entry_ticks: record.witness.entry_ticks,
      });
      await this.verifyServerReceipt(approval.receipt, this.ctx.config.maker_id, 'approve_quote');
      acks = approval.acknowledgments;
      await this.verifyAcks(acks, chain.pending, record);
      record = { ...record, acknowledgments: acks };
      await this.store.putSealed(OPENING, record);
      chain = await this.refresh();
      if (!this.quoteMatches(chain.quote, record, chain.height)) {
        throw new Error('the finalized maker approval does not match the staged opening or is expiring');
      }
    } else {
      await this.verifyAcks(acks, chain.pending, record);
    }

    if (chain.ledger.trader_available < M.ESCROW_CENTS) throw new Error('available balance fell below the escrow');
    this.progress('Opening on chain');
    await this.ctx.chain.call('open', this.ctx.session.market_id, [functionCall('open', {
      nonce: record.nonce, commitment: record.commitment, acknowledgments: acks, proof: record.proof,
    })]);
    chain = await this.refresh();
    if (chain.active?.commitment !== record.commitment) {
      throw new Error('open finalized but the active position is not this commitment');
    }
    await this.store.putSealed(OPENING, { ...record, phase: 'active', proof: null, acknowledgments: null });
    await this.refresh();
  }

  assertCanOpen({ ledger, active }) {
    if (ledger.halted) throw new Error('the market is halted after bad debt');
    if (active) throw new Error('a position is already active; close it first');
    if (ledger.trader_available < M.ESCROW_CENTS) {
      throw new Error(`opening locks ${usd(M.ESCROW_CENTS)} mUSDC escrow; deposit at least `
        + `${usd(M.ESCROW_CENTS - ledger.trader_available)} more`);
    }
    if (ledger.maker_vault - ledger.maker_reserved < M.MAKER_RESERVE_CENTS) {
      throw new Error('the maker vault cannot reserve this position right now');
    }
  }

  /** Returns the stored in-progress opening if it can still be completed. */
  async resumableOpening(chain, lots, margin) {
    const record = await this.openingRecord();
    if (!record) return null;
    const sameTerms = record.witness.size_lots === lots && record.witness.margin_cents === margin;
    const o = chain.oracle;
    const sameMark = o && o.price_ticks === record.open_price_ticks && o.funding_cents === record.funding_checkpoint;
    const valid = record.market_id === this.ctx.session.market_id && record.nonce === chain.ledger.next_nonce
      && record.phase !== 'active' && sameTerms && sameMark
      && (await this.recordIntegrity(record));
    if (valid) return record;
    // A different request, a consumed nonce or a moved mark: never reuse the
    // opening (its context and proof would be wrong). Nothing on chain can
    // depend on it, because open was not finalized for it.
    await this.store.delete(OPENING);
    return null;
  }

  async recordIntegrity(record) {
    const context = toBase64(await M.positionContext(this.ctx.market, record.nonce, record.funding_checkpoint,
      this.ctx.session.trader_id));
    return context === record.witness.context
      && toBase64(await M.commitment(record.witness)) === record.commitment;
  }

  async prepareOpening(chain, lots, margin) {
    const o = chain.oracle;
    const witness = {
      context: toBase64(await M.positionContext(this.ctx.market, chain.ledger.next_nonce, o.funding_cents,
        this.ctx.session.trader_id)),
      blinder: toBase64(randomBytes(32)),
      size_lots: lots,
      // The maker quotes at the authenticated opening mark.
      entry_ticks: o.price_ticks,
      margin_cents: margin,
    };
    M.checkOpenAt(witness, o.price_ticks);
    const quote_blinder = toBase64(randomBytes(32));
    const record = {
      market_id: this.ctx.session.market_id,
      nonce: chain.ledger.next_nonce,
      open_price_ticks: o.price_ticks,
      funding_checkpoint: o.funding_cents,
      witness,
      quote_blinder,
      commitment: toBase64(await M.commitment(witness)),
      quote_terms: toBase64(await M.quoteTerms({ ...witness, quote_blinder })),
      phase: 'prepared',
    };
    // Persist the secret opening before anything can reference it on chain.
    await this.store.putSealed(OPENING, record);
    return record;
  }

  pendingMatches(pending, record) {
    return Boolean(pending) && pending.nonce === record.nonce && pending.commitment === record.commitment
      && pending.quote_terms === record.quote_terms && pending.open_price_ticks === record.open_price_ticks
      && pending.funding_checkpoint === record.funding_checkpoint
      && canonical(pending.ciphertexts) === canonical(record.ciphertexts);
  }

  quoteMatches(quote, record, height) {
    return Boolean(quote) && quote.nonce === record.nonce && quote.commitment === record.commitment
      && quote.quote_terms === record.quote_terms && quote.open_price_ticks === record.open_price_ticks
      && quote.expires_at >= height + QUOTE_MARGIN_BLOCKS;
  }

  async verifyAcks(acks, pending, record) {
    const commitmentBytes = fromBase64(record.commitment, 32);
    for (let i = 0; i < M.KEEPER_COUNT; i += 1) {
      const msg = await M.ackMessage(this.ctx.market, record.nonce, commitmentBytes,
        fromBase64(pending.ciphertexts[i], M.CIPHERTEXT_LEN), i);
      if (!verifyEd25519(fromBase64(acks[i], 64), msg, this.ctx.ackKeys[i])) {
        throw new Error(`keeper ${i === 0 ? 'A' : 'B'} acknowledgment does not verify for this opening`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Close.
  // ------------------------------------------------------------------

  onClose() {
    return this.run('Closing position', () => this.close());
  }

  async close() {
    let chain = await this.refresh();
    const { active } = chain;
    if (!active) throw new Error('there is no active position');
    const record = await this.openingRecord();
    if (!record || record.commitment !== active.commitment || record.nonce !== active.nonce
      || record.funding_checkpoint !== active.funding_checkpoint || !(await this.recordIntegrity(record))) {
      throw new Error('this browser does not hold the secret opening of the active position');
    }
    const w = record.witness;
    // Every attempt closes exactly this slot; nothing else is ever proven or sent.
    const { nonce, commitment, funding_checkpoint: checkpoint } = active;

    for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
      this.progress('Checking the oracle round for close');
      chain = await this.freshChain(attempt === 0 ? chain : null);
      if (!chain.active) throw new Error('the position was settled before close (keeper liquidation)');
      if (chain.active.nonce !== nonce || chain.active.commitment !== commitment
        || chain.active.funding_checkpoint !== checkpoint) {
        throw new Error('the active position changed during close; nothing was sent');
      }
      const o = chain.oracle;
      const delta = o.funding_cents - checkpoint;
      if (delta < 0 || delta > M.MAX_FUNDING_DELTA_CENTS) throw new Error('funding delta is outside 0..=200');
      const expected = M.settlement('close', w, o.price_ticks, delta);
      const l = chain.ledger;
      if (l.maker_vault + M.ESCROW_CENTS - expected.refund < l.maker_reserved - M.MAKER_RESERVE_CENTS) {
        throw new Error('the maker vault cannot cover this close refund');
      }
      this.progress('Proving close locally');
      const out = await this.prover.prove('close', this.ctx.vk.close, {
        ...w, round: o.round, price_ticks: o.price_ticks, funding_cents: delta,
      }, (s) => this.progress(s));
      if (out.commitment !== commitment || out.refund !== expected.refund || out.bad_debt !== expected.bad_debt) {
        throw new Error('the close proof output does not match the local settlement model');
      }
      // Proving takes time: the round must still be current and still fresh
      // at the final height reached now, not at the height read before proving.
      const [latest, block] = await Promise.all([
        this.ctx.rpc.view(this.ctx.session.market_id, 'get_oracle'), this.ctx.rpc.finalBlock(),
      ]);
      if (!latest || latest.round !== o.round) continue; // a new round landed while proving
      if (block.header.height - o.height > M.ORACLE_FRESHNESS_BLOCKS - CLOSE_MARGIN_BLOCKS) continue;

      this.progress('Closing on chain');
      const before = chain.ledger.trader_available;
      let result;
      try {
        result = await this.ctx.chain.call('close', this.ctx.session.market_id, [functionCall('close', {
          nonce, root: commitment, round: o.round,
          refund: out.refund, bad_debt: out.bad_debt, proof: out.proof,
        })]);
      } catch (error) {
        if (error instanceof TxFailedError && ['ERR_ROUND_MISMATCH', 'ERR_ORACLE_STALE'].includes(error.reason)) continue;
        if (error instanceof TxFailedError && error.reason === 'ERR_NO_ACTIVE') {
          throw new Error('Keeper B settled the position first; the close was refused on chain');
        }
        throw error;
      }
      chain = await this.refresh();
      if (chain.active) throw new Error(`close ${result.hash} finalized but the position is still active`);
      await this.store.delete(OPENING);
      // The trader settled this slot; Keeper B will report no liquidation for it.
      if ((await this.keeperRecord())?.nonce === nonce) await this.store.delete(KEEPER);
      this.state = {
        ...this.state,
        notice: `Closed nonce ${nonce}: refund ${usd(out.refund)} mUSDC`
          + ` (available ${usd(before)} → ${usd(chain.ledger.trader_available)})`,
      };
      return;
    }
    throw new Error('the oracle kept moving during close proving; try again');
  }
}

function describe(error) {
  if (error instanceof RangeError || error instanceof TypeError) return error.message;
  return error?.message ?? String(error);
}
