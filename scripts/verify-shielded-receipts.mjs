import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const evidence = JSON.parse(await readFile(new URL('../docs/shielded-testnet-receipts.json', import.meta.url), 'utf8'));
const { wallet, pool, token, deposits } = evidence;
const leaves = await Promise.all(deposits.map(async ({ hash, cents }) => {
  const response = await fetch('https://test.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: hash, method: 'tx', params: {
      tx_hash: hash, sender_account_id: wallet, wait_until: 'FINAL',
    } }),
    signal: AbortSignal.timeout(25_000),
  });
  assert(response.ok, 'NEAR RPC HTTP ' + response.status);
  const { result, error } = await response.json();
  assert(result, JSON.stringify(error));
  const { transaction, receipts_outcome, status } = result;
  assert.equal(result.final_execution_status, 'FINAL');
  assert(Object.hasOwn(status, 'SuccessValue'));
  assert.equal(transaction.hash, hash);
  assert.equal(transaction.signer_id, wallet);
  assert.equal(transaction.receiver_id, token);
  assert.equal(transaction.actions.length, 1);
  assert(receipts_outcome.every(({ outcome }) => !Object.hasOwn(outcome.status, 'Failure')));
  const call = transaction.actions[0].FunctionCall;
  const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
  assert.equal(call.method_name, 'ft_transfer_call');
  assert.equal(args.receiver_id, pool);
  assert.equal(args.amount, cents);

  const prefix = 'EVENT_JSON:';
  const event = receipts_outcome
    .filter(({ outcome }) => outcome.executor_id === pool)
    .flatMap(({ outcome }) => outcome.logs)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)))
    .find((event) => event.standard === 'quiet_margin_pool' && event.event === 'note_deposited');
  assert.equal(event?.data[0]?.amount, cents);
  const leaf = event.data[0].leaf;
  assert.equal(Buffer.from(leaf, 'base64').length, 32);
  console.log((Number(cents) / 100) + ' mUSDC deposit verified', hash);
  return leaf;
}));
assert.equal(new Set(leaves).size, deposits.length);
console.log('Each deposit created a distinct note in the same NEAR testnet pool.');
