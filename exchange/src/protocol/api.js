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
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    /** The server's machine-readable `error` code, when it sent one. */
    if (typeof code === 'string') this.code = code;
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

function parseOracle(o, where) {
  if (!o || !Number.isSafeInteger(o.round) || !Number.isSafeInteger(o.price_ticks)) {
    throw new ApiError(where + ': malformed oracle');
  }
  return o;
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

// Hosted admission invite: the link carries `#invite=<64 lowercase hex>`.
// It is taken out of the address bar at once (the fragment never reaches a
// server, a Referer or the history entry) and kept in sessionStorage so a
// reload or retry can still enroll. It is sent only as X-Xythum-Invite on
// POST /api/sessions and is never logged. Without an invite (local mode)
// nothing changes.
export const INVITE_STORAGE_KEY = 'xythum:invite';
export const INVITE_HEADER = 'x-xythum-invite';
const INVITE = /^[0-9a-f]{64}$/;
let memoryInvite = null;

function defaultStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Moves a `#invite=` fragment parameter out of the URL into sessionStorage
 * (or memory if storage is unavailable) and returns the current invite, or
 * null. A malformed or duplicated invite is removed from the URL, is not
 * kept, and clears any previously stored invite.
 */
export function captureInvite({
  location = globalThis.location, history = globalThis.history, storage = defaultStorage(),
} = {}) {
  const hash = typeof location?.hash === 'string' ? location.hash.replace(/^#/, '') : '';
  const parts = hash ? hash.split('&') : [];
  const found = parts.filter((part) => part.startsWith('invite='));
  if (found.length > 0) {
    const rest = parts.filter((part) => !part.startsWith('invite=')).join('&');
    try {
      history?.replaceState?.(history.state ?? null, '',
        (location.pathname ?? '') + (location.search ?? '') + (rest ? '#' + rest : ''));
    } catch {
      // Without history access the fragment stays; enrollment still works.
    }
    // The newest link always wins: a malformed or duplicated invite clears
    // any earlier one, so enrollment fails visibly with invite_required
    // rather than silently using a stale invite. An existing session is
    // unaffected (it authenticates with its own bearer, not the invite).
    const value = found.length === 1 ? found[0].slice('invite='.length) : '';
    memoryInvite = INVITE.test(value) ? value : null;
    try {
      if (memoryInvite) storage?.setItem(INVITE_STORAGE_KEY, memoryInvite);
      else storage?.removeItem?.(INVITE_STORAGE_KEY);
    } catch {
      // Private mode or storage disabled: the in-memory value is used.
    }
    if (!memoryInvite) return null;
  }
  let stored = null;
  try {
    stored = storage?.getItem(INVITE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (typeof stored === 'string' && INVITE.test(stored)) return stored;
  return memoryInvite;
}

// Capture at startup, before any other code can read or report the URL.
if (typeof window !== 'undefined' && globalThis.location) captureInvite();

export class Api {
  #invite;

  constructor({
    base = '/api', fetchImpl = globalThis.fetch.bind(globalThis), invite = captureInvite(),
  } = {}) {
    this.base = base;
    this.fetch = fetchImpl;
    this.sessionId = null;
    // Private field: never serialized or enumerated with the client.
    this.#invite = typeof invite === 'string' && INVITE.test(invite) ? invite : null;
  }

  async request(method, path, body, { auth = true, invite = false } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (invite && this.#invite) headers[INVITE_HEADER] = this.#invite;
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
      const code = typeof json?.error === 'string' && /^[a-z_]{1,40}$/.test(json.error) ? json.error : undefined;
      throw new ApiError(`exchange server ${method} ${path} failed (${response.status}): ${message}`, response.status, code);
    }
    if (json === null) throw new ApiError('exchange server returned no JSON', response.status);
    return json;
  }

  /**
   * Enrolls the browser key. `proof` is the canonical padded Base64 Ed25519
   * signature of `sessionProofMessage(publicKey)` by that same key, so the
   * server can bind the session to the key holder and replay it on retry.
   *
   * With `{ recoverOnly: true }` the body also carries `restore_only: true`:
   * the server then only returns the existing ready session bound to this
   * key and proof, and refuses (404 none, 409 not ready or bound elsewhere)
   * rather than allocating a new trader account. Without it the body is
   * exactly `{public_key, proof}`, as before.
   */
  async createSession(publicKey, proof, options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ApiError('bad session options');
    }
    const { recoverOnly = false, ...rest } = options;
    if (typeof recoverOnly !== 'boolean' || Object.keys(rest).length !== 0) throw new ApiError('bad session options');
    if (!isEd25519PublicKey(publicKey)) throw new ApiError('bad public key');
    let raw;
    try {
      raw = fromBase64(proof, 64);
    } catch {
      raw = null;
    }
    if (!raw || toBase64(raw) !== proof) throw new ApiError('bad session proof');
    const body = recoverOnly ? { public_key: publicKey, proof, restore_only: true } : { public_key: publicKey, proof };
    const session = parseSession(await this.request('POST', '/sessions', body, { auth: false, invite: true }));
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

  /** User test mark: capped and rate limited by the server. */
  async mark(priceTicks) {
    const body = await this.request('POST', '/session/mark', { price_ticks: priceTicks });
    return { oracle: parseOracle(body.oracle, 'mark'), receipt: parseReceipt(body.receipt, 'mark') };
  }

  /**
   * Liveness refresh: the server republishes the current price and funding
   * under a new round only when the oracle is old. It does not consume the
   * user mark quota. The receipt is absent when no refresh was needed.
   */
  async refreshOracle() {
    const body = await this.request('POST', '/session/refresh', {});
    return {
      oracle: parseOracle(body.oracle, 'refresh'),
      receipt: body.receipt == null ? null : parseReceipt(body.receipt, 'refresh'),
    };
  }

  async armKeeper() {
    const body = await this.request('POST', '/session/keeper', { armed: true });
    if (typeof body.keeper_armed !== 'boolean') throw new ApiError('keeper: malformed response');
    return { keeper_armed: body.keeper_armed, receipt: body.receipt ? parseReceipt(body.receipt, 'keeper') : null };
  }
}
