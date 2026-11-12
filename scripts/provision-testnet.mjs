import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectChain, demoAccounts, loadDemoEnv, TESTNET_DIR, TESTNET_RPC, waitFinal } from './testnet-client.mjs';

const NEAR = 10n ** 24n;
const initialBalances = {
  MARKET: 32n * NEAR / 10n,
  TOKEN: 24n * NEAR / 10n,
  TRADER: NEAR / 5n,
  MAKER: NEAR / 5n,
  ORACLE: NEAR / 5n,
  KEEPER_A: NEAR / 5n,
  KEEPER_B: NEAR / 5n,
};

const { roles } = loadDemoEnv();
const chain = await connectChain(TESTNET_RPC, true);
const accounts = await demoAccounts(chain, roles);
const journalPath = join(TESTNET_DIR, 'accounts.json');
await mkdir(TESTNET_DIR, { recursive: true });
let journal = {};
try {
  journal = JSON.parse(await readFile(journalPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const assertKey = async (role) => {
  const account = accounts[role];
  const publicKey = roles[role].key.getPublicKey();
  const key = await chain.provider.query({
    request_type: 'view_access_key', finality: 'final',
    account_id: account.accountId, public_key: publicKey.toString(),
  });
  assert.equal(key.permission, 'FullAccess');
  return publicKey.toString();
};

journal.DEMO = { account: accounts.DEMO.accountId, public_key: await assertKey('DEMO') };
for (const [role, balance] of Object.entries(initialBalances)) {
  const child = accounts[role];
  if (!(await child.exists())) {
    const tx = await accounts.DEMO.batch(child)
      .createAccount()
      .transfer(balance)
      .addKey(roles[role].key.getPublicKey())
      .transact();
    assert.ok(tx.succeeded && tx.receiptFailures.length === 0, JSON.stringify(tx.status));
    journal[role] = { creation_tx: tx.transactionReceipt.hash };
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n');
    await waitFinal(chain, tx);
  }
  journal[role] = { ...journal[role], account: child.accountId, public_key: await assertKey(role) };
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n');
  console.log(role + ' ' + child.accountId + ' verified');
}
