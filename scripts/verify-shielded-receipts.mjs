import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const browser = process.argv.includes('--browser');
const evidenceFile = browser ? 'browser-pool-testnet-receipts.json' : 'shielded-testnet-receipts.json';
const evidence = JSON.parse(await readFile(new URL('../docs/' + evidenceFile, import.meta.url), 'utf8'));
const { wallet, pool, token, deposits, lifecycle } = evidence;
const rpc = 'https://test.rpc.fastnear.com';

async function callRpc(method, params) {
  const response = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  assert(response.ok, 'NEAR RPC HTTP ' + response.status);
  const { result, error } = await response.json();
  assert(result, JSON.stringify(error));
  return result;
}

async function tx(hash, signer, receiver, method) {
  const result = await callRpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
  const { transaction, receipts_outcome: receipts, status } = result;
  assert.equal(result.final_execution_status, 'FINAL');
  assert(Object.hasOwn(status, 'SuccessValue'));
  assert.equal(transaction.hash, hash);
  assert.equal(transaction.signer_id, signer);
  assert.equal(transaction.receiver_id, receiver);
  assert.equal(transaction.actions.length, 1);
  assert(receipts.every(({ outcome }) => !Object.hasOwn(outcome.status, 'Failure')));
  const call = transaction.actions[0].FunctionCall;
  assert.equal(call.method_name, method);
  const args = JSON.parse(Buffer.from(call.args, 'base64'));
  const prefix = 'EVENT_JSON:';
  const events = receipts.flatMap(({ outcome }) => outcome.logs
    .filter((line) => line.startsWith(prefix))
    .map((line) => ({ contract: outcome.executor_id, ...JSON.parse(line.slice(prefix.length)) })));
  return { transaction, args, events, result };
}

function event(record, contract, name, standard = 'quiet_margin_pool') {
  const match = record.events.find((item) => item.contract === contract && item.event === name && item.standard === standard);
  assert(match, 'Missing event ' + name);
  return match.data[0];
}

const leaves = await Promise.all(deposits.map(async ({ hash, cents }) => {
  const record = await tx(hash, wallet, token, 'ft_transfer_call');
  assert.equal(record.args.receiver_id, pool);
  assert.equal(record.args.amount, cents);
  const note = event(record, pool, 'note_deposited');
  assert.equal(note.amount, cents);
  assert.equal(Buffer.from(note.leaf, 'base64').length, 32);
  console.log((Number(cents) / 100) + ' mUSDC deposit verified', hash);
  return note.leaf;
}));
assert.equal(new Set(leaves).size, deposits.length);

if (lifecycle) {
  const { trader, open, close, withdrawal, block, height } = lifecycle;
  assert.notEqual(trader, wallet);
  const [opened, closed, exited, inclusion] = await Promise.all([
    tx(open, trader, pool, 'open_private'), tx(close, trader, pool, 'close_private'),
    tx(withdrawal, trader, pool, 'withdraw_private'), callRpc('block', { block_id: block }),
  ]);
  assert.equal(inclusion.header.hash, block);
  assert.equal(inclusion.header.height, height);
  assert.equal(opened.result.transaction_outcome.block_hash, block);
  assert.deepEqual(Object.keys(opened.args).sort(), ['change', 'commitment', 'context', 'entry_ticks', 'nullifiers', 'owner_tag', 'proof', 'root']);
  for (const record of [opened, closed]) assert(!JSON.stringify(record.transaction).includes(wallet));
  const empty = Buffer.alloc(32).toString('base64');
  assert.equal(new Set(opened.args.nullifiers).size, 2);
  assert(opened.args.nullifiers.every((n) => n !== empty));
  assert.notEqual(opened.args.change, empty);
  assert.equal(event(opened, pool, 'position_opened').change, opened.args.change);
  assert.equal(event(opened, pool, 'position_opened').commitment, opened.args.commitment);
  assert.equal(event(closed, pool, 'position_closed').commitment, opened.args.commitment);
  assert.notEqual(event(closed, pool, 'position_closed').payout_note, empty);
  assert.equal(exited.args.recipient, wallet);
  assert.equal(exited.args.amount, '10000');
  assert.equal(event(exited, pool, 'withdrawn').change, empty);
  const transfer = event(exited, token, 'ft_transfer', 'nep141');
  assert.equal(transfer.old_owner_id, pool);
  assert.equal(transfer.new_owner_id, wallet);
  assert.equal(transfer.amount, '10000');
  console.log('Private open, close, withdrawal and NEAR block verified.');
}
