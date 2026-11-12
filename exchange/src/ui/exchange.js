// Xythum NEAR Perps — customer exchange UI.
//
// Layout and visual language are adapted from the original Xythum EVM DEX
// (Xythum-Labs/darkpool-gateway @ e5cbe25965ec546ac6e691704d9c176137cf561c):
//   frontend/src/pages/Index.tsx            7/3 chart + trade terminal grid
//   frontend/src/components/Header.tsx      brand lockup and network state
//   frontend/src/components/TradingPanel.tsx account card, margin input, quote summary
//   frontend/src/components/TabsSection.tsx positions / history tabs
//   frontend/src/components/PositionRow.tsx position fields and close action
//   frontend/src/components/ProofGenerationLoader.tsx proof progress messaging
//   frontend/src/index.css                  HSL palette (navy, cyan, magenta)
// React, wagmi, TradingView and wallet code were not carried over. This module
// is plain DOM; it renders client state and forwards intents to handlers.

import {
  COLLATERAL, ESCROW_CENTS, MAKER_RESERVE_CENTS, MAX_LEVERAGE, MAX_LOTS, MAX_MARGIN_CENTS, MIN_LOTS, TICK_USD,
  buildQuote, centsToString, formatAmount, formatBtc, formatCents, formatLeverage, formatPriceUsd, formatSigned,
  formatTicks, lotsToBtcString, normalizeState, parseCents, parseLots, parseMarkUsd, safeHttpUrl,
  shortHash,
} from './format.js';
import { createMarkChart } from './chart.js';

let uid = 0;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const unit = (text = COLLATERAL) => h('span', { class: 'xc-unit', text });

function stat(label, valueEl) {
  return h('div', { class: 'xc-stat' }, h('span', { class: 'xc-stat__label', text: label }), valueEl);
}

function row(label, value, { tone, id } = {}) {
  return h('div', { class: 'xc-row' },
    h('dt', { text: label }),
    h('dd', { class: tone ? `is-${tone}` : null, id }, value));
}

