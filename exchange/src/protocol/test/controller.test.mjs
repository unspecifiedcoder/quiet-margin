// End-to-end controller flows against the offline fake chain and server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from '../api.js';
import { toBase58, toBase64 } from '../bytes.js';
import { ExchangeController } from '../controller.js';
import { Rpc } from '../rpc.js';
import { memoryBackend, Store } from '../store.js';
import { createWorld, IDS } from './fake-near.mjs';

const noSleep = async () => {};

function makeController(world, store = new Store(memoryBackend())) {
  const states = [];
  const controller = new ExchangeController({
    api: new Api({ base: '/api', fetchImpl: world.apiFetch }),
    store,
    prover: world.prover,
    rpcFactory: (url) => new Rpc(url, { fetchImpl: world.rpcFetch }),
    onState: (s) => states.push(s),
    pollMs: 0,
    locks: null,
    sleep: noSleep,
    finalWaitMs: 50,
  });
  return { controller, store, states, last: () => states.at(-1) };
}

async function started(world) {
  const c = makeController(world);
  assert.equal(await c.controller.onStart(), true, c.last()?.error);
  return c;
}

const methodsCalled = (w, signer) => w.calls.filter((c) => c.signer === signer).map((c) => c.method);

test('full user flow: deposit, open, mark, close, withdraw', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await started(world);
  assert.equal(last().network, 'testnet');
  assert.equal(last().session.traderId, IDS.trader);
  assert.equal(last().session.custody, 'webcrypto-nonextractable');
  assert.equal(last().balances.wallet, 100_000);

  assert.equal(await controller.onSetMark(100_000), true, last().error);
  assert.equal(last().oracle.price_ticks, 10_000);
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), false);
  assert.match(last().error, /escrow/);

  assert.equal(await controller.onDeposit(700), true, last().error);
  assert.deepEqual([last().balances.wallet, last().balances.available], [30_000, 70_000]);

  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, last().error);
  const s = last();
  assert.equal(s.balances.locked, 60_000);
  assert.equal(s.position.sizeBtc, 0.01);
  assert.equal(s.position.marginUsd, 500);
  assert.equal(s.position.entryUsd, 100_000);
  assert.equal(s.position.pnlUsd, 0);
  assert.ok(Math.abs(s.position.liquidationUsd - 52_631.58) < 0.01);
  assert.deepEqual(s.active, { nonce: 1, commitment: s.position.commitment });
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open']);

  // The maker only ever saw size, entry and the quote blinder.
  const approve = w.serverBodies.find((b) => b.route === 'POST /session/approve');
  assert.deepEqual(Object.keys(approve.body).sort(), ['commitment', 'entry_ticks', 'nonce', 'quote_blinder', 'size_lots']);
  const posted = JSON.stringify(w.serverBodies.map((b) => b.body));
  assert.ok(!posted.includes('margin') && !posted.includes(w.keeperWitness.blinder), 'no witness reached the server');
  assert.equal(w.keeperWitness.margin_cents, 50_000);

  assert.equal(await controller.onSetMark(120_000), true, last().error);
  assert.equal(last().position.pnlUsd, 200);
  assert.equal(await controller.onArmKeeper(), true);
  assert.equal(last().keeperArmed, true);

  assert.equal(await controller.onClose(), true, last().error);
  assert.equal(last().active, null);
  assert.equal(last().position, null);
  assert.equal(last().balances.available, 10_000 + 80_000);
  assert.equal(world.prover.jobs.at(-1).kind, 'close');
  assert.equal(world.prover.jobs.at(-1).vk, w.config.close_vk_sha256);

  assert.equal(await controller.onWithdraw('198.00'), true, last().error);
  assert.deepEqual([last().balances.wallet, last().balances.available], [30_000 + 19_800, 70_200]);
  const labels = last().receipts.map((r) => r.label);
  for (const l of ['deposit', 'stage', 'maker approval', 'open', 'close', 'withdraw', 'mark']) assert.ok(labels.includes(l), l);
  assert.ok(last().receipts.every((r) => r.explorerUrl.startsWith('https://testnet.near.rocks/tx/')));
});

test('a failed approval resumes after reload without restaging or reproving', async () => {
  const world = await createWorld();
  const { w } = world;
  const first = await started(world);
  await first.controller.onSetMark(100_000);
  await first.controller.onDeposit(600);
  let failures = 1;
  w.hooks.api = async (route) => (route === 'POST /session/approve' && failures-- > 0
    ? new Response(JSON.stringify({ error: 'maker offline' }), { status: 503 }) : null);
  assert.equal(await first.controller.onOpen({ sizeBtc: '0.005', marginUsd: '200' }), false);
  assert.match(first.last().error, /maker offline/);
  assert.equal(first.last().busy, null);
  assert.ok(w.pending, 'stage landed');

  // Reload: a new controller over the same browser storage.
  const second = makeController(world, first.store);
  assert.equal(await second.controller.onStart(), true, second.last().error);
  assert.equal(await second.controller.onOpen({ sizeBtc: '0.005', marginUsd: '200' }), true, second.last().error);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open']);
  assert.equal(world.prover.jobs.length, 1);
  assert.equal(second.last().position.sizeBtc, 0.005);
});

