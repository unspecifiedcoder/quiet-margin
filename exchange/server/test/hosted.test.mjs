// Hosted admission (invite gate), hosted-only response headers, dot-path
// handling, and the hosted runtime configuration. Offline: mock chain only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkInvite, createApp, HOSTED_CSP } from '../app.mjs';
import { ConfigError, loadConfig } from '../config.mjs';
import { enrollment, harness } from './harness.mjs';

const INVITE = randomBytes(32).toString('hex');
const HOSTED_ENV = Object.freeze({
  XYTHUM_ALLOW_HOSTED: '1', XYTHUM_SERVER_HOST: '0.0.0.0', XYTHUM_HOSTED_INVITE: INVITE,
  XYTHUM_SESSION_DIR: '/data/sessions', XYTHUM_PROVING_DIR: '/app/artifacts/proving',
  MARKET_WASM: '/app/artifacts/market.wasm', PROVER_BIN: '/app/bin/xythum-prover',
});

let dir;
const servers = [];
let hosted;
let local;

async function listen(h) {
  const logs = [];
  const server = createServer(createApp({ coordinator: h.coordinator, config: h.config, log: (line) => logs.push(line) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { h, logs, base: 'http://127.0.0.1:' + server.address().port };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xythum-hosted-test-'));
  const dist = join(dir, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(join(dist, 'prover'), { recursive: true });
  await mkdir(join(dist, '.git'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>exchange</title>');
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(dist, 'prover', 'xythum_prover_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  await writeFile(join(dist, '.env'), 'NEAR_DEMO_SECRET_KEY=should-never-be-served');
  await writeFile(join(dist, '.git', 'config'), 'never served');
  hosted = await listen(harness({ env: { ...HOSTED_ENV, XYTHUM_DIST_DIR: dist } }));
  local = await listen(harness({ env: { XYTHUM_DIST_DIR: dist } }));
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(dir, { recursive: true, force: true });
});

const create = (base, body, headers = {}) => fetch(base + '/api/sessions', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('hosted mode requires a 32-byte lowercase hex invite and absolute runtime paths', () => {
  const config = loadConfig(HOSTED_ENV);
  assert.equal(config.hosted, true);
  assert.equal(config.host, '0.0.0.0');
  assert.deepEqual(config.hostedInvite, Buffer.from(INVITE, 'hex'));
  assert.equal(config.sessionDir, '/data/sessions');
  assert.equal(config.provingDir, '/app/artifacts/proving');
  assert.equal(config.marketWasm, '/app/artifacts/market.wasm');
  for (const invite of [undefined, '', INVITE.toUpperCase(), INVITE.slice(1), INVITE + '0',
    'g'.repeat(64), ' ' + INVITE.slice(1), randomBytes(32).toString('base64')]) {
    assert.throws(() => loadConfig({ ...HOSTED_ENV, XYTHUM_HOSTED_INVITE: invite }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /XYTHUM_HOSTED_INVITE/);
      if (invite) assert.ok(!error.message.includes(invite), 'invite value leaked into the error');
      return true;
    });
  }
  for (const name of ['XYTHUM_SESSION_DIR', 'XYTHUM_PROVING_DIR', 'MARKET_WASM', 'PROVER_BIN']) {
    assert.throws(() => loadConfig({ ...HOSTED_ENV, [name]: '' }), new RegExp(name));
    assert.throws(() => loadConfig({ ...HOSTED_ENV, [name]: 'relative/path' }), new RegExp(name));
  }
  // Local mode is unchanged: no invite, repository defaults.
  const plain = loadConfig({});
  assert.equal(plain.hosted, false);
  assert.equal(plain.hostedInvite, null);
  assert.equal(loadConfig({ XYTHUM_HOSTED_INVITE: 'ignored-locally' }).hostedInvite, null);
});

test('invite comparison is exact: shape first, then constant-time bytes', () => {
  const invite = Buffer.from(INVITE, 'hex');
  assert.equal(checkInvite(INVITE, invite), true);
  for (const header of [undefined, '', INVITE.toUpperCase(), INVITE.slice(2), INVITE + 'ab', ' ' + INVITE,
    INVITE + '\n', [INVITE], randomBytes(32).toString('hex')]) {
    assert.equal(checkInvite(header, invite), false, String(header));
  }
});

test('POST /api/sessions rejects missing, malformed and wrong invites before any allocation', async () => {
  const { h, base, logs } = hosted;
  const body = enrollment();
  const wrong = randomBytes(32).toString('hex');
  const attempts = [
    {}, { 'X-Xythum-Invite': '' }, { 'X-Xythum-Invite': INVITE.toUpperCase() },
    { 'X-Xythum-Invite': INVITE.slice(0, 63) }, { 'X-Xythum-Invite': INVITE + '00' },
    { 'X-Xythum-Invite': Buffer.from(INVITE, 'hex').toString('base64') }, { 'X-Xythum-Invite': wrong },
    { Authorization: 'Bearer ' + INVITE },
  ];
  for (const headers of attempts) {
    const response = await create(base, body, headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
    const json = await response.json();
    assert.equal(json.error, 'invite_required');
    assert.ok(!JSON.stringify(json).includes(INVITE));
  }
  // The gate runs before the body is read: no body validation leaks through.
  assert.equal((await create(base, '{', {})).status, 401);
  assert.equal((await create(base, 'x', { 'Content-Type': 'text/plain' })).status, 401);
  // Nothing was reserved, provisioned or charged (cooldown is 60 s hosted).
  assert.equal(h.chain.calls.length, 0);
  assert.equal(h.store.size, 0);
  assert.equal(h.actorCalls.length, 0);

  const created = await create(base, body, { 'X-Xythum-Invite': INVITE });
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal(h.store.size, 1);
  assert.ok(h.chain.calls.length > 0);

  // A retry with the invite returns the same session; without it, nothing.
  const retried = await create(base, body, { 'X-Xythum-Invite': INVITE });
  assert.equal((await retried.json()).session_id, session.session_id);
  assert.equal((await create(base, body)).status, 401);

  // Other session routes keep the per-session bearer and need no invite.
  const fetched = await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + session.session_id } });
  assert.equal(fetched.status, 200);
  assert.equal((await fetch(base + '/api/session', { headers: { 'X-Xythum-Invite': INVITE } })).status, 401);
  assert.equal((await fetch(base + '/api/health')).status, 200);

  assert.ok(!logs.join('\n').includes(INVITE));
  assert.ok(logs.some((line) => /^POST \/api\/sessions 401 \d+ms$/.test(line)));
});

test('local mode needs no invite and ignores the header', async () => {
  const { h, base } = local;
  assert.equal((await create(base, enrollment())).status, 201);
  assert.equal((await create(base, enrollment(), { 'X-Xythum-Invite': 'nonsense' })).status, 201);
  assert.equal(h.store.size, 2);
});

test('hosted responses carry the CSP and framing headers; local responses do not', async () => {
  for (const path of ['/', '/assets/app.js', '/prover/xythum_prover_bg.wasm', '/api/health', '/missing.js']) {
    const response = await fetch(hosted.base + path);
    assert.equal(response.headers.get('content-security-policy'), HOSTED_CSP, path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', path);
    const plain = await fetch(local.base + path);
    assert.equal(plain.headers.get('content-security-policy'), null, path);
    assert.equal(plain.headers.get('x-frame-options'), null, path);
  }
  const directives = Object.fromEntries(HOSTED_CSP.split('; ').map((part) => {
    const [name, ...values] = part.split(' ');
    return [name, values];
  }));
  assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(directives['worker-src'], ["'self'"]);
  assert.deepEqual(directives['connect-src'], ["'self'", 'https://test.rpc.fastnear.com']);
  const explorer = await fetch(hosted.base + '/positions');
  assert.equal(explorer.status, 200);
  assert.equal(explorer.headers.get('content-security-policy'), HOSTED_CSP.replace(
    "connect-src 'self' https://test.rpc.fastnear.com",
    "connect-src 'self' https://test.rpc.fastnear.com https://archival-rpc.testnet.fastnear.com",
  ));
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.ok(!HOSTED_CSP.includes("'unsafe-eval'") && !HOSTED_CSP.includes("'unsafe-inline'"));
  const wasm = await fetch(hosted.base + '/prover/xythum_prover_bg.wasm');
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
});

test('dot paths are never served and never fall back to the app', async () => {
  for (const { base } of [hosted, local]) {
    for (const path of ['/.env', '/.git/config', '/.git', '/.well-known/anything', '/assets/.hidden',
      '/%2eenv']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
      const text = await response.text();
      assert.doesNotMatch(text, /should-never|never served|<title>/, path);
    }
    // Ordinary client routes still get the single-page fallback.
    assert.match(await (await fetch(base + '/trade')).text(), /exchange/);
  }
});
