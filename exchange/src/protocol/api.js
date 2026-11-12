// Client for the exchange server (`/api`, proxied to 127.0.0.1:8790 in dev).
// Request bodies are built from explicit allowlists: the server can only ever
// receive the browser public key, the session bearer, the maker-visible quote
// terms (nonce, commitment, quote blinder, size, entry), a mark price, and the
// keeper arm flag. Margin, the position blinder, and the full witness never
// leave the browser except inside the keeper envelopes posted to the chain.

import { fromBase58, fromBase64, toBase58, toBase64 } from './bytes.js';
import { spkiToRaw } from './envelope.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 60_000;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * True for a canonical NEAR Ed25519 public key: `ed25519:` followed by the
 * canonical Base58 of exactly 32 bytes (any length from 32 to 44 digits).
 */
export function isEd25519PublicKey(value) {
  if (typeof value !== 'string' || !value.startsWith('ed25519:')) return false;
  const text = value.slice('ed25519:'.length);
  let raw;
  try {
    raw = fromBase58(text);
  } catch {
    return false;
  }
  return raw.length === 32 && toBase58(raw) === text;
}

export function isAccountId(value) {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

export function parseReceipt(value, where) {
  if (!value || typeof value.label !== 'string' || value.label.length > 80 || typeof value.hash !== 'string') {
    throw new ApiError(where + ': malformed receipt');
  }
  let raw;
  try {
    raw = fromBase58(value.hash);
  } catch {
    raw = null;
  }
  if (!raw || raw.length !== 32) throw new ApiError(where + ': receipt hash is not a NEAR transaction hash');
  return { label: value.label, hash: value.hash };
}

export function parseSession(body) {
  const fail = (what) => {
    throw new ApiError('session response: ' + what);
  };
  if (!body || typeof body !== 'object') fail('not an object');
  if (typeof body.session_id !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,256}$/.test(body.session_id)) {
    fail('session_id');
  }
  for (const field of ['trader_id', 'market_id', 'token_id']) if (!isAccountId(body[field])) fail(field);
  if (new Set([body.trader_id, body.market_id, body.token_id]).size !== 3) fail('roles are not distinct');
  if (typeof body.chain_id !== 'string') fail('chain_id');
  if (typeof body.rpc_url !== 'string') fail('rpc_url');
  const keys = body.keeper_encryption_keys;
  if (!Array.isArray(keys) || keys.length !== 2) fail('keeper_encryption_keys must hold two keys');
  const raws = keys.map((k) => {
    try {
      return spkiToRaw(fromBase64(k));
    } catch (error) {
      return fail('keeper encryption key: ' + error.message);
    }
  });
  if (raws[0].every((b, i) => b === raws[1][i])) fail('keeper encryption keys are not distinct');
  if (typeof body.keeper_armed !== 'boolean') fail('keeper_armed');
  if (!Array.isArray(body.receipts) || body.receipts.length > 64) fail('receipts');
  return {
    session_id: body.session_id,
    trader_id: body.trader_id,
    market_id: body.market_id,
    token_id: body.token_id,
    chain_id: body.chain_id,
    rpc_url: body.rpc_url,
    keeper_encryption_keys: [...keys],
    keeper_armed: body.keeper_armed,
    receipts: body.receipts.map((r) => parseReceipt(r, 'session')),
  };
}

export class Api {
  constructor({ base = '/api', fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.base = base;
    this.fetch = fetchImpl;
    this.sessionId = null;
  }

  async request(method, path, body, { auth = true } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!this.sessionId) throw new ApiError('no session');
      headers.authorization = 'Bearer ' + this.sessionId;
    }
    let response;
    try {
      response = await this.fetch(this.base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiError('exchange server unreachable: ' + (error?.message ?? error), 0);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ApiError('exchange server response too large', response.status);
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message = typeof json?.error === 'string' ? json.error : (typeof json?.message === 'string' ? json.message : text.slice(0, 200));
      throw new ApiError(`exchange server ${method} ${path} failed (${response.status}): ${message}`, response.status);
    }
    if (json === null) throw new ApiError('exchange server returned no JSON', response.status);
    return json;
  }

  /**
   * Enrolls the browser key. `proof` is the canonical padded Base64 Ed25519
   * signature of `sessionProofMessage(publicKey)` by that same key, so the
   * server can bind the session to the key holder and replay it on retry.
   */
  async createSession(publicKey, proof) {
    if (!isEd25519PublicKey(publicKey)) throw new ApiError('bad public key');
    let raw;
    try {
      raw = fromBase64(proof, 64);
    } catch {
      raw = null;
    }
    if (!raw || toBase64(raw) !== proof) throw new ApiError('bad session proof');
    const session = parseSession(await this.request('POST', '/sessions', { public_key: publicKey, proof }, { auth: false }));
    this.sessionId = session.session_id;
    return session;
  }

  async getSession(sessionId) {
    this.sessionId = sessionId;
    const session = parseSession(await this.request('GET', '/session'));
    if (session.session_id !== sessionId) throw new ApiError('server returned a different session');
    return session;
  }

  async approve({ nonce, commitment, quote_blinder, size_lots, entry_ticks }) {
    fromBase64(commitment, 32);
    fromBase64(quote_blinder, 32);
    const body = await this.request('POST', '/session/approve', {
      nonce, commitment, quote_blinder, size_lots, entry_ticks,
    });
    const acks = body.acknowledgments;
    if (!Array.isArray(acks) || acks.length !== 2) throw new ApiError('approve: expected two acknowledgments');
    acks.forEach((a) => fromBase64(a, 64));
    return { acknowledgments: [...acks], receipt: parseReceipt(body.receipt, 'approve') };
  }

  async mark(priceTicks) {
    const body = await this.request('POST', '/session/mark', { price_ticks: priceTicks });
    const o = body.oracle;
    if (!o || !Number.isSafeInteger(o.round) || !Number.isSafeInteger(o.price_ticks)) {
      throw new ApiError('mark: malformed oracle');
    }
    return { oracle: o, receipt: parseReceipt(body.receipt, 'mark') };
  }

  async armKeeper() {
    const body = await this.request('POST', '/session/keeper', { armed: true });
    if (typeof body.keeper_armed !== 'boolean') throw new ApiError('keeper: malformed response');
    return { keeper_armed: body.keeper_armed, receipt: body.receipt ? parseReceipt(body.receipt, 'keeper') : null };
  }
}
