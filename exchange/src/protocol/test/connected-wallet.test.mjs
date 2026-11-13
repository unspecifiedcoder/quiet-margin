import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toBase58, toBase64 } from '../bytes.js';
import { unlockConnectedTrader } from '../connected-wallet.js';
import { sessionProof } from '../signer.js';
import { memoryBackend } from '../store.js';
import { nep413Digest } from '../wallet-messages.js';

const accountId = 'owner.testnet';
const origin = 'http://127.0.0.1:8791';

function wallet(seedByte, overrides = {}) {
  const seed = new Uint8Array(32).fill(seedByte);
  return {
    async signMessage(request) {
      assert.equal(request.signerId, accountId);
      assert.equal(request.network, 'testnet');
      return {
        accountId,
        publicKey: 'ed25519:' + toBase58(ed25519.getPublicKey(seed)),
        signature: toBase64(ed25519.sign(await nep413Digest(request), seed)),
        ...overrides,
      };
    },
  };
}

test('an independent browser recovers the same private trader and can prove control', async () => {
  const a = await unlockConnectedTrader(wallet(21), accountId, origin, { backend: memoryBackend() });
  const b = await unlockConnectedTrader(wallet(21), accountId, origin, { backend: memoryBackend() });
  const differentSite = await unlockConnectedTrader(wallet(21), accountId, 'https://other.example',
    { backend: memoryBackend() });
  assert.equal(a.signer.publicKey, b.signer.publicKey);
  assert.equal(await sessionProof(a.signer), await sessionProof(b.signer));
  assert.notEqual(a.signer.publicKey, differentSite.signer.publicKey);
  assert.equal((await a.store.get('signer')).privateKey.extractable, false);
});

test('refuses another account, a substituted signature and silent key changes', async () => {
  const backend = memoryBackend();
  const opts = { backend };
  await assert.rejects(unlockConnectedTrader(wallet(21, { accountId: 'other.testnet' }), accountId, origin, opts),
    /different account/);
  await assert.rejects(unlockConnectedTrader(wallet(21, { signature: toBase64(new Uint8Array(64)) }),
    accountId, origin, opts), /signature did not match/);
  await unlockConnectedTrader(wallet(21), accountId, origin, opts);
  await assert.rejects(unlockConnectedTrader(wallet(23), accountId, origin, opts), /different key/);
});
