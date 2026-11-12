// Native NEAR testnet burner wallet: authorization and recovery of the
// private trading wallet.
//
// The burner is a real, independent, randomly generated 32-byte Ed25519
// keypair whose NEAR account is the implicit account named by the hex public
// key. All signing is local; nothing here contacts a wallet, a server or the
// chain.
//
// Unlocking signs one NEP-413 message (Borsh payload, tag 2^31 + 413,
// SHA-256 digest) scoped to the canonical app origin, testnet, the owner
// account and a version. Its nonce is deterministic and domain separated so
// the same burner re-derives the same signature. That signature is used
// ONLY as local key material: HKDF-SHA-256 (domain separated) turns it into
// the seed of an independent Ed25519 trading key. It is never sent anywhere
// and must never be used as an authentication challenge (it is replayable
// by design). The trading key is imported as a non-extractable WebCrypto
// key and kept in a per-origin, per-burner IndexedDB database that never
// touches the legacy `xythum-exchange` database.
//
// Origin binding: the trading key depends on the origin, so the same burner
// at another origin would be a different trader. A wallet is therefore bound
// to exactly one canonical origin: an imported wallet to the origin in its
// backup, a created wallet to the first origin it is exported, signed or
// unlocked at. Using it at any other origin fails closed before anything is
// signed, stored or sent, and a backup (format version 1, `version` and
// `origin` fields) is only importable at the origin that exported it.
//
// Recovery: importing the same backup on any browser at the same origin
// re-derives the same trading key, whose deterministic enrollment proof gets
// the original exchange session (same trader account and funds) back
// without consuming new session capacity. A hosted server still requires a
// valid invite on POST /api/sessions, so recovery there may need the
// original invite link. The sealed secret opening of an active position is
// held only by the browser that opened it and is not recovered.
//
// The backup file holds the burner private key: it is the owner credential
// for the account and the trading wallet. Keep it private and offline, and
// import it only on the app origin it names.

import { ed25519 } from '@noble/curves/ed25519.js';
import { concat, equalBytes, fromBase58, fromUtf8, le32, sha256, subtle, toBase58, toHex, utf8 } from './bytes.js';
import { indexedDbBackend, Store } from './store.js';
import { verifyEd25519, webCryptoEd25519Available } from './signer.js';

export const BURNER_VERSION = 1;
export const BURNER_NETWORK = 'testnet';
/** Backup file format version. */
export const BURNER_BACKUP_VERSION = 1;
/** NEP-413 payload tag: 2^31 + 413. */
export const NEP413_TAG = 2 ** 31 + 413;
/** Upper bound on an imported backup file, in UTF-16 code units. */
export const MAX_BACKUP_LENGTH = 1024;

const NONCE_DOMAIN = 'xythum:exchange:burner:nep413-nonce:v1';
const HKDF_SALT = 'xythum:exchange:burner:trader-seed:salt:v1';
const HKDF_INFO = 'xythum:exchange:burner:trader-seed:v1';
const STORE_DOMAIN = 'xythum:exchange:burner:store:v1';
const STORE_PREFIX = 'xythum-exchange-burner-v1-';
const SIGNER_KEY = 'signer';
const BINDING_KEY = 'burner-binding';
const PROBE = utf8('xythum:exchange:burner:custody-probe:v1');
const MAX_ORIGIN_LENGTH = 256;
const BACKUP_KEYS = ['account_id', 'network', 'origin', 'private_key', 'public_key', 'version'];
const ORIGIN_MISMATCH = 'this burner wallet belongs to a different app origin; use it only on the app origin that exported its backup';
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

// Burner seeds live only here, keyed by the wallet object, so no property of
// a wallet ever exposes them.
const seeds = new WeakMap();
// The one canonical origin each wallet is bound to, once bound.
const origins = new WeakMap();

const nearKey = (raw) => 'ed25519:' + toBase58(raw);
const wipe = (...buffers) => buffers.forEach((b) => b?.fill(0));

// Length-prefixed fields, so no field boundary can be shifted into another.
const fields = (...parts) => concat(...parts.map((p) => {
  const bytes = typeof p === 'string' ? utf8(p) : p;
  return concat(le32(bytes.length), bytes);
}));

function makeWallet(seed, origin) {
  const publicKeyBytes = ed25519.getPublicKey(seed);
  const accountId = toHex(publicKeyBytes);
  const publicKey = nearKey(publicKeyBytes);
  const wallet = Object.freeze({
    accountId,
    publicKey,
    network: BURNER_NETWORK,
    /**
     * The backup file text, bound to `origin` (this page's origin by
     * default). It contains the private key: keep it private.
     */
    exportBackup(origin = globalThis.location?.origin) {
      const boundOrigin = bindOrigin(wallet, origin);
      const full = concat(seedOf(wallet), publicKeyBytes);
      const privateKey = 'ed25519:' + toBase58(full);
      wipe(full);
      return JSON.stringify({
        version: BURNER_BACKUP_VERSION, network: BURNER_NETWORK, origin: boundOrigin,
        account_id: accountId, public_key: publicKey, private_key: privateKey,
      }, null, 2) + '\n';
    },
  });
  seeds.set(wallet, seed);
  if (origin !== undefined) origins.set(wallet, origin);
  return wallet;
}

