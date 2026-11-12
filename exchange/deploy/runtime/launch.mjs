// Container entrypoint for the hosted (Fly) session coordinator.
//
//   node exchange/deploy/runtime/launch.mjs              start the coordinator
//   node exchange/deploy/runtime/launch.mjs --self-check offline image check (no secrets, no network)
//
// Order of a real start:
//  1. As root only: require /data to be a mounted volume, create
//     /data/sessions (0700) owned by the app user, then permanently drop to it.
//  2. Require the fixed hosted runtime values (fly.toml [env]) and a quota of 0..1.
//  3. Re-hash every pinned public artifact at its runtime path.
//  4. Clear a coordinator.lock left by a previous boot of this Machine.
//  5. Load exchange/server/server.mjs unmodified. The server itself requires
//     the invite, loads the hosted role credentials (environment or
//     XYTHUM_CREDENTIALS_FILE), scrubs them from process.env, and only then
//     starts child processes. This launcher never reads or validates them.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { chmod, lchown, lstat, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inviteSmoke } from './invite-smoke.mjs';

export const APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const LOCK_FILE = fileURLToPath(new URL('../artifacts.lock.json', import.meta.url));
export const DATA_ROOT = '/data';
export const SESSION_DIR = '/data/sessions';
export const APP_UID = 10001;
export const APP_GID = 10001;
export const PORT = '8080';
export const MAX_HOSTED_QUOTA = 1;
// The self-check's native prover child gets this environment and nothing else.
export const PROVER_CHILD_ENV = Object.freeze({});

const log = (line) => console.log(new Date().toISOString() + ' launch: ' + line);

export class LaunchError extends Error {}

export function expectedRuntime(appRoot = APP_ROOT) {
  return Object.freeze({
    XYTHUM_ALLOW_HOSTED: '1',
    XYTHUM_SERVER_HOST: '0.0.0.0',
    XYTHUM_SERVER_PORT: PORT,
    XYTHUM_SESSION_DIR: SESSION_DIR,
    XYTHUM_PROVING_DIR: join(appRoot, 'artifacts', 'proving'),
    MARKET_WASM: join(appRoot, 'artifacts', 'market.wasm'),
    PROVER_BIN: join(appRoot, 'bin', 'xythum-prover'),
  });
}

// Non-secret runtime values only; credentials are the server's job.
export function checkRuntimeEnv(env, appRoot = APP_ROOT) {
  for (const [key, value] of Object.entries(expectedRuntime(appRoot))) {
    if (env[key] !== value) throw new LaunchError(key + ' must be ' + value + ' on the hosted machine');
  }
  const quota = env.XYTHUM_SESSION_QUOTA ?? '';
  if (!/^\d*$/.test(quota) || Number(quota || 0) > MAX_HOSTED_QUOTA) {
    throw new LaunchError('XYTHUM_SESSION_QUOTA must be 0..' + MAX_HOSTED_QUOTA + ' for this hosted package');
  }
  return Number(quota || 0);
}

export function readLock(file = LOCK_FILE) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  if (lock.version !== 1 || !Array.isArray(lock.artifacts)) throw new LaunchError('unsupported artifacts.lock.json');
  return lock;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const inside = (root, path) => resolve(path).startsWith(resolve(root) + sep);

// Where each pinned artifact lives. In the staging context: `stage`. In the
// runtime image: `dist` when the artifact has one (the browser prover files
// exist only in the Vite build output there), otherwise `stage`.
export const artifactPath = (artifact, where) => (where === 'runtime' && artifact.dist ? artifact.dist : artifact.stage);

// Every pinned artifact must be a regular file with the exact size and SHA-256.
export async function verifyArtifacts({ appRoot = APP_ROOT, lock = readLock(), where = 'runtime' } = {}) {
  if (where !== 'runtime' && where !== 'stage') throw new LaunchError('verifyArtifacts: where must be runtime or stage');
  const checked = [];
  for (const artifact of lock.artifacts) {
    const rel = artifactPath(artifact, where);
    const path = join(appRoot, rel);
    if (!inside(appRoot, path)) throw new LaunchError('artifact path escapes the app root: ' + rel);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new LaunchError('missing pinned artifact ' + rel);
    if (info.size !== artifact.bytes) throw new LaunchError(rel + ' has ' + info.size + ' bytes, pinned ' + artifact.bytes);
    if (await sha256File(path) !== artifact.sha256) throw new LaunchError(rel + ' SHA-256 differs from artifacts.lock.json');
    checked.push(rel);
  }
  return checked;
}

export function isMountPoint(path, mountinfo = readFileSync('/proc/self/mountinfo', 'utf8')) {
  // Field 5 of each mountinfo line is the mount point (octal-escaped).
  return mountinfo.split('\n').some((line) => line.split(' ')[4] === path);
}

async function chownTree(path, uid, gid) {
  const info = await lstat(path);
  await lchown(path, uid, gid);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(path)) await chownTree(join(path, name), uid, gid);
  }
}

// Root phase: prepare the volume, then drop privileges for good.
export async function prepareVolumeAndDrop() {
  if (!isMountPoint(DATA_ROOT)) {
    throw new LaunchError(DATA_ROOT + ' is not a mounted volume; refusing to keep sessions on the ephemeral root filesystem');
  }
  await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  const info = await lstat(SESSION_DIR);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LaunchError(SESSION_DIR + ' must be a real directory');
  await chownTree(SESSION_DIR, APP_UID, APP_GID);
  await chmod(SESSION_DIR, 0o700);
  process.setgroups([]);
  process.setgid(APP_GID);
  process.setuid(APP_UID);
  let regained = false;
  try {
    process.setuid(0);
    regained = true;
  } catch {
    // expected: root cannot be regained
  }
  if (regained || process.getuid() !== APP_UID || process.geteuid() !== APP_UID || process.getegid() !== APP_GID) {
    throw new LaunchError('failed to drop root privileges');
  }
}

