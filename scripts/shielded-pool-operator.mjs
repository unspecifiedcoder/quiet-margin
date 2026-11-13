import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { KeyPair } from 'near-workspaces';
import { connectChain, demoAccounts, TESTNET_RPC, viewFinal, waitFinal } from './testnet-client.mjs';
import { loadPoolHashes, poolKeeper, poolProve } from '../exchange/server/pool-keepers.mjs';

const [mode, pool, envFile, role, command] = process.argv.slice(2);
assert(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.testnet$/.test(pool), 'A NEAR testnet pool is required.');
const env = parseEnv(await readFile(resolve(envFile), 'utf8'));
const chain = await connectChain(TESTNET_RPC, true);
const view = (method, args = {}) => viewFinal(chain, pool, method, args);
const getSigner = async (role) => (await demoAccounts(chain, { signer: {
  id: env['NEAR_' + role + '_ACCOUNT_ID'], key: KeyPair.fromString(env['NEAR_' + role + '_SECRET_KEY']),
} })).signer;
const send = async (signer, method, args, gas = 100_000_000_000_000n) => {
  const tx = await signer.callRaw(pool, method, args, { gas });
  if (!tx.succeeded || tx.receiptFailures.length) throw new Error('Testnet rejected ' + method + ': ' + tx.transactionReceipt.hash);
  await waitFinal(chain, tx);
  return tx.transactionReceipt.hash;
};
const continuous = command === '--watch' || role === '--watch';
const keys = resolve(process.env.QUIET_POOL_LIQUIDATION_KEYS ?? '.testnet/shielded/keeper-v3-keys');
const binary = resolve(process.env.QUIET_POOL_PROVER ?? 'prover/target/release/quiet-pool-prover'
  + (process.platform === 'win32' ? '.exe' : ''));

async function latestTrade() {
  const response = await fetch('https://data-api.binance.vision/api/v3/trades?symbol=BTCUSDT&limit=1',
    { signal: AbortSignal.timeout(8_000), redirect: 'error' });
  assert(response.ok, 'BTC reference feed is unavailable.');
  const trades = await response.json();
  assert(Array.isArray(trades) && trades.length === 1);
  const { price, time } = trades[0];
  assert(typeof price === 'string' && /^\d+(\.\d+)?$/.test(price) && Number.isSafeInteger(time));
  assert(Date.now() - time < 20_000 && time <= Date.now() + 1500, 'BTC reference trade is stale.');
  const price_ticks = Math.round(Number(price) / 10);
  assert(price_ticks >= 1 && price_ticks <= 20_000);
  return { price_ticks, observed_at: Math.floor(time / 1000), sourcePrice: price };
}

let run;
const cfg = await view('get_keeper_config');
if (mode === 'oracle') {
  assert(cfg.live_oracle, 'This pool is configured for a controlled mark.');
  const signer = await getSigner('ORACLE');
  run = async () => {
    const mark = await latestTrade();
    const current = await view('get_keeper_config');
    if (mark.observed_at <= current.observed_at) return;
    // No no-op round changes while the last mark is still useful.
    if (Date.now() / 1000 - current.observed_at < 40) return;
    const { sourcePrice, ...args } = mark;
    console.log(JSON.stringify({ transaction: await send(signer, 'publish_live_mark', args), sourcePrice, ...args }));
  };
} else {
  assert(mode === 'keeper' && ['A', 'B'].includes(role), 'Use keeper A or B, or oracle.');
  const name = 'KEEPER_' + role;
  const index = role === 'A' ? 0 : 1;
  const hashes = await loadPoolHashes(resolve('exchange/public/shielded/judge-pool/xythum_prover.js'));
  const keeper = poolKeeper({ pool, hashes, index, encryption: env['NEAR_' + name + '_ENCRYPTION_SECRET'],
    acknowledgment: env['NEAR_' + name + '_ACK_SECRET'] });
  const signer = await getSigner(name);
  run = async () => {
    const state = await view('get_pool');
    const mark = cfg.live_oracle ? await view('get_keeper_config') : cfg;
    if (cfg.live_oracle && Date.now() / 1000 - mark.observed_at > 80) return;
    for (const commitment of state.positions) {
      const opening = await keeper.opening(commitment, state);
      if (!opening) continue;
      const { proof, settlement } = await poolProve(binary, keys, 'liquidation', opening);
      if ((await view('get_pool')).round !== state.round) continue;
      const hash = await send(signer, 'liquidate_private', { commitment, round: state.round, ...settlement, proof });
      console.log(JSON.stringify({ transaction: hash, commitment, round: state.round, keeper: role }));
    }
  };
}
do {
  try { await run(); }
  catch (error) {
    if (!continuous) throw error;
    console.error('Operator pass failed; retrying.');
  }
  if (continuous) await wait(mode === 'oracle' ? 6000 : 4000);
} while (continuous);
