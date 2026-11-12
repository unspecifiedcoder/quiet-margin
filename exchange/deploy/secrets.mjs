#!/usr/bin/env node
// Writes the least-privilege hosted credentials for the coordinator from an
// operator-chosen env file. Run it yourself; it never uploads anything.
//
//   node exchange/deploy/secrets.mjs --from <env file> --app <new-fly-app>
//        [--out-dir <dir>] [--reuse-invite] [--mounted-file <absolute guest path>]
//
// The schema is the server's own: HOSTED_VARIABLES / HOSTED_UNUSED_SECRETS and
// loadHostedEnv() from scripts/testnet-client.mjs, INVITE_PATTERN from
// exchange/server/config.mjs. Only HOSTED_VARIABLES leave the source file
// (signing keys for DEMO, MARKET, MAKER, ORACLE, KEEPER_B; public IDs/keys for
// TOKEN, TRADER, KEEPER_A; both keepers' envelope/ack material). The TOKEN,
// TRADER and KEEPER_A transaction secrets are never copied, and the result is
// validated by loadHostedEnv() after a parse round trip.
//
// Output (owner-only directory, files written once, never overwritten):
//   default:          <app>.secrets.env      role variables + XYTHUM_HOSTED_INVITE,
//                                            for `fly secrets import --stage`
//   --mounted-file P: <app>.credentials.env  role variables only, to be mounted
//                                            read-only at P on the host
//                     <app>.secrets.env      XYTHUM_HOSTED_INVITE and
//                                            XYTHUM_CREDENTIALS_FILE=P
//   always:           <app>.invite.txt       https://<app>.fly.dev/#invite=<64 hex>
// Default <out-dir> is <repo>/.testnet/fly (Git-ignored). Only names are printed.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { HOSTED_UNUSED_SECRETS, HOSTED_VARIABLES, loadHostedEnv } from '../../scripts/testnet-client.mjs';
import { securePrivateDir } from '../server/actors.mjs';
import { INVITE_PATTERN } from '../server/config.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const APP = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const INVITE_KEY = 'XYTHUM_HOSTED_INVITE';
export const CREDENTIALS_FILE_KEY = 'XYTHUM_CREDENTIALS_FILE';
// Where the image keeps code; a mounted credentials file must be elsewhere
// (the server also refuses one inside its repository root).
const IMAGE_APP_ROOT = '/app';

export const formatEnv = (env) => Object.entries(env).map(([key, value]) => key + '=' + value).join('\n') + '\n';

// The text must parse back to exactly the same variables.
function roundTrip(env, what) {
  const text = formatEnv(env);
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(env)) {
    if (/[\r\n]/.test(value) || parsed[key] !== value) throw new Error(key + ' does not survive the ' + what + ' format');
  }
  if (Object.keys(parsed).length !== Object.keys(env).length) throw new Error(what + ' format added variables');
  return text;
}

export function checkMountPath(path) {
  if (typeof path !== 'string' || !posix.isAbsolute(path) || posix.normalize(path) !== path || path.endsWith('/')) {
    throw new Error('--mounted-file must be a normalized absolute POSIX path on the host');
  }
  if (path === IMAGE_APP_ROOT || path.startsWith(IMAGE_APP_ROOT + '/')) {
    throw new Error('--mounted-file must be outside ' + IMAGE_APP_ROOT + ' (the image code root)');
  }
  return path;
}

/**
 * Pure: picks the hosted variables from a parsed source env and validates them
 * with the server's loadHostedEnv(). Returns the files' variable sets and the
 * names that were not copied. Errors name variables, never values.
 */
export function buildSecrets(sourceEnv, invite, { mountedFile } = {}) {
  if (!INVITE_PATTERN.test(invite ?? '')) throw new Error(INVITE_KEY + ' must be 64 lowercase hex digits');
  const roles = Object.fromEntries(HOSTED_VARIABLES
    .filter((key) => typeof sourceEnv[key] === 'string' && sourceEnv[key] !== '')
    .map((key) => [key, sourceEnv[key]]));
  const credentialsText = roundTrip(roles, 'KEY=VALUE');
  // Validate exactly what the server will read.
  if (mountedFile === undefined) {
    loadHostedEnv(parseEnv(credentialsText));
  } else {
    checkMountPath(mountedFile);
    loadHostedEnv({ [CREDENTIALS_FILE_KEY]: mountedFile },
      { read: () => credentialsText, realpath: (path) => path });
  }
  const skipped = Object.keys(sourceEnv).filter((key) => !(key in roles));
  const unusedSkipped = skipped.filter((key) => HOSTED_UNUSED_SECRETS.includes(key));
  if (mountedFile === undefined) {
    const secrets = { ...roles, [INVITE_KEY]: invite };
    return { files: { secrets: roundTrip(secrets, 'secrets') }, names: Object.keys(secrets), skipped, unusedSkipped };
  }
  const secrets = { [INVITE_KEY]: invite, [CREDENTIALS_FILE_KEY]: mountedFile };
  return {
    files: { secrets: roundTrip(secrets, 'secrets'), credentials: credentialsText },
    names: Object.keys(roles), secretNames: Object.keys(secrets), skipped, unusedSkipped,
  };
}

