import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Worker } from 'near-workspaces';
import { actor, FULL_GAS, makerApproval, prover, txEvidence } from './actor.mjs';
const mockPath = process.env.MOCK_TOKEN_WASM ?? 'target/mock/xythum_near_perps.wasm';
const marketPath = process.env.MARKET_WASM ?? 'target/near/xythum_near_perps.wasm';
const ONE_YOCTO = { attachedDeposit: 1n };
const storageDeposit = 10n ** 22n;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function success(account, target, method, args, opts) {
  const tx = await account.callRaw(target, method, args, { gas: FULL_GAS, ...opts });
  assert.ok(tx.succeeded, JSON.stringify(tx.status));
  assert.deepEqual(tx.receiptFailures, []);
  return txEvidence(tx);
}

function replaceByte(base64) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

test('funded close, cold keeper liquidation, and settlement race', { timeout: 600_000 }, async () => {
  assert.ok(process.env.NEAR_SANDBOX_BINARY_PATH, 'run scripts/sandbox.sh to pin the Sandbox binary');
  const sandboxVersion = execFileSync(join(process.env.NEAR_SANDBOX_BINARY_PATH, 'near-sandbox'),
    ['--version'], { encoding: 'utf8' }).trim();
  assert.match(sandboxVersion, /\b2\.14\.0\b/);
  const temp = await mkdtemp(join(tmpdir(), 'xythum-sandbox-'));
  let worker;
  try {
    const provingDir = join(temp, 'proving');
    const started = performance.now();
    const keys = prover('setup', provingDir);
    const setupMs = Math.round(performance.now() - started);
    for (const kind of ['open', 'liquidation', 'close']) {
      assert.equal(createHash('sha256').update(Buffer.from(keys[kind + '_vk'], 'base64')).digest('base64'), keys[kind + '_vk_sha256']);
    }
    const marketWasm = await readFile(marketPath);
    const mockWasm = await readFile(mockPath);
    const evidence = {
      sandbox_version: sandboxVersion,
      toolchain: {
        rustc: process.env.XYTHUM_RUSTC_VERSION,
        cargo_near: process.env.XYTHUM_CARGO_NEAR_VERSION,
        node: process.version,
        arkworks: '0.5.0',
      },
      market_wasm: { size_bytes: marketWasm.length, sha256: digest(marketWasm) },
      mock_token_wasm: { size_bytes: mockWasm.length, sha256: digest(mockWasm) },
      setup_ms: setupMs,
      keys,
      oracle_rounds: [],
      outcomes: {},
    };

    worker = await Worker.init({ network: 'sandbox', rm: true });
    const root = worker.rootAccount;
    const contract = await root.createSubAccount('market');
    const token = await root.createSubAccount('mock-usdc');
    const trader = await root.createSubAccount('trader');
    const maker = await root.createSubAccount('maker');
    const oracle = await root.createSubAccount('oracle');
    const keeperA = await root.createSubAccount('keeper-a');
    const keeperB = await root.createSubAccount('keeper-b');
    const keepers = [keeperA, keeperB];
    const keeperPaths = keepers.map((_, i) => join(temp, 'keeper-' + i + '.json'));
    const keeperKeys = await Promise.all(keepers.map(async (account, i) =>
      actor('configure', { keyPath: keeperPaths[i], txKey: (await account.getKey()).toString() })));

    const contractDeploy = await contract.deploy(marketWasm);
    const tokenDeploy = await token.deploy(mockWasm);
    assert.ok(contractDeploy.succeeded, JSON.stringify(contractDeploy.status));
    assert.ok(tokenDeploy.succeeded, JSON.stringify(tokenDeploy.status));
    const tokenInit = { owner_id: root.accountId, total_supply: '1000000' };
    const foreignTokenInit = await trader.callRaw(token, 'new', tokenInit, { gas: FULL_GAS });
    assert.ok(foreignTokenInit.failed);
    assert.match(JSON.stringify(foreignTokenInit.failures), /private/i);
    await success(token, token, 'new', tokenInit);
    const deploymentId = randomBytes(32).toString('base64');
    const contractInit = {
      token_id: token.accountId, trader_id: trader.accountId, maker_id: maker.accountId,
      oracle_id: oracle.accountId,
      keepers: keepers.map((account, i) => ({ account_id: account.accountId, ack_key: keeperKeys[i].ack_key })),
      deployment_id: deploymentId, open_vk: keys.open_vk, liquidation_vk: keys.liquidation_vk,
      close_vk: keys.close_vk,
    };
    const foreignInit = await trader.callRaw(contract, 'init', contractInit, { gas: FULL_GAS });
    assert.ok(foreignInit.failed);
    assert.match(JSON.stringify(foreignInit.failures), /private/i);
    const malformedVk = Buffer.alloc(Buffer.from(keys.liquidation_vk, 'base64').length).toString('base64');
    const badInit = await contract.callRaw(contract, 'init', {
      ...contractInit, liquidation_vk: malformedVk,
    }, { gas: FULL_GAS });
    assert.ok(badInit.failed);
    assert.match(JSON.stringify(badInit.failures), /ERR_INVALID_VK/);
    evidence.outcomes.malformed_vk = txEvidence(badInit);
    await success(contract, contract, 'init', contractInit);

    const config = await contract.view('get_config');
    assert.equal(config.open_vk_sha256, keys.open_vk_sha256);
    assert.equal(config.liquidation_vk_sha256, keys.liquidation_vk_sha256);
    assert.equal(config.close_vk_sha256, keys.close_vk_sha256);

    const register = (account) => success(root, token, 'storage_deposit', {
      account_id: account.accountId, registration_only: true,
    }, { attachedDeposit: storageDeposit });
    for (const account of [contract, trader, maker]) await register(account);

    const tokenBalance = async (account) => Number(await token.view('ft_balance_of', {
      account_id: account.accountId,
    }));
    for (const [account, amount, msg] of [[trader, '60000', 'trader'], [maker, '100000', 'maker']]) {
      await success(root, token, 'ft_transfer', { receiver_id: account.accountId, amount }, ONE_YOCTO);
      evidence.outcomes[msg + '_deposit'] = await success(account, token, 'ft_transfer_call', {
        receiver_id: contract.accountId, amount, msg,
      }, ONE_YOCTO);
    }
    const view = (method) => contract.view(method);
    const ledger = () => view('get_ledger');
    const funded = await ledger();
    assert.equal(funded.trader_available, 60_000);
    assert.equal(funded.maker_vault, 100_000);
    assert.equal(await tokenBalance(contract), 160_000);

    const publish = async (round, price_ticks, funding_cents) => {
      evidence.outcomes['oracle_' + round] = await success(oracle, contract, 'publish_oracle',
        { round, price_ticks, funding_cents });
      const published = await view('get_oracle');
      assert.equal(published.round, round);
      evidence.oracle_rounds.push(published);
    };
    await publish(1, 10_000, 0);
    const market = await view('get_market');
    const expectedMarket = createHash('sha256').update('xythum:BTC-USDC:v2:')
      .update(Buffer.from(deploymentId, 'base64')).update(contract.accountId).digest('base64');
    assert.equal(market, expectedMarket);
    const rpcAddr = worker.provider.connection.url;
    const keeper = (i) => ({
      rpcAddr, contractId: contract.accountId, accountId: keepers[i].accountId,
      trader: trader.accountId, keeperIndex: i, keyPath: keeperPaths[i], provingDir,
    });
    const closeProof = (traderWitnessPath) => actor('prove-close', {
      rpcAddr, contractId: contract.accountId, trader: trader.accountId, provingDir, traderWitnessPath,
    });
    const provingArgs = {
      market, trader: trader.accountId,
      recipients: keeperKeys.map((key) => key.encryption_key), provingDir,
    };
    const approve = async (terms) => {
      const block = await worker.provider.block({ finality: 'final' });
      return success(maker, contract, 'approve_quote', { ...terms, expires_at: block.header.height + 500 });
    };
    const admit = async (nonce, fundingCheckpoint, traderWitnessPath) => {
      const prepared = actor('prepare', {
        ...provingArgs, nonce, fundingCheckpoint, openPriceTicks: 10_000, traderWitnessPath,
      });
      const { commitment, quote_terms, ciphertexts, proof } = prepared;
      await success(trader, contract, 'stage_position', { nonce, commitment, quote_terms, ciphertexts });
      const pending = await view('get_pending');
      assert.equal(pending.funding_checkpoint, fundingCheckpoint);
      await approve(makerApproval(pending, prepared.offer, market, trader.accountId));
      const acknowledgments = [0, 1].map((i) => actor('ack', keeper(i)).signature);
      return success(trader, contract, 'open', { nonce, commitment, acknowledgments, proof });
    };

    const firstWitness = join(temp, 'trader-1.witness.json');
    evidence.outcomes.profit_open = await admit(1, 0, firstWitness);
    await publish(2, 12_000, 200);
    const profit = closeProof(firstWitness);
    assert.equal(profit.close.refund, 79_800);
    assert.equal(profit.close.bad_debt, 0);
    const reserved = await ledger();
    const foreignClose = await keeperB.callRaw(contract, 'close', profit.close, { gas: FULL_GAS });
    assert.ok(foreignClose.failed);
    assert.match(JSON.stringify(foreignClose.failures), /ERR_NOT_TRADER/);
    const overdraw = await maker.callRaw(contract, 'withdraw',
      { amount: '39901' }, { gas: FULL_GAS, ...ONE_YOCTO });
    assert.ok(overdraw.failed);
    assert.match(JSON.stringify(overdraw.failures), /balance|reserve/i);
    assert.deepEqual(await ledger(), reserved);
    evidence.outcomes.foreign_close = txEvidence(foreignClose);
    evidence.outcomes.maker_reserved_withdrawal = txEvidence(overdraw);
    evidence.close_proving_ms = profit.proving_ms;
    evidence.outcomes.profit_close = await success(trader, contract, 'close', profit.close);
    evidence.ledger_after_profit = await ledger();
    assert.deepEqual(evidence.ledger_after_profit, {
      ...funded, trader_available: 79_800, maker_vault: 80_200, next_nonce: 2,
    });
    assert.equal(await view('get_active'), null);
    evidence.outcomes.profit_withdraw = await success(trader, contract, 'withdraw',
      { amount: '19800' }, ONE_YOCTO);
    assert.equal(await tokenBalance(trader), 19_800);
    assert.equal(await tokenBalance(contract), 140_200);
    const reopenedFunds = await ledger();
    assert.equal(reopenedFunds.trader_available, 60_000);

    const nonce = 2;
    await publish(3, 10_000, 200);
    const prepared = actor('prepare', {
      ...provingArgs, nonce, fundingCheckpoint: 200, openPriceTicks: 10_000,
    });
    const { commitment, quote_terms, ciphertexts, proof } = prepared;
    evidence.open_proving_ms = prepared.proving_ms;
    const stage = (payloads, terms = quote_terms) => success(trader, contract, 'stage_position',
      { nonce, commitment, quote_terms: terms, ciphertexts: payloads });
    const quote = async () => approve(makerApproval(
      await view('get_pending'), prepared.offer, market, trader.accountId,
    ));
    const snapshot = async () => ({
      ledger: await ledger(), active: await view('get_active'), pending: await view('get_pending'),
    });
    const reject = async (name, caller, method, args, message) => {
      const before = await snapshot();
      const tx = await caller.callRaw(contract, method, args, { gas: FULL_GAS });
      assert.ok(tx.failed, name + ' unexpectedly succeeded');
      assert.match(JSON.stringify(tx.failures), message);
      assert.deepEqual(await snapshot(), before);
      evidence.outcomes[name] = txEvidence(tx);
    };

    actor('ack', keeper(1), /missing keeper payload/);
    await reject('missing_payload', trader, 'stage_position',
      { nonce, commitment, quote_terms, ciphertexts: [ciphertexts[0], ''] }, /ciphertext/i);
    await stage([ciphertexts[0], replaceByte(ciphertexts[1])]);
    actor('ack', keeper(1), /undecryptable keeper payload/);
    await stage([ciphertexts[0], prepared.mismatched]);
    actor('ack', keeper(1), /commitment mismatch/);
    await stage(ciphertexts);
    const acknowledgments = [0, 1].map((i) => actor('ack', keeper(i)).signature);
    const openArgs = { nonce, commitment, acknowledgments, proof };
    const tamperedTerms = replaceByte(quote_terms);
    await stage(ciphertexts, tamperedTerms);
    const tamperedPending = await view('get_pending');
    assert.throws(() => makerApproval(tamperedPending, prepared.offer, market, trader.accountId), /quote terms changed/);
    // A maker signature over another digest cannot substitute the open proof's terms.
    await approve({ nonce, commitment, quote_terms: tamperedTerms });
    await reject('tampered_quote_terms', trader, 'open', openArgs, /proof/i);
    await stage([ciphertexts[0], prepared.mismatched]);
    await quote();
    await reject('wrong_acknowledgment', trader, 'open', openArgs, /ack|signature/i);
    await stage(ciphertexts);
    await quote();
    await reject('mutated_open_proof', trader, 'open',
      { ...openArgs, proof: replaceByte(proof) }, /proof|BLS12/i);
    evidence.outcomes.open = await success(trader, contract, 'open', openArgs);
    const opened = await snapshot();
    assert.deepEqual(opened.active, {
      nonce, commitment, quote_terms, ciphertexts, funding_checkpoint: 200, open_price_ticks: 10_000,
    });
    assert.equal(opened.pending, null);
    assert.deepEqual(opened.ledger, {
      ...reopenedFunds, trader_available: 0, trader_locked: 60_000, maker_reserved: 60_100, next_nonce: 3,
    });

    // The trader preparation process has exited. Remove both the trader and Keeper A
    // transaction signers from the harness before changing the oracle. Keeper A's
    // acknowledgment process stays stopped during this liquidation.
    const traderKey = await trader.getKey();
    await worker.manager.removeKey(trader.accountId);
    await worker.manager.removeKey(keeperA.accountId);
    assert.equal(await trader.getKey(), null);
    assert.equal(await keeperA.getKey(), null);

    await publish(4, 7000, 400);
    actor('prove', keeper(1), /healthy|maintenance/i);
    const healthyAttempt = actor('prove', {
      ...keeper(1), oracleOverride: { round: 4, price_ticks: 5200, funding_cents: 400 },
    }).liquidation;
    // Correct slot, round, signer and payout bounds. The live healthy price is
    // supplied by the contract to the verifier and invalidates this proof.
    await reject('healthy_liquidation', keeperB, 'liquidate', healthyAttempt, /proof/i);

    await publish(5, 5200, 400);
    await reject('stale_round', keeperB, 'liquidate', healthyAttempt, /round|stale/i);
    const distressed = actor('prove', keeper(1)).liquidation;
    await reject('wrong_root', keeperB, 'liquidate',
      { ...distressed, root: replaceByte(distressed.root) }, /root|commitment|active_mismatch/i);
    const wrongDomain = actor('prove', {
      ...keeper(1), otherMarket: randomBytes(32).toString('base64'),
    }).liquidation;
    assert.equal(wrongDomain.root, distressed.root);
    await reject('wrong_domain', keeperB, 'liquidate', wrongDomain, /proof/i);
    await reject('tampered_refund', keeperB, 'liquidate',
      { ...distressed, refund: distressed.refund + 1 }, /proof/i);
    const mutated = Buffer.from(distressed.proof, 'base64');
    Buffer.from(proof, 'base64').copy(mutated, 288, 288, 384);
    await reject('mutated_liquidation_proof', keeperB, 'liquidate',
      { ...distressed, proof: mutated.toString('base64') }, /proof/i);

    await publish(6, 5200, 400);
    await reject('changed_round_same_values', keeperB, 'liquidate',
      { ...distressed, round: 6 }, /proof/i);

    // Submit from a separate process with only Keeper B's persisted keys,
    // public parameters, and the on-chain ciphertext. No witness is passed.
    const liquidated = actor('liquidate', keeper(1));
    evidence.liquidation_proving_ms = liquidated.proving_ms;
    evidence.outcomes.liquidation = liquidated.tx;
    evidence.accepted_liquidation = liquidated.liquidation;
    assert.equal(liquidated.tx.signer, keeperB.accountId);
    assert.equal(liquidated.liquidation.refund, 11_700);
    assert.equal(liquidated.liquidation.bad_debt, 0);
    const settled = await snapshot();
    assert.equal(settled.active, null);
    assert.equal(settled.pending, null);
    assert.deepEqual(settled.ledger, {
      trader_available: 11_700, trader_locked: 0, maker_vault: 128_400,
      maker_reserved: 0, keeper_available: [0, 100], pending_withdrawals: 0,
      bad_debt: 0, halted: false, next_nonce: 3,
    });
    await reject('replay', keeperB, 'liquidate', liquidated.liquidation, /position|active|spent/i);

    // An unregistered FT recipient triggers a failed token receipt. The private
    // callback restores the bounty, then a retry after registration pays once.
    await reject('foreign_callback', keeperB, 'resolve_withdraw',
      { account_id: keeperB.accountId }, /private/i);
    const failedTransfer = await keeperB.callRaw(contract, 'withdraw', { amount: '100' },
      { gas: FULL_GAS, ...ONE_YOCTO });
    assert.ok(failedTransfer.receiptFailures.length > 0);
    assert.deepEqual(await snapshot(), settled);
    assert.equal(await tokenBalance(contract), 140_200);
    evidence.outcomes.failed_withdrawal = txEvidence(failedTransfer);
    await register(keeperB);
    evidence.outcomes.withdrawal = await success(keeperB, contract, 'withdraw',
      { amount: '100' }, ONE_YOCTO);
    assert.equal(await tokenBalance(keeperB), 100);
    assert.equal(await tokenBalance(contract), 140_100);
    evidence.ledger_before_liquidation = opened.ledger;
    evidence.ledger_after_liquidation = settled.ledger;
    evidence.ledger_after_withdrawal = await ledger();
    assert.deepEqual(evidence.ledger_after_withdrawal, { ...settled.ledger, keeper_available: [0, 0] });
    evidence.open = openArgs;
    evidence.market = { id: market, account: contract.accountId, deployment_id: deploymentId };
    evidence.public_ciphertexts = ciphertexts;


    // The offline scenario is complete. Bring the trader back for a race in
    // which both settlement proofs are valid against the same state.
    await trader.setKey(traderKey);
    await success(root, token, 'ft_transfer', { receiver_id: trader.accountId, amount: '48300' }, ONE_YOCTO);
    await success(trader, token, 'ft_transfer_call', {
      receiver_id: contract.accountId, amount: '48300', msg: 'trader',
    }, ONE_YOCTO);
    await publish(7, 10_000, 400);
    const raceWitness = join(temp, 'trader-3.witness.json');
    evidence.outcomes.race_open = await admit(3, 400, raceWitness);
    await publish(8, 5200, 600);
    const racingClose = closeProof(raceWitness).close;
    const racingLiquidation = actor('prove', keeper(1)).liquidation;
    assert.equal(racingClose.refund, 11_800);
    assert.equal(racingLiquidation.refund, 11_700);
    await reject('liquidation_proof_cannot_close', trader, 'close', racingLiquidation, /proof/i);
    const [closeTx, liquidationTx] = await Promise.all([
      trader.callRaw(contract, 'close', racingClose, { gas: FULL_GAS }),
      keeperB.callRaw(contract, 'liquidate', racingLiquidation, { gas: FULL_GAS }),
    ]);
    assert.notEqual(closeTx.succeeded, liquidationTx.succeeded);
    const loser = closeTx.succeeded ? liquidationTx : closeTx;
    assert.ok(loser.failed);
    assert.match(JSON.stringify(loser.failures), /ERR_NO_ACTIVE/);
    assert.equal(await view('get_active'), null);
    const raceLedger = await ledger();
    assert.deepEqual(raceLedger, {
      trader_available: closeTx.succeeded ? 11_800 : 11_700,
      trader_locked: 0, maker_vault: 176_600, maker_reserved: 0,
      keeper_available: [0, closeTx.succeeded ? 0 : 100], pending_withdrawals: 0,
      bad_debt: 0, halted: false, next_nonce: 4,
    });
    assert.equal(await tokenBalance(contract), 188_400);
    evidence.race = { close: txEvidence(closeTx), liquidation: txEvidence(liquidationTx), ledger: raceLedger };

    // A fresh market instance exercises exact maintenance equality and the
    // gap waterfall independently of the funded failover fixture above.
    const gapTrader = await root.createSubAccount('gap-trader');
    const gapMarket = await root.createSubAccount('gap-market');
    const gapDeployment = randomBytes(32).toString('base64');
    const gapDeploy = await gapMarket.deploy(marketWasm);
    assert.ok(gapDeploy.succeeded, JSON.stringify(gapDeploy.status));
    await success(gapMarket, gapMarket, 'init', {
      ...contractInit, trader_id: gapTrader.accountId, deployment_id: gapDeployment,
    });
    for (const account of [gapMarket, gapTrader]) await register(account);
    for (const [account, amount, msg] of [[gapTrader, '60000', 'trader'], [maker, '100000', 'maker']]) {
      await success(root, token, 'ft_transfer', { receiver_id: account.accountId, amount }, ONE_YOCTO);
      await success(account, token, 'ft_transfer_call', {
        receiver_id: gapMarket.accountId, amount, msg,
      }, ONE_YOCTO);
    }
    const publishGap = async (round, price_ticks) => {
      await success(oracle, gapMarket, 'publish_oracle', { round, price_ticks, funding_cents: 0 });
      return gapMarket.view('get_oracle');
    };
    const gapEntry = await publishGap(1, 57);
    const gapId = await gapMarket.view('get_market');
    const gapOpening = actor('prepare', {
      ...provingArgs, market: gapId, trader: gapTrader.accountId, nonce: 1,
      fundingCheckpoint: 0, openPriceTicks: 57,
      fixture: { size_lots: 1, entry_ticks: 57, margin_cents: 19 },
    });
    const gapCommit = { nonce: 1, commitment: gapOpening.commitment };
    const gapTerms = { ...gapCommit, quote_terms: gapOpening.quote_terms };
    const gapKeeper = (i) => ({
      ...keeper(i), contractId: gapMarket.accountId, trader: gapTrader.accountId,
    });

    const unhealthyMark = await publishGap(2, 1);
    await success(gapTrader, gapMarket, 'stage_position',
      { ...gapTerms, ciphertexts: gapOpening.ciphertexts });
    const unhealthyBlock = await worker.provider.block({ finality: 'final' });
    await success(maker, gapMarket, 'approve_quote', {
      ...gapTerms, expires_at: unhealthyBlock.header.height + 500,
    });
    const unhealthyAcks = [0, 1].map((i) => actor('ack', gapKeeper(i)).signature);
    const unhealthyOpen = await gapTrader.callRaw(gapMarket, 'open', {
      ...gapCommit, proof: gapOpening.proof, acknowledgments: unhealthyAcks,
    }, { gas: FULL_GAS });
    assert.ok(unhealthyOpen.failed);
    assert.match(JSON.stringify(unhealthyOpen.failures), /proof/i);
    assert.equal(await gapMarket.view('get_active'), null);
    assert.equal((await gapMarket.view('get_ledger')).trader_available, 60_000);

    const reopenedGapOracle = await publishGap(3, 57);
    await success(gapTrader, gapMarket, 'stage_position',
      { ...gapTerms, ciphertexts: gapOpening.ciphertexts });
    const gapBlock = await worker.provider.block({ finality: 'final' });
    await success(maker, gapMarket, 'approve_quote',
      {
        ...makerApproval(await gapMarket.view('get_pending'), gapOpening.offer, gapId, gapTrader.accountId),
        expires_at: gapBlock.header.height + 500,
      });
    const gapOpenTx = await success(gapTrader, gapMarket, 'open', {
      ...gapCommit, proof: gapOpening.proof,
      acknowledgments: [0, 1].map((i) => actor('ack', gapKeeper(i)).signature),
    });
    const equalOracle = await publishGap(4, 40);
    actor('prove', gapKeeper(1), /healthy|maintenance/i);
    const equalAttempt = actor('prove', {
      ...gapKeeper(1), oracleOverride: { ...equalOracle, price_ticks: 1 },
    }).liquidation;
    const beforeEquality = await gapMarket.view('get_ledger');
    const equality = await keeperB.callRaw(gapMarket, 'liquidate', equalAttempt, { gas: FULL_GAS });
    assert.ok(equality.failed);
    assert.match(JSON.stringify(equality.failures), /proof/i);
    assert.deepEqual(await gapMarket.view('get_ledger'), beforeEquality);
    assert.equal((await gapMarket.view('get_active')).commitment, gapOpening.commitment);

    const gapOracle = await publishGap(5, 1);
    const gapLiquidation = actor('liquidate', gapKeeper(1));
    const gapLedger = await gapMarket.view('get_ledger');
    assert.deepEqual(gapLedger, {
      trader_available: 59_981, trader_locked: 0, maker_vault: 99_919,
      maker_reserved: 0, keeper_available: [0, 100], pending_withdrawals: 0,
      bad_debt: 37, halted: true, next_nonce: 2,
    });
    assert.equal(await tokenBalance(gapMarket), 160_000);
    assert.equal(await gapMarket.view('get_active'), null);
    const halted = await gapTrader.callRaw(gapMarket, 'stage_position', {
      ...gapTerms, nonce: 2, ciphertexts: gapOpening.ciphertexts,
    }, { gas: FULL_GAS });
    assert.ok(halted.failed);
    assert.match(JSON.stringify(halted.failures), /halted/i);
    assert.deepEqual(await gapMarket.view('get_ledger'), gapLedger);
    evidence.risk_edges = {
      market: { id: gapId, account: gapMarket.accountId, deployment_id: gapDeployment },
      oracle_rounds: [gapEntry, unhealthyMark, reopenedGapOracle, equalOracle, gapOracle],
      unhealthy_open: txEvidence(unhealthyOpen),
      open: gapOpenTx,
      equality: txEvidence(equality),
      gap: gapLiquidation,
      ledger: gapLedger,
      halted: txEvidence(halted),
    };


    const output = JSON.stringify(evidence, null, 2);
    if (process.env.EVIDENCE_FILE) await writeFile(process.env.EVIDENCE_FILE, output + '\n');
    console.log(JSON.stringify({
      open_proving_ms: evidence.open_proving_ms,
      liquidation_proving_ms: evidence.liquidation_proving_ms,
      open: evidence.outcomes.open,
      profit_close: evidence.outcomes.profit_close,
      race: evidence.race,
      healthy_liquidation: evidence.outcomes.healthy_liquidation,
      liquidation: evidence.outcomes.liquidation,
      withdrawal: evidence.outcomes.withdrawal,
      settled: settled.ledger,
    }));
  } finally {
    try {
      await worker?.tearDown();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});
