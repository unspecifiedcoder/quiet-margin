// Byte helpers shared by the browser protocol. Everything here is pure and
// runs identically in browsers and in Node (tests), using only WebCrypto.

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is unavailable; use a secure (https or localhost) origin');
  return s;
};

export const utf8 = (text) => new TextEncoder().encode(text);
export const fromUtf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function le16(value) {
  assertInt(value, 0, 0xffff, 'u16');
  return new Uint8Array([value & 0xff, value >>> 8]);
}

export function le32(value) {
  assertInt(value, 0, 0xffff_ffff, 'u32');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function assertInt(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..=${max}`);
  }
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function sha256(...parts) {
  return new Uint8Array(await subtle().digest('SHA-256', concat(...parts)));
}

/** Standard padded Base64 (the contract and the prover CLI use this form). */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function fromBase64(text, length) {
  if (typeof text !== 'string' || !BASE64.test(text)) {
    throw new TypeError('expected standard padded Base64');
  }
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  if (length !== undefined && out.length !== length) {
    throw new RangeError(`expected ${length} bytes, got ${out.length}`);
  }
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function fromBase58(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('expected Base58');
  let n = 0n;
  for (const ch of text) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new TypeError('invalid Base58 character');
    n = n * 58n + BigInt(v);
  }
  const body = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (text[zeros] === '1') zeros += 1;
  return new Uint8Array([...new Array(zeros).fill(0), ...body]);
}

export { subtle };
