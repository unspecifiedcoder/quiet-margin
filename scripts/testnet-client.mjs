import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { KeyPair, Worker } from 'near-workspaces';
import near from 'near-api-js';

export const TESTNET_RPC = 'https://test.rpc.fastnear.com';
export const TESTNET_GAS = 80_000_000_000_000n;
export const TESTNET_DIR = fileURLToPath(new URL('../.testnet/', import.meta.url));
export const ROLES = ['DEMO', 'MARKET', 'TOKEN', 'TRADER', 'MAKER', 'ORACLE', 'KEEPER_A', 'KEEPER_B'];

export function loadDemoEnv() {
  const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  assert.equal(env.NEAR_NETWORK_ID, 'testnet');
  assert.equal(env.NEAR_RPC_URL, TESTNET_RPC);
  const demo = env.NEAR_DEMO_ACCOUNT_ID;
  assert.match(demo, /^[a-z0-9]+(?:-[a-z0-9]+)*\.testnet$/);
  assert.equal(Buffer.from(env.NEAR_DEPLOYMENT_ID, 'base64').length, 32);
  const roles = Object.fromEntries(ROLES.map((role) => {
    const id = env['NEAR_' + role + '_ACCOUNT_ID'];
    if (role !== 'DEMO') assert.ok(id.endsWith('.' + demo), 'expected demo subaccount');
    const key = KeyPair.fromString(env['NEAR_' + role + '_SECRET_KEY']);
    assert.equal(key.getPublicKey().toString(), env['NEAR_' + role + '_PUBLIC_KEY']);
    return [role, { id, key }];
  }));
  assert.equal(new Set(Object.values(roles).map(({ id }) => id)).size, ROLES.length);
  return { env, roles };
}

// --- Hosted credentials ---------------------------------------------------
// The hosted coordinator never reads the local .env. It takes role variables
// only from its runtime environment, or from one mounted KEY=VALUE file named
// by XYTHUM_CREDENTIALS_FILE (an absolute path outside the repository). It
// loads only what it uses: the five signing roles, public account IDs for the
// other roles, and both keepers' envelope and acknowledgment material.
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOSTED_SIGNERS = ['DEMO', 'MARKET', 'MAKER', 'ORACLE', 'KEEPER_B'];
export const HOSTED_PUBLIC_ROLES = ['TOKEN', 'TRADER', 'KEEPER_A'];
const KEEPER_ROLES = ['KEEPER_A', 'KEEPER_B'];
const KEEPER_MATERIAL = ['ENCRYPTION_SECRET', 'ENCRYPTION_PUBLIC', 'ACK_SECRET', 'ACK_PUBLIC'];
const DEMO_ROOT = /^[a-z0-9]+(?:-[a-z0-9]+)*\.testnet$/;
const SUBACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ED25519_PUBLIC = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class CredentialError extends Error {}

// Every variable the hosted loader may read. Nothing else is copied.
export const HOSTED_VARIABLES = Object.freeze([
  'NEAR_NETWORK_ID', 'NEAR_RPC_URL',
  ...ROLES.map((role) => 'NEAR_' + role + '_ACCOUNT_ID'),
  ...ROLES.map((role) => 'NEAR_' + role + '_PUBLIC_KEY'),
  ...HOSTED_SIGNERS.map((role) => 'NEAR_' + role + '_SECRET_KEY'),
  ...KEEPER_ROLES.flatMap((role) => KEEPER_MATERIAL.map((name) => 'NEAR_' + role + '_' + name)),
]);
// Transaction keys the host never uses; supplying one is a deployment error.
export const HOSTED_UNUSED_SECRETS = Object.freeze(
  HOSTED_PUBLIC_ROLES.map((role) => 'NEAR_' + role + '_SECRET_KEY'));
