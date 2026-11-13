const WIDTH = 800;
const HEIGHT = 290;
const PAD = { top: 24, right: 74, bottom: 30, left: 16 };
const formatPrice = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

function svg(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function valid(data) {
  if (data?.symbol !== 'BTC/USDT' || data?.source !== 'Binance Spot'
    || !Number.isFinite(data.price) || data.price <= 0 || !Number.isSafeInteger(data.as_of)
    || !Array.isArray(data.candles) || data.candles.length < 2 || data.candles.length > 80) return false;
  return data.candles.every((c) => c && Number.isSafeInteger(c.time)
    && ['open', 'high', 'low', 'close'].every((key) => Number.isFinite(c[key]) && c[key] > 0)
    && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
}

export function createSpotChart(host, meta, spotPrice) {
  const plot = svg('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img' });
  const status = document.createElement('p');
  status.className = 'xc-small xc-muted xc-spot-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading BTC/USDT candles…';
  host.append(plot, status);
  plot.hidden = true;
  let destroyed = false;
  let data = null;
  let timer;

  function draw() {
    const width = WIDTH - PAD.left - PAD.right;
    const height = HEIGHT - PAD.top - PAD.bottom;
    const hi = Math.max(data.price, ...data.candles.map((c) => c.high));
    const lo = Math.min(data.price, ...data.candles.map((c) => c.low));
    const spread = Math.max(hi - lo, hi * 0.0001);
    const top = hi + spread * 0.13;
    const bottom = lo - spread * 0.13;
    const y = (price) => PAD.top + (top - price) / (top - bottom) * height;
    const step = width / data.candles.length;
    const nodes = [];
    for (let i = 0; i <= 4; i++) {
      const price = top - (top - bottom) * i / 4;
      const yy = y(price);
      nodes.push(
        svg('line', { x1: PAD.left, x2: WIDTH - PAD.right, y1: yy, y2: yy, class: 'xc-spot-grid' }),
        svg('text', { x: WIDTH - PAD.right + 7, y: yy + 4, class: 'xc-spot-axis' }, formatPrice.format(price)),
      );
    }
    data.candles.forEach((candle, index) => {
      const x = PAD.left + (index + 0.5) * step;
      const tone = candle.close >= candle.open ? 'xc-spot-up' : 'xc-spot-down';
      nodes.push(
        svg('line', { x1: x, x2: x, y1: y(candle.high), y2: y(candle.low), class: tone }),
        svg('rect', { x: x - step * 0.31, width: step * 0.62, y: y(Math.max(candle.open, candle.close)),
          height: Math.max(1, Math.abs(y(candle.open) - y(candle.close))), class: tone }),
      );
      if (index % 16 === 0) {
        nodes.push(svg('text', { x, y: HEIGHT - 7, class: 'xc-spot-axis' }, formatTime.format(candle.time)));
      }
    });
    nodes.push(svg('line', { x1: PAD.left, x2: WIDTH - PAD.right, y1: y(data.price), y2: y(data.price), class: 'xc-spot-last' }));
    plot.setAttribute('aria-label', `Binance BTC/USDT candles. Latest price ${formatPrice.format(data.price)} USDT.`);
    plot.replaceChildren(...nodes);
    plot.hidden = false;
  }

  async function poll() {
    try {
      const response = await fetch('/api/market-data', { signal: AbortSignal.timeout(9_000), cache: 'no-store' });
      if (!response.ok) throw new Error();
      const next = await response.json();
      if (!valid(next) || Date.now() - next.as_of > 70_000) throw new Error();
      if (destroyed) return;
      data = next;
      draw();
      spotPrice.textContent = formatPrice.format(data.price);
      meta.textContent = `Binance Spot · 1m · ${formatTime.format(data.as_of)} UTC`;
      status.hidden = true;
    } catch {
      if (destroyed) return;
      status.hidden = false;
      status.textContent = data ? 'Live feed interrupted. Showing the last received candles.' : 'BTC/USDT feed unavailable. Retrying…';
      spotPrice.textContent = '—';
    } finally {
      if (!destroyed) timer = setTimeout(poll, 8_000);
    }
  }
  void poll();
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}
