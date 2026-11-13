// Testnet-first session coordinator. Each consumer session gets its own
// trader account (holding only the browser's public key) and its own isolated
// clearing market under the existing demo root, operated by the existing
// maker, oracle and keeper roles with the existing mock token and proving keys.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { utils } from 'near-api-js';
import { makerApproval, positionContext } from '../../tests/actor.mjs';
import { MAX_PRICE_TICKS, NEAR, RESERVE_CENTS } from './config.mjs';
import { isHealthyRefusal } from './actors.mjs';
import { HttpError, KeyedSerializer, safeMessage, sha256Hex } from './util.mjs';
import { FAUCET_GRANT_CENTS, FAUCET_WINDOW_MS, faucetAuthorization, nep413Digest } from '../src/protocol/wallet-messages.js';

export const NO_CODE = '11111111111111111111111111111111';
const ONE_YOCTO = { attachedDeposit: 1n };
const REGISTRATION_DEPOSIT = 10n ** 22n;
const GAS_ALLOWANCE = NEAR / 10n;
const MAX_ATTEMPTS_KEPT = 50;
// Bounded tries of one oracle round after transient (non-healthy) failures.
export const MAX_ROUND_ATTEMPTS = 3;
// Short time backoff after a failed oracle refresh send (never a block bar).
export const REFRESH_RETRY_MS = 2_000;
// The client contract: a session view carries at most the latest 64 receipts.
// The durable record keeps the full history.
export const MAX_VIEW_RECEIPTS = 64;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_PROOF_PREFIX = 'xythum:exchange:session:v1:testnet:';
const BEARER_PREFIX = Buffer.from('xythum:exchange:bearer:v1:');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PROOF = /^[A-Za-z0-9+/]{86}==$/;

const isU32 = (value, min = 0) => Number.isSafeInteger(value) && value >= min && value <= 0xffff_ffff;
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const isDigest = (value) => typeof value === 'string' && value.length === 44
  && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value;

function exactKeys(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'expected a JSON object');
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'unexpected_field', 'unexpected field ' + JSON.stringify(key.slice(0, 32)));
  }
}

export function parsePublicKey(value) {
  if (typeof value !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new HttpError(400, 'invalid_public_key', 'public_key must be a NEAR ed25519 public key');
  }
  let key;
  try {
    key = utils.PublicKey.fromString(value);
  } catch {
    throw new HttpError(400, 'invalid_public_key', 'public_key must be a NEAR ed25519 public key');
  }
  if (key.keyType !== 0 || key.data.length !== 32 || key.toString() !== value) {
    throw new HttpError(400, 'invalid_public_key', 'public_key must be canonical');
  }
  return value;
}

// Proof of possession for POST /api/sessions: canonical padded Base64 of the
// 64-byte Ed25519 signature over UTF-8 SESSION_PROOF_PREFIX + public_key.
// Returns the raw signature, or throws the same 401 for every bad proof, before
// any session state is consulted, so a bad proof learns nothing about a key.
export function verifySessionProof(publicKey, proof) {
  const invalid = () => new HttpError(401, 'invalid_proof', 'proof must be an Ed25519 signature by public_key');
  if (typeof proof !== 'string' || !PROOF.test(proof)) throw invalid();
  const signature = Buffer.from(proof, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== proof) throw invalid();
  if (!verifyEd25519(publicKey, Buffer.from(SESSION_PROOF_PREFIX + publicKey, 'utf8'), signature)) throw invalid();
  return signature;
}

function verifyEd25519(publicKey, message, signature) {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, Buffer.from(utils.PublicKey.fromString(publicKey).data)]),
      format: 'der', type: 'spki',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

// The bearer is derived from the proof, so the key holder re-derives the same
// capability on every retry. Ed25519 signing is deterministic, so a retry with
// the same key and message yields the same proof.
export const bearerFromSignature = (signature) =>
  createHash('sha256').update(Buffer.concat([BEARER_PREFIX, signature])).digest('base64url');

export const sessionAccountIds = (key, root) => {
  const suffix = key.slice(2, 14);
  return { trader_id: 'trader-' + suffix + '.' + root, market_id: 'market-' + suffix + '.' + root };
};

export function isFullAccessOnly(keys, publicKey) {
  return keys.length === 1 && keys[0].public_key === publicKey && keys[0].permission === 'FullAccess';
}

export class Coordinator {
  #inflight = new Map();
  #reserved = new Set();
  #lastCreateByClient = new Map();
  #serial = new KeyedSerializer();
  #refreshRetryAt = new Map();
  #wake = null;