test('a lost broadcast response is followed to FINAL instead of resent blindly', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await started(world);
  await controller.onSetMark(100_000);
  let drops = 0;
  // The broadcast executes but its response is lost, then one FINAL wait times out.
  w.hooks.dropResponse = (method) => method === 'send_tx' && drops++ === 0;
  let timeouts = 1;
  w.hooks.rpc = async (method) => (method === 'tx' && timeouts-- > 0
    ? { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } : undefined);
  assert.equal(await controller.onDeposit(10), true, last().error);
  assert.equal(methodsCalled(w, IDS.trader).length, 1);
});

test('ambiguous finality is reported, kept, and resolved before the next action', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, store } = await started(world);
  let hide = true;
  w.hooks.rpc = async (method) => (method === 'tx' && hide
    ? { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } : undefined);
  assert.equal(await controller.onDeposit(10), false);
  assert.match(last().error, /finality is not confirmed/);
  assert.ok(await store.get('journal'));
  assert.ok(last().receipts.some((r) => /pending finality/.test(r.label)));
  hide = false;
  assert.equal(await controller.onWithdraw(0.1), true, last().error);
  assert.equal(await store.get('journal'), undefined);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'withdraw']);
  assert.ok(last().receipts.some((r) => r.label === 'deposit'));
});

test('duplicate in-flight actions are refused', async () => {
  const world = await createWorld();
  const { controller, last } = await started(world);
  const [a, b] = await Promise.all([controller.onDeposit(1), controller.onDeposit(1)]);
  assert.deepEqual([a, b], [true, false]);
  assert.equal(methodsCalled(world.w, IDS.trader).length, 1);
  assert.equal(last().balances.available, 100);
});

test('a keeper liquidation is shown and erases the local opening', async () => {
  const world = await createWorld();
  const { controller, last, store } = await started(world);
  await controller.onSetMark(100_000);
  await controller.onDeposit(600);
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, last().error);
  await controller.onSetMark(52_000);
  assert.equal(last().position.liquidatable, true);
  const outcome = await world.keeperLiquidate();
  assert.ok(outcome.status.SuccessValue !== undefined, JSON.stringify(outcome.status));
  await controller.refresh();
  assert.equal(controller.snapshot().active, null);
  assert.match(controller.snapshot().notice, /settled on chain/);
  // Liquidation refund at $52,000: 10,000 unassigned escrow + 2,000 equity - 100 bounty.
  assert.equal(controller.snapshot().balances.available, 11_900);
  assert.equal(await store.get('opening'), undefined);
  assert.equal(await controller.onClose(), false);
});

// ---------------------------------------------------------------- Keeper B

const sessionGets = (w) => w.serverBodies.filter((b) => b.route === 'GET /session').length;
const receiptFor = (s, hash) => s.receipts.find((r) => r.hash === hash);

/** Opens 0.01 BTC with 500 USD margin at 100,000 and arms Keeper B while healthy. */
async function armedPosition(world, existing) {
  const c = existing ?? await started(world);
  const { controller, last } = c;
  assert.equal(await controller.onSetMark(100_000), true, last().error);
  assert.equal(await controller.onDeposit(600), true, last().error);
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, last().error);
  assert.equal(await controller.onArmKeeper(), true, last().error);
  assert.equal(last().keeperArmed, true);
  return c;
}

/** Moves the mark to 52,000 and lets Keeper B liquidate in the background. */
async function backgroundLiquidation(world, controller) {
  assert.equal(await controller.onSetMark(52_000), true, controller.snapshot().error);
  const outcome = await world.keeperLiquidate();
  assert.ok(outcome.status.SuccessValue !== undefined, JSON.stringify(outcome.status));
  return outcome.transaction.hash;
}

test('a background Keeper B liquidation appears verified in the same open tab', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, store } = await armedPosition(world);
  const hash = await backgroundLiquidation(world, controller);
  assert.equal(last().keeperArmed, true, 'nothing observed yet');

  const gets = sessionGets(w);
  await controller.poll();
  assert.equal(sessionGets(w), gets + 1, 'one coordinator read while armed');
  const s = last();
  assert.equal(s.keeperArmed, false);
  assert.equal(s.active, null);
  assert.equal(s.position, null);
  assert.equal(s.balances.available, 11_900);
  assert.deepEqual(receiptFor(s, hash), {
    label: 'liquidation_1', hash, explorerUrl: 'https://testnet.near.rocks/tx/' + hash,
  });
  assert.match(s.notice, new RegExp('Keeper B liquidated position nonce 1 on chain in ' + hash));
  assert.equal(await store.get('keeper'), undefined);
  assert.equal(await store.get('opening'), undefined);

  // Settled: polling goes back to chain reads only, and the receipt is not duplicated.
  await controller.poll();
  assert.equal(sessionGets(w), gets + 1);
  assert.equal(last().receipts.filter((r) => r.hash === hash).length, 1);
});