// Binds `wallet` to canonical `origin` on first use; afterwards only that
// exact origin is accepted. Throws before any signing, storage or request.
function bindOrigin(wallet, origin) {
  seedOf(wallet);
  canonicalOrigin(origin);
  const bound = origins.get(wallet);
  if (bound === undefined) origins.set(wallet, origin);
  else if (bound !== origin) throw new Error(ORIGIN_MISMATCH);
  return origin;
}

function seedOf(wallet) {
  const seed = seeds.get(wallet);
  if (!seed) throw new TypeError('expected a burner wallet from createBurnerWallet or importBurnerWallet');
  return seed;
}

/** Creates a fresh, independent random testnet burner wallet. */
export function createBurnerWallet() {
  return makeWallet(ed25519.utils.randomSecretKey());
}

/**
 * Imports a backup file produced by `exportBackup()` at `origin` (this
 * page's origin by default). Validation is strict: exact keys, version 1,
 * testnet only, canonical encodings, the backup's origin must be exactly
 * `origin`, and the private key must match both the public key and the
 * implicit account ID. The returned wallet is bound to that origin.
 */
export function importBurnerWallet(text, origin = globalThis.location?.origin) {
  const bad = (why) => new Error('invalid burner wallet backup: ' + why);
  canonicalOrigin(origin);
  if (typeof text !== 'string') throw bad('expected the backup file text');
  if (text.length > MAX_BACKUP_LENGTH) throw bad('file is too large');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('expected a JSON object');
  const keys = Object.keys(body).sort();
  if (keys.length !== BACKUP_KEYS.length || keys.some((k, i) => k !== BACKUP_KEYS[i])) {
    throw bad('expected exactly ' + BACKUP_KEYS.join(', '));
  }
  if (body.version !== BURNER_BACKUP_VERSION) throw bad('unsupported version');
  if (keys.some((k) => k !== 'version' && typeof body[k] !== 'string')) throw bad('every field but version must be a string');
  if (body.network !== BURNER_NETWORK) throw bad('only testnet burner wallets are supported');
  if (!isCanonicalOrigin(body.origin)) throw bad('origin is not a canonical app origin');
  // Before the private key is decoded at all.
  if (body.origin !== origin) throw new Error(ORIGIN_MISMATCH);
  const encoded = body.private_key;
  if (!encoded.startsWith('ed25519:') || encoded.length > 8 + 90) throw bad('private_key must be ed25519:<base58>');
  let full;
  try {
    full = fromBase58(encoded.slice(8));
  } catch {
    throw bad('private_key is not Base58');
  }
  try {
    if (full.length !== 64 || 'ed25519:' + toBase58(full) !== encoded) throw bad('private_key must be 64 canonical bytes');
    const seed = full.slice(0, 32);
    const publicKeyBytes = ed25519.getPublicKey(seed);
    if (!equalBytes(publicKeyBytes, full.subarray(32))) {
      wipe(seed);
      throw bad('private_key does not contain its own public key');
    }
    if (body.public_key !== nearKey(publicKeyBytes)) {
      wipe(seed);
      throw bad('public_key does not match private_key');
    }
    if (body.account_id !== toHex(publicKeyBytes)) {
      wipe(seed);
      throw bad('account_id is not the implicit account of this key');
    }
    return makeWallet(seed, origin);
  } finally {
    wipe(full);
  }
}

/**
 * The canonical app origin: an exact `URL.origin`, https except loopback
 * http for local development. In a browser it must be this page's origin.
 */
export function canonicalOrigin(origin) {
  if (!isCanonicalOrigin(origin)) {
    throw new Error('the app origin must be a canonical https origin (or http on localhost)');
  }
  const here = globalThis.location?.origin;
  if (typeof here === 'string' && here !== origin) throw new Error('the app origin must be this page\'s origin');
  return origin;
}

// Syntax only: an exact `URL.origin`, https or loopback http.
function isCanonicalOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || origin === 'null') return false;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
}

/**
 * The full NEP-413 authorization for `accountId` at `origin`, including the
 * deterministic nonce. The nonce is public; it is never a challenge.
 */
export async function burnerAuthorization(accountId, origin) {
  canonicalOrigin(origin);
  if (typeof accountId !== 'string' || !/^[0-9a-f]{64}$/.test(accountId)) {
    throw new TypeError('expected a 64-hex implicit testnet account ID');
  }
  const message = [
    `Xythum testnet trading wallet unlock v${BURNER_VERSION}`,
    `App: ${origin}`,
    `Network: ${BURNER_NETWORK}`,
    `Owner: ${accountId}`,
    'Signing derives this app\'s private trading key on this device.',
    'It is not a transaction and is never sent anywhere. Sign only on the app shown above.',
  ].join('\n');
  const nonce = await sha256(fields(NONCE_DOMAIN, origin, BURNER_NETWORK, accountId, le32(BURNER_VERSION)));
  return { message, recipient: origin, nonce };
}

