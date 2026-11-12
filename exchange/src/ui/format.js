// Pure market arithmetic, parsing, and formatting for the exchange UI.
//
// Units follow docs/SPEC.md and docs/FUNDED-MARKET.md: one lot is 0.001 BTC,
// one price tick is 10 USD, lots * ticks = cents of mock collateral (mUSDC).
// Balances arrive in cents. Inputs are parsed from strings with integer
// arithmetic so 0.001 BTC steps and 2-decimal collateral never drift.

export const LOT_BTC = 0.001;
export const MIN_LOTS = 1;
export const MAX_LOTS = 50;
export const TICK_USD = 10;
export const MAX_TICKS = 20000;
export const MAX_LEVERAGE = 3;
export const ESCROW_CENTS = 60000;
export const MAX_MARGIN_CENTS = 60000;
export const MAKER_RESERVE_CENTS = 60100;
export const KEEPER_BOUNTY_CENTS = 100;
export const COLLATERAL = 'mUSDC';

const NUM = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Parse a non-negative decimal string into an integer scaled by 10^places. */
export function parseScaled(raw, places) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: false, empty: true, reason: 'Required' };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, reason: 'Enter a number' };
  const frac = m[2] ?? '';
  if (frac.length > places) {
    return { ok: false, reason: places === 3 ? 'Use 0.001 BTC steps' : `At most ${places} decimals` };
  }
  const whole = m[1] === '' ? '0' : m[1];
  if (whole.length > 9) return { ok: false, reason: 'Too large' };
  const value = Number(whole) * 10 ** places + Number((frac + '0'.repeat(places)).slice(0, places) || '0');
  return { ok: true, value };
}

export function parseLots(raw) {
  const r = parseScaled(raw, 3);
  if (!r.ok) return r;
  if (r.value < MIN_LOTS) return { ok: false, reason: 'Minimum 0.001 BTC' };
  if (r.value > MAX_LOTS) return { ok: false, reason: 'Maximum 0.050 BTC (50 lots)' };
  return { ok: true, value: r.value };
}

export function parseCents(raw, { max = Infinity, maxReason } = {}) {
  const r = parseScaled(raw, 2);
  if (!r.ok) return r;
  if (r.value <= 0) return { ok: false, reason: 'Must be above zero' };
  if (r.value > max) return { ok: false, reason: maxReason ?? `At most ${formatCents(max)}` };
  return { ok: true, value: r.value };
}

/** Test mark input: whole USD, multiple of the 10 USD tick, within oracle bounds. */
export function parseMarkUsd(raw) {
  const r = parseScaled(raw, 0);
  if (!r.ok) return r.empty ? r : { ok: false, reason: 'Whole USD only' };
  if (r.value % TICK_USD !== 0) return { ok: false, reason: 'Use 10 USD ticks' };
  const ticks = r.value / TICK_USD;
  if (ticks < 1 || ticks > MAX_TICKS) return { ok: false, reason: '10 to 200,000 USD' };
  return { ok: true, value: ticks };
}

export const lotsToBtcString = (lots) => (lots / 1000).toFixed(3);
export const centsToString = (cents) => (cents / 100).toFixed(2);

export function formatCents(cents) {
  return isNum(cents) ? NUM.format(cents / 100) : '—';
}
export function formatAmount(units) {
  return isNum(units) ? NUM.format(units) : '—';
}
export function formatSigned(units) {
  if (!isNum(units)) return '—';
  const sign = units > 0 ? '+' : units < 0 ? '−' : '';
  return sign + NUM.format(Math.abs(units));
}
export function formatPriceUsd(usd) {
  return isNum(usd) ? INT.format(Math.round(usd)) : '—';
}
export function formatTicks(ticks) {
  return isNum(ticks) ? INT.format(ticks * TICK_USD) : '—';
}
export function formatBtc(btc) {
  return isNum(btc) ? btc.toFixed(3) : '—';
}
export function formatLeverage(x) {
  return isNum(x) && x > 0 ? `${x.toFixed(2)}x` : '—';
}

export function shortHash(value, head = 6, tail = 4) {
  const s = String(value ?? '');
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function safeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Liquidation threshold for a long, in ticks. The contract liquidates when
 * 20 * (margin - funding + (price - entry) * lots) < price * lots, so the
 * position is liquidatable strictly below (20 * (entry * lots - margin + funding)) / (19 * lots).
 */
export function liquidationTicks({ lots, entryTicks, marginCents, fundingCents = 0 }) {
  if (!(lots > 0) || !(entryTicks > 0)) return null;
  const t = (20 * (entryTicks * lots - marginCents + fundingCents)) / (19 * lots);
  return t > 0 ? t : 0;
}

/** Quote preview for the trade form. All outputs are integers in cents or ticks. */
export function buildQuote({ lots, marginCents, markTicks }) {
  if (!(lots > 0) || !(marginCents > 0) || !(markTicks > 0)) return null;
  const notionalCents = markTicks * lots;
  const leverage = notionalCents / marginCents;
  const minMarginCents = Math.ceil(notionalCents / MAX_LEVERAGE);
  return {
    lots,
    marginCents,
    markTicks,
    notionalCents,
    leverage,
    minMarginCents,
    withinLeverage: notionalCents <= MAX_LEVERAGE * marginCents,
    liqTicks: liquidationTicks({ lots, entryTicks: markTicks, marginCents }),
    unassignedEscrowCents: ESCROW_CENTS - marginCents,
    maxLotsForMargin: Math.min(MAX_LOTS, Math.floor((MAX_LEVERAGE * marginCents) / markTicks)),
  };
}

/** Normalize a possibly partial state object from the client. */
export function normalizeState(s = {}) {
  const b = s.balances ?? {};
  return {
    network: s.network === 'testnet' ? 'testnet' : s.network === 'sandbox' ? 'sandbox' : null,
    busy: s.busy || null,
    error: s.error || null,
    notice: typeof s.notice === 'string' && s.notice ? s.notice : null,
    session: s.session ?? null,
    oracle: s.oracle && isNum(s.oracle.price_ticks) ? s.oracle : null,
    balances: {
      wallet: isNum(b.wallet) ? b.wallet : null,
      available: isNum(b.available) ? b.available : null,
      locked: isNum(b.locked) ? b.locked : null,
      maker: isNum(b.maker) ? b.maker : null,
    },
    position: s.position ?? null,
    active: s.active ?? null,
    keeperArmed: Boolean(s.keeperArmed),
    markHistory: Array.isArray(s.markHistory)
      ? s.markHistory.filter((p) => p && isNum(p.price_ticks) && isNum(p.round))
      : [],
    receipts: Array.isArray(s.receipts) ? s.receipts.filter(Boolean) : [],
    proofStatus: s.proofStatus || null,
  };
}