test('a coordinator outage never blocks chain refresh and the result lands when it returns', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await armedPosition(world);
  const hash = await backgroundLiquidation(world, controller);
  w.hooks.api = async (route) => (route === 'GET /session'
    ? new Response(JSON.stringify({ error: 'coordinator restarting' }), { status: 503 }) : null);
  await controller.poll();
  let s = last();
  assert.equal(s.error, null, 'the outage is not a trading error');
  assert.equal(s.active, null, 'the finalized chain view still moved');
  assert.equal(s.balances.available, 11_900);
  assert.equal(s.keeperArmed, false, 'never shown armed over a settled slot');
  assert.equal(receiptFor(s, hash), undefined);

  w.hooks.api = null;
  await controller.poll();
  s = last();
  assert.equal(receiptFor(s, hash)?.label, 'liquidation_1');
  assert.match(s.notice, /Keeper B liquidated position nonce 1/);
});

test('resume after being offline picks up and verifies the Keeper B liquidation', async () => {
  const world = await createWorld();
  const first = await armedPosition(world);
  const hash = await backgroundLiquidation(world, first.controller);
  // The tab was closed before it could observe anything.
  assert.equal(first.last().keeperArmed, true);

  const reload = makeController(world, first.store);
  assert.equal(await reload.controller.onResume(), true, reload.last()?.error);
  const s = reload.last();
  assert.equal(s.keeperArmed, false);
  assert.equal(s.active, null);
  assert.equal(receiptFor(s, hash)?.label, 'liquidation_1', 'verified, not server-reported');
  assert.match(s.notice, /Keeper B liquidated position nonce 1/);
  assert.equal(await reload.store.get('keeper'), undefined);

  // A second reload neither re-verifies nor downgrades receipts it already holds.
  const again = makeController(world, first.store);
  assert.equal(await again.controller.onResume(), true, again.last()?.error);
  assert.equal(receiptFor(again.last(), hash)?.label, 'liquidation_1');
  assert.ok(again.last().receipts.some((r) => r.label === 'maker approval'));
  assert.ok(!again.last().receipts.some((r) => /^maker approval \(/.test(r.label)));
});

test('arming a distressed position reports its immediate verified liquidation', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, store } = await started(world);
  await controller.onSetMark(100_000);
  await controller.onDeposit(600);
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, last().error);
  await controller.onSetMark(52_000);
  assert.equal(last().position.liquidatable, true);

  assert.equal(await controller.onArmKeeper(), true, last().error);
  const s = last();
  const hash = [...w.txs.values()].find((o) => o.transaction.signer_id === IDS.keeperB).transaction.hash;
  assert.equal(s.error, null);
  assert.equal(s.keeperArmed, false);
  assert.equal(s.active, null);
  assert.equal(receiptFor(s, hash)?.label, 'liquidation_1');
  assert.match(s.notice, /Keeper B liquidated position nonce 1/);
  assert.equal(await store.get('keeper'), undefined);
});

test('an unverifiable immediate liquidation is refused, not shown as armed', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await started(world);
  await controller.onSetMark(100_000);
  await controller.onDeposit(600);
  await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 });
  const makerHash = last().receipts.find((r) => r.label === 'maker approval').hash;
  w.hooks.api = async (route) => (route === 'POST /session/keeper'
    ? new Response(JSON.stringify({ keeper_armed: false, receipt: { label: 'liquidation_1', hash: makerHash } }), { status: 200 })
    : null);
  assert.equal(await controller.onArmKeeper(), false);
  assert.match(last().error, /does not verify on chain/);
  assert.equal(last().keeperArmed, false);
  assert.ok(last().active, 'nothing was settled');
});

test('the next position can be armed after a Keeper B settlement', async () => {
  const world = await createWorld();
  const { w } = world;
  const c = await armedPosition(world);
  await backgroundLiquidation(world, c.controller);
  await c.controller.poll();
  assert.equal(c.last().keeperArmed, false);

  w.balances.set(IDS.trader, w.balances.get(IDS.trader) + 60_000); // faucet top-up
  await armedPosition(world, c);
  const s = c.last();
  assert.equal(s.active.nonce, 2);
  assert.equal(s.keeperArmed, true);
  assert.deepEqual(await c.store.get('keeper'), {
    market_id: IDS.market, nonce: 2, commitment: s.active.commitment,
  });
  // The settled slot's receipt cannot settle the new slot.
  await c.controller.poll();
  assert.equal(c.last().keeperArmed, true);
  assert.ok(c.last().active);

  await backgroundLiquidation(world, c.controller);
  await c.controller.poll();
  assert.equal(c.last().keeperArmed, false);
  assert.match(c.last().notice, /nonce 2/);
  assert.equal(c.last().receipts.filter((r) => /^liquidation_\d$/.test(r.label)).length, 2);
  assert.equal(methodsCalled(w, IDS.keeperB).length, 2);
});

