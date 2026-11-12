// Exact browser mirror of the v2 market model (prover/src/model.rs and the
// encodings in src/lib.rs). Every function here must agree byte for byte with
// the Rust reference; the tests pin the shared fixtures.

import { assertInt, concat, fromBase64, le16, le32, sha256, toBase64, utf8 } from './bytes.js';

export const MIN_LOTS = 1;
export const MAX_LOTS = 50;
export const MAX_TICKS = 20_000;
export const MAX_MARGIN_CENTS = 60_000;
export const MAX_LEVERAGE = 3;
export const ESCROW_CENTS = 60_000;
export const MAKER_RESERVE_CENTS = 60_100;
export const PNL_CAP_CENTS = 60_000;
export const BOUNTY_CENTS = 100;
export const MAX_FUNDING_DELTA_CENTS = 200;
export const MAINTENANCE_DIVISOR = 20;
export const ORACLE_FRESHNESS_BLOCKS = 1_000;
export const KEEPER_COUNT = 2;
export const KEY_VERSION = 1;
export const CIPHERTEXT_LEN = 144;
/** One lot is 0.001 BTC; one tick is 10 USD; lots * ticks are cents. */
export const LOT_BTC = 0.001;
export const TICK_USD = 10;

export const MARKET_PREFIX = utf8('xythum:BTC-USDC:v2:');
export const POSITION_PREFIX = utf8('xythum:position:v2:');
export const QUOTE_PREFIX = utf8('xythum:quote:v2:');
export const ACK_PREFIX = utf8('xythum:keeper-ack:v2:');

/** `SHA256(prefix || deployment_id[32] || contract_account_utf8)`. */
export async function marketId(deploymentId, contractId) {
  if (deploymentId.length !== 32) throw new RangeError('deployment_id must be 32 bytes');
  return sha256(MARKET_PREFIX, deploymentId, utf8(contractId));
}

/** `SHA256(prefix || market || nonce_le32 || checkpoint_le32 || trader_utf8)`. */
export async function positionContext(market, nonce, fundingCheckpoint, traderId) {
  if (market.length !== 32) throw new RangeError('market must be 32 bytes');
  return sha256(POSITION_PREFIX, market, le32(nonce), le32(fundingCheckpoint), utf8(traderId));
}

/** The 72-byte commitment preimage, also the keeper envelope plaintext. */
export function encodeWitness({ context, blinder, size_lots, entry_ticks, margin_cents }) {
  const c = fromBase64(context, 32);
  const b = fromBase64(blinder, 32);
  return concat(c, b, le16(size_lots), le16(entry_ticks), le32(margin_cents));
}

export function decodeWitness(raw) {
  if (raw.length !== 72) throw new RangeError('witness must be 72 bytes');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    context: toBase64(raw.subarray(0, 32)),
    blinder: toBase64(raw.subarray(32, 64)),
    size_lots: view.getUint16(64, true),
    entry_ticks: view.getUint16(66, true),
    margin_cents: view.getUint32(68, true),
  };
}

export async function commitment(witness) {
  return sha256(encodeWitness(witness));
}

/** Salted maker quote digest; margin and the position blinder never enter it. */
export async function quoteTerms({ context, quote_blinder, size_lots, entry_ticks }) {
  return sha256(QUOTE_PREFIX, fromBase64(context, 32), fromBase64(quote_blinder, 32),
    le16(size_lots), le16(entry_ticks));
}

export async function ackMessage(market, nonce, commitmentBytes, ciphertext, keeperIndex) {
  return concat(ACK_PREFIX, market, le32(nonce), commitmentBytes, await sha256(ciphertext),
    new Uint8Array([keeperIndex]), le32(KEY_VERSION));
}

export function checkOpen({ size_lots, entry_ticks, margin_cents }) {
  assertInt(size_lots, MIN_LOTS, MAX_LOTS, 'size_lots');
  assertInt(entry_ticks, 1, MAX_TICKS, 'entry_ticks');
  assertInt(margin_cents, 1, MAX_MARGIN_CENTS, 'margin_cents');
  if (entry_ticks * size_lots > MAX_LEVERAGE * margin_cents) {
    throw new RangeError('position exceeds 3x leverage: entry * lots must be <= 3 * margin');
  }
}

