import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