test('a coordinator view for another session or a forged liquidation receipt changes nothing', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await armedPosition(world);
  const makerHash = last().receipts.find((r) => r.label === 'maker approval').hash;

  w.hooks.session = () => ({ trader_id: 'someone-else.testnet' });
  await controller.poll();
  assert.match(last().error, /coordinator view changed trader_id/);
  assert.equal(last().keeperArmed, true);

  w.hooks.session = () => ({ keeper_armed: false, receipts: [{ label: 'liquidation_1', hash: makerHash }] });
  await controller.poll();
  const s = last();
  assert.ok(s.active, 'still open on chain');
  assert.ok(!/Keeper B liquidated/.test(s.notice ?? ''));
  assert.equal(receiptFor(s, makerHash).label, 'maker approval', 'a forged label never overwrites a held receipt');
  assert.equal(controller.keeperRejected.has(makerHash), true);

  // A forged receipt under a hash this browser has never seen is shown as such.
  const unknown = toBase58(new Uint8Array(32).fill(5));
  w.hooks.rpc = async (method, params) => (method === 'tx' && params.tx_hash === unknown
    ? { result: { ...w.txs.get(makerHash), transaction: { ...w.txs.get(makerHash).transaction, hash: unknown } } }
    : undefined);
  w.hooks.session = () => ({ receipts: [{ label: 'liquidation_1', hash: unknown }] });
  assert.equal(await controller.onArmKeeper(), true, last().error);
  await controller.poll();
  assert.equal(last().keeperArmed, true);
  assert.ok(last().active);
  assert.equal(receiptFor(last(), unknown)?.label, 'liquidation_1 (failed on-chain verification)');
});

// ------------------------------------------------------- oracle liveness

const routeBodies = (w, route) => w.serverBodies.filter((b) => b.route === route);
const marks = (w) => routeBodies(w, 'POST /session/mark').length;
const refreshes = (w) => routeBodies(w, 'POST /session/refresh');
const oraclePublishes = (w) => w.calls.filter((c) => c.signer === IDS.oracle && c.method === 'publish_oracle');
const closeJobs = (world) => world.prover.jobs.filter((j) => j.kind === 'close');

/** Deposits and opens 0.01 BTC at 100,000, then forbids every further user test mark. */
async function openWithoutMarks(world) {
  const c = await started(world);
  assert.equal(await c.controller.onSetMark(100_000), true, c.last().error);
  assert.equal(await c.controller.onDeposit(600), true, c.last().error);
  assert.equal(await c.controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, c.last().error);
  world.w.markQuota = 0;
  return { ...c, marksBefore: marks(world.w), active: c.last().active };
}

test('close with a fresh final oracle uses it directly, even with the mark quota exhausted', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, marksBefore, active } = await openWithoutMarks(world);
  assert.equal(await controller.onSetMark(110_000), false, 'quota is exhausted');
  assert.match(last().error, /quota exhausted/);
  const publishes = oraclePublishes(w).length;

  assert.equal(await controller.onClose(), true, last().error);
  assert.equal(marks(w), marksBefore + 1, 'only the refused user mark, none from close');
  assert.equal(refreshes(w).length, 0, 'a fresh oracle needs no refresh');
  assert.equal(oraclePublishes(w).length, publishes);
  assert.equal(last().active, null);
  const [close] = w.calls.filter((c) => c.method === 'close');
  assert.deepEqual([close.args.nonce, close.args.root], [active.nonce, active.commitment]);
});

test('a stale oracle is refreshed at the same price for close during a mark cooldown', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, marksBefore } = await openWithoutMarks(world);
  w.markQuota = Infinity;
  w.markCooldown = true;
  const before = { ...w.oracle };
  w.height += 700; // older than the staging threshold, still valid on chain

  assert.equal(await controller.onClose(), true, last().error);
  assert.equal(marks(w), marksBefore, 'close never calls the user test mark');
  const sent = refreshes(w);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {});
  assert.deepEqual(Object.keys(sent[0].body), []);
  assert.equal(sent[0].headers.authorization, 'Bearer ' + world.session.id);
  const refresh = oraclePublishes(w).at(-1);
  assert.deepEqual([refresh.args.price_ticks, refresh.args.funding_cents], [before.price_ticks, before.funding_cents]);
  assert.ok(refresh.args.round > before.round);
  assert.equal(closeJobs(world).length, 1);
  assert.equal(closeJobs(world)[0].input.round, refresh.args.round);
  assert.ok(last().receipts.some((r) => r.label === 'oracle refresh'), 'verified on chain');
  assert.equal(last().active, null);
});

test('a stale oracle is refreshed at the same price for open without a user mark', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await started(world);
  assert.equal(await controller.onSetMark(100_000), true, last().error);
  assert.equal(await controller.onDeposit(600), true, last().error);
  w.markQuota = 0;
  const marksBefore = marks(w);
  w.height += 700;
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, last().error);
  assert.equal(marks(w), marksBefore);
  assert.equal(refreshes(w).length, 1);
  assert.equal(oraclePublishes(w).at(-1).args.price_ticks, 10_000);
  assert.equal(last().position.entryUsd, 100_000);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open']);
});

