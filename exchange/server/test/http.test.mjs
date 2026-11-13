import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createActors, HEALTHY_REFUSAL, isOwnerOnlySddl, runActor, securePrivateDir, WINDOWS_TOOLS } from '../actors.mjs';
import { createApp } from '../app.mjs';
import { safeMessage } from '../util.mjs';
import { KeeperWorker } from '../worker.mjs';
import { enrollment, harness } from './harness.mjs';

let dir;
let server;
let base;
let h;
const logs = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xythum-server-test-'));
  const proving = join(dir, 'proving');
  const dist = join(dir, 'dist');
  await mkdir(proving);
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(proving, 'open.pk'), Buffer.from('open-proving-key'));
  await writeFile(join(proving, 'close.pk'), Buffer.from('close-proving-key'));
  await writeFile(join(proving, 'liquidation.pk'), Buffer.from('liquidation-proving-key'));
  await writeFile(join(dir, 'secret.txt'), 'outside dist');
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>exchange</title>');
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)');
  h = harness({ env: { XYTHUM_PROVING_DIR: proving, XYTHUM_DIST_DIR: dist } });
  server = createServer(createApp({ coordinator: h.coordinator, config: h.config, log: (line) => logs.push(line) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const post = (path, body, token, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('local pool helper requires explicit loopback setup and a same-origin browser request', async () => {
  const route = '/api/proving/local-pool';
  assert.equal((await post(route, {})).status, 404);
  const inputs = [];
  const local = createServer(createApp({ coordinator: h.coordinator, config: h.config,
    poolProver: async (input) => { inputs.push(input); return { proof: 'test-proof' }; } }));
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + local.address().port;
  const input = { kind: 'spend', fingerprint: 'mock', witness: { fixture: 'private' } };
  const request = (source, site, body = input) => fetch(origin + route, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: source, 'Sec-Fetch-Site': site } });
  try {
    assert.equal((await request('https://example.com', 'cross-site')).status, 403);
    assert.equal((await request(origin, 'cross-site')).status, 403);
    assert.equal((await request(origin, 'same-origin', 'x'.repeat(21_000))).status, 413);
    const accepted = await request(origin, 'same-origin');
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await accepted.json(), { proof: 'test-proof' });
    assert.deepEqual(inputs, [input]);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test('refresh requires the bearer and an exact empty object', async () => {
  const created = await (await post('/api/sessions', enrollment())).json();
  assert.equal((await post('/api/session/refresh', {})).status, 401);
  const calls = h.chain.calls.length;
  const reused = await post('/api/session/refresh', {}, created.session_id);
  assert.equal(reused.status, 200);
  assert.deepEqual(Object.keys(await reused.json()), ['oracle']);
  const priced = await post('/api/session/refresh', { price_ticks: 1 }, created.session_id);
  assert.equal(priced.status, 400);
  assert.equal((await priced.json()).error, 'unexpected_field');
  assert.equal((await post('/api/session/refresh', '[]', created.session_id)).status, 400);
  assert.equal(h.chain.calls.length, calls);
  assert.equal((await fetch(base + '/api/session/refresh')).status, 405);
});

test('session lifecycle over HTTP without leaking capabilities or bodies to logs', async () => {
  const body = enrollment();
  const publicKey = body.public_key;
  const created = await post('/api/sessions', body);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const session = await created.json();
  assert.equal(session.chain_id, 'testnet');
  assert.equal(typeof session.session_id, 'string');

  // A lost response is recovered by posting the same proof again.
  const retried = await post('/api/sessions', body);
  assert.equal(retried.status, 201);
  const again = await retried.json();
  assert.equal(again.session_id, session.session_id);
  assert.equal(again.market_id, session.market_id);
  // Someone who knows only the public key gets nothing.
  const forged = await post('/api/sessions', { public_key: publicKey, proof: enrollment().proof });
  assert.equal(forged.status, 401);
  assert.deepEqual(Object.keys(await forged.json()).sort(), ['error', 'message']);
  assert.equal((await post('/api/sessions', { public_key: publicKey })).status, 400);

  const unauthorized = await fetch(base + '/api/session');
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, 'unauthorized');

  const fetched = await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + session.session_id } });
  assert.equal(fetched.status, 200);
  assert.deepEqual((await fetched.json()).receipts, session.receipts);

  const mark = await post('/api/session/mark', { price_ticks: 10_000 }, session.session_id);
  assert.equal(mark.status, 200);
  assert.equal((await mark.json()).oracle.round, 2);

  const keeper = await post('/api/session/keeper', { armed: true }, session.session_id);
  assert.equal(keeper.status, 409);
  assert.equal((await keeper.json()).error, 'no_active');

  const withSecret = await post('/api/session/approve', {
    nonce: 1, commitment: randomBytes(32).toString('base64'), quote_blinder: randomBytes(32).toString('base64'),
    size_lots: 10, entry_ticks: 10_000, margin_cents: 50_000,
  }, session.session_id);
  assert.equal(withSecret.status, 400);
  assert.equal((await withSecret.json()).error, 'unexpected_field');

  const text = logs.join('\n');
  assert.ok(!text.includes(session.session_id));
  assert.ok(!text.includes(publicKey));
  assert.ok(!text.includes(body.proof));
  assert.ok(!text.includes('price_ticks') && !text.includes('margin'));
  assert.ok(logs.some((line) => /^POST \/api\/sessions 201 \d+ms$/.test(line)));
});

