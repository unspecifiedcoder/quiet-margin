// Settlement and risk arithmetic against the fixtures in prover/src/model.rs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as M from '../model.js';

const fixture = (margin) => ({ size_lots: 10, entry_ticks: 10_000, margin_cents: margin });

test('model.rs settlement fixtures', () => {
  assert.equal(M.equity(fixture(50_000), 7_000, 200), 19_800);
  assert.equal(M.isLiquidatable(fixture(50_000), 7_000, 200), false);
  assert.deepEqual(M.settlement('liquidation', fixture(50_000), 5_200, 200), { refund: 11_700, bad_debt: 0 });
  assert.deepEqual(M.settlement('close', fixture(50_000), 5_200, 200), { refund: 11_800, bad_debt: 0 });
  assert.deepEqual(M.settlement('close', fixture(50_000), 12_000, 200), { refund: 79_800, bad_debt: 0 });
  assert.deepEqual(M.settlement('liquidation', fixture(50_000), 100, 200), { refund: 10_000, bad_debt: 49_200 });
  assert.deepEqual(M.settlement('liquidation', fixture(50_002), 5_283, 200), { refund: 12_530, bad_debt: 0 });
  assert.equal(M.isLiquidatable(fixture(50_002), 5_284, 200), false);
  assert.deepEqual(M.settlement('liquidation', fixture(50_000), 5_023, 200), { refund: 10_000, bad_debt: 0 });
});

test('open bounds, 3x leverage and health at the opening mark', () => {
  M.checkOpenAt(fixture(50_000), 5_264);
  assert.throws(() => M.checkOpenAt(fixture(50_000), 5_263), /maintenance/);
  M.checkOpenAt(fixture(49_992), 5_264);
  assert.throws(() => M.checkOpenAt(fixture(49_992), 5_263), /maintenance/);
  M.checkOpen({ size_lots: 50, entry_ticks: 3, margin_cents: 50 });
  assert.throws(() => M.checkOpen({ size_lots: 50, entry_ticks: 4, margin_cents: 50 }), /3x/);
  assert.throws(() => M.checkOpen({ size_lots: 51, entry_ticks: 1, margin_cents: 1 }), /size_lots/);
  assert.throws(() => M.checkOpen({ size_lots: 1, entry_ticks: 1, margin_cents: 60_001 }), /margin/);
  // 0.05 BTC at $100,000 is $5,000 notional, above 3x of the $600 margin cap;
  // 0.018 BTC ($1,800) is the largest size at that mark.
  assert.throws(() => M.checkOpen({ size_lots: 50, entry_ticks: 10_000, margin_cents: 60_000 }), /3x/);
  M.checkOpen({ size_lots: 18, entry_ticks: 10_000, margin_cents: 60_000 });
});

test('liquidation estimate is the exact maintenance boundary', () => {
  for (const [o, f] of [[fixture(50_000), 200], [fixture(50_002), 200], [{ size_lots: 7, entry_ticks: 9_870, margin_cents: 23_100 }, 13]]) {
    const t = M.liquidationTicks(o, f);
    const below = Math.ceil(t) - 1;
    assert.equal(M.isLiquidatable(o, below, f), true, `liquidatable just below ${t}`);
    assert.equal(M.isLiquidatable(o, Math.ceil(t) === t ? t : Math.ceil(t), f), false);
  }
});

test('exact unit parsing', () => {
  assert.equal(M.btcToLots(0.01), 10);
  assert.equal(M.btcToLots('0.037'), 37);
  assert.throws(() => M.btcToLots('0.0005'));
  assert.throws(() => M.btcToLots(0.051));
  assert.equal(M.usdToCents(0.1 + 0.2), 30);
  assert.equal(M.usdToCents('600'), 60_000);
  assert.equal(M.usdToCents(100), 10_000);
  assert.throws(() => M.usdToCents('1.234'));
  assert.throws(() => M.usdToCents(0));
  assert.equal(M.usdToTicks(100_000), 10_000);
  assert.throws(() => M.usdToTicks(100_005), /tick/);
  assert.throws(() => M.usdToTicks(200_010));
});