test('a no-write refresh keeps a still-valid oracle when the server refreshes only after 900 blocks', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, marksBefore, active } = await openWithoutMarks(world);
  w.refreshAfterBlocks = 900; // highest allowed XYTHUM_REFRESH_AFTER_BLOCKS
  const before = { ...w.oracle };
  const publishes = oraclePublishes(w).length;
  w.height += 750; // past the staging threshold, well inside on-chain validity

  assert.equal(await controller.onClose(), true, last().error);
  assert.equal(refreshes(w).length, 1, 'asked once, server declined to write');
  assert.equal(oraclePublishes(w).length, publishes, 'no oracle write');
  assert.equal(marks(w), marksBefore);
  assert.equal(closeJobs(world).length, 1);
  assert.equal(closeJobs(world)[0].input.round, before.round, 'proved against the existing final round');
  const [close] = w.calls.filter((c) => c.method === 'close');
  assert.deepEqual([close.args.nonce, close.args.root, close.args.round], [active.nonce, active.commitment, before.round]);
  assert.equal(last().active, null);
});

test('a no-write refresh near staleness is refused before proving or sending', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, marksBefore } = await openWithoutMarks(world);
  w.refreshAfterBlocks = 1_000; // server declines to write at this age
  const publishes = oraclePublishes(w).length;
  w.height += 980; // still valid on chain, but without proving headroom

  assert.equal(await controller.onClose(), false);
  assert.match(last().error, /near staleness/);
  assert.equal(refreshes(w).length, 1);
  assert.equal(oraclePublishes(w).length, publishes);
  assert.equal(marks(w), marksBefore);
  assert.equal(closeJobs(world).length, 0, 'nothing proven');
  assert.equal(w.calls.filter((c) => c.method === 'close').length, 0, 'nothing sent');
  assert.ok(last().active);
});

test('a refresh receipt whose round does not advance to a fresh final oracle is refused', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await openWithoutMarks(world);
  const markHash = last().receipts.filter((r) => r.label === 'mark').at(-1)?.hash;
  assert.ok(markHash, 'a verified oracle publish from the earlier mark');
  w.hooks.api = async (route) => (route === 'POST /session/refresh'
    ? new Response(JSON.stringify({ oracle: { ...w.oracle }, receipt: { label: 'oracle refresh', hash: markHash } }), { status: 200 })
    : null);
  w.height += 750;

  assert.equal(await controller.onClose(), false);
  assert.match(last().error, /still stale after a liveness refresh/);
  assert.equal(closeJobs(world).length, 0);
  assert.equal(w.calls.filter((c) => c.method === 'close').length, 0);
});

test('close retries a round that changed while proving, without a user mark, for the same slot', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, marksBefore, active } = await openWithoutMarks(world);
  let moves = 1;
  w.hooks.prove = async (kind) => {
    // Another oracle round lands while the browser proves (same slot stays active).
    if (kind === 'close' && moves-- > 0) w.oracle = { ...w.oracle, round: w.oracle.round + 1, height: w.height };
  };
  assert.equal(await controller.onClose(), true, last().error);
  const jobs = closeJobs(world);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].input.round, jobs[0].input.round + 1);
  assert.ok(jobs.every((j) => j.input.blinder === jobs[0].input.blinder && j.input.context === jobs[0].input.context));
  const closes = w.calls.filter((c) => c.method === 'close');
  assert.equal(closes.length, 1);
  assert.deepEqual([closes[0].args.nonce, closes[0].args.root, closes[0].args.round],
    [active.nonce, active.commitment, jobs[1].input.round]);
  assert.equal(marks(w), marksBefore);
  assert.equal(refreshes(w).length, 0, 'the new round is fresh');
});

test('close rechecks oracle age at the final height after proving and refreshes instead of sending', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, marksBefore } = await openWithoutMarks(world);
  let slow = 1;
  w.hooks.prove = async (kind) => {
    if (kind === 'close' && slow-- > 0) w.height += 995; // proving outlived the round
  };
  assert.equal(await controller.onClose(), true, last().error);
  assert.equal(closeJobs(world).length, 2);
  assert.equal(refreshes(w).length, 1);
  assert.equal(marks(w), marksBefore);
  const closes = w.calls.filter((c) => c.method === 'close');
  assert.equal(closes.length, 1, 'the stale proof was never sent');
  assert.equal(closes[0].args.round, closeJobs(world)[1].input.round);
  assert.equal(last().active, null);
});

test('close never proves or sends for a slot other than the one it started with', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await openWithoutMarks(world);
  w.hooks.prove = async (kind) => {
    if (kind === 'close') {
      w.hooks.prove = null;
      w.oracle = { ...w.oracle, round: w.oracle.round + 1, height: w.height };
      w.active = { ...w.active, commitment: toBase64(new Uint8Array(32).fill(4)) };
    }
  };
  assert.equal(await controller.onClose(), false);
  assert.match(last().error, /active position changed during close/);
  assert.equal(closeJobs(world).length, 1);
  assert.equal(w.calls.filter((c) => c.method === 'close').length, 0);
});

