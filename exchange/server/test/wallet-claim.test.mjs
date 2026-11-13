import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faucetAuthorization, nep413Digest } from '../../src/protocol/wallet-messages.js';
import { browserPair, enrollment, harness } from './harness.mjs';
import { IDS } from './mock-chain.mjs';

const origin = 'http://127.0.0.1:8791';
const owner = 'judge-wallet.testnet';
const now = 1_795_560_000_000;

async function claim(wallet, trader = enrollment(), { site = origin, expiry = now + 60_000 } = {}) {
  const digest = await nep413Digest(await faucetAuthorization(site, owner, trader.public_key, expiry));
  return { ...trader, wallet: {
    account_id: owner, public_key: wallet.getPublicKey().toString(),
    signature: Buffer.from(wallet.sign(digest).signature).toString('base64'), expires_at: expiry,
  } };
}

test('a verified public wallet can fund one private trader and retry safely', async () => {
  const h = harness({ env: { XYTHUM_WALLET_FAUCET: '1' }, now: () => now });
  const wallet = browserPair();
  h.chain.accounts.set(owner, { amount: '1', keys: [wallet.getPublicKey().toString()] });
  const body = await claim(wallet);
  await assert.rejects(h.coordinator.createSession(enrollment()), { code: 'wallet_claim_required' });
  const [first, retry] = await Promise.all([
    h.coordinator.claimFaucet(body, origin, 'local'),
    h.coordinator.claimFaucet(body, origin, 'local'),
  ]);
  assert.equal(first.trader_id, retry.trader_id);
  assert.equal(h.chain.balances.get(first.trader_id), 60_000);
  assert.equal(first.receipts.filter(({ label }) => label === 'trader_musdc_transfer').length, 1);
  assert.equal(h.chain.balances.get(IDS.root), 679_900);
  assert.ok(!JSON.stringify(first).includes(owner));
  assert.ok(!JSON.stringify(first).includes(body.wallet.public_key));
  await assert.rejects(h.coordinator.claimFaucet(await claim(wallet), origin, 'local'), { code: 'wallet_already_funded' });
  assert.equal(h.store.find((row) => row.trader_id === first.trader_id).wallet_claim_id.length, 64);
});

test('a valid signature cannot be moved across origin, trader, expiration or access key', async () => {
  const h = harness({ env: { XYTHUM_WALLET_FAUCET: '1' }, now: () => now });
  const wallet = browserPair();
  h.chain.accounts.set(owner, { amount: '1', keys: [wallet.getPublicKey().toString()] });
  const body = await claim(wallet);
  for (const request of [
    { ...body, ...enrollment() },
    await claim(wallet, enrollment(), { site: 'https://other.example' }),
    await claim(wallet, enrollment(), { expiry: now }),
    await claim(browserPair()),
  ]) await assert.rejects(h.coordinator.claimFaucet(request, origin, 'local'), { code: 'invalid_wallet_proof' });
  assert.equal(h.chain.calls.length, 0);
  assert.equal(h.chain.balances.get(IDS.root), 800_000);
});

test('a fresh test token registers the maker before funding the vault', async () => {
  const h = harness({ env: { XYTHUM_WALLET_FAUCET: '1' }, now: () => now });
  h.chain.registered.delete(IDS.maker);
  const wallet = browserPair();
  h.chain.accounts.set(owner, { amount: '1', keys: [wallet.getPublicKey().toString()] });
  const view = await h.coordinator.claimFaucet(await claim(wallet), origin, 'local');
  const labels = view.receipts.map(({ label }) => label);
  assert.ok(labels.indexOf('maker_registration') < labels.indexOf('maker_musdc_transfer'));
  assert.ok(labels.includes('maker_registration'));
  assert.equal(view.ledger.maker_vault, 60_100);
});
