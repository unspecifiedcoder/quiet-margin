// Session enrollment proof, public-key validation and cross-tab signer
// creation, all offline with synthetic keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Api, ApiError, isEd25519PublicKey } from '../api.js';
import { fromBase64, toBase58, toBase64, utf8 } from '../bytes.js';
import { loadSigner, sessionProof, sessionProofMessage } from '../signer.js';
import { indexedDbBackend, memoryBackend, Store } from '../store.js';

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const seedPub = ed25519.getPublicKey(seed);
const nearKey = (raw) => 'ed25519:' + toBase58(raw);

/**
 * Minimal IndexedDB model: every transaction (from any connection, i.e.
 * any tab) runs exclusively and in creation order, each request in its own
 * task, as browsers do for overlapping readwrite transactions.
 */
function fakeIndexedDB() {
  const databases = new Map();
  let lock = Promise.resolve();
  const task = () => new Promise((r) => setTimeout(r, 0));
  const database = (data) => ({
    createObjectStore() {},
    transaction(_name, mode) {
      const requests = [];
      const enqueue = (op) => {
        const req = { result: undefined, onsuccess: null };
        requests.push({ req, op });
        return req;
      };
      const writable = () => {
        if (mode !== 'readwrite') throw new Error('ReadOnlyError');
      };
      const store = {
        get: (k) => enqueue(() => structuredClone(data.get(k))),
        put: (v, k) => {
          writable();
          return enqueue(() => {
            data.set(k, structuredClone(v));
            return k;
          });
        },
        delete: (k) => {
          writable();
          return enqueue(() => {
            data.delete(k);
          });
        },
      };
      const tx = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null, error: null };
      lock = lock.then(async () => {
        while (requests.length) {
          await task();
          const { req, op } = requests.shift();
          req.result = op();
          req.onsuccess?.({ target: req });
        }
        await task();
        tx.oncomplete?.();
      });
      return tx;
    },
  });
  return {
    data: (name) => databases.get(name),
    open(name) {
      const req = {};
      setTimeout(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        req.result = database(databases.get(name));
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

async function withFakeIndexedDB(fn) {
  const saved = globalThis.indexedDB;
  const idb = fakeIndexedDB();
  globalThis.indexedDB = idb;
  try {
    return await fn(idb);
  } finally {
    globalThis.indexedDB = saved;
  }
}

test('session proof is the exact Ed25519 signature over the enrollment string', async () => {
  const store = new Store(memoryBackend());
  await store.put('signer', { kind: 'origin-storage', secret: seed, publicKey: seedPub });
  const signer = await loadSigner(store);
  assert.equal(signer.publicKey, nearKey(seedPub));
  assert.equal(sessionProofMessage(signer.publicKey), 'xythum:exchange:session:v1:testnet:' + nearKey(seedPub));
  const proof = await sessionProof(signer);
  const expected = ed25519.sign(utf8('xythum:exchange:session:v1:testnet:' + nearKey(seedPub)), seed);
  assert.equal(proof, toBase64(expected));
  assert.equal(toBase64(fromBase64(proof, 64)), proof);
});

test('WebCrypto signer proof verifies and is stable across reloads', async () => {
  const store = new Store(memoryBackend());
  const first = await loadSigner(store);
  assert.equal(first.custody, 'webcrypto-nonextractable');
  const proof = await sessionProof(first);
  const message = utf8(sessionProofMessage(first.publicKey));
  assert.ok(ed25519.verify(fromBase64(proof, 64), message, first.publicKeyBytes, { zip215: false }));
  const reloaded = await loadSigner(store);
  assert.equal(reloaded.publicKey, first.publicKey);
  assert.equal(await sessionProof(reloaded), proof, 'a retried enrollment carries the same proof');
  const other = await loadSigner(new Store(memoryBackend()));
  assert.ok(!ed25519.verify(fromBase64(proof, 64), utf8(sessionProofMessage(other.publicKey)), other.publicKeyBytes));
});

test('public keys are validated by decoding exactly 32 canonical bytes', () => {
  const zero = new Uint8Array(32);
  const leading = Uint8Array.from({ length: 32 }, (_, i) => (i < 5 ? 0 : 0xab));
  const small = new Uint8Array(32);
  small[31] = 1;
  for (const raw of [zero, leading, small, seedPub, new Uint8Array(32).fill(0xff)]) {
    const key = nearKey(raw);
    assert.ok(isEd25519PublicKey(key), key);
  }
  assert.equal(nearKey(zero), 'ed25519:' + '1'.repeat(32));
  assert.ok(nearKey(leading).length - 8 < 43, 'shorter than the old 43..44 digit rule');
  for (const bad of [
    nearKey(new Uint8Array(31).fill(7)),
    nearKey(new Uint8Array(33).fill(7)),
    'ed25519:' + '1'.repeat(33),
    'ed25519:' + '1'.repeat(31),
    'ed25519:' + toBase58(seedPub).replace(/.$/, '0'),
    'secp256k1:' + toBase58(seedPub),
    toBase58(seedPub),
    'ed25519:',
    42,
  ]) assert.equal(isEd25519PublicKey(bad), false, String(bad));
});

test('createSession posts exactly {public_key, proof} without a bearer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ error: 'stop' }), { status: 418 });
  };
  const api = new Api({ base: '/api', fetchImpl });
  const store = new Store(memoryBackend());
  await store.put('signer', { kind: 'origin-storage', secret: seed, publicKey: seedPub });
  const signer = await loadSigner(store);
  const proof = await sessionProof(signer);
  await assert.rejects(api.createSession(signer.publicKey, proof), (e) => e instanceof ApiError && e.status === 418);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/sessions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { public_key: signer.publicKey, proof });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), ['public_key', 'proof']);

  // Malformed inputs never reach the network.
  const sig = fromBase64(proof, 64);
  for (const [key, p] of [
    [signer.publicKey, undefined],
    [signer.publicKey, toBase64(sig.subarray(0, 63))],
    [signer.publicKey, proof.replace(/=+$/, '')],
    [nearKey(new Uint8Array(33)), proof],
  ]) {
    await assert.rejects(api.createSession(key, p), ApiError);
  }
  assert.equal(calls.length, 1);
});

