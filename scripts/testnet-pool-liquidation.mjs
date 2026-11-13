// Testnet-only evidence runner. The cold phase has no trader or Keeper A key.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { KeyPair } from 'near-workspaces';
import { connectChain, demoAccounts, TESTNET_RPC, viewFinal, waitFinal } from './testnet-client.mjs';
import { PoolClient } from '../exchange/src/protocol/shielded-pool.js';
import { loadPoolHashes, poolKeeper, poolProve } from '../exchange/server/pool-keepers.mjs';

const [phase, dir = '.testnet/shielded/keeper-demo'] = process.argv.slice(2);
assert(['open', 'cold', 'live'].includes(phase), 'Use open, cold or live.');
await mkdir(dir, { recursive: true });
const chain = await connectChain(TESTNET_RPC, true);
const path = (name) => resolve(dir, name);
const saved = await readFile(path('public.json'), 'utf8').then(JSON.parse).catch((e) => {
  if (e.code !== 'ENOENT') throw e;
  return null;
});
const pool = saved?.pool ?? JSON.parse(await readFile('.testnet/shielded/' + (phase === 'live' ? 'live-config.json' : 'keeper-config.json'), 'utf8')).pool;
const view = (method, args = {}) => viewFinal(chain, pool, method, args);
const hashes = await loadPoolHashes(resolve('exchange/public/shielded/judge-pool/xythum_prover.js'));
const binary = resolve('prover/target/release/quiet-pool-prover' + (process.platform === 'win32' ? '.exe' : ''));
const liquidationKeys = resolve('.testnet/shielded/keeper-v3-keys');
const tradeKeys = resolve('.testnet/shielded/judge-side-keys');
const cfg = await view('get_keeper_config');
assert.equal(cfg.live_oracle, phase === 'live');
const info = saved ?? { pool, positions: [] };
const save = () => writeFile(path('public.json'), JSON.stringify(info, null, 2) + '\n');
const remember = async (record, label, tx, ok = true, expected) => {
  assert.equal(tx.succeeded && tx.receiptFailures.length === 0, ok, label);
  if (expected) assert.match(JSON.stringify(tx.receiptFailures), expected);
  const final = await waitFinal(chain, tx);
  record[label] = { hash: tx.transactionReceipt.hash, block: final.transaction_outcome.block_hash,
    signer: tx.transactionReceipt.signer_id };
  await save();
};

