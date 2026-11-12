import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// Strips anything that could be key material or a bearer capability before a
// message reaches a log line, a durable record, or an HTTP response.
export function safeMessage(error, limit = 240) {
  const text = String(error?.message ?? error ?? 'error').split('\n').find((line) => line.trim()) ?? 'error';
  return text
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, 'ed25519:[redacted]')
    .replace(/secp256k1:[1-9A-HJ-NP-Za-km-z]+/g, 'secp256k1:[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .slice(0, limit);
}

// Runs tasks one at a time per key, in arrival order. Used to serialize every
// transaction signed by a shared role key so access-key nonces never collide.
export class KeyedSerializer {
  #tails = new Map();

  run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => {}, () => {});
    this.#tails.set(key, tail);
    tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  // Holds several keys in a fixed global order to avoid lock-order inversion.
  runAll(keys, task) {
    const ordered = [...new Set(keys)].sort();
    const nest = (index) => index === ordered.length
      ? task()
      : this.run(ordered[index], () => nest(index + 1));
    return nest(0);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
