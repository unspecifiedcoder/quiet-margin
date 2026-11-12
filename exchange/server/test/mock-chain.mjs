// In-memory stand-in for the testnet adapter: enough of the mock token and the
// clearing market to exercise provisioning, approval, marks and keeper flows.
import { createHash, randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { NO_CODE } from '../coordinator.mjs';
import { NEAR } from '../config.mjs';

export const ROOT = 'xythum-perps-demo.testnet';
export const MARKET_DEPLOY_KEY = KeyPair.fromRandom('ed25519').getPublicKey().toString();
export const TRADER_ROLE_PAIR = KeyPair.fromRandom('ed25519');
export const TRADER_ROLE_KEY = TRADER_ROLE_PAIR.getPublicKey().toString();
export const IDS = {
  root: ROOT, token: 'musdc.' + ROOT, maker: 'maker.' + ROOT, oracle: 'oracle.' + ROOT,
  keepers: ['keeper-a.' + ROOT, 'keeper-b.' + ROOT],
  forbidden: ['market.' + ROOT, 'trader.' + ROOT, ROOT, 'musdc.' + ROOT, 'maker.' + ROOT,
    'oracle.' + ROOT, 'keeper-a.' + ROOT, 'keeper-b.' + ROOT],
  rolePublicKeys: [MARKET_DEPLOY_KEY, TRADER_ROLE_KEY],
};
export const CODE_HASH = 'MockCodeHash1111111111111111111111111111111';
export const FINGERPRINTS = { open: 'b3Blbg==', liquidation: 'bGlx', close: 'Y2xvc2U=' };

const SIGNER_IDS = { DEMO: IDS.root, MAKER: IDS.maker, ORACLE: IDS.oracle };
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

export class MockChain {
  accounts = new Map();
  markets = new Map();
  balances = new Map();
  registered = new Set();
  calls = [];
  inFlight = new Map();
  overlaps = [];
  height = 1_000;
  failNext = new Map();
  delayMs = 2;

  constructor() {
    this.accounts.set(IDS.root, { amount: (100n * NEAR).toString(), storage_usage: 1000, code_hash: NO_CODE, keys: [] });
    this.balances.set(IDS.root, 800_000);
    for (const id of [IDS.root, IDS.maker, IDS.keepers[1]]) this.registered.add(id);
  }

  // Throws once from the named operation, after optionally applying it.
  failOnce(operation, { afterEffect = false } = {}) {
    this.failNext.set(operation, { afterEffect });
  }

  async #signed(signer, operation, effect) {
    if (this.inFlight.get(signer)) this.overlaps.push(signer + ':' + operation);
    this.inFlight.set(signer, true);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const failure = this.failNext.get(operation);
      if (failure) {
        this.failNext.delete(operation);
        if (failure.afterEffect) effect();
        throw new Error('simulated RPC failure in ' + operation);
      }
      effect();
      this.height += 3;
      const hash = randomBytes(32).toString('hex').slice(0, 44);
      this.calls.push({ signer, operation, hash });
      return { hash };
    } finally {
      this.inFlight.set(signer, false);
    }
  }

  async view(accountId, method, args = {}) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (accountId === IDS.token) {
      if (method === 'ft_balance_of') return String(this.balances.get(args.account_id) ?? 0);
      if (method === 'storage_balance_of') return this.registered.has(args.account_id) ? { total: '1', available: '0' } : null;
      throw new Error('unknown token view ' + method);
    }
    const market = this.markets.get(accountId);
    if (!market) throw new Error('no contract at ' + accountId);
    if (method === 'get_config') return market.config;
    if (method === 'get_market') return market.hash;
    if (method === 'get_ledger') return { ...market.ledger, keeper_available: [...market.ledger.keeper_available] };
    if (method === 'get_oracle') return market.oracle;
    if (method === 'get_pending') return market.pending;
    if (method === 'get_active') return market.active;
    if (method === 'get_quote') return market.quote;
    throw new Error('unknown market view ' + method);
  }

  async accountState(id) {
    const account = this.accounts.get(id);
    return account ? { amount: account.amount, locked: '0', code_hash: account.code_hash, storage_usage: account.storage_usage } : null;
  }

  async accessKeys(id) {
    return this.accounts.get(id).keys.map((public_key) => ({ public_key, permission: 'FullAccess' }));
  }

  async finalHeight() {
    return this.height;
  }

  createMarketAccount(id, amount) {
    return this.#signed('DEMO', 'createMarketAccount', () => {
      if (this.accounts.has(id)) throw new Error('account exists');
      this.accounts.set(id, { amount: amount.toString(), storage_usage: 100, code_hash: NO_CODE, keys: [MARKET_DEPLOY_KEY] });
    });
  }

  createTraderAccount(id, amount, publicKey) {
    return this.#signed('DEMO', 'createTraderAccount', () => {
      if (this.accounts.has(id)) throw new Error('account exists');
      this.accounts.set(id, { amount: amount.toString(), storage_usage: 100, code_hash: NO_CODE, keys: [publicKey] });
    });
  }

  deployMarket(id, wasm, init) {
    return this.#signed('MARKET:' + id, 'deployMarket', () => {
      const account = this.accounts.get(id);
      account.code_hash = CODE_HASH;
      account.keys = [];
      this.markets.set(id, {
        hash: sha(Buffer.from(init.deployment_id, 'base64'), Buffer.from(id)).toString('base64'),
        config: {
          token_id: init.token_id, trader_id: init.trader_id, maker_id: init.maker_id, oracle_id: init.oracle_id,
          keepers: init.keepers, deployment_id: init.deployment_id, key_version: 1,
          open_vk_sha256: FINGERPRINTS.open, liquidation_vk_sha256: FINGERPRINTS.liquidation,
          close_vk_sha256: FINGERPRINTS.close,
        },
        ledger: {
          trader_available: 0, trader_locked: 0, maker_vault: 0, maker_reserved: 0,
          keeper_available: [0, 0], pending_withdrawals: 0, bad_debt: 0, halted: false, next_nonce: 1,
        },
        oracle: null, pending: null, active: null, quote: null,
      });
    });
  }

  call(signer, contractId, method, args, options = {}) {
    const from = SIGNER_IDS[signer];
    return this.#signed(signer, method, () => {
      if (contractId === IDS.token) return this.#token(from, method, args, options);
      const market = this.markets.get(contractId);
      if (!market) throw new Error('no contract at ' + contractId);
      if (method === 'publish_oracle') {
        if (from !== IDS.oracle) throw new Error('ERR_NOT_ORACLE');
        if (market.oracle && args.round <= market.oracle.round) throw new Error('ERR_ROUND_NOT_INCREASING');
        if (market.oracle && args.funding_cents < market.oracle.funding_cents) throw new Error('ERR_FUNDING_DECREASED');
        market.oracle = { round: args.round, price_ticks: args.price_ticks, funding_cents: args.funding_cents, height: this.height };
      } else if (method === 'approve_quote') {
        if (from !== IDS.maker) throw new Error('ERR_NOT_MAKER');
        const p = market.pending;
        if (!p || p.nonce !== args.nonce || p.commitment !== args.commitment || p.quote_terms !== args.quote_terms
          || p.open_price_ticks !== args.open_price_ticks) throw new Error('ERR_PENDING_MISMATCH');
        if (args.expires_at <= this.height) throw new Error('ERR_EXPIRY_NOT_FUTURE');
        market.quote = { nonce: p.nonce, commitment: p.commitment, quote_terms: p.quote_terms,
          open_price_ticks: p.open_price_ticks, expires_at: args.expires_at };
      } else {
        throw new Error('unexpected market call ' + method);
      }
    });
  }

  #token(from, method, args, options) {
    if (method === 'storage_deposit') {
      if (options.attachedDeposit !== 10n ** 22n) throw new Error('bad storage deposit');
      this.registered.add(args.account_id);
      return;
    }
    if (options.attachedDeposit !== 1n) throw new Error('requires one yocto');
    const amount = Number(args.amount);
    if (!this.registered.has(args.receiver_id)) throw new Error('receiver not registered');
    if ((this.balances.get(from) ?? 0) < amount) throw new Error('insufficient balance');
    this.balances.set(from, this.balances.get(from) - amount);
    if (method === 'ft_transfer') {
      this.balances.set(args.receiver_id, (this.balances.get(args.receiver_id) ?? 0) + amount);
    } else if (method === 'ft_transfer_call') {
      const market = this.markets.get(args.receiver_id);
      if (!market || args.msg !== 'maker' || from !== IDS.maker) throw new Error('unexpected deposit');
      this.balances.set(args.receiver_id, (this.balances.get(args.receiver_id) ?? 0) + amount);
      market.ledger.maker_vault += amount;
    } else {
      throw new Error('unexpected token call ' + method);
    }
  }

  // Simulates the browser staging a position directly with its own key.
  stage(marketId, { commitment, quote_terms }) {
    const market = this.markets.get(marketId);
    market.pending = {
      nonce: market.ledger.next_nonce, commitment, quote_terms,
      open_price_ticks: market.oracle.price_ticks, funding_checkpoint: market.oracle.funding_cents,
      ciphertexts: ['A'.repeat(192), 'B'.repeat(192)],
    };
    market.quote = null;
  }

  // Simulates the trader's open after approval.
  open(marketId) {
    const market = this.markets.get(marketId);
    market.active = market.pending;
    market.pending = null;
    market.quote = null;
    market.ledger.next_nonce += 1;
    market.ledger.maker_reserved = 60_100;
  }
}
