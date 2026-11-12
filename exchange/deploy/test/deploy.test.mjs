// Offline tests for the Fly deployment package that need no npm dependency.
// No RPC, no credentials, no .env, no Fly API.
//   node --test exchange/deploy/test/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { headroom, sessionCost } from '../check-funds.mjs';
import { inviteSmoke } from '../runtime/invite-smoke.mjs';
import {
  checkRuntimeEnv, clearStaleLock, expectedRuntime, isMountPoint, LaunchError, PROVER_CHILD_ENV, readLock, verifyArtifacts,
} from '../runtime/launch.mjs';
import { APP_FILES, DEPLOY_FILES, promote, readTar, scanStage, stage, StageError } from '../stage.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const tempDir = (prefix) => mkdtemp(join(tmpdir(), prefix));

test('checkRuntimeEnv requires the exact hosted values and caps the quota at 1; no credential checks', () => {
  const env = { ...expectedRuntime('/app'), XYTHUM_SESSION_QUOTA: '1' };
  assert.deepEqual(expectedRuntime('/app'), {
    XYTHUM_ALLOW_HOSTED: '1', XYTHUM_SERVER_HOST: '0.0.0.0', XYTHUM_SERVER_PORT: '8080',
    XYTHUM_SESSION_DIR: '/data/sessions', XYTHUM_PROVING_DIR: join('/app', 'artifacts', 'proving'),
    MARKET_WASM: join('/app', 'artifacts', 'market.wasm'), PROVER_BIN: join('/app', 'bin', 'xythum-prover'),
  });
  // Credentials may come from a mounted XYTHUM_CREDENTIALS_FILE: the launcher
  // must not require any role variable in the environment.
  assert.equal(checkRuntimeEnv(env, '/app'), 1);
  assert.equal(checkRuntimeEnv({ ...env, XYTHUM_CREDENTIALS_FILE: '/run/xythum/credentials.env' }, '/app'), 1);
  assert.equal(checkRuntimeEnv({ ...env, XYTHUM_SESSION_QUOTA: '' }, '/app'), 0);
  assert.throws(() => checkRuntimeEnv({ ...env, XYTHUM_SESSION_QUOTA: '2' }, '/app'), LaunchError);
  assert.throws(() => checkRuntimeEnv({ ...env, XYTHUM_SERVER_HOST: '127.0.0.1' }, '/app'), /XYTHUM_SERVER_HOST/);
  assert.throws(() => checkRuntimeEnv({ ...env, XYTHUM_SESSION_DIR: '/tmp/s' }, '/app'), /XYTHUM_SESSION_DIR/);
  assert.deepEqual(PROVER_CHILD_ENV, {});
});

test('isMountPoint reads the mount point field of mountinfo', () => {
  const info = '22 1 0:21 / / rw - overlay overlay rw\n90 22 253:16 / /data rw,relatime - ext4 /dev/vdb rw\n';
  assert.equal(isMountPoint('/data', info), true);
  assert.equal(isMountPoint('/data/sessions', info), false);
  assert.equal(isMountPoint('/data', '22 1 0:21 / / rw - overlay overlay rw\n'), false);
});

