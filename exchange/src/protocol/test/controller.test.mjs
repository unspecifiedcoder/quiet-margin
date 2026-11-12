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
  assert.ok(last().receipts.every((r) => r.explorerUrl.startsWith('https://testnet.nearblocks.io/txns/')));
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
