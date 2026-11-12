import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actor, FULL_GAS, makerApproval, prover, txEvidence } from '../tests/actor.mjs';
import { connectChain, demoAccounts, loadDemoEnv, TESTNET_DIR, TESTNET_GAS, TESTNET_RPC, viewFinal, waitFinal } from './testnet-client.mjs';

const command = process.argv[2];
assert.ok(['deploy', 'run', 'resume-active'].includes(command), 'use deploy, run, or resume-active');
const { env, roles } = loadDemoEnv();
const chain = await connectChain(TESTNET_RPC, true);
const accounts = await demoAccounts(chain, roles);
const { DEMO: root, MARKET: market, TOKEN: token, TRADER: trader, MAKER: maker,
  ORACLE: oracle, KEEPER_A: keeperA, KEEPER_B: keeperB } = accounts;
const provingDir = join(TESTNET_DIR, 'proving');
const witnessDir = join(TESTNET_DIR, 'witnesses');
const positionDir = join(TESTNET_DIR, 'positions');
const noCode = '11111111111111111111111111111111';
const keeperRoles = ['KEEPER_A', 'KEEPER_B'];
const keepers = [keeperA, keeperB];
const ONE_YOCTO = { attachedDeposit: 1n };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const vkNames = ['open', 'liquidation', 'close'];
const keyFiles = vkNames.flatMap((kind) => [kind + '.pk', kind + '.vk']);

function positionId(commitment) {
  const raw = Buffer.from(commitment, 'base64');
  assert.equal(raw.length, 32);
  return raw.toString('hex');
}

const witnessFile = (commitment) => join(witnessDir, positionId(commitment) + '.witness.json');
const positionFile = (commitment) => join('positions', positionId(commitment) + '.json');

await mkdir(TESTNET_DIR, { recursive: true });
const view = (account, method, args) => viewFinal(chain, account.accountId, method, args);

async function record(file, value) {
  const path = join(TESTNET_DIR, file);
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}

async function call(account, target, method, args, options) {
  const result = await account.callRaw(target, method, args, { gas: TESTNET_GAS, ...options });
  assert.ok(result.succeeded && result.receiptFailures.length === 0,
    method + ' failed: ' + JSON.stringify(result.failures));
  try {
    await waitFinal(chain, result);
  } catch (error) {
    console.error('Check testnet transaction ' + result.transactionReceipt.hash);
    throw error;
  }
  return txEvidence(result);
}