function assertPrivateOutDir(outDir) {
  // Whatever Git worktree holds --out-dir must ignore it.
  let probe = outDir;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let top = null;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: probe, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // not inside a Git worktree
  }
  for (const root of new Set([REPO, top].filter(Boolean).map((path) => resolve(path)))) {
    const rel = relative(root, outDir);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel.replaceAll('\\', '/') + '/'], { cwd: root, stdio: 'ignore' });
    } catch {
      throw new Error('--out-dir is inside ' + root + ' but not Git-ignored');
    }
  }
  for (let dir = outDir; dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, '.xythum-fly-stage'))) throw new Error('--out-dir must not be inside a staging context');
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' }, app: { type: 'string' }, 'out-dir': { type: 'string' }, 'reuse-invite': { type: 'boolean' },
      'mounted-file': { type: 'string' },
    },
    strict: true,
  });
  if (!values.from || !values.app) {
    throw new Error('usage: --from <env file> --app <new-fly-app> [--out-dir <dir>] [--reuse-invite] [--mounted-file <path>]');
  }
  if (!APP.test(values.app)) throw new Error('--app must be a lowercase Fly app name');
  const outDir = resolve(values['out-dir'] ?? join(REPO, '.testnet', 'fly'));
  assertPrivateOutDir(outDir);
  const secretsFile = join(outDir, values.app + '.secrets.env');
  const credentialsFile = join(outDir, values.app + '.credentials.env');
  const inviteFile = join(outDir, values.app + '.invite.txt');
  for (const file of [secretsFile, credentialsFile]) {
    if (existsSync(file)) throw new Error(file + ' already exists; delete it deliberately to regenerate');
  }

  let invite;
  if (values['reuse-invite']) {
    invite = /#invite=([0-9a-f]{64})\s*$/.exec(readFileSync(inviteFile, 'utf8'))?.[1];
    if (!invite) throw new Error('could not read the existing invite from ' + inviteFile);
  } else {
    if (existsSync(inviteFile)) throw new Error(inviteFile + ' already exists; pass --reuse-invite or delete it');
    invite = randomBytes(32).toString('hex');
  }

  const result = buildSecrets(parseEnv(readFileSync(values.from, 'utf8')), invite, { mountedFile: values['mounted-file'] });
  // Owner-only directory (POSIX 0700 / Windows protected single-user DACL).
  await securePrivateDir(outDir);
  // 'wx' fails instead of overwriting if a file appeared meanwhile.
  if (result.files.credentials) await writeFile(credentialsFile, result.files.credentials, { flag: 'wx', mode: 0o600 });
  await writeFile(secretsFile, result.files.secrets, { flag: 'wx', mode: 0o600 });
  if (!values['reuse-invite']) {
    await writeFile(inviteFile, 'https://' + values.app + '.fly.dev/#invite=' + invite + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (result.files.credentials) {
    console.log('wrote ' + result.names.length + ' role variables to ' + credentialsFile + ' (mount read-only at '
      + values['mounted-file'] + ')');
    console.log('wrote ' + result.secretNames.join(' ') + ' to ' + secretsFile);
  } else {
    console.log('wrote ' + result.names.length + ' secrets to ' + secretsFile);
  }
  console.log('role names: ' + result.names.filter((name) => name !== INVITE_KEY).join(' '));
  if (result.unusedSkipped.length) console.log('NOT copied (unused transaction secrets): ' + result.unusedSkipped.join(' '));
  console.log('ignored ' + (result.skipped.length - result.unusedSkipped.length) + ' other variables from the source file');
  console.log('invite link (keep private): ' + inviteFile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('secrets: ' + String(error?.message ?? error).slice(0, 300));
    process.exit(1);
  });
}
