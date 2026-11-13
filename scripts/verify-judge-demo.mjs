import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Rpc, TESTNET_RPC } from '../exchange/src/protocol/rpc.js';

const receipts = JSON.parse(await readFile(new URL('../docs/quiet-margin-demo-receipts.json', import.meta.url), 'utf8'));
const rpc = new Rpc(TESTNET_RPC);

async function verify(row) {
  const [tx, block] = await Promise.all([
    rpc.txFinal(row.hash, row.signer),
    rpc.call('block', { block_id: row.block }),
  ]);
  assert.equal(tx.final_execution_status, 'FINAL');
  assert.equal(tx.transaction.hash, row.hash);
  assert.equal(tx.transaction.signer_id, row.signer);
  assert.equal(tx.transaction_outcome.block_hash, row.block);
  assert.equal(block.header.hash, row.block);
  assert.equal(block.header.height, row.height);
  assert.equal(tx.transaction.actions.length, 1);
  const call = tx.transaction.actions[0].FunctionCall;
  assert.equal(call.method_name, row.method);
  const outcomes = tx.receipts_outcome.map(({ outcome }) => outcome);
  const failures = outcomes.flatMap(({ status }) => status.Failure ? [status.Failure] : []);
  if (row.status === 'Success') {
    assert.equal(failures.length, 0);
    assert(Object.hasOwn(tx.status, 'SuccessValue'));
  } else {
    assert(JSON.stringify(failures).includes(row.status), 'Expected rejection ' + row.status);
  }
  const args = JSON.parse(Buffer.from(call.args, 'base64'));
  const events = outcomes.flatMap(({ logs }) => logs
    .filter((line) => line.startsWith('EVENT_JSON:'))
    .map((line) => JSON.parse(line.slice('EVENT_JSON:'.length))));
  return { args, events, signer: row.signer, receiver: tx.transaction.receiver_id };
}

const records = new Map();
for (let i = 0; i < receipts.length; i += 4) {
  await Promise.all(receipts.slice(i, i + 4).map(async (row) => {
    try {
      records.set(row.id, await verify(row));
    } catch (error) {
      throw new Error('Verification failed for ' + row.label, { cause: error });
    }
  }));
}
assert.equal(records.size, 16);
const [fund, deposit, mark, open, close, exit] = ['fund', 'deposit', 'mark', 'open', 'close', 'withdraw']
  .map((id) => records.get(id));
assert.equal(fund.args.receiver_id, deposit.signer);
assert.equal(fund.args.amount, '10000');
assert.equal(deposit.args.amount, '10000');
assert.equal(deposit.args.receiver_id, open.receiver);
assert.equal(mark.receiver, open.receiver);
assert.equal(close.receiver, open.receiver);
assert.equal(exit.receiver, open.receiver);
assert.equal(mark.args.price_ticks, 6882);
assert.equal(open.args.entry_ticks, mark.args.price_ticks);
assert(!['margin', 'lots', 'short', 'size'].some((key) => Object.hasOwn(open.args, key)));
assert(!JSON.stringify(open.args).includes(deposit.signer));
assert.notEqual(open.signer, deposit.signer);
assert.equal(close.signer, open.signer);
assert.equal(exit.signer, open.signer);
assert.equal(close.args.commitment, open.args.commitment);
assert.equal(close.args.maker_credit, '60000');
assert(close.events.some((event) => event.event === 'position_closed'));
assert.equal(exit.args.amount, '1000');
assert.equal(exit.args.recipient, deposit.signer);
assert(exit.events.some((event) => event.standard === 'nep141' && event.event === 'ft_transfer'
  && event.data.some((entry) => entry.amount === '1000' && entry.new_owner_id === deposit.signer)));

for (const [side, adversePrice, equityCents] of [['long', 4000, 120], ['short', 9600, 280]]) {
  const [opened, healthy, rejected, adverse, accepted] = ['open', 'healthy', 'reject', 'adverse', 'accept']
    .map((stage) => records.get(side + '-' + stage));
  assert([healthy, rejected, adverse, accepted].every(({ receiver }) => receiver === opened.receiver));
  assert.equal(healthy.args.price_ticks, 6880);
  assert.equal(adverse.args.price_ticks, adversePrice);
  assert.equal(rejected.args.commitment, opened.args.commitment);
  assert.equal(accepted.args.commitment, opened.args.commitment);
  assert.equal(accepted.signer, 'keeper-b.qm-treasury-a280bef3.testnet');
  assert.notEqual(accepted.signer, opened.signer);
  assert(accepted.events.some((event) => event.event === 'position_liquidated'));
  // Both controlled test positions were opened with 30.00 mUSDC of margin.
  assert.equal(63000 - Number(accepted.args.maker_credit), equityCents);
}
console.log('PASS: 16 finalized NEAR testnet transactions and inclusion blocks.');
console.log('PASS: live mark, private open and close, public withdrawal, and both keeper outcomes.');
