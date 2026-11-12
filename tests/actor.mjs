import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { KeyPair, Worker } from 'near-workspaces';
import near from 'near-api-js';

export const FULL_GAS = 250_000_000_000_000n;

const SHA = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const le32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};
const bytes = (text) => Buffer.from(text, 'base64');
const base64 = (value) => value.toString('base64');
const label = (text) => Buffer.from(text, 'ascii');

export function prover(command, dir, input) {
  const bin = process.env.PROVER_BIN;
  assert.ok(bin, 'set PROVER_BIN to the built xythum-prover executable');
  const result = spawnSync(bin, dir ? [command, dir] : [command], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || command + ' failed');
  return JSON.parse(result.stdout);
}

export function txEvidence(tx) {
  return {
    hash: tx.transactionReceipt.hash,
    signer: tx.transactionReceipt.signer_id,
    status: tx.status,
    gas_burnt: tx.gas_burnt,
    receipts: tx.result.receipts_outcome.map(({ id, outcome }) => ({
      id, executor_id: outcome.executor_id, gas_burnt: outcome.gas_burnt,
      status: outcome.status,
      bls_gas_profile: (outcome.metadata?.gas_profile ?? []).filter(({ cost }) => /bls12381/i.test(cost)),
    })),
  };
}

const publicDer = (key) => key.export({ type: 'spki', format: 'der' });
const privateDer = (key) => base64(key.export({ type: 'pkcs8', format: 'der' }));
const publicKey = (key) => createPublicKey({ key, type: 'spki', format: 'der' });
const privateKey = (key) => createPrivateKey({ key: bytes(key), type: 'pkcs8', format: 'der' });

function configureKeeper(keyPath, txKey) {
  const encryption = generateKeyPairSync('x25519');
  const signing = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, JSON.stringify({
    encryption: privateDer(encryption.privateKey),
    signing: privateDer(signing.privateKey),
    txKey,
  }), { mode: 0o600, flag: 'wx' });
  return {
    encryption_key: base64(publicDer(encryption.publicKey)),
    ack_key: base64(publicDer(signing.publicKey).subarray(-32)),
  };
}

const aeadKey = (secret, commitment) =>
  hkdfSync('sha256', secret, bytes(commitment), label('xythum:keeper-envelope:v1'), 32);

function encodeWitness(witness) {
  const raw = Buffer.alloc(72);
  bytes(witness.context).copy(raw, 0);
  bytes(witness.blinder).copy(raw, 32);
  raw.writeUInt16LE(witness.size_lots, 64);
  raw.writeUInt16LE(witness.entry_ticks, 66);
  raw.writeUInt32LE(witness.margin_cents, 68);
  return raw;
}

function decodeWitness(raw) {
  assert.equal(raw.length, 72);
  return {
    context: base64(raw.subarray(0, 32)),
    blinder: base64(raw.subarray(32, 64)),
    size_lots: raw.readUInt16LE(64),
    entry_ticks: raw.readUInt16LE(66),
    margin_cents: raw.readUInt32LE(68),
  };
}

