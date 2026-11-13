// Testnet only. Keep the operator credentials in the existing ignored .env files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { KeyPair } from 'near-workspaces';
import { connectChain, demoAccounts, TESTNET_RPC, viewFinal, waitFinal } from './testnet-client.mjs';

const root = new URL('../', import.meta.url);
const file = (name) => new URL(name, root);
const env = parseEnv(readFileSync(file('.testnet/quiet-margin-wallet-recording/treasury.env'), 'utf8'));
const wallet = parseEnv(readFileSync(file('.testnet/quiet-margin-wallet-recording/.env'), 'utf8')).NEAR_ACCOUNT_ID;
assert.equal(env.NEAR_NETWORK_ID, 'testnet');
assert.equal(env.NEAR_RPC_URL, TESTNET_RPC);
const args = process.argv.slice(2);
const keeperPool = args[0] === '--keeper-pool' || args[0] === '--keeper-pool-live';
const liveOracle = args[0] === '--keeper-pool-live';
const judgePool = keeperPool || args[0] === '--judge-pool';
const browserPool = judgePool || args[0] === '--browser-pool';
if (browserPool) args.shift();
const pool = (keeperPool ? (liveOracle ? 'live-pool.' : 'keeper-pool.') : judgePool ? 'judge-pool.' : browserPool ? 'browser-pool.' : 'shielded.') + env.NEAR_DEMO_ACCOUNT_ID;
const keyDir = judgePool ? 'judge-side-keys' : browserPool ? 'browser-keys' : 'keys';
const token = env.NEAR_TOKEN_ACCOUNT_ID;
const oracle = env.NEAR_ORACLE_ACCOUNT_ID;
const maker = env.NEAR_DEMO_ACCOUNT_ID;
const keys = Object.fromEntries(['spend', 'close'].map((kind) => {
  const vk = readFileSync(file('.testnet/shielded/' + keyDir + '/' + kind + '.vk'));
  return [kind, { bytes: vk.toString('base64'), fingerprint: createHash('sha256').update(vk).digest('base64') }];
}));
const liquidation = keeperPool ? readFileSync(file('.testnet/shielded/keeper-v3-keys/liquidation.vk')) : null;
const keepers = keeperPool ? ['KEEPER_A', 'KEEPER_B'].map((role) => ({
  account: env['NEAR_' + role + '_ACCOUNT_ID'],
  encryption_key: env['NEAR_' + role + '_ENCRYPTION_PUBLIC'],
  acknowledgment_key: env['NEAR_' + role + '_ACK_PUBLIC'],
})) : null;
const wasm = readFileSync(file('target/' + (keeperPool ? 'keeper-pool' : browserPool ? 'browser-pool' : 'pool-build') + '/wasm32-unknown-unknown/release/xythum_near_perps.wasm'));
const chain = await connectChain(TESTNET_RPC, true);
const marketKey = KeyPair.fromString(env.NEAR_MARKET_SECRET_KEY);
const { DEMO, POOL, ORACLE } = await demoAccounts(chain, {
  DEMO: { id: maker, key: KeyPair.fromString(env.NEAR_DEMO_SECRET_KEY) },
  POOL: { id: pool, key: marketKey },
  ORACLE: { id: oracle, key: KeyPair.fromString(env.NEAR_ORACLE_SECRET_KEY) },
});
const view = (id, method, args) => viewFinal(chain, id, method, args);
const record = { pool, token, oracle, wallet, keyFingerprints: { spend: keys.spend.fingerprint, close: keys.close.fingerprint } };
const journal = file('.testnet/shielded/' + (keeperPool ? (liveOracle ? 'live-deployment.json' : 'keeper-deployment.json') : judgePool ? 'judge-deployment.json' : browserPool ? 'browser-deployment.json' : 'deployment.json'));
try { Object.assign(record, JSON.parse(readFileSync(journal, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.equal(record.pool, pool);
assert.equal(record.token, token);
const gas = 100_000_000_000_000n;
async function track(name, transaction) {
  const tx = await transaction;
  assert(tx.succeeded && tx.receiptFailures.length === 0, name + ': ' + JSON.stringify(tx.failures));
  await waitFinal(chain, tx);
  record[name] = tx.transactionReceipt.hash;
  writeFileSync(journal, JSON.stringify(record, null, 2) + '\n');
  return tx;
}
async function account(id) {
  try {
    return await chain.provider.query({ request_type: 'view_account', account_id: id, finality: 'final' });
  } catch (error) {
    if (/does not exist|doesn't exist|UNKNOWN_ACCOUNT/i.test(String(error.message))) return null;
    throw error;
  }
}
if (args.length > 0) {
  const [command, id] = args;
  assert(command === '--activate' && /^[a-f0-9]{64}$/.test(id), 'Use --activate with an implicit NEAR account.');
  const funded = BigInt((await account(id))?.amount ?? 0);
  const target = (browserPool ? 35n : 15n) * 10n ** 22n;
  if (funded < target) {
    const tx = await DEMO.batch(id).transfer(target - funded).transact();
    assert(tx.succeeded && tx.receiptFailures.length === 0, 'Testnet gas funding failed.');
    await waitFinal(chain, tx);
    console.log('Testnet gas funding:', tx.transactionReceipt.hash);
  }
  assert(await account(id), 'Implicit testnet account is unavailable.');
  process.exit(0);
}
let state = await account(pool);
if (!state) {
  const funds = BigInt(wasm.length + 20_000) * 10n ** 19n + (keeperPool ? 10n : 30n) * 10n ** 22n;
  assert(BigInt((await account(maker)).amount) > funds + (keeperPool ? 15n : 50n) * 10n ** 22n, 'Treasury needs more test NEAR.');
  await track('create', DEMO.batch(pool).createAccount().transfer(funds).addKey(marketKey.getPublicKey()).transact());
  state = await account(pool);
}
if (/^1+$/.test(state.code_hash)) {
  await track('deploy', POOL.batch(POOL).deployContract(wasm).functionCall('init', {
    token, maker, oracle, spend_vk: keys.spend.bytes, close_vk: keys.close.bytes,
    ...(keeperPool ? { liquidation_vk: liquidation.toString("base64"), keepers, live_oracle: liveOracle } : {}),
  }, { gas }).deleteKey(marketKey.getPublicKey()).transact());
}
const call = (signer, target, method, args, deposit = 0n) =>
  signer.callRaw(target, method, args, { gas, attachedDeposit: deposit });
const poolView = await view(pool, 'get_pool');
assert.equal(poolView.token, token);
assert.equal(poolView.spend_vk_sha256, keys.spend.fingerprint);
assert.equal(poolView.close_vk_sha256, keys.close.fingerprint);
for (const [name, id] of [['pool', pool], ['wallet', wallet]]) {
  if (!await view(token, 'storage_balance_of', { account_id: id })) {
    await track(name + '_registration', call(DEMO, token, 'storage_deposit', {
      account_id: id, registration_only: true,
    }, 10n ** 22n));
  }
}
const makerReserve = keeperPool ? (liveOracle ? 60_000 : 120_000) : judgePool ? 360_000 : 60_000;
if (Number(poolView.maker_available) < makerReserve) {
  await track('maker_reserve', call(DEMO, token, 'ft_transfer_call', {
    receiver_id: pool, amount: String(makerReserve - Number(poolView.maker_available)), msg: 'maker',
  }, 1n));
}
if (!poolView.round && !liveOracle) await track('mark', call(ORACLE, pool, 'publish_mark', { price_ticks: 6880 }));
if (!record.wallet_funding && Number(await view(token, 'ft_balance_of', { account_id: wallet })) < 10_000) {
  await track('wallet_funding', call(DEMO, token, 'ft_transfer', { receiver_id: wallet, amount: '10000' }, 1n));
}
const data = { pool, token, spendVk: keys.spend.fingerprint, closeVk: keys.close.fingerprint };
if (browserPool) data.proofVersion = keeperPool ? 'poseidon-v3' : judgePool ? 'poseidon-v2' : 'poseidon-v1';
if (keeperPool) data.liveOracle = liveOracle;
mkdirSync(file('exchange/public/shielded/'), { recursive: true });
// Browser artifacts for a new deployment must be published together. Keep its
// generated config beside its keys until the operator stages the static bundle.
const configPath = keeperPool ? '.testnet/shielded/' + (liveOracle ? 'live-config.json' : 'keeper-config.json') : browserPool ? '.testnet/shielded/' + keyDir + '/config.json' : 'exchange/public/shielded/config.json';
writeFileSync(file(configPath), JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
