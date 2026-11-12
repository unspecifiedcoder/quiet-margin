// Signing serialization against the official NEAR libraries, offline, with
// synthetic keys only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { KeyPair } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { createTransaction, decodeSignedTransaction, encodeTransaction } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';
import { concat, fromBase58, fromBase64, sha256, toBase58, utf8 } from '../bytes.js';
import { isEd25519PublicKey } from '../api.js';
import { loadSigner } from '../signer.js';
import { memoryBackend, Store } from '../store.js';
import { CALL_GAS, functionCall, ONE_YOCTO, signTransaction } from '../tx.js';

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pub = ed25519.getPublicKey(seed);
const nearKey = KeyPair.fromString('ed25519:' + toBase58(concat(seed, pub)));
const blockHash = toBase58(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

async function webCryptoSigner() {
  const pkcs8 = concat(Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20]), seed);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return {
    publicKey: 'ed25519:' + toBase58(pub),
    sign: async (m) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, m)),
  };
}

const actions = () => [functionCall('ft_transfer_call', {
  receiver_id: 'market.example.testnet', amount: '60000', msg: 'trader',
}, { gas: CALL_GAS, deposit: ONE_YOCTO })];

test('browser WebCrypto signing is byte-identical to @near-js/signers KeyPairSigner', async () => {
  const signer = await webCryptoSigner();
  assert.equal(signer.publicKey, nearKey.getPublicKey().toString());
  const mine = await signTransaction({
    signer, signerId: 'trader.example.testnet', receiverId: 'token.example.testnet',
    nonce: 4242, blockHash, actions: actions(),
  });
  const tx = createTransaction('trader.example.testnet', PublicKey.fromString(signer.publicKey),
    'token.example.testnet', 4242n, actions(), fromBase58(blockHash));
  const [hash, signed] = await new KeyPairSigner(nearKey).signTransaction(tx);
  assert.equal(mine.hash, toBase58(hash));
  assert.deepEqual(fromBase64(mine.signedTx), signed.encode());

  const decoded = decodeSignedTransaction(fromBase64(mine.signedTx));
  assert.equal(decoded.transaction.signerId, 'trader.example.testnet');
  assert.equal(decoded.transaction.receiverId, 'token.example.testnet');
  assert.equal(decoded.transaction.nonce, 4242n);
  const call = decoded.transaction.actions[0].functionCall;
  assert.equal(call.methodName, 'ft_transfer_call');
  assert.equal(call.gas, 80_000_000_000_000n);
  assert.equal(call.deposit, 1n);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args))), {
    receiver_id: 'market.example.testnet', amount: '60000', msg: 'trader',
  });
  assert.ok(ed25519.verify(Uint8Array.from(decoded.signature.ed25519Signature.data), await sha256(encodeTransaction(decoded.transaction)), pub));
});

test('origin-storage fallback signing matches too', async () => {
  const signer = { publicKey: 'ed25519:' + toBase58(pub), sign: async (m) => ed25519.sign(m, seed) };
  const mine = await signTransaction({
    signer, signerId: 'a.testnet', receiverId: 'b.testnet', nonce: 7, blockHash,
    actions: [functionCall('withdraw', { amount: '19800' }, { deposit: ONE_YOCTO })],
  });
  const tx = createTransaction('a.testnet', PublicKey.fromString(signer.publicKey), 'b.testnet', 7n,
    [functionCall('withdraw', { amount: '19800' }, { deposit: ONE_YOCTO })], fromBase58(blockHash));
  const [, signed] = await new KeyPairSigner(nearKey).signTransaction(tx);
  assert.deepEqual(fromBase64(mine.signedTx), signed.encode());
});

test('loadSigner keeps one non-extractable WebCrypto key across reloads', async () => {
  const store = new Store(memoryBackend());
  const first = await loadSigner(store);
  assert.equal(first.custody, 'webcrypto-nonextractable');
  assert.ok(isEd25519PublicKey(first.publicKey));
  const record = await store.get('signer');
  assert.equal(record.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', record.privateKey));
  const again = await loadSigner(store);
  assert.equal(again.publicKey, first.publicKey);
  const msg = utf8('xythum');
  assert.ok(ed25519.verify(await again.sign(msg), msg, first.publicKeyBytes));
});
