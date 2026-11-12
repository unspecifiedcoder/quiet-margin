import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { positionContext } from '../../../tests/actor.mjs';
import { HEALTHY_REFUSAL, isHealthyRefusal } from '../actors.mjs';
import { loadConfig, NEAR } from '../config.mjs';
import {
  bearerFromSignature, MAX_ROUND_ATTEMPTS, MAX_VIEW_RECEIPTS, parsePublicKey, REFRESH_RETRY_MS, sessionAccountIds, verifySessionProof,
} from '../coordinator.mjs';
import { MemoryStore } from '../store.mjs';
import { HttpError } from '../util.mjs';
import { ACK_KEYS, browserKey, browserPair, ENC_KEYS, enrollment, harness, RPC } from './harness.mjs';
import { IDS, MockChain, TRADER_ROLE_PAIR } from './mock-chain.mjs';

const rejects = (promise, status, code) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof HttpError, 'expected HttpError, got ' + error);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  return true;
});

function quoteTerms(context, quoteBlinder, lots, entry) {
  const terms = Buffer.alloc(4);
  terms.writeUInt16LE(lots, 0);
  terms.writeUInt16LE(entry, 2);
  return createHash('sha256').update(Buffer.concat([
    Buffer.from('xythum:quote:v2:'), Buffer.from(context, 'base64'), Buffer.from(quoteBlinder, 'base64'), terms,
  ])).digest('base64');
}

async function ready(h, body = enrollment()) {
  const view = await h.coordinator.createSession(body);
  const { record } = h.coordinator.authenticate('Bearer ' + view.session_id);
  return { view, record, key: body.public_key, body };
}

const fresh = () => enrollment();

function stageQuote(h, record, { lots = 10, entry = 10_000 } = {}) {
  const market = h.chain.markets.get(record.market_id);
  const quote_blinder = randomBytes(32).toString('base64');
  const commitment = randomBytes(32).toString('base64');
  const context = positionContext(market.hash, market.ledger.next_nonce, market.oracle.funding_cents, record.trader_id);
  h.chain.stage(record.market_id, { commitment, quote_terms: quoteTerms(context, quote_blinder, lots, entry) });
  return { nonce: market.ledger.next_nonce, commitment, quote_blinder, size_lots: lots, entry_ticks: entry };
}

test('config defaults to loopback 8790, disables creation without a quota and bounds spend', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8790);
  assert.equal(config.sessionQuota, 0);
  assert.equal(config.traderNear, NEAR / 2n);
  assert.throws(() => loadConfig({ XYTHUM_SERVER_HOST: '0.0.0.0' }), /XYTHUM_ALLOW_HOSTED/);
  assert.equal(loadConfig({
    XYTHUM_SERVER_HOST: '0.0.0.0', XYTHUM_ALLOW_HOSTED: '1', XYTHUM_HOSTED_INVITE: randomBytes(32).toString('hex'),
    XYTHUM_SESSION_DIR: '/data/sessions', XYTHUM_PROVING_DIR: '/app/artifacts/proving',
    MARKET_WASM: '/app/artifacts/market.wasm', PROVER_BIN: '/app/bin/xythum-prover',
  }).createCooldownMs, 60_000);
  assert.throws(() => loadConfig({ XYTHUM_SESSION_QUOTA: '51' }), /between/);
  assert.throws(() => loadConfig({ XYTHUM_TRADER_NEAR: '5' }), /bounded/);
  assert.throws(() => loadConfig({ XYTHUM_TRADER_MUSDC: '100' }), /between/);
  assert.throws(() => loadConfig({ XYTHUM_VK_FINGERPRINTS: '{"open":"x"}' }), /Base64/);
});

test('public keys must be canonical NEAR ed25519 keys', () => {
  const key = browserKey();
  assert.equal(parsePublicKey(key), key);
  for (const bad of [undefined, 42, 'ed25519:abc', key.replace('ed25519:', 'secp256k1:'), key + 'x', key.slice(8)]) {
    assert.throws(() => parsePublicKey(bad), HttpError);
  }
  const ids = sessionAccountIds('s-0123456789abcdef01234567', IDS.root);
  assert.equal(ids.trader_id, 'trader-0123456789ab.' + IDS.root);
  assert.equal(ids.market_id, 'market-0123456789ab.' + IDS.root);
  assert.ok(!IDS.forbidden.includes(ids.trader_id) && !IDS.forbidden.includes(ids.market_id));
});

