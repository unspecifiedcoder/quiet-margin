// Burner-wallet authorization and recovery, offline with in-memory stores.
// The NEP-413 encoding and the trading-key derivation are recomputed here
// from their written specification and cross-checked with @near-js.
import assert from 'node:assert/strict';
import { createHash, hkdfSync } from 'node:crypto';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import {
  burnerAuthorization, burnerSignRequest, burnerStoreName, canonicalOrigin, createBurnerWallet,
  importBurnerWallet, MAX_BACKUP_LENGTH, nep413Payload, unlockBurnerStore,
} from '../burner-wallet.js';
import { fromBase58, toBase58, toHex } from '../bytes.js';
import { loadSigner, sessionProof } from '../signer.js';
import { memoryBackend, Store } from '../store.js';
import * as protocol from '../index.js';

const ORIGIN = 'https://exchange.example';
const FIXED_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const backupFor = (origin, seed = FIXED_SEED) => {
  const pub = ed25519.getPublicKey(seed);
  return JSON.stringify({
    version: 1, network: 'testnet', origin,
    account_id: toHex(pub),
    private_key: 'ed25519:' + toBase58(Uint8Array.from([...seed, ...pub])),
    public_key: 'ed25519:' + toBase58(pub),
  });
};
const fixedBackup = backupFor(ORIGIN);
const fixedAt = (origin) => importBurnerWallet(backupFor(origin), origin);
const fixed = () => fixedAt(ORIGIN);
const unlock = (wallet, origin = ORIGIN, backend = memoryBackend()) => unlockBurnerStore(wallet, origin, { backend });

// Independent restatement of the documented encodings.
const lp = (s) => {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
};
const u32 = (v) => {
  const n = Buffer.alloc(4);
  n.writeUInt32LE(v);
  return n;
};
const sha = (b) => createHash('sha256').update(b).digest();

function expectedTraderPublicKey(backupText, origin) {
  const backup = JSON.parse(backupText);
  const seed = fromBase58(backup.private_key.slice(8)).slice(0, 32);
  const message = [
    'Xythum testnet trading wallet unlock v1',
    `App: ${origin}`,
    'Network: testnet',
    `Owner: ${backup.account_id}`,
    'Signing derives this app\'s private trading key on this device.',
    'It is not a transaction and is never sent anywhere. Sign only on the app shown above.',
  ].join('\n');
  const nonce = sha(Buffer.concat([lp('xythum:exchange:burner:nep413-nonce:v1'), lp(origin), lp('testnet'),
    lp(backup.account_id), lp(u32(1))]));
  const payload = Buffer.concat([u32(2147484061), lp(message), nonce, lp(origin), Buffer.from([0])]);
  const signature = ed25519.sign(sha(payload), seed);
  const traderSeed = new Uint8Array(hkdfSync('sha256', signature, Buffer.from('xythum:exchange:burner:trader-seed:salt:v1'),
    Buffer.concat([lp('xythum:exchange:burner:trader-seed:v1'), lp(origin), lp('testnet'), lp(backup.account_id)]), 32));
  return { message, nonce, payload, signature, traderPublicKey: 'ed25519:' + toBase58(ed25519.getPublicKey(traderSeed)) };
}

test('a created burner is an independent implicit testnet account with no readable secret', () => {
  const a = createBurnerWallet();
  const b = createBurnerWallet();
  assert.notEqual(a.accountId, b.accountId);
  assert.match(a.accountId, /^[0-9a-f]{64}$/);
  assert.equal(a.publicKey, 'ed25519:' + toBase58(Uint8Array.from(Buffer.from(a.accountId, 'hex'))));
  assert.ok(Object.isFrozen(a));
  assert.deepEqual(Object.keys(a).sort(), ['accountId', 'exportBackup', 'network', 'publicKey']);
  const privateKey = JSON.parse(a.exportBackup(ORIGIN)).private_key;
  assert.ok(!JSON.stringify(a).includes(privateKey.slice(8)));
  assert.ok(!Object.getOwnPropertyNames(a).some((k) => /seed|secret|private|signature/i.test(k)));
});

