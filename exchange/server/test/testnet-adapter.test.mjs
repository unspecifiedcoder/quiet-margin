import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyPair } from 'near-api-js';
import { createTestnetAdapter } from '../testnet.mjs';

const ROOT = 'xythum-perps-demo.testnet';
const ROLES = ['DEMO', 'MARKET', 'TOKEN', 'TRADER', 'MAKER', 'ORACLE', 'KEEPER_A', 'KEEPER_B'];
const IDS = {
  DEMO: ROOT, MARKET: 'market.' + ROOT, TOKEN: 'musdc.' + ROOT, TRADER: 'trader.' + ROOT,
  MAKER: 'maker.' + ROOT, ORACLE: 'oracle.' + ROOT, KEEPER_A: 'keeper-a.' + ROOT, KEEPER_B: 'keeper-b.' + ROOT,
};

function fake() {
  const roles = Object.fromEntries(ROLES.map((role) => [role, { id: IDS[role], key: KeyPair.fromRandom('ed25519') }]));
  const env = {};
  for (const role of ['KEEPER_A', 'KEEPER_B']) {
    for (const name of ['ENCRYPTION_SECRET', 'ENCRYPTION_PUBLIC', 'ACK_SECRET', 'ACK_PUBLIC']) {
      env['NEAR_' + role + '_' + name] = role + '-' + name;
    }
  }
  const sent = [];
  const ok = (what) => ({ succeeded: true, receiptFailures: [], transactionReceipt: { hash: 'hash-' + what } });
  const batch = (signer) => (receiver) => {
    const actions = [];
    const tx = {
      createAccount: () => (actions.push('createAccount'), tx),
      transfer: (amount) => (actions.push('transfer:' + amount), tx),
      addKey: (key) => (actions.push('addKey:' + key.toString()), tx),
      deployContract: () => (actions.push('deploy'), tx),
      functionCall: (method) => (actions.push('call:' + method), tx),
      deleteKey: (key) => (actions.push('deleteKey:' + key.toString()), tx),
      transact: async () => {
        sent.push({ signer, receiver: receiver.accountId ?? receiver, actions });
        return ok(actions[0]);
      },
    };
    return tx;
  };
  const accounts = Object.fromEntries(['DEMO', 'MAKER', 'ORACLE'].map((role) => [role, {
    accountId: IDS[role],
    batch: batch(IDS[role]),
    callRaw: async (contractId, method) => {
      sent.push({ signer: IDS[role], receiver: contractId, actions: ['call:' + method] });
      return ok(method);
    },
  }]));
  const chain = {
    provider: {
      async query({ request_type, account_id }) {
        if (request_type === 'view_account' && account_id === 'missing.' + ROOT) {
          throw new Error('[-32000] Server error: account missing.' + ROOT + ' does not exist while viewing');
        }
        if (request_type === 'view_account') return { amount: '1', locked: '0', code_hash: 'c', storage_usage: 1 };
        if (request_type === 'view_access_key_list') {
          return { keys: [{ public_key: 'ed25519:k', access_key: { permission: 'FullAccess' } },
            { public_key: 'ed25519:f', access_key: { permission: { FunctionCall: {} } } }] };
        }
        if (request_type === 'call_function') {
          return { result: [...Buffer.from(JSON.stringify({ symbol: 'mUSDC', decimals: 2 }))] };
        }
        throw new Error('unexpected query');
      },
      block: async () => ({ header: { height: 42 } }),
    },
    rootAccount: { getAccount: (id) => ({ accountId: id, setKey: async () => {}, batch: batch(id) }) },
  };
  return { roles, env, chain, accounts, sent };
}

test('testnet adapter refuses the existing market and role accounts', async () => {
  const f = fake();
  const adapter = await createTestnetAdapter({ ...f, finalize: async () => {} });
  const { chain } = adapter;
  await assert.rejects(chain.call('MAKER', IDS.MARKET, 'approve_quote', {}), /existing demo market/);
  await assert.rejects(chain.call('TRADER', 'market-1.' + ROOT, 'open', {}), /unknown signer/);
  for (const id of Object.values(IDS)) {
    await assert.rejects(chain.createMarketAccount(id, 1n), /existing demo role/);
    await assert.rejects(chain.createTraderAccount(id, 1n, 'ed25519:x'), /existing demo role/);
    await assert.rejects(chain.deployMarket(id, Buffer.alloc(1), {}), /existing demo role/);
  }
  assert.deepEqual(f.sent, []);

  const marketPk = f.roles.MARKET.key.getPublicKey().toString();
  assert.deepEqual(await chain.createMarketAccount('market-a.' + ROOT, 5n), { hash: 'hash-createAccount' });
  await chain.deployMarket('market-a.' + ROOT, Buffer.alloc(1), {});
  const browser = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  await chain.createTraderAccount('trader-a.' + ROOT, 7n, browser);
  assert.deepEqual(f.sent.map(({ signer, receiver, actions }) => [signer, receiver, actions]), [
    [ROOT, 'market-a.' + ROOT, ['createAccount', 'transfer:5', 'addKey:' + marketPk]],
    ['market-a.' + ROOT, 'market-a.' + ROOT, ['deploy', 'call:init', 'deleteKey:' + marketPk]],
    [ROOT, 'trader-a.' + ROOT, ['createAccount', 'transfer:7', 'addKey:' + browser]],
  ]);

  assert.equal(await chain.accountState('missing.' + ROOT), null);
  assert.deepEqual(await chain.accessKeys('x.' + ROOT), [
    { public_key: 'ed25519:k', permission: 'FullAccess' }, { public_key: 'ed25519:f', permission: 'FunctionCall' },
  ]);
  assert.equal(await chain.finalHeight(), 42);
});

test('keeper secrets are split per actor and only Keeper B gets a transaction key', async () => {
  const f = fake();
  const adapter = await createTestnetAdapter({ ...f, finalize: async () => {} });
  assert.deepEqual(adapter.keeperSecrets(0, { withTxKey: false }),
    { encryption: 'KEEPER_A-ENCRYPTION_SECRET', signing: 'KEEPER_A-ACK_SECRET' });
  assert.deepEqual(adapter.keeperSecrets(1, { withTxKey: true }),
    { encryption: 'KEEPER_B-ENCRYPTION_SECRET', txKey: f.roles.KEEPER_B.key.toString() });
  assert.throws(() => adapter.keeperSecrets(0, { withTxKey: true }), /only Keeper B/);
  assert.deepEqual(adapter.keeperEncryptionKeys, ['KEEPER_A-ENCRYPTION_PUBLIC', 'KEEPER_B-ENCRYPTION_PUBLIC']);
  assert.ok(adapter.ids.forbidden.includes(IDS.MARKET));
  assert.ok(!JSON.stringify({ ...adapter, keeperSecrets: undefined, chain: undefined }).includes('SECRET'));
});

test('failed transactions report a redacted failure', async () => {
  const f = fake();
  f.accounts.ORACLE.callRaw = async () => ({
    succeeded: false, receiptFailures: [{}], failures: [{ error: 'ERR_PRICE_RANGE ed25519:5Kd3NBUAdUnhyzenEwVLy9pB' }],
    transactionReceipt: { hash: 'h' },
  });
  const adapter = await createTestnetAdapter({ ...f, finalize: async () => {} });
  await assert.rejects(adapter.chain.call('ORACLE', 'market-a.' + ROOT, 'publish_oracle', {}), (error) => {
    assert.match(error.message, /publish_oracle failed: .*ERR_PRICE_RANGE/);
    assert.doesNotMatch(error.message, /5Kd3N/);
    return true;
  });
});
