// Hosted role credentials: runtime variables or a mounted file only, never the
// repository .env. All keys here are freshly generated and fake.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { KeyPair } from 'near-api-js';
import {
  CredentialError, HOSTED_SECRET_VARIABLES, HOSTED_UNUSED_SECRETS, loadHostedEnv, REPO_ROOT, TESTNET_RPC,
} from '../../../scripts/testnet-client.mjs';
import { childEnv } from '../actors.mjs';
import { createTestnetAdapter, HOSTED_SCRUBBED, loadRoles, takeCredentials } from '../testnet.mjs';

const ROOT = 'xythum-perps-demo.testnet';
const IDS = {
  DEMO: ROOT, MARKET: 'market.' + ROOT, TOKEN: 'musdc.' + ROOT, TRADER: 'trader.' + ROOT,
  MAKER: 'maker.' + ROOT, ORACLE: 'oracle.' + ROOT, KEEPER_A: 'keeper-a.' + ROOT, KEEPER_B: 'keeper-b.' + ROOT,
};
const SIGNERS = ['DEMO', 'MARKET', 'MAKER', 'ORACLE', 'KEEPER_B'];
const PUBLIC_ONLY = ['TOKEN', 'TRADER', 'KEEPER_A'];
const MOUNT = process.platform === 'win32' ? 'C:\\run\\secrets\\xythum.env' : '/run/secrets/xythum.env';

function keeperMaterial() {
  const encryption = generateKeyPairSync('x25519');
  const ack = generateKeyPairSync('ed25519');
  return {
    ENCRYPTION_SECRET: encryption.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    ENCRYPTION_PUBLIC: encryption.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    ACK_SECRET: ack.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    ACK_PUBLIC: ack.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  };
}

// What a Fly deployment sets: signers with secrets, public IDs (and public
// keys) for the rest, and both keepers' envelope/ack material.
function hostedEnv() {
  const env = { NEAR_NETWORK_ID: 'testnet', NEAR_RPC_URL: TESTNET_RPC, UNRELATED: 'kept out', PATH: '/usr/bin' };
  for (const [role, id] of Object.entries(IDS)) {
    env['NEAR_' + role + '_ACCOUNT_ID'] = id;
    const key = KeyPair.fromRandom('ed25519');
    env['NEAR_' + role + '_PUBLIC_KEY'] = key.getPublicKey().toString();
    if (SIGNERS.includes(role)) env['NEAR_' + role + '_SECRET_KEY'] = key.toString();
  }
  for (const role of ['KEEPER_A', 'KEEPER_B']) {
    for (const [name, value] of Object.entries(keeperMaterial())) env['NEAR_' + role + '_' + name] = value;
  }
  return env;
}

const noRead = () => {
  throw new Error('no file may be read');
};
const rejects = (env, pattern, options = { read: noRead }) => assert.throws(() => loadHostedEnv(env, options),
  (error) => {
    assert.ok(error instanceof CredentialError, String(error));
    assert.match(error.message, pattern);
    // Errors name variables, never values.
    for (const value of Object.values(env)) {
      if (typeof value === 'string' && value.length > 20) assert.ok(!error.message.includes(value));
    }
    return true;
  });

test('hosted loader takes signers, public IDs and keeper material from runtime variables only', () => {
  const env = hostedEnv();
  const { env: loaded, roles } = loadHostedEnv(env, { read: noRead });
  for (const role of SIGNERS) {
    assert.equal(roles[role].id, IDS[role]);
    assert.equal(roles[role].key.getPublicKey().toString(), env['NEAR_' + role + '_PUBLIC_KEY']);
  }
  for (const role of PUBLIC_ONLY) {
    assert.deepEqual(roles[role], { id: IDS[role], publicKey: env['NEAR_' + role + '_PUBLIC_KEY'] });
  }
  assert.equal(loaded.UNRELATED, undefined);
  assert.equal(loaded.PATH, undefined);
  assert.equal(loaded.NEAR_KEEPER_A_ACK_SECRET, env.NEAR_KEEPER_A_ACK_SECRET);
  for (const name of Object.keys(loaded)) assert.match(name, /^NEAR_/);
  assert.ok(HOSTED_SECRET_VARIABLES.includes('NEAR_KEEPER_B_SECRET_KEY'));
  assert.ok(HOSTED_SECRET_VARIABLES.includes('NEAR_KEEPER_A_ACK_SECRET'));
  assert.ok(!HOSTED_SECRET_VARIABLES.some((name) => name.endsWith('_PUBLIC') || name.endsWith('_PUBLIC_KEY')));

  // Public keys of the public-only roles are optional; IDs are not.
  for (const role of PUBLIC_ONLY) delete env['NEAR_' + role + '_PUBLIC_KEY'];
  assert.equal(loadHostedEnv(env, { read: noRead }).roles.TOKEN.publicKey, null);
});