test('a backup round-trips, names its version and origin, and is a standard NEAR ed25519 credential', async () => {
  const wallet = createBurnerWallet();
  const text = wallet.exportBackup(ORIGIN);
  const backup = JSON.parse(text);
  assert.deepEqual(Object.keys(backup).sort(),
    ['account_id', 'network', 'origin', 'private_key', 'public_key', 'version']);
  assert.equal(backup.version, 1);
  assert.equal(backup.origin, ORIGIN);
  const again = importBurnerWallet(text, ORIGIN);
  assert.equal(again.accountId, wallet.accountId);
  assert.equal(again.exportBackup(ORIGIN), text);
  assert.equal(wallet.exportBackup(ORIGIN), text);
  assert.equal(KeyPair.fromString(backup.private_key).getPublicKey().toString(), wallet.publicKey);
  assert.equal((await unlock(again)).traderPublicKey, (await unlock(wallet)).traderPublicKey);
  // Node has no page origin, so the defaults fail closed.
  assert.throws(() => createBurnerWallet().exportBackup(), /origin/);
  assert.throws(() => importBurnerWallet(text), /origin/);
});

test('backup validation is strict', () => {
  const good = JSON.parse(fixedBackup);
  const other = JSON.parse(createBurnerWallet().exportBackup(ORIGIN));
  const full = fromBase58(good.private_key.slice(8));
  const variant = (patch) => JSON.stringify({ ...good, ...patch });
  const without = (key) => JSON.stringify(Object.fromEntries(Object.entries(good).filter(([k]) => k !== key)));
  const bad = [
    undefined, 42, '', 'null', '[]', '"x"', '{', ' '.repeat(MAX_BACKUP_LENGTH + 1),
    JSON.stringify({ ...good, extra: '1' }),
    JSON.stringify({ account_id: good.account_id, network: 'testnet', private_key: good.private_key, public_key: good.public_key }),
    without('version'),
    without('origin'),
    fixedBackup.replace('{', '{"__proto__":"x",'),
    variant({ version: 2 }),
    variant({ version: 0 }),
    variant({ version: '1' }),
    variant({ version: 1.5 }),
    variant({ origin: 1 }),
    variant({ origin: '' }),
    variant({ origin: ORIGIN + '/' }),
    variant({ origin: ORIGIN + '/trade' }),
    variant({ origin: 'HTTPS://exchange.example' }),
    variant({ origin: 'https://exchange.example:443' }),
    variant({ origin: 'http://exchange.example' }),
    variant({ origin: 'null' }),
    variant({ network: 'mainnet' }),
    variant({ network: 1 }),
    variant({ account_id: other.account_id }),
    variant({ account_id: good.account_id.toUpperCase() }),
    variant({ public_key: other.public_key }),
    variant({ private_key: other.private_key }),
    variant({ private_key: good.private_key.slice(8) }),
    variant({ private_key: 'ed25519:1' + good.private_key.slice(8) }),
    variant({ private_key: 'ed25519:' + toBase58(full.slice(0, 32)) }),
    variant({ private_key: 'ed25519:' + toBase58(Uint8Array.from([...full.slice(0, 32), ...fromBase58(other.public_key.slice(8))])) }),
    variant({ private_key: 'ed25519:0OIl' }),
  ];
  for (const text of bad) {
    assert.throws(() => importBurnerWallet(text, ORIGIN), /invalid burner wallet backup/, String(text).slice(0, 80));
  }
  assert.equal(importBurnerWallet(fixedBackup, ORIGIN).accountId, good.account_id);
  // The import origin itself must be canonical.
  for (const origin of [undefined, '', ORIGIN + '/', ORIGIN + '/trade', 'https://Exchange.example']) {
    assert.throws(() => importBurnerWallet(fixedBackup, origin), /canonical/, String(origin));
  }
});