export function mountExchange(root, handlers = {}) {
  if (!root) throw new Error('mountExchange: root element required');
  const id = `xc${++uid}`;
  const has = (name) => typeof handlers[name] === 'function';
  let state = normalizeState({});
  let pending = null;
  let localError = null;
  let touched = { size: false, margin: false, deposit: false, withdraw: false, mark: false };
  let dialogSpec = null;
  const timers = new Set();

  root.classList.add('xc');
  root.replaceChildren();

  // ---------- header ----------
  const r = {};
  r.networkBadge = h('span', { class: 'xc-badge' });
  r.session = h('div', { class: 'xc-session' });
  r.mark = h('strong', { class: 'xc-ticker__mark' });
  r.round = h('span');
  r.funding = h('span');
  const header = h('header', { class: 'xc-top' },
    h('div', { class: 'xc-brand' },
      h('span', { class: 'xc-brand__mark', 'aria-hidden': 'true', text: 'X' }),
      h('span', { class: 'xc-brand__name' }, h('span', { class: 'is-primary', text: 'Xythum ' }), h('span', { class: 'is-accent', text: 'Perps' }))),
    h('div', { class: 'xc-ticker', role: 'group', 'aria-label': 'Market' },
      h('div', { class: 'xc-ticker__pair' },
        h('strong', { text: 'BTC-PERP' }),
        h('span', { class: 'xc-muted', text: `Isolated long · ${COLLATERAL} margin` })),
      stat('Mark (USD)', r.mark),
      stat('Oracle round', r.round),
      stat(`Funding index (${COLLATERAL})`, r.funding)),
    h('div', { class: 'xc-top__right' }, r.networkBadge, r.session));

  // ---------- status ----------
  r.statusText = h('span', { class: 'xc-status__text' });
  r.proof = h('span', { class: 'xc-status__proof' });
  r.status = h('div', { class: 'xc-status', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'xc-spinner', 'aria-hidden': 'true' }), r.statusText, r.proof);
  r.alertText = h('span');
  r.alert = h('div', { class: 'xc-alert', role: 'alert', hidden: true },
    r.alertText,
    h('button', { type: 'button', class: 'xc-link', text: 'Dismiss', onclick: () => { localError = null; render(); } }));

  // ---------- collapsible panel ----------
  function panel(key, title, body, { extra, cls = '' } = {}) {
    const bodyId = `${id}-${key}`;
    const btn = h('button', { type: 'button', class: 'xc-panel__toggle', 'aria-expanded': 'true', 'aria-controls': bodyId },
      h('span', { text: title }), h('span', { class: 'xc-chev', 'aria-hidden': 'true' }));
    const wrapper = h('div', { class: 'xc-panel__body', id: bodyId }, body);
    const sec = h('section', { class: `xc-panel ${cls}`, 'aria-labelledby': `${bodyId}-h` },
      h('h2', { class: 'xc-panel__head', id: `${bodyId}-h` }, btn, extra ?? null), wrapper);
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      sec.classList.toggle('is-collapsed', !open);
    });
    return sec;
  }

  // ---------- chart ----------
  r.chartLast = h('span', { class: 'xc-panel__meta' });
  const chartHost = h('div', { class: 'xc-chart-host' });
  const chartPanel = panel('chart', 'BTC mark · oracle rounds', chartHost, { extra: r.chartLast, cls: 'xc-area-chart' });
  const chart = createMarkChart(chartHost);

  // ---------- trade form ----------
  function field({ key, label, value, unitText, hint }) {
    const inputId = `${id}-${key}`;
    const input = h('input', {
      id: inputId, class: 'xc-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
      value, 'aria-describedby': `${inputId}-hint ${inputId}-err`,
    });
    const err = h('p', { class: 'xc-field__err', id: `${inputId}-err`, 'aria-live': 'polite' });
    const hintEl = h('p', { class: 'xc-field__hint', id: `${inputId}-hint`, text: hint ?? '' });
    const box = h('div', { class: 'xc-input-wrap' }, input, unitText ? unit(unitText) : null);
    const wrap = h('div', { class: 'xc-field' }, h('label', { for: inputId, text: label }), box, hintEl, err);
    return { input, err, hint: hintEl, box, wrap };
  }

  r.size = field({ key: 'size', label: 'Size', value: '0.010', unitText: 'BTC' });
  const stepBtn = (delta, text, label) => h('button', {
    type: 'button', class: 'xc-step', 'aria-label': label, text,
    onclick: () => stepSize(delta),
  });
  r.sizeDown = stepBtn(-1, '−', 'Decrease size by 0.001 BTC');
  r.sizeUp = stepBtn(1, '+', 'Increase size by 0.001 BTC');
  r.size.box.prepend(r.sizeDown);
  r.size.box.append(r.sizeUp);
  r.margin = field({ key: 'margin', label: 'Margin', value: '300.00', unitText: COLLATERAL, hint: `Up to ${formatCents(MAX_MARGIN_CENTS)} ${COLLATERAL} · max ${MAX_LEVERAGE}x` });
  r.levBtns = [1, 2, 3].map((k) => h('button', {
    type: 'button', class: 'xc-chip', text: `${k}x`, 'aria-label': `Set margin for ${k}x leverage`,
    onclick: () => setLeverage(k),
  }));
  r.levValue = h('strong');
  r.levFill = h('span', { class: 'xc-meter__fill' });
  r.levMeter = h('div', { class: 'xc-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(MAX_LEVERAGE), 'aria-label': 'Leverage' }, r.levFill);
  r.quote = h('dl', { class: 'xc-rows xc-quote', 'aria-label': 'Quote preview' });
  r.blocker = h('p', { class: 'xc-blocker', id: `${id}-blocker`, 'aria-live': 'polite' });
  r.review = h('button', { type: 'submit', class: 'xc-btn xc-btn--long xc-btn--block', 'aria-describedby': `${id}-blocker`, text: 'Review long' });
  r.form = h('form', { class: 'xc-form', novalidate: true },
    h('div', { class: 'xc-side-pill' },
      h('span', { class: 'xc-side-pill__long', text: 'Long' }),
      h('span', { class: 'xc-muted', text: `Isolated · ≤ ${MAX_LEVERAGE}x · single slot` })),
    r.size.wrap,
    r.margin.wrap,
    h('div', { class: 'xc-lev' },
      h('div', { class: 'xc-lev__head' }, h('span', { text: 'Leverage' }), r.levValue),
      r.levMeter,
      h('div', { class: 'xc-chips', role: 'group', 'aria-label': 'Leverage presets' }, r.levBtns)),
    r.quote,
    h('aside', { class: 'xc-privacy' },
      h('strong', { text: 'Private opening' }),
      h('p', { text: `Your margin and random blinder are generated in this browser, which never sends them to the coordinator in plaintext. The chain sees a salted commitment and the fixed ${formatCents(ESCROW_CENTS)} ${COLLATERAL} escrow. The maker sees size and entry. The opening is encrypted to both designated keepers, and either keeper can decrypt the full opening, including margin and blinder, so it can liquidate if needed.` })),
    r.review,
    r.blocker);
  r.form.addEventListener('submit', (e) => { e.preventDefault(); touched.size = touched.margin = true; reviewOpen(); });
  r.size.input.addEventListener('input', () => { touched.size = true; renderForm(); });
  r.margin.input.addEventListener('input', () => { touched.margin = true; renderForm(); });
  r.size.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepSize(e.key === 'ArrowUp' ? 1 : -1); }
  });
  const tradePanel = panel('trade', 'Trade', r.form, { cls: 'xc-area-trade' });

  // ---------- account ----------
  r.bal = { wallet: h('span'), available: h('span'), locked: h('span'), maker: h('span') };
  const balRow = (label, el, note) => h('div', { class: 'xc-row' },
    h('dt', {}, label, note ? h('span', { class: 'xc-muted xc-row__note', text: note }) : null),
    h('dd', {}, el, ' ', unit()));
  r.balances = h('dl', { class: 'xc-rows' },
    balRow('Wallet', r.bal.wallet, 'token balance'),
    balRow('Available', r.bal.available, 'in market'),
    balRow('Locked', r.bal.locked, 'escrow'),
    balRow('Maker vault', r.bal.maker, 'counterparty'));
  r.accountNote = h('p', { class: 'xc-muted xc-small' });
  function amountForm(key, label, verb) {
    const f = field({ key, label, value: '', unitText: COLLATERAL });
    f.input.placeholder = '0.00';
    const max = h('button', { type: 'button', class: 'xc-chip', text: 'Max', 'aria-label': `Use maximum ${label.toLowerCase()} amount` });
    const go = h('button', { type: 'submit', class: 'xc-btn xc-btn--ghost', text: verb });
    f.box.append(max);
    const form = h('form', { class: 'xc-amount', novalidate: true }, f.wrap, go);
    return { ...f, max, go, form };
  }
  r.deposit = amountForm('deposit', 'Deposit', 'Deposit');
  r.withdraw = amountForm('withdraw', 'Withdraw', 'Withdraw');
  r.deposit.max.addEventListener('click', () => { if (state.balances.wallet != null) { r.deposit.input.value = centsToString(state.balances.wallet); touched.deposit = true; renderAccount(); } });
  r.withdraw.max.addEventListener('click', () => { if (state.balances.available != null) { r.withdraw.input.value = centsToString(state.balances.available); touched.withdraw = true; renderAccount(); } });
  r.deposit.input.addEventListener('input', () => { touched.deposit = true; renderAccount(); });
  r.withdraw.input.addEventListener('input', () => { touched.withdraw = true; renderAccount(); });
  r.deposit.form.addEventListener('submit', (e) => { e.preventDefault(); touched.deposit = true; reviewTransfer('deposit'); });
  r.withdraw.form.addEventListener('submit', (e) => { e.preventDefault(); touched.withdraw = true; reviewTransfer('withdraw'); });
  const accountPanel = panel('account', 'Account', [
    r.balances, r.accountNote, h('div', { class: 'xc-amounts' }, r.deposit.form, r.withdraw.form),
  ], { cls: 'xc-area-account' });

  // ---------- test controls ----------
  r.markField = field({ key: 'mark', label: 'Test mark', value: '', unitText: 'USD', hint: 'Publishes a new oracle round in 10 USD ticks.' });
  r.markField.input.inputMode = 'numeric';
  r.markLiq = h('button', { type: 'button', class: 'xc-chip', text: 'Below liq.', 'aria-label': 'Fill the first tick below the liquidation price' });
  r.markField.box.append(r.markLiq);
  r.markEffect = h('p', { class: 'xc-small', 'aria-live': 'polite' });
  r.markGo = h('button', { type: 'submit', class: 'xc-btn xc-btn--ghost', text: 'Publish mark' });
  r.markForm = h('form', { class: 'xc-amount', novalidate: true }, r.markField.wrap, r.markGo);
  r.markField.input.addEventListener('input', () => { touched.mark = true; renderTest(); });
  r.markLiq.addEventListener('click', () => {
    const liq = currentLiqTicks();
    if (liq > 1) { r.markField.input.value = String((Math.ceil(liq) - 1) * TICK_USD); touched.mark = true; renderTest(); r.markField.input.focus(); }
  });
  r.markForm.addEventListener('submit', (e) => {
    e.preventDefault();
    touched.mark = true;
    const m = parseMarkUsd(r.markField.input.value);
    renderTest();
    if (!m.ok || controlsLocked() || !has('onSetMark')) return;
    run('onSetMark', String(m.value * TICK_USD));
  });
  r.keeperState = h('span', { class: 'xc-pill' });
  r.keeperNote = h('p', { class: 'xc-muted xc-small' });
  r.arm = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Arm keeper', onclick: () => run('onArmKeeper') });
  const testPanel = panel('test', 'Test controls', [
    h('p', { class: 'xc-muted xc-small', text: 'Protocol tools for this test market. They are separate from trading and act on the shared oracle and keeper.' }),
    r.markForm, r.markEffect,
    h('div', { class: 'xc-keeper' },
      h('div', { class: 'xc-lev__head' }, h('span', { text: 'Liquidation keeper' }), r.keeperState),
      r.keeperNote, r.arm),
  ], { cls: 'xc-area-test xc-panel--test' });

  // ---------- tabs: position / receipts / mark rounds ----------
  const tabDefs = [['position', 'Position'], ['receipts', 'Receipts'], ['rounds', 'Mark rounds']];
  r.tabs = {};
  r.tabPanels = {};
  const tablist = h('div', { class: 'xc-tabs', role: 'tablist', 'aria-label': 'Position and activity' });
  for (const [key, label] of tabDefs) {
    const tab = h('button', {
      type: 'button', role: 'tab', class: 'xc-tab', id: `${id}-tab-${key}`, 'aria-controls': `${id}-tp-${key}`,
      'aria-selected': key === 'position' ? 'true' : 'false', tabindex: key === 'position' ? '0' : '-1',
    }, h('span', { text: label }), h('span', { class: 'xc-count' }));
    tab.addEventListener('click', () => selectTab(key));
    r.tabs[key] = tab;
    tablist.append(tab);
    r.tabPanels[key] = h('div', { class: 'xc-tabpanel', role: 'tabpanel', id: `${id}-tp-${key}`, 'aria-labelledby': tab.id, tabindex: '0', hidden: key !== 'position' });
  }
  tablist.addEventListener('keydown', (e) => {
    const keys = tabDefs.map(([k]) => k);
    const cur = keys.findIndex((k) => r.tabs[k].getAttribute('aria-selected') === 'true');
    let next = null;
    if (e.key === 'ArrowRight') next = (cur + 1) % keys.length;
    else if (e.key === 'ArrowLeft') next = (cur - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = keys.length - 1;
    if (next == null) return;
    e.preventDefault();
    selectTab(keys[next]);
    r.tabs[keys[next]].focus();
  });
  function selectTab(key) {
    for (const [k] of tabDefs) {
      const on = k === key;
      r.tabs[k].setAttribute('aria-selected', String(on));
      r.tabs[k].tabIndex = on ? 0 : -1;
      r.tabPanels[k].hidden = !on;
    }
  }
  const bookPanel = h('section', { class: 'xc-panel xc-area-book', 'aria-label': 'Position and activity' },
    tablist, ...tabDefs.map(([k]) => r.tabPanels[k]));

  // ---------- dialog ----------
  r.dlgTitle = h('h2', { id: `${id}-dlg-t`, class: 'xc-dialog__title' });
  r.dlgBody = h('div', { class: 'xc-dialog__body', id: `${id}-dlg-b` });
  r.dlgConfirm = h('button', { type: 'button', class: 'xc-btn xc-btn--long', text: 'Confirm' });
  r.dlgCancel = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Cancel' });
  r.dialog = h('dialog', { class: 'xc-dialog', 'aria-labelledby': r.dlgTitle.id, 'aria-describedby': r.dlgBody.id },
    r.dlgTitle, r.dlgBody, h('div', { class: 'xc-dialog__actions' }, r.dlgCancel, r.dlgConfirm));
  r.dlgCancel.addEventListener('click', () => closeDialog());
  r.dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
  r.dlgConfirm.addEventListener('click', () => {
    if (!dialogSpec || r.dlgConfirm.disabled) return;
    const spec = dialogSpec;
    if (spec.ackRound !== undefined && spec.ackRound !== (state.oracle?.round ?? null)) {
      spec.ackRound = state.oracle?.round ?? null;
      renderDialog();
      return;
    }
    const args = spec.args();
    closeDialog();
    run(spec.handler, ...args);
  });

  // ---------- assemble ----------
  const main = h('div', { class: 'xc-main' }, chartPanel, bookPanel);
  const side = h('aside', { class: 'xc-side', 'aria-label': 'Trading' }, tradePanel, accountPanel, testPanel);
  root.append(
    header,
    h('div', { class: 'xc-statusbar' }, r.status, r.alert),
    h('main', { class: 'xc-grid' }, main, side),
    h('footer', { class: 'xc-foot' },
      h('p', { text: `${COLLATERAL} is mock collateral on a test network with no cash value. Prices are the market's authenticated oracle marks in USD. Read-only replay is a separate view.` })),
    r.dialog);

  // ---------- behaviour ----------
  function controlsLocked() { return Boolean(pending || state.busy); }

  async function run(name, ...args) {
    if (!has(name) || controlsLocked()) return;
    pending = name;
    localError = null;
    render();
    try {
      await handlers[name](...args);
    } catch (err) {
      localError = err?.message ? String(err.message) : 'The action failed.';
    } finally {
      pending = null;
      render();
    }
  }

  function stepSize(delta) {
    const cur = parseLots(r.size.input.value);
    const base = cur.ok ? cur.value : MIN_LOTS - (delta > 0 ? 1 : 0);
    const next = Math.min(MAX_LOTS, Math.max(MIN_LOTS, base + delta));
    r.size.input.value = lotsToBtcString(next);
    touched.size = true;
    renderForm();
  }

  function setLeverage(k) {
    const lots = parseLots(r.size.input.value);
    const mark = state.oracle?.price_ticks;
    if (!lots.ok || !mark) return;
    const cents = Math.ceil((mark * lots.value) / k);
    r.margin.input.value = centsToString(Math.min(MAX_MARGIN_CENTS, cents));
    touched.margin = true;
    renderForm();
  }

  function slotOccupied() { return Boolean(state.position || state.active); }

  function readForm() {
    const lots = parseLots(r.size.input.value);
    const margin = parseCents(r.margin.input.value, { max: MAX_MARGIN_CENTS, maxReason: `Margin is capped at ${formatCents(MAX_MARGIN_CENTS)}` });
    const mark = state.oracle?.price_ticks ?? null;
    const quote = lots.ok && margin.ok && mark ? buildQuote({ lots: lots.value, marginCents: margin.value, markTicks: mark }) : null;
    let blocker = null;
    if (!state.session) blocker = 'Start a session to trade.';
    else if (!mark) blocker = 'Waiting for an oracle mark.';
    else if (slotOccupied()) blocker = 'This market has one isolated slot. Close the open position first.';
    else if (!lots.ok) blocker = `Size: ${lots.reason}.`;
    else if (!margin.ok) blocker = `Margin: ${margin.reason}.`;
    else if (quote && !quote.withinLeverage) blocker = `Leverage above ${MAX_LEVERAGE}x. Add margin (at least ${formatCents(quote.minMarginCents)}) or reduce size.`;
    else if (state.balances.available == null) blocker = 'Balances not loaded yet.';
    else if (state.balances.available < ESCROW_CENTS) blocker = `Each position locks ${formatCents(ESCROW_CENTS)} ${COLLATERAL} escrow. Deposit ${formatCents(ESCROW_CENTS - state.balances.available)} more.`;
    else if (state.balances.maker != null && state.balances.maker < MAKER_RESERVE_CENTS) blocker = `The maker vault cannot reserve ${formatCents(MAKER_RESERVE_CENTS)} ${COLLATERAL} for this position right now.`;
    else if (!has('onOpen')) blocker = 'Trading is unavailable in this view.';
    return { lots, margin, quote, blocker };
  }

  function quoteRows(q) {
    const liq = q.liqTicks;
    return [
      row('Mark · entry', h('span', {}, `${formatTicks(q.markTicks)} `, unit('USD'), h('span', { class: 'xc-muted', text: ` · R${state.oracle?.round ?? '—'}` }))),
      row('Notional', h('span', {}, `${formatCents(q.notionalCents)} `, unit())),
      row('Leverage', formatLeverage(q.leverage), { tone: q.withinLeverage ? null : 'neg' }),
      row('Est. liquidation', h('span', {}, `${liq > 0 ? formatPriceUsd(liq * TICK_USD) : 'None'} `, liq > 0 ? unit('USD') : null), { tone: 'neg' }),
      row('Escrow locked', h('span', {}, `${formatCents(ESCROW_CENTS)} `, unit())),
      row('Unassigned escrow', h('span', {}, `${formatCents(q.unassignedEscrowCents)} `, unit())),
    ];
  }

  function renderForm() {
    const { lots, margin, quote, blocker } = readForm();
    const locked = controlsLocked();
    const disabledAll = !state.session || slotOccupied();
    for (const el of [r.size.input, r.margin.input, r.sizeDown, r.sizeUp, ...r.levBtns]) el.disabled = disabledAll || locked;
    r.levBtns.forEach((b) => { b.disabled = b.disabled || !lots.ok || !state.oracle; });

    const setErr = (f, res, isTouched) => {
      const msg = isTouched && !res.ok ? res.reason : '';
      f.err.textContent = msg;
      f.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    setErr(r.size, lots, touched.size);
    setErr(r.margin, margin, touched.margin);
    r.size.hint.textContent = lots.ok
      ? `${lots.value} lot${lots.value === 1 ? '' : 's'} · 0.001 BTC per lot · max ${lotsToBtcString(MAX_LOTS)}`
      : `0.001 BTC per lot · max ${lotsToBtcString(MAX_LOTS)} BTC`;

    if (quote) {
      const lev = quote.leverage;
      r.levValue.textContent = formatLeverage(lev);
      r.levValue.className = quote.withinLeverage ? '' : 'is-neg';
      r.levFill.style.width = `${Math.min(100, (lev / MAX_LEVERAGE) * 100)}%`;
      r.levMeter.classList.toggle('is-over', !quote.withinLeverage);
      r.levMeter.setAttribute('aria-valuenow', lev.toFixed(2));
      r.levMeter.setAttribute('aria-valuetext', `${lev.toFixed(2)}x of ${MAX_LEVERAGE}x maximum`);
      r.quote.replaceChildren(...quoteRows(quote));
    } else {
      r.levValue.textContent = '—';
      r.levValue.className = '';
      r.levFill.style.width = '0%';
      r.levMeter.classList.remove('is-over');
      r.levMeter.removeAttribute('aria-valuenow');
      r.levMeter.setAttribute('aria-valuetext', 'Not available');
      r.quote.replaceChildren(h('p', { class: 'xc-muted xc-small', text: state.oracle ? 'Enter size and margin to preview the quote.' : 'Quote preview needs a live oracle mark.' }));
    }
    r.review.disabled = Boolean(blocker) || locked;
    r.review.textContent = pending === 'onOpen' ? 'Opening…' : 'Review long';
    r.blocker.textContent = blocker ?? '';
  }

  function reviewOpen() {
    const { lots, margin, blocker } = readForm();
    renderForm();
    if (blocker || controlsLocked()) { (lots.ok ? r.margin.input : r.size.input).focus(); return; }
    openDialog({
      title: 'Review long BTC-PERP',
      handler: 'onOpen',
      confirmLabel: 'Sign and open',
      ackRound: state.oracle?.round ?? null,
      args: () => [{ sizeBtc: lotsToBtcString(lots.value), marginUsd: centsToString(margin.value) }],
      build: () => {
        const f = readForm();
        const q = f.quote;
        const out = [];
        if (dialogSpec.ackRound !== (state.oracle?.round ?? null)) {
          out.push(h('p', { class: 'xc-notice', role: 'alert', text: `The mark moved to round ${state.oracle?.round}. Figures below use the new mark. Confirm again to proceed.` }));
        }
        if (q) {
          out.push(h('dl', { class: 'xc-rows' },
            row('Side', 'Long', { tone: 'pos' }),
            row('Size', h('span', {}, `${lotsToBtcString(q.lots)} `, unit('BTC'), h('span', { class: 'xc-muted', text: ` · ${q.lots} lots` }))),
            row('Margin', h('span', {}, `${formatCents(q.marginCents)} `, unit())),
            ...quoteRows(q)));
        }
        out.push(h('p', { class: 'xc-small', text: `Your client stages a private commitment, gets maker approval at this mark and keeper acknowledgments, builds the open proof, and submits the open. You may be asked to sign more than once. The quote expires if the mark changes before the open lands.` }));
        out.push(h('p', { class: 'xc-small xc-muted', text: `Liquidation happens if equity falls below 5% of notional at the oracle mark. The keeper bounty is 1.00 ${COLLATERAL}. Margin and blinder are never sent to the coordinator in plaintext; both designated keepers can decrypt the full opening.` }));
        return { nodes: out, blocked: f.blocker };
      },
    });
  }

  function reviewTransfer(kind) {
    const f = kind === 'deposit' ? r.deposit : r.withdraw;
    const res = transferCheck(kind);
    renderAccount();
    if (!res.ok || controlsLocked()) { f.input.focus(); return; }
    const amount = centsToString(res.value);
    openDialog({
      title: kind === 'deposit' ? 'Deposit collateral' : 'Withdraw collateral',
      handler: kind === 'deposit' ? 'onDeposit' : 'onWithdraw',
      confirmLabel: kind === 'deposit' ? 'Sign deposit' : 'Sign withdrawal',
      args: () => [amount],
      build: () => {
        const b = state.balances;
        const after = kind === 'deposit'
          ? [['Wallet after', b.wallet - res.value], ['Available after', b.available + res.value]]
          : [['Available after', b.available - res.value], ['Wallet after', b.wallet + res.value]];
        return {
          nodes: [
            h('dl', { class: 'xc-rows' },
              row('Amount', h('span', {}, `${formatCents(res.value)} `, unit())),
              row(kind === 'deposit' ? 'From → to' : 'From → to', kind === 'deposit' ? 'Wallet → market' : 'Market → wallet'),
              ...after.map(([l, v]) => row(l, h('span', {}, `${formatCents(v)} `, unit())))),
            h('p', { class: 'xc-small xc-muted', text: kind === 'deposit'
              ? `Moves mock tokens into your available market balance. Opening a position locks ${formatCents(ESCROW_CENTS)} ${COLLATERAL}.`
              : 'Transfers your available market balance back to your wallet. Locked escrow is not withdrawable.' }),
          ],
          blocked: transferCheck(kind).ok ? null : 'Balance changed; review the amount.',
        };
      },
    });
  }

  function transferCheck(kind) {
    const f = kind === 'deposit' ? r.deposit : r.withdraw;
    const bal = kind === 'deposit' ? state.balances.wallet : state.balances.available;
    if (bal == null) return { ok: false, reason: 'Balance not loaded' };
    return parseCents(f.input.value, { max: bal, maxReason: `Exceeds ${kind === 'deposit' ? 'wallet' : 'available'} balance (${formatCents(bal)})` });
  }

  function renderAccount() {
    const b = state.balances;
    const live = Boolean(state.session);
    for (const k of ['wallet', 'available', 'locked', 'maker']) r.bal[k].textContent = live ? formatCents(b[k]) : '—';
    r.accountNote.textContent = live ? '' : 'Start a session to load balances.';
    r.accountNote.hidden = live;
    const locked = controlsLocked();
    for (const kind of ['deposit', 'withdraw']) {
      const f = r[kind];
      const handlerOk = has(kind === 'deposit' ? 'onDeposit' : 'onWithdraw');
      const res = transferCheck(kind);
      const off = !live || !handlerOk || locked;
      f.input.disabled = !live || !handlerOk;
      f.max.disabled = off;
      f.go.disabled = off || (touched[kind] && !res.ok);
      const msg = touched[kind] && live && !res.ok ? res.reason : '';
      f.err.textContent = msg;
      f.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      f.go.textContent = pending === (kind === 'deposit' ? 'onDeposit' : 'onWithdraw') ? 'Signing…' : (kind === 'deposit' ? 'Deposit' : 'Withdraw');
    }
    r.withdraw.hint.textContent = live && b.locked > 0 ? `${formatCents(b.locked)} ${COLLATERAL} is locked in escrow until the position settles.` : '';
  }

  function positionView() {
    const p = state.position;
    if (!p) return null;
    const n = (v) => (v == null || v === '' ? null : Number(v));
    return {
      sizeBtc: n(p.sizeBtc), marginUsd: n(p.marginUsd), entryUsd: n(p.entryUsd),
      liquidationUsd: n(p.liquidationUsd), pnlUsd: n(p.pnlUsd), nonce: p.nonce, commitment: p.commitment,
    };
  }

  function currentLiqTicks() {
    const p = positionView();
    if (p && Number.isFinite(p.liquidationUsd)) return p.liquidationUsd / TICK_USD;
    return null;
  }

  function copyButton(value, label) {
    const btn = h('button', { type: 'button', class: 'xc-link', text: 'Copy', 'aria-label': `Copy ${label}` });
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      const t = setTimeout(() => { btn.textContent = 'Copy'; timers.delete(t); }, 1500);
      timers.add(t);
    });
    return btn;
  }

  function hashValue(v, label) {
    return h('span', { class: 'xc-hash' }, h('code', { title: String(v), text: shortHash(v, 8, 6) }), copyButton(v, label));
  }

  function renderPosition() {
    const host = r.tabPanels.position;
    const p = positionView();
    const markUsd = state.oracle ? state.oracle.price_ticks * TICK_USD : null;
    r.tabs.position.querySelector('.xc-count').textContent = p || state.active ? '1' : '';
    if (!state.session) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'Not connected. Start a session to see your position.' }));
      return;
    }
    if (!p && state.active) {
      const whyId = `${id}-nowitness`;
      host.replaceChildren(
        h('div', { class: 'xc-empty' },
          h('p', { text: `An active slot (nonce ${state.active.nonce ?? '—'}) exists on chain, but its private opening is not held in this browser, so size, margin and PnL cannot be shown.` }),
          h('dl', { class: 'xc-rows' },
            row('Commitment', state.active.commitment ? hashValue(state.active.commitment, 'commitment') : '—'),
            row('Keeper', state.keeperArmed ? 'Armed' : 'Not armed', { tone: state.keeperArmed ? 'pos' : null })),
          h('p', { class: 'xc-notice', id: whyId, text: 'Voluntary close is unavailable here: closing needs a proof built from the private opening, and this browser does not hold it. The designated keepers can still liquidate the slot from their encrypted copy if the mark crosses liquidation.' })),
        closeBar({ noWitness: true, describedBy: whyId }));
      return;
    }
    if (!p) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'No open position. Use the trade form to open an isolated long.' }));
      return;
    }
    const lev = p.entryUsd && p.sizeBtc && p.marginUsd ? (p.entryUsd * p.sizeBtc) / p.marginUsd : null;
    const pnlTone = p.pnlUsd > 0 ? 'pos' : p.pnlUsd < 0 ? 'neg' : null;
    const pnlPct = p.marginUsd ? (p.pnlUsd / p.marginUsd) * 100 : null;
    const nearLiq = markUsd != null && p.liquidationUsd > 0 && markUsd < p.liquidationUsd;
    host.replaceChildren(
      h('div', { class: 'xc-pos' },
        h('div', { class: 'xc-pos__head' },
          h('span', { class: 'xc-side-pill__long', text: 'Long' }),
          h('strong', { text: 'BTC-PERP' }),
          h('span', { class: 'xc-muted', text: `Isolated · nonce ${p.nonce ?? '—'}` }),
          nearLiq ? h('span', { class: 'xc-pill is-neg', text: 'Liquidatable at this mark' }) : null),
        h('dl', { class: 'xc-pos__grid' },
          row('Size', h('span', {}, `${formatBtc(p.sizeBtc)} `, unit('BTC'))),
          row('Entry', h('span', {}, `${formatPriceUsd(p.entryUsd)} `, unit('USD'))),
          row('Mark', h('span', {}, `${formatPriceUsd(markUsd)} `, unit('USD'))),
          row('Liquidation', h('span', {}, `${formatPriceUsd(p.liquidationUsd)} `, unit('USD')), { tone: 'neg' }),
          row('Margin', h('span', {}, `${formatAmount(p.marginUsd)} `, unit())),
          row('Leverage', formatLeverage(lev)),
          row('Unrealized PnL', h('span', {},
            `${formatSigned(p.pnlUsd)} `, unit(),
            pnlPct != null ? h('span', { class: 'xc-muted', text: ` (${formatSigned(pnlPct)}%)` }) : null), { tone: pnlTone }),
          row('Escrow', h('span', {}, `${formatCents(ESCROW_CENTS)} `, unit())),
          row('Keeper', state.keeperArmed ? 'Armed' : 'Not armed', { tone: state.keeperArmed ? 'pos' : null }),
          row('Commitment', p.commitment ? hashValue(p.commitment, 'commitment') : '—'))),
      closeBar());
  }

  function closeBar({ noWitness = false, describedBy } = {}) {
    const btn = h('button', {
      type: 'button', class: 'xc-btn xc-btn--short', 'aria-describedby': describedBy,
      text: pending === 'onClose' ? 'Closing…' : 'Close position',
    });
    btn.disabled = noWitness || controlsLocked() || !has('onClose');
    btn.addEventListener('click', () => {
      if (btn.disabled || !state.position) return;
      openDialog({
        title: 'Close position',
        handler: 'onClose',
        confirmLabel: 'Sign and close',
        args: () => [],
        build: () => {
          const pv = positionView();
          const mark = state.oracle ? state.oracle.price_ticks * TICK_USD : null;
          return {
            nodes: [
              h('dl', { class: 'xc-rows' },
                pv ? row('Size', h('span', {}, `${formatBtc(pv.sizeBtc)} `, unit('BTC'))) : null,
                row('Mark', h('span', {}, `${formatPriceUsd(mark)} `, unit('USD'), h('span', { class: 'xc-muted', text: ` · R${state.oracle?.round ?? '—'}` }))),
                pv ? row('Est. PnL', h('span', {}, `${formatSigned(pv.pnlUsd)} `, unit()), { tone: pv.pnlUsd > 0 ? 'pos' : pv.pnlUsd < 0 ? 'neg' : null }) : null),
              h('p', { class: 'xc-small', text: 'Settlement is computed by the market contract at the latest oracle round, including funding. The final refund appears in your available balance and receipts.' }),
            ],
            blocked: state.position
              ? null
              : state.active
                ? 'This browser does not hold the private opening for the active slot, so it cannot build a close proof.'
                : 'No open position.',
          };
        },
      });
    });
    return h('div', { class: 'xc-actions' }, btn);
  }

  function renderReceipts() {
    const host = r.tabPanels.receipts;
    const list = state.receipts;
    r.tabs.receipts.querySelector('.xc-count').textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'No transactions yet. Signed transactions appear here with explorer links.' }));
      return;
    }
    host.replaceChildren(h('ol', { class: 'xc-receipts', reversed: true },
      [...list].reverse().map((rc) => {
        const url = safeHttpUrl(rc.explorerUrl);
        return h('li', { class: 'xc-receipt' },
          h('span', { class: 'xc-receipt__label', text: rc.label ?? 'Transaction' }),
          rc.hash ? hashValue(rc.hash, `${rc.label ?? 'transaction'} hash`) : h('span', { class: 'xc-muted', text: '—' }),
          url ? h('a', { class: 'xc-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Explorer', 'aria-label': `Open ${rc.label ?? 'transaction'} in explorer (new tab)` }) : null);
      })));
  }

  function renderRounds() {
    const host = r.tabPanels.rounds;
    const hist = state.markHistory;
    r.tabs.rounds.querySelector('.xc-count').textContent = hist.length ? String(hist.length) : '';
    if (!hist.length) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'No oracle rounds recorded.' }));
      return;
    }
    host.replaceChildren(h('table', { class: 'xc-table' },
      h('caption', { class: 'xc-sr', text: 'Oracle mark by round, newest first' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Round' }), h('th', { scope: 'col', text: 'Mark (USD)' }), h('th', { scope: 'col', text: 'Change' }))),
      h('tbody', {}, [...hist].map((p, i) => {
        const prev = hist[i - 1];
        const d = prev ? (p.price_ticks - prev.price_ticks) * TICK_USD : null;
        return h('tr', {},
          h('td', { text: String(p.round) }),
          h('td', { text: formatTicks(p.price_ticks) }),
          h('td', { class: d > 0 ? 'is-pos' : d < 0 ? 'is-neg' : null, text: d == null ? '—' : d === 0 ? '0' : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')}` }));
      }).reverse())));
  }

  function renderTest() {
    const live = Boolean(state.session);
    const locked = controlsLocked();
    const m = parseMarkUsd(r.markField.input.value);
    r.markField.input.disabled = !live || !has('onSetMark');
    r.markGo.disabled = !live || !has('onSetMark') || locked || (touched.mark && !m.ok);
    r.markGo.textContent = pending === 'onSetMark' ? 'Publishing…' : 'Publish mark';
    const msg = touched.mark && !m.ok ? m.reason : '';
    r.markField.err.textContent = msg;
    r.markField.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    const liq = currentLiqTicks();
    r.markLiq.disabled = !live || !(liq > 1);
    r.markField.input.placeholder = state.oracle ? String(state.oracle.price_ticks * TICK_USD) : '';
    let effect = '';
    let tone = '';
    if (m.ok && state.position && liq != null) {
      if (m.value < liq) { effect = `Below liquidation (${formatPriceUsd(liq * TICK_USD)} USD): an armed keeper can liquidate.`; tone = 'is-neg'; }
      else { effect = `Above liquidation (${formatPriceUsd(liq * TICK_USD)} USD): position stays healthy.`; tone = 'is-pos'; }
    } else if (m.ok && state.active && !state.position) {
      effect = 'Health of the active slot is evaluated by the keeper with the private opening.';
    }
    r.markEffect.textContent = effect;
    r.markEffect.className = `xc-small ${tone}`;

    const armed = state.keeperArmed;
    r.keeperState.textContent = armed ? 'Armed' : 'Idle';
    r.keeperState.className = `xc-pill ${armed ? 'is-pos' : ''}`;
    r.keeperNote.textContent = armed
      ? 'The keeper is watching the active slot and will submit a liquidation proof if the mark crosses liquidation.'
      : state.active || state.position
        ? 'Arm the keeper so it watches this slot and liquidates with a proof when equity drops below maintenance.'
        : 'Available once a position is open.';
    r.arm.disabled = !live || armed || !(state.active || state.position) || locked || !has('onArmKeeper');
    r.arm.textContent = pending === 'onArmKeeper' ? 'Arming…' : armed ? 'Keeper armed' : 'Arm keeper';
  }

  function renderHeader() {
    const o = state.oracle;
    r.mark.textContent = o ? formatTicks(o.price_ticks) : '—';
    r.round.textContent = o ? String(o.round) : '—';
    r.funding.textContent = o && Number.isFinite(o.funding_cents) ? formatCents(o.funding_cents) : '—';
    const net = state.network;
    r.networkBadge.textContent = net === 'testnet' ? 'NEAR testnet' : net === 'sandbox' ? 'NEAR sandbox' : 'Offline';
    r.networkBadge.className = `xc-badge ${net ? `is-${net}` : 'is-off'}`;
    const s = state.session;
    if (s) {
      r.session.replaceChildren(
        h('span', { class: 'xc-dot is-on', 'aria-hidden': 'true' }),
        h('span', { class: 'xc-session__id', title: `Trader ${s.traderId}\nMarket ${s.marketId}\nToken ${s.tokenId}`, text: s.traderId ?? 'session' }));
    } else {
      const btn = h('button', { type: 'button', class: 'xc-btn xc-btn--primary', text: pending === 'onStart' ? 'Starting…' : 'Start session', onclick: () => run('onStart') });
      btn.disabled = controlsLocked() || !has('onStart');
      r.session.replaceChildren(btn);
    }
  }

  function renderStatus() {
    const working = state.busy || (pending ? 'Waiting for confirmation…' : null);
    r.status.classList.toggle('is-busy', Boolean(working));
    r.statusText.textContent = working
      ?? (state.session ? (state.oracle ? `Ready · mark round ${state.oracle.round}` : 'Connected · waiting for oracle') : 'Not connected. Start a session to load the market.');
    r.proof.textContent = state.proofStatus ? `Proof: ${state.proofStatus}` : '';
    r.proof.hidden = !state.proofStatus;
    const err = state.error || localError;
    r.alert.hidden = !err;
    r.alertText.textContent = err ?? '';
    r.alert.querySelector('button').hidden = !localError || Boolean(state.error);
    root.setAttribute('aria-busy', working ? 'true' : 'false');
  }

  function renderChart() {
    const p = positionView();
    const hist = state.markHistory;
    chart.update({
      history: hist,
      entryTicks: p && Number.isFinite(p.entryUsd) ? p.entryUsd / TICK_USD : null,
      liqTicks: p && Number.isFinite(p.liquidationUsd) && p.liquidationUsd > 0 ? p.liquidationUsd / TICK_USD : null,
    });
    if (hist.length >= 2) {
      const d = (hist[hist.length - 1].price_ticks - hist[0].price_ticks) * TICK_USD;
      r.chartLast.textContent = `${hist.length} rounds · ${d >= 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} USD`;
      r.chartLast.className = `xc-panel__meta ${d > 0 ? 'is-pos' : d < 0 ? 'is-neg' : ''}`;
    } else {
      r.chartLast.textContent = hist.length ? '1 round' : '';
      r.chartLast.className = 'xc-panel__meta';
    }
  }

  // ---------- dialog lifecycle ----------
  let returnFocus = null;
  function openDialog(spec) {
    dialogSpec = spec;
    returnFocus = document.activeElement;
    renderDialog();
    if (typeof r.dialog.showModal === 'function') { if (!r.dialog.open) r.dialog.showModal(); }
    else r.dialog.setAttribute('open', '');
    r.dlgCancel.focus();
  }
  function closeDialog() {
    dialogSpec = null;
    if (r.dialog.open) { if (typeof r.dialog.close === 'function') r.dialog.close(); else r.dialog.removeAttribute('open'); }
    if (returnFocus && typeof returnFocus.focus === 'function' && root.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
  }
  function renderDialog() {
    if (!dialogSpec) return;
    r.dlgTitle.textContent = dialogSpec.title;
    const { nodes, blocked } = dialogSpec.build();
    r.dlgBody.replaceChildren(...nodes, blocked ? h('p', { class: 'xc-blocker', text: blocked }) : null);
    const stale = dialogSpec.ackRound !== undefined && dialogSpec.ackRound !== (state.oracle?.round ?? null);
    r.dlgConfirm.textContent = stale ? `Confirm at round ${state.oracle?.round}` : dialogSpec.confirmLabel;
    r.dlgConfirm.className = `xc-btn ${dialogSpec.handler === 'onClose' ? 'xc-btn--short' : 'xc-btn--long'}`;
    r.dlgConfirm.disabled = Boolean(blocked) || controlsLocked() || !has(dialogSpec.handler);
  }

  function render() {
    renderHeader();
    renderStatus();
    renderChart();
    renderForm();
    renderAccount();
    renderPosition();
    renderReceipts();
    renderRounds();
    renderTest();
    renderDialog();
  }

  render();

  return {
    update(next) {
      state = normalizeState(next ?? {});
      render();
    },
    destroy() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (r.dialog.open && typeof r.dialog.close === 'function') r.dialog.close();
      chart.destroy();
      root.replaceChildren();
      root.classList.remove('xc');
      root.removeAttribute('aria-busy');
      handlers = {};
    },
  };
}
