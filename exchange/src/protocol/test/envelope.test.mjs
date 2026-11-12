// Browser keeper envelopes against the Node keeper code in tests/actor.mjs.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decryptWitness, encryptWitness } from '../envelope.js';
import * as M from '../model.js';
import { fromBase64, toBase64 } from '../bytes.js';
import { configureKeeper, decrypt, encodeWitness, encrypt, positionContext, quoteDigest } from './actor-reference.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xythum-envelope-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function keeper(index) {
  const path = join(dir, 'keeper-' + index + '.json');
  const pub = configureKeeper(path, 'ed25519:synthetic');
  const keys = JSON.parse(readFileSync(path, 'utf8'));
  const jwk = createPrivateKey({ key: Buffer.from(keys.encryption, 'base64'), type: 'pkcs8', format: 'der' })
    .export({ format: 'jwk' });
  return { spki: pub.encryption_key, pkcs8: keys.encryption, raw: new Uint8Array(Buffer.from(jwk.d, 'base64url')) };
}

const keepers = [keeper(0), keeper(1)];
const market = new Uint8Array(randomBytes(32));
const witness = {
  context: toBase64(await M.positionContext(market, 3, 1234, 'trader.example.testnet')),
  blinder: randomBytes(32).toString('base64'),
  size_lots: 37,
  entry_ticks: 10_490,
  margin_cents: 54_321,
};
const commitment = toBase64(await M.commitment(witness));

test('context, commitment preimage and quote digest equal the actor encodings', async () => {
  assert.equal(witness.context, positionContext(toBase64(market), 3, 1234, 'trader.example.testnet'));
  assert.deepEqual(M.encodeWitness(witness), new Uint8Array(encodeWitness(witness)));
  assert.equal(commitment, createHash('sha256').update(encodeWitness(witness)).digest('base64'));
  const quote_blinder = randomBytes(32).toString('base64');
  assert.equal(toBase64(await M.quoteTerms({ ...witness, quote_blinder })),
    quoteDigest({ context: witness.context, quote_blinder, size_lots: 37, entry_ticks: 10_490 }));
});

test('browser envelopes decrypt with the Node keeper code for both keepers', async () => {
  for (const k of keepers) {
    const ciphertext = await encryptWitness(witness, k.spki, commitment);
    assert.equal(fromBase64(ciphertext).length, 144);
    assert.deepEqual(decrypt(ciphertext, k.pkcs8, commitment), witness);
  }
});

test('Node keeper envelopes decrypt with the browser code', async () => {
  const ciphertext = encrypt(witness, keepers[1].spki, commitment);
  assert.deepEqual(await decryptWitness(ciphertext, keepers[1].raw, commitment), witness);
});

test('envelopes are bound to the recipient and the commitment', async () => {
  const ciphertext = await encryptWitness(witness, keepers[0].spki, commitment);
  assert.throws(() => decrypt(ciphertext, keepers[1].pkcs8, commitment), /undecryptable/);
  const other = toBase64(new Uint8Array(randomBytes(32)));
  assert.throws(() => decrypt(ciphertext, keepers[0].pkcs8, other), /undecryptable/);
  const raw = fromBase64(ciphertext);
  raw[100] ^= 1;
  assert.throws(() => decrypt(toBase64(raw), keepers[0].pkcs8, commitment), /undecryptable/);
  // Fresh ephemeral key and IV each time.
  assert.notEqual(await encryptWitness(witness, keepers[0].spki, commitment), ciphertext);
});

test('malformed keeper keys are refused', async () => {
  await assert.rejects(encryptWitness(witness, toBase64(new Uint8Array(44)), commitment), /X25519 SPKI/);
  const zero = fromBase64(keepers[0].spki);
  zero.fill(0, 12);
  await assert.rejects(encryptWitness(witness, toBase64(zero), commitment), /degenerate/);
});