test('a backup and its wallet are bound to one exact origin, failing closed elsewhere', async () => {
  const secret = JSON.parse(fixedBackup).private_key.slice(8);
  const redacted = () => (err) => {
    assert.match(err.message, /different app origin/);
    assert.ok(!err.message.includes(secret) && !String(err.stack).includes(secret));
    return true;
  };
  for (const elsewhere of ['https://other.example', 'https://exchange.example:8443', 'http://localhost:5173',
    'https://app.exchange.example']) {
    assert.throws(() => importBurnerWallet(fixedBackup, elsewhere), redacted(), elsewhere);
  }

  // An imported wallet is usable only at its backup's origin: nothing is
  // signed, stored or requested at any other one.
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('no request expected');
  };
  try {
    const wallet = fixed();
    const backend = memoryBackend();
    await assert.rejects(unlock(wallet, 'https://other.example', backend), redacted());
    await assert.rejects(burnerSignRequest(wallet, 'https://other.example'), redacted());
    assert.throws(() => wallet.exportBackup('https://other.example'), redacted());
    assert.deepEqual(await backend.keys(''), []);
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(wallet.exportBackup(ORIGIN)), JSON.parse(fixedBackup));

    // A created wallet binds to the first origin it is used at.
    const created = createBurnerWallet();
    await unlock(created);
    assert.throws(() => created.exportBackup('https://other.example'), redacted());
    const exported = createBurnerWallet();
    const text = exported.exportBackup(ORIGIN);
    await assert.rejects(unlock(exported, 'http://localhost:5173', backend), redacted());
    assert.throws(() => importBurnerWallet(text, 'http://localhost:5173'), redacted());
    assert.deepEqual(await backend.keys(''), []);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = fetch;
  }

  // Routes share an origin: one wallet, one trading key, one store, whatever
  // path the app is served under. Different origins stay isolated.
  const a = await unlock(fixed());
  const b = await unlock(importBurnerWallet(fixedBackup, new URL(ORIGIN + '/trade/btc?x=1#y').origin));
  assert.equal(a.traderPublicKey, b.traderPublicKey);
  assert.notEqual((await unlock(fixedAt('https://other.example'), 'https://other.example')).traderPublicKey,
    a.traderPublicKey);
});

test('the sign request is exact NEP-413, matching @near-js and the documented derivation', async () => {
  const wallet = fixed();
  const request = await burnerSignRequest(wallet, ORIGIN);
  assert.deepEqual(Object.keys(request).sort(), ['message', 'recipient']);
  const expected = expectedTraderPublicKey(fixedBackup, ORIGIN);
  assert.equal(request.message, expected.message);
  assert.equal(request.recipient, ORIGIN);
  const auth = await burnerAuthorization(wallet.accountId, ORIGIN);
  assert.deepEqual(Buffer.from(auth.nonce), expected.nonce);
  assert.deepEqual(Buffer.from(nep413Payload(auth)), expected.payload);

  const signer = new KeyPairSigner(KeyPair.fromString(JSON.parse(fixedBackup).private_key));
  const near = await signer.signNep413Message(request.message, wallet.accountId, request.recipient, auth.nonce);
  assert.deepEqual(Buffer.from(near.signature), Buffer.from(expected.signature));

  assert.equal((await unlock(wallet)).traderPublicKey, expected.traderPublicKey);
});

test('recovery is deterministic across fresh stores and keeps the enrollment proof', async () => {
  const one = await unlock(fixed());
  const two = await unlock(importBurnerWallet(fixedBackup, ORIGIN));
  assert.equal(one.traderPublicKey, two.traderPublicKey);
  assert.equal(one.ownerAccountId, JSON.parse(fixedBackup).account_id);
  const a = await loadSigner(one.store, { allowFallback: false });
  const b = await loadSigner(two.store, { allowFallback: false });
  assert.equal(a.publicKey, one.traderPublicKey);
  assert.equal(a.custody, 'webcrypto-nonextractable');
  // Identical proof => identical server bearer => the original session.
  assert.equal(await sessionProof(a), await sessionProof(b));
  // A legacy browser key in a fresh store is unrelated.
  assert.notEqual((await loadSigner(new Store(memoryBackend()))).publicKey, one.traderPublicKey);
});

test('different burners and origins derive separate trading wallets and stores', async () => {
  const wallet = fixed();
  const other = createBurnerWallet();
  const base = await unlock(wallet);
  const at = async (origin) => (await unlock(fixedAt(origin), origin)).traderPublicKey;
  const keys = new Set([
    wallet.publicKey, base.traderPublicKey,
    (await unlock(other)).traderPublicKey,
    await at('https://other.example'),
    await at('https://exchange.example:8443'),
    await at('http://localhost:5173'),
  ]);
  assert.equal(keys.size, 6);
  assert.notEqual((await burnerSignRequest(fixedAt('https://other.example'), 'https://other.example')).message,
    (await burnerSignRequest(wallet, ORIGIN)).message);
  const names = new Set([
    await burnerStoreName(wallet.accountId, ORIGIN),
    await burnerStoreName(other.accountId, ORIGIN),
    await burnerStoreName(wallet.accountId, 'https://other.example'),
    'xythum-exchange',
  ]);
  assert.equal(names.size, 4);
  for (const name of names) if (name !== 'xythum-exchange') assert.match(name, /^xythum-exchange-burner-v1-[0-9a-f]{32}$/);
});