test('creates an isolated funded session with only the browser key on the trader', async () => {
  const h = harness();
  const { view, record, key, body } = await ready(h);
  assert.deepEqual(Object.keys(view).sort(), [
    'chain_id', 'keeper_armed', 'keeper_encryption_keys', 'ledger', 'market_id', 'oracle', 'receipts',
    'rpc_url', 'session_id', 'token_id', 'trader_id',
  ]);
  assert.equal(view.chain_id, 'testnet');
  assert.equal(view.rpc_url, RPC);
  assert.equal(view.token_id, IDS.token);
  assert.deepEqual(view.keeper_encryption_keys, ENC_KEYS);
  assert.equal(view.keeper_armed, false);
  assert.match(view.trader_id, /^trader-[0-9a-f]{12}\.xythum-perps-demo\.testnet$/);
  assert.match(view.market_id, /^market-[0-9a-f]{12}\.xythum-perps-demo\.testnet$/);
  assert.deepEqual(view.receipts.map(({ label }) => label), [
    'market_account', 'market_deploy', 'market_registration', 'maker_musdc_transfer', 'maker_vault_deposit',
    'mark_1', 'trader_account', 'trader_registration', 'trader_musdc_transfer',
  ]);
  for (const receipt of view.receipts) assert.deepEqual(Object.keys(receipt), ['label', 'hash']);
  assert.deepEqual(view.oracle, { round: 1, price_ticks: 10_000, funding_cents: 0, height: view.oracle.height });
  assert.equal(view.ledger.maker_vault, 60_100);

  assert.deepEqual(await h.chain.accessKeys(view.trader_id), [{ public_key: key, permission: 'FullAccess' }]);
  assert.deepEqual(await h.chain.accessKeys(view.market_id), []);
  assert.equal(h.chain.balances.get(view.trader_id), 60_000);
  const config = await h.chain.view(view.market_id, 'get_config');
  assert.equal(config.trader_id, view.trader_id);
  assert.equal(config.maker_id, IDS.maker);
  assert.deepEqual(config.keepers, IDS.keepers.map((account_id, i) => ({ account_id, ack_key: ACK_KEYS[i] })));
  assert.notEqual(record.deployment_id, undefined);
  assert.ok(!h.chain.calls.some(({ operation }) => /market\.xythum/.test(operation)));

  // The bearer is derived from the proof; the durable record holds only its hash, not the proof.
  assert.match(view.session_id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(view.session_id, createHash('sha256')
    .update(Buffer.concat([Buffer.from('xythum:exchange:bearer:v1:'), Buffer.from(body.proof, 'base64')]))
    .digest('base64url'));
  const serialized = JSON.stringify(h.store.all());
  assert.ok(!serialized.includes(view.session_id));
  assert.ok(!serialized.includes(body.proof));
  assert.equal(record.token_hash, createHash('sha256').update(view.session_id).digest('hex'));
  assert.deepEqual(h.chain.overlaps, []);

  const again = await h.coordinator.sessionView(record, view.session_id);
  assert.equal(again.session_id, view.session_id);
  assert.throws(() => h.coordinator.authenticate('Bearer ' + 'x'.repeat(43)), HttpError);
  assert.throws(() => h.coordinator.authenticate(undefined), HttpError);
});

test('enrollment proofs: canonical Base64 Ed25519 over the session message, bearer derived from it', () => {
  const pair = browserPair();
  const body = enrollment(pair);
  const signature = verifySessionProof(body.public_key, body.proof);
  assert.equal(signature.length, 64);
  assert.equal(bearerFromSignature(signature).length, 43);
  // Deterministic: the same key signs the same message to the same bearer.
  assert.equal(enrollment(pair).proof, body.proof);
  const raw = Buffer.from(body.proof, 'base64');
  const flipped = Buffer.from(raw);
  flipped[10] ^= 1;
  const otherMessage = Buffer.from(pair.sign(Buffer.from('xythum:exchange:session:v1:mainnet:' + body.public_key)).signature);
  for (const bad of [
    undefined, 42, '', body.proof.slice(0, -2), body.proof.replace(/==$/, ''), raw.toString('base64url'),
    flipped.toString('base64'), otherMessage.toString('base64'), enrollment().proof,
    Buffer.concat([raw, Buffer.alloc(1)]).toString('base64'), ' ' + body.proof,
  ]) {
    assert.throws(() => verifySessionProof(body.public_key, bad), (error) => error.status === 401
      && error.code === 'invalid_proof', String(bad));
  }
  // Non-canonical padding bits decode to the same bytes but are refused.
  const last = body.proof.at(-3);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const tweaked = body.proof.slice(0, -3) + alphabet[alphabet.indexOf(last) ^ 1] + '==';
  assert.deepEqual(Buffer.from(tweaked, 'base64'), raw);
  assert.throws(() => verifySessionProof(body.public_key, tweaked), HttpError);
});

test('an invalid proof cannot join a pending setup or read a ready session', async () => {
  const h = harness();
  h.chain.delayMs = 5;
  const victim = enrollment();
  const forged = [
    { public_key: victim.public_key, proof: enrollment().proof },
    { public_key: victim.public_key, proof: Buffer.alloc(64).toString('base64') },
    { public_key: victim.public_key },
    { public_key: victim.public_key, proof: victim.proof, extra: 1 },
  ];
  const pending = h.coordinator.createSession(victim);
  for (const body of forged) {
    await assert.rejects(h.coordinator.createSession(body), (error) => {
      assert.ok(error instanceof HttpError);
      assert.ok([400, 401].includes(error.status), error.code);
      return true;
    });
  }
  // The same 401 for a pending key as for a ready one and an unknown one.
  const codes = async (body) => h.coordinator.createSession(body).then(() => 'ok', (error) => error.status + error.code);
  assert.equal(await codes(forged[0]), '401invalid_proof');
  const view = await pending;
  const calls = h.chain.calls.length;
  assert.equal(await codes(forged[0]), '401invalid_proof');
  assert.equal(await codes({ public_key: browserKey(), proof: victim.proof }), '401invalid_proof');
  assert.equal(h.chain.calls.length, calls);
  assert.equal(h.store.size, 1);
  assert.equal(h.store.all()[0].status, 'ready');
  assert.ok(view.session_id);
});

test('a valid retry returns the same session and capability, even after ready, without re-funding', async () => {
  const h = harness({ env: { XYTHUM_SESSION_QUOTA: '1' } });
  const body = enrollment();
  const [a, b] = await Promise.all([h.coordinator.createSession(body), h.coordinator.createSession(body)]);
  assert.equal(a.session_id, b.session_id);
  assert.equal(h.chain.calls.filter(({ operation }) => operation === 'createMarketAccount').length, 1);
  assert.equal(h.store.size, 1);

  // The first response was lost: the key holder posts the same proof again.
  const calls = h.chain.calls.length;
  const balances = new Map(h.chain.balances);
  const again = await h.coordinator.createSession(body);
  assert.equal(again.session_id, a.session_id);
  assert.equal(again.market_id, a.market_id);
  assert.equal(again.trader_id, a.trader_id);
  assert.deepEqual(Object.keys(again).sort(), Object.keys(a).sort());
  assert.equal(h.chain.calls.length, calls);
  assert.deepEqual(h.chain.balances, balances);
  assert.equal(h.store.size, 1);
  assert.equal(h.coordinator.authenticate('Bearer ' + again.session_id).record.market_id, a.market_id);
  // A retry neither counts against the quota nor is blocked by it.
  await rejects(h.coordinator.createSession(enrollment()), 429, 'quota_exhausted');
  assert.equal((await h.coordinator.createSession(body)).session_id, a.session_id);
});

test('a ready session bound to a different bearer is not re-issued', async () => {
  const pair = browserPair();
  const body = enrollment(pair);
  const legacy = harness();
  const { record } = await ready(legacy, body);
  // A record whose bearer was minted another way (e.g. before proofs) keeps it.
  record.token_hash = 'f'.repeat(64);
  await rejects(legacy.coordinator.createSession(body), 409, 'session_exists');
});

const recover = (body) => ({ ...body, restore_only: true });
const snapshot = (h) => JSON.stringify(h.store.snapshot());

test('restore_only for an unknown key allocates nothing, even with capacity, quota and no cooldown', async () => {
  let clock = 0;
  const h = harness({ env: { XYTHUM_SESSION_QUOTA: '5', XYTHUM_CREATE_COOLDOWN_MS: '1000' }, now: () => clock });
  const body = enrollment();
  await rejects(h.coordinator.createSession(recover(body), '10.0.0.1'), 404, 'session_not_found');
  await rejects(h.coordinator.createSession(recover(body), '10.0.0.1'), 404, 'session_not_found');
  assert.equal(h.store.size, 0);
  assert.equal(h.chain.calls.length, 0);
  // The cooldown was neither consulted nor consumed: an ordinary creation proceeds at once.
  await h.coordinator.createSession(fresh(), '10.0.0.1');
  assert.equal(h.store.size, 1);
  // Explicit false is the ordinary path.
  await h.coordinator.createSession({ ...body, restore_only: false }, '10.0.0.2');
  assert.equal(h.store.size, 2);
});

test('restore_only returns the exact existing ready session after the quota is exhausted, with no writes or transactions', async () => {
  const h = harness({ env: { XYTHUM_SESSION_QUOTA: '1', XYTHUM_CREATE_COOLDOWN_MS: '60000' } });
  const { view, body } = await ready(h);
  await rejects(h.coordinator.createSession(enrollment()), 429, 'quota_exhausted');
  const calls = h.chain.calls.length;
  const before = snapshot(h);
  const save = h.store.save;
  h.store.save = () => assert.fail('recovery must not write a durable record');
  const recovered = await h.coordinator.createSession(recover(body), '10.0.0.7');
  h.store.save = save;
  assert.deepEqual(recovered, view);
  assert.equal(h.chain.calls.length, calls);
  assert.equal(snapshot(h), before);
  assert.equal(h.coordinator.authenticate('Bearer ' + recovered.session_id).record.trader_id, view.trader_id);
  // After a restart from the durable store (new process, empty in-memory state).
  const restarted = harness({ chain: h.chain, store: new MemoryStore(h.store.snapshot()), env: { XYTHUM_SESSION_QUOTA: '1' } });
  assert.deepEqual(await restarted.coordinator.createSession(recover(body)), view);
  assert.equal(h.chain.calls.length, calls);
});

test('restore_only validates the body and proof exactly like enrollment and leaks nothing', async () => {
  const h = harness();
  const { body } = await ready(h);
  const calls = h.chain.calls.length;
  const before = snapshot(h);
  for (const value of ['true', 1, 0, null, {}, [], 'yes']) {
    await rejects(h.coordinator.createSession({ ...body, restore_only: value }), 400, 'invalid_restore_only');
  }
  await rejects(h.coordinator.createSession({ public_key: body.public_key, restore_only: true }), 400, 'invalid_body');
  await rejects(h.coordinator.createSession({ ...recover(body), extra: 1 }), 400, 'unexpected_field');
  await rejects(h.coordinator.createSession({ restoreOnly: true, ...body }), 400, 'unexpected_field');
  // A bad proof gets the same 401 for a ready key as for an unknown one.
  for (const forged of [
    { ...body, proof: enrollment().proof }, { ...body, proof: Buffer.alloc(64).toString('base64') },
    { public_key: browserKey(), proof: body.proof },
  ]) {
    await rejects(h.coordinator.createSession(recover(forged)), 401, 'invalid_proof');
  }
  await rejects(h.coordinator.createSession(recover(enrollment(TRADER_ROLE_PAIR))), 400, 'invalid_public_key');
  assert.equal(h.chain.calls.length, calls);
  assert.equal(snapshot(h), before);
});

test('restore_only refuses pending, unfinished and differently bound sessions without touching them', async () => {
  const h = harness();
  h.chain.delayMs = 5;
  const body = enrollment();
  const pending = h.coordinator.createSession(body);
  await rejects(h.coordinator.createSession(recover(body)), 409, 'session_not_ready');
  await pending;

  // An interrupted setup is not resumed by recovery.
  const chain = new MockChain();
  const first = harness({ chain });
  const key = enrollment();
  chain.failOnce('createTraderAccount', { afterEffect: true });
  await rejects(first.coordinator.createSession(key), 502, 'setup_incomplete');
  const restarted = harness({ chain, store: new MemoryStore(first.store.snapshot()) });
  const calls = chain.calls.length;
  const before = snapshot(restarted);
  await rejects(restarted.coordinator.createSession(recover(key)), 409, 'session_not_ready');
  assert.equal(chain.calls.length, calls);
  assert.equal(snapshot(restarted), before);
  assert.equal(restarted.store.all()[0].status, 'provisioning');

  // A ready record bound to another bearer, or to none, is never re-issued.
  const bound = harness();
  const { record, body: boundBody } = await ready(bound);
  record.token_hash = 'f'.repeat(64);
  await rejects(bound.coordinator.createSession(recover(boundBody)), 409, 'session_exists');
  delete record.token_hash;
  await rejects(bound.coordinator.createSession(recover(boundBody)), 409, 'session_unbound');
  assert.equal(record.token_hash, undefined, 'recovery does not bind a legacy record');
});

test('the setup slot is claimed synchronously, so a same-key race cannot reserve a second record', async () => {
  const h = harness({ env: { XYTHUM_SESSION_QUOTA: '2', XYTHUM_CREATE_COOLDOWN_MS: '60000' } });
  const body = enrollment();
  const first = h.coordinator.createSession(body, '10.0.0.9');
  const second = h.coordinator.createSession(body, '10.0.0.9'); // would hit the cooldown if it reserved
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.session_id, b.session_id);
  assert.equal(h.store.size, 1);
});