test('request hygiene: content type, size, JSON and methods', async () => {
  assert.equal((await post('/api/sessions', 'x', undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/sessions', '{')).status, 400);
  assert.equal((await post('/api/sessions', JSON.stringify({ public_key: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await fetch(base + '/api/sessions')).status, 405);
  assert.equal((await fetch(base + '/api/nothing')).status, 404);
  assert.equal((await post('/api/session/mark', { price_ticks: 1 }, 'not-a-token')).status, 401);
});

test('proving endpoints serve only the fixed public key files', async () => {
  const open = await fetch(base + '/api/proving/open.pk');
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('content-type'), 'application/octet-stream');
  assert.equal(open.headers.get('content-encoding'), null);
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), Buffer.from('open-proving-key'));
  assert.deepEqual(Buffer.from(await (await fetch(base + '/api/proving/close.pk')).arrayBuffer()),
    Buffer.from('close-proving-key'));
  for (const path of ['/api/proving/liquidation.pk', '/api/proving/', '/api/proving/open.vk',
    '/api/proving/..%2Fsecret.txt', '/api/proving/open.pk/']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('serves the optional exchange build without escaping its directory', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /exchange/);
  assert.equal((await fetch(base + '/assets/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await (await fetch(base + '/trade')).text(), /exchange/);
  for (const path of ['/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/assets/missing.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /outside dist/);
  }
});

test('async actor runner returns JSON and surfaces only the final redacted stderr line', async () => {
  const fake = join(dir, 'fake-actor.mjs');
  await writeFile(fake, `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (process.argv[2] === 'fail') {
      process.stderr.write('noise ed25519:3yZe7d1fd\\n' + 'position is healthy (key ' + 'A'.repeat(50) + ')\\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ echoed: input.value }));
  `);
  assert.deepEqual(await runActor('ok', { value: 7 }, { actorPath: fake }), { echoed: 7 });
  await assert.rejects(runActor('fail', {}, { actorPath: fake }), (error) => {
    assert.equal(error.message, 'position is healthy (key [redacted])');
    return true;
  });
  assert.equal(safeMessage('Bearer abc.def ed25519:5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe'),
    'Bearer [redacted] ed25519:[redacted]');
});

test('actor wrapper gives each keeper a temporary file with only its own secrets', async () => {
  const seen = [];
  const keeperDir = join(dir, 'sessions', 'keeper');
  const actors = createActors({
    keeperIds: ['keeper-a.x.testnet', 'keeper-b.x.testnet'], rpcUrl: 'https://test.rpc.fastnear.com', provingDir: '/p',
    keeperDir,
    keeperSecrets: (index, { withTxKey }) => withTxKey
      ? { encryption: 'enc' + index, txKey: 'tx' + index }
      : { encryption: 'enc' + index, signing: 'sig' + index },
    run: async (command, input) => {
      seen.push({ command, input, file: JSON.parse(await readFile(input.keyPath, 'utf8')) });
      return command === 'ack' ? { signature: 'sig' } : { tx: { hash: 'h' } };
    },
  });
  const session = { market_id: 'market-0.x.testnet', trader_id: 'trader-0.x.testnet' };
  const commitment = randomBytes(32).toString('base64');
  await actors.ack(session, 0);
  await actors.liquidate(session, { expectedNonce: 3, expectedCommitment: commitment });
  assert.deepEqual(seen[0].file, { encryption: 'enc0', signing: 'sig0' });
  assert.deepEqual(seen[1].file, { encryption: 'enc1', txKey: 'tx1' });
  assert.equal(seen[1].input.keeperIndex, 1);
  assert.equal(seen[1].input.accountId, 'keeper-b.x.testnet');
  assert.equal(seen[1].input.testnet, true);
  // The armed slot pin reaches the actor (tests/actor.mjs checkPinnedSlot on the integrated base).
  assert.equal(seen[1].input.expectedNonce, 3);
  assert.equal(seen[1].input.expectedCommitment, commitment);
  assert.equal(seen[0].input.expectedNonce, undefined);
  for (const { input } of seen) {
    assert.ok(input.keyPath.startsWith(keeperDir), 'keeper file is under the operator directory');
    await assert.rejects(readFile(input.keyPath));
  }
  // Without a pin, nothing is written and no actor runs.
  await assert.rejects(actors.liquidate(session), /armed slot/);
  await assert.rejects(actors.liquidate(session, { expectedNonce: 3 }), /armed slot/);
  assert.equal(seen.length, 2);
  assert.throws(() => createActors({ keeperSecrets() {}, keeperIds: [], rpcUrl: '', provingDir: '' }), /keeperDir/);
});

test('no keeper secret is written if the keeper directory cannot be restricted', async () => {
  let wrote = false;
  const actors = createActors({
    keeperIds: ['a', 'b'], rpcUrl: '', provingDir: '', keeperDir: join(dir, 'never'),
    keeperSecrets: () => { wrote = true; return {}; },
    secureDir: async () => { throw new Error('keeper directory ACL is not restricted to the current user'); },
    run: async () => ({ signature: 'sig' }),
  });
  await assert.rejects(actors.ack({ market_id: 'm', trader_id: 't' }, 0), /not restricted/);
  assert.equal(wrote, false);
});

test('SDDL check accepts only a protected DACL with allow ACEs for the current user', () => {
  const me = 'S-1-5-21-1-2-3-1001';
  assert.ok(isOwnerOnlySddl('O:' + me + 'G:' + me + 'D:PAI(A;OICI;FA;;;' + me + ')', me));
  assert.ok(isOwnerOnlySddl('D:P(A;OICI;FA;;;' + me + ')(A;;FA;;;' + me + ')', me));
  for (const sddl of [
    'D:AI(A;OICI;FA;;;' + me + ')', // inherits
    'D:P(A;OICI;FA;;;' + me + ')(A;OICI;FR;;;WD)', // Everyone
    'D:P(A;OICI;FA;;;' + me + ')(A;OICI;FA;;;SY)',
    'D:P(D;;FA;;;' + me + ')', 'D:P', '', 'D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1002)',
  ]) {
    assert.ok(!isOwnerOnlySddl(sddl, me), sddl);
  }
});

test('the keeper directory is restricted to the current user before use', async () => {
  const target = join(dir, 'acl-check', 'keeper');
  const secured = await securePrivateDir(target);
  await writeFile(join(secured, 'run-stale'), 'left by a crash');
  await securePrivateDir(target);
  await assert.rejects(readFile(join(secured, 'run-stale')));
  if (process.platform === 'win32') {
    // A file created inside inherits only the current user's ACE.
    const run0 = promisify(execFile);
    await writeFile(join(secured, 'probe'), 'x');
    const listing = (await run0(WINDOWS_TOOLS.icacls, [join(secured, 'probe')], { windowsHide: true })).stdout;
    assert.equal(listing.split(/\r?\n/).filter((line) => /:\(/.test(line)).length, 1, listing);
    const run = promisify(execFile);
    // Granting another principal is detected and refused on the next check.
    const loose = join(dir, 'acl-loose');
    await mkdir(loose);
    await securePrivateDir(loose);
    await run(WINDOWS_TOOLS.icacls, [loose, '/grant', '*S-1-1-0:(R)', '/q'], { windowsHide: true });
    await assert.rejects(securePrivateDir(loose, {
      // Reuse the real checks but skip the reset, as if icacls had silently failed.
      exec: async (file, args, options) => args.includes('/inheritance:r') ? ''
        : (await run(file, args, { windowsHide: true, ...options })).stdout,
    }), /not restricted/);
  } else {
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(secured)).mode & 0o077, 0);
  }
});

test('the background worker retries armed sessions on new rounds while the browser is away', async () => {
  let liquidatable = false;
  const w = harness({
    actors: {
      ack: async () => randomBytes(64).toString('base64'),
      async liquidate(session) {
        if (!liquidatable) throw new Error('error: ' + HEALTHY_REFUSAL);
        w.chain.markets.get(session.market_id).active = null;
        return { tx: { hash: 'WorkerLiquidation' } };
      },
    },
  });
  const view = await w.coordinator.createSession(enrollment());
  const { record } = w.coordinator.authenticate('Bearer ' + view.session_id);
  const market = w.chain.markets.get(record.market_id);
  market.pending = { nonce: 1, commitment: randomBytes(32).toString('base64') };
  w.chain.open(record.market_id);
  await w.coordinator.keeper(record, { armed: true });
  const lines = [];
  const worker = new KeeperWorker({ coordinator: w.coordinator, intervalMs: 60_000, log: (line) => lines.push(line) });
  worker.start();
  try {
    liquidatable = true;
    market.oracle = { ...market.oracle, round: market.oracle.round + 1, price_ticks: 5_200 };
    await worker.wake();
    await worker.wake();
  } finally {
    await worker.stop();
  }
  assert.equal(record.keeper.settlement.outcome, 'liquidated');
  assert.ok(lines.some((line) => line.endsWith('liquidation_1 WorkerLiquidation')));
  assert.ok(!lines.join('\n').includes(view.session_id));
});