test('hosted loader refuses unused transaction secrets and mismatched or missing material', () => {
  for (const name of HOSTED_UNUSED_SECRETS) {
    rejects({ ...hostedEnv(), [name]: KeyPair.fromRandom('ed25519').toString() }, new RegExp(name + ' is not used'));
  }
  assert.deepEqual(HOSTED_UNUSED_SECRETS,
    ['NEAR_TOKEN_SECRET_KEY', 'NEAR_TRADER_SECRET_KEY', 'NEAR_KEEPER_A_SECRET_KEY']);

  rejects({ ...hostedEnv(), NEAR_NETWORK_ID: 'mainnet' }, /NEAR_NETWORK_ID/);
  rejects({ ...hostedEnv(), NEAR_RPC_URL: 'https://rpc.mainnet.near.org' }, /NEAR_RPC_URL/);
  rejects({ ...hostedEnv(), NEAR_DEMO_ACCOUNT_ID: 'demo.near' }, /NEAR_DEMO_ACCOUNT_ID/);
  rejects({ ...hostedEnv(), NEAR_MAKER_ACCOUNT_ID: 'maker.other.testnet' }, /NEAR_MAKER_ACCOUNT_ID/);
  rejects({ ...hostedEnv(), NEAR_TOKEN_ACCOUNT_ID: undefined }, /NEAR_TOKEN_ACCOUNT_ID/);
  rejects({ ...hostedEnv(), NEAR_TRADER_ACCOUNT_ID: IDS.MAKER }, /distinct/);
  for (const role of SIGNERS) {
    rejects({ ...hostedEnv(), ['NEAR_' + role + '_SECRET_KEY']: undefined }, new RegExp('NEAR_' + role + '_SECRET_KEY'));
    rejects({ ...hostedEnv(), ['NEAR_' + role + '_PUBLIC_KEY']: KeyPair.fromRandom('ed25519').getPublicKey().toString() },
      new RegExp('NEAR_' + role + '_PUBLIC_KEY does not match'));
  }
  rejects({ ...hostedEnv(), NEAR_TOKEN_PUBLIC_KEY: 'not-a-key' }, /NEAR_TOKEN_PUBLIC_KEY/);
  const other = keeperMaterial();
  for (const role of ['KEEPER_A', 'KEEPER_B']) {
    for (const name of ['ENCRYPTION_SECRET', 'ACK_SECRET']) {
      rejects({ ...hostedEnv(), ['NEAR_' + role + '_' + name]: undefined }, new RegExp('NEAR_' + role + '_' + name));
      rejects({ ...hostedEnv(), ['NEAR_' + role + '_' + name]: 'AAAA' }, new RegExp('NEAR_' + role + '_' + name));
    }
    rejects({ ...hostedEnv(), ['NEAR_' + role + '_ENCRYPTION_PUBLIC']: other.ENCRYPTION_PUBLIC },
      new RegExp('NEAR_' + role + '_ENCRYPTION_PUBLIC does not match'));
    rejects({ ...hostedEnv(), ['NEAR_' + role + '_ACK_PUBLIC']: other.ACK_PUBLIC },
      new RegExp('NEAR_' + role + '_ACK_PUBLIC does not match'));
    // An ack key in the encryption slot (wrong algorithm) is refused.
    rejects({ ...hostedEnv(), ['NEAR_' + role + '_ENCRYPTION_SECRET']: other.ACK_SECRET },
      new RegExp('NEAR_' + role + '_ENCRYPTION_SECRET'));
  }
});