const pnl = (o, price) => (price - o.entry_ticks) * o.size_lots;

export function equity(o, priceTicks, fundingDelta) {
  return o.margin_cents - fundingDelta + pnl(o, priceTicks);
}

export function isHealthyAtOpen(o, openPriceTicks) {
  return MAINTENANCE_DIVISOR * (o.margin_cents + pnl(o, openPriceTicks)) >= openPriceTicks * o.size_lots;
}

export function checkOpenAt(o, openPriceTicks) {
  checkOpen(o);
  assertInt(openPriceTicks, 1, MAX_TICKS, 'open_price_ticks');
  if (!isHealthyAtOpen(o, openPriceTicks)) {
    throw new RangeError('position is below 5% maintenance at the opening mark');
  }
}

export function isLiquidatable(o, priceTicks, fundingDelta) {
  return MAINTENANCE_DIVISOR * equity(o, priceTicks, fundingDelta) < priceTicks * o.size_lots;
}

/** Exact settlement outputs (`settlement_formula_for`); no health check. */
export function settlement(kind, o, priceTicks, fundingDelta) {
  checkOpen(o);
  assertInt(priceTicks, 1, MAX_TICKS, 'price_ticks');
  assertInt(fundingDelta, 0, MAX_FUNDING_DELTA_CENTS, 'funding delta');
  const bounty = kind === 'liquidation' ? BOUNTY_CENTS : 0;
  const eq = equity(o, priceTicks, fundingDelta);
  const capped = o.margin_cents - fundingDelta + Math.min(pnl(o, priceTicks), PNL_CAP_CENTS);
  return {
    refund: ESCROW_CENTS - o.margin_cents + Math.max(capped - bounty, 0),
    bad_debt: Math.max(-eq, 0),
  };
}

/**
 * Highest mark (in ticks, possibly fractional) at or below which the
 * position is liquidatable: `20 * equity < price * lots` solved for price.
 * Liquidatable strictly below the returned value.
 */
export function liquidationTicks(o, fundingDelta = 0) {
  const t = (MAINTENANCE_DIVISOR * (o.entry_ticks * o.size_lots - o.margin_cents + fundingDelta))
    / ((MAINTENANCE_DIVISOR - 1) * o.size_lots);
  return Math.max(t, 0);
}

/** USD amount (number or decimal string) to integer cents, exactly. */
export function usdToCents(value, { max = Number.MAX_SAFE_INTEGER, name = 'amount' } = {}) {
  const text = typeof value === 'number' ? numberText(value) : String(value ?? '').trim();
  const m = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(text);
  if (!m) throw new RangeError(`${name} must be a positive USD amount with at most 2 decimals`);
  const cents = Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
  if (cents <= 0 || cents > max) throw new RangeError(`${name} must be in 0.01..=${max / 100} USD`);
  return cents;
}

/** BTC size (number or decimal string) to integer 0.001 BTC lots, exactly. */
export function btcToLots(value) {
  const text = typeof value === 'number' ? numberText(value) : String(value ?? '').trim();
  const m = /^(\d{1,3})(?:\.(\d{0,3}))?$/.exec(text);
  if (!m) throw new RangeError('size must be a BTC amount in 0.001 steps');
  const lots = Number(m[1]) * 1000 + Number(((m[2] ?? '') + '000').slice(0, 3));
  assertInt(lots, MIN_LOTS, MAX_LOTS, 'size in lots (0.001 BTC)');
  return lots;
}

/** Whole-USD mark price on the 10 USD tick grid to ticks. */
export function usdToTicks(value) {
  const text = typeof value === 'number' ? numberText(value) : String(value ?? '').trim();
  if (!/^\d{1,7}(?:\.0*)?$/.test(text)) throw new RangeError('mark must be a whole USD price');
  const usd = Number(text);
  if (usd % TICK_USD !== 0) throw new RangeError('mark must be a multiple of the 10 USD tick');
  const ticks = usd / TICK_USD;
  assertInt(ticks, 1, MAX_TICKS, 'mark in ticks');
  return ticks;
}

function numberText(value) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('expected a nonnegative number');
  // Round away binary noise (e.g. 0.1 + 0.2) before exact decimal parsing.
  return String(Number(value.toFixed(6)));
}