test('a refresh receipt that is not an oracle publish on this market is refused', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await openWithoutMarks(world);
  const makerHash = last().receipts.find((r) => r.label === 'maker approval').hash;
  w.hooks.api = async (route) => (route === 'POST /session/refresh'
    ? new Response(JSON.stringify({ oracle: { ...w.oracle }, receipt: { label: 'oracle refresh', hash: makerHash } }), { status: 200 })
    : null);
  w.height += 700;
  assert.equal(await controller.onClose(), false);
  assert.match(last().error, /unexpected signer|not publish_oracle/);
  assert.equal(closeJobs(world).length, 0);
  assert.ok(last().active, 'nothing was sent');
});

test('route and config mismatches are refused before any signing', async () => {
  for (const [patch, pattern] of [
    [{ rpc_url: 'https://rpc.testnet.near.org' }, /pinned testnet RPC/],
    [{ chain_id: 'mainnet' }, /only NEAR testnet/],
    [{ trader_id: 'someone-else.testnet' }, /trader_id differs/],
    [{ token_id: 'other-token.testnet' }, /token_id differs/],
  ]) {
    const world = await createWorld();
    world.w.hooks.session = () => patch;
    const c = makeController(world);
    assert.equal(await c.controller.onStart(), false);
    assert.match(c.last().error, pattern);
    assert.equal(world.w.calls.length, 0);
  }
});

test('an oracle move during staging never opens a stale proof', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await started(world);
  await controller.onSetMark(100_000);
  await controller.onDeposit(600);
  w.hooks.prove = async (kind) => {
    if (kind === 'open') {
      w.hooks.prove = null;
      w.oracle = { ...w.oracle, round: w.oracle.round + 100, price_ticks: 10_100 };
    }
  };
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), false);
  assert.match(last().error, /oracle moved/);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call']);
  assert.equal(await controller.onOpen({ sizeBtc: 0.01, marginUsd: 500 }), true, last().error);
  assert.equal(last().position.entryUsd, 101_000);
});

test('a broadcast that never reached the network is re-sent from the journal, once', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await started(world);
  let first = true;
  w.hooks.rpc = async (method) => {
    if (method === 'send_tx' && first) {
      first = false;
      return { error: { name: 'REQUEST_TIMEOUT' } }; // dropped before execution
    }
    return undefined;
  };
  assert.equal(await controller.onDeposit(5), true, last().error);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call']);
  assert.equal(last().balances.available, 500);
});

test('session enrollment is signed by the browser key and retried identically after a lost response', async () => {
  const world = await createWorld();
  const { w } = world;
  const realFetch = world.apiFetch;
  let lose = 1;
  world.apiFetch = async (url, init) => {
    const response = await realFetch(url, init);
    if (init.method === 'POST' && url === '/api/sessions' && lose-- > 0) throw new TypeError('network connection lost');
    return response;
  };
  const c = makeController(world);
  assert.equal(await c.controller.onStart(), false);
  assert.match(c.last().error, /unreachable/);
  assert.equal(await c.controller.onStart(), true, c.last()?.error);
  const enrollments = w.serverBodies.filter((b) => b.route === 'POST /sessions');
  assert.equal(enrollments.length, 2);
  assert.deepEqual(enrollments[0].body, enrollments[1].body);
  assert.deepEqual(Object.keys(enrollments[0].body), ['public_key', 'proof']);
  const signer = await c.store.get('signer');
  assert.equal(enrollments[0].body.public_key, 'ed25519:' + toBase58(signer.publicKey));
});

const enrollments = (w) => w.serverBodies.filter((b) => b.route === 'POST /sessions');

test('automatic restore on a fresh browser makes no request and creates no key', async () => {
  const world = await createWorld();
  const { w } = world;
  const c = makeController(world);
  assert.equal(await c.controller.onResume(), true, c.last()?.error);
  assert.deepEqual(w.serverBodies, [], 'no server request at all');
  assert.equal(await c.store.get('signer'), undefined, 'no signer created');
  assert.deepEqual(await c.store.keys(''), []);
  assert.equal(c.last().session, null);
  assert.equal(c.last().error, null);
  assert.equal(w.calls.length, 0);
});

test('automatic restore of a stale saved session never falls back to enrollment', async () => {
  const world = await createWorld();
  const { w } = world;
  const first = await started(world);
  const saved = await first.store.get('session');
  await first.store.put('session', { ...saved, session_id: 'session-revoked-000000000' });
  const before = enrollments(w).length;

  const reload = makeController(world, first.store);
  assert.equal(await reload.controller.onResume(), true, reload.last()?.error);
  assert.equal(enrollments(w).length, before, 'no implicit POST /sessions');
  assert.equal(reload.last().session, null);
  assert.match(reload.last().notice, /Start session/);

  // A saved session for a different key is not even queried.
  const otherKey = makeController(world, first.store);
  await first.store.put('session', { ...saved, public_key: 'ed25519:' + '1'.repeat(32) });
  const gets = w.serverBodies.length;
  assert.equal(await otherKey.controller.onResume(), true);
  assert.equal(w.serverBodies.length, gets);

  // The explicit click still re-enrolls the same key.
  assert.equal(await reload.controller.onStart(), true, reload.last()?.error);
  assert.equal(enrollments(w).length, before + 1);
  assert.equal(reload.last().session.publicKey, saved.public_key);
});

