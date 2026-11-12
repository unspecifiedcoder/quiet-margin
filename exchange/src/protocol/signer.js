// The browser's own Ed25519 transaction signer. Preferred custody is a
// non-extractable WebCrypto key held in IndexedDB: script on this origin can
// ask it to sign, but the private key bytes can never be read back or sent.
// Browsers without WebCrypto Ed25519 fall back to a random secret kept in
// origin storage; that custody is reported explicitly as `origin-storage`.

import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes, subtle, toBase58, toBase64, utf8 } from './bytes.js';

const SIGNER_KEY = 'signer';
const SESSION_PROOF_PREFIX = 'xythum:exchange:session:v1:testnet:';

/** The exact UTF-8 string a browser key signs to enroll a session. */
export const sessionProofMessage = (publicKey) => SESSION_PROOF_PREFIX + publicKey;

/** Canonical padded Base64 Ed25519 session enrollment proof by `signer`. */
export async function sessionProof(signer) {
  const signature = await signer.sign(utf8(sessionProofMessage(signer.publicKey)));
  if (signature.length !== 64) throw new Error('browser signer produced a malformed signature');
  return toBase64(signature);
}

export async function webCryptoEd25519Available() {
  try {
    const pair = await subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const msg = new Uint8Array([1]);
    const sig = await subtle().sign('Ed25519', pair.privateKey, msg);
    return subtle().verify('Ed25519', pair.publicKey, sig, msg);
  } catch {
    return false;
  }
}

class Signer {
  constructor({ custody, publicKey, sign }) {
    this.custody = custody;
    /** 32-byte raw Ed25519 public key. */
    this.publicKeyBytes = publicKey;
    this.publicKey = 'ed25519:' + toBase58(publicKey);
    this.sign = sign;
  }
}

function webCryptoSigner(record) {
  return new Signer({
    custody: 'webcrypto-nonextractable',
    publicKey: record.publicKey,
    sign: async (message) => new Uint8Array(await subtle().sign('Ed25519', record.privateKey, message)),
  });
}

function originStorageSigner(record) {
  return new Signer({
    custody: 'origin-storage',
    publicKey: record.publicKey,
    sign: async (message) => ed25519.sign(message, record.secret),
  });
}

/**
 * Loads this browser's signer, creating it on first use. `allowFallback`
 * permits origin-storage custody when WebCrypto Ed25519 is missing.
 */
export async function loadSigner(store, { allowFallback = true } = {}) {
  const existing = await store.get(SIGNER_KEY);
  if (existing) return fromRecord(existing);
  let record;
  if (await webCryptoEd25519Available()) {
    const pair = await subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    if (pair.privateKey.extractable) throw new Error('browser produced an extractable signing key');
    record = {
      kind: 'webcrypto',
      privateKey: pair.privateKey,
      publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)),
    };
  } else if (allowFallback) {
    const secret = randomBytes(32);
    record = { kind: 'origin-storage', secret, publicKey: ed25519.getPublicKey(secret) };
  } else {
    throw new Error('this browser cannot hold a non-extractable Ed25519 key');
  }
  // Atomic create-if-absent: if another tab stored a key first, this tab's
  // fresh key is discarded and both use the one that was stored.
  return fromRecord(await store.putIfAbsent(SIGNER_KEY, record));
}

/** Loads this browser's signer only if one was already created; never creates one. */
export async function storedSigner(store) {
  const existing = await store.get(SIGNER_KEY);
  return existing ? fromRecord(existing) : null;
}

function fromRecord(record) {
  if (record.kind === 'webcrypto') return webCryptoSigner(record);
  if (record.kind === 'origin-storage') return originStorageSigner(record);
  throw new Error('unknown signer record');
}

/** Ed25519 verification used to check keeper acknowledgments. */
export function verifyEd25519(signature, message, publicKey) {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