// Variables holding secret material, so the server can drop them from
// process.env once they are loaded.
export const HOSTED_SECRET_VARIABLES = Object.freeze(HOSTED_VARIABLES.filter((name) => name.endsWith('SECRET')
  || name.endsWith('SECRET_KEY')));

const within = (root, path) => {
  const inside = relative(root, path);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
};

// The repository check runs on the path as given and again on the canonical
// (symlink- and junction-resolved) paths of both the file and the repository,
// so a link outside the repository that points into it is refused. The file
// actually read is the canonical one that was checked.
function readMountedCredentials(file, read, realpath) {
  if (!isAbsolute(file)) throw new CredentialError('XYTHUM_CREDENTIALS_FILE must be an absolute path');
  const outside = () => new CredentialError('XYTHUM_CREDENTIALS_FILE must be mounted outside the repository');
  if (within(resolve(REPO_ROOT), resolve(file))) throw outside();
  let root;
  let target;
  try {
    root = realpath(resolve(REPO_ROOT));
    target = realpath(resolve(file));
  } catch {
    throw new CredentialError('XYTHUM_CREDENTIALS_FILE could not be read');
  }
  if (within(root, target)) throw outside();
  let text;
  try {
    text = read(target, 'utf8');
  } catch {
    throw new CredentialError('XYTHUM_CREDENTIALS_FILE could not be read');
  }
  return parseEnv(text);
}

const decodeDer = (text) => (typeof text === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(text)
  ? Buffer.from(text, 'base64') : Buffer.alloc(0));

// Checks that a keeper's DER secrets parse with the expected algorithm and
// derive exactly the published public keys, in the encodings written by
// scripts/testnet-keys.mjs (SPKI for X25519, raw 32 bytes for the ack key).
function checkKeeperMaterial(env, role) {
  const name = (suffix) => 'NEAR_' + role + '_' + suffix;
  const derivedPublic = (suffix, type) => {
    let key;
    try {
      key = createPrivateKey({ key: decodeDer(env[name(suffix)]), format: 'der', type: 'pkcs8' });
    } catch {
      key = null;
    }
    if (key?.asymmetricKeyType !== type) throw new CredentialError(name(suffix) + ' is missing or malformed');
    return createPublicKey(key).export({ format: 'der', type: 'spki' });
  };
  if (derivedPublic('ENCRYPTION_SECRET', 'x25519').toString('base64') !== env[name('ENCRYPTION_PUBLIC')]) {
    throw new CredentialError(name('ENCRYPTION_PUBLIC') + ' does not match ' + name('ENCRYPTION_SECRET'));
  }
  if (derivedPublic('ACK_SECRET', 'ed25519').subarray(-32).toString('base64') !== env[name('ACK_PUBLIC')]) {
    throw new CredentialError(name('ACK_PUBLIC') + ' does not match ' + name('ACK_SECRET'));
  }
}

/**
 * Loads hosted role credentials from `source` (normally process.env) or from
 * the mounted file it names. Never reads the repository .env. Returns
 * `{ env, roles }` like loadDemoEnv, except that `env` holds only
 * HOSTED_VARIABLES and the public roles are `{ id, publicKey }` (publicKey
 * may be null) with no key pair. Error messages name variables, never values.
 */
