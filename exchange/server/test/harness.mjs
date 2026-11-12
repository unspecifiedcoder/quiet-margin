import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { loadConfig } from '../config.mjs';
import { Coordinator } from '../coordinator.mjs';
import { MemoryStore } from '../store.mjs';
import { CODE_HASH, FINGERPRINTS, IDS, MARKET_DEPLOY_KEY, MockChain } from './mock-chain.mjs';

export const RPC = 'https://test.rpc.fastnear.com';
export const ACK_KEYS = [randomBytes(32).toString('base64'), randomBytes(32).toString('base64')];
export const ENC_KEYS = ['MCowBQYDK2VuAyEA' + 'a'.repeat(43) + '=', 'MCowBQYDK2VuAyEA' + 'b'.repeat(43) + '='];

export const browserKey = () => KeyPair.fromRandom('ed25519').getPublicKey().toString();
export const browserPair = () => KeyPair.fromRandom('ed25519');

// What the browser posts: its public key and an Ed25519 signature over the
// session enrollment message, as canonical padded Base64.
export function enrollment(pair = browserPair()) {
  const public_key = pair.getPublicKey().toString();
  const message = Buffer.from('xythum:exchange:session:v1:testnet:' + public_key, 'utf8');
  return { public_key, proof: Buffer.from(pair.sign(message).signature).toString('base64') };
}

export function harness({ env = {}, chain = new MockChain(), store = new MemoryStore(), actors, now } = {}) {
  const config = loadConfig({ XYTHUM_SESSION_QUOTA: '3', XYTHUM_MARK_INTERVAL_MS: '0', ...env });
  const actorCalls = [];
  const defaultActors = {
    async ack(session, index) {
      actorCalls.push({ command: 'ack', index, market: session.market_id });
      return randomBytes(64).toString('base64');
    },
    async liquidate(session) {
      actorCalls.push({ command: 'liquidate', market: session.market_id });
      throw new Error('position is healthy at this oracle round (equity is at least 5% maintenance)');
    },
  };
  const coordinator = new Coordinator({
    config, store, chain, chainId: 'testnet', rpcUrl: RPC, ids: IDS,
    keeperAckKeys: ACK_KEYS, keeperEncryptionKeys: ENC_KEYS, marketDeployKey: MARKET_DEPLOY_KEY,
    vks: { open_vk: 'b3Blbg==', liquidation_vk: 'bGlx', close_vk: 'Y2xvc2U=' },
    fingerprints: FINGERPRINTS, marketWasm: Buffer.alloc(1000), marketCodeHash: CODE_HASH,
    actors: actors ?? defaultActors, ...(now ? { now } : {}),
  });
  return { coordinator, chain, store, config, actorCalls };
}
