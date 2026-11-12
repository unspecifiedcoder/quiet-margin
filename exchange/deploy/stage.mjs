#!/usr/bin/env node
// Builds the sanitized Docker/Fly build context for the hosted coordinator.
// It never uploads, deploys, or reads .env, session, keeper or witness files.
//
//   node exchange/deploy/stage.mjs [--ref <git ref>] [--source <worktree>]
//        [--out <dir>] [--app <new-fly-app>] [--test-deploy-from-worktree]
//
// The context contains exactly:
//  - an explicit allowlist of tracked files at one commit, extracted from
//    `git archive <commit> -- <allowlist>` (the archive must hold exactly the
//    allowlist, nothing else);
//  - the PUBLIC artifacts pinned in exchange/deploy/artifacts.lock.json
//    (market Wasm, open/close/liquidation .pk, browser prover Wasm glue),
//    copied from --source by these exact paths only, size and SHA-256 checked;
//  - Dockerfile and fly.toml at the context root.
// Then it cross-checks the pins against the repository, runs the offline
// invite smoke check (runtime/invite-smoke.mjs) against the staged server code
// in a child with a minimal environment, and scans the result for anything
// secret-looking. Everything is built in a scratch directory next to --out and
// only promoted over --out after every check passed, so a failed run leaves
// any earlier valid context untouched.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MARKER = '.xythum-fly-stage';
const INVITE_KEY = 'XYTHUM_HOSTED_INVITE';
const SMOKE = 'exchange/deploy/runtime/invite-smoke.mjs';

// Tracked files the image needs, at the chosen commit.
export const APP_FILES = Object.freeze([
  'LICENSE', 'package.json', 'package-lock.json',
  'scripts/testnet-client.mjs', 'tests/actor.mjs',
  'exchange/package.json', 'exchange/package-lock.json', 'exchange/index.html', 'exchange/vite.config.js',
  'prover/Cargo.toml', 'prover/Cargo.lock',
  // Declared [[bin]] of prover/Cargo.toml; cargo refuses a manifest whose bin path is missing.
  'prover/browser/keys.rs',
]);
export const APP_TREES = Object.freeze(['exchange/src', 'exchange/server', 'prover/src']);
export const TREE_EXCLUDES = Object.freeze(['exchange/src/protocol/test/', 'exchange/server/test/']);
export const DEPLOY_FILES = Object.freeze([
  'exchange/deploy/Dockerfile', 'exchange/deploy/fly.toml', 'exchange/deploy/artifacts.lock.json',
  'exchange/deploy/runtime/launch.mjs', SMOKE,
]);
// Read at the commit for cross-checks only (not staged).
const CHECK_FILES = Object.freeze(['docs/TESTNET-ADDRESSES.md', 'rust-toolchain.toml']);

export class StageError extends Error {}

const inside = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
    cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...options,
  });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Minimal reader for `git archive --format=tar`: regular files, directories,
// pax global ('g', git's commit comment) and pax extended ('x') headers.
// Anything else (symlinks, devices, hard links) is rejected.
export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let paxPath = null;
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156] || 48);
    const prefix = field(block, 345, 155);
    const name = (prefix ? prefix + '/' : '') + field(block, 0, 100);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      for (const record of body.toString('utf8').split('\n')) {
        const match = /^\d+ path=(.*)$/s.exec(record);
        if (match) paxPath = match[1];
      }
      continue;
    }
    const path = paxPath ?? name;
    paxPath = null;
    if (type === '5') continue;
    if (type !== '0') throw new StageError('archive entry ' + path + ' has unsupported type ' + JSON.stringify(type));
    entries.push({ path, data: Buffer.from(body) });
  }
  return entries;
}

function safeRelative(path) {
  const clean = normalize(path).split(sep).join('/');
  if (isAbsolute(path) || clean.startsWith('../') || clean === '..' || clean.includes('/../') || clean.startsWith('/')) {
    throw new StageError('unsafe path ' + path);
  }
  return clean;
}