test('clearStaleLock removes a lock naming an unrelated or dead pid, refuses a live coordinator', async () => {
  const dir = await tempDir('xythum-lock-');
  try {
    const lock = join(dir, 'coordinator.lock');
    await writeFile(lock, '1');
    assert.equal(await clearStaleLock(dir, { readCmdline: () => '/fly/init\0' }), 'removed');
    assert.equal(existsSync(lock), false);
    await writeFile(lock, '424242');
    assert.equal(await clearStaleLock(dir, { readCmdline: () => { throw new Error('ENOENT'); } }), 'removed');
    await writeFile(lock, '7');
    await assert.rejects(clearStaleLock(dir, { readCmdline: () => 'node\0/app/exchange/deploy/runtime/launch.mjs\0' }),
      /another coordinator/);
    assert.equal(await clearStaleLock(join(dir, 'none')), 'none');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyArtifacts: runtime checks the dist copy when there is one, staging checks the stage path', async () => {
  const root = await tempDir('xythum-art-');
  try {
    const data = randomBytes(100);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const lock = {
      version: 1,
      artifacts: [
        { id: 'glue', stage: 'exchange/public/prover/x.js', dist: 'exchange/dist/prover/x.js', bytes: 100, sha256 },
        { id: 'pk', stage: 'artifacts/proving/x.pk', bytes: 100, sha256 },
      ],
    };
    // Runtime image layout: no exchange/public at all.
    await mkdir(join(root, 'exchange', 'dist', 'prover'), { recursive: true });
    await mkdir(join(root, 'artifacts', 'proving'), { recursive: true });
    await writeFile(join(root, 'exchange', 'dist', 'prover', 'x.js'), data);
    await writeFile(join(root, 'artifacts', 'proving', 'x.pk'), data);
    assert.deepEqual(await verifyArtifacts({ appRoot: root, lock, where: 'runtime' }),
      ['exchange/dist/prover/x.js', 'artifacts/proving/x.pk']);
    await assert.rejects(verifyArtifacts({ appRoot: root, lock, where: 'stage' }),
      /missing pinned artifact exchange\/public\/prover\/x\.js/);
    // Staging layout: no dist yet.
    await rm(join(root, 'exchange', 'dist'), { recursive: true });
    await mkdir(join(root, 'exchange', 'public', 'prover'), { recursive: true });
    await writeFile(join(root, 'exchange', 'public', 'prover', 'x.js'), data);
    assert.deepEqual(await verifyArtifacts({ appRoot: root, lock, where: 'stage' }),
      ['exchange/public/prover/x.js', 'artifacts/proving/x.pk']);
    await assert.rejects(verifyArtifacts({ appRoot: root, lock, where: 'runtime' }), /missing pinned artifact exchange\/dist/);
    await writeFile(join(root, 'artifacts', 'proving', 'x.pk'), Buffer.concat([data.subarray(0, 99), Buffer.from([data[99] ^ 1])]));
    await assert.rejects(verifyArtifacts({ appRoot: root, lock, where: 'stage' }), /SHA-256 differs/);
    await assert.rejects(verifyArtifacts({ appRoot: root, lock, where: 'both' }), /runtime or stage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifacts.lock.json pins the recorded deployment; the Dockerfile puts dist copies where the runtime looks', async () => {
  const lock = readLock();
  const ids = Object.fromEntries(lock.artifacts.map((a) => [a.id, a]));
  assert.equal(lock.artifacts.length, 7);
  assert.equal(ids['market-wasm'].sha256, '9004770854c3d3a1aa8c71d7a19d258fac568abb41cda1dd2ad1827b5c80db7c');
  for (const id of ['open-pk', 'close-pk', 'liquidation-pk']) assert.match(ids[id].stage, /^artifacts\/proving\/\w+\.pk$/);
  for (const artifact of lock.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
    assert.ok(!artifact.source.includes('..') && !artifact.stage.includes('..'));
    // Runtime image copies only artifacts/ and exchange/dist/ (never exchange/public/).
    if (artifact.stage.startsWith('exchange/public/')) {
      assert.equal(artifact.dist, artifact.stage.replace('exchange/public/', 'exchange/dist/'), artifact.id);
    } else {
      assert.ok(artifact.stage.startsWith('artifacts/') && !artifact.dist, artifact.id);
    }
  }
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
  assert.match(runtime, /COPY --from=web \/app\/exchange\/dist exchange\/dist/);
  assert.match(runtime, /COPY artifacts artifacts/);
  assert.doesNotMatch(runtime, /exchange\/public/);
});

test('readTar parses git archive output and the allowlist is tracked at HEAD', () => {
  const tracked = execFileSync('git', ['ls-files', '--', ...APP_FILES], { cwd: REPO }).toString().split('\n').filter(Boolean);
  assert.deepEqual(tracked.sort(), [...APP_FILES].sort());
  const archive = execFileSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', 'HEAD', '--', 'LICENSE', 'prover/Cargo.toml'], { cwd: REPO });
  const entries = readTar(archive);
  assert.deepEqual(entries.map((e) => e.path), ['LICENSE', 'prover/Cargo.toml']);
  assert.deepEqual(entries[1].data, execFileSync('git', ['cat-file', 'blob', 'HEAD:prover/Cargo.toml'], { cwd: REPO }));
  assert.ok(DEPLOY_FILES.every((file) => file.startsWith('exchange/deploy/')));
  assert.ok(!DEPLOY_FILES.some((file) => /hooks|hosted-env|testnet-client\.hosted/.test(file)), 'shim files are gone');
});

test('scanStage rejects secret-looking content and forbidden paths', async () => {
  const lock = { artifacts: [{ stage: 'artifacts/proving/open.pk' }] };
  const fakeSecret = 'ed25519:' + '1'.repeat(88);
  const cases = [
    ['a.mjs', 'const k = "' + fakeSecret + '";', /ed25519 secret/],
    ['b.txt', 'NEAR_DEMO_SECRET_KEY=ed25519:abcdefghijklmnopqrstuvwxyz', /assigned NEAR secret/],
    ['c.txt', 'https://x.fly.dev/#invite=' + 'a'.repeat(64), /invite URL/],
    ['.env', 'X=1', /forbidden path/],
    ['data/sessions/r.json', '{}', /forbidden path/],
    ['other.pk', 'x', /unpinned proving key/],
  ];
  for (const [file, content, expected] of cases) {
    const dir = await tempDir('xythum-scan-');
    try {
      await mkdir(join(dir, file, '..'), { recursive: true });
      await writeFile(join(dir, file), content);
      await assert.rejects(scanStage(dir, lock), (error) => error instanceof StageError && expected.test(error.message));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('invite smoke passes against the real exchange/server createApp', async () => {
  assert.deepEqual(await inviteSmoke(REPO), { refused: 6, admitted: 1 });
});

test('invite smoke fails a server tree whose POST /api/sessions is ungated', async () => {
  const root = await tempDir('xythum-ungated-');
  try {
    const server = join(root, 'exchange', 'server');
    await mkdir(server, { recursive: true });
    for (const file of ['config.mjs', 'util.mjs']) await copyFile(join(REPO, 'exchange', 'server', file), join(server, file));
    await writeFile(join(server, 'app.mjs'), [
      'export const INVITE_HEADER = "x-xythum-invite";',
      'export function createApp({ coordinator }) {',
      '  return async (req, res) => {',
      '    for await (const chunk of req) void chunk;',
      '    await coordinator.createSession({ smoke: true });',
      '    res.writeHead(201, { "content-type": "application/json" }); res.end("{}");',
      '  };',
      '}',
    ].join('\n'));
    await assert.rejects(inviteSmoke(root), /missing invite got HTTP 201/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('promote replaces an earlier context only as a whole', async () => {
  const dir = await tempDir('xythum-promote-');
  try {
    const [out, scratch, backup] = ['out', 'scratch', 'backup'].map((name) => join(dir, name));
    await mkdir(scratch);
    await writeFile(join(scratch, 'v'), '1');
    await promote(scratch, out, backup, false);
    assert.equal(await readFile(join(out, 'v'), 'utf8'), '1');
    await mkdir(scratch);
    await writeFile(join(scratch, 'v'), '2');
    await promote(scratch, out, backup, true);
    assert.equal(await readFile(join(out, 'v'), 'utf8'), '2');
    assert.deepEqual((await readdir(dir)).sort(), ['out']);
    // A failed swap (scratch missing) restores the earlier context.
    await assert.rejects(promote(join(dir, 'gone'), out, backup, true));
    assert.equal(await readFile(join(out, 'v'), 'utf8'), '2');
    assert.deepEqual((await readdir(dir)).sort(), ['out']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing stage leaves an earlier valid context untouched and no scratch behind', async () => {
  const dir = await tempDir('xythum-stage-');
  try {
    // An earlier context (marker + manifest), and a --source without the artifacts.
    const out = join(dir, 'fly-stage');
    await mkdir(out);
    await writeFile(join(out, '.xythum-fly-stage'), 'x');
    await writeFile(join(out, 'STAGE-MANIFEST.json'), '{"previous":true}');
    const source = join(dir, 'source');
    await mkdir(source);
    execFileSync('git', ['init', '-q'], { cwd: source });
    await assert.rejects(stage({ out, source, testDeployFromWorktree: true }),
      (error) => error instanceof StageError && /missing public artifact target\/near\/xythum_near_perps\.wasm/.test(error.message));
    assert.equal(await readFile(join(out, 'STAGE-MANIFEST.json'), 'utf8'), '{"previous":true}');
    assert.deepEqual((await readdir(dir)).sort(), ['fly-stage', 'source']);
    // A foreign non-empty --out is refused before anything is written.
    const foreign = join(dir, 'foreign');
    await mkdir(foreign);
    await writeFile(join(foreign, 'keep'), 'x');
    await assert.rejects(stage({ out: foreign, source, testDeployFromWorktree: true }), /not created by stage\.mjs/);
    assert.deepEqual(await readdir(foreign), ['keep']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stage refuses a commit without exchange/deploy unless the test-only flag is given', async () => {
  const dir = await tempDir('xythum-stage-ref-');
  try {
    const source = join(dir, 'source');
    await mkdir(source);
    execFileSync('git', ['init', '-q'], { cwd: source });
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'exchange/deploy/runtime/launch.mjs'], { cwd: REPO })
      .toString().trim();
    if (tracked) return; // the package is committed: nothing to refuse
    await assert.rejects(stage({ out: join(dir, 'out'), source }), /deploy files are not tracked/);
    assert.equal(existsSync(join(dir, 'out')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-funds headroom mirrors the coordinator preflight', () => {
  const { near, cents } = sessionCost();
  assert.equal(cents, 120_100n);
  const reserve = 10n ** 24n;
  const enough = headroom({ amount: String(reserve + near), storageUsage: 0, rootCents: 120_100, makerCents: 0 });
  assert.equal(enough.sessions, 1n);
  const short = headroom({ amount: String(reserve + near - 1n), storageUsage: 0, rootCents: 120_100, makerCents: 0 });
  assert.equal(short.sessions, 0n);
  const makerFunded = headroom({ amount: String(reserve + 3n * near), storageUsage: 0, rootCents: 60_000, makerCents: 60_100 });
  assert.equal(makerFunded.sessions, 1n);
});
