// Durable session metadata. One JSON file per session in a directory outside
// Git. Records hold public chain data and a SHA-256 of the bearer capability,
// never the capability itself or any key material.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RECORD = /^s-[0-9a-f]{24}\.json$/;
const TEMP = /^s-[0-9a-f]{24}\.json(?:\.\d+)?\.tmp$/;

export class SessionStore {
  #dir;
  #records = new Map();
  #lockPath;
  #writes = new Map();
  #sequence = 0;

  constructor(dir) {
    this.#dir = dir;
    this.#lockPath = join(dir, 'coordinator.lock');
  }

  // A second coordinator on the same directory would break quota accounting
  // and signer nonce serialization, so hold an exclusive pid lock.
  async open() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.#lockPath)) {
      const pid = Number(readFileSync(this.#lockPath, 'utf8'));
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          alive = error.code === 'EPERM';
        }
      }
      if (alive) throw new Error('another coordinator holds ' + this.#lockPath);
      unlinkSync(this.#lockPath);
    }
    writeFileSync(this.#lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    for (const name of await readdir(this.#dir)) {
      // A temp file is only ever renamed over its record once complete, so
      // one left by a crash is an unfinished write and is discarded.
      if (TEMP.test(name)) {
        await unlink(join(this.#dir, name));
        continue;
      }
      if (!RECORD.test(name)) continue;
      const record = JSON.parse(await readFile(join(this.#dir, name), 'utf8'));
      if (name !== record.key + '.json') throw new Error('session record name mismatch: ' + name);
      this.#records.set(record.key, record);
    }
    return this;
  }

  close() {
    try {
      if (readFileSync(this.#lockPath, 'utf8') === String(process.pid)) unlinkSync(this.#lockPath);
    } catch {
      // Already released.
    }
  }

  get size() {
    return this.#records.size;
  }

  all() {
    return [...this.#records.values()];
  }

  get(key) {
    return this.#records.get(key);
  }

  find(predicate) {
    for (const record of this.#records.values()) if (predicate(record)) return record;
    return undefined;
  }

  // Callers on independent queues (HTTP session work, the keeper worker,
  // setup) may save the same record concurrently. The record is serialized
  // synchronously at invocation and the in-memory map updated in call order;
  // durable writes then run one at a time per session in that same order,
  // each through its own temp file, so a later save can never be overwritten
  // by an earlier one or collide on a shared temp path. The queue is private
  // to the store, so it cannot interleave with coordinator locks.
  save(record) {
    if (!/^s-[0-9a-f]{24}$/.test(record.key)) return Promise.reject(new Error('invalid session key'));
    record.updated_at = new Date().toISOString();
    let data;
    try {
      data = JSON.stringify(record, null, 2) + '\n';
    } catch (error) {
      return Promise.reject(error);
    }
    this.#records.set(record.key, record);
    const path = join(this.#dir, record.key + '.json');
    const temp = path + '.' + (++this.#sequence) + '.tmp';
    const write = async () => {
      try {
        await writeFile(temp, data, { mode: 0o600 });
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      return record;
    };
    const previous = this.#writes.get(record.key) ?? Promise.resolve();
    const result = previous.then(write, write);
    const tail = result.then(() => {}, () => {});
    this.#writes.set(record.key, tail);
    tail.then(() => {
      if (this.#writes.get(record.key) === tail) this.#writes.delete(record.key);
    });
    return result;
  }

  // Resolves once every durable write queued so far has settled.
  async flush() {
    await Promise.all([...this.#writes.values()]);
  }
}

// Volatile store for offline tests. `snapshot()` simulates a restart.
export class MemoryStore {
  #records = new Map();
  constructor(records = []) {
    for (const record of records) this.#records.set(record.key, structuredClone(record));
  }
  snapshot() {
    return this.all().map((record) => structuredClone(record));
  }
  async open() {
    return this;
  }
  async flush() {}
  close() {}
  get size() {
    return this.#records.size;
  }
  all() {
    return [...this.#records.values()];
  }
  get(key) {
    return this.#records.get(key);
  }
  find(predicate) {
    for (const record of this.#records.values()) if (predicate(record)) return record;
    return undefined;
  }
  async save(record) {
    record.updated_at = new Date().toISOString();
    this.#records.set(record.key, record);
    return record;
  }
}
