// Origin-local persistence. Browsers use one IndexedDB object store, which
// can hold non-extractable CryptoKey objects by structured clone. Tests use
// the in-memory backend. Secret position openings are sealed at rest with a
// non-extractable AES-GCM vault key kept in the same database, so a copied
// storage dump alone does not reveal margin or blinders.

import { fromUtf8, randomBytes, subtle, utf8 } from './bytes.js';

const DB_NAME = 'xythum-exchange';
const STORE = 'kv';

export function memoryBackend() {
  const map = new Map();
  return {
    async get(key) { return structuredClone(map.get(key)); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async putIfAbsent(key, value) {
      if (!map.has(key)) map.set(key, structuredClone(value));
      return structuredClone(map.get(key));
    },
    async delete(key) { map.delete(key); },
    async keys(prefix) { return [...map.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

export function indexedDbBackend(name = DB_NAME) {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable; browser custody cannot be persisted');
  // Opened on first use, so constructing the backend never creates the
  // database (its existence must not be read as "this browser has a session").
  let connection;
  const opened = () => {
    connection ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('exchange storage is blocked by another tab'));
    });
    return connection;
  };
  const run = async (mode, fn) => {
    const db = await opened();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, value) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
    delete: (key) => run('readwrite', (s) => s.delete(key)).then(() => undefined),
    // One readwrite transaction: IndexedDB serializes overlapping readwrite
    // transactions across every connection (tab) of this origin, so the
    // read and the conditional write cannot interleave with another tab.
    putIfAbsent: async (key, value) => {
      const db = await opened();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let stored;
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result === undefined) {
            store.put(value, key);
            stored = value;
          } else {
            stored = req.result;
          }
        };
        tx.oncomplete = () => resolve(stored);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
      });
    },
    keys: (prefix) => run('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')))
      .then((keys) => keys.map(String)),
  };
}

export class Store {
  constructor(backend) {
    this.backend = backend;
  }

  get(key) { return this.backend.get(key); }
  put(key, value) { return this.backend.put(key, value); }
  delete(key) { return this.backend.delete(key); }
  /** Stores `value` only if `key` is unset; returns whichever value is stored. */
  putIfAbsent(key, value) { return this.backend.putIfAbsent(key, value); }
  keys(prefix) { return this.backend.keys(prefix); }

  async vaultKey() {
    const key = await this.backend.get('vault-key');
    if (key) return key;
    const fresh = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // Racing tabs converge on whichever key was stored first.
    return this.backend.putIfAbsent('vault-key', fresh);
  }

  /** Stores a JSON value encrypted under the origin vault key. */
  async putSealed(key, value) {
    const iv = randomBytes(12);
    const body = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(key) },
      await this.vaultKey(), utf8(JSON.stringify(value)),
    ));
    await this.backend.put(key, { sealed: 1, iv, body });
  }

  async getSealed(key) {
    const record = await this.backend.get(key);
    if (!record) return undefined;
    if (record.sealed !== 1) throw new Error('unexpected unsealed secret record ' + key);
    try {
      const plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: utf8(key) },
        await this.vaultKey(), record.body,
      );
      return JSON.parse(fromUtf8(new Uint8Array(plain)));
    } catch {
      throw new Error('local position secret ' + key + ' cannot be unsealed by this browser');
    }
  }
}
