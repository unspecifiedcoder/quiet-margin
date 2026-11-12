// Mark history chart: a step line of authenticated oracle rounds only.
// Replaces the EVM baseline's TradingView embed (frontend/src/components/TradingChart.tsx
// at e5cbe25) because that widget streamed exchange prices unrelated to this market.
// Nothing is drawn unless the client supplies real mark rounds.
//
// Drawn on a <canvas> so no markup is generated per update. Colors and fonts are
// read from CSS custom properties on the chart wrapper (see exchange.css), which
// keeps the palette, forced-colors overrides and the static stylesheet in one place.

import { TICK_USD } from './format.js';

const PAD = { top: 16, right: 72, bottom: 26, left: 12 };
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function readTheme(el) {
  const cs = getComputedStyle(el);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    grid: v('--chart-grid', '#1d2738'),
    text: v('--chart-text', '#94a3b8'),
    strong: v('--chart-strong', '#f1f5f9'),
    line: v('--chart-line', '#00ffff'),
    tagFill: v('--chart-tag-fill', 'rgba(0,255,255,0.14)'),
    tagStroke: v('--chart-tag-stroke', 'rgba(0,255,255,0.5)'),
    entry: v('--chart-entry', '#94a3b8'),
    liq: v('--chart-liq', '#ef5a76'),
    cross: v('--chart-cross', '#2c3a52'),
    halo: v('--chart-halo', '#0f1420'),
    font: v('--chart-font', 'monospace'),
  };
}

