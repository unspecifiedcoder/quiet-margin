// Offline tests for secrets.mjs, which uses the server's own hosted schema
// (scripts/testnet-client.mjs loadHostedEnv). Needs the root npm dependencies
// (`npm ci --ignore-scripts`); skipped without them. Keys are generated per
// run; no RPC, no .env.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { parseEnv } from 'node:util';

const sdk = await import('near-workspaces').then(() => true, () => false);
const skip = sdk ? false : 'root npm dependencies are not installed';

const ROLES = ['DEMO', 'MARKET', 'TOKEN', 'TRADER', 'MAKER', 'ORACLE', 'KEEPER_A', 'KEEPER_B'];

// A full legacy .env-like source: all eight transaction secrets, plus noise.
async function legacySource() {
  const { KeyPair } = await import('near-workspaces');
  const env = {
    NEAR_NETWORK_ID: 'testnet', NEAR_RPC_URL: 'https://test.rpc.fastnear.com',
    NEAR_DEPLOYMENT_ID: randomBytes(32).toString('base64'), NEAR_DEMO_ACCOUNT_ID: 'fake-demo.testnet', PATH: '/usr/bin',
  };
  for (const role of ROLES) {
    if (role !== 'DEMO') env['NEAR_' + role + '_ACCOUNT_ID'] = role.toLowerCase().replace('_', '-') + '.fake-demo.testnet';
    const key = KeyPair.fromRandom('ed25519');
    env['NEAR_' + role + '_SECRET_KEY'] = key.toString();
    env['NEAR_' + role + '_PUBLIC_KEY'] = key.getPublicKey().toString();
  }
  for (const role of ['KEEPER_A', 'KEEPER_B']) {
    const ack = generateKeyPairSync('ed25519');
    const enc = generateKeyPairSync('x25519');
    env['NEAR_' + role + '_ACK_PUBLIC'] = ack.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    env['NEAR_' + role + '_ACK_SECRET'] = ack.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    env['NEAR_' + role + '_ENCRYPTION_PUBLIC'] = enc.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    env['NEAR_' + role + '_ENCRYPTION_SECRET'] = enc.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  }
  return env;
}

test('env format: only the server HOSTED_VARIABLES plus the invite; unused secrets dropped; server loads and scrubs it',
  { skip }, async () => {
    const { buildSecrets } = await import('../secrets.mjs');
    const { HOSTED_UNUSED_SECRETS, HOSTED_VARIABLES, loadHostedEnv } = await import('../../../scripts/testnet-client.mjs');
    const { takeCredentials } = await import('../../server/testnet.mjs');
    const source = await legacySource();
    const invite = randomBytes(32).toString('hex');
    const { files, names, unusedSkipped } = buildSecrets(source, invite);
    assert.deepEqual(unusedSkipped.sort(), [...HOSTED_UNUSED_SECRETS].sort());
    assert.equal(files.credentials, undefined);
    const written = parseEnv(files.secrets);
    assert.deepEqual(Object.keys(written).sort(), [...HOSTED_VARIABLES, 'XYTHUM_HOSTED_INVITE'].sort());
    assert.deepEqual(names.sort(), Object.keys(written).sort());
    for (const name of HOSTED_UNUSED_SECRETS) assert.ok(!files.secrets.includes(source[name]), name);
    assert.ok(!('NEAR_DEPLOYMENT_ID' in written) && !('PATH' in written));
    const { roles } = loadHostedEnv(written);
    assert.ok(roles.DEMO.key && roles.KEEPER_B.key && !roles.TRADER.key && roles.TRADER.publicKey);
    // What the server will do with it on the host: load, then scrub every secret.
    takeCredentials({ hosted: true, env: written });
    assert.ok(!Object.keys(written).some((name) => /SECRET|INVITE/.test(name)));
  });

test('public-only role public keys may be absent (the server treats them as optional)', { skip }, async () => {
  const { buildSecrets } = await import('../secrets.mjs');
  const source = await legacySource();
  delete source.NEAR_TRADER_PUBLIC_KEY;
  const { files } = buildSecrets(source, randomBytes(32).toString('hex'));
  assert.ok(!('NEAR_TRADER_PUBLIC_KEY' in parseEnv(files.secrets)));
  // A signer's public key is not optional.
  delete source.NEAR_ORACLE_PUBLIC_KEY;
  assert.throws(() => buildSecrets(source, randomBytes(32).toString('hex')), /NEAR_ORACLE_PUBLIC_KEY/);
});

test('mounted-file format: role variables in the credentials file, only invite + path in secrets', { skip }, async () => {
  const { buildSecrets, checkMountPath } = await import('../secrets.mjs');
  const { HOSTED_VARIABLES, loadHostedEnv } = await import('../../../scripts/testnet-client.mjs');
  const source = await legacySource();
  const invite = randomBytes(32).toString('hex');
  const mount = '/run/xythum/credentials.env';
  const { files } = buildSecrets(source, invite, { mountedFile: mount });
  assert.deepEqual(parseEnv(files.secrets), { XYTHUM_HOSTED_INVITE: invite, XYTHUM_CREDENTIALS_FILE: mount });
  assert.deepEqual(Object.keys(parseEnv(files.credentials)).sort(), [...HOSTED_VARIABLES].sort());
  assert.ok(!files.credentials.includes(invite));
  const { roles } = loadHostedEnv({ XYTHUM_CREDENTIALS_FILE: mount }, { read: () => files.credentials, realpath: (p) => p });
  assert.ok(roles.MARKET.key);
  for (const bad of ['relative/file', '/app/credentials.env', '/app', '/run/../app/x', '/run/x/']) {
    assert.throws(() => checkMountPath(bad), /--mounted-file/, bad);
  }
});

test('mismatched keys and bad invites are refused without echoing values', { skip }, async () => {
  const { buildSecrets } = await import('../secrets.mjs');
  const { CredentialError } = await import('../../../scripts/testnet-client.mjs');
  const source = await legacySource();
  const other = await legacySource();
  source.NEAR_MAKER_PUBLIC_KEY = other.NEAR_MAKER_PUBLIC_KEY;
  assert.throws(() => buildSecrets(source, randomBytes(32).toString('hex')), (error) => error instanceof CredentialError
    && /NEAR_MAKER_PUBLIC_KEY/.test(error.message) && !error.message.includes(source.NEAR_MAKER_SECRET_KEY));
  const good = await legacySource();
  for (const invite of [undefined, 'A'.repeat(64), 'a'.repeat(63)]) {
    assert.throws(() => buildSecrets(good, invite), /XYTHUM_HOSTED_INVITE must be 64 lowercase hex/);
  }
  good.NEAR_KEEPER_A_ACK_PUBLIC = other.NEAR_KEEPER_A_ACK_PUBLIC;
  assert.throws(() => buildSecrets(good, randomBytes(32).toString('hex')), /NEAR_KEEPER_A_ACK_PUBLIC/);
});
