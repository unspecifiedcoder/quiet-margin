// Asynchronous wrapper around the repository keeper actor (tests/actor.mjs).
// Each invocation gets a fresh temporary keeper file holding only the secrets
// that keeper needs, so the HTTP event loop never blocks on proving and an
// acknowledgment actor never sees the other keeper's keys.
import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { safeMessage } from './util.mjs';

const ACTOR = fileURLToPath(new URL('../../tests/actor.mjs', import.meta.url));
const CHILD_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'PROVER_BIN'];
const RUN_PREFIX = 'run-';
const SID = /^S-1-[0-9-]+$/;

export class ActorError extends Error {}

const execText = async (file, args, options) => (await promisify(execFile)(file, args,
  { windowsHide: true, timeout: 30_000, ...options })).stdout;

// Absolute System32 paths, so a PATH entry (e.g. Git Bash coreutils) can
// neither shadow nor impersonate the ACL tools.
const system32 = () => join(process.env.SystemRoot || 'C:\\Windows', 'System32');
export const WINDOWS_TOOLS = Object.freeze({
  get whoami() { return join(system32(), 'whoami.exe'); },
  get icacls() { return join(system32(), 'icacls.exe'); },
});

// Parses the DACL of an SDDL string and accepts it only if it is protected
// (no inherited ACEs) and every ACE is an allow ACE for `sid`.
export function isOwnerOnlySddl(sddl, sid) {
  const match = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!match || !match[1].includes('P')) return false;
  const aces = [...match[2].matchAll(/\(([^)]*)\)/g)].map(([, ace]) => ace.split(';'));
  return aces.length > 0 && aces.every((ace) => ace.length === 6 && ace[0] === 'A' && ace[5] === sid);
}

async function currentSid(exec) {
  const line = (await exec(WINDOWS_TOOLS.whoami, ['/user', '/fo', 'csv', '/nh'])).trim();
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(line)?.[1];
  if (!sid || !SID.test(sid)) throw new Error('could not determine the current Windows user SID');
  return sid;
}

// Makes `dir` a directory that only the current user can open, then verifies
// that by reading the ACL back. On Windows the POSIX mode is ignored, so the
// DACL is replaced with a single inheritable full-control ACE for the current
// user and checked through its SDDL. Throws if the check fails.
export async function securePrivateDir(dir, { platform = process.platform, exec = execText } = {}) {
  const path = resolve(dir);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('keeper directory must be a real directory');
  if (platform === 'win32') {
    const sid = await currentSid(exec);
    await exec(WINDOWS_TOOLS.icacls, [path, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '/q']);
    // Read the ACL back as SDDL (icacls /save writes UTF-16LE: name, then SDDL).
    // The save file holds only the ACL, never a secret.
    const out = await mkdtemp(join(tmpdir(), 'xythum-acl-'));
    let sddl;
    try {
      const file = join(out, 'acl.txt');
      await exec(WINDOWS_TOOLS.icacls, [path, '/save', file, '/q']);
      const lines = (await readFile(file)).toString('utf16le').replace(/^﻿/, '').split(/\r?\n/);
      sddl = lines.find((line) => line.startsWith('D:')) ?? '';
    } finally {
      await rm(out, { recursive: true, force: true });
    }
    if (!isOwnerOnlySddl(sddl, sid)) throw new Error('keeper directory ACL is not restricted to the current user');
  } else {
    await chmod(path, 0o700);
    const checked = await lstat(path);
    if ((checked.mode & 0o077) !== 0 || (process.getuid && checked.uid !== process.getuid())) {
      throw new Error('keeper directory must be owned by and private to the current user');
    }
  }
  // Remove keeper files left by a run that crashed before its cleanup.
  for (const name of await readdir(path)) {
    if (name.startsWith(RUN_PREFIX)) await rm(join(path, name), { recursive: true, force: true });
  }
  return path;
}

// The only variables a child process (actor or native prover) inherits.
export const childEnv = (source = process.env) => Object.fromEntries(CHILD_ENV
  .filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));

export function runActor(command, input, { timeoutMs = 130_000, actorPath = ACTOR } = {}) {
  const env = childEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [actorPath, command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ActorError(safeMessage(error)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // The actor writes its error as the final stderr line.
        const lines = stderr.trim().split('\n');
        reject(new ActorError(safeMessage(lines[lines.length - 1] || 'actor ' + command + ' failed')));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new ActorError('actor ' + command + ' returned malformed output'));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// keeperSecrets(index, { withTxKey }) -> { encryption, signing, txKey? } (DER Base64 / NEAR key).
// keeperDir is an operator-controlled directory (by default inside the session
// directory). It is restricted and verified before the first secret is written.
export function createActors({
  keeperSecrets, keeperIds, rpcUrl, provingDir, keeperDir, run = runActor, secureDir = securePrivateDir,
}) {
  if (!keeperDir) throw new Error('createActors requires an operator-controlled keeperDir');
  let prepared = null;
  const prepare = () => {
    prepared ??= secureDir(keeperDir).catch((error) => {
      prepared = null;
      throw error;
    });
    return prepared;
  };

  async function withKeeperFile(index, withTxKey, task) {
    const root = await prepare();
    // Inherits the owner-only ACL (Windows) or sits under a 0700 directory (POSIX).
    const dir = await mkdtemp(join(root, RUN_PREFIX));
    try {
      const keyPath = join(dir, 'keeper.json');
      await writeFile(keyPath, JSON.stringify(keeperSecrets(index, { withTxKey })), { flag: 'wx', mode: 0o600 });
      return await task(keyPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const input = (session, index, keyPath) => ({
    testnet: true, rpcAddr: rpcUrl, contractId: session.market_id, trader: session.trader_id,
    accountId: keeperIds[index], keeperIndex: index, keyPath, provingDir,
  });

  return {
    prepare,
    // Keeper decrypts its own pending envelope, checks the commitment, signs.
    ack: (session, index) => withKeeperFile(index, false,
      async (keyPath) => (await run('ack', input(session, index, keyPath))).signature),
    // Cold Keeper B: proves against the latest round for the pinned armed slot
    // only, and submits only if that position is liquidatable.
    liquidate(session, { expectedNonce, expectedCommitment } = {}) {
      if (!Number.isSafeInteger(expectedNonce) || typeof expectedCommitment !== 'string') {
        return Promise.reject(new ActorError('liquidation requires the armed slot nonce and commitment'));
      }
      return withKeeperFile(1, true, (keyPath) => run('liquidate',
        { ...input(session, 1, keyPath), expectedNonce, expectedCommitment }));
    },
  };
}

// Exact text of the prover's ModelError::Healthy (prover/src/model.rs). The
// prover prints it as "error: <msg>" and the actor relays that final line.
// Anything else (RPC, prover crash, timeout) is a transient error, not a skip.
export const HEALTHY_REFUSAL =
  'position is healthy at this oracle round (equity is at least 5% maintenance); liquidation cannot be proven';
export const isHealthyRefusal = (error) =>
  String(error?.message ?? '').trim().replace(/^error: /, '') === HEALTHY_REFUSAL;
