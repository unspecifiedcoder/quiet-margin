// Proving worker integrity (pinned proving-key digest before wasm) and the
// one-worker-per-proof lifecycle, offline with synthetic key bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runJob } from '../prover-core.js';
import { DEFAULT_PK_SHA256, resolvePins } from '../prover-pins.js';
import { ProverClient } from '../prover.js';

const ORIGIN = 'http://127.0.0.1:5173';
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const syntheticKey = (n, salt) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + salt) & 0xff);

const B64_32 = Buffer.alloc(32, 9).toString('base64');
const OPEN_OUT = JSON.stringify({ commitment: B64_32, proof: 'AAAA', quote_terms: B64_32 });

function keyServer(keys, { declare = (body) => body.length, chunk = 1 << 20 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const kind = String(url).match(/\/api\/proving\/(open|close)\.pk$/)?.[1];
    const body = keys[kind];
    if (!body) return new Response('missing', { status: 404 });
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= body.length) return controller.close();
        controller.enqueue(body.slice(offset, offset + chunk));
        offset += chunk;
        return undefined;
      },
    });
    const headers = {};
    const declared = declare(body);
    if (declared !== null) headers['content-length'] = String(declared);
    return new Response(stream, { status: 200, headers });
  };
  return { fetchImpl, requests };
}

function fakeWasm() {
  const calls = [];
  const mod = {
    prove_open: (pk, vk, input) => {
      calls.push({ kind: 'open', pk: Uint8Array.from(pk), vk, input });
      return OPEN_OUT;
    },
    prove_close: (pk, vk, input) => {
      calls.push({ kind: 'close', pk: Uint8Array.from(pk), vk, input });
      return '{}';
    },
  };
  return { mod, calls, loadProver: async () => mod };
}

async function job(data, deps) {
  const posts = [];
  await runJob(data, { origin: ORIGIN, post: (m) => posts.push(m), ...deps });
  return { posts, final: posts.at(-1) };
}

test('pins default to the audited release digests and accept public overrides', () => {
  assert.deepEqual(resolvePins({}), {
    open: '7493ceba35d7d37768794b4b1796aded44cae4483da8c9b45bd9a636b784010f',
    close: '26df7dc7c8f3af3e4d1dc2c6c8c307f838512069a48837148f97cda8c082a58a',
  });
  assert.deepEqual(resolvePins({}), DEFAULT_PK_SHA256);
  assert.deepEqual(resolvePins({ VITE_XYTHUM_OPEN_PK_SHA256: '' }).open, DEFAULT_PK_SHA256.open);
  const custom = 'ab'.repeat(32);
  assert.equal(resolvePins({ VITE_XYTHUM_CLOSE_PK_SHA256: custom }).close, custom);
  assert.equal(resolvePins({ VITE_XYTHUM_CLOSE_PK_SHA256: custom }).open, DEFAULT_PK_SHA256.open);
  for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), ' ' + 'ab'.repeat(32)]) {
    assert.throws(() => resolvePins({ VITE_XYTHUM_OPEN_PK_SHA256: bad }), /64 lowercase hex/);
  }
});

test('a key matching its pin reaches the wasm prover byte for byte', async () => {
  const pk = syntheticKey(3 * (1 << 20) + 17, 5);
  const { fetchImpl, requests } = keyServer({ open: pk });
  const wasm = fakeWasm();
  const { posts, final } = await job(
    { id: 7, kind: 'open', vkSha256: 'VK', input: '{"x":1}' },
    { fetchImpl, loadProver: wasm.loadProver, pins: { open: hex(pk), close: '0'.repeat(64) } },
  );
  assert.deepEqual(final, { id: 7, ok: true, output: OPEN_OUT });
  assert.equal(wasm.calls.length, 1);
  assert.deepEqual(wasm.calls[0], { kind: 'open', pk, vk: 'VK', input: '{"x":1}' });
  assert.ok(posts.some((p) => p.progress === 'Verifying open proving key'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, ORIGIN + '/api/proving/open.pk');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'error');
});

test('a key without content-length is still hashed in full', async () => {
  const pk = syntheticKey(20 * (1 << 20) + 3, 9);
  const { fetchImpl } = keyServer({ close: pk }, { declare: () => null });
  const wasm = fakeWasm();
  const { final } = await job(
    { id: 1, kind: 'close', vkSha256: 'VK', input: '{}' },
    { fetchImpl, loadProver: wasm.loadProver, pins: { open: '0'.repeat(64), close: hex(pk) } },
  );
  assert.equal(final.ok, true, final.error);
  assert.deepEqual(wasm.calls[0].pk, pk);
});

test('a key that does not match its pin never reaches the wasm prover', async () => {
  const pk = syntheticKey(1 << 20, 1);
  const tampered = Uint8Array.from(pk);
  tampered[tampered.length - 1] ^= 1;
  const wasm = fakeWasm();
  for (const [served, pins] of [
    [tampered, { open: hex(pk) }],
    [pk, { open: DEFAULT_PK_SHA256.open }],
    // The close key served on the open route is refused by the open pin.
    [syntheticKey(4096, 2), { open: hex(pk), close: hex(syntheticKey(4096, 2)) }],
  ]) {
    const { fetchImpl } = keyServer({ open: served });
    const { final } = await job({ id: 2, kind: 'open', vkSha256: 'VK', input: '{}' }, { fetchImpl, loadProver: wasm.loadProver, pins });
    assert.equal(final.ok, false);
    assert.match(final.error, /does not match the pinned release digest/);
  }
  assert.equal(wasm.calls.length, 0);
});

