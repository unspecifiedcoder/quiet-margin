import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Rpc, TESTNET_RPC } from '../exchange/src/protocol/rpc.js';

const [controlled, live] = await Promise.all(['pool-liquidation-testnet', 'pool-live-settlement-testnet']
  .map(async (name) => JSON.parse(await readFile(new URL('../docs/' + name + '.json', import.meta.url)))));
const rpc = new Rpc(TESTNET_RPC);
const prefix = 'EVENT_JSON:';
const publicTx = async ({ hash, signer, block }, receiver, method, error) => {
  const result = await rpc.txFinal(hash, signer);
  const { transaction, receipts_outcome: receipts, status } = result;
  assert.equal(result.final_execution_status, 'FINAL');
  assert.equal(transaction.hash, hash);
  assert.equal(transaction.signer_id, signer);
  assert.equal(transaction.receiver_id, receiver);
  if (block) assert.equal(result.transaction_outcome.block_hash, block);
  assert.equal(transaction.actions.length, 1);
  const action = transaction.actions[0].FunctionCall;
  assert.equal(action.method_name, method);
  const args = JSON.parse(Buffer.from(action.args, 'base64'));
  const failures = receipts.map((r) => r.outcome.status.Failure).filter(Boolean);
  if (error) assert.match(JSON.stringify(failures), error);
  else {
    assert.equal(failures.length, 0);
    assert(Object.hasOwn(status, 'SuccessValue'));
  }
  const event = (name) => receipts.filter((r) => r.outcome.executor_id === receiver).flatMap((r) => r.outcome.logs)
    .filter((log) => log.startsWith(prefix)).map((log) => JSON.parse(log.slice(prefix.length)))
    .find((record) => record.standard === 'quiet_margin_pool' && record.event === name)?.data[0];
  return { args, event };
};
for (const row of controlled.positions) {
  const pool = controlled.pool;
  const [open, healthy, rejected, trigger, liquidation] = await Promise.all([
    publicTx(row.open, pool, 'open_private'),
    publicTx(row.healthyMark, pool, 'publish_mark'),
    publicTx(row.healthyRejected, pool, 'liquidate_private', /ERR_PROOF_INVALID/),
    publicTx(row.triggerMark, pool, 'publish_mark'),
    publicTx(row.liquidation, pool, 'liquidate_private'),
    publicTx(row.replayRejected, pool, 'liquidate_private', /ERR_NO_POSITION/),
  ]);
  assert.equal(open.args.commitment, row.commitment);
  assert.equal(open.args.envelopes.length, 2);
  assert(open.args.envelopes.every((value) => Buffer.from(value, 'base64').length === 113));
  assert(!['margin', 'lots', 'short', 'size'].some((key) => Object.hasOwn(open.args, key)));
  assert.equal(rejected.args.commitment, row.commitment);
  assert.equal(healthy.args.price_ticks, 6880);
  assert.equal(trigger.args.price_ticks, row.short ? 9600 : 4000);
  assert.notEqual(row.open.signer, row.liquidation.signer);
  assert.equal(row.liquidation.signer, controlled.keeper);
  const settled = liquidation.event('position_liquidated');
  assert.equal(settled.commitment, row.commitment);
  assert.notEqual(settled.payout_note, Buffer.alloc(32).toString('base64'));
  assert.equal(63000 - Number(settled.maker_credit), row.shieldedEquityCents);
  assert.equal(await rpc.view(pool, 'get_liquidation_credit', { commitment: row.commitment }), settled.maker_credit);
  console.log((row.short ? 'Short' : 'Long') + ': healthy rejection, keeper settlement and replay rejection verified.');
}
await publicTx(controlled.badAck, controlled.pool, 'open_private', /ERR_KEEPER_ACK/);
const [trade] = live.positions;
assert.notEqual(trade.deposit.signer, trade.open.signer);
const [mark, open, close] = await Promise.all([
  publicTx({ hash: live.liveMark.transaction, signer: live.oracle }, live.pool, 'publish_live_mark'),
  publicTx(trade.open, live.pool, 'open_private'), publicTx(trade.close, live.pool, 'close_private'),
]);
assert.equal(mark.args.observed_at, live.liveMark.observed_at);
assert.equal(mark.args.price_ticks, Math.round(Number(live.liveMark.sourcePrice) / 10));
assert.equal(open.args.entry_ticks, mark.args.price_ticks);
assert.equal(close.args.round, mark.event('mark_published').round);
assert.equal(close.event('position_closed').commitment, open.args.commitment);
console.log('Live BTC mark, private open and close verified.');
