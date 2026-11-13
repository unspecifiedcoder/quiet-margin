import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Rpc, TESTNET_RPC } from '../src/protocol/rpc.js';
import { poseidonPool } from '../src/protocol/shielded-pool.js';
import { belowMaintenance, openPoolEnvelope, poolAckMessage, validateOpening } from '../src/protocol/pool-keeper.js';

export async function loadPoolHashes(wasmPath) {
  const wasm = await import(pathToFileURL(wasmPath).href);
  const buffer = await readFile(new URL('./xythum_prover_bg.wasm', pathToFileURL(wasmPath)));
  await wasm.default({ module_or_path: buffer });
  return poseidonPool(wasm, true);
}

const keyFrom = (der) => createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });
const publicSpki = (key) => createPublicKey(key).export({ type: 'spki', format: 'der' });
const bytes = (text) => [...Buffer.from(text, 'base64')];

export function poolKeeper({ pool, hashes, index, encryption, acknowledgment, rpc = new Rpc(TESTNET_RPC) }) {
  const key = keyFrom(encryption);
  const raw = Buffer.from(key.export({ format: 'jwk' }).d, 'base64url');
  const ack = keyFrom(acknowledgment);
  const encryptionKey = publicSpki(key).toString('base64');
  const ackKey = publicSpki(ack).subarray(-32).toString('base64');
  let config;
  async function configured() {
    config ??= await rpc.view(pool, 'get_keeper_config');
    const keeper = config.keepers[index];
    if (keeper?.encryption_key !== encryptionKey || keeper?.acknowledgment_key !== ackKey) {
      throw new Error('Local keys do not match the pool keeper configuration.');
    }
    return keeper;
  }
  async function decode(payload) {
    const opening = await openPoolEnvelope(payload.envelope, raw, payload.commitment);
    validateOpening(hashes, payload, opening);
    return opening;
  }
  return {
    async acknowledge(payload) {
      const [state] = await Promise.all([rpc.view(pool, 'get_pool'), configured(), decode(payload)]);
      const message = await poolAckMessage(state.domain, index, payload);
      return sign(null, message, ack).toString('base64');
    },
    async opening(commitment, state, { requireUnhealthy = true } = {}) {
      await configured();
      const pos = await rpc.view(pool, 'get_keeper_position', { commitment });
      if (!pos) return null;
      const payload = { commitment, context: pos.context, owner_tag: pos.owner_tag, envelope: pos.envelopes[index] };
      const opening = await decode(payload);
      if (requireUnhealthy && !belowMaintenance(opening, state.price_ticks)) return null;
      return { ...opening, commitment: bytes(commitment), context: bytes(pos.context),
        owner_tag: bytes(pos.owner_tag), domain: bytes(state.domain), price: state.price_ticks, round: state.round };
    },
  };
}

export function poolProve(binary, keys, kind, witness) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['prove-pool-v3', keys, kind], { windowsHide: true, timeout: 120_000 });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > 8192) child.kill();
    });
    child.stderr.resume(); // Never copy an error that could contain private input to a log.
    child.stdin.on('error', reject);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('Pool proof generation failed.'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Pool proof response is invalid.')); }
    });
    child.stdin.end(JSON.stringify(witness));
  });
}