test('automatic restore reattaches a valid saved session without enrolling', async () => {
  const world = await createWorld();
  const { w } = world;
  const first = await started(world);
  const reload = makeController(world, first.store);
  assert.equal(await reload.controller.onResume(), true, reload.last()?.error);
  assert.equal(enrollments(w).length, 1);
  assert.equal(reload.last().session.traderId, IDS.trader);
  assert.equal(reload.last().session.publicKey, first.last().session.publicKey);
  assert.equal(await reload.controller.onDeposit(5), true, reload.last().error);
});

test('a Start click during the automatic restore waits for it instead of racing', async () => {
  const world = await createWorld();
  const { w } = world;
  const first = await started(world);
  const reload = makeController(world, first.store);
  assert.deepEqual(await Promise.all([reload.controller.onResume(), reload.controller.onStart()]), [true, true]);
  assert.ok(!reload.states.some((s) => /still in progress/.test(s.error ?? '')));
  assert.equal(enrollments(w).length, 1);

  // Fresh browser: the click enrolls exactly once after the no-op restore.
  const fresh = makeController(await createWorld());
  const res = await Promise.all([fresh.controller.onResume(), fresh.controller.onStart()]);
  assert.deepEqual(res, [true, true], fresh.last()?.error);
  assert.ok(!fresh.states.some((s) => /still in progress/.test(s.error ?? '')));
  assert.ok(fresh.last().session);
});

test('after a lost enrollment response a reload stays idle and Start re-sends the same enrollment', async () => {
  const world = await createWorld();
  const { w } = world;
  const realFetch = world.apiFetch;
  let lose = 1;
  world.apiFetch = async (url, init) => {
    const response = await realFetch(url, init);
    if (init.method === 'POST' && url === '/api/sessions' && lose-- > 0) throw new TypeError('network connection lost');
    return response;
  };
  const first = makeController(world);
  assert.equal(await first.controller.onStart(), false);
  assert.equal(enrollments(w).length, 1);

  const reload = makeController(world, first.store);
  assert.equal(await reload.controller.onResume(), true, reload.last()?.error);
  assert.equal(enrollments(w).length, 1, 'restore does not retry enrollment');
  assert.equal(reload.last().session, null);

  assert.equal(await reload.controller.onStart(), true, reload.last()?.error);
  const sent = enrollments(w);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, sent[0].body, 'same signer, same signed enrollment');
  assert.equal(reload.last().session.publicKey, sent[0].body.public_key);
});

test('a forged session proof is refused by the server', async () => {
  const world = await createWorld();
  const realFetch = world.apiFetch;
  world.apiFetch = (url, init) => {
    if (url === '/api/sessions') {
      const body = JSON.parse(init.body);
      body.proof = toBase64(new Uint8Array(64));
      return realFetch(url, { ...init, body: JSON.stringify(body) });
    }
    return realFetch(url, init);
  };
  const c = makeController(world);
  assert.equal(await c.controller.onStart(), false);
  assert.match(c.last().error, /401/);
});

// ------------------------------------------------------- reviewed quote

/** Started, marked at 100,000 and funded; returns the quote the UI shows for review. */
async function reviewing(world) {
  const c = await started(world);
  assert.equal(await c.controller.onSetMark(100_000), true, c.last().error);
  assert.equal(await c.controller.onDeposit(600), true, c.last().error);
  const { price_ticks: priceTicks, funding_cents: fundingCents } = c.last().oracle;
  return { ...c, reviewedQuote: { priceTicks, fundingCents } };
}

const openJobs = (world) => world.prover.jobs.filter((j) => j.kind === 'open');
const ORDER = { sizeBtc: 0.01, marginUsd: 500 };

test('a reviewed quote opens at exactly the reviewed price and funding checkpoint', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, reviewedQuote } = await reviewing(world);
  assert.deepEqual(reviewedQuote, { priceTicks: 10_000, fundingCents: 0 });
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), true, last().error);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open']);
  assert.equal(w.active.funding_checkpoint, 0);
  assert.equal(last().position.entryUsd, 100_000);
});

test('invalid reviewed quotes are refused before any request or signature', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last } = await reviewing(world);
  const calls = w.calls.length;
  const bodies = w.serverBodies.length;
  for (const [reviewedQuote, pattern] of [
    [{ priceTicks: '10000', fundingCents: 0 }, /priceTicks/],
    [{ priceTicks: 10_000.5, fundingCents: 0 }, /priceTicks/],
    [{ priceTicks: 0, fundingCents: 0 }, /priceTicks/],
    [{ priceTicks: 20_001, fundingCents: 0 }, /priceTicks/],
    [{ priceTicks: 10_000 }, /fundingCents/],
    [{ priceTicks: 10_000, fundingCents: -1 }, /fundingCents/],
    [{ priceTicks: 10_000, fundingCents: 2 ** 32 }, /fundingCents/],
    [[10_000, 0], /reviewedQuote must be/],
    ['10000', /reviewedQuote must be/],
  ]) {
    assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), false, JSON.stringify(reviewedQuote));
    assert.match(last().error, pattern);
  }
  assert.equal(w.calls.length, calls, 'nothing signed');
  assert.equal(w.serverBodies.length, bodies, 'nothing requested');
  assert.equal(openJobs(world).length, 0);
});

