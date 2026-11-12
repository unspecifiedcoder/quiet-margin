// Bounded configuration for the testnet session coordinator. Every value that
// spends testnet NEAR or mock collateral has an explicit default and a hard cap.
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NEAR = 10n ** 24n;
export const ESCROW_CENTS = 60_000;
export const RESERVE_CENTS = 60_100;
export const MAX_PRICE_TICKS = 20_000;
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const TESTNET_DIR = join(REPO_ROOT, '.testnet');

// Public verifying-key fingerprints of the recorded testnet deployment
// (docs/TESTNET-ADDRESSES.md). New session markets must reuse these keys.
export const PINNED_VK_FINGERPRINTS = Object.freeze({
  open: '3sesQDTxpTB6+wdunP8crHc4Hnxv9V4TQqFQiBKIsDA=',
  liquidation: 'hvfOfFq80ldBwlvMRH7dEgQfqvUeULcKpYIjnabxyOg=',
  close: '66lAStu/S3ID1d4pkYQEJHubw9EGWDNIO+giKUDfcIs=',
});

export class ConfigError extends Error {}

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(name + ' must be a non-negative integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(name + ' must be between ' + min + ' and ' + max);
  }
  return value;
}

// Parses a decimal NEAR amount such as "0.5" into yoctoNEAR.
export function parseNear(text, name) {
  if (!/^\d+(?:\.\d{1,24})?$/.test(text)) throw new ConfigError(name + ' must be a decimal NEAR amount');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * NEAR + BigInt(fraction.padEnd(24, '0'));
}

function nearAmount(env, name, fallback, max) {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : parseNear(raw, name);
  if (value <= 0n || value > max) throw new ConfigError(name + ' is outside its bounded range');
  return value;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env = process.env) {
  const host = env.XYTHUM_SERVER_HOST || '127.0.0.1';
  const hosted = !LOOPBACK.has(host);
  if (hosted && env.XYTHUM_ALLOW_HOSTED !== '1') {
    throw new ConfigError('binding ' + host + ' requires XYTHUM_ALLOW_HOSTED=1');
  }
  if (hosted && isIP(host) === 0) throw new ConfigError('XYTHUM_SERVER_HOST must be an IP address');

  const quotaRaw = env.XYTHUM_SESSION_QUOTA;
  // Without an explicit quota the server runs read-only for sessions.
  const sessionQuota = quotaRaw === undefined || quotaRaw === ''
    ? 0 : integer(env, 'XYTHUM_SESSION_QUOTA', 0, 1, 50);

  let fingerprints = PINNED_VK_FINGERPRINTS;
  if (env.XYTHUM_VK_FINGERPRINTS) {
    let parsed;
    try {
      parsed = JSON.parse(env.XYTHUM_VK_FINGERPRINTS);
    } catch {
      throw new ConfigError('XYTHUM_VK_FINGERPRINTS must be JSON');
    }
    for (const kind of ['open', 'liquidation', 'close']) {
      if (typeof parsed?.[kind] !== 'string' || Buffer.from(parsed[kind], 'base64').length !== 32) {
        throw new ConfigError('XYTHUM_VK_FINGERPRINTS.' + kind + ' must be a Base64 SHA-256');
      }
    }
    fingerprints = Object.freeze({ open: parsed.open, liquidation: parsed.liquidation, close: parsed.close });
  }

  const markMin = integer(env, 'XYTHUM_MARK_MIN_TICKS', 1, 1, MAX_PRICE_TICKS);
  const markMax = integer(env, 'XYTHUM_MARK_MAX_TICKS', MAX_PRICE_TICKS, markMin, MAX_PRICE_TICKS);
  const wasmPin = env.XYTHUM_MARKET_WASM_SHA256 || null;
  if (wasmPin !== null && !/^[0-9a-f]{64}$/.test(wasmPin)) {
    throw new ConfigError('XYTHUM_MARKET_WASM_SHA256 must be lowercase hex');
  }

  return Object.freeze({
    host,
    hosted,
    port: integer(env, 'XYTHUM_SERVER_PORT', 8790, 1, 65_535),
    serveDist: env.XYTHUM_SERVE_DIST !== '0',
    distDir: env.XYTHUM_DIST_DIR || fileURLToPath(new URL('../dist/', import.meta.url)),
    sessionDir: env.XYTHUM_SESSION_DIR || join(TESTNET_DIR, 'exchange-sessions'),
    provingDir: env.XYTHUM_PROVING_DIR || join(TESTNET_DIR, 'proving'),
    marketWasm: env.MARKET_WASM || join(REPO_ROOT, 'target', 'near', 'xythum_near_perps.wasm'),
    marketWasmSha256: wasmPin,
    fingerprints,
    sessionQuota,
    setupQueue: integer(env, 'XYTHUM_SETUP_QUEUE', 4, 1, 16),
    traderNear: nearAmount(env, 'XYTHUM_TRADER_NEAR', NEAR / 2n, 2n * NEAR),
    marketNear: env.XYTHUM_MARKET_NEAR ? nearAmount(env, 'XYTHUM_MARKET_NEAR', 0n, 6n * NEAR) : null,
    rootReserve: nearAmount(env, 'XYTHUM_ROOT_RESERVE_NEAR', NEAR, 100n * NEAR),
    traderMusdc: integer(env, 'XYTHUM_TRADER_MUSDC', ESCROW_CENTS, ESCROW_CENTS, 2 * ESCROW_CENTS),
    makerVaultMusdc: integer(env, 'XYTHUM_MAKER_VAULT_MUSDC', RESERVE_CENTS, RESERVE_CENTS, 4 * RESERVE_CENTS),
    initialPriceTicks: integer(env, 'XYTHUM_INITIAL_PRICE_TICKS', 10_000, markMin, markMax),
    markMin,
    markMax,
    markIntervalMs: integer(env, 'XYTHUM_MARK_INTERVAL_MS', 2_000, 0, 600_000),
    marksPerSession: integer(env, 'XYTHUM_MARKS_PER_SESSION', 100, 1, 1_000),
    approvalsPerSession: integer(env, 'XYTHUM_APPROVALS_PER_SESSION', 20, 1, 200),
    createCooldownMs: integer(env, 'XYTHUM_CREATE_COOLDOWN_MS', hosted ? 60_000 : 0, 0, 86_400_000),
    keeperPollMs: integer(env, 'XYTHUM_KEEPER_POLL_MS', 5_000, 500, 600_000),
    quoteTtlBlocks: integer(env, 'XYTHUM_QUOTE_TTL_BLOCKS', 500, 10, 900),
  });
}