/** Borsh NEP-413 payload: u32 tag, message, [u8; 32] nonce, recipient, None callback. */
export function nep413Payload({ message, nonce, recipient }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new TypeError('NEP-413 nonce must be 32 bytes');
  return concat(le32(NEP413_TAG), fields(message), nonce, fields(recipient), Uint8Array.of(0));
}

/**
 * What the UI shows before the user signs: exactly the message and
 * recipient that `unlockBurnerStore` signs.
 */
export async function burnerSignRequest(wallet, origin) {
  bindOrigin(wallet, origin);
  const { message, recipient } = await burnerAuthorization(wallet.accountId, origin);
  return { message, recipient };
}

/** The per-origin, per-burner IndexedDB database name. */
export async function burnerStoreName(accountId, origin) {
  return STORE_PREFIX + toHex(await sha256(fields(STORE_DOMAIN, origin, BURNER_NETWORK, accountId))).slice(0, 32);
}

async function deriveTraderSeed(wallet, origin) {
  const auth = await burnerAuthorization(wallet.accountId, origin);
  const digest = await sha256(nep413Payload(auth));
  const signature = ed25519.sign(digest, seedOf(wallet));
  try {
    if (!verifyEd25519(signature, digest, ed25519.getPublicKey(seedOf(wallet)))) {
      throw new Error('burner signature failed verification');
    }
    const ikm = await subtle().importKey('raw', signature, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle().deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: utf8(HKDF_SALT),
      info: fields(HKDF_INFO, origin, BURNER_NETWORK, wallet.accountId),
    }, ikm, 256));
  } finally {
    wipe(signature);
  }
}

async function importTraderKey(seed) {
  const pkcs8 = concat(PKCS8_ED25519_PREFIX, seed);
  try {
    const key = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    if (key.extractable || key.type !== 'private') throw new Error('browser produced an extractable trading key');
    return key;
  } finally {
    wipe(pkcs8);
  }
}

async function assertControls(privateKey, publicKey) {
  const signature = new Uint8Array(await subtle().sign('Ed25519', privateKey, PROBE));
  if (!verifyEd25519(signature, PROBE, publicKey)) {
    throw new Error('stored trading key does not match this burner wallet');
  }
}

/**
 * The user's explicit "sign" action: signs `burnerSignRequest(wallet,
 * origin)` locally, derives the trading key and stores it non-extractably in
 * this burner's own database. Pass the result's `store` to
 * `createExchange({ store })`. Fails closed (use legacy Start session) when
 * the browser cannot hold a non-extractable Ed25519 key in IndexedDB.
 */
export async function unlockBurnerStore(wallet, origin, { backend } = {}) {
  bindOrigin(wallet, origin);
  if (!(await webCryptoEd25519Available())) {
    throw new Error('this browser cannot hold a non-extractable Ed25519 trading key; use Start session instead');
  }
  const seed = await deriveTraderSeed(wallet, origin);
  let publicKeyBytes;
  let privateKey;
  try {
    publicKeyBytes = ed25519.getPublicKey(seed);
    privateKey = await importTraderKey(seed);
  } finally {
    wipe(seed);
  }
  const traderPublicKey = nearKey(publicKeyBytes);
  const store = new Store(backend ?? indexedDbBackend(await burnerStoreName(wallet.accountId, origin)));

  const binding = {
    version: BURNER_VERSION, network: BURNER_NETWORK, origin,
    owner_account_id: wallet.accountId, trader_public_key: traderPublicKey,
  };
  const boundTo = await store.putIfAbsent(BINDING_KEY, binding);
  if (!boundTo || Object.keys(binding).some((k) => boundTo[k] !== binding[k])
    || Object.keys(boundTo).length !== Object.keys(binding).length) {
    throw new Error('this wallet storage belongs to a different burner wallet or app origin');
  }

  // Atomic create-if-absent; a stored key must be this exact trading key.
  await store.putIfAbsent(SIGNER_KEY, { kind: 'webcrypto', privateKey, publicKey: publicKeyBytes });
  // putIfAbsent may hand back the in-memory original on first insert, so
  // validate what a later load will actually read from storage.
  const record = await store.get(SIGNER_KEY);
  if (record?.kind !== 'webcrypto' || !(record.publicKey instanceof Uint8Array)
    || !equalBytes(record.publicKey, publicKeyBytes)) {
    throw new Error('this wallet storage holds a different trading key');
  }
  if (!(record.privateKey instanceof CryptoKey) || record.privateKey.extractable !== false) {
    throw new Error('this browser could not store a non-extractable trading key; use Start session instead');
  }
  // Proves the key that came back from storage (a structured clone) still
  // signs for the derived public key; a browser that cannot persist a
  // CryptoKey fails here instead of trading with an unrecoverable key.
  await assertControls(record.privateKey, publicKeyBytes);
  return { store, ownerAccountId: wallet.accountId, traderPublicKey };
}