test('a mounted credentials file must be absolute and outside the repository', () => {
  const values = hostedEnv();
  const file = Object.entries(values).filter(([name]) => name.startsWith('NEAR_'))
    .map(([name, value]) => name + '=' + value).join('\n') + '\n';
  const reads = [];
  const read = (path) => {
    reads.push(path);
    return file;
  };
  // The fake mount does not exist on disk: canonicalization is the identity.
  const realpath = (path) => path;
  const { roles } = loadHostedEnv({ XYTHUM_CREDENTIALS_FILE: MOUNT, PATH: '/usr/bin' }, { read, realpath });
  assert.deepEqual(reads, [MOUNT]);
  assert.equal(roles.KEEPER_B.id, IDS.KEEPER_B);

  rejects({ XYTHUM_CREDENTIALS_FILE: 'secrets.env' }, /absolute/);
  for (const inside of [join(REPO_ROOT, '.env'), join(REPO_ROOT, 'exchange', '.env'), REPO_ROOT]) {
    rejects({ XYTHUM_CREDENTIALS_FILE: inside }, /outside the repository/);
  }
  rejects({ XYTHUM_CREDENTIALS_FILE: MOUNT }, /could not be read/, { read: noRead, realpath });
  // A path that cannot be canonicalized (missing) is refused before any read.
  rejects({ XYTHUM_CREDENTIALS_FILE: MOUNT }, /could not be read/, {
    read: noRead, realpath: (path) => {
      if (path === MOUNT) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return path;
    },
  });
  // The same variable from two sources must agree.
  rejects({ XYTHUM_CREDENTIALS_FILE: MOUNT, NEAR_MAKER_ACCOUNT_ID: 'maker2.' + ROOT }, /both in the environment/,
    { read, realpath });
});