export function createMarkChart(host) {
  const wrap = document.createElement('div');
  wrap.className = 'xc-chart';
  const empty = document.createElement('p');
  empty.className = 'xc-chart__empty';
  const tip = document.createElement('div');
  tip.className = 'xc-chart__tip';
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  // Announces the inspected round to assistive tech while the visual tip follows the cursor.
  const live = document.createElement('p');
  live.className = 'xc-sr';
  live.setAttribute('aria-live', 'polite');
  const plot = document.createElement('canvas');
  plot.className = 'xc-chart__canvas';
  plot.setAttribute('role', 'img');
  plot.tabIndex = 0;
  plot.textContent = 'BTC mark history chart.';
  wrap.append(plot, tip, empty, live);
  host.append(wrap);

  let data = { history: [], entryTicks: null, liqTicks: null };
  let cursor = null;
  let geom = null;

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
  ro?.observe(wrap);
  const fc = typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : null;
  const onScheme = () => draw();
  fc?.addEventListener?.('change', onScheme);

  function layout() {
    const pts = data.history;
    const W = Math.max(280, wrap.clientWidth || 600);
    const H = Math.max(180, wrap.clientHeight || 300);
    const prices = pts.map((p) => p.price_ticks * TICK_USD);
    const refs = [data.entryTicks, data.liqTicks].filter((t) => t > 0).map((t) => t * TICK_USD);
    let lo = Math.min(...prices, ...refs);
    let hi = Math.max(...prices, ...refs);
    if (hi - lo < 50) { lo -= 50; hi += 50; }
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x0 = PAD.left, x1 = W - PAD.right, y0 = PAD.top, y1 = H - PAD.bottom;
    const n = pts.length;
    const xAt = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
    const yAt = (usd) => y1 - ((usd - lo) / (hi - lo)) * (y1 - y0);
    return { W, H, lo, hi, step, x0, x1, y0, y1, n, xAt, yAt, prices };
  }

  function draw() {
    const pts = data.history;
    const has = pts.length > 0;
    plot.hidden = !has;
    empty.hidden = has;
    if (!has) {
      empty.textContent = 'No oracle rounds yet. The chart only plots marks published to the market contract.';
      tip.hidden = true;
      live.textContent = '';
      geom = null;
      return;
    }
    geom = layout();
    const { W, H, lo, hi, step, x0, x1, y0, y1, n, xAt, yAt, prices } = geom;
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (plot.width !== bw) plot.width = bw;
    if (plot.height !== bh) plot.height = bh;
    const ctx = plot.getContext('2d');
    if (!ctx) return;
    const t = readTheme(wrap);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `11px ${t.font}`;
    ctx.textBaseline = 'alphabetic';
    const crisp = (v) => Math.round(v) + 0.5;

    // Grid and price axis.
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = t.grid;
    ctx.fillStyle = t.text;
    ctx.textAlign = 'left';
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const y = crisp(yAt(v));
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(INT.format(v), x1 + 8, y + 4);
    }
    ctx.fillText(`R${pts[0].round}`, x0, H - 8);
    if (n > 1) { ctx.textAlign = 'right'; ctx.fillText(`R${pts[n - 1].round}`, x1, H - 8); }

    // Entry and liquidation reference lines.
    const refLine = (ticks, color, name) => {
      if (!(ticks > 0)) return;
      const y = crisp(yAt(ticks * TICK_USD));
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.setLineDash([]);
      const label = `${name} ${INT.format(ticks * TICK_USD)}`;
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = t.halo;
      ctx.strokeText(label, x0 + 4, y - 5);
      ctx.fillStyle = t.strong;
      ctx.fillText(label, x0 + 4, y - 5);
    };
    refLine(data.entryTicks, t.entry, 'Entry');
    refLine(data.liqTicks, t.liq, 'Liq.');

    // Step-after path: an oracle mark holds until the next round replaces it.
    ctx.strokeStyle = t.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (n === 1) {
      ctx.moveTo(x0, yAt(prices[0])); ctx.lineTo(x1, yAt(prices[0]));
    } else {
      ctx.moveTo(xAt(0), yAt(prices[0]));
      for (let i = 1; i < n; i++) { ctx.lineTo(xAt(i), yAt(prices[i - 1])); ctx.lineTo(xAt(i), yAt(prices[i])); }
    }
    ctx.stroke();

    const dot = (x, y, r) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = t.line; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = t.halo; ctx.stroke();
    };
    const last = n - 1;
    const ly = yAt(prices[last]);
    dot(xAt(last), ly, 4);

    // Last-price tag on the axis.
    ctx.fillStyle = t.tagFill;
    ctx.strokeStyle = t.tagStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x1 + 2.5, ly - 9.5, PAD.right - 6, 20, 3);
    else ctx.rect(x1 + 2.5, ly - 9.5, PAD.right - 6, 20);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = t.strong;
    ctx.textAlign = 'left';
    ctx.fillText(INT.format(prices[last]), x1 + 8, ly + 4);

    // Crosshair for the inspected round.
    if (cursor != null && cursor < n) {
      const x = crisp(xAt(cursor));
      ctx.strokeStyle = t.cross;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      dot(xAt(cursor), yAt(prices[cursor]), 5);
    }

    plot.setAttribute(
      'aria-label',
      `BTC mark over ${n} oracle round${n === 1 ? '' : 's'}, from ${INT.format(prices[0])} USD at round ${pts[0].round} ` +
        `to ${INT.format(prices[last])} USD at round ${pts[last].round}. Use left and right arrow keys, Home and End to inspect rounds.`,
    );
    paintTip();
  }

  function paintTip() {
    if (!geom || cursor == null || cursor >= data.history.length) { tip.hidden = true; return; }
    const p = data.history[cursor];
    const x = geom.xAt(cursor);
    const y = geom.yAt(p.price_ticks * TICK_USD);
    tip.hidden = false;
    tip.textContent = `Round ${p.round} · ${INT.format(p.price_ticks * TICK_USD)} USD`;
    const left = Math.min(Math.max(x - 70, 4), geom.W - 150);
    // CSSOM property writes are permitted under a style-src 'self' CSP.
    tip.style.transform = `translate(${left}px, ${Math.max(y - 44, 2)}px)`;
  }

  function nearest(clientX) {
    const r = plot.getBoundingClientRect();
    const x = ((clientX - r.left) / (r.width || 1)) * geom.W;
    if (geom.n === 1) return 0;
    const i = Math.round(((x - geom.x0) / (geom.x1 - geom.x0)) * (geom.n - 1));
    return Math.min(geom.n - 1, Math.max(0, i));
  }

  const onMove = (e) => {
    if (!geom) return;
    const next = nearest(e.clientX);
    if (next !== cursor) { cursor = next; draw(); }
  };
  const onLeave = () => { if (cursor != null) { cursor = null; draw(); } };
  const onBlur = () => { live.textContent = ''; onLeave(); };
  const onKey = (e) => {
    if (!geom) return;
    const n = data.history.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      cursor = cursor == null ? n - 1 : Math.min(n - 1, Math.max(0, cursor + d));
    } else if (e.key === 'Home') { e.preventDefault(); cursor = 0; }
    else if (e.key === 'End') { e.preventDefault(); cursor = n - 1; }
    else if (e.key === 'Escape') { cursor = null; live.textContent = ''; draw(); return; }
    else return;
    draw();
    live.textContent = tip.textContent;
  };
  plot.addEventListener('pointermove', onMove);
  plot.addEventListener('pointerleave', onLeave);
  plot.addEventListener('blur', onBlur);
  plot.addEventListener('keydown', onKey);

  return {
    update(next) {
      data = {
        history: next.history ?? [],
        entryTicks: next.entryTicks ?? null,
        liqTicks: next.liqTicks ?? null,
      };
      if (cursor != null && cursor >= data.history.length) cursor = null;
      draw();
    },
    destroy() {
      ro?.disconnect();
      fc?.removeEventListener?.('change', onScheme);
      plot.removeEventListener('pointermove', onMove);
      plot.removeEventListener('pointerleave', onLeave);
      plot.removeEventListener('blur', onBlur);
      plot.removeEventListener('keydown', onKey);
      wrap.remove();
    },
  };
}
