// Read-only check of the public testnet receipts in demo/receipts.json.
// Uses only Node 22 built-ins and public JSON-RPC views. It needs no keys
// and never signs or submits a transaction.
//
//   node scripts/verify-demo-receipts.mjs [--strict]
//
// A historical view is SKIPped only when both endpoints report that the old
// block is unavailable. Any other error is a FAIL. Exit code 0 means nothing
// failed; with --strict (required for submission) skips also fail.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { retryRateLimit, TESTNET_ARCHIVAL_FALLBACK } from './retry-rate-limit.mjs';

const manifest = JSON.parse(readFileSync(new URL('../demo/receipts.json', import.meta.url), 'utf8'));
const { network, accounts, market } = manifest;
const results = [];

function report(status, scope, message) {
  results.push(status);
  console.log(`${status.padEnd(4)} ${scope.padEnd(22)} ${message}`);
}

function check(scope, ok, message) {
  report(ok ? 'PASS' : 'FAIL', scope, message);
}

async function rpcOnce(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'verify', method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`${url} returned HTTP ${response.status}`), { status: response.status });
  }
  const body = await response.json();
  if (body.error) {
    const code = body.error.cause?.name ?? body.error.name;
    throw Object.assign(new Error(code ?? JSON.stringify(body.error)), { code, data: body.error });
  }
  return body.result;
}

// NEAR RPC error causes that mean the node no longer serves the requested block.
const UNAVAILABLE = new Set(['UNKNOWN_BLOCK', 'GARBAGE_COLLECTED_BLOCK', 'UNAVAILABLE_SHARD']);

// Most reads are historical, so use the archival RPC before the regular RPC.
async function rpc(method, params) {
  try {
    return await retryRateLimit(
      () => rpcOnce(network.archival_rpc, method, params),
      () => rpcOnce(TESTNET_ARCHIVAL_FALLBACK, method, params),
    );
  } catch (first) {
    try {
      return await retryRateLimit(() => rpcOnce(network.rpc, method, params));
    } catch (second) {
      throw Object.assign(new Error(`archival: ${first.message}; regular: ${second.message}`),
        { unavailable: UNAVAILABLE.has(first.code) && UNAVAILABLE.has(second.code) });
    }
  }
}

// Skip only when the historical block is unavailable; anything else fails.
function historicalError(scope, what, error) {
  if (error.unavailable) report('SKIP', scope, `historical ${what} block unavailable: ${error.message}`);
  else check(scope, false, `historical ${what} view failed: ${error.message}`);
}

async function view(accountId, method, args, block) {
  const result = await rpc('query', {
    request_type: 'call_function', account_id: accountId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args ?? {})).toString('base64'),
    ...(block ? { block_id: block } : { finality: 'final' }),
  });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let value = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

// Every key in `expected` must match `actual`; arrays must match exactly.
function matches(actual, expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => matches(actual[key], value));
}

const pretty = (value) => JSON.stringify(value);
const short = (hash) => hash.slice(0, 8) + '…';

function events(outcomes) {
  return outcomes.flatMap(({ outcome }) => outcome.logs
    .filter((log) => log.startsWith('EVENT_JSON:'))
    .map((log) => ({ executor: outcome.executor_id, ...JSON.parse(log.slice('EVENT_JSON:'.length)) })));
}