export function loadHostedEnv(source = process.env, { read = readFileSync, realpath = realpathSync.native } = {}) {
  let input = source;
  if (source.XYTHUM_CREDENTIALS_FILE) {
    const mounted = readMountedCredentials(source.XYTHUM_CREDENTIALS_FILE, read, realpath);
    for (const name of HOSTED_VARIABLES) {
      if (source[name] !== undefined && name in mounted && source[name] !== mounted[name]) {
        throw new CredentialError(name + ' is set both in the environment and in XYTHUM_CREDENTIALS_FILE');
      }
    }
    input = { ...source, ...mounted };
  }
  for (const name of HOSTED_UNUSED_SECRETS) {
    if (input[name]) throw new CredentialError(name + ' is not used by the hosted coordinator; do not provide it');
  }
  const env = Object.fromEntries(HOSTED_VARIABLES
    .filter((name) => typeof input[name] === 'string' && input[name] !== '')
    .map((name) => [name, input[name]]));

  if (env.NEAR_NETWORK_ID !== 'testnet') throw new CredentialError('NEAR_NETWORK_ID must be testnet');
  if (env.NEAR_RPC_URL !== TESTNET_RPC) throw new CredentialError('NEAR_RPC_URL must be ' + TESTNET_RPC);
  const demo = env.NEAR_DEMO_ACCOUNT_ID;
  if (!demo || !DEMO_ROOT.test(demo)) throw new CredentialError('NEAR_DEMO_ACCOUNT_ID must be a named .testnet account');
  const accountId = (role) => {
    const id = env['NEAR_' + role + '_ACCOUNT_ID'];
    if (!id || !SUBACCOUNT.test(id) || (role !== 'DEMO' && !id.endsWith('.' + demo))) {
      throw new CredentialError('NEAR_' + role + '_ACCOUNT_ID must be a subaccount of the demo root');
    }
    return id;
  };

  const roles = {};
  for (const role of HOSTED_SIGNERS) {
    const id = accountId(role);
    let key;
    try {
      key = KeyPair.fromString(env['NEAR_' + role + '_SECRET_KEY']);
    } catch {
      throw new CredentialError('NEAR_' + role + '_SECRET_KEY is missing or malformed');
    }
    if (key.getPublicKey().toString() !== env['NEAR_' + role + '_PUBLIC_KEY']) {
      throw new CredentialError('NEAR_' + role + '_PUBLIC_KEY does not match NEAR_' + role + '_SECRET_KEY');
    }
    roles[role] = { id, key };
  }
  for (const role of HOSTED_PUBLIC_ROLES) {
    const publicKey = env['NEAR_' + role + '_PUBLIC_KEY'] ?? null;
    if (publicKey !== null && !ED25519_PUBLIC.test(publicKey)) {
      throw new CredentialError('NEAR_' + role + '_PUBLIC_KEY must be an ed25519 public key');
    }
    roles[role] = { id: accountId(role), publicKey };
  }
  if (new Set(Object.values(roles).map(({ id }) => id)).size !== ROLES.length) {
    throw new CredentialError('role account IDs must be distinct');
  }
  for (const role of KEEPER_ROLES) checkKeeperMaterial(env, role);
  return { env, roles };
}

export async function connectChain(rpcAddr, testnet = false) {
  const url = new URL(rpcAddr);
  if (testnet) {
    assert.equal(rpcAddr, TESTNET_RPC);
  } else {
    assert.ok(url.hostname === '127.0.0.1' && url.protocol === 'http:', 'expected Sandbox RPC');
  }
  const keyStore = new near.keyStores.InMemoryKeyStore();
  const chain = await Worker.init({ network: 'custom', rpcAddr, keyStore });
  if (testnet) assert.equal((await chain.provider.status()).chain_id, 'testnet');
  return chain;
}

export async function demoAccounts(chain, roles) {
  const accounts = {};
  for (const [role, { id, key }] of Object.entries(roles)) {
    const account = chain.rootAccount.getAccount(id);
    await account.setKey(key);
    accounts[role] = account;
  }
  return accounts;
}

export async function viewFinal(chain, accountId, method, args = {}) {
  const response = await chain.provider.query({
    request_type: 'call_function', finality: 'final', account_id: accountId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(response.result).toString('utf8'));
}

export async function waitFinal(chain, tx) {
  const receipt = tx.transactionReceipt;
  const outcome = await chain.provider.txStatus(receipt.hash, receipt.signer_id, 'FINAL');
  assert.equal(outcome.final_execution_status, 'FINAL');
  assert.deepEqual(outcome.status, tx.status);
  return outcome;
}
