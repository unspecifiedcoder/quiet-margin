#!/usr/bin/env node
// Read-only check of the SHARED demo root funds before enabling the remote
// funded session. The local Windows coordinator and the Fly coordinator spend
// from the same root, maker and token, so verify headroom first. It sends RPC
// view queries only (final finality): no key, no signature, no transaction.
//
//   node exchange/deploy/check-funds.mjs [--sessions 1] [--root <id>] [--token <id>] [--maker <id>]
//
// Mirrors Coordinator#preflight (exchange/server/coordinator.mjs) at the
// default amounts from exchange/server/config.mjs.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RPC = 'https://test.rpc.fastnear.com';
const NEAR = 10n ** 24n;
export const DEFAULTS = Object.freeze({
  root: 'xythum-perps-demo.testnet',
  token: 'musdc.xythum-perps-demo.testnet',
  maker: 'maker.xythum-perps-demo.testnet',
});
const WASM_BYTES = 194_440n; // artifacts.lock.json market-wasm
const GAS_ALLOWANCE = NEAR / 10n;
const REGISTRATION_DEPOSIT = 10n ** 22n;
const TRADER_NEAR = NEAR / 2n;
const MARKET_NEAR = WASM_BYTES * 10n ** 19n + NEAR / 2n;
const ROOT_RESERVE = NEAR;
const TRADER_MUSDC = 60_000n;
const MAKER_VAULT_MUSDC = 60_100n;

export function sessionCost() {
  return { near: GAS_ALLOWANCE + MARKET_NEAR + TRADER_NEAR + 2n * REGISTRATION_DEPOSIT, cents: TRADER_MUSDC + MAKER_VAULT_MUSDC };
}

// Pure: how many fresh sessions the observed balances cover.
export function headroom({ amount, storageUsage, rootCents, makerCents }) {
  const spendable = BigInt(amount) - BigInt(storageUsage) * 10n ** 19n - ROOT_RESERVE;
  const { near } = sessionCost();
  const byNear = spendable <= 0n ? 0n : spendable / near;
  // The first session may use the maker wallet's own mUSDC for the vault.
  let byCents = 0n;
  let cents = BigInt(rootCents);
  let maker = BigInt(makerCents);
  while (byCents < 1000n) {
    const vault = MAKER_VAULT_MUSDC > maker ? MAKER_VAULT_MUSDC - maker : 0n;
    maker = maker > MAKER_VAULT_MUSDC ? maker - MAKER_VAULT_MUSDC : 0n;
    if (cents < TRADER_MUSDC + vault) break;
    cents -= TRADER_MUSDC + vault;
    byCents += 1n;
  }
  return { spendable, byNear, byCents, sessions: byNear < byCents ? byNear : byCents };
}

async function rpc(params) {
  const response = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'check-funds', method: 'query', params: { finality: 'final', ...params } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  if (body.error || body.result?.error) throw new Error('RPC error: ' + JSON.stringify(body.error ?? body.result.error).slice(0, 200));
  return body.result;
}

const view = async (account_id, method_name, args) => JSON.parse(Buffer.from((await rpc({
  request_type: 'call_function', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
})).result).toString('utf8'));

const near = (yocto) => (Number(yocto / 10n ** 20n) / 1e4).toFixed(4) + ' NEAR';

async function main() {
  const { values } = parseArgs({
    options: { sessions: { type: 'string', default: '1' }, root: { type: 'string' }, token: { type: 'string' }, maker: { type: 'string' } },
    strict: true,
  });
  const want = BigInt(values.sessions);
  const ids = { root: values.root ?? DEFAULTS.root, token: values.token ?? DEFAULTS.token, maker: values.maker ?? DEFAULTS.maker };
  const account = await rpc({ request_type: 'view_account', account_id: ids.root });
  const rootCents = await view(ids.token, 'ft_balance_of', { account_id: ids.root });
  const makerCents = await view(ids.token, 'ft_balance_of', { account_id: ids.maker });
  const result = headroom({ amount: account.amount, storageUsage: account.storage_usage, rootCents, makerCents });
  const cost = sessionCost();
  console.log('root ' + ids.root + ': spendable above the 1 NEAR reserve ' + near(result.spendable)
    + '; mUSDC root ' + rootCents + ' cents, maker wallet ' + makerCents + ' cents');
  console.log('per session: ~' + near(cost.near) + ' and up to ' + cost.cents + ' mUSDC cents');
  console.log('covers ' + result.sessions + ' new session(s) (NEAR: ' + result.byNear + ', mUSDC: ' + result.byCents
    + '), shared with the local Windows coordinator');
  if (result.sessions < want) {
    console.log('INSUFFICIENT for ' + want + ' remote session(s): top up before enabling XYTHUM_SESSION_QUOTA');
    process.exitCode = 2;
  } else {
    console.log('OK for ' + want + ' remote session(s)');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('check-funds: ' + String(error?.message ?? error).slice(0, 300));
    process.exit(1);
  });
}