async function verifyTransaction(entry) {
  const { id, hash, signer, receiver, expect } = entry;
  let tx;
  try {
    tx = await rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
  } catch (error) {
    check(id, false, `${hash} could not be fetched: ${error.message}`);
    return;
  }
  check(id, tx.transaction.hash === hash, `returned transaction hash ${short(tx.transaction.hash)}`);
  check(id, tx.final_execution_status === 'FINAL',
    `${short(hash)} final_execution_status ${tx.final_execution_status}`);
  check(id, tx.transaction.signer_id === signer && tx.transaction.receiver_id === receiver,
    `signer ${tx.transaction.signer_id} -> receiver ${tx.transaction.receiver_id}`);

  const failures = tx.receipts_outcome.filter(({ outcome }) => 'Failure' in outcome.status);
  if (expect.status === 'success') {
    check(id, !('Failure' in tx.status) && failures.length === 0,
      `succeeded with ${tx.receipts_outcome.length} receipts and no failed receipt`);
  } else {
    const panic = 'Smart contract panicked: ' + expect.error;
    const reason = tx.status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    check(id, reason === panic && failures.length === 1 && failures[0].outcome.executor_id === receiver,
      `failed in ${failures[0]?.outcome.executor_id ?? 'no receipt'} with ${reason ?? pretty(tx.status)}`);
  }

  const actions = tx.transaction.actions;
  if (expect.actions) {
    const kinds = actions.map((action) => (typeof action === 'string' ? action : Object.keys(action)[0]));
    check(id, isDeepStrictEqual(kinds, expect.actions), `actions ${kinds.join(', ')}`);
  }
  if (expect.deploy_code_sha256) {
    const code = Buffer.from(actions.find((action) => action.DeployContract)?.DeployContract.code ?? '', 'base64');
    // Current RPC returns the 32-byte code hash. Older nodes returned the code itself.
    const digest = (code.length === 32 ? code : createHash('sha256').update(code).digest()).toString('hex');
    check(id, digest === expect.deploy_code_sha256, `deployed Wasm SHA-256 ${digest}`);
  }
  if (expect.method) {
    const call = actions.find((action) => action.FunctionCall)?.FunctionCall;
    let args = null;
    try {
      args = JSON.parse(Buffer.from(call?.args ?? '', 'base64').toString('utf8'));
    } catch {
      // Leave args null so the mismatch is reported below.
    }
    const shown = Object.fromEntries(Object.keys(expect.args ?? {}).map((key) => [key, args?.[key]]));
    check(id, call?.method_name === expect.method && matches(args, expect.args ?? {}),
      `${call?.method_name}(${pretty(shown)})`);
  }
  if (expect.events) {
    const found = events(tx.receipts_outcome);
    const missing = expect.events.filter((wanted) => !found.some((event) =>
      event.executor === wanted.executor && event.standard === wanted.standard
      && event.event === wanted.event && matches(event.data?.[0], wanted.data)));
    check(id, missing.length === 0 && found.length === expect.events.length,
      found.length === 0 ? 'no event logs' : found.map((event) =>
        `${event.event}${pretty(event.data?.[0])}`).join('; '));
  }

  // Contract state is read at the block where the market executed the call,
  // which shows the oracle round the contract itself used for verification.
  const mainReceipt = tx.receipts_outcome.find(({ id: receiptId }) =>
    receiptId === tx.transaction_outcome.outcome.status.SuccessReceiptId);
  if (expect.oracle) {
    try {
      const oracle = await view(accounts.market, 'get_oracle', {}, mainReceipt.block_hash);
      const labeled = { round: oracle?.round, price_ticks: oracle?.price_ticks, funding_cents: oracle?.funding_cents };
      check(id, isDeepStrictEqual(labeled, expect.oracle),
        `oracle round ${labeled.round} at $${(labeled.price_ticks * manifest.units.tick_usd).toLocaleString('en-US')}`
        + `, funding index ${labeled.funding_cents} cents (historical get_oracle at receipt block)`);
    } catch (error) {
      historicalError(id, 'oracle', error);
    }
  }
  if (expect.ledger_after) {
    // Read the snapshot at the market receipt that emitted the expected
    // withdrawal_resolved event, rather than relying on receipt order.
    const wanted = expect.events?.find((event) => event.event === 'withdrawal_resolved');
    const resolved = wanted ? tx.receipts_outcome.filter((receipt) =>
      receipt.outcome.executor_id === accounts.market && events([receipt]).some((event) =>
        event.standard === wanted.standard && event.event === wanted.event
        && matches(event.data?.[0], wanted.data))) : [];
    if (resolved.length !== 1) {
      check(id, false, `expected one market receipt emitting withdrawal_resolved, found ${resolved.length}`);
      return;
    }
    const [resolvedReceipt] = resolved;
    try {
      const ledger = await view(accounts.market, 'get_ledger', {}, resolvedReceipt.block_hash);
      check(id, isDeepStrictEqual(ledger, expect.ledger_after), `ledger after final withdrawal ${pretty(ledger)}`);
      const balance = await view(market.token.account, 'ft_balance_of', { account_id: accounts.market }, resolvedReceipt.block_hash);
      check(id, balance === expect.market_token_balance_after, `market holds ${balance} mUSDC cents`);
    } catch (error) {
      historicalError(id, 'ledger', error);
    }
  }
}

async function verifyMarketAccount() {
  const scope = 'market_account';
  try {
    for (const [accountId, expected] of [[market.account, market.code_sha256], [market.token.account, market.token.code_sha256]]) {
      const account = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
      check(scope, account.code_hash === base58(Buffer.from(expected, 'hex')),
        `${accountId} code_hash ${account.code_hash}`);
    }
    const config = await view(market.account, 'get_config');
    check(scope, config.token_id === market.token.account && config.trader_id === accounts.trader
      && config.maker_id === accounts.maker && config.oracle_id === accounts.oracle,
    `roles token ${config.token_id}, trader ${config.trader_id}, maker ${config.maker_id}, oracle ${config.oracle_id}`);
    const keepers = config.keepers.map(({ account_id: accountId }) => accountId);
    check(scope, isDeepStrictEqual(keepers, [accounts.keeper_a, accounts.keeper_b]), `keepers ${keepers.join(', ')}`);
    check(scope, config.deployment_id === market.deployment_id_b64, `deployment ID ${config.deployment_id}`);
    for (const kind of ['open', 'close', 'liquidation']) {
      const fingerprint = config[kind + '_vk_sha256'];
      check(scope, fingerprint === market.vk_sha256_b64[kind], `${kind} verifying-key SHA-256 ${fingerprint}`);
    }
    const domain = await view(market.account, 'get_market');
    check(scope, domain === market.domain_b64, `market domain ${domain}`);
    const metadata = await view(market.token.account, 'ft_metadata');
    check(scope, metadata.symbol === market.token.symbol && metadata.decimals === market.token.decimals,
      `token ${metadata.symbol}, ${metadata.decimals} decimals`);
  } catch (error) {
    check(scope, false, `account views failed: ${error.message}`);
  }
}

console.log(`Read-only ${network.chain_id} check of ${manifest.transactions.length} transactions via ${network.rpc}`);
const node = await rpc('status', []);
check('network', node.chain_id === network.chain_id, `chain_id ${node.chain_id}`);
await verifyMarketAccount();
for (const entry of manifest.transactions) await verifyTransaction(entry);

const count = (kind) => results.filter((result) => result === kind).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
if (count('SKIP') > 0) {
  console.log('Incomplete: historical blocks were unavailable. Submission requires 0 skipped (--strict).');
}
const strict = process.argv.includes('--strict');
process.exitCode = count('FAIL') === 0 && !(strict && count('SKIP') > 0) ? 0 : 1;