function encrypt(witness, recipient, commitment) {
  const ephemeral = generateKeyPairSync('x25519');
  const secret = diffieHellman({
    privateKey: ephemeral.privateKey, publicKey: publicKey(bytes(recipient)),
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aeadKey(secret, commitment), iv);
  cipher.setAAD(bytes(commitment));
  const body = Buffer.concat([cipher.update(encodeWitness(witness)), cipher.final()]);
  return base64(Buffer.concat([publicDer(ephemeral.publicKey), iv, cipher.getAuthTag(), body]));
}

function decrypt(ciphertext, key, commitment) {
  const input = bytes(ciphertext);
  // X25519 SubjectPublicKeyInfo is a 44-byte DER encoding.
  if (input.length !== 144) throw new Error('undecryptable keeper payload');
  try {
    const secret = diffieHellman({
      privateKey: privateKey(key), publicKey: publicKey(input.subarray(0, 44)),
    });
    const decipher = createDecipheriv(
      'aes-256-gcm', aeadKey(secret, commitment), input.subarray(44, 56),
    );
    decipher.setAAD(bytes(commitment));
    decipher.setAuthTag(input.subarray(56, 72));
    return decodeWitness(Buffer.concat([decipher.update(input.subarray(72)), decipher.final()]));
  } catch {
    throw new Error('undecryptable keeper payload');
  }
}

function positionContext(market, nonce, trader) {
  return base64(SHA(label('xythum:position:v1:'), bytes(market), le32(nonce), Buffer.from(trader)));
}

function prepare({ market, nonce, trader, recipients, provingDir, fixture }) {
  const witness = {
    context: positionContext(market, nonce, trader),
    size_lots: 10,
    entry_ticks: 10_000,
    margin_cents: 50_000,
    ...fixture,
    blinder: base64(randomBytes(32)),
  };
  const opened = prover('prove-open', provingDir, witness);
  const ciphertexts = recipients.map((recipient) => encrypt(witness, recipient, opened.commitment));
  const mismatched = encrypt({ ...witness, margin_cents: witness.margin_cents + 1 }, recipients[1], opened.commitment);
  return { ...opened, ciphertexts, mismatched };
}

async function act(command, input) {
  if (command === 'configure') return configureKeeper(input.keyPath, input.txKey);
  if (command === 'prepare') return prepare(input);

  const { rpcAddr, contractId, accountId, trader, keeperIndex, keyPath, provingDir } = input;
  const { hostname, protocol } = new URL(rpcAddr);
  assert.ok(hostname === '127.0.0.1' && protocol === 'http:', 'expected local Sandbox RPC');
  const chain = await Worker.init({ network: 'custom', rpcAddr, keyStore: new near.keyStores.InMemoryKeyStore() });
  const contract = chain.rootAccount.getAccount(contractId);
  const state = await contract.view(command === 'ack' ? 'get_pending' : 'get_active');
  const market = await contract.view('get_market');
  if (!state?.ciphertexts?.[keeperIndex]) throw new Error('missing keeper payload');
  const keys = JSON.parse(readFileSync(keyPath, 'utf8'));
  const ciphertext = state.ciphertexts[keeperIndex];
  const witness = decrypt(ciphertext, keys.encryption, state.commitment);
  if (witness.context !== positionContext(market, state.nonce, trader)
    || prover('commit', undefined, witness).commitment !== state.commitment) {
    throw new Error('keeper witness commitment mismatch');
  }

  if (command === 'ack') {
    const message = Buffer.concat([
      label('xythum:keeper-ack:v1:'), bytes(market), le32(state.nonce), bytes(state.commitment),
      SHA(bytes(ciphertext)), Buffer.from([keeperIndex]), le32(1),
    ]);
    return { signature: base64(sign(null, message, privateKey(keys.signing))) };
  }

  const oracle = input.oracleOverride ?? await contract.view('get_oracle');
  assert.ok(!input.otherMarket || command === 'prove');
  const opening = input.otherMarket
    ? { ...witness, context: positionContext(input.otherMarket, state.nonce, trader) }
    : witness;
  const generated = prover('prove-liquidation', provingDir, {
    ...opening, round: oracle.round, price_ticks: oracle.price_ticks,
    funding_cents: oracle.funding_cents,
  });
  if (input.otherMarket) assert.notEqual(generated.commitment, state.commitment);
  else assert.equal(generated.commitment, state.commitment);
  const liquidation = {
    nonce: state.nonce, root: state.commitment, round: oracle.round,
    refund: generated.refund, bad_debt: generated.bad_debt, proof: generated.proof,
  };
  if (command === 'prove') return { liquidation, proving_ms: generated.proving_ms };

  assert.equal(command, 'liquidate');
  assert.equal(input.oracleOverride, undefined);
  const keeper = chain.rootAccount.getAccount(accountId);
  await keeper.setKey(KeyPair.fromString(keys.txKey));
  const tx = await keeper.callRaw(contract, 'liquidate', liquidation, { gas: FULL_GAS });
  assert.ok(tx.succeeded && tx.receiptFailures.length === 0, JSON.stringify(tx.status));
  return { liquidation, proving_ms: generated.proving_ms, tx: txEvidence(tx) };
}

if (process.argv[2]) {
  try {
    const result = await act(process.argv[2], JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}

