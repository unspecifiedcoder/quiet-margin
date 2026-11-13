// Xythum NEAR Perps — customer exchange UI.
//
// Layout lineage: the original Xythum EVM DEX terminal
// (Xythum-Labs/darkpool-gateway @ e5cbe25965ec546ac6e691704d9c176137cf561c):
// chart + activity on the left, a trade ticket on the right, positions /
// history tabs below the chart. React, wagmi, TradingView and wallet code were
// not carried over. This module is plain DOM; it renders client state and
// forwards intents to handlers.
//
// Rendering rule: every interactive control is created once and only has its
// text, disabled state and visibility updated. Lists (receipts, rounds,
// position details) are rebuilt only when their visible content changes, so
// the 8 s poll never steals focus from a button, link or input.

import {
  COLLATERAL, ESCROW_CENTS, KEEPER_BOUNTY_CENTS, MAKER_RESERVE_CENTS, MAX_LEVERAGE, MAX_LOTS, MAX_MARGIN_CENTS,
  MIN_LOTS, TICK_USD,
  buildQuote, centsToString, formatAmount, formatBtc, formatCents, formatLeverage, formatPriceUsd, formatSigned,
  formatTicks, lotsToBtcString, normalizeState, parseCents, parseLots, parseMarkUsd, safeHttpUrl,
  shortHash,
} from './format.js';
import { createMarkChart } from './chart.js';
import { createSpotChart } from './spot-chart.js';

/** Cold-start ticket: a valid 1.78x quote at a 100,000 USD mark that fits the fixed escrow. */
const DEFAULT_SIZE = '0.008';
const DEFAULT_MARGIN = '450.00';

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

function row(label, value, { tone, id } = {}) {
  return h('div', { class: 'xc-row' },
    h('dt', { text: label }),
    h('dd', { class: tone ? `is-${tone}` : null, id }, value));
}

function setText(el, text) {
  const t = text ?? '';
  if (el.textContent !== t) el.textContent = t;
}

const CUSTODY = {
  'webcrypto-nonextractable': { short: 'Non-exportable browser key', long: 'The trader key is a non-extractable WebCrypto key in this browser. Pages on this site can ask it to sign, but cannot read it out.' },
  'origin-storage': { short: 'Key in site storage', long: 'This browser lacks WebCrypto Ed25519, so the trader key is a secret kept in this site\'s storage. Clearing site data removes it.' },
};

/**
 * options (all optional; the default route passes only privateWalletHref):
 *   privateWalletHref  link to the private wallet route, shown beside Start session
 *   banner             element placed under the top bar (private wallet identity)
 *   cold               { title, body, button, noteSummary, note[] } copy for the
 *                      not-yet-started state when the session is started elsewhere
 */