// The store refuses to start while coordinator.lock names a live pid. After a
// machine restart that pid can belong to an unrelated process, so remove the
// lock unless it names another live coordinator in this machine. This is NOT
// a cross-machine guard: one Machine per volume is enforced by deployment.
export async function clearStaleLock(dir = SESSION_DIR, { readCmdline = (pid) => readFileSync('/proc/' + pid + '/cmdline', 'utf8') } = {}) {
  const lock = join(dir, 'coordinator.lock');
  if (!existsSync(lock)) return 'none';
  const pid = Number((await readFile(lock, 'utf8')).trim());
  if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
    let cmdline = '';
    try {
      cmdline = readCmdline(pid);
    } catch {
      // not running
    }
    if (/exchange[\\/](?:server[\\/]server|deploy[\\/]runtime[\\/]launch)\.mjs/.test(cmdline.replaceAll('\0', ' '))) {
      throw new LaunchError('another coordinator (pid ' + pid + ') is running on this volume');
    }
  }
  await unlink(lock);
  return 'removed';
}

function proverFingerprints(appRoot) {
  const result = spawnSync(join(appRoot, 'bin', 'xythum-prover'), ['keys', join(appRoot, 'artifacts', 'proving')], {
    env: PROVER_CHILD_ENV, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new LaunchError('xythum-prover keys failed: ' + result.stderr.trim().slice(-300));
  const keys = JSON.parse(result.stdout);
  return { open: keys.open_vk_sha256, liquidation: keys.liquidation_vk_sha256, close: keys.close_vk_sha256 };
}

// The server's own hosted loader must refuse an incomplete environment and
// scrub every secret variable from it either way. Synthetic values only.
export async function checkCredentialHandoff(appRoot) {
  const { takeCredentials, HOSTED_SCRUBBED } = await import(pathToFileURL(join(appRoot, 'exchange', 'server', 'testnet.mjs')).href);
  if (typeof takeCredentials !== 'function' || !Array.isArray(HOSTED_SCRUBBED)) {
    throw new LaunchError('exchange/server/testnet.mjs has no hosted takeCredentials');
  }
  const env = { XYTHUM_HOSTED_INVITE: 'self-check', NEAR_DEMO_SECRET_KEY: 'self-check', NEAR_TRADER_SECRET_KEY: 'self-check' };
  let loaded = true;
  try {
    takeCredentials({ hosted: true, env });
  } catch {
    loaded = false;
  }
  if (loaded) throw new LaunchError('hosted credential loader accepted an incomplete environment');
  if (Object.keys(env).length !== 0) throw new LaunchError('hosted credential loader left secret variables in the environment');
}

// Offline image check run during `docker build` as the app user.
export async function selfCheck(appRoot = APP_ROOT) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 12) throw new LaunchError('Node 22.12+ (22.x) required, got ' + process.versions.node);
  if (process.getuid?.() === 0) throw new LaunchError('self-check must run as the non-root app user');
  if (existsSync(join(appRoot, '.env'))) throw new LaunchError('the image must not contain a .env');
  const lock = readLock();
  const checked = await verifyArtifacts({ appRoot, lock, where: 'runtime' });
  const { PINNED_VK_FINGERPRINTS } = await import(pathToFileURL(join(appRoot, 'exchange', 'server', 'config.mjs')).href);
  const derived = proverFingerprints(appRoot);
  for (const kind of ['open', 'liquidation', 'close']) {
    if (derived[kind] !== lock.vk_fingerprints[kind] || derived[kind] !== PINNED_VK_FINGERPRINTS[kind]) {
      throw new LaunchError(kind + ' verifying key re-derived by the Linux prover differs from the pins');
    }
  }
  await inviteSmoke(appRoot);
  await checkCredentialHandoff(appRoot);
  log('self-check ok: ' + checked.length + ' pinned files, VK fingerprints match, invite gate refuses before the '
    + 'coordinator, hosted credential loader scrubs');
}

export async function start(env = process.env) {
  if (process.platform !== 'linux') throw new LaunchError('the hosted launcher runs only inside the Linux image');
  if (process.getuid() === 0) await prepareVolumeAndDrop();
  else if (!isMountPoint(DATA_ROOT)) throw new LaunchError(DATA_ROOT + ' is not a mounted volume');
  if (process.getuid() === 0) throw new LaunchError('refusing to run the coordinator as root');
  const quota = checkRuntimeEnv(env);
  const lock = readLock();
  await verifyArtifacts({ lock, where: 'runtime' });
  if (env.XYTHUM_MARKET_WASM_SHA256 !== lock.artifacts.find((a) => a.id === 'market-wasm').sha256) {
    throw new LaunchError('XYTHUM_MARKET_WASM_SHA256 must pin the locked market Wasm');
  }
  log('lock: ' + await clearStaleLock());
  log('starting coordinator as uid ' + process.getuid() + ' (quota ' + quota + ')');
  await import(pathToFileURL(join(APP_ROOT, 'exchange', 'server', 'server.mjs')).href);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const task = process.argv.includes('--self-check') ? selfCheck() : start();
  task.catch((error) => {
    // Launch errors never carry secret values; others are truncated.
    log('failed: ' + String(error?.message ?? error).slice(0, 300));
    process.exit(1);
  });
}