test('quota, cooldown and key validation stop unbounded spend before any transaction', async () => {
  const unset = harness({ env: { XYTHUM_SESSION_QUOTA: '' } });
  await rejects(unset.coordinator.createSession(fresh()), 503, 'quota_unset');
  assert.equal(unset.chain.calls.length, 0);

  const h = harness({ env: { XYTHUM_SESSION_QUOTA: '1' } });
  await h.coordinator.createSession(fresh());
  const before = h.chain.calls.length;
  await rejects(h.coordinator.createSession(fresh()), 429, 'quota_exhausted');
  await rejects(h.coordinator.createSession(enrollment(TRADER_ROLE_PAIR)), 400, 'invalid_public_key');
  await rejects(h.coordinator.createSession({ ...fresh(), extra: 1 }), 400, 'unexpected_field');
  await rejects(h.coordinator.createSession({ public_key: browserKey() }), 400, 'invalid_body');
  await rejects(h.coordinator.createSession([]), 400, 'invalid_body');
  assert.equal(h.chain.calls.length, before);

  let clock = 0;
  const cooled = harness({ env: { XYTHUM_SESSION_QUOTA: '5', XYTHUM_CREATE_COOLDOWN_MS: '1000' }, now: () => clock });
  const first = fresh();
  await cooled.coordinator.createSession(first, '10.0.0.1');
  await rejects(cooled.coordinator.createSession(fresh(), '10.0.0.1'), 429, 'cooldown');
  // An invalid proof is refused before the cooldown is consulted or consumed.
  await rejects(cooled.coordinator.createSession({ ...fresh(), proof: first.proof }, '10.0.0.3'), 401, 'invalid_proof');
  await cooled.coordinator.createSession(fresh(), '10.0.0.3');
  // A valid retry of an existing session is not a new creation.
  await cooled.coordinator.createSession(first, '10.0.0.1');
  await cooled.coordinator.createSession(fresh(), '10.0.0.2');
  clock = 2_000;
  await cooled.coordinator.createSession(fresh(), '10.0.0.1');
});