export function mountExchange(root, handlers = {}, options = {}) {
  if (!root) throw new Error('mountExchange: root element required');
  const cold = options.cold ?? null;
  const id = `xc${++uid}`;
  const has = (name) => typeof handlers[name] === 'function';
  let state = normalizeState({});
  let pending = null;
  let localError = null;
  let touched = { size: false, margin: false, deposit: false, withdraw: false, mark: false };
  let dialogSpec = null;
  let phase = null;
  const keys = { position: null, receipts: null, receiptItems: null, rounds: null };
  const timers = new Set();
  // Run after the current focus change settles (focusout fires before the
  // next element is focused).
  const later = (fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, 0); timers.add(t); };

  root.classList.add('xc');
  root.replaceChildren();

  const r = {};

  // ---------- top bar: brand, network, collateral, session ----------
  r.netDot = h('span', { class: 'xc-dot', 'aria-hidden': 'true' });
  r.netText = h('span');
  r.network = h('span', { class: 'xc-tag xc-net' }, r.netDot, r.netText);
  r.sessionId = h('span', { class: 'xc-who__id' });
  r.custody = h('span', { class: 'xc-who__key' });
  r.who = h('div', { class: 'xc-who' }, r.sessionId, r.custody);
  r.positionExplorer = h('a', { class: 'xc-link', href: '/positions', text: 'Position Explorer' });
  const top = h('header', { class: 'xc-top' },
    h('div', { class: 'xc-brand' },
      h('span', { class: 'xc-brand__mark', 'aria-hidden': 'true' }),
      h('span', { class: 'xc-brand__name', text: 'Quiet Margin' })),
    h('div', { class: 'xc-top__ctx' },
      r.network,
      h('span', { class: 'xc-tag', title: `${COLLATERAL} is a mock token on a test network with no cash value.` }, h('strong', { text: COLLATERAL }), ' mock collateral'),
      r.positionExplorer),
    r.who);

  // ---------- market strip ----------
  r.mark = h('strong', { class: 'xc-fig xc-fig--lg' });
  r.spot = h('strong', { class: 'xc-fig xc-fig--lg', text: '—' });
  r.round = h('strong', { class: 'xc-fig' });
  r.funding = h('strong', { class: 'xc-fig' });
  r.change = h('strong', { class: 'xc-fig' });
  const figure = (label, el, extra) => h('div', { class: 'xc-strip__fig' }, h('span', { class: 'xc-label', text: label }), h('span', {}, el, extra ?? null));
  const strip = h('section', { class: 'xc-strip', 'aria-label': 'Market' },
    h('div', { class: 'xc-strip__pair' },
      h('h1', { class: 'xc-pair', text: 'BTC-PERP' }),
      h('span', { class: 'xc-muted', text: `Isolated long · ${COLLATERAL} margin · ≤ ${MAX_LEVERAGE}x` })),
    options.spot ? figure('BTC/USDT spot', r.spot, unit('USDT')) : null,
    figure('NEAR oracle mark', r.mark, unit('USD')),
    figure('Round', r.round),
    figure('Funding index', r.funding, unit()),
    figure('Since first round', r.change, unit('USD')),
    h('nav', { class: 'xc-jumps', 'aria-label': 'Jump to section' },
      h('a', { class: 'xc-link', href: `#${id}-chart`, text: 'Chart' }),
      h('a', { class: 'xc-link', href: `#${id}-activity`, text: 'Activity' }),
      h('a', { class: 'xc-link', href: `#${id}-privacy`, text: 'Who can see' })));

  // ---------- status ----------
  r.statusText = h('span', { class: 'xc-status__text' });
  r.proof = h('span', { class: 'xc-status__proof' });
  r.notice = h('span', { class: 'xc-status__notice' });
  r.status = h('div', { class: 'xc-status', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'xc-spinner', 'aria-hidden': 'true' }), r.statusText, r.proof, r.notice);
  r.alertText = h('span');
  r.alertDismiss = h('button', { type: 'button', class: 'xc-link', text: 'Dismiss', onclick: () => { localError = null; render(); } });
  r.alert = h('div', { class: 'xc-alert', role: 'alert', hidden: true }, r.alertText, r.alertDismiss);

  // ---------- chart ----------
  r.chartMeta = h('span', { class: 'xc-card__meta' });
  const chartHost = h('div', { class: 'xc-chart-host' });
  r.chartCard = h('section', { class: 'xc-card xc-area-chart', id: `${id}-chart`, 'aria-labelledby': `${id}-chart-h` },
    h('div', { class: 'xc-card__head' },
      h('h2', { id: `${id}-chart-h`, class: 'xc-card__title', text: options.spot ? 'BTC / USDT' : 'BTC mark · oracle rounds' }),
      r.chartMeta),
    chartHost);
  const chart = options.spot ? createSpotChart(chartHost, r.chartMeta, r.spot) : createMarkChart(chartHost);

  // ---------- fields ----------
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

  // ---------- ticket: next action ----------
  const stepDefs = [['session', 'Session'], ['escrow', 'Escrow'], ['open', 'Open long']];
  r.steps = {};
  const stepList = h('ol', { class: 'xc-steps', 'aria-label': 'Progress' },
    stepDefs.map(([k, label], i) => {
      const li = h('li', { class: 'xc-step' }, h('span', { class: 'xc-step__n', 'aria-hidden': 'true', text: String(i + 1) }), h('span', { text: label }), h('span', { class: 'xc-sr' }));
      r.steps[k] = li;
      return li;
    }));
  r.nextTitle = h('h2', { class: 'xc-next__title', id: `${id}-next-h`, tabindex: '-1' });
  r.nextBody = h('p', { class: 'xc-next__body' });
  r.nextLinkLabel = h('span');
  r.nextLink = h('a', { class: 'xc-link', target: '_blank', rel: 'noopener noreferrer', text: 'View on explorer' });
  r.nextEvidence = h('p', { class: 'xc-next__evidence' }, r.nextLinkLabel, ' ', r.nextLink);
  r.startBtn = h('button', { type: 'button', class: 'xc-btn xc-btn--act xc-btn--block', text: cold?.button ?? 'Start session', onclick: () => run('onStart') });
  r.nextClose = h('button', { type: 'button', class: 'xc-btn xc-btn--risk', text: 'Close position', onclick: () => requestClose() });
  r.nextArm = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Arm Keeper B', onclick: () => run('onArmKeeper') });
  // Once Keeper B is armed, the natural next step is to move the mark; this
  // opens the (still secondary) testnet tools at the mark field.
  r.nextMark = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Publish a test mark', 'aria-controls': `${id}-tools`, onclick: () => openMarkTool() });
  r.nextActions = h('div', { class: 'xc-next__actions' }, r.startBtn, r.nextClose, r.nextArm, r.nextMark);
  r.startNote = cold?.note
    ? h('details', { class: 'xc-disclose' },
      h('summary', { text: cold.noteSummary ?? 'What this step does' }),
      h('ul', { class: 'xc-list' }, cold.note.map((text) => h('li', { text }))))
    : h('details', { class: 'xc-disclose' },
      h('summary', { text: 'What Start session does' }),
      h('ul', { class: 'xc-list' },
        h('li', { text: 'Creates a signing key in this browser and proves possession of it to the coordinator.' }),
        h('li', { text: `The coordinator provisions a NEAR testnet trader account controlled by that key, holding mock ${COLLATERAL}.` }),
        h('li', { text: 'The page then checks the market config and the key on chain before showing balances.' }),
        h('li', { text: 'Nothing is created until you click. A saved session in this browser is reattached automatically.' })));
  // Alternative entry on the default route: the private wallet route.
  r.altEntry = options.privateWalletHref
    ? h('p', { class: 'xc-alt-entry' },
      h('a', { class: 'xc-btn xc-btn--ghost xc-alt-entry__btn', href: options.privateWalletHref, 'aria-describedby': `${id}-alt-d`, text: 'Private wallet' }),
      h('span', { class: 'xc-small xc-muted', id: `${id}-alt-d`, text: `A separate trader on a built-in NEAR testnet burner with demo ${COLLATERAL}. This browser's session here is not changed.` }))
    : null;
  r.next = h('section', { class: 'xc-next', 'aria-labelledby': r.nextTitle.id },
    stepList, r.nextTitle, r.nextBody, r.nextEvidence, r.nextActions, r.altEntry, r.startNote);

  // ---------- ticket: collateral ----------
  r.bal = { wallet: h('span', { class: 'xc-fig' }), available: h('span', { class: 'xc-fig' }), locked: h('span', { class: 'xc-fig' }), maker: h('span', { class: 'xc-fig' }) };
  const balCell = (label, el, note) => h('div', { class: 'xc-bal' }, h('dt', { class: 'xc-label', title: note, text: label }), h('dd', {}, el));
  r.balances = h('dl', { class: 'xc-bals', 'aria-label': `Balances in ${COLLATERAL}` },
    balCell('Wallet', r.bal.wallet, 'Token balance in your trader account'),
    balCell('Available', r.bal.available, 'In the market, free to use or withdraw'),
    balCell('Locked', r.bal.locked, 'Escrow held by an open position'),
    balCell('Maker vault', r.bal.maker, 'Counterparty vault free to reserve'));
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
  r.withdrawBox = h('details', { class: 'xc-disclose' }, h('summary', { text: 'Withdraw to wallet' }), r.withdraw.form);
  // Funding phase: forced open with its summary hidden, so Deposit leads.
  // Other phases: collapsed under the compact balance row.
  r.transferBox = h('details', { class: 'xc-disclose xc-transfer' },
    h('summary', { text: 'Deposit or withdraw' }),
    h('div', { class: 'xc-transfer__body' }, r.deposit.form, r.withdrawBox));
  r.fund = h('section', { class: 'xc-tsec xc-fund', 'aria-labelledby': `${id}-fund-h` },
    h('div', { class: 'xc-tsec__head' },
      h('h3', { id: `${id}-fund-h`, class: 'xc-tsec__title', text: 'Collateral' }),
      h('span', { class: 'xc-muted xc-small', text: `${COLLATERAL} · mock, no cash value` })),
    r.balances, r.transferBox);

  // ---------- ticket: order ----------
  r.size = field({ key: 'size', label: 'Size', value: DEFAULT_SIZE, unitText: 'BTC' });
  const stepBtn = (delta, text, label) => h('button', {
    type: 'button', class: 'xc-stepper', 'aria-label': label, text,
    onclick: () => stepSize(delta),
  });
  r.sizeDown = stepBtn(-1, '−', 'Decrease size by 0.001 BTC');
  r.sizeUp = stepBtn(1, '+', 'Increase size by 0.001 BTC');
  r.sizeMax = h('button', { type: 'button', class: 'xc-chip', text: 'Max', 'aria-label': `Largest size this margin allows at ${MAX_LEVERAGE}x` });
  r.sizeMax.addEventListener('click', () => maxSize());
  r.size.box.prepend(r.sizeDown);
  r.size.box.append(r.sizeUp, r.sizeMax);
  r.margin = field({ key: 'margin', label: 'Margin', value: DEFAULT_MARGIN, unitText: COLLATERAL, hint: `Up to ${formatCents(MAX_MARGIN_CENTS)} ${COLLATERAL}, paid from the fixed escrow` });
  r.levBtns = [1, 2, 3].map((k) => h('button', {
    type: 'button', class: 'xc-chip', text: `${k}x`, 'aria-label': `Set margin for ${k}x leverage`,
    onclick: () => setLeverage(k),
  }));
  r.levValue = h('strong', { class: 'xc-fig' });
  r.levFill = h('span', { class: 'xc-meter__fill' });
  r.levMeter = h('div', { class: 'xc-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(MAX_LEVERAGE), 'aria-label': 'Leverage' }, r.levFill);
  r.quoteRound = h('span', { class: 'xc-muted xc-small' });
  r.quote = h('dl', { class: 'xc-rows xc-quote', 'aria-labelledby': `${id}-quote-h` });
  r.blocker = h('p', { class: 'xc-blocker', id: `${id}-blocker`, 'aria-live': 'polite' });
  r.review = h('button', { type: 'submit', class: 'xc-btn xc-btn--act xc-btn--block xc-review', 'aria-describedby': `${id}-blocker`, text: 'Review long' });
  r.privacyLink = h('a', { class: 'xc-link xc-privacy-link', href: `#${id}-privacy`, text: 'Who can see the opening?' });
  // Review long sits directly after the inputs that define the order, so the
  // ready action is on screen with them; the quote it previews follows.
  r.form = h('form', { class: 'xc-tsec xc-order', novalidate: true, 'aria-labelledby': `${id}-order-h` },
    h('div', { class: 'xc-tsec__head' },
      h('h3', { id: `${id}-order-h`, class: 'xc-tsec__title' }, h('span', { class: 'xc-side', text: 'Long' }), ' BTC-PERP'),
      h('span', { class: 'xc-muted xc-small', text: 'Isolated · one slot' })),
    h('div', { class: 'xc-order__inputs' }, r.size.wrap, r.margin.wrap),
    h('div', { class: 'xc-lev' },
      h('div', { class: 'xc-lev__head' }, h('span', { class: 'xc-label', text: `Leverage · max ${MAX_LEVERAGE}x` }), r.levValue),
      r.levMeter,
      h('div', { class: 'xc-chips', role: 'group', 'aria-label': 'Leverage presets' }, r.levBtns)),
    r.review,
    r.blocker,
    h('div', { class: 'xc-quote-wrap' },
      h('div', { class: 'xc-lev__head' }, h('h4', { class: 'xc-label', id: `${id}-quote-h`, text: 'Execution quote' }), r.quoteRound),
      r.quote),
    r.privacyLink);
  r.form.addEventListener('submit', (e) => { e.preventDefault(); touched.size = touched.margin = true; reviewOpen(); });
  r.size.input.addEventListener('input', () => { touched.size = true; renderForm(); });
  r.margin.input.addEventListener('input', () => { touched.margin = true; renderForm(); });
  r.size.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepSize(e.key === 'ArrowUp' ? 1 : -1); }
  });

  // ---------- ticket: testnet tools ----------
  r.markField = field({ key: 'mark', label: 'Test mark', value: '', unitText: 'USD', hint: 'Publishes a new oracle round to this session\'s test market, in 10 USD ticks.' });
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
  r.arm = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Arm Keeper B', onclick: () => run('onArmKeeper') });
  r.toolsSummaryNote = h('span', { class: 'xc-muted xc-small' });
  r.tools = h('details', { class: 'xc-tsec xc-tools', id: `${id}-tools` },
    h('summary', {}, h('span', { class: 'xc-tsec__title', text: 'Testnet tools' }), r.toolsSummaryNote),
    h('div', { class: 'xc-tools__body' },
      h('p', { class: 'xc-muted xc-small', text: 'Protocol controls for this session\'s isolated test market. They act on its oracle and backup keeper, separately from your trade.' }),
      r.markForm, r.markEffect,
      h('div', { class: 'xc-keeper' },
        h('div', { class: 'xc-lev__head' }, h('span', { class: 'xc-label', text: 'Keeper B · backup liquidation keeper' }), r.keeperState),
        r.keeperNote, r.arm)));

  r.ticket = h('aside', { class: 'xc-ticket xc-area-ticket', 'aria-label': 'Order ticket' }, r.next, r.fund, r.form, r.tools);

  // ---------- activity: positions / receipts / mark rounds ----------
  const tabDefs = [['position', 'Positions'], ['receipts', 'Receipts'], ['rounds', 'Mark rounds']];
  r.tabs = {};
  r.counts = {};
  r.tabPanels = {};
  const tablist = h('div', { class: 'xc-tabs', role: 'tablist', 'aria-label': 'Activity' });
  for (const [key, label] of tabDefs) {
    r.counts[key] = h('span', { class: 'xc-count' });
    const tab = h('button', {
      type: 'button', role: 'tab', class: 'xc-tab', id: `${id}-tab-${key}`, 'aria-controls': `${id}-tp-${key}`,
      'aria-selected': key === 'position' ? 'true' : 'false', tabindex: key === 'position' ? '0' : '-1',
    }, h('span', { text: label }), r.counts[key]);
    tab.addEventListener('click', () => selectTab(key));
    r.tabs[key] = tab;
    tablist.append(tab);
    r.tabPanels[key] = h('div', { class: 'xc-tabpanel', role: 'tabpanel', id: `${id}-tp-${key}`, 'aria-labelledby': tab.id, tabindex: '0', hidden: key !== 'position' });
  }
  tablist.addEventListener('keydown', (e) => {
    const ks = tabDefs.map(([k]) => k);
    const cur = ks.findIndex((k) => r.tabs[k].getAttribute('aria-selected') === 'true');
    let next = null;
    if (e.key === 'ArrowRight') next = (cur + 1) % ks.length;
    else if (e.key === 'ArrowLeft') next = (cur - 1 + ks.length) % ks.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ks.length - 1;
    if (next == null) return;
    e.preventDefault();
    selectTab(ks[next]);
    r.tabs[ks[next]].focus();
  });
  function selectTab(key) {
    for (const [k] of tabDefs) {
      const on = k === key;
      r.tabs[k].setAttribute('aria-selected', String(on));
      r.tabs[k].tabIndex = on ? 0 : -1;
      r.tabPanels[k].hidden = !on;
    }
  }
  // Position panel: details are rebuilt on change; the action bar is persistent.
  r.posBody = h('div', { class: 'xc-posbody' });
  // While a Copy / Explorer control inside the details has focus, rebuilding
  // would drop focus, so the fresh view renders above and the old details stay
  // (marked as earlier) until focus leaves them.
  r.posFresh = h('div', { class: 'xc-posbody', hidden: true });
  r.posStaleNote = h('p', { class: 'xc-small xc-muted xc-stale-note', hidden: true, text: 'Earlier details, kept while a control in them has focus.' });
  for (const box of [r.posBody, r.posFresh]) {
    box.addEventListener('focusout', (e) => {
      if (box.contains(e.relatedTarget)) return;
      // Defer so the newly focused element is settled before rebuilding.
      later(renderPosition);
    });
  }
  r.posNoWitness = h('p', { class: 'xc-notice', id: `${id}-nowitness`, hidden: true, text: 'Voluntary close is unavailable here: closing needs a proof built from the private opening, and this browser does not hold it. The designated keepers can still liquidate the slot from their encrypted copy if the mark crosses liquidation.' });
  r.posClose = h('button', { type: 'button', class: 'xc-btn xc-btn--risk', text: 'Close position', onclick: () => requestClose() });
  r.posArm = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Arm Keeper B', onclick: () => run('onArmKeeper') });
  r.posActions = h('div', { class: 'xc-actions', hidden: true }, r.posArm, r.posClose);
  r.tabPanels.position.append(r.posFresh, r.posStaleNote, r.posBody, r.posNoWitness, r.posActions);
  r.tabPanels.receipts.addEventListener('focusout', (e) => {
    if (r.tabPanels.receipts.contains(e.relatedTarget)) return;
    later(renderReceipts);
  });
  r.activity = h('section', { class: 'xc-card xc-area-book', id: `${id}-activity`, 'aria-label': 'Activity' },
    tablist, ...tabDefs.map(([k]) => r.tabPanels[k]));

  // ---------- who can see the opening ----------
  const EXAMPLE_TX = [
    ['Open', '9jm21tNY6doDZKxLmmmfVPNGhaiRqTVa3uUMsERo6JQD'],
    ['Keeper', 'F5zj6buC35jzdVesQxHWX4m6YJaBiFje5eBfbJ3a54dD'],
  ];
  const seeItem = (who, scope, sees, detail) => h('li', { class: `xc-see xc-see--${scope}` },
    h('span', { class: 'xc-see__who' }, h('span', { class: 'xc-see__mark', 'aria-hidden': 'true' }), who),
    h('strong', { class: 'xc-see__what', text: sees }),
    h('p', { class: 'xc-see__detail', text: detail }));
  r.privacyCard = h('section', { class: 'xc-card xc-area-privacy xc-seecard', id: `${id}-privacy`, 'aria-labelledby': `${id}-privacy-h` },
    h('div', { class: 'xc-card__head' },
      h('h2', { id: `${id}-privacy-h`, class: 'xc-card__title', text: 'Who can see the opening?' }),
      h('span', { class: 'xc-card__meta', text: 'Opening = size, entry, margin and position blinder' })),
    h('ol', { class: 'xc-see-list' },
      seeItem('NEAR chain', 'public', 'Commitment and fixed escrow',
        `Anyone reading the chain sees a salted commitment to the opening and the fixed ${formatCents(ESCROW_CENTS)} ${COLLATERAL} escrow it locks.`),
      seeItem('Maker', 'maker', 'Size and entry',
        'The maker sees size and entry mark, salted with a separate quote blinder, to approve the quote.'),
      seeItem('Keeper A or B', 'keeper', 'The full opening',
        'The opening is encrypted to both designated keepers. Either can decrypt all of it, including margin and the position blinder, to liquidate.')),
    h('div', { class: 'xc-see-foot' },
      h('p', { class: 'xc-small xc-muted', text: 'Close and liquidation amounts settle on chain and can allow inference about the opening.' }),
      h('p', { class: 'xc-small xc-see-examples' },
        h('span', { class: 'xc-muted', text: 'Example testnet receipts, archived, not this session: ' }),
        EXAMPLE_TX.flatMap(([label, hash], i) => [
          i ? h('span', { class: 'xc-muted', text: ' · ' }) : null,
          h('a', {
            class: 'xc-link', href: `https://testnet.near.rocks/tx/${hash}`, target: '_blank', rel: 'noopener noreferrer',
            title: hash, 'aria-label': `Example ${label.toLowerCase()} receipt ${shortHash(hash, 4, 4)} on testnet near.rocks explorer (archived example, new tab)`,
          }, `${label} ${shortHash(hash, 4, 4)}`),
        ]))));

  // ---------- dialog ----------
  r.dlgTitle = h('h2', { id: `${id}-dlg-t`, class: 'xc-dialog__title' });
  // The description is one short sentence; the structured body is read in
  // place rather than announced as a single run-on description.
  r.dlgDesc = h('p', { class: 'xc-small', id: `${id}-dlg-d` });
  r.dlgBody = h('div', { class: 'xc-dialog__body', id: `${id}-dlg-b` });
  r.dlgConfirm = h('button', { type: 'button', class: 'xc-btn xc-btn--act', text: 'Confirm' });
  r.dlgCancel = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Cancel' });
  r.dialog = h('dialog', { class: 'xc-dialog', 'aria-labelledby': r.dlgTitle.id, 'aria-describedby': r.dlgDesc.id },
    r.dlgTitle, r.dlgDesc, r.dlgBody, h('div', { class: 'xc-dialog__actions' }, r.dlgCancel, r.dlgConfirm));
  r.dlgCancel.addEventListener('click', () => closeDialog());
  r.dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
  r.dlgConfirm.addEventListener('click', () => {
    if (!dialogSpec || r.dlgConfirm.disabled) return;
    const spec = dialogSpec;
    if (markStale(spec)) {
      spec.ackMark = currentMark();
      renderDialog();
      return;
    }
    const args = spec.args();
    closeDialog();
    run(spec.handler, ...args);
  });

  // ---------- assemble ----------
  // DOM order is ticket, chart, activity: on narrow screens that is also the
  // visual order, so onboarding and deposit sit near the top. Desktop places
  // the ticket in a right column spanning the chart and activity rows.
  root.append(
    top,
    ...(options.banner ? [options.banner] : []),
    strip,
    h('div', { class: 'xc-statusbar' }, r.status, r.alert),
    h('main', { class: 'xc-grid' }, r.ticket, r.chartCard, r.activity, r.privacyCard),
    h('footer', { class: 'xc-foot' },
      h('p', { text: options.spot
        ? `${COLLATERAL} is a test token with no cash value. Binance spot is a reference; the published NEAR mark determines settlement.`
        : `${COLLATERAL} is mock collateral on a NEAR test network with no cash value. This demo uses controlled oracle marks.` })),
    r.dialog);

  // ---------- behaviour ----------
  function controlsLocked() { return Boolean(pending || state.busy); }

  function isGone(el) {
    return !el || !el.isConnected || el === document.body || el.disabled || el.closest('[hidden]') != null
      || (typeof el.checkVisibility === 'function' && !el.checkVisibility());
  }

  async function run(name, ...args) {
    if (!has(name) || controlsLocked()) return;
    const origin = document.activeElement;
    pending = name;
    localError = null;
    render();
    try {
      return await handlers[name](...args);
    } catch (err) {
      localError = err?.message ? String(err.message) : 'The action failed.';
    } finally {
      pending = null;
      render();
      // An action can hide or disable the control that started it (Start
      // session, Close position). Land focus on the next step once, instead
      // of leaving it on <body>.
      // Disabled controls also drop focus while the action runs; return it to
      // the control that started the action when it is still usable.
      const active = document.activeElement;
      const lost = !active || active === document.body || isGone(active);
      if (lost && !r.dialog.open && origin && origin !== document.body && root.contains(origin)) {
        if (isGone(origin)) (phase === 'ready' && !isGone(r.review) ? r.review : r.nextTitle).focus();
        else origin.focus();
      }
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

  function maxSize() {
    const margin = parseCents(r.margin.input.value, { max: MAX_MARGIN_CENTS });
    const mark = state.oracle?.price_ticks;
    if (!margin.ok || !mark) return;
    const lots = Math.min(MAX_LOTS, Math.floor((MAX_LEVERAGE * margin.value) / mark));
    if (lots < MIN_LOTS) return;
    r.size.input.value = lotsToBtcString(lots);
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

  function openMarkTool() {
    r.tools.open = true;
    r.markField.input.focus();
  }

  function slotOccupied() { return Boolean(state.position || state.active); }

  function needsEscrow() {
    const a = state.balances.available;
    return Boolean(state.session) && !slotOccupied() && a != null && a < ESCROW_CENTS;
  }

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
      row('Entry at oracle mark', h('span', {}, `${formatTicks(q.markTicks)} `, unit('USD'))),
      row('Notional', h('span', {}, `${formatCents(q.notionalCents)} `, unit())),
      row('Leverage', formatLeverage(q.leverage), { tone: q.withinLeverage ? null : 'neg' }),
      row('Est. liquidation', h('span', {}, `${liq > 0 ? formatPriceUsd(liq * TICK_USD) : 'None'} `, liq > 0 ? unit('USD') : null), { tone: 'neg' }),
      row('Escrow locked', h('span', {}, `${formatCents(ESCROW_CENTS)} `, unit())),
      row('Unassigned escrow', h('span', {}, `${formatCents(q.unassignedEscrowCents)} `, unit())),
    ];
  }

  let quoteKey = null;
  function renderForm() {
    const { lots, margin, quote, blocker } = readForm();
    const locked = controlsLocked();
    const disabledAll = !state.session || slotOccupied();
    for (const el of [r.size.input, r.margin.input, r.sizeDown, r.sizeUp, r.sizeMax, ...r.levBtns]) el.disabled = disabledAll || locked;
    r.levBtns.forEach((b) => { b.disabled = b.disabled || !lots.ok || !state.oracle; });
    r.sizeMax.disabled = r.sizeMax.disabled || !state.oracle;

    const setErr = (f, res, isTouched) => {
      const msg = isTouched && !res.ok ? res.reason : '';
      setText(f.err, msg);
      f.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    setErr(r.size, lots, touched.size);
    setErr(r.margin, margin, touched.margin);
    setText(r.size.hint, lots.ok
      ? `${lots.value} lot${lots.value === 1 ? '' : 's'} · 0.001 BTC per lot · max ${lotsToBtcString(MAX_LOTS)}`
      : `0.001 BTC per lot · max ${lotsToBtcString(MAX_LOTS)} BTC`);

    setText(r.quoteRound, state.oracle ? `round ${state.oracle.round}` : '');
    const nextKey = quote ? JSON.stringify([quote.lots, quote.marginCents, quote.markTicks]) : `none:${Boolean(state.oracle)}`;
    if (quote) {
      const lev = quote.leverage;
      setText(r.levValue, formatLeverage(lev));
      r.levValue.classList.toggle('is-neg', !quote.withinLeverage);
      r.levFill.style.width = `${Math.min(100, (lev / MAX_LEVERAGE) * 100)}%`;
      r.levMeter.classList.toggle('is-over', !quote.withinLeverage);
      r.levMeter.setAttribute('aria-valuenow', lev.toFixed(2));
      r.levMeter.setAttribute('aria-valuetext', `${lev.toFixed(2)}x of ${MAX_LEVERAGE}x maximum`);
      if (nextKey !== quoteKey) r.quote.replaceChildren(...quoteRows(quote));
    } else {
      setText(r.levValue, '—');
      r.levValue.classList.remove('is-neg');
      r.levFill.style.width = '0%';
      r.levMeter.classList.remove('is-over');
      r.levMeter.removeAttribute('aria-valuenow');
      r.levMeter.setAttribute('aria-valuetext', 'Not available');
      if (nextKey !== quoteKey) {
        r.quote.replaceChildren(h('p', { class: 'xc-muted xc-small', text: state.oracle
          ? 'Enter size and margin to see the quote at the current oracle mark.'
          : 'The quote is computed at the market\'s live oracle mark once a session is loaded.' }));
      }
    }
    quoteKey = nextKey;
    r.review.disabled = Boolean(blocker) || locked;
    setText(r.review, pending === 'onRefreshQuote' ? 'Checking mark…'
      : pending === 'onOpen' || state.busy === 'Opening position' ? 'Opening…' : 'Review long');
    setText(r.blocker, blocker ?? '');
    // Blocker text is only useful once there is a session; before that the
    // next-action card explains the single step.
    r.blocker.hidden = !state.session;
  }

  async function reviewOpen() {
    const { blocker } = readForm();
    renderForm();
    if (blocker || controlsLocked()) {
      if (needsEscrow()) { r.transferBox.open = true; r.deposit.input.focus(); }
      else if (state.session && !slotOccupied()) (readForm().lots.ok ? r.margin.input : r.size.input).focus();
      return;
    }
    if (state.session?.live_market && has('onRefreshQuote') && !await run('onRefreshQuote')) return;
    const { lots, margin, blocker: updatedBlocker } = readForm();
    if (updatedBlocker || controlsLocked()) return;
    openDialog({
      title: 'Review long BTC-PERP',
      handler: 'onOpen',
      confirmLabel: 'Sign and open',
      ackMark: currentMark(),
      describe: () => `Opens a long of ${lotsToBtcString(lots.value)} BTC with ${formatCents(margin.value)} ${COLLATERAL} margin at the oracle mark of round ${state.oracle?.round ?? '—'}.`,
      // Called only when the acknowledged mark equals the live one, so the
      // reviewed quote is exactly what the dialog showed.
      args: () => [{
        sizeBtc: lotsToBtcString(lots.value), marginUsd: centsToString(margin.value),
        reviewedQuote: { priceTicks: dialogSpec.ackMark.priceTicks, fundingCents: dialogSpec.ackMark.fundingCents },
      }],
      build: () => {
        const f = readForm();
        const q = f.quote;
        const out = [];
        if (markStale(dialogSpec)) {
          out.push(h('p', { class: 'xc-notice', role: 'alert', text: `The mark moved to round ${state.oracle?.round}. Figures below use the new mark and funding index. Confirm again to proceed.` }));
        }
        if (q) {
          out.push(h('dl', { class: 'xc-rows xc-quote' },
            row('Side', 'Long'),
            row('Size', h('span', {}, `${lotsToBtcString(q.lots)} `, unit('BTC'), h('span', { class: 'xc-muted', text: ` · ${q.lots} lots` }))),
            row('Margin', h('span', {}, `${formatCents(q.marginCents)} `, unit())),
            row('Oracle round', String(state.oracle?.round ?? '—')),
            row('Funding index', h('span', {}, `${Number.isFinite(state.oracle?.funding_cents) ? formatCents(state.oracle.funding_cents) : '—'} `, unit())),
            ...quoteRows(q)));
        }
        out.push(h('p', { class: 'xc-small', text: 'This one confirmation authorizes your browser to sign and submit every transaction the open needs: it stages a private commitment, gets maker approval at this mark and keeper acknowledgments, builds the open proof, and submits the open. The quote expires if the mark changes before the open lands.' }));
        out.push(h('p', { class: 'xc-small xc-muted', text: `Liquidation happens if equity falls below 5% of notional at the oracle mark. The keeper bounty is ${formatCents(KEEPER_BOUNTY_CENTS)} ${COLLATERAL}. The maker sees size and entry; margin and the position blinder are not sent to the coordinator in plaintext; either designated keeper can decrypt the full opening.` }));
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
      describe: `${kind === 'deposit' ? 'Deposits' : 'Withdraws'} ${formatCents(res.value)} ${COLLATERAL} ${kind === 'deposit' ? 'from your wallet into the market' : 'from the market to your wallet'}.`,
      args: () => [amount],
      build: () => {
        const b = state.balances;
        const after = kind === 'deposit'
          ? [['Wallet after', b.wallet - res.value], ['Available after', b.available + res.value]]
          : [['Available after', b.available - res.value], ['Wallet after', b.wallet + res.value]];
        return {
          nodes: [
            h('dl', { class: 'xc-rows xc-quote' },
              row('Amount', h('span', {}, `${formatCents(res.value)} `, unit())),
              row('From → to', kind === 'deposit' ? 'Wallet → market' : 'Market → wallet'),
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
    for (const k of ['wallet', 'available', 'locked', 'maker']) setText(r.bal[k], live ? formatCents(b[k]) : '—');
    r.bal.available.classList.toggle('is-warn', live && b.available != null && b.available < ESCROW_CENTS && !slotOccupied());
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
      setText(f.err, msg);
      f.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      setText(f.go, pending === (kind === 'deposit' ? 'onDeposit' : 'onWithdraw') ? 'Signing…' : (kind === 'deposit' ? 'Deposit' : 'Withdraw'));
    }
    const short = live && b.available != null ? Math.max(0, ESCROW_CENTS - b.available) : 0;
    setText(r.deposit.hint, !live
      ? 'Balances load after Start session.'
      : needsEscrow()
        ? `Each position locks a fixed ${formatCents(ESCROW_CENTS)} ${COLLATERAL} escrow. Deposit at least ${formatCents(short)}.`
        : `Wallet → available market balance.`);
    setText(r.withdraw.hint, live && b.locked > 0 ? `${formatCents(b.locked)} ${COLLATERAL} is locked in escrow until the position settles.` : '');
    r.deposit.go.classList.toggle('xc-btn--act', needsEscrow());
    r.deposit.go.classList.toggle('xc-btn--ghost', !needsEscrow());
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

  function explorerLink(rc) {
    const url = safeHttpUrl(rc?.explorerUrl);
    return url ? h('a', { class: 'xc-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Explorer', 'aria-label': `Open ${rc.label ?? 'transaction'} in explorer (new tab)` }) : null;
  }

  function lastReceipt() {
    const list = state.receipts;
    return list.length ? list[list.length - 1] : null;
  }

  function renderPosition() {
    const p = positionView();
    const markUsd = state.oracle ? state.oracle.price_ticks * TICK_USD : null;
    setText(r.counts.position, p || state.active ? '1' : '');
    const noWitness = Boolean(state.session && !p && state.active);
    r.posNoWitness.hidden = !noWitness;
    r.posActions.hidden = !(state.session && (p || state.active));
    const rc = lastReceipt();
    const key = JSON.stringify([
      Boolean(state.session), p, state.active, markUsd, state.keeperArmed, rc?.hash, rc?.label, rc?.explorerUrl,
    ]);
    const focused = r.posBody.contains(document.activeElement);
    const inFresh = r.posFresh.contains(document.activeElement);
    const stale = r.posBody.classList.contains('is-stale');
    // Focus moved into the fresh view itself: hold it too until focus leaves.
    if (stale && inFresh) return;
    if (stale && !focused) {
      // Focus left the earlier details: flush them and show the fresh view in place.
      r.posBody.classList.remove('is-stale');
      r.posBody.removeAttribute('aria-hidden');
      r.posFresh.hidden = true;
      r.posStaleNote.hidden = true;
      r.posFresh.replaceChildren();
      keys.position = null;
    }
    if (key === keys.position) return;
    keys.position = key;
    // Rebuilding would drop focus from a Copy / Explorer control inside the
    // details, so render the update above them until focus leaves.
    const host = focused ? r.posFresh : r.posBody;
    if (focused) {
      r.posFresh.hidden = false;
      r.posStaleNote.hidden = false;
      r.posBody.classList.add('is-stale');
    }
    if (!state.session) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: options.spot
        ? 'Connect and unlock your wallet to see your positions.'
        : 'Not connected. Your position appears here after Start session.' }));
      return;
    }
    const evidence = rc ? row('Latest NEAR receipt', h('span', { class: 'xc-hash' },
      h('span', { class: 'xc-muted', text: `${rc.label ?? 'Transaction'} ` }),
      rc.hash ? h('code', { title: String(rc.hash), text: shortHash(rc.hash, 6, 4) }) : null,
      explorerLink(rc))) : null;
    if (noWitness) {
      host.replaceChildren(
        h('p', { class: 'xc-muted', text: `An active slot (nonce ${state.active.nonce ?? '—'}) exists on chain, but its private opening is not held in this browser, so size, margin and PnL cannot be shown.` }),
        h('dl', { class: 'xc-pos__grid' },
          row('Commitment', state.active.commitment ? hashValue(state.active.commitment, 'commitment') : '—'),
          row('Keeper B', state.keeperArmed ? 'Armed' : 'Not armed', { tone: state.keeperArmed ? 'pos' : null }),
          evidence));
      return;
    }
    if (!p) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'No open position. The order ticket opens one isolated long on this market.' }));
      return;
    }
    const lev = p.entryUsd && p.sizeBtc && p.marginUsd ? (p.entryUsd * p.sizeBtc) / p.marginUsd : null;
    const pnlTone = p.pnlUsd > 0 ? 'pos' : p.pnlUsd < 0 ? 'neg' : null;
    const pnlPct = p.marginUsd ? (p.pnlUsd / p.marginUsd) * 100 : null;
    const belowLiq = markUsd != null && p.liquidationUsd > 0 && markUsd < p.liquidationUsd;
    host.replaceChildren(
      h('div', { class: 'xc-pos__head' },
        h('span', { class: 'xc-side', text: 'Long' }),
        h('strong', { text: 'BTC-PERP' }),
        h('span', { class: 'xc-muted', text: `Isolated · nonce ${p.nonce ?? '—'}` }),
        belowLiq ? h('span', { class: 'xc-pill is-neg', text: 'Liquidatable at this mark' }) : null),
      h('dl', { class: 'xc-pos__grid' },
        row('Size', h('span', {}, `${formatBtc(p.sizeBtc)} `, unit('BTC'))),
        row('Entry', h('span', {}, `${formatPriceUsd(p.entryUsd)} `, unit('USD'))),
        row('Oracle mark', h('span', {}, `${formatPriceUsd(markUsd)} `, unit('USD'))),
        row('Liquidation', h('span', {}, `${formatPriceUsd(p.liquidationUsd)} `, unit('USD')), { tone: 'neg' }),
        row('Margin', h('span', {}, `${formatAmount(p.marginUsd)} `, unit())),
        row('Leverage', formatLeverage(lev)),
        row('Unrealized PnL', h('span', {},
          `${formatSigned(p.pnlUsd)} `, unit(),
          pnlPct != null ? h('span', { class: 'xc-muted', text: ` (${formatSigned(pnlPct)}%)` }) : null), { tone: pnlTone }),
        row('Escrow', h('span', {}, `${formatCents(ESCROW_CENTS)} `, unit())),
        row('Keeper B', state.keeperArmed ? 'Armed' : 'Not armed', { tone: state.keeperArmed ? 'pos' : null }),
        row('Commitment', p.commitment ? hashValue(p.commitment, 'commitment') : '—'),
        evidence));
  }

  function renderActionButtons() {
    const locked = controlsLocked();
    const p = state.position;
    const closing = pending === 'onClose' || state.busy === 'Closing position';
    const arming = pending === 'onArmKeeper' || state.busy === 'Arming Keeper B';
    for (const btn of [r.posClose, r.nextClose]) {
      btn.disabled = !p || locked || !has('onClose');
      setText(btn, closing ? 'Closing…' : 'Close position');
      if (!p && state.active) btn.setAttribute('aria-describedby', r.posNoWitness.id);
      else btn.removeAttribute('aria-describedby');
    }
    const armOff = !state.session || state.keeperArmed || !(state.active || state.position) || locked || !has('onArmKeeper');
    for (const btn of [r.posArm, r.nextArm, r.arm]) {
      btn.disabled = armOff;
      setText(btn, arming ? 'Arming…' : state.keeperArmed ? 'Keeper B armed' : 'Arm Keeper B');
    }
  }

  function requestClose() {
    if (!state.position || controlsLocked() || !has('onClose')) return;
    openDialog({
      title: 'Close position',
      handler: 'onClose',
      confirmLabel: 'Sign and close',
      describe: 'Closes the whole position at the latest oracle mark.',
      args: () => [],
      build: () => {
        const pv = positionView();
        const mark = state.oracle ? state.oracle.price_ticks * TICK_USD : null;
        return {
          nodes: [
            h('dl', { class: 'xc-rows xc-quote' },
              pv ? row('Size', h('span', {}, `${formatBtc(pv.sizeBtc)} `, unit('BTC'))) : null,
              row('Oracle mark', h('span', {}, `${formatPriceUsd(mark)} `, unit('USD'), h('span', { class: 'xc-muted', text: ` · R${state.oracle?.round ?? '—'}` }))),
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
  }

  function renderReceipts() {
    const host = r.tabPanels.receipts;
    const list = state.receipts;
    setText(r.counts.receipts, list.length ? String(list.length) : '');
    const traderId = state.network === 'testnet' ? state.session?.traderId : null;
    const items = list.map((rc) => JSON.stringify([rc.label, rc.hash, rc.explorerUrl]));
    const key = JSON.stringify([traderId, items]);
    if (key === keys.receipts) return;
    const receiptItem = (rc) => h('li', { class: 'xc-receipt' },
      h('span', { class: 'xc-receipt__label', text: rc.label ?? 'Transaction' }),
      rc.hash ? hashValue(rc.hash, `${rc.label ?? 'transaction'} hash`) : h('span', { class: 'xc-muted', text: '—' }),
      explorerLink(rc),
      traderId && rc.hash && rc.label?.toLowerCase() === 'open'
        ? h('a', { class: 'xc-link xc-receipt__inspect',
          href: '/positions?' + new URLSearchParams({ open: rc.hash, trader: traderId }), text: 'Inspect position' }) : null);
    if (host.contains(document.activeElement) && document.activeElement !== host) {
      // A Copy / Explorer control has focus. New receipts are appended to the
      // log, so add them at the top of the newest-first list without touching
      // the focused row; anything else waits for focusout.
      const prev = keys.receiptItems ?? [];
      const ol = host.querySelector('.xc-receipts');
      if (!ol || prev.length > items.length || prev.some((k, i) => k !== items[i])) return;
      for (const rc of list.slice(prev.length)) ol.prepend(receiptItem(rc));
    } else if (!list.length) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'No transactions yet. Each signed NEAR transaction is listed here with its hash and an explorer link.' }));
    } else {
      host.replaceChildren(h('ol', { class: 'xc-receipts', reversed: true }, [...list].reverse().map(receiptItem)));
    }
    keys.receipts = key;
    keys.receiptItems = items;
  }

  function renderRounds() {
    const host = r.tabPanels.rounds;
    const hist = state.markHistory;
    setText(r.counts.rounds, hist.length ? String(hist.length) : '');
    const key = JSON.stringify(hist.map((p) => [p.round, p.price_ticks]));
    if (key === keys.rounds) return;
    keys.rounds = key;
    if (!hist.length) {
      host.replaceChildren(h('p', { class: 'xc-empty', text: 'No oracle rounds recorded in this browser yet.' }));
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
    setText(r.markGo, pending === 'onSetMark' ? 'Publishing…' : 'Publish mark');
    const msg = touched.mark && !m.ok ? m.reason : '';
    setText(r.markField.err, msg);
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
    setText(r.markEffect, effect);
    r.markEffect.className = `xc-small ${tone}`;

    const armed = state.keeperArmed;
    setText(r.keeperState, armed ? 'Armed' : 'Idle');
    r.keeperState.className = `xc-pill ${armed ? 'is-pos' : ''}`;
    setText(r.keeperNote, armed
      ? 'Keeper B is watching the active slot and will submit a liquidation proof if the mark crosses liquidation.'
      : state.active || state.position
        ? 'Arm Keeper B so it watches this slot and liquidates with a proof when equity drops below maintenance.'
        : 'Available once a position is open.');
    setText(r.toolsSummaryNote, `Oracle mark · Keeper B ${armed ? 'armed' : 'idle'}`);
  }

  function renderHeader() {
    const o = state.oracle;
    setText(r.mark, o ? formatTicks(o.price_ticks) : '—');
    setText(r.round, o ? String(o.round) : '—');
    setText(r.funding, o && Number.isFinite(o.funding_cents) ? formatCents(o.funding_cents) : '—');
    const hist = state.markHistory;
    if (hist.length >= 2) {
      const d = (hist[hist.length - 1].price_ticks - hist[0].price_ticks) * TICK_USD;
      setText(r.change, `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toLocaleString('en-US')}`);
    } else setText(r.change, '—');
    const net = state.network;
    setText(r.netText, net === 'testnet' ? 'NEAR testnet' : net === 'sandbox' ? 'NEAR sandbox' : 'NEAR testnet · not connected');
    r.network.className = `xc-tag xc-net ${net ? `is-${net}` : 'is-off'}`;
    const s = state.session;
    const marketExplorerHref = s?.marketId && net === 'testnet' ? '/positions?market=' + encodeURIComponent(s.marketId) : '/positions';
    if (r.positionExplorer.getAttribute('href') !== marketExplorerHref) r.positionExplorer.href = marketExplorerHref;
    r.who.hidden = !s;
    if (s) {
      setText(r.sessionId, s.traderId ?? 'session');
      r.sessionId.title = `Trader ${s.traderId ?? '—'}\nMarket ${s.marketId ?? '—'}\nToken ${s.tokenId ?? '—'}`;
      const c = CUSTODY[s.custody];
      setText(r.custody, c ? c.short : '');
      r.custody.title = c ? c.long : '';
      r.custody.classList.toggle('is-warn', s.custody === 'origin-storage');
    }
  }

  function renderStatus() {
    const working = state.busy || (pending ? 'Waiting for confirmation…' : null);
    r.status.classList.toggle('is-busy', Boolean(working));
    setText(r.statusText, working
      ?? (state.session ? (state.oracle ? `Ready · oracle round ${state.oracle.round}` : 'Connected · waiting for oracle') : 'Not connected'));
    setText(r.proof, state.proofStatus ? `Proof: ${state.proofStatus}` : '');
    r.proof.hidden = !state.proofStatus;
    setText(r.notice, state.notice ?? '');
    r.notice.hidden = !state.notice;
    const err = state.error || localError;
    r.alert.hidden = !err;
    setText(r.alertText, err ?? '');
    r.alertDismiss.hidden = !localError || Boolean(state.error);
    root.setAttribute('aria-busy', working ? 'true' : 'false');
  }

  function computePhase() {
    if (!state.session) return 'cold';
    if (state.position) return 'position';
    if (state.active) return 'active';
    if (!state.oracle || state.balances.available == null) return 'wait';
    if (needsEscrow()) return 'fund';
    return 'ready';
  }

  function renderNext() {
    const next = computePhase();
    const b = state.balances;
    const working = state.busy || (pending ? 'Waiting for confirmation…' : null);
    let title = '';
    let body = '';
    switch (next) {
      case 'cold':
        title = state.busy === 'Restoring session' ? 'Checking for a saved session'
          : state.busy === 'Recovering session' ? 'Recovering your session'
          : pending === 'onStart' || state.busy === 'Starting session' ? 'Setting up your session'
            : cold?.title ?? 'Start a session to trade';
        body = cold?.body ?? `Trade an isolated BTC long on a NEAR testnet market, margined in mock ${COLLATERAL} with no cash value. One click sets up a trader account for this browser. Deposits, opens and closes show a review before you sign.`;
        break;
      case 'wait':
        title = 'Loading market';
        body = 'Waiting for the oracle mark and your balances from NEAR.';
        break;
      case 'fund':
        title = `Deposit ${formatCents(ESCROW_CENTS)} ${COLLATERAL} escrow`;
        body = `Every position locks a fixed ${formatCents(ESCROW_CENTS)} ${COLLATERAL} escrow from your available balance. Available: ${formatCents(b.available)} · wallet: ${formatCents(b.wallet)}. Use Deposit below.`;
        break;
      case 'ready':
        title = 'Ready · review your long';
        body = `${formatCents(b.available)} ${COLLATERAL} available. Set size and margin, then review the quote before signing.`;
        break;
      case 'position': {
        const p = positionView();
        title = 'Position open';
        body = `Long ${formatBtc(p?.sizeBtc)} BTC from ${formatPriceUsd(p?.entryUsd)} USD · est. liquidation ${formatPriceUsd(p?.liquidationUsd)} USD. Keeper B ${state.keeperArmed ? (state.session?.live_market ? 'is armed for new NEAR marks.' : 'is armed: publish a test mark below liquidation to see it act.') : 'is not armed.'}`;
        break;
      }
      case 'active':
        title = 'Active slot without its opening';
        body = 'This browser does not hold the private opening for the slot on chain, so it cannot close it. Details are under Positions.';
        break;
      default:
    }
    setText(r.nextTitle, title);
    const workingText = working ? `${working.replace(/…$/, '')}…${state.proofStatus ? ` Proof: ${state.proofStatus}` : ''}` : null;
    setText(r.nextBody, workingText ?? body);
    r.next.classList.toggle('is-busy', Boolean(working));
    r.ticket.dataset.phase = next;

    // Progress reflects observed state only.
    const done = {
      session: Boolean(state.session),
      escrow: Boolean(state.session) && (slotOccupied() || (b.available != null && b.available >= ESCROW_CENTS)),
      open: slotOccupied(),
    };
    const current = !done.session ? 'session' : !done.escrow ? 'escrow' : !done.open ? 'open' : null;
    for (const [k] of stepDefs) {
      const li = r.steps[k];
      li.classList.toggle('is-done', done[k]);
      li.classList.toggle('is-current', current === k);
      if (current === k) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      setText(li.lastChild, done[k] ? ' (done)' : current === k ? ' (current)' : '');
    }

    r.startBtn.hidden = options.hideStart || next !== 'cold';
    r.startNote.hidden = next !== 'cold';
    // The private wallet link stays visible in every state, including for a
    // browser already connected here: it opens a separate route and leaves
    // this session untouched.
    r.startBtn.disabled = controlsLocked() || !has('onStart');
    setText(r.startBtn, state.busy === 'Recovering session' ? 'Recovering…'
      : pending === 'onStart' || state.busy === 'Starting session' ? 'Starting…' : (cold?.button ?? 'Start session'));
    r.nextClose.hidden = next !== 'position';
    r.nextArm.hidden = !(next === 'position' || next === 'active') || state.keeperArmed;
    r.nextMark.hidden = !(next === 'position' || next === 'active') || !state.keeperArmed || !has('onSetMark');
    r.nextMark.disabled = controlsLocked();
    r.nextActions.hidden = r.startBtn.hidden && r.nextClose.hidden && r.nextArm.hidden && r.nextMark.hidden;
    orderTicket(next);

    const rc = (next === 'position' || next === 'active' || next === 'ready' || next === 'fund') ? lastReceipt() : null;
    const url = safeHttpUrl(rc?.explorerUrl);
    r.nextEvidence.hidden = !rc;
    if (rc) {
      setText(r.nextLinkLabel, `Last NEAR receipt: ${rc.label ?? 'transaction'} · ${shortHash(rc.hash, 6, 4)}`);
      r.nextLink.hidden = !url;
      if (url && r.nextLink.getAttribute('href') !== url) r.nextLink.href = url;
      r.nextLink.setAttribute('aria-label', `Open ${rc.label ?? 'transaction'} in explorer (new tab)`);
    }

    // Open the collateral section's deposit path when escrow is short; only on
    // the transition, so a user's own toggling is never overridden by polling.
    if (next !== phase) {
      if (next === 'fund' && !touched.deposit && !r.deposit.input.value && b.available != null && b.wallet != null) {
        const need = Math.min(ESCROW_CENTS - b.available, b.wallet);
        if (need > 0) r.deposit.input.value = centsToString(need);
      }
      if (next === 'fund') r.transferBox.open = true;
      else if (phase === 'fund') {
        // Escrow is covered: fold transfers behind the balance row and, if the
        // deposit just made had focus, land it on the ready action.
        const hadFocus = r.transferBox.contains(document.activeElement);
        r.transferBox.open = false;
        // After this render pass, so Review long's enabled state is current.
        if (hadFocus) later(() => (next === 'ready' && !r.review.disabled ? r.review : r.nextTitle).focus());
      }
      phase = next;
    }
  }

  // Cold: only the start step. Funding: Deposit leads. Otherwise the order
  // (or the open position's actions) leads and collateral is a compact row.
  function orderTicket(next) {
    r.fund.hidden = next === 'cold';
    r.form.hidden = next === 'cold' || next === 'position' || next === 'active';
    r.tools.hidden = next === 'cold';
    const want = next === 'fund' || next === 'wait'
      ? [r.next, r.fund, r.form, r.tools]
      : [r.next, r.form, r.fund, r.tools];
    const kids = [...r.ticket.children];
    if (want.every((el, i) => kids[i] === el)) return;
    const active = document.activeElement;
    r.ticket.append(...want);
    if (active && active !== document.activeElement && root.contains(active)) active.focus({ preventScroll: true });
  }

  function renderChart() {
    if (options.spot) return;
    const p = positionView();
    const hist = state.markHistory;
    r.chartCard.classList.toggle('is-empty', hist.length === 0);
    chart.update({
      history: hist,
      entryTicks: p && Number.isFinite(p.entryUsd) ? p.entryUsd / TICK_USD : null,
      liqTicks: p && Number.isFinite(p.liquidationUsd) && p.liquidationUsd > 0 ? p.liquidationUsd / TICK_USD : null,
      emptyText: state.session
        ? 'No oracle rounds recorded in this browser yet. Rounds appear as the market contract publishes them.'
        : 'Oracle marks load after Start session. This chart plots only rounds published to the market contract; there is no external price feed.',
    });
    if (hist.length >= 2) {
      const d = (hist[hist.length - 1].price_ticks - hist[0].price_ticks) * TICK_USD;
      setText(r.chartMeta, `${hist.length} rounds · ${d >= 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} USD`);
    } else setText(r.chartMeta, hist.length ? '1 round' : '');
  }

  // ---------- dialog lifecycle ----------
  let returnFocus = null;
  function currentMark() {
    const o = state.oracle;
    return o ? { round: o.round, priceTicks: o.price_ticks, fundingCents: o.funding_cents } : null;
  }
  // A reviewed open is stale when the round, price or funding index moved.
  function markStale(spec) {
    if (!spec || spec.ackMark === undefined) return false;
    const a = spec.ackMark, b = currentMark();
    if (!a || !b) return a !== b;
    return a.round !== b.round || a.priceTicks !== b.priceTicks || a.fundingCents !== b.fundingCents;
  }
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
    setText(r.dlgTitle, dialogSpec.title);
    const desc = typeof dialogSpec.describe === 'function' ? dialogSpec.describe() : dialogSpec.describe;
    setText(r.dlgDesc, desc ?? '');
    r.dlgDesc.hidden = !desc;
    if (desc) r.dialog.setAttribute('aria-describedby', r.dlgDesc.id);
    else r.dialog.removeAttribute('aria-describedby');
    const { nodes, blocked } = dialogSpec.build();
    // replaceChildren stringifies null, so drop empty slots explicitly.
    r.dlgBody.replaceChildren(...[...nodes, blocked ? h('p', { class: 'xc-blocker', text: blocked }) : null].filter(Boolean));
    const stale = markStale(dialogSpec);
    setText(r.dlgConfirm, stale ? `Confirm at round ${state.oracle?.round}` : dialogSpec.confirmLabel);
    r.dlgConfirm.className = `xc-btn ${dialogSpec.handler === 'onClose' ? 'xc-btn--risk' : 'xc-btn--act'}`;
    r.dlgConfirm.disabled = Boolean(blocked) || controlsLocked() || !has(dialogSpec.handler);
  }

  function render() {
    renderHeader();
    renderStatus();
    renderChart();
    renderNext();
    renderForm();
    renderAccount();
    renderPosition();
    renderActionButtons();
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