  /**
   * deps.chain     adapter (see testnet.mjs) for final views and role-signed transactions
   * deps.actors    { ack(session, index), liquidate(session) } keeper actor runner
   * deps.store     durable session store
   * deps.ids       { root, token, maker, oracle, keepers: [a, b], forbidden: [existing market, ...], rolePublicKeys }
   * deps.keeperAckKeys / keeperEncryptionKeys  public keeper keys from the demo env
   * deps.vks       { open_vk, liquidation_vk, close_vk } and deps.fingerprints
   * deps.marketWasm / deps.marketCodeHash      Wasm bytes and its base58 SHA-256
   * deps.marketDeployKey  existing MARKET role public key, added only until deploy+init deletes it
   * deps.chainId / deps.rpcUrl  must be 'testnet' and the pinned testnet RPC
   */
  constructor(deps) {
    Object.assign(this, { now: () => Date.now(), random: randomBytes }, deps);
    const { root } = this.ids;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.testnet$/.test(root)) throw new Error('expected a named .testnet demo root');
    if (this.chainId !== 'testnet') throw new Error('the coordinator only supports testnet');
    this.forbidden = new Set(this.ids.forbidden);
    this.marketNear = this.config.marketNear
      ?? BigInt(this.marketWasm.length) * 10n ** 19n + NEAR / 2n;
  }

  setWake(callback) {
    this.#wake = callback;
  }

  // -- Signing guards -------------------------------------------------------

  #assertSessionAccount(id, kind) {
    const pattern = new RegExp('^' + kind + '-[0-9a-f]{12}\\.' + this.ids.root.replace(/[.]/g, '\\.') + '$');
    if (!pattern.test(id) || id.length > 64 || this.forbidden.has(id)) {
      throw new Error('refusing to act on non-session account ' + id);
    }
  }

  #assertTarget(contractId) {
    if (contractId === this.ids.token) return;
    this.#assertSessionAccount(contractId, 'market');
    if (!this.store.find((record) => record.market_id === contractId)) {
      throw new Error('refusing to call unrecorded market ' + contractId);
    }
  }

  // Unlocked call: the caller must already hold the signer's serializer.
  async #callHeld(signer, contractId, method, args, options) {
    this.#assertTarget(contractId);
    return this.chain.call(signer, contractId, method, args, options);
  }

  #call(signer, contractId, method, args, options) {
    return this.#serial.run('signer:' + signer, () => this.#callHeld(signer, contractId, method, args, options));
  }

  #view(contractId, method, args) {
    return this.chain.view(contractId, method, args);
  }

  async #save(record) {
    return this.store.save(record);
  }

  async #receipt(record, label, tx) {
    const receipt = { label, hash: tx.hash };
    record.receipts.push(receipt);
    await this.#save(record);
    return receipt;
  }

  // -- Session creation -----------------------------------------------------

  // Body: exactly {public_key, proof}, plus an optional strict-boolean
  // `restore_only`. With `restore_only: true` the request only recovers an
  // existing ready session for this key and proof (see #recoverSession).
  async claimFaucet(body, origin, client) {
    exactKeys(body, ['public_key', 'proof', 'wallet']);
    exactKeys(body.wallet, ['account_id', 'public_key', 'signature', 'expires_at']);
    const traderKey = parsePublicKey(body.public_key);
    verifySessionProof(traderKey, body.proof);
    const { account_id: account, public_key: ownerKey, signature, expires_at: expiry } = body.wallet;
    const invalid = () => new HttpError(401, 'invalid_wallet_proof', 'sign a fresh claim with your connected testnet wallet');
    const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
    const now = this.now();
    if (typeof account !== 'string' || !accountPattern.test(account) || this.forbidden.has(account)
      || !Number.isSafeInteger(expiry) || expiry <= now || expiry > now + FAUCET_WINDOW_MS
      || typeof signature !== 'string' || !PROOF.test(signature) || parsePublicKey(ownerKey) === traderKey) {
      throw invalid();
    }
    const bytes = Buffer.from(signature, 'base64');
    const digest = await nep413Digest(await faucetAuthorization(origin, account, traderKey, expiry));
    if (bytes.toString('base64') !== signature || !verifyEd25519(ownerKey, digest, bytes)) throw invalid();
    if (!await this.chain.accountState(account)) throw invalid();
    const keys = await this.chain.accessKeys(account);
    if (!keys.some((key) => key.public_key === ownerKey && key.permission === 'FullAccess')) throw invalid();

    const claimId = sha256Hex('quiet-margin:testnet:faucet:v1:' + account);
    return this.#serial.run('faucet:' + claimId, () =>
      this.createSession({ public_key: traderKey, proof: body.proof }, client, claimId));
  }

  async createSession(body, client = 'local', claimId = null) {
    exactKeys(body, ['public_key', 'proof', 'restore_only']);
    if (!('public_key' in body) || !('proof' in body)) {
      throw new HttpError(400, 'invalid_body', 'expected exactly {public_key, proof} and optionally restore_only');
    }
    if ('restore_only' in body && typeof body.restore_only !== 'boolean') {
      throw new HttpError(400, 'invalid_restore_only', 'restore_only must be a JSON boolean');
    }
    const restoreOnly = body.restore_only === true;
    const publicKey = parsePublicKey(body.public_key);
    // Proof of possession comes first: nothing below (inflight setups, durable
    // records, quotas or cooldowns) is consulted for a caller without the key.
    const token = bearerFromSignature(verifySessionProof(publicKey, body.proof));
    const tokenHash = sha256Hex(token);
    if (this.ids.rolePublicKeys.includes(publicKey)) {
      throw new HttpError(400, 'invalid_public_key', 'public_key must be freshly generated by the browser');
    }
    const mismatch = () => new HttpError(409, 'session_exists',
      'a session for this public key was created with a different proof');
    if (restoreOnly) return this.#recoverSession(publicKey, token, tokenHash, mismatch);
    if (!claimId && this.config.walletFaucet) {
      throw new HttpError(403, 'wallet_claim_required', 'connect a NEAR wallet to claim test collateral');
    }
    if (claimId && this.store.find((r) => r.wallet_claim_id === claimId && r.public_key !== publicKey)) {
      throw new HttpError(409, 'wallet_already_funded', 'this wallet already claimed test collateral');
    }

    const inflight = this.#inflight.get(publicKey);
    if (inflight) {
      if (inflight.tokenHash !== tokenHash) throw mismatch();
      if (inflight.claimId !== claimId) throw mismatch();
      return inflight.promise;
    }

    const record = this.store.find((candidate) => candidate.public_key === publicKey);
    if (record?.token_hash && record.token_hash !== tokenHash) throw mismatch();
    if (record && (record.wallet_claim_id ?? null) !== claimId) throw mismatch();
    if (record?.status === 'ready') {
      // A lost response is recoverable: the key holder re-derives the same
      // capability and gets the same session back, with no new transaction.
      return this.sessionView(record, token);
    }
    if (this.#inflight.size >= this.config.setupQueue) {
      throw new HttpError(503, 'setup_busy', 'session setup queue is full; retry shortly', { 'Retry-After': '10' });
    }
    let reserved = null;
    if (!record) {
      if (this.config.sessionQuota === 0) {
        throw new HttpError(503, 'quota_unset', 'session creation is disabled until XYTHUM_SESSION_QUOTA is set');
      }
      const unsaved = [...this.#reserved].filter((key) => !this.store.get(key)).length;
      if (this.store.size + unsaved >= this.config.sessionQuota) {
        throw new HttpError(429, 'quota_exhausted', 'the testnet session quota is exhausted');
      }
      const last = this.#lastCreateByClient.get(client);
      if (this.config.createCooldownMs > 0 && last !== undefined && this.now() - last < this.config.createCooldownMs) {
        throw new HttpError(429, 'cooldown', 'retry session creation later',
          { 'Retry-After': String(Math.ceil((this.config.createCooldownMs - (this.now() - last)) / 1000)) });
      }
      this.#lastCreateByClient.set(client, this.now());
      reserved = this.#reserveKey();
    }
    // Claim the single-flight slot synchronously, before any await, so a
    // concurrent request for the same key joins this setup instead of
    // reserving a second record. The work starts only after the claim.
    let start;
    const gate = new Promise((resolve) => { start = resolve; });
    const promise = gate.then(async () => {
      try {
        let current = record;
        if (!current) {
          current = await this.#newRecord(publicKey, reserved, tokenHash, claimId);
        } else if (!current.token_hash) {
          // A record from before proofs were required binds to the first valid proof.
          current.token_hash = tokenHash;
          await this.#save(current);
        }
        return await this.#serial.run('setup', () => this.#provision(current.key, token));
      } finally {
        if (reserved) this.#reserved.delete(reserved);
        this.#inflight.delete(publicKey);
      }
    });
    this.#inflight.set(publicKey, { promise, tokenHash, claimId });
    start();
    return promise;
  }

  // Recovery-only enrollment, reached only after the same body, proof and
  // role-key checks as ordinary enrollment. It returns the existing ready
  // session whose durable record is bound to this exact proof-derived bearer,
  // or refuses. It never joins or starts a setup, never consults or consumes
  // the queue, quota or cooldown, never writes a durable record and never
  // signs a transaction: the only chain access is the read-only session view.
  async #recoverSession(publicKey, token, tokenHash, mismatch) {
    const inflight = this.#inflight.get(publicKey);
    if (inflight && inflight.tokenHash !== tokenHash) throw mismatch();
    const record = this.store.find((candidate) => candidate.public_key === publicKey);
    if (record?.token_hash && record.token_hash !== tokenHash) throw mismatch();
    if (inflight || (record && record.status !== 'ready')) {
      throw new HttpError(409, 'session_not_ready',
        'the session for this key is not ready; start a session normally to resume its setup');
    }
    if (!record) {
      throw new HttpError(404, 'session_not_found',
        'no session exists for this key; nothing was created. Start a new session to enroll it');
    }
    if (!record.token_hash) {
      // A ready record that predates proofs has no bearer binding to recover against.
      throw new HttpError(409, 'session_unbound', 'the session for this key is not bound to a proof and cannot be recovered');
    }
    return this.sessionView(record, token);
  }

  #reserveKey() {
    let key;
    do key = 's-' + this.random(12).toString('hex');
    while (this.store.get(key) || this.#reserved.has(key)
      || this.store.find((r) => r.market_id === sessionAccountIds(key, this.ids.root).market_id));
    this.#reserved.add(key);
    return key;
  }

  async #newRecord(publicKey, key, tokenHash, claimId) {
    const ids = sessionAccountIds(key, this.ids.root);
    this.#assertSessionAccount(ids.trader_id, 'trader');
    this.#assertSessionAccount(ids.market_id, 'market');
    // Only the hash of the proof-derived bearer is stored; authenticate()
    // accepts it only once the record is ready.
    const record = {
      key, version: 1, status: 'provisioning', public_key: publicKey, token_hash: tokenHash,
      ...ids, deployment_id: this.random(32).toString('base64'),
      ...(claimId && { wallet_claim_id: claimId }),
      created_at: new Date(this.now()).toISOString(),
      steps: {}, receipts: [], marks: 0, last_mark_at: 0,
      refreshes: 0, approvals: 0, keeper: null, last_error: null,
    };
    return this.#save(record);
  }

  async #provision(key, token) {
    const record = this.store.get(key);
    if (record.status === 'ready') return this.sessionView(record, token);
    try {
      await this.#preflight(record);
      await this.#ensureMarket(record);
      await this.#ensureRegistered(record, record.market_id, 'market_registration');
      await this.#ensureMakerVault(record);
      await this.#ensureInitialOracle(record);
      // The trader account is created last so its key is public on chain only briefly before completion.
      await this.#ensureTrader(record);
      await this.#ensureRegistered(record, record.trader_id, 'trader_registration');
      await this.#ensureTraderFunds(record);
      if (!isFullAccessOnly(await this.chain.accessKeys(record.trader_id), record.public_key)) {
        throw new Error('trader account must hold only the browser public key');
      }
      // Build the response before committing; a read that fails leaves the
      // session resumable. A lost response is recovered by a valid retry.
      const view = await this.sessionView(record, token);
      record.token_hash = sha256Hex(token);
      record.status = 'ready';
      record.last_error = null;
      await this.#save(record);
      return view;
    } catch (error) {
      record.last_error = safeMessage(error);
      await this.#save(record);
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'setup_incomplete',
        'session setup did not complete; retry with the same public key to resume');
    }
  }

  async #preflight(record) {
    let near = GAS_ALLOWANCE;
    if (!record.steps.market_account) near += this.marketNear;
    if (!record.steps.trader_account) near += this.config.traderNear;
    if (!record.steps.market_registration) near += REGISTRATION_DEPOSIT;
    if (!record.steps.trader_registration) near += REGISTRATION_DEPOSIT;
    const root = await this.chain.accountState(this.ids.root);
    if (!root) throw new Error('demo root account is missing');
    const spendable = BigInt(root.amount) - BigInt(root.storage_usage) * 10n ** 19n;
    if (spendable < near + this.config.rootReserve) {
      throw new HttpError(503, 'root_capacity', 'the demo root lacks testnet NEAR for another session');
    }
    let cents = 0;
    if (!record.steps.trader_funds) cents += this.#grantAmount(record);
    if (!record.steps.maker_vault) {
      const wallet = Number(await this.#view(this.ids.token, 'ft_balance_of', { account_id: this.ids.maker }));
      cents += Math.max(this.config.makerVaultMusdc - wallet, 0);
    }
    const rootTokens = Number(await this.#view(this.ids.token, 'ft_balance_of', { account_id: this.ids.root }));
    if (rootTokens < cents) {
      throw new HttpError(503, 'token_capacity', 'the demo root lacks mock mUSDC for another session');
    }
  }

  async #ensureMarket(record) {
    const id = record.market_id;
    this.#assertSessionAccount(id, 'market');
    let state = await this.chain.accountState(id);
    if (!state) {
      if (record.steps.market_account === 'done') throw new Error('recorded session market is missing');
      record.steps.market_account = 'submitting';
      await this.#save(record);
      const tx = await this.#serial.run('signer:DEMO', () => this.chain.createMarketAccount(id, this.marketNear));
      record.steps.market_account = 'done';
      await this.#receipt(record, 'market_account', tx);
      state = await this.chain.accountState(id);
    } else if (!record.steps.market_account) {
      throw new Error('session market account already exists without a record');
    } else if (record.steps.market_account !== 'done') {
      record.steps.market_account = 'done';
      await this.#save(record);
    }

    if (state.code_hash === NO_CODE) {
      if (!isFullAccessOnly(await this.chain.accessKeys(id), this.marketDeployKey)) {
        throw new Error('session market has unexpected access keys');
      }
      record.steps.market_deploy = 'submitting';
      await this.#save(record);
      const tx = await this.#serial.run('signer:MARKET', () => this.chain.deployMarket(id, this.marketWasm, {
        token_id: this.ids.token, trader_id: record.trader_id, maker_id: this.ids.maker,
        oracle_id: this.ids.oracle,
        keepers: this.ids.keepers.map((account_id, index) => ({ account_id, ack_key: this.keeperAckKeys[index] })),
        deployment_id: record.deployment_id, ...this.vks,
      }));
      record.steps.market_deploy = 'done';
      await this.#receipt(record, 'market_deploy', tx);
      state = await this.chain.accountState(id);
    }
    if (state.code_hash !== this.marketCodeHash) throw new Error('session market code differs from the market Wasm');
    if ((await this.chain.accessKeys(id)).length !== 0) throw new Error('session market must be locked');
    const config = await this.#view(id, 'get_config');
    const expected = {
      token_id: this.ids.token, trader_id: record.trader_id, maker_id: this.ids.maker,
      oracle_id: this.ids.oracle, deployment_id: record.deployment_id,
      open_vk_sha256: this.fingerprints.open, liquidation_vk_sha256: this.fingerprints.liquidation,
      close_vk_sha256: this.fingerprints.close,
    };
    for (const [name, value] of Object.entries(expected)) {
      if (config[name] !== value) throw new Error('session market config mismatch: ' + name);
    }
    const keepers = this.ids.keepers.map((account_id, index) => ({ account_id, ack_key: this.keeperAckKeys[index] }));
    if (JSON.stringify(config.keepers) !== JSON.stringify(keepers)) throw new Error('session market keepers mismatch');
    record.market_hash = await this.#view(id, 'get_market');
    record.steps.market_deploy = 'done';
    await this.#save(record);
  }

  async #ensureRegistered(record, accountId, step) {
    if (await this.#view(this.ids.token, 'storage_balance_of', { account_id: accountId }) === null) {
      const tx = await this.#call('DEMO', this.ids.token, 'storage_deposit',
        { account_id: accountId, registration_only: true }, { attachedDeposit: REGISTRATION_DEPOSIT });
      await this.#receipt(record, step, tx);
    }
    record.steps[step] = 'done';
    await this.#save(record);
  }

  // The maker wallet is shared by every session, so its read-transfer-deposit
  // sequence runs while holding both the root and maker signers.
  async #ensureMakerVault(record) {
    if (record.steps.maker_vault === 'done') return;
    await this.#serial.runAll(['signer:DEMO', 'signer:MAKER'], async () => {
      const ledger = await this.#view(record.market_id, 'get_ledger');
      const need = this.config.makerVaultMusdc - ledger.maker_vault;
      if (need > 0) {
        const wallet = Number(await this.#view(this.ids.token, 'ft_balance_of', { account_id: this.ids.maker }));
        if (wallet < need) {
          const tx = await this.#callHeld('DEMO', this.ids.token, 'ft_transfer',
            { receiver_id: this.ids.maker, amount: String(need - wallet) }, ONE_YOCTO);
          await this.#receipt(record, 'maker_musdc_transfer', tx);
        }
        const tx = await this.#callHeld('MAKER', this.ids.token, 'ft_transfer_call',
          { receiver_id: record.market_id, amount: String(need), msg: 'maker' }, ONE_YOCTO);
        await this.#receipt(record, 'maker_vault_deposit', tx);
      }
      const funded = await this.#view(record.market_id, 'get_ledger');
      if (funded.maker_vault < this.config.makerVaultMusdc) throw new Error('maker vault deposit was not credited');
    });
    record.steps.maker_vault = 'done';
    await this.#save(record);
  }

  async #ensureInitialOracle(record) {
    if (await this.#view(record.market_id, 'get_oracle') === null) {
      const tx = await this.#call('ORACLE', record.market_id, 'publish_oracle',
        { round: 1, price_ticks: this.config.initialPriceTicks, funding_cents: 0 });
      await this.#receipt(record, 'mark_1', tx);
    }
    record.steps.initial_oracle = 'done';
    await this.#save(record);
  }

  async #ensureTrader(record) {
    const id = record.trader_id;
    this.#assertSessionAccount(id, 'trader');
    const state = await this.chain.accountState(id);
    if (!state) {
      if (record.steps.trader_account === 'done') throw new Error('recorded trader account is missing');
      record.steps.trader_account = 'submitting';
      await this.#save(record);
      const tx = await this.#serial.run('signer:DEMO',
        () => this.chain.createTraderAccount(id, this.config.traderNear, record.public_key));
      await this.#receipt(record, 'trader_account', tx);
    } else if (!record.steps.trader_account) {
      throw new Error('trader account already exists without a record');
    }
    if (!isFullAccessOnly(await this.chain.accessKeys(id), record.public_key)) {
      throw new Error('trader account must hold only the browser public key');
    }
    record.steps.trader_account = 'done';
    await this.#save(record);
  }

  #grantAmount(record) {
    return record.wallet_claim_id ? FAUCET_GRANT_CENTS : this.config.traderMusdc;
  }

  async #ensureTraderFunds(record) {
    if (record.steps.trader_funds === 'done') return;
    await this.#serial.run('signer:DEMO', async () => {
      const wallet = Number(await this.#view(this.ids.token, 'ft_balance_of', { account_id: record.trader_id }));
      const ledger = await this.#view(record.market_id, 'get_ledger');
      const held = wallet + ledger.trader_available + ledger.trader_locked;
      const grant = this.#grantAmount(record);
      if (held < grant) {
        if (record.wallet_claim_id) {
          if (record.steps.trader_funds === 'submitting') {
            throw new HttpError(503, 'claim_pending_review', 'the prior transfer must be reconciled before funding can resume');
          }
          // A lost submission response must never authorize a second grant.
          record.steps.trader_funds = 'submitting';
          await this.#save(record);
        }
        const tx = await this.#callHeld('DEMO', this.ids.token, 'ft_transfer',
          { receiver_id: record.trader_id, amount: String(grant - held) }, ONE_YOCTO);
        await this.#receipt(record, 'trader_musdc_transfer', tx);
      }
    });
    record.steps.trader_funds = 'done';
    await this.#save(record);
  }

  // -- Authenticated session ------------------------------------------------

  authenticate(header) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? '');
    if (!match || !TOKEN.test(match[1])) throw new HttpError(401, 'unauthorized', 'missing or invalid session');
    const hash = sha256Hex(match[1]);
    const record = this.store.find((candidate) => candidate.status === 'ready' && candidate.token_hash === hash);
    if (!record) throw new HttpError(401, 'unauthorized', 'missing or invalid session');
    return { record, token: match[1] };
  }

  async sessionView(record, token) {
    const [oracle, ledger] = await Promise.all([
      this.#view(record.market_id, 'get_oracle'),
      this.#view(record.market_id, 'get_ledger'),
    ]);
    return {
      session_id: token,
      trader_id: record.trader_id,
      market_id: record.market_id,
      token_id: this.ids.token,
      chain_id: 'testnet',
      rpc_url: this.rpcUrl,
      keeper_encryption_keys: [...this.keeperEncryptionKeys],
      keeper_armed: Boolean(record.keeper?.armed),
      receipts: record.receipts.slice(-MAX_VIEW_RECEIPTS).map(({ label, hash }) => ({ label, hash })),
      ...(oracle ? { oracle } : {}),
      ledger,
    };
  }

  async approve(record, body) {
    exactKeys(body, ['nonce', 'commitment', 'quote_blinder', 'size_lots', 'entry_ticks']);
    const { nonce, commitment, quote_blinder, size_lots, entry_ticks } = body;
    if (!isU32(nonce, 1) || !isDigest(commitment) || !isDigest(quote_blinder)
      || !isInt(size_lots, 1, 50) || !isInt(entry_ticks, 1, MAX_PRICE_TICKS)) {
      throw new HttpError(400, 'invalid_quote', 'nonce, commitment, quote_blinder, size_lots and entry_ticks are required');
    }
    return this.#serial.run('session:' + record.key, async () => {
      const pending = await this.#view(record.market_id, 'get_pending');
      if (!pending) throw new HttpError(409, 'no_pending', 'stage the position before requesting approval');
      if (pending.nonce !== nonce || pending.commitment !== commitment) {
        throw new HttpError(409, 'pending_mismatch', 'the staged position differs from this request');
      }
      const market = await this.#view(record.market_id, 'get_market');
      const offer = {
        context: positionContext(market, pending.nonce, pending.funding_checkpoint, record.trader_id),
        size_lots, entry_ticks, quote_blinder,
      };
      let terms;
      try {
        terms = makerApproval(pending, offer, market, record.trader_id);
      } catch (error) {
        const known = ['quote is outside the demo maker price band', 'maker quote terms changed'];
        throw new HttpError(422, 'quote_rejected',
          known.includes(error.message) ? error.message : 'quote does not match the staged position');
      }
      const ledger = await this.#view(record.market_id, 'get_ledger');
      if (ledger.halted) throw new HttpError(409, 'market_halted', 'the session market is halted');
      if (ledger.maker_vault - ledger.maker_reserved < RESERVE_CENTS) {
        throw new HttpError(409, 'maker_reserve', 'the maker vault cannot reserve another position');
      }

      // Each keeper independently decrypts its own envelope and signs; this
      // spends no gas, so it runs before the maker approval transaction.
      let acknowledgments;
      try {
        acknowledgments = await Promise.all([0, 1].map((index) => this.actors.ack(record, index)));
      } catch (error) {
        throw new HttpError(422, 'keeper_refused', 'a keeper could not verify its envelope: ' + safeMessage(error, 120));
      }
      for (const signature of acknowledgments) {
        if (typeof signature !== 'string' || Buffer.from(signature, 'base64').length !== 64) {
          throw new HttpError(502, 'keeper_refused', 'a keeper returned a malformed acknowledgment');
        }
      }

      const label = 'quote_' + nonce;
      const height = await this.chain.finalHeight();
      const existing = await this.#view(record.market_id, 'get_quote');
      const previous = [...record.receipts].reverse().find((receipt) => receipt.label === label);
      if (existing && previous && existing.nonce === nonce && existing.commitment === commitment
        && existing.quote_terms === pending.quote_terms && existing.expires_at > height + 50) {
        return { acknowledgments, receipt: { label, hash: previous.hash } };
      }
      if (record.approvals >= this.config.approvalsPerSession) {
        throw new HttpError(429, 'approval_limit', 'this session reached its maker approval limit');
      }
      record.approvals += 1;
      await this.#save(record);
      const tx = await this.#call('MAKER', record.market_id, 'approve_quote',
        { ...terms, expires_at: height + this.config.quoteTtlBlocks });
      const receipt = await this.#receipt(record, label, tx);
      return { acknowledgments, receipt };
    });
  }

  async mark(record, body) {
    exactKeys(body, ['price_ticks']);
    const { price_ticks } = body;
    if (!isInt(price_ticks, this.config.markMin, this.config.markMax)) {
      throw new HttpError(400, 'invalid_mark',
        'price_ticks must be an integer in ' + this.config.markMin + '..' + this.config.markMax);
    }
    return this.#serial.run('session:' + record.key, async () => {
      if (record.marks >= this.config.marksPerSession) {
        throw new HttpError(429, 'mark_limit', 'this session reached its oracle mark limit');
      }
      const wait = record.last_mark_at + this.config.markIntervalMs - this.now();
      if (wait > 0) {
        throw new HttpError(429, 'mark_rate', 'oracle marks are rate limited',
          { 'Retry-After': String(Math.ceil(wait / 1000)) });
      }
      record.marks += 1;
      record.last_mark_at = this.now();
      await this.#save(record);
      const { oracle, tx } = await this.#serial.run('signer:ORACLE', async () => {
        const previous = await this.#view(record.market_id, 'get_oracle');
        const round = (previous?.round ?? 0) + 1;
        // Cumulative funding is retained; a same-price refresh keeps a prepared opening valid.
        const funding_cents = previous?.funding_cents ?? 0;
        const tx = await this.#callHeld('ORACLE', record.market_id, 'publish_oracle', { round, price_ticks, funding_cents });
        const current = await this.#view(record.market_id, 'get_oracle');
        if (current?.round !== round) throw new Error('published oracle round is not final');
        return { oracle: current, tx };
      });
      const receipt = await this.#receipt(record, 'mark_' + oracle.round, tx);
      this.#wake?.(record.key);
      return { oracle, receipt };
    });
  }

  // Keeps the current oracle round usable for a close or open without a user
  // price: republishes the current price and cumulative funding as round + 1,
  // only when the final round is at least `refreshAfterBlocks` old. A younger
  // round is returned as is, with no transaction. Separate from the user mark
  // quota and never capped per session: the age check, re-read from final
  // chain state under the oracle signer lock, allows at most one publish per
  // `refreshAfterBlocks` window. A failed send only defers a retry by a short
  // time backoff, never by blocks, so a lost send cannot strand a position.
  async refresh(record, body) {
    exactKeys(body, []);
    return this.#serial.run('session:' + record.key, async () => {
      const after = this.config.refreshAfterBlocks;
      const finalOracle = async () => {
        const [oracle, height] = await Promise.all([
          this.#view(record.market_id, 'get_oracle'),
          this.chain.finalHeight(),
        ]);
        if (!oracle) throw new HttpError(409, 'no_oracle', 'the session market has no oracle round');
        if (!Number.isSafeInteger(oracle.height) || !Number.isSafeInteger(height)) {
          throw new HttpError(502, 'oracle_unavailable', 'the oracle round height is unavailable');
        }
        return { oracle, fresh: height - oracle.height < after };
      };
      const observed = await finalOracle();
      if (observed.fresh) return { oracle: observed.oracle };
      const wait = (this.#refreshRetryAt.get(record.key) ?? 0) - this.now();
      if (wait > 0) {
        throw new HttpError(429, 'refresh_retry', 'the last oracle refresh failed; retry shortly',
          { 'Retry-After': String(Math.ceil(wait / 1000)) });
      }
      let result;
      try {
        result = await this.#serial.run('signer:ORACLE', async () => {
          // Re-checked under the signer lock: a refresh that already landed is reused.
          const { oracle: previous, fresh } = await finalOracle();
          if (fresh) return { oracle: previous, tx: null };
          const round = previous.round + 1;
          const tx = await this.#callHeld('ORACLE', record.market_id, 'publish_oracle',
            { round, price_ticks: previous.price_ticks, funding_cents: previous.funding_cents });
          const current = await this.#view(record.market_id, 'get_oracle');
          if (current?.round !== round) throw new Error('published oracle round is not final');
          return { oracle: current, tx };
        });
      } catch (error) {
        if (!(error instanceof HttpError)) this.#refreshRetryAt.set(record.key, this.now() + REFRESH_RETRY_MS);
        throw error;
      }
      this.#refreshRetryAt.delete(record.key);
      const { oracle, tx } = result;
      if (!tx) return { oracle };
      record.refreshes = (record.refreshes ?? 0) + 1;
      const receipt = await this.#receipt(record, 'refresh_' + oracle.round, tx);
      this.#wake?.(record.key);
      return { oracle, receipt };
    });
  }

  async keeper(record, body) {
    exactKeys(body, ['armed']);
    if (body.armed !== true) throw new HttpError(400, 'invalid_keeper', 'only {"armed": true} is supported');
    return this.#serial.run('session:' + record.key, async () => {
      const active = await this.#view(record.market_id, 'get_active');
      if (!active) throw new HttpError(409, 'no_active', 'there is no active position to guard');
      const current = record.keeper;
      if (!(current?.armed && current.nonce === active.nonce && current.commitment === active.commitment)) {
        record.keeper = {
          armed: true, nonce: active.nonce, commitment: active.commitment,
          armed_at: new Date(this.now()).toISOString(), last_round: null, retry: null, attempts: [],
          liquidation: null, settlement: null,
        };
        await this.#save(record);
      }
      const { receipt } = await this.attemptKeeper(record);
      return { keeper_armed: Boolean(record.keeper.armed), ...(receipt ? { receipt } : {}) };
    });
  }

  // Cold Keeper B attempts per distinct oracle round for an armed slot: one if
  // the prover refuses it as healthy (before any transaction), up to
  // MAX_ROUND_ATTEMPTS if it fails transiently. Re-arming resets the state.
  attemptKeeper(record) {
    return this.#serial.run('keeper:' + record.key, async () => {
      const keeper = record.keeper;
      if (!keeper?.armed) return {};
      const active = await this.#view(record.market_id, 'get_active');
      if (!active || active.nonce !== keeper.nonce || active.commitment !== keeper.commitment) {
        keeper.armed = false;
        keeper.settlement = {
          nonce: keeper.nonce,
          outcome: keeper.liquidation ? 'liquidated' : 'settled',
          ledger: await this.#view(record.market_id, 'get_ledger'),
          observed_at: new Date(this.now()).toISOString(),
        };
        await this.#save(record);
        return {};
      }
      const oracle = await this.#view(record.market_id, 'get_oracle');
      if (!oracle || (keeper.last_round !== null && oracle.round <= keeper.last_round)) return {};
      // A round is done only once it is liquidated, refused as healthy by the
      // prover, or has failed MAX_ROUND_ATTEMPTS times. Transient prover/RPC
      // errors leave it pending so a distressed round is not silently skipped.
      const failures = keeper.retry?.round === oracle.round ? keeper.retry.failures : 0;
      const attempt = { round: oracle.round, price_ticks: oracle.price_ticks, at: new Date(this.now()).toISOString() };
      let receipt;
      try {
        // Pin the armed slot: the actor refuses any other slot before it proves or signs.
        const pin = { expectedNonce: keeper.nonce, expectedCommitment: keeper.commitment };
        const result = await this.#serial.run('signer:KEEPER_B', () => this.actors.liquidate(record, pin));
        attempt.outcome = 'liquidated';
        attempt.hash = result.tx.hash;
        receipt = { label: 'liquidation_' + keeper.nonce, hash: result.tx.hash };
        record.receipts.push(receipt);
        keeper.liquidation = receipt;
        keeper.last_round = oracle.round;
        keeper.retry = null;
        if (await this.#view(record.market_id, 'get_active') === null) {
          keeper.armed = false;
          keeper.settlement = {
            nonce: keeper.nonce, outcome: 'liquidated', hash: receipt.hash,
            ledger: await this.#view(record.market_id, 'get_ledger'),
            observed_at: new Date(this.now()).toISOString(),
          };
        }
      } catch (error) {
        if (receipt) {
          // Liquidation landed; only the follow-up view failed. Never retry it.
          attempt.error = safeMessage(error, 160);
        } else if (isHealthyRefusal(error)) {
          attempt.outcome = 'healthy';
          keeper.last_round = oracle.round;
          keeper.retry = null;
        } else {
          attempt.outcome = 'error';
          attempt.error = safeMessage(error, 160);
          if (failures + 1 >= MAX_ROUND_ATTEMPTS) {
            attempt.exhausted = true;
            keeper.last_round = oracle.round;
            keeper.retry = null;
          } else {
            keeper.retry = { round: oracle.round, failures: failures + 1 };
          }
        }
      }
      keeper.attempts = [...keeper.attempts, attempt].slice(-MAX_ATTEMPTS_KEPT);
      await this.#save(record);
      return receipt ? { receipt } : {};
    });
  }

  armedSessions() {
    return this.store.all().filter((record) => record.status === 'ready' && record.keeper?.armed);
  }
}
