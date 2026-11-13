// Minimal bounded NEAR JSON-RPC client. Every state read uses `final`
// finality, and every transaction is followed to FINAL execution status.

import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes.js';

export const TESTNET_RPC = 'https://test.rpc.fastnear.com';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export class RpcError extends Error {
  constructor(message, { cause, kind, data } = {}) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    this.data = data;
    if (cause) this.cause = cause;
  }
}

/**
 * Accepts only the pinned public testnet RPC, or (when explicitly allowed)
 * a loopback NEAR Sandbox RPC on an explicit port.
 */
export function pinRpcUrl(chainId, rpcUrl, { allowSandbox = false } = {}) {
  if (chainId === 'testnet') {
    if (rpcUrl !== TESTNET_RPC && rpcUrl !== TESTNET_RPC + '/') {
      throw new Error('session RPC must be the pinned testnet RPC ' + TESTNET_RPC);
    }
    return TESTNET_RPC;
  }
  if (chainId === 'sandbox' && allowSandbox) {
    let url;
    try {
      url = new URL(rpcUrl);
    } catch {
      throw new Error('invalid sandbox RPC URL');
    }
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !loopback || !url.port || url.pathname !== '/' || url.search || url.username) {
      throw new Error('sandbox RPC must be http://127.0.0.1:<port>');
    }
    return url.origin;
  }
  throw new Error('unsupported chain_id ' + JSON.stringify(chainId) + '; only NEAR testnet is accepted');
}

export class Rpc {
  constructor(url, { fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.url = url;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.id = 0;
  }

  async call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    let response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'x' + (this.id += 1), method, params }),
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RpcError('RPC request failed: ' + (error?.message ?? error), { kind: 'NETWORK', cause: error });
    }
    const text = await boundedText(response, MAX_RESPONSE_BYTES);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError('RPC returned HTTP ' + response.status + ' without JSON', { kind: 'NETWORK' });
    }
    if (body.error) {
      const kind = body.error.cause?.name ?? body.error.name ?? 'RPC_ERROR';
      const detail = body.error.data ?? body.error.cause?.info ?? body.error.message;
      throw new RpcError(method + ': ' + kind + ' ' + JSON.stringify(detail), { kind, data: body.error });
    }
    if (!response.ok) throw new RpcError('RPC HTTP ' + response.status, { kind: 'NETWORK' });
    return body.result;
  }

  status() { return this.call('status', []); }

  finalBlock() { return this.call('block', { finality: 'final' }); }

  async view(accountId, method, args = {}) {
    const result = await this.call('query', {
      request_type: 'call_function', finality: 'final', account_id: accountId, method_name: method,
      args_base64: toBase64(utf8(JSON.stringify(args))),
    });
    return JSON.parse(fromUtf8(Uint8Array.from(result.result)));
  }

  viewAccessKey(accountId, publicKey) {
    return this.call('query', {
      request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey,
    });
  }

  /** Broadcasts a signed transaction with the requested execution threshold. */
  sendTx(signedTx, { waitUntil = 'NONE' } = {}) {
    return this.call('send_tx', { signed_tx_base64: signedTx, wait_until: waitUntil }, { timeoutMs: 30_000 });
  }

  /** One bounded wait for FINAL; throws TIMEOUT_ERROR / UNKNOWN_TRANSACTION. */
  txFinal(hash, senderId) {
    return this.call('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'FINAL' },
      { timeoutMs: 30_000 });
  }

  txStatus(hash, senderId) {
    return this.call('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'NONE' });
  }
}

async function boundedText(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > limit) throw new RpcError('RPC response too large', { kind: 'NETWORK' });
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > limit) throw new RpcError('RPC response too large', { kind: 'NETWORK' });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new RpcError('RPC response too large', { kind: 'NETWORK' });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * Interprets a FINAL outcome. Returns `{ ok, value, failure }`, where `ok`
 * requires both a successful top-level status and no failed receipt.
 */
export function interpretOutcome(outcome) {
  const failures = [];
  if (outcome.status?.Failure) failures.push(outcome.status.Failure);
  for (const r of outcome.receipts_outcome ?? []) {
    if (r.outcome?.status?.Failure) failures.push(r.outcome.status.Failure);
  }
  const success = outcome.status && 'SuccessValue' in outcome.status;
  let value;
  if (success && outcome.status.SuccessValue) {
    try {
      value = JSON.parse(fromUtf8(fromBase64(outcome.status.SuccessValue)));
    } catch {
      value = outcome.status.SuccessValue;
    }
  }
  return { ok: Boolean(success) && failures.length === 0, value, failures };
}

/** Extracts the contract panic message (e.g. ERR_ROUND_MISMATCH) if any. */
export function failureReason(failures) {
  const text = JSON.stringify(failures);
  const code = /ERR_[A-Z_]+/.exec(text);
  if (code) return code[0];
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}