async function writeStaged(out, rel, data) {
  const target = join(out, safeRelative(rel));
  if (!inside(out, target)) throw new StageError('path escapes the staging directory: ' + rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
}

// --out (and the scratch/backup siblings used to replace it) must be outside
// every relevant Git worktree, or ignored by it. An existing --out must be
// empty or a previous stage. Nothing is deleted here.
async function checkOut(paths, out, roots) {
  for (const path of paths) {
    for (const root of roots) {
      if (inside(path, root)) throw new StageError('--out must not contain ' + root);
      if (inside(root, path)) {
        const rel = relative(root, path).split(sep).join('/');
        try {
          git(root, ['check-ignore', '-q', '--', rel + '/'], { stdio: 'ignore' });
        } catch {
          throw new StageError(path + ' is inside ' + root + ' but not ignored by Git');
        }
      }
    }
  }
  for (const path of paths.filter((p) => p !== out)) {
    if (existsSync(path)) throw new StageError(path + ' already exists');
  }
  if (!existsSync(out)) return false;
  const info = await lstat(out);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StageError('--out exists and is not a directory');
  const names = await readdir(out);
  if (names.length > 0 && !names.includes(MARKER)) {
    throw new StageError('--out is not empty and was not created by stage.mjs; refusing to replace it');
  }
  return true;
}

// Swap the fully checked scratch context in for --out.
export async function promote(scratch, out, backup, replace) {
  if (!replace) {
    await mkdir(dirname(out), { recursive: true });
    await rename(scratch, out);
    return;
  }
  await rename(out, backup);
  try {
    await rename(scratch, out);
  } catch (error) {
    await rename(backup, out);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

// Behavioral check of the staged server's invite gate, in a child that sees
// no credentials (only what Windows needs to open a loopback socket).
function runInviteSmoke(dir) {
  const env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  try {
    return execFileSync(process.execPath, [join(dir, SMOKE), dir], {
      cwd: dir, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
  } catch (error) {
    throw new StageError('staged server failed the invite smoke check: '
      + String(error.stderr || error.message).trim().slice(0, 300));
  }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new StageError('unexpected symlink ' + relative(base, path));
    if (entry.isDirectory()) out.push(...await walk(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'));
    else throw new StageError('unexpected special file ' + relative(base, path));
  }
  return out;
}

// Copy one pinned public artifact by exact path; verify before and after.
async function copyArtifact(source, sourceReal, out, artifact) {
  const from = join(source, artifact.source);
  const info = await lstat(from).catch(() => null);
  if (!info) throw new StageError('missing public artifact ' + artifact.source + ' under --source');
  if (!info.isFile() || info.isSymbolicLink()) throw new StageError(artifact.source + ' must be a regular file');
  if (!inside(sourceReal, await realpath(from))) throw new StageError(artifact.source + ' resolves outside --source');
  if (info.size !== artifact.bytes) {
    throw new StageError(artifact.source + ' is ' + info.size + ' bytes; artifacts.lock.json pins ' + artifact.bytes);
  }
  if (await sha256File(from) !== artifact.sha256) throw new StageError(artifact.source + ' SHA-256 differs from artifacts.lock.json');
  const to = join(out, safeRelative(artifact.stage));
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  if (await sha256File(to) !== artifact.sha256) throw new StageError('copy of ' + artifact.source + ' does not match its pin');
}

const SECRET_PATTERNS = [
  [/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/, 'NEAR ed25519 secret key'],
  [/secp256k1:[1-9A-HJ-NP-Za-km-z]{60,}/, 'NEAR secp256k1 key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/\bNEAR_[A-Z0-9_]*SECRET[A-Z0-9_]*\s*=\s*["']?[A-Za-z0-9+/:=_-]{16,}/, 'assigned NEAR secret'],
  [new RegExp('\\b' + INVITE_KEY + '\\s*[=:]\\s*["\']?[0-9a-fA-F]{64}'), 'invite secret value'],
  [/[?#&]invite=[0-9a-fA-F]{64}/, 'invite URL'],
];
const FORBIDDEN_NAME = /(^|\/)(\.env(\..*)?|\.git|\.testnet|node_modules|sessions|keeper|keys|target)(\/|$)|\.witness\.json$|\.keeper-keys\.json$|\.vk$|\.pem$|\.key$|(^|\/)keeper\.json$|coordinator\.lock$/;

export async function scanStage(out, lock) {
  const allowedPk = new Set(lock.artifacts.filter((a) => a.stage.endsWith('.pk')).map((a) => a.stage));
  const binary = new Set(lock.artifacts.map((a) => a.stage));
  const files = await walk(out);
  for (const file of files) {
    if (FORBIDDEN_NAME.test(file)) throw new StageError('forbidden path in staging context: ' + file);
    if (file.endsWith('.pk') && !allowedPk.has(file)) throw new StageError('unpinned proving key in staging context: ' + file);
    if (binary.has(file)) continue;
    const text = await readFile(join(out, file), 'utf8');
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(text)) throw new StageError(what + ' pattern found in ' + file);
    }
  }
  return files;
}

function crossCheck({ lock, staged, checks }) {
  const pin = (id) => lock.artifacts.find((a) => a.id === id).sha256;
  const pins = staged.get('exchange/src/protocol/prover-pins.js').toString('utf8');
  for (const [kind, id] of [['open', 'open-pk'], ['close', 'close-pk']]) {
    const match = new RegExp('\\b' + kind + ":\\s*'([0-9a-f]{64})'").exec(pins);
    if (match?.[1] !== pin(id)) throw new StageError('prover-pins.js ' + kind + ' pin differs from artifacts.lock.json');
  }
  const config = staged.get('exchange/server/config.mjs').toString('utf8');
  for (const [kind, value] of Object.entries(lock.vk_fingerprints)) {
    if (!config.includes(kind + ": '" + value + "'")) throw new StageError('config.mjs ' + kind + ' VK fingerprint differs from the lock');
  }
  if (!checks.get('docs/TESTNET-ADDRESSES.md').toString('utf8').includes('Clearing Wasm SHA-256 `' + pin('market-wasm') + '`')) {
    throw new StageError('market Wasm pin is not the recorded clearing Wasm in docs/TESTNET-ADDRESSES.md');
  }
  if (!/channel\s*=\s*"1\.95\.0"/.test(checks.get('rust-toolchain.toml').toString('utf8'))) {
    throw new StageError('rust-toolchain.toml is no longer 1.95.0; update the Dockerfile Rust image');
  }
  for (const file of ['exchange/deploy/Dockerfile', 'exchange/deploy/fly.toml']) {
    if (!staged.get(file).toString('utf8').includes(pin('market-wasm'))) {
      throw new StageError(file + ' does not pin XYTHUM_MARKET_WASM_SHA256 to the locked market Wasm');
    }
  }
}


// Builds into a fresh scratch directory beside --out and promotes it only
// after every check passed. On any failure the scratch directory is removed
// and an earlier context at --out is left exactly as it was.
export async function stage(options) {
  const repo = git(SCRIPT_DIR, ['rev-parse', '--show-toplevel']).toString().trim();
  const out = resolve(options.out ?? join(repo, 'target', 'fly-stage'));
  const source = resolve(options.source ?? repo);
  if (options.app !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.app)) {
    throw new StageError('--app must be a lowercase Fly app name');
  }
  let sourceRoot;
  try {
    sourceRoot = git(source, ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    throw new StageError('--source ' + source + ' is not inside a Git worktree');
  }
  const suffix = process.pid + '-' + randomBytes(4).toString('hex');
  const scratch = join(dirname(out), '.' + basename(out) + '.scratch-' + suffix);
  const backup = join(dirname(out), '.' + basename(out) + '.previous-' + suffix);
  const replace = await checkOut([out, scratch, backup], out, [...new Set([resolve(repo), resolve(sourceRoot)])]);
  let result;
  try {
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, MARKER), 'xythum fly staging context; safe to delete\n', { flag: 'wx' });
    result = await build(options, repo, source, scratch);
    if (options.beforePromote) await options.beforePromote(scratch); // tests only
    // Re-check --out right before replacing it.
    if (await checkOut([out], out, []) !== replace) throw new StageError('--out changed while staging');
    await promote(scratch, out, backup, replace);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  return { ...result, out };
}

async function build(options, repo, source, out) {
  const sourceReal = await realpath(source);
  const commit = git(repo, ['rev-parse', '--verify', '--end-of-options', (options.ref ?? 'HEAD') + '^{commit}']).toString().trim();

  // 1. Exact tracked blobs at the commit, through git archive.
  const deployAtRef = git(repo, ['ls-tree', '-r', '--name-only', commit, '--', 'exchange/deploy']).toString().split('\n').filter(Boolean);
  // Test only: take exchange/deploy from this checkout (before it is committed).
  const deployFromWorktree = options.testDeployFromWorktree === true;
  if (!deployFromWorktree) {
    const missing = DEPLOY_FILES.filter((file) => !deployAtRef.includes(file));
    if (missing.length) {
      throw new StageError('deploy files are not tracked at ' + commit.slice(0, 12) + ' (' + missing.join(', ')
        + '); stage a commit that contains exchange/deploy');
    }
  }
  const treeFiles = git(repo, ['ls-tree', '-r', '--name-only', commit, '--', ...APP_TREES]).toString().split('\n')
    .filter(Boolean).filter((file) => !TREE_EXCLUDES.some((prefix) => file.startsWith(prefix)));
  const wanted = [...APP_FILES, ...treeFiles, ...(deployFromWorktree ? [] : DEPLOY_FILES)];
  const archive = git(repo, ['archive', '--format=tar', commit, '--', ...wanted]);
  const entries = readTar(archive);
  const got = new Set(entries.map((entry) => entry.path));
  const missing = wanted.filter((file) => !got.has(file));
  const extra = [...got].filter((file) => !wanted.includes(file));
  if (missing.length || extra.length) {
    throw new StageError('git archive does not match the allowlist (missing: ' + missing.join(', ') + '; extra: ' + extra.join(', ') + ')');
  }
  const staged = new Map(entries.map(({ path, data }) => [path, data]));
  let worktreeDirty = null;
  if (deployFromWorktree) {
    for (const file of DEPLOY_FILES) {
      const path = join(repo, file);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) throw new StageError(file + ' must be a regular file');
      staged.set(file, await readFile(path));
    }
    worktreeDirty = git(repo, ['status', '--porcelain', '--', 'exchange/deploy']).toString().trim() !== '';
  }
  for (const [path, data] of staged) await writeStaged(out, path, data);
  const checks = new Map(CHECK_FILES.map((file) => [file, git(repo, ['cat-file', 'blob', commit + ':' + file])]));

  const lock = JSON.parse(staged.get('exchange/deploy/artifacts.lock.json').toString('utf8'));
  if (lock.version !== 1) throw new StageError('unsupported artifacts.lock.json');

  // 2. Consistency of pins across the repository.
  crossCheck({ lock, staged, checks });

  // 3. The staged server's invite gate, exercised over HTTP (no RPC, no credentials).
  const inviteSmoke = runInviteSmoke(out);

  // 4. Pinned public artifacts from --source: exactly the lock's paths; nothing else there is opened or listed.
  for (const artifact of lock.artifacts) await copyArtifact(source, sourceReal, out, artifact);

  // 5. Context root: Dockerfile and fly.toml (app name filled in).
  await writeStaged(out, 'Dockerfile', staged.get('exchange/deploy/Dockerfile'));
  let fly = staged.get('exchange/deploy/fly.toml').toString('utf8');
  if (options.app) fly = fly.replace('app = "REPLACE-WITH-NEW-FLY-APP"', 'app = "' + options.app + '"');
  await writeStaged(out, 'fly.toml', fly);

  // 6. Sanitization scan and manifest.
  const files = await scanStage(out, lock);
  const listed = [];
  for (const file of files.filter((name) => name !== MARKER).sort()) {
    const info = await lstat(join(out, file));
    listed.push({ path: file, bytes: info.size, sha256: await sha256File(join(out, file)) });
  }
  const manifest = {
    commit, ref: options.ref ?? 'HEAD', app: options.app ?? null,
    deploy_files_from: deployFromWorktree ? 'worktree (TEST ONLY - do not deploy)' : 'commit',
    deploy_worktree_dirty: worktreeDirty, invite_smoke: inviteSmoke,
    node: process.version, created_at: new Date().toISOString(),
    total_bytes: listed.reduce((sum, file) => sum + file.bytes, 0), files: listed,
  };
  await writeFile(join(out, 'STAGE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { manifest, sha: sha256(JSON.stringify(listed)) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      ref: { type: 'string' }, source: { type: 'string' }, out: { type: 'string' }, app: { type: 'string' },
      'test-deploy-from-worktree': { type: 'boolean' }, help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    console.log('usage: node exchange/deploy/stage.mjs [--ref <ref>] [--source <worktree>] [--out <dir>] [--app <name>] '
      + '[--test-deploy-from-worktree]');
    return;
  }
  const { out, manifest, sha } = await stage({
    ref: values.ref, source: values.source, out: values.out, app: values.app,
    testDeployFromWorktree: values['test-deploy-from-worktree'],
  });
  const mb = (manifest.total_bytes / 1e6).toFixed(1);
  console.log('staged ' + manifest.files.length + ' files (' + mb + ' MB) at ' + manifest.commit.slice(0, 12) + ' into ' + out);
  console.log('deploy files from ' + manifest.deploy_files_from + (manifest.deploy_worktree_dirty ? ' (UNCOMMITTED changes)' : ''));
  console.log(manifest.invite_smoke);
  console.log('context digest ' + sha.slice(0, 16) + '; app: ' + (manifest.app ?? 'not set (pass --app or edit fly.toml)'));
  console.log('nothing was uploaded. Next: docs/HOSTING.md');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('stage: ' + (error instanceof StageError ? error.message : (error?.stack ?? error)));
    process.exit(1);
  });
}
