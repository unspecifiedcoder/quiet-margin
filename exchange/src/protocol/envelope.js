// Keeper witness envelope, byte-identical to `encrypt`/`decrypt` in
// tests/actor.mjs:
//
//   ephemeral_spki[44] || iv[12] || tag[16] || aes256gcm(witness[72])
//
// with an ephemeral X25519 key against the keeper SPKI key,
// key = HKDF-SHA256(ikm = shared, salt = commitment, info = label, 32) and
// AAD = commitment. The total length is the contract's 144 bytes.

import { x25519 } from '@noble/curves/ed25519.js';
import { concat, equalBytes, fromBase64, randomBytes, subtle, toBase64, utf8 } from './bytes.js';
import { CIPHERTEXT_LEN, decodeWitness, encodeWitness } from './model.js';

export const ENVELOPE_INFO = utf8('xythum:keeper-envelope:v1');
/** DER prefix of an X25519 SubjectPublicKeyInfo (RFC 8410). */
export const X25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

export function spkiToRaw(spki) {
  if (spki.length !== 44 || !equalBytes(spki.subarray(0, 12), X25519_SPKI_PREFIX)) {
    throw new TypeError('keeper encryption key must be a 44-byte X25519 SPKI');
  }
  const raw = spki.slice(12);
  if (raw.every((b) => b === 0)) throw new TypeError('keeper encryption key is degenerate');
  return raw;
}

export const rawToSpki = (raw) => concat(X25519_SPKI_PREFIX, raw);

async function aeadKey(shared, commitmentBytes, usage) {
  if (shared.every((b) => b === 0)) throw new Error('X25519 produced a small-order shared secret');
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: commitmentBytes, info: ENVELOPE_INFO },
    ikm, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

/** Encrypts the witness for one keeper. `recipient` is Base64 SPKI. */
export async function encryptWitness(witness, recipient, commitmentB64) {
  const commitmentBytes = fromBase64(commitmentB64, 32);
  const recipientRaw = spkiToRaw(fromBase64(recipient));
  const ephemeral = x25519.utils.randomSecretKey();
  try {
    const shared = x25519.getSharedSecret(ephemeral, recipientRaw);
    const key = await aeadKey(shared, commitmentBytes, 'encrypt');
    const iv = randomBytes(12);
    const sealed = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: commitmentBytes, tagLength: 128 },
      key, encodeWitness(witness),
    ));
    // WebCrypto returns body || tag; the actor layout is tag || body.
    const body = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const out = concat(rawToSpki(x25519.getPublicKey(ephemeral)), iv, tag, body);
    if (out.length !== CIPHERTEXT_LEN) throw new Error('envelope length mismatch');
    return toBase64(out);
  } finally {
    ephemeral.fill(0);
  }
}

/** Inverse of `encryptWitness`, given the keeper's raw X25519 secret. Test use. */
export async function decryptWitness(ciphertextB64, secretRaw, commitmentB64) {
  const input = fromBase64(ciphertextB64);
  if (input.length !== CIPHERTEXT_LEN) throw new Error('undecryptable keeper payload');
  const commitmentBytes = fromBase64(commitmentB64, 32);
  try {
    const shared = x25519.getSharedSecret(secretRaw, spkiToRaw(input.subarray(0, 44)));
    const key = await aeadKey(shared, commitmentBytes, 'decrypt');
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: input.subarray(44, 56), additionalData: commitmentBytes, tagLength: 128 },
      key, concat(input.subarray(72), input.subarray(56, 72)),
    );
    return decodeWitness(new Uint8Array(plain));
  } catch {
    throw new Error('undecryptable keeper payload');
  }
}