async function loadProofKeys(create) {
  if (keyFiles.every((file) => existsSync(join(provingDir, file)))) return prover('keys', provingDir);
  assert.ok(create, 'restore the complete proving-key backup for this deployment');
  if (existsSync(provingDir)) {
    assert.equal((await market.accountView()).code_hash, noCode,
      'restore the complete proving-key backup for this deployment');
    await rename(provingDir, join(TESTNET_DIR, 'incomplete-proving-' + randomUUID()));
  }
  const staged = await mkdtemp(join(TESTNET_DIR, 'proving-build-'));
  try {
    const keys = prover('setup', staged);
    await rename(staged, provingDir);
    return keys;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

async function assertConfig(keys) {
  const config = await view(market, 'get_config');
  const expectedRoles = {
    token_id: token.accountId, trader_id: trader.accountId, maker_id: maker.accountId,
    oracle_id: oracle.accountId,
  };
  for (const [name, account] of Object.entries(expectedRoles)) assert.equal(config[name], account);
  assert.deepEqual(config.keepers, keepers.map((account, index) => ({
    account_id: account.accountId,
    ack_key: env['NEAR_' + keeperRoles[index] + '_ACK_PUBLIC'],
  })));
  assert.equal(config.deployment_id, env.NEAR_DEPLOYMENT_ID);
  for (const kind of vkNames) assert.equal(config[kind + '_vk_sha256'], keys[kind + '_vk_sha256']);
}

async function deploy(account, wasm, method, args) {
  const state = await account.accountView();
  if (state.code_hash !== noCode) {
    assert.equal(sha256(await account.viewCode()), sha256(wasm), 'existing Wasm differs for ' + account.accountId);
    return;
  }
  const result = await account.batch(account)
    .deployContract(wasm)
    .functionCall(method, args, { gas: FULL_GAS })
    .transact();
  assert.ok(result.succeeded && result.receiptFailures.length === 0,
    'deploy failed for ' + account.accountId + ': ' + JSON.stringify(result.failures));
  await waitFinal(chain, result);
  return txEvidence(result);
}

async function deployDemo() {
  const keys = await loadProofKeys(true);
  const wasm = await readFile(process.env.MARKET_WASM ?? 'target/near/xythum_near_perps.wasm');
  const mock = await readFile(process.env.MOCK_TOKEN_WASM ?? 'target/mock/xythum_near_perps.wasm');
  let evidence;
  try {
    evidence = JSON.parse(await readFile(join(TESTNET_DIR, 'deployment.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    evidence = {
      network: 'testnet',
      rpc: TESTNET_RPC,
      accounts: Object.fromEntries(Object.entries(accounts).map(([role, value]) => [role, value.accountId])),
      deployment_id: env.NEAR_DEPLOYMENT_ID,
      transactions: {},
    };
  }
  assert.equal(evidence.deployment_id, env.NEAR_DEPLOYMENT_ID);
  evidence.market_wasm = { size_bytes: wasm.length, sha256: sha256(wasm) };
  evidence.token_wasm = { size_bytes: mock.length, sha256: sha256(mock) };
  evidence.verifying_key_fingerprints = Object.fromEntries(
    vkNames.map((kind) => [kind, keys[kind + '_vk_sha256']]),
  );
  const tokenDeployment = await deploy(token, mock, 'new', {
    owner_id: root.accountId, total_supply: '1000000',
  });
  if (tokenDeployment) evidence.transactions.token = tokenDeployment;
  const metadata = await view(token, 'ft_metadata');
  assert.equal(metadata.symbol, 'mUSDC');
  assert.equal(metadata.decimals, 2);
  await record('deployment.json', evidence);

  const marketDeployment = await deploy(market, wasm, 'init', {
    token_id: token.accountId, trader_id: trader.accountId, maker_id: maker.accountId,
    oracle_id: oracle.accountId,
    keepers: keepers.map((account, index) => ({
      account_id: account.accountId, ack_key: env['NEAR_' + keeperRoles[index] + '_ACK_PUBLIC'],
    })),
    deployment_id: env.NEAR_DEPLOYMENT_ID,
    open_vk: keys.open_vk, liquidation_vk: keys.liquidation_vk, close_vk: keys.close_vk,
  });
  if (marketDeployment) evidence.transactions.market = marketDeployment;
  await assertConfig(keys);
  evidence.market_id = await view(market, 'get_market');
  await record('deployment.json', evidence);
  console.log('Verified deployed contracts ' + token.accountId + ' and ' + market.accountId);
}

async function runDemo() {
  await assertConfig(await loadProofKeys(false));
  const ledger = () => view(market, 'get_ledger');
  const active = () => view(market, 'get_active');
  assert.equal(await active(), null, 'an active position must be settled before starting a new demo');
  assert.equal((await ledger()).halted, false, 'the market is halted');
  const initialNonce = (await ledger()).next_nonce;
  const evidenceFile = 'demo-' + initialNonce + '.json';
  const evidence = {
    network: 'testnet', market: market.accountId, token: token.accountId,
    initial_nonce: initialNonce, oracle_rounds: [], transactions: {},
  };
  const journalPath = join(TESTNET_DIR, evidenceFile);
  if (existsSync(journalPath)) {
    const previous = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(previous.market, market.accountId);
    assert.equal(previous.initial_nonce, initialNonce);
    assert.equal(previous.complete, undefined);
    evidence.transactions = previous.transactions;
  }
  const save = () => record(evidenceFile, evidence);
  const track = async (name, tx) => {
    evidence.transactions[name] = await tx;
    await save();
    console.log(name + ' ' + evidence.transactions[name].hash);
  };
  const storageBalance = (account) => view(token, 'storage_balance_of', { account_id: account.accountId });
  const tokenBalance = async (account) => Number(await view(token, 'ft_balance_of', { account_id: account.accountId }));
  const ensureRegistered = async (account) => {
    if (await storageBalance(account) !== null) return;
    await track('register_' + account.accountId, call(root, token, 'storage_deposit', {
      account_id: account.accountId, registration_only: true,
    }, { attachedDeposit: 10n ** 22n }));
  };

  for (const account of [market, trader, maker, keeperB]) await ensureRegistered(account);
  for (const [name, account, available, minimum] of [
    ['trader', trader, (await ledger()).trader_available, 60_000],
    ['maker', maker, (await ledger()).maker_vault, 100_000],
  ]) {
    const needed = Math.max(minimum - available, 0);
    if (needed === 0) continue;
    const topUp = Math.max(needed - await tokenBalance(account), 0);
    if (topUp > 0) {
      await track(name + '_transfer', call(root, token, 'ft_transfer',
        { receiver_id: account.accountId, amount: String(topUp) }, ONE_YOCTO));
    }
    await track(name + '_deposit', call(account, token, 'ft_transfer_call', {
      receiver_id: market.accountId, amount: String(needed), msg: name,
    }, ONE_YOCTO));
  }
  const funded = await ledger();
  assert.ok(funded.trader_available >= 60_000 && funded.maker_vault >= 100_000);
  evidence.funded = funded;
  const fundedBalance = await tokenBalance(market);
  assert.equal(fundedBalance,
    funded.trader_available + funded.maker_vault + funded.keeper_available.reduce((a, b) => a + b, 0));
  const oldOracle = await view(market, 'get_oracle');
  let round = oldOracle?.round ?? 0;
  const checkpoint = oldOracle?.funding_cents ?? 0;
  assert.ok(checkpoint <= 0xffff_ffff - 400);
  const publish = async (name, price_ticks, funding_cents) => {
    round += 1;
    await track(name, call(oracle, market, 'publish_oracle', { round, price_ticks, funding_cents }));
    const current = await view(market, 'get_oracle');
    assert.equal(current.round, round);
    evidence.oracle_rounds.push(current);
    await save();
    return current;
  };

  await mkdir(positionDir, { recursive: true });
  await mkdir(witnessDir, { recursive: true });
  await withKeepers(async (keeperInput) => {
    const marketId = await view(market, 'get_market');
    const admit = async (name, nonce, fundingCheckpoint) => {
      const temporaryWitness = name === 'profit'
        ? join(witnessDir, 'pending-' + randomUUID() + '.witness.json')
        : undefined;
      const prepared = actor('prepare', {
        market: marketId, nonce, trader: trader.accountId, fundingCheckpoint, openPriceTicks: 10_000,
        recipients: keeperRoles.map((role) => env['NEAR_' + role + '_ENCRYPTION_PUBLIC']),
        provingDir, traderWitnessPath: temporaryWitness,
      });
      const { commitment, quote_terms, ciphertexts, proof } = prepared;
      const position = { market: market.accountId, nonce, commitment, fundingCheckpoint, fixture: name };
      await record(positionFile(commitment), position);
      if (temporaryWitness) await rename(temporaryWitness, witnessFile(commitment));
      await track(name + '_stage', call(trader, market, 'stage_position', { nonce, commitment, quote_terms, ciphertexts }));
      const pending = await view(market, 'get_pending');
      assert.equal(pending.funding_checkpoint, fundingCheckpoint);
      const terms = makerApproval(pending, prepared.offer, marketId, trader.accountId);
      const block = await chain.provider.block({ finality: 'final' });
      await track(name + '_quote', call(maker, market, 'approve_quote', {
        ...terms, expires_at: block.header.height + 500,
      }));
      const acknowledgments = [0, 1].map((index) => actor('ack', keeperInput(index)).signature);
      await track(name + '_open', call(trader, market, 'open', { nonce, commitment, acknowledgments, proof }));
      assert.equal((await active()).commitment, commitment);
      return commitment;
    };

    await publish('entry_oracle', 10_000, checkpoint);
    const profitCommitment = await admit('profit', initialNonce, checkpoint);
    const traderWitnessPath = witnessFile(profitCommitment);
    await publish('profit_oracle', 12_000, checkpoint + 200);
    const close = actor('prove-close', { ...actorInput, traderWitnessPath }).close;
    assert.equal(close.refund, 79_800);
    assert.equal(close.bad_debt, 0);
    await track('profit_close', call(trader, market, 'close', close));
    const closed = await ledger();
    assert.equal(closed.trader_available, funded.trader_available + 19_800);
    assert.equal(closed.maker_vault, funded.maker_vault - 19_800);
    assert.equal(await active(), null);
    const traderBefore = await tokenBalance(trader);
    await track('profit_withdraw', call(trader, market, 'withdraw', { amount: '19800' }, ONE_YOCTO));
    assert.equal(await tokenBalance(trader), traderBefore + 19_800);
    assert.equal(await tokenBalance(market), fundedBalance - 19_800);
    await rm(traderWitnessPath);

    await publish('reentry_oracle', 10_000, checkpoint + 200);
    await admit('liquidation', initialNonce + 1, checkpoint + 200);
    await chain.manager.removeKey(trader.accountId);
    await chain.manager.removeKey(keeperA.accountId);
    assert.equal(await trader.getKey(), null);
    assert.equal(await keeperA.getKey(), null);

    const healthy = await publish('healthy_oracle', 7000, checkpoint + 400);
    actor('prove', keeperInput(1), /healthy|maintenance/i);
    const wrongPrice = actor('prove', {
      ...keeperInput(1), oracleOverride: { ...healthy, price_ticks: 5200 },
    }).liquidation;
    const before = { active: await active(), ledger: await ledger() };
    const refused = await keeperB.callRaw(market, 'liquidate', wrongPrice, { gas: TESTNET_GAS });
    assert.ok(refused.failed);
    await waitFinal(chain, refused);
    assert.match(JSON.stringify(refused.failures), /ERR_PROOF_INVALID/);
    assert.deepEqual({ active: await active(), ledger: await ledger() }, before);
    await track('healthy_refused', Promise.resolve(txEvidence(refused)));

    await publish('distressed_oracle', 5200, checkpoint + 400);
    const liquidated = actor('liquidate', keeperInput(1));
    await track('liquidation', Promise.resolve(liquidated.tx));
    assert.equal(liquidated.tx.signer, keeperB.accountId);
    assert.equal(liquidated.liquidation.refund, 11_700);
    assert.equal(liquidated.liquidation.bad_debt, 0);
    const settled = await ledger();
    assert.equal(await active(), null);
    assert.equal(settled.trader_available, funded.trader_available - 60_000 + 11_700);
    assert.equal(settled.maker_vault, funded.maker_vault - 19_800 + 48_200);
    assert.deepEqual(settled.keeper_available, [funded.keeper_available[0], funded.keeper_available[1] + 100]);
    assert.equal(settled.maker_reserved, 0);
    assert.equal(settled.trader_locked, 0);
    assert.equal(settled.bad_debt, 0);
    assert.equal(settled.next_nonce, initialNonce + 2);
    const replay = await keeperB.callRaw(market, 'liquidate', liquidated.liquidation, { gas: TESTNET_GAS });
    assert.ok(replay.failed);
    await waitFinal(chain, replay);
    assert.match(JSON.stringify(replay.failures), /ERR_NO_ACTIVE/);
    assert.deepEqual(await ledger(), settled);
    await track('replay_refused', Promise.resolve(txEvidence(replay)));
    const keeperBefore = await tokenBalance(keeperB);
    await track('bounty_withdraw', call(keeperB, market, 'withdraw', { amount: '100' }, ONE_YOCTO));
    assert.equal(await tokenBalance(keeperB), keeperBefore + 100);
    assert.equal(await tokenBalance(market), fundedBalance - 19_900);
    evidence.after_close = closed;
    evidence.after_liquidation = settled;
    evidence.final_ledger = await ledger();
    evidence.final_market_balance = await tokenBalance(market);
    evidence.complete = true;
    await save();
    console.log('Verified testnet close, healthy refusal and cold Keeper B liquidation.');
  });
}

const actorInput = {
  testnet: true, rpcAddr: TESTNET_RPC, contractId: market.accountId, trader: trader.accountId, provingDir,
};

async function withKeepers(run) {
  const temp = await mkdtemp(join(tmpdir(), 'xythum-testnet-'));
  try {
    const keeperPaths = keepers.map((_, index) => join(temp, 'keeper-' + index + '.json'));
    for (const [index, role] of keeperRoles.entries()) {
      await writeFile(keeperPaths[index], JSON.stringify({
        encryption: env['NEAR_' + role + '_ENCRYPTION_SECRET'],
        signing: env['NEAR_' + role + '_ACK_SECRET'],
        txKey: roles[role].key.toString(),
      }), { flag: 'wx', mode: 0o600 });
    }
    return await run((index) => ({
      ...actorInput, accountId: keepers[index].accountId, keeperIndex: index, keyPath: keeperPaths[index],
    }));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function resumeActive() {
  await assertConfig(await loadProofKeys(false));
  const active = await view(market, 'get_active');
  assert.ok(active, 'there is no active testnet demo position');
  const identity = JSON.parse(await readFile(join(TESTNET_DIR, positionFile(active.commitment)), 'utf8'));
  assert.equal(identity.market, market.accountId);
  assert.equal(identity.nonce, active.nonce);
  assert.equal(identity.commitment, active.commitment);
  assert.equal(identity.fundingCheckpoint, active.funding_checkpoint);
  assert.ok(['profit', 'liquidation'].includes(identity.fixture));
  const traderWitnessPath = witnessFile(active.commitment);
  const close = identity.fixture === 'profit';
  if (close) assert.ok(existsSync(traderWitnessPath), 'the trader witness for the active position is missing');
  const previous = await view(market, 'get_oracle');
  const evidence = { network: 'testnet', market: market.accountId, nonce: active.nonce };
  const evidenceFile = 'resume-' + active.nonce + '.json';

  evidence.oracle = await call(oracle, market, 'publish_oracle', {
    round: previous.round + 1, price_ticks: close ? 12_000 : 5200,
    funding_cents: active.funding_checkpoint + 200,
  });
  await record(evidenceFile, evidence);
  if (close) {
    const proof = actor('prove-close', { ...actorInput, traderWitnessPath }).close;
    evidence.settlement = await call(trader, market, 'close', proof);
    await rm(traderWitnessPath);
  } else {
    await chain.manager.removeKey(trader.accountId);
    await chain.manager.removeKey(keeperA.accountId);
    evidence.settlement = (await withKeepers((keeperInput) => actor('liquidate', keeperInput(1)))).tx;
  }
  evidence.final_ledger = await view(market, 'get_ledger');
  assert.equal(await view(market, 'get_active'), null);
  await record(evidenceFile, evidence);
  console.log('Settled testnet demo nonce ' + active.nonce + ' in ' + evidence.settlement.hash);
}

if (command === 'deploy') await deployDemo();
else if (command === 'resume-active') await resumeActive();
else await runDemo();