test('recoverOnly adds exactly restore_only: true; options are strict and the server code is kept', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ error: 'session_not_found', message: 'none' }), { status: 404 });
  };
  const api = new Api({ base: '/api', fetchImpl });
  const store = new Store(memoryBackend());
  await store.put('signer', { kind: 'origin-storage', secret: seed, publicKey: seedPub });
  const signer = await loadSigner(store);
  const proof = await sessionProof(signer);
  await assert.rejects(api.createSession(signer.publicKey, proof, { recoverOnly: true }),
    (e) => e instanceof ApiError && e.status === 404 && e.code === 'session_not_found');
  assert.deepEqual(JSON.parse(calls[0].init.body), { public_key: signer.publicKey, proof, restore_only: true });
  assert.equal(calls[0].init.headers.authorization, undefined);
  // An explicit false and an empty options object keep the legacy body.
  await assert.rejects(api.createSession(signer.publicKey, proof, { recoverOnly: false }), ApiError);
  await assert.rejects(api.createSession(signer.publicKey, proof, {}), ApiError);
  for (const call of calls.slice(1)) assert.deepEqual(Object.keys(JSON.parse(call.init.body)), ['public_key', 'proof']);
  assert.equal(calls.length, 3);
  // Non-boolean or unknown options never reach the network.
  for (const options of [{ recoverOnly: 'true' }, { recoverOnly: 1 }, { recoverOnly: null }, { restore_only: true },
    { recoverOnly: true, extra: 1 }, null, true, []]) {
    await assert.rejects(api.createSession(signer.publicKey, proof, options), /bad session options/, JSON.stringify(options));
  }
  assert.equal(calls.length, 3);
});

test('a 64-byte proof with non-zero padding bits is rejected as non-canonical', async () => {
  const api = new Api({ base: '/api', fetchImpl: async () => assert.fail('must not fetch') });
  const canonicalProof = toBase64(new Uint8Array(64));
  assert.ok(canonicalProof.endsWith('AA=='));
  const padded = canonicalProof.slice(0, -3) + 'B==';
  assert.equal(fromBase64(padded, 64).length, 64, 'decodes to the same bytes');
  await assert.rejects(api.createSession(nearKey(seedPub), padded), /bad session proof/);
});