test('a mark that moved after review is refused before proving, staging or signing', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, store, reviewedQuote } = await reviewing(world);
  assert.equal(await controller.onSetMark(101_000), true, last().error);
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), false);
  assert.match(last().error, /quote changed after you reviewed it \(entry price \$100,000\.00 → \$101,000\.00\)/);
  assert.match(last().error, /Review the new quote and confirm again/);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call']);
  assert.equal(openJobs(world).length, 0);
  assert.equal(await store.getSealed('opening'), undefined, 'no opening prepared for unreviewed terms');

  // A new review at the shown terms opens.
  const fresh = { priceTicks: last().oracle.price_ticks, fundingCents: last().oracle.funding_cents };
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote: fresh }), true, last().error);
  assert.equal(last().position.entryUsd, 101_000);
});

test('a funding index that moved after review is refused even at the same price', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, reviewedQuote } = await reviewing(world);
  w.oracle = { ...w.oracle, round: w.oracle.round + 1, funding_cents: 7, height: w.height };
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), false);
  assert.match(last().error, /funding index 0 → 7 cents/);
  assert.doesNotMatch(last().error, /entry price/);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call']);
  assert.equal(openJobs(world).length, 0);
});

test('a stale oracle refreshed to a new round at the same price and funding keeps the review', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, reviewedQuote } = await reviewing(world);
  const round = w.oracle.round;
  w.markQuota = 0;
  w.height += 700;
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), true, last().error);
  assert.equal(refreshes(w).length, 1);
  assert.ok(w.oracle.round > round, 'opened under a later liveness round');
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open']);
  assert.equal(last().position.entryUsd, 100_000);
});

test('an oracle move after staging and approval is caught before the open signature', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, store, reviewedQuote } = await reviewing(world);
  let moves = 1;
  // A new funding index lands as soon as the maker approval is on chain.
  w.hooks.rpc = async () => {
    if (w.pending?.expires_at && moves-- > 0) {
      w.oracle = { ...w.oracle, round: w.oracle.round + 1, funding_cents: 3, height: w.height };
    }
    return undefined;
  };
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), false);
  assert.match(last().error, /funding index 0 → 3 cents/);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position'], 'open never signed');
  assert.ok(await store.getSealed('opening'), 'the staged opening is kept, not discarded');

  // The stale review is refused again; a new review restages at the new checkpoint.
  w.hooks.rpc = null;
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), false);
  assert.match(last().error, /quote changed after you reviewed it/);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position']);
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote: { priceTicks: 10_000, fundingCents: 3 } }), true, last().error);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'stage_position', 'open']);
  assert.equal(w.active.funding_checkpoint, 3);
});

test('a staged opening resumes on retry under a new same-terms round, and only for a matching review', async () => {
  const world = await createWorld();
  const { w } = world;
  const first = await reviewing(world);
  const { reviewedQuote } = first;
  let failures = 1;
  w.hooks.api = async (route) => (route === 'POST /session/approve' && failures-- > 0
    ? new Response(JSON.stringify({ error: 'maker offline' }), { status: 503 }) : null);
  assert.equal(await first.controller.onOpen({ ...ORDER, reviewedQuote }), false);
  assert.match(first.last().error, /maker offline/);
  assert.ok(w.pending, 'stage landed');

  // A new oracle round at the same price and funding index lands meanwhile.
  w.oracle = { ...w.oracle, round: w.oracle.round + 1, height: w.height };

  // Reload. A stale review from another tab is refused and keeps the staged opening.
  const second = makeController(world, first.store);
  assert.equal(await second.controller.onStart(), true, second.last().error);
  assert.equal(await second.controller.onOpen({ ...ORDER, reviewedQuote: { priceTicks: 10_010, fundingCents: 0 } }), false);
  assert.match(second.last().error, /entry price \$100,100\.00 → \$100,000\.00/);
  assert.ok(await second.store.getSealed('opening'));

  assert.equal(await second.controller.onOpen({ ...ORDER, reviewedQuote }), true, second.last().error);
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open'], 'no restage');
  assert.equal(openJobs(world).length, 1, 'no reprove');
  assert.equal(second.last().position.entryUsd, 100_000);
});

test('a retry after a landed open reports the active position instead of a quote change', async () => {
  const world = await createWorld();
  const { w } = world;
  const { controller, last, reviewedQuote } = await reviewing(world);
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), true, last().error);
  assert.equal(await controller.onSetMark(101_000), true, last().error);
  assert.equal(await controller.onOpen({ ...ORDER, reviewedQuote }), false);
  assert.match(last().error, /already active/);
  assert.ok(last().position, 'the landed position stays reconciled');
  assert.deepEqual(methodsCalled(w, IDS.trader), ['ft_transfer_call', 'stage_position', 'open']);
});