test('capacity preflight refuses a session the root cannot fund', async () => {
  const chain = new MockChain();
  chain.balances.set(IDS.root, 1_000);
  const h = harness({ chain });
  await rejects(h.coordinator.createSession(fresh()), 503, 'token_capacity');
  assert.equal(chain.calls.length, 0);
  const poor = new MockChain();
  poor.accounts.get(IDS.root).amount = (2n * NEAR).toString();
  await rejects(harness({ chain: poor }).coordinator.createSession(fresh()), 503, 'root_capacity');
});

test('an interrupted setup resumes after restart without repeating landed transactions', async () => {
  const chain = new MockChain();
  const first = harness({ chain });
  const key = enrollment();
  // The trader account lands on chain but the response is lost.
  chain.failOnce('createTraderAccount', { afterEffect: true });
  await rejects(first.coordinator.createSession(key), 502, 'setup_incomplete');
  const [record] = first.store.all();
  assert.equal(record.status, 'provisioning');
  assert.equal(record.steps.trader_account, 'submitting');
  assert.match(record.last_error, /simulated RPC failure/);
  // Bound to the proof's bearer hash, but not usable until ready.
  assert.match(record.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(first.coordinator.armedSessions().length, 0);

  const restarted = harness({ chain, store: new MemoryStore(first.store.snapshot()) });
  // Before resuming, a forged proof for the pending key learns nothing.
  await rejects(restarted.coordinator.createSession({ ...key, proof: enrollment().proof }), 401, 'invalid_proof');
  const view = await restarted.coordinator.createSession(key);
  assert.equal(restarted.store.all()[0].token_hash, record.token_hash);
  const count = (operation) => chain.calls.filter((call) => call.operation === operation).length;
  assert.equal(count('createMarketAccount'), 1);
  assert.equal(count('deployMarket'), 1);
  assert.equal(count('createTraderAccount'), 0);
  assert.equal(count('ft_transfer_call'), 1);
  assert.equal(chain.balances.get(view.trader_id), 60_000);
  assert.equal(new Set(view.receipts.map(({ label }) => label)).size, view.receipts.length);

  // A trader transfer that landed before a crash is not repeated.
  const chain2 = new MockChain();
  const h2 = harness({ chain: chain2 });
  const key2 = enrollment();
  chain2.failOnce('ft_transfer', { afterEffect: true });
  await rejects(h2.coordinator.createSession(key2), 502);
  const resumed = await h2.coordinator.createSession(key2);
  assert.equal(chain2.balances.get(IDS.maker) + chain2.markets.get(resumed.market_id).ledger.maker_vault, 60_100);
  assert.equal(chain2.balances.get(resumed.trader_id), 60_000);
});

test('refuses to adopt a pre-existing account it did not create', async () => {
  const chain = new MockChain();
  const h = harness({ chain });
  const original = h.coordinator.createSession.bind(h.coordinator);
  // Occupy the next market ID before the coordinator creates it.
  const random = (n) => Buffer.alloc(n, 0xab);
  h.coordinator.random = random;
  const { market_id } = sessionAccountIds('s-' + random(12).toString('hex'), IDS.root);
  chain.accounts.set(market_id, { amount: '1', storage_usage: 1, code_hash: 'x', keys: [] });
  await rejects(original(fresh()), 502);
  assert.match(h.store.all()[0].last_error, /without a record/);
  assert.equal(chain.calls.length, 0);
});

test('maker approval verifies the pending digest and limits, then keepers acknowledge', async () => {
  const h = harness();
  const { record } = await ready(h);
  const quote = stageQuote(h, record);
  const height = h.chain.height;
  const result = await h.coordinator.approve(record, quote);
  assert.deepEqual(Object.keys(result), ['acknowledgments', 'receipt']);
  assert.equal(result.acknowledgments.length, 2);
  assert.equal(result.receipt.label, 'quote_1');
  const market = h.chain.markets.get(record.market_id);
  assert.equal(market.quote.commitment, quote.commitment);
  assert.equal(market.quote.expires_at, height + 500);
  assert.deepEqual(h.actorCalls.map(({ command, index }) => command + index), ['ack0', 'ack1']);

  // A retry of the same live approval reuses the receipt without a new transaction.
  const calls = h.chain.calls.length;
  const retried = await h.coordinator.approve(record, quote);
  assert.equal(retried.receipt.hash, result.receipt.hash);
  assert.equal(h.chain.calls.length, calls);

  await rejects(h.coordinator.approve(record, { ...quote, margin_cents: 50_000 }), 400, 'unexpected_field');
  await rejects(h.coordinator.approve(record, { ...quote, blinder: quote.quote_blinder }), 400, 'unexpected_field');
  await rejects(h.coordinator.approve(record, { ...quote, witness: {} }), 400, 'unexpected_field');
  await rejects(h.coordinator.approve(record, { ...quote, commitment: 'AAAA' }), 400, 'invalid_quote');
  await rejects(h.coordinator.approve(record, { ...quote, size_lots: 11 }), 422, 'quote_rejected');
  await rejects(h.coordinator.approve(record, { ...quote, nonce: 2 }), 409, 'pending_mismatch');

  const wide = stageQuote(h, record, { entry: 10_200 });
  await rejects(h.coordinator.approve(record, wide), 422, 'quote_rejected');
  const tooBig = stageQuote(h, record, { lots: 51 });
  await rejects(h.coordinator.approve(record, tooBig), 400, 'invalid_quote');
});

test('approval is withheld when a keeper refuses and when the maker cannot reserve', async () => {
  const h = harness({
    actors: {
      ack: async (_session, index) => {
        if (index === 1) throw new Error('undecryptable keeper payload');
        return randomBytes(64).toString('base64');
      },
      liquidate: async () => ({}),
    },
  });
  const { record } = await ready(h);
  const quote = stageQuote(h, record);
  const calls = h.chain.calls.length;
  await rejects(h.coordinator.approve(record, quote), 422, 'keeper_refused');
  assert.equal(h.chain.calls.length, calls);
  h.chain.markets.get(record.market_id).ledger.maker_reserved = 60_100;
  await rejects(h.coordinator.approve(record, quote), 409, 'maker_reserve');
});

test('marks publish bounded rounds, retain funding, refresh safely and are rate limited', async () => {
  let clock = 10_000;
  const h = harness({ env: { XYTHUM_MARK_INTERVAL_MS: '1000', XYTHUM_MARKS_PER_SESSION: '3' }, now: () => clock });
  const { record } = await ready(h);
  h.chain.markets.get(record.market_id).oracle.funding_cents = 200;
  const first = await h.coordinator.mark(record, { price_ticks: 9_000 });
  assert.deepEqual(Object.keys(first), ['oracle', 'receipt']);
  assert.equal(first.oracle.round, 2);
  assert.equal(first.oracle.funding_cents, 200);
  assert.equal(first.receipt.label, 'mark_2');
  await rejects(h.coordinator.mark(record, { price_ticks: 9_000 }), 429, 'mark_rate');
  clock += 1_000;
  const same = await h.coordinator.mark(record, { price_ticks: 9_000 });
  assert.equal(same.oracle.round, 3);
  assert.equal(same.oracle.price_ticks, 9_000);
  for (const price_ticks of [0, 20_001, 1.5, '100', null]) {
    await rejects(h.coordinator.mark(record, { price_ticks }), 400, 'invalid_mark');
  }
  await rejects(h.coordinator.mark(record, { price_ticks: 9_000, funding_cents: 1 }), 400, 'unexpected_field');
  clock += 1_000;
  await h.coordinator.mark(record, { price_ticks: 9_000 });
  clock += 1_000;
  await rejects(h.coordinator.mark(record, { price_ticks: 9_000 }), 429, 'mark_limit');
});

test('refresh reuses a fresh round with no transaction and validates an exact empty body', async () => {
  const h = harness();
  const { record } = await ready(h);
  const before = structuredClone(h.chain.markets.get(record.market_id).oracle);
  const calls = h.chain.calls.length;
  const receipts = record.receipts.length;
  const result = await h.coordinator.refresh(record, {});
  assert.deepEqual(result, { oracle: before });
  h.chain.height += h.config.refreshAfterBlocks - 1 - (h.chain.height - before.height);
  assert.deepEqual(await h.coordinator.refresh(record, {}), { oracle: before });
  assert.equal(h.chain.calls.length, calls);
  assert.equal(record.receipts.length, receipts);
  assert.equal(record.refreshes, 0);
  await rejects(h.coordinator.refresh(record, { price_ticks: 9_000 }), 400, 'unexpected_field');
  await rejects(h.coordinator.refresh(record, { funding_cents: 0 }), 400, 'unexpected_field');
  for (const body of [null, [], 'x', 1]) await rejects(h.coordinator.refresh(record, body), 400, 'invalid_body');
  assert.equal(h.chain.calls.length, calls);
});

test('refresh republishes a stale round at the same price and funding without the user mark quota', async () => {
  const h = harness({ env: { XYTHUM_MARKS_PER_SESSION: '1' } });
  const { record } = await ready(h);
  await h.coordinator.mark(record, { price_ticks: 9_500 });
  await rejects(h.coordinator.mark(record, { price_ticks: 9_500 }), 429, 'mark_limit');
  const market = h.chain.markets.get(record.market_id);
  stageQuote(h, record, { entry: 9_500 });
  h.chain.open(record.market_id);
  market.oracle.funding_cents = 150;
  const stale = structuredClone(market.oracle);
  h.chain.height = stale.height + h.config.refreshAfterBlocks;
  const calls = h.chain.calls.length;
  const result = await h.coordinator.refresh(record, {});
  assert.deepEqual(Object.keys(result), ['oracle', 'receipt']);
  assert.equal(result.oracle.round, stale.round + 1);
  assert.equal(result.oracle.price_ticks, 9_500);
  assert.equal(result.oracle.funding_cents, 150);
  assert.equal(result.receipt.label, 'refresh_' + result.oracle.round);
  assert.deepEqual(h.chain.calls.slice(calls).map(({ signer, operation }) => signer + ':' + operation),
    ['ORACLE:publish_oracle']);
  assert.equal(record.marks, 1);
  assert.equal(record.refreshes, 1);
  assert.deepEqual(record.receipts.at(-1), result.receipt);
  // The new round is fresh: a repeat call is a no-write reuse.
  assert.deepEqual(await h.coordinator.refresh(record, {}), { oracle: result.oracle });
  assert.equal(h.chain.calls.length, calls + 1);
});

test('refresh is bounded by final block age only, with no lifetime cap, and capped marks never block it', async () => {
  const h = harness({ env: { XYTHUM_REFRESH_AFTER_BLOCKS: '100', XYTHUM_MARKS_PER_SESSION: '1' } });
  const { record } = await ready(h);
  await h.coordinator.mark(record, { price_ticks: 9_800 });
  await rejects(h.coordinator.mark(record, { price_ticks: 9_800 }), 429, 'mark_limit');
  const market = h.chain.markets.get(record.market_id);
  const age = () => { h.chain.height = market.oracle.height + 100; };
  const start = h.chain.calls.length;
  // Far more windows than any former per-session cap: each stale window publishes once.
  for (let window = 1; window <= 60; window += 1) {
    age();
    // Concurrent callers in one window: one publish, the rest reuse the fresh final round.
    const results = await Promise.all([1, 2, 3].map(() => h.coordinator.refresh(record, {})));
    assert.equal(results.filter((r) => r.receipt).length, 1);
    assert.ok(results.every((r) => r.oracle.round === market.oracle.round && r.oracle.price_ticks === 9_800));
    assert.equal(h.chain.calls.length, start + window);
  }
  assert.equal(record.refreshes, 60);
  assert.equal(record.marks, 1);
  assert.equal('last_refresh_height' in record, false);
  assert.equal('refreshesPerSession' in h.config, false);
  assert.throws(() => loadConfig({ XYTHUM_REFRESH_AFTER_BLOCKS: '1000' }), /between/);
});

test('a transient refresh publish failure is retried after a short backoff, not a block bar', async () => {
  let clock = 50_000;
  const h = harness({ env: { XYTHUM_REFRESH_AFTER_BLOCKS: '100' }, now: () => clock });
  const { record } = await ready(h);
  const market = h.chain.markets.get(record.market_id);
  const stale = structuredClone(market.oracle);
  h.chain.height = stale.height + 100;
  const calls = h.chain.calls.length;
  const receipts = record.receipts.length;

  // The send fails before it lands: nothing is published and no window is consumed.
  h.chain.failOnce('publish_oracle');
  await assert.rejects(h.coordinator.refresh(record, {}), /simulated RPC failure/);
  assert.deepEqual(market.oracle, stale);
  assert.equal(record.refreshes, 0);
  await rejects(h.coordinator.refresh(record, {}), 429, 'refresh_retry');
  assert.equal(h.chain.calls.length, calls);
  // The same block height: only the time backoff gates the retry.
  clock += REFRESH_RETRY_MS;
  const retried = await h.coordinator.refresh(record, {});
  assert.equal(retried.oracle.round, stale.round + 1);
  assert.equal(retried.receipt.label, 'refresh_' + retried.oracle.round);
  assert.equal(h.chain.calls.length, calls + 1);
  assert.equal(record.refreshes, 1);

  // The send lands but its response is lost: the retry sees the fresh final round, no second write.
  h.chain.height = market.oracle.height + 100;
  h.chain.failOnce('publish_oracle', { afterEffect: true });
  await assert.rejects(h.coordinator.refresh(record, {}), /simulated RPC failure/);
  clock += REFRESH_RETRY_MS;
  const landed = await h.coordinator.refresh(record, {});
  assert.deepEqual(landed, { oracle: market.oracle });
  assert.equal(landed.oracle.round, stale.round + 2);
  assert.equal(h.chain.calls.length, calls + 1);
  assert.equal(record.receipts.length, receipts + 1);
});

test('shared role signers are serialized across concurrent sessions', async () => {
  const h = harness();
  h.chain.delayMs = 5;
  const sessions = await Promise.all([ready(h), ready(h), ready(h)]);
  await Promise.all(sessions.flatMap(({ record }) => [
    h.coordinator.mark(record, { price_ticks: 10_000 }),
    h.coordinator.approve(record, stageQuote(h, record)),
  ]));
  assert.deepEqual(h.chain.overlaps, []);
  assert.equal(new Set(sessions.map(({ view }) => view.market_id)).size, 3);
});

test('Keeper B arms for the active slot, skips healthy rounds without a transaction and settles', async () => {
  let liquidatable = false;
  const h = harness({
    actors: {
      ack: async () => randomBytes(64).toString('base64'),
      // Stub of the integrated actor's optional pin: it refuses any other slot.
      async liquidate(session, pin) {
        h.actorCalls.push({ command: 'liquidate', pin });
        const active = h.chain.markets.get(session.market_id).active;
        if (pin?.expectedNonce !== active.nonce || pin?.expectedCommitment !== active.commitment) {
          throw new Error('position changed: nothing was proved, signed or sent');
        }
        if (!liquidatable) throw new Error('error: ' + HEALTHY_REFUSAL);
        const market = h.chain.markets.get(session.market_id);
        market.active = null;
        market.ledger.keeper_available[1] += 100;
        return { tx: { hash: 'LiquidationHash' } };
      },
    },
  });
  const { record, view } = await ready(h);
  await rejects(h.coordinator.keeper(record, { armed: true }), 409, 'no_active');
  await rejects(h.coordinator.keeper(record, { armed: false }), 400, 'invalid_keeper');
  h.chain.open(record.market_id, stageQuote(h, record));

  const calls = h.chain.calls.length;
  const armed = await h.coordinator.keeper(record, { armed: true });
  assert.deepEqual(armed, { keeper_armed: true });
  assert.equal(record.keeper.attempts.at(-1).outcome, 'healthy');
  const active = h.chain.markets.get(record.market_id).active;
  assert.deepEqual(h.actorCalls.at(-1).pin, { expectedNonce: active.nonce, expectedCommitment: active.commitment });
  assert.equal(record.keeper.nonce, active.nonce);
  assert.equal(h.chain.calls.length, calls);
  assert.equal((await h.coordinator.sessionView(record, view.session_id)).keeper_armed, true);

  // The same round is not retried; a distinct round is.
  await h.coordinator.attemptKeeper(record);
  assert.equal(h.actorCalls.filter(({ command }) => command === 'liquidate').length, 1);
  await h.coordinator.mark(record, { price_ticks: 5_200 });
  liquidatable = true;
  const { receipt } = await h.coordinator.attemptKeeper(record);
  assert.deepEqual(receipt, { label: 'liquidation_1', hash: 'LiquidationHash' });
  assert.equal(record.keeper.armed, false);
  assert.equal(record.keeper.settlement.outcome, 'liquidated');
  const after = await h.coordinator.sessionView(record, view.session_id);
  assert.equal(after.keeper_armed, false);
  assert.deepEqual(after.receipts.at(-1), receipt);
  assert.deepEqual(h.coordinator.armedSessions(), []);
});

test('the session view carries the latest 64 receipts; the durable record keeps them all', async () => {
  const h = harness();
  const { record, view, body } = await ready(h);
  const setup = view.receipts.length;
  for (let i = 0; i < 100; i += 1) record.receipts.push({ label: 'extra_' + i, hash: 'h' + i });
  const after = await h.coordinator.sessionView(record, view.session_id);
  assert.equal(MAX_VIEW_RECEIPTS, 64);
  assert.equal(after.receipts.length, 64);
  assert.deepEqual(after.receipts.at(-1), { label: 'extra_99', hash: 'h99' });
  assert.deepEqual(after.receipts[0], { label: 'extra_36', hash: 'h36' });
  assert.equal(record.receipts.length, setup + 100);
  assert.equal((await h.coordinator.createSession(body)).receipts.length, 64);
});

test('an armed slot settled by the trader is tracked as terminal', async () => {
  const h = harness();
  const { record } = await ready(h);
  h.chain.open(record.market_id, stageQuote(h, record));
  await h.coordinator.keeper(record, { armed: true });
  h.chain.markets.get(record.market_id).active = null;
  await h.coordinator.attemptKeeper(record);
  assert.equal(record.keeper.armed, false);
  assert.equal(record.keeper.settlement.outcome, 'settled');
});

test('only the exact prover healthy refusal counts as healthy', () => {
  assert.equal(isHealthyRefusal(new Error(HEALTHY_REFUSAL)), true);
  assert.equal(isHealthyRefusal(new Error('error: ' + HEALTHY_REFUSAL)), true);
  for (const message of [
    'position is healthy at this oracle round',
    'position is below 5% maintenance at the opening mark; open cannot be proven',
    'RPC unhealthy: 503', 'node not healthy', 'error: internal prover failure',
  ]) assert.equal(isHealthyRefusal(new Error(message)), false, message);
});

test('Keeper B retries a round after transient failures, bounded, and skips it only when healthy', async () => {
  let outcome = 'error';
  const h = harness({
    actors: {
      ack: async () => randomBytes(64).toString('base64'),
      async liquidate(session) {
        h.actorCalls.push({ command: 'liquidate' });
        if (outcome === 'error') throw new Error('[-32000] Server error: RPC timeout');
        if (outcome === 'healthy') throw new Error('error: ' + HEALTHY_REFUSAL);
        h.chain.markets.get(session.market_id).active = null;
        return { tx: { hash: 'RetriedLiquidation' } };
      },
    },
  });
  const liquidations = () => h.actorCalls.filter(({ command }) => command === 'liquidate').length;
  const { record } = await ready(h);
  h.chain.open(record.market_id, stageQuote(h, record));
  await h.coordinator.keeper(record, { armed: true });
  const round = record.keeper.attempts[0].round;
  assert.equal(record.keeper.attempts[0].outcome, 'error');
  assert.equal(record.keeper.last_round, null);

  // A transient failure on the same round is retried up to the bound, then given up.
  for (let i = 1; i < MAX_ROUND_ATTEMPTS + 2; i += 1) await h.coordinator.attemptKeeper(record);
  assert.equal(liquidations(), MAX_ROUND_ATTEMPTS);
  assert.ok(record.keeper.attempts.every((a) => a.round === round && a.outcome === 'error'));
  assert.equal(record.keeper.attempts.at(-1).exhausted, true);
  assert.equal(record.keeper.last_round, round);

  // A new round: a healthy refusal is skipped after one try.
  await h.coordinator.mark(record, { price_ticks: 9_000 });
  outcome = 'healthy';
  await h.coordinator.attemptKeeper(record);
  await h.coordinator.attemptKeeper(record);
  assert.equal(liquidations(), MAX_ROUND_ATTEMPTS + 1);
  assert.equal(record.keeper.attempts.at(-1).outcome, 'healthy');

  // A distressed round that first fails transiently is liquidated on the retry.
  await h.coordinator.mark(record, { price_ticks: 5_200 });
  outcome = 'error';
  await h.coordinator.attemptKeeper(record);
  assert.equal(record.keeper.armed, true);
  outcome = 'liquidated';
  const { receipt } = await h.coordinator.attemptKeeper(record);
  assert.deepEqual(receipt, { label: 'liquidation_1', hash: 'RetriedLiquidation' });
  assert.equal(record.keeper.settlement.outcome, 'liquidated');
  assert.equal(liquidations(), MAX_ROUND_ATTEMPTS + 3);
});
