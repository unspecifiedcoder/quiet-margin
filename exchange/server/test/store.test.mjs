import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SessionStore } from '../store.mjs';

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xythum-store-test-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const key = 's-' + 'ab'.repeat(12);
const onDisk = async (sub) => JSON.parse(await readFile(join(dir, sub, key + '.json'), 'utf8'));

test('concurrent saves of one session land in call order without temp collisions', async () => {
  const store = await new SessionStore(join(dir, 'concurrent')).open();
  try {
    // Shared by reference across queues, as the coordinator does.
    const record = { key, receipts: [], keeper: null };
    const saves = [];
    for (let i = 0; i < 40; i += 1) {
      record.receipts.push({ label: 'r' + i, hash: 'h' + i });
      if (i % 3 === 0) record.keeper = { attempts: i };
      saves.push(store.save(record));
    }
    // Mutated after the last call: not part of any queued snapshot.
    record.receipts.push({ label: 'unsaved', hash: 'x' });
    await Promise.all(saves);
    const saved = await onDisk('concurrent');
    assert.equal(saved.receipts.length, 40);
    assert.equal(saved.receipts.at(-1).label, 'r39');
    assert.equal(saved.keeper.attempts, 39);
    assert.equal(store.get(key), record);
    assert.deepEqual(await readdir(join(dir, 'concurrent')), ['coordinator.lock', key + '.json']);
  } finally {
    store.close();
  }
});

test('a failed write does not block or reorder later saves, and open discards temp files', async () => {
  const sub = join(dir, 'recover');
  const store = await new SessionStore(sub).open();
  try {
    const record = { key, receipts: [] };
    // Invalid input rejects instead of throwing synchronously.
    await assert.rejects(store.save({ key, bad: 1n }), TypeError);
    await assert.rejects(store.save({ key: 'nope' }), /invalid session key/);
    // A rename over a directory fails; the queue for the key still drains.
    await mkdir(join(sub, key + '.json'));
    await assert.rejects(store.save(record));
    await rm(join(sub, key + '.json'), { recursive: true });
    record.receipts.push({ label: 'later', hash: 'h' });
    await store.save(record);
    assert.equal((await onDisk('recover')).receipts[0].label, 'later');
  } finally {
    store.close();
  }
  await writeFile(join(sub, key + '.json.7.tmp'), '{partial');
  const reopened = await new SessionStore(sub).open();
  try {
    assert.equal(reopened.get(key).receipts[0].label, 'later');
    assert.ok(!(await readdir(sub)).some((name) => name.endsWith('.tmp')));
  } finally {
    reopened.close();
  }
});
