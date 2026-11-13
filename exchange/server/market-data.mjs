import { HttpError } from './util.mjs';

const BASE = 'https://data-api.binance.vision/api/v3/';
const FRESH_MS = 60_000;
const POLL_MS = 8_000;
const CANDLE_MS = 60_000;

const unavailable = () => new HttpError(503, 'market_data_unavailable', 'live BTC/USDT data is unavailable');
const positive = (value) => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw unavailable();
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) throw unavailable();
  return price;
};

export function createMarketData({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  let inFlight;

  async function get(path) {
    const response = await fetchImpl(BASE + path, { signal: AbortSignal.timeout(7_000), redirect: 'error' });
    if (!response.ok) throw unavailable();
    const body = await response.text();
    if (body.length > 64_000) throw unavailable();
    return JSON.parse(body);
  }

  async function read() {
    const [rows, trades] = await Promise.all([
      get('klines?symbol=BTCUSDT&interval=1m&limit=80'),
      get('trades?symbol=BTCUSDT&limit=1'),
    ]);
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 80 || !Array.isArray(trades)
      || trades.length !== 1 || !Number.isSafeInteger(trades[0]?.time)) throw unavailable();
    let previous = 0;
    const candles = rows.map((row) => {
      if (!Array.isArray(row)) throw unavailable();
      const [time, ...raw] = row;
      if (!Number.isSafeInteger(time) || time % CANDLE_MS !== 0 || time <= previous) throw unavailable();
      previous = time;
      const [open, high, low, close] = raw.slice(0, 4).map(positive);
      if (!(high >= Math.max(open, close) && low <= Math.min(open, close))) throw unavailable();
      return { time, open, high, low, close };
    });
    const { time: as_of, price } = trades[0];
    if (as_of > now() + 5_000 || now() - as_of > FRESH_MS || Math.abs(previous - as_of) > 2 * CANDLE_MS) {
      throw unavailable();
    }
    cached = { at: now(), data: { symbol: 'BTC/USDT', source: 'Binance Spot', as_of, price: positive(price), candles } };
    return cached.data;
  }

  return {
    get() {
      if (cached && now() - cached.at < POLL_MS && now() - cached.data.as_of < FRESH_MS) {
        return Promise.resolve(cached.data);
      }
      inFlight ??= read().catch(() => { throw unavailable(); }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