test('a mounted path that links back into the repository is refused before any read', () => {
  // Injected: the lexical path is outside, its canonical target is inside.
  const into = join(REPO_ROOT, '.env');
  rejects({ XYTHUM_CREDENTIALS_FILE: MOUNT }, /outside the repository/,
    { read: noRead, realpath: (path) => (path === MOUNT ? into : path) });
  // Injected: the repository itself is reached through a link (e.g. /app ->
  // /srv/app) and the mount resolves into its canonical location.
  const canonicalRoot = process.platform === 'win32' ? 'D:\\srv\\app' : '/srv/app';
  rejects({ XYTHUM_CREDENTIALS_FILE: MOUNT }, /outside the repository/, {
    read: noRead,
    realpath: (path) => (path === MOUNT ? join(canonicalRoot, '.env') : path === resolve(REPO_ROOT) ? canonicalRoot : path),
  });

  // On disk: a directory link outside the repository pointing at it. A
  // junction needs no privilege on Windows; elsewhere it is a symlink.
  const outside = mkdtempSync(join(tmpdir(), 'xythum-cred-'));
  try {
    const link = join(outside, 'repo');
    symlinkSync(resolve(REPO_ROOT), link, process.platform === 'win32' ? 'junction' : 'dir');
    rejects({ XYTHUM_CREDENTIALS_FILE: join(link, 'package.json') }, /outside the repository/);
    // A real file outside the repository is still accepted (and read by its canonical path).
    const real = join(outside, 'xythum.env');
    writeFileSync(real, Object.entries(hostedEnv()).filter(([name]) => name.startsWith('NEAR_'))
      .map(([name, value]) => name + '=' + value).join('\n') + '\n');
    const reads = [];
    const { roles } = loadHostedEnv({ XYTHUM_CREDENTIALS_FILE: real }, {
      read: (path, encoding) => {
        reads.push(path);
        return readFileSync(path, encoding);
      },
    });
    assert.equal(roles.MARKET.id, IDS.MARKET);
    assert.deepEqual(reads, [realpathSync.native(real)]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('hosted secrets and the invite leave the environment before any child starts', () => {
  const invite = 'ab'.repeat(32);
  const env = { ...hostedEnv(), XYTHUM_HOSTED_INVITE: invite };
  const secrets = Object.entries(env).filter(([name]) => /SECRET/.test(name)).map(([, value]) => value);
  assert.ok(secrets.length >= 9);
  const { roles } = takeCredentials({ hosted: true, env });
  assert.equal(roles.ORACLE.id, IDS.ORACLE);
  for (const name of HOSTED_SCRUBBED) assert.equal(env[name], undefined, name);
  assert.ok(!Object.keys(env).some((name) => /SECRET|INVITE/.test(name)));
  for (const value of Object.values(env)) assert.ok(value !== invite && !secrets.includes(value));
  // Public material and unrelated variables stay.
  assert.equal(typeof env.NEAR_KEEPER_A_ACK_PUBLIC, 'string');
  assert.equal(env.PATH, '/usr/bin');

  // A failed load still scrubs, so a crash path never leaves secrets behind.
  const bad = { ...hostedEnv(), NEAR_MAKER_PUBLIC_KEY: KeyPair.fromRandom('ed25519').getPublicKey().toString(),
    NEAR_TOKEN_SECRET_KEY: KeyPair.fromRandom('ed25519').toString(), XYTHUM_HOSTED_INVITE: invite };
  assert.throws(() => takeCredentials({ hosted: true, env: bad }), CredentialError);
  for (const name of HOSTED_SCRUBBED) assert.equal(bad[name], undefined, name);
  // Local mode reads the repository .env instead and never edits the environment.
  const local = { XYTHUM_HOSTED_INVITE: invite };
  try {
    takeCredentials({ hosted: false, env: local });
  } catch {
    // No local .env in this checkout: irrelevant here.
  }
  assert.equal(local.XYTHUM_HOSTED_INVITE, invite);

  // The native prover and actors inherit only the minimal allowlist.
  const child = childEnv({ ...hostedEnv(), XYTHUM_HOSTED_INVITE: invite, FLY_API_TOKEN: 'x', PROVER_BIN: '/app/bin/p' });
  assert.deepEqual(Object.keys(child).sort(), ['PATH', 'PROVER_BIN']);
});

test('hosted roles drive the testnet adapter without TOKEN, TRADER or KEEPER_A keys', async () => {
  const env = hostedEnv();
  // loadRoles in hosted mode goes through loadHostedEnv (the .env path is never taken).
  const { env: loaded, roles } = loadRoles({ hosted: true, env });
  assert.equal(roles.TRADER.key, undefined);
  const chain = {
    provider: {
      query: async () => ({ result: [...Buffer.from(JSON.stringify({ symbol: 'mUSDC', decimals: 2 }))] }),
    },
  };
  const adapter = await createTestnetAdapter({ env: loaded, roles, chain, accounts: {}, finalize: async () => {} });
  assert.deepEqual(adapter.ids.forbidden.sort(), Object.values(IDS).sort());
  assert.equal(adapter.ids.rolePublicKeys.length, 8);
  for (const role of Object.keys(IDS)) assert.ok(adapter.ids.rolePublicKeys.includes(env['NEAR_' + role + '_PUBLIC_KEY']));
  assert.deepEqual(adapter.keeperAckKeys, [env.NEAR_KEEPER_A_ACK_PUBLIC, env.NEAR_KEEPER_B_ACK_PUBLIC]);
  assert.deepEqual(adapter.keeperEncryptionKeys, [env.NEAR_KEEPER_A_ENCRYPTION_PUBLIC, env.NEAR_KEEPER_B_ENCRYPTION_PUBLIC]);
  assert.deepEqual(adapter.keeperSecrets(0, { withTxKey: false }),
    { encryption: env.NEAR_KEEPER_A_ENCRYPTION_SECRET, signing: env.NEAR_KEEPER_A_ACK_SECRET });
  assert.deepEqual(adapter.keeperSecrets(1, { withTxKey: true }),
    { encryption: env.NEAR_KEEPER_B_ENCRYPTION_SECRET, txKey: env.NEAR_KEEPER_B_SECRET_KEY });
  assert.equal(adapter.marketDeployKey, env.NEAR_MARKET_PUBLIC_KEY);

  // Without public keys for the public-only roles, the guard list holds the signers.
  for (const role of PUBLIC_ONLY) delete env['NEAR_' + role + '_PUBLIC_KEY'];
  const partial = loadHostedEnv(env, { read: noRead });
  const again = await createTestnetAdapter({ ...partial, chain, accounts: {}, finalize: async () => {} });
  assert.equal(again.ids.rolePublicKeys.length, 5);
});