test('fake IndexedDB reproduces the get-then-put race (control)', () => withFakeIndexedDB(async () => {
  const [a, b] = [indexedDbBackend('race-control'), indexedDbBackend('race-control')];
  // The previous get -> generate -> put -> re-read flow, with tab B's key
  // generation finishing after tab A already re-read (and used) its key.
  // Promise barriers fix the interleaving instead of timers: both tabs see
  // no key, then A finishes entirely, then B's generation completes.
  const barrier = () => {
    let open;
    return { promise: new Promise((r) => { open = r; }), open };
  };
  const readA = barrier();
  const readB = barrier();
  const doneA = barrier();
  const naive = async (backend, value, read, generated) => {
    if (await backend.get('k')) return backend.get('k');
    read.open();
    await generated; // key generation
    await backend.put('k', value);
    return backend.get('k');
  };
  const [ra, rb] = await Promise.all([
    naive(a, 'A', readA, Promise.all([readA.promise, readB.promise])).then((v) => {
      doneA.open();
      return v;
    }),
    naive(b, 'B', readB, doneA.promise),
  ]);
  assert.equal(ra, 'A');
  assert.equal(rb, 'B', 'tab B overwrote the key tab A already used');
}));

test('two tabs creating the first signer through IndexedDB converge on one key', () => withFakeIndexedDB(async (idb) => {
  const tabs = [indexedDbBackend('xythum-exchange'), indexedDbBackend('xythum-exchange')];
  const [a, b] = await Promise.all(tabs.map((backend) => loadSigner(new Store(backend))));
  assert.equal(a.publicKey, b.publicKey);
  const stored = idb.data('xythum-exchange').get('signer');
  assert.equal(nearKey(stored.publicKey), a.publicKey);
  // Both tabs' signatures verify under the stored (funded) key.
  const msg = utf8('xythum');
  for (const signer of [a, b]) assert.ok(ed25519.verify(await signer.sign(msg), msg, stored.publicKey));
  const third = await loadSigner(new Store(indexedDbBackend('xythum-exchange')));
  assert.equal(third.publicKey, a.publicKey);
}));

test('a tab whose key generation finishes late adopts the key the first tab already uses', () => withFakeIndexedDB(async (idb) => {
  const fast = indexedDbBackend('slow-tab');
  const real = indexedDbBackend('slow-tab');
  const slow = {
    ...real,
    async put(key, value) {
      await new Promise((r) => setTimeout(r, 50));
      return real.put(key, value);
    },
    async putIfAbsent(key, value) {
      await new Promise((r) => setTimeout(r, 50));
      return real.putIfAbsent(key, value);
    },
  };
  const [a, b] = await Promise.all([loadSigner(new Store(fast)), loadSigner(new Store(slow))]);
  assert.equal(b.publicKey, a.publicKey);
  assert.equal(nearKey(idb.data('slow-tab').get('signer').publicKey), a.publicKey);
}));

test('two tabs creating the vault key converge, so sealed records stay readable', () => withFakeIndexedDB(async () => {
  const [a, b] = [new Store(indexedDbBackend('vault')), new Store(indexedDbBackend('vault'))];
  await Promise.all([a.putSealed('opening-a', { margin: 1 }), b.putSealed('opening-b', { margin: 2 })]);
  assert.deepEqual(await b.getSealed('opening-a'), { margin: 1 });
  assert.deepEqual(await a.getSealed('opening-b'), { margin: 2 });
}));

test('constructing the IndexedDB backend does not open or create the database', () => withFakeIndexedDB(async (idb) => {
  const backend = indexedDbBackend('lazy');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(idb.data('lazy'), undefined);
  assert.equal(await backend.get('signer'), undefined);
  assert.ok(idb.data('lazy'));
}));

test('memory backend putIfAbsent keeps the first value', async () => {
  const store = new Store(memoryBackend());
  const [x, y] = await Promise.all([store.putIfAbsent('k', { v: 1 }), store.putIfAbsent('k', { v: 2 })]);
  assert.deepEqual(x, { v: 1 });
  assert.deepEqual(y, { v: 1 });
  const [a, b] = await Promise.all([loadSigner(store), loadSigner(store)]);
  assert.equal(a.publicKey, b.publicKey);
});