if (phase !== 'cold') {
  assert(!saved, 'Use a fresh evidence directory for opening.');
  const operator = parseEnv(await readFile('.testnet/quiet-margin-wallet-recording/treasury.env', 'utf8'));
  const demo = parseEnv(await readFile('.testnet/quiet-margin-wallet-recording/.env', 'utf8'));
  const [demoKeyName] = Object.keys(demo).filter((k) => /SECRET_KEY|PRIVATE_KEY/.test(k));
  const traderKey = KeyPair.fromString(demo[demoKeyName]);
  const roles = {
    trader: { id: demo.NEAR_ACCOUNT_ID, key: traderKey },
    oracle: { id: operator.NEAR_ORACLE_ACCOUNT_ID, key: KeyPair.fromString(operator.NEAR_ORACLE_SECRET_KEY) },
  };
  const settlementKey = KeyPair.fromRandom('ed25519');
  const settlementId = Buffer.from(settlementKey.getPublicKey().data).toString('hex');
  if (phase === 'live') {
    roles.privateTrader = { id: settlementId, key: settlementKey };
    await writeFile(path('trader.env'), 'NEAR_ACCOUNT_ID=' + settlementId + '\nNEAR_SECRET_KEY='
      + settlementKey.toString() + '\n', { flag: 'wx', mode: 0o600 });
  }
  const { trader, oracle, privateTrader } = await demoAccounts(chain, roles);
  if (privateTrader) await remember(info, 'traderGas', await trader.transfer(settlementId, 35n * 10n ** 22n));
  const keepers = ['A', 'B'].map((side, index) => poolKeeper({ pool, hashes, index,
    encryption: operator['NEAR_KEEPER_' + side + '_ENCRYPTION_SECRET'],
    acknowledgment: operator['NEAR_KEEPER_' + side + '_ACK_SECRET'] }));
  const cold = {};
  for (const field of ['ACCOUNT_ID', 'SECRET_KEY', 'ENCRYPTION_SECRET', 'ACK_SECRET']) {
    cold['KEEPER_' + field] = operator['NEAR_KEEPER_B_' + field];
  }
  for (const field of ['ACCOUNT_ID', 'SECRET_KEY']) cold['ORACLE_' + field] = operator['NEAR_ORACLE_' + field];
  await writeFile(path('.env'), Object.entries(cold).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 });
  if (phase === 'live') {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['scripts/shielded-pool-operator.mjs', 'oracle', pool,
      '.testnet/quiet-margin-wallet-recording/treasury.env'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split(/\r?\n/).find((line) => line.startsWith('{"transaction":'));
    assert(line, 'Run the live smoke with the periodic publisher stopped.');
    info.liveMark = JSON.parse(line);
    await save();
  } else await remember(info, 'initialMark', await oracle.callRaw(pool, 'publish_mark', { price_ticks: 6880 }));
  for (const short of phase === 'live' ? [true] : [false, true]) {
    const state = await view('get_pool');
    const row = { short };
    info.positions.push(row);
    const data = new Map();
    const signer = { publicKey: traderKey.getPublicKey().toString(), sign: (digest) => traderKey.sign(digest).signature };
    const client = new PoolClient({ account: trader.accountId, wallet: {}, pool, token: state.token, hashes,
      trader: { signer, store: { getSealed: async (k) => data.get(k), putSealed: async (k, v) => data.set(k, v) } },
      keeperAck: (i, payload) => keepers[i].acknowledge(payload),
      prove: async (kind, _fingerprint, witness) => (await poolProve(binary, tradeKeys, kind, witness)).proof,
    });
    const { sign } = signer;
    // Distinct note ownership per position; the trader signing the real NEAR transaction is unchanged.
    signer.sign = (digest) => sign(new Uint8Array([...digest, short ? 1 : 0]));
    client.exclusive = (run) => run();
    client.journalStore = { get: async () => null };
    // Initialize note state without the browser's signing journal; real NEAR calls use the demo wallet.
    client.state = () => view('get_pool');
    client.domain = Buffer.from(state.domain, 'base64');
    client.owner = await (await import('../exchange/src/protocol/bytes.js')).sha256(await signer.sign(client.domain));
    client.depth = 6;
    client.keeperConfig = cfg;
    client.call = async (method, args) => {
      const sender = privateTrader ?? trader;
      if (method === 'close_private') {
        await remember(row, 'close', await sender.callRaw(pool, method, args, { gas: 150_000_000_000_000n }));
        return row.close.hash;
      }
      row.commitment = args.commitment;
      if (phase === 'open' && !info.badAck) {
        const bad = { ...args, acknowledgments: [args.acknowledgments[1], args.acknowledgments[1]] };
        await remember(info, 'badAck', await sender.callRaw(pool, method, bad, { gas: 160_000_000_000_000n }), false, /ERR_KEEPER_ACK/);
      }
      await remember(row, 'open', await sender.callRaw(pool, method, args, { gas: 160_000_000_000_000n }));
    };
    const { randomBytes } = await import('node:crypto');
    const note = { cents: 3000, salt: [...randomBytes(32)] };
    const fields = await client.noteFields(note);
    await client.save({ notes: [note], positions: [] });
    await remember(row, 'deposit', await trader.callRaw(state.token, 'ft_transfer_call', {
      receiver_id: pool, amount: '3000', msg: fields.inner,
    }, { gas: 100_000_000_000_000n, attachedDeposit: 1n }));
    await client.open('30', 1, short);
    const pos = await view('get_keeper_position', { commitment: row.commitment });
    assert.equal(pos.envelopes.length, 2);
    assert(pos.envelopes.every((e) => Buffer.from(e, 'base64').length === 113));
    const vault = await client.records();
    // Private evidence is sealed from the cold keeper phase: no owner secret is persisted for it.
    assert.equal(vault.positions.length, 1);
    if (phase === 'live') {
      assert.equal(vault.positions[0].entry, info.liveMark.price_ticks);
      await client.close();
      assert.equal((await client.read()).balance, 3000);
      assert.equal((await client.read()).position, undefined);
    }
  }
} else {
  assert.equal(info.positions.length, 2, 'Open both positions before running the cold keeper.');
  const env = parseEnv(await readFile(path('.env'), 'utf8'));
  const { keeper, oracle } = await demoAccounts(chain, {
    keeper: { id: env.KEEPER_ACCOUNT_ID, key: KeyPair.fromString(env.KEEPER_SECRET_KEY) },
    oracle: { id: env.ORACLE_ACCOUNT_ID, key: KeyPair.fromString(env.ORACLE_SECRET_KEY) },
  });
  const backup = poolKeeper({ pool, hashes, index: 1, encryption: env.KEEPER_ENCRYPTION_SECRET,
    acknowledgment: env.KEEPER_ACK_SECRET });
  const update = async (row, label, price_ticks) => {
    await remember(row, label, await oracle.callRaw(pool, 'publish_mark', { price_ticks }));
    return view('get_pool');
  };
  for (const row of info.positions) {
    if (row.liquidation) continue;
    const trigger = row.short ? 9600 : 4000;
    const healthy = await update(row, 'healthyMark', 6880);
    assert.equal(await backup.opening(row.commitment, healthy), null);
    const opening = await backup.opening(row.commitment, healthy, { requireUnhealthy: false });
    // Same round, different price: valid proof cannot pass NEAR at the healthy mark.
    const wrong = await poolProve(binary, liquidationKeys, 'liquidation', { ...opening, price: trigger });
    const args = (state, proof) => ({ commitment: row.commitment, round: state.round,
      ...proof.settlement, proof: proof.proof });
    const liquidate = (args) => keeper.callRaw(pool, 'liquidate_private', args, { gas: 150_000_000_000_000n });
    await remember(row, 'healthyRejected', await liquidate(args(healthy, wrong)), false, /ERR_PROOF_INVALID/);
    assert((await view('get_pool')).positions.includes(row.commitment));
    const unhealthy = await update(row, 'triggerMark', trigger);
    const witness = await backup.opening(row.commitment, unhealthy);
    assert(witness, 'Backup keeper could not recover unhealthy witness.');
    const proof = await poolProve(binary, liquidationKeys, 'liquidation', witness);
    await remember(row, 'liquidation', await liquidate(args(unhealthy, proof)));
    const after = await view('get_pool');
    assert(!after.positions.includes(row.commitment));
    assert(after.leaves.includes(proof.settlement.payout));
    assert.equal(await view('get_liquidation_credit', { commitment: row.commitment }), proof.settlement.maker_credit);
    row.shieldedEquityCents = 60_000 + witness.margin - Number(proof.settlement.maker_credit);
    assert.equal(row.shieldedEquityCents, row.short ? 280 : 120);
    await remember(row, 'replayRejected', await liquidate(args(unhealthy, proof)), false, /ERR_NO_POSITION/);
  }
}
console.log('Verified testnet phase:', phase, path('public.json'));