test('truncated, oversized or missing keys never reach the wasm prover', async () => {
  const pk = syntheticKey(1 << 20, 3);
  const wasm = fakeWasm();
  const pins = { open: hex(pk), close: hex(pk) };
  const cases = [
    [keyServer({ open: pk }, { declare: (b) => b.length + 1 }), {}, /truncated/],
    [keyServer({ open: pk }), { maxPkBytes: 1000 }, /exceeds 1000 bytes/],
    [keyServer({ open: pk }, { declare: () => null }), { maxPkBytes: 1000 }, /exceeds 1000 bytes/],
    [keyServer({}), {}, /HTTP 404/],
  ];
  for (const [{ fetchImpl }, extra, pattern] of cases) {
    const { final } = await job({ id: 3, kind: 'open', vkSha256: 'VK', input: '{}', ...extra }, { fetchImpl, loadProver: wasm.loadProver, pins });
    assert.equal(final.ok, false);
    assert.match(final.error, pattern);
  }
  const { final } = await job({ id: 4, kind: 'liquidation', vkSha256: 'VK', input: '{}' }, { fetchImpl: keyServer({}).fetchImpl, loadProver: wasm.loadProver, pins });
  assert.match(final.error, /unknown proof kind/);
  assert.equal(wasm.calls.length, 0);
});

// ------------------------------------------------------------- client

function workerFactory(behave) {
  const workers = [];
  const create = () => {
    const w = {
      afterPreviousTerminated: workers.every((prev) => prev.terminated),
      terminated: false,
      messages: [],
      terminate() { this.terminated = true; },
      postMessage(message) {
        this.messages.push(message);
        setTimeout(() => behave(w, message, workers), 0);
      },
    };
    workers.push(w);
    return w;
  };
  return { create, workers };
}

const OPEN_INPUT = {
  context: 'c', size_lots: 1, entry_ticks: 2, margin_cents: 3, blinder: 'b', quote_blinder: 'q', open_price_ticks: 4,
};
const CLOSE_INPUT = {
  context: 'c', size_lots: 1, entry_ticks: 2, margin_cents: 3, blinder: 'b', round: 5, price_ticks: 6, funding_cents: 0,
};
const CLOSE_OUT = JSON.stringify({ commitment: B64_32, proof: 'AAAA', refund: 1, bad_debt: 0 });

test('each proof runs in a fresh worker that is terminated afterwards', async () => {
  const { create, workers } = workerFactory((w, m) => {
    w.onmessage({ data: { id: m.id, progress: 'working' } });
    w.onmessage({ data: { id: m.id + 1000, ok: true, output: 'ignored' } });
    w.onmessage({ data: { id: m.id, ok: true, output: m.kind === 'open' ? OPEN_OUT : CLOSE_OUT } });
  });
  const client = new ProverClient(create);
  const progress = [];
  const [open, close] = await Promise.all([
    client.prove('open', 'VK', OPEN_INPUT, (p) => progress.push(p)),
    client.prove('close', 'VK', CLOSE_INPUT),
  ]);
  assert.equal(open.quote_terms, B64_32);
  assert.equal(close.refund, 1);
  assert.deepEqual(progress, ['working']);
  assert.equal(workers.length, 2);
  assert.ok(workers.every((w) => w.terminated && w.messages.length === 1));
  assert.deepEqual(workers.map((w) => w.messages[0].kind), ['open', 'close']);
  assert.ok(workers.every((w) => w.afterPreviousTerminated), 'the close worker starts only after the open worker is gone');
  assert.deepEqual(Object.keys(JSON.parse(workers[0].messages[0].input)).sort(), Object.keys(OPEN_INPUT).sort());
});

test('a failed or crashed proof terminates its worker and the next one starts fresh', async () => {
  const { create, workers } = workerFactory((w, m) => {
    if (workers.length === 1) w.onmessage({ data: { id: m.id, ok: false, error: 'pin mismatch' } });
    else if (workers.length === 2) w.onerror({ message: 'out of memory' });
    else w.onmessage({ data: { id: m.id, ok: true, output: OPEN_OUT } });
  });
  const client = new ProverClient(create);
  await assert.rejects(client.prove('open', 'VK', OPEN_INPUT), /local proving failed: pin mismatch/);
  await assert.rejects(client.prove('open', 'VK', OPEN_INPUT), /proving worker crashed: out of memory/);
  assert.equal((await client.prove('open', 'VK', OPEN_INPUT)).commitment, B64_32);
  assert.equal(workers.length, 3);
  assert.ok(workers.every((w) => w.terminated && w.afterPreviousTerminated));
});

test('the worker imports the prover only from the public /prover/ path', () => {
  const worker = readFileSync(new URL('../prover.worker.js', import.meta.url), 'utf8');
  assert.match(worker, /new URL\('\/prover\/xythum_prover\.js', self\.location\.origin\)/);
  assert.doesNotMatch(worker, /prover\/pkg/);
  const config = readFileSync(new URL('../../../vite.config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /prover\/pkg|XYTHUM_PROVER_PKG/);
});