test('origins must be canonical', async () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'https://a.example']) {
    assert.equal(canonicalOrigin(origin), origin);
  }
  for (const origin of [undefined, '', 'null', 'https://a.example/', 'https://a.example/path', 'HTTPS://a.example',
    'https://A.example', 'https://a.example:443', 'http://a.example', 'javascript:alert(1)', 'file:///x',
    'https://' + 'a'.repeat(300) + '.example']) {
    assert.throws(() => canonicalOrigin(origin), /origin/, String(origin));
    await assert.rejects(burnerSignRequest(fixed(), origin), /origin/);
  }
});

test('custody: non-extractable, idempotent, bound to one burner and origin, nothing else stored', async () => {
  const wallet = fixed();
  const backend = memoryBackend();
  const first = await unlock(wallet, ORIGIN, backend);
  const record = await backend.get('signer');
  assert.equal(record.kind, 'webcrypto');
  assert.equal(record.privateKey.extractable, false);
  assert.deepEqual((await backend.keys('')).sort(), ['burner-binding', 'signer']);
  assert.equal((await unlock(importBurnerWallet(fixedBackup, ORIGIN), ORIGIN, backend)).traderPublicKey, first.traderPublicKey);

  await assert.rejects(unlock(createBurnerWallet(), ORIGIN, backend), /different burner wallet or app origin/);
  // The same burner bound to another origin, handed this origin's storage.
  await assert.rejects(unlock(fixedAt('https://other.example'), 'https://other.example', backend),
    /different burner wallet or app origin/);

  const foreign = memoryBackend();
  await loadSigner(new Store(foreign));
  await assert.rejects(unlock(wallet, ORIGIN, foreign), /different trading key/);

  // A record whose public key matches but whose private key does not.
  const forged = memoryBackend();
  const legacy = memoryBackend();
  await loadSigner(new Store(legacy));
  await forged.put('signer', { ...(await legacy.get('signer')), publicKey: record.publicKey });
  await assert.rejects(unlock(wallet, ORIGIN, forged), /does not match this burner wallet/);

  await assert.rejects(unlockBurnerStore({ accountId: wallet.accountId }, ORIGIN, { backend: memoryBackend() }), TypeError);
  await assert.rejects(burnerSignRequest({ ...wallet }, ORIGIN), TypeError);
});

test('fails closed when the browser cannot hold a non-extractable Ed25519 key', async () => {
  const wallet = fixed();
  // Storage that cannot keep a CryptoKey.
  const lossy = memoryBackend();
  const put = lossy.putIfAbsent;
  lossy.putIfAbsent = async (key, value) => put(key, key === 'signer' ? { ...value, privateKey: {} } : value);
  await assert.rejects(unlock(wallet, ORIGIN, lossy), /could not store a non-extractable trading key/);

  // First insert returns the original CryptoKey, but the persisted copy is lost.
  const readLossy = memoryBackend();
  readLossy.putIfAbsent = async (key, value) => {
    await readLossy.put(key, key === 'signer' ? { ...value, privateKey: {} } : value);
    return value;
  };
  await assert.rejects(unlock(wallet, ORIGIN, readLossy), /could not store a non-extractable trading key/);

  const subtle = globalThis.crypto.subtle;
  const generateKey = subtle.generateKey;
  subtle.generateKey = async () => {
    throw new Error('Ed25519 unsupported');
  };
  try {
    const backend = memoryBackend();
    await assert.rejects(unlock(wallet, ORIGIN, backend), /use Start session instead/);
    assert.deepEqual(await backend.keys(''), []);
  } finally {
    subtle.generateKey = generateKey;
  }
});

test('createExchange accepts a burner store and keeps the legacy default', async () => {
  assert.equal(typeof protocol.createBurnerWallet, 'function');
  assert.equal(typeof protocol.importBurnerWallet, 'function');
  assert.equal(typeof protocol.burnerSignRequest, 'function');
  assert.equal(typeof protocol.unlockBurnerStore, 'function');
  const { store } = await unlock(fixed());
  const { controller } = protocol.createExchange({ store });
  assert.equal(controller.store, store);
  // Without a store the legacy IndexedDB backend is used (absent in Node).
  assert.throws(() => protocol.createExchange({}), /IndexedDB is unavailable/);
});
