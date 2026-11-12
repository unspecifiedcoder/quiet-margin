// Renders the static evidence replay from receipts.json, the same public
// manifest checked by scripts/verify-demo-receipts.mjs. Nothing here signs,
// submits, or queries chain state.

const data = await fetch('receipts.json').then((response) => {
  if (!response.ok) throw new Error('receipts.json returned HTTP ' + response.status);
  return response.json();
}).catch((error) => {
  document.getElementById('step-panel').textContent =
    'Could not load receipts.json (' + error.message + '). Start the page with: node scripts/serve-demo.mjs';
  throw error;
});

const { units, accounts, market, network } = data;
const tx = Object.fromEntries(data.transactions.map((entry) => [entry.id, entry]));
const round = (n) => data.oracle_rounds.find((r) => r.round === n);
const fixture = data.synthetic_fixture;

// ---------------------------------------------------------------- formatting

const usd = (ticks) => '$' + (ticks * units.tick_usd).toLocaleString('en-US');
const musdc = (cents) => (cents < 0 ? '−' : '') + (Math.abs(cents) / units.cents_per_musdc)
  .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' mUSDC';
const btc = (lots) => (lots * units.lot_btc).toFixed(3) + ' BTC';
const ROLE_NAMES = {
  demo: 'Demo parent', market: 'Clearing contract', token: 'Mock USDC', trader: 'Trader', maker: 'Maker',
  oracle: 'Test oracle', keeper_a: 'Keeper A', keeper_b: 'Keeper B',
};
const role = (accountId) => ROLE_NAMES[Object.keys(accounts).find((key) => accounts[key] === accountId)]
  ?? 'testnet account creator';

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value === undefined) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

const label = (kind, text) => h('p', { class: 'label label-' + kind }, h('strong', {}, kind === 'synthetic' ? 'Synthetic' : 'Replay'), ' · ' + text);
const rows = (pairs) => h('dl', { class: 'kv' }, pairs.map(([key, value]) => [h('dt', {}, key), h('dd', {}, value)]));
const verdict = (ok, yes, no) => h('strong', { class: ok ? 'ok' : 'bad' }, ok ? yes : no);

// ----------------------------------------------- reference model arithmetic
// Formulas from docs/FUNDED-MARKET.md, applied to the synthetic fixture.

function position(price, funding) {
  const { size_lots: lots, entry_ticks: entry, margin_cents: margin } = fixture;
  const pnl = (price - entry) * lots;
  const equity = margin - funding + pnl;
  return {
    pnl, equity,
    maintenance: (price * lots) / 20,
    liquidatable: 20 * equity < price * lots,
    settle(bounty) {
      const capped = margin - funding + Math.min(pnl, units.pnl_cap_cents);
      const refund = units.escrow_cents - margin + Math.max(capped - bounty, 0);
      return { refund, bad_debt: Math.max(-equity, 0), vault_delta: units.escrow_cents - refund - bounty };
    },
  };
}

// --------------------------------------------------------- evidence blocks

function evidence(id) {
  const entry = tx[id];
  const { expect } = entry;
  const ok = expect.status === 'success';
  const args = Object.entries(expect.args ?? {}).map(([key, value]) => key + ': ' + JSON.stringify(value)).join(', ');
  const events = (expect.events ?? []).map((event) => event.event + ' ' + JSON.stringify(event.data));
  return h('article', { class: 'tx' },
    h('header', {},
      h('h4', {}, entry.title),
      verdict(ok, 'ACCEPTED', 'REJECTED')),
    rows([
      ['Transaction', h('a', { class: 'hash', href: network.explorer_tx + entry.hash, target: '_blank', rel: 'noopener noreferrer' },
        entry.hash, h('span', { class: 'sr' }, ' (opens NearBlocks testnet explorer)'))],
      ['Signer', h('span', {}, h('code', {}, entry.signer), ' · ' + role(entry.signer))],
      ['Call', h('code', {}, `${expect.method}(${args})`)],
      expect.oracle && ['Oracle used', `round ${expect.oracle.round} · ${usd(expect.oracle.price_ticks)} · funding index ${expect.oracle.funding_cents} cents`],
      ok ? ['Receipt log', events.length ? h('code', {}, events.join('\n')) : '—']
        : ['Failure', h('code', { class: 'bad' }, 'Smart contract panicked: ' + expect.error)],
    ].filter(Boolean)));
}

// ------------------------------------------------------------------ steps

const checkpoint = round(3).funding_cents; // nonce 2 opened at oracle round 3
const steps = [
  {
    tab: 'Open at ' + usd(round(3).price_ticks),
    title: 'Private open',
    synthetic() {
      const p = position(round(3).price_ticks, 0);
      const notional = fixture.entry_ticks * fixture.size_lots;
      return rows([
        ['Size', `${fixture.size_lots} lots · ${btc(fixture.size_lots)}`],
        ['Entry', usd(fixture.entry_ticks)],
        ['Margin', musdc(fixture.margin_cents)],
        ['Unassigned escrow', musdc(units.escrow_cents - fixture.margin_cents)],
        ['Funding checkpoint', checkpoint + ' cents'],
        ['Leverage rule', h('span', {}, `entry × lots ${notional.toLocaleString('en-US')} ≤ ${units.max_leverage} × margin ${(units.max_leverage * fixture.margin_cents).toLocaleString('en-US')} `,
          verdict(notional <= units.max_leverage * fixture.margin_cents, 'holds', 'violated'))],
        ['Health at open', h('span', {}, `equity ${musdc(p.equity)} vs maintenance ${musdc(p.maintenance)} `, verdict(!p.liquidatable, 'healthy', 'unhealthy'))],
        ['Position blinder', 'random 32 bytes, never public in plaintext (only inside the keeper envelopes)'],
      ]);
    },
    public: ['liquidation_open'],
    note: 'The chain sees a salted commitment, a salted quote digest the maker approved, two 144-byte keeper envelopes, '
      + 'and the fixed 600 mUSDC escrow with a 601 mUSDC maker reserve. The open proof shows the hidden terms satisfy '
      + 'the leverage rule and are healthy at the authenticated $100,000 mark. After this, the runner removed the '
      + 'trader and Keeper A keys from its in-memory signer, so later steps could not sign as them. The testnet run '
      + 'operated both keepers.',
  },
  {
    tab: 'Healthy at ' + usd(round(4).price_ticks),
    title: 'Liquidation refused while healthy',
    synthetic() {
      const r = round(4);
      const p = position(r.price_ticks, r.funding_cents - checkpoint);
      return rows([
        ['Mark', usd(r.price_ticks) + ' · round ' + r.round],
        ['Funding owed', musdc(r.funding_cents - checkpoint)],
        ['PnL', musdc(p.pnl)],
        ['Equity', musdc(p.equity)],
        ['Maintenance 5%', musdc(p.maintenance)],
        ['Liquidation allowed', verdict(!p.liquidatable, 'no · healthy', 'yes')],
      ]);
    },
    public: ['healthy_refused'],
    note: 'No valid liquidation proof exists for a healthy position, so Keeper B submitted a proof built for $52,000 '
      + 'at the current round 4. The contract builds the proof statement from its own oracle state ($70,000), so the '
      + 'NEP-488 pairing check fails with ERR_PROOF_INVALID. The runner confirmed the ledger and active slot were unchanged.',
  },
  {
    tab: 'Keeper B at ' + usd(round(5).price_ticks),
    title: 'Cold Keeper B liquidates',
    synthetic() {
      const r = round(5);
      const p = position(r.price_ticks, r.funding_cents - checkpoint);
      const s = p.settle(units.bounty_cents);
      const publicRefund = tx.keeper_b_liquidation.expect.args.refund;
      return rows([
        ['Mark', usd(r.price_ticks) + ' · round ' + r.round],
        ['Funding owed', musdc(r.funding_cents - checkpoint)],
        ['PnL', musdc(p.pnl)],
        ['Equity', musdc(p.equity)],
        ['Maintenance 5%', musdc(p.maintenance)],
        ['Liquidation allowed', verdict(p.liquidatable, 'yes · below maintenance', 'no')],
        ['Refund to trader', h('span', {}, musdc(s.refund) + ' (unassigned escrow + equity after bounty) ',
          verdict(s.refund === publicRefund, 'matches public refund', 'differs from public refund'))],
        ['Keeper bounty', musdc(units.bounty_cents)],
        ['Maker vault change', musdc(s.vault_delta)],
        ['Bad debt', musdc(s.bad_debt)],
      ]);
    },
    public: ['keeper_b_liquidation'],
    note: 'Keeper B started in a fresh process with only its own keys, read its envelope from get_active, decrypted the '
      + 'opening, proved the position is below maintenance at the contract\'s round 5, and signed the liquidation. '
      + 'The slot cleared in the same receipt that credited the refund, the bounty, and the maker vault.',
  },
  {
    tab: 'Settlement',
    title: 'Replay refused, bounty paid, ledger reconciled',
    synthetic() {
      const ledger = tx.keeper_payout.expect.ledger_after;
      return rows([
        ['Trader claim', musdc(ledger.trader_available) + ' · waiting for the offline trader to withdraw'],
        ['Maker vault', musdc(ledger.maker_vault)],
        ['Keeper claims', musdc(ledger.keeper_available[0] + ledger.keeper_available[1]) + ' after payout'],
        ['Locked / reserved', musdc(ledger.trader_locked + ledger.maker_reserved)],
        ['Bad debt', musdc(ledger.bad_debt)],
        ['Market token balance', musdc(Number(tx.keeper_payout.expect.market_token_balance_after))],
        ['Reconciles', verdict(ledger.trader_available + ledger.maker_vault + ledger.keeper_available[0] + ledger.keeper_available[1]
          === Number(tx.keeper_payout.expect.market_token_balance_after), 'claims = token balance', 'mismatch')],
      ]);
    },
    syntheticLabel: 'Public ledger at the payout block, read by the verifier. Not synthetic.',
    public: ['replay_refused', 'keeper_payout'],
    note: 'Resubmitting the accepted liquidation fails with ERR_NO_ACTIVE because the slot is gone, and the ledger does '
      + 'not move. Keeper B then withdraws its 1 mUSDC bounty through NEP-141. Across both positions the market keeps '
      + '1,401 mUSDC: the 117 mUSDC trader claim plus the 1,284 mUSDC maker vault.',
  },
];

const stepList = document.getElementById('steps');
const panel = document.getElementById('step-panel');
const tabs = steps.map((step, index) => h('button', {
  type: 'button', role: 'tab', id: 'step-tab-' + index, 'aria-controls': 'step-panel',
}, h('span', { class: 'num', 'aria-hidden': 'true' }, String(index + 1)), step.tab));
stepList.append(...tabs);
let current = 0;

function show(index, focus) {
  current = Math.max(0, Math.min(steps.length - 1, index));
  const step = steps[current];
  tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === current));
    tab.tabIndex = i === current ? 0 : -1;
    tab.classList.toggle('done', i < current);
  });
  if (focus) tabs[current].focus();
  panel.setAttribute('aria-labelledby', tabs[current].id);
  document.getElementById('step-count').textContent = `Step ${current + 1} of ${steps.length}: ${step.title}`;
  document.getElementById('prev').disabled = current === 0;
  document.getElementById('next').disabled = current === steps.length - 1;
  history.replaceState(null, '', '#step-' + (current + 1));
  panel.replaceChildren(
    h('h3', {}, step.title),
    h('div', { class: 'split' },
      h('div', { class: 'col col-synthetic' },
        step.syntheticLabel ? label('replay', step.syntheticLabel)
          : label('synthetic', 'trader fixture from tests/actor.mjs, derived with the docs/FUNDED-MARKET.md formulas'),
        step.synthetic()),
      h('div', { class: 'col col-public' },
        label('replay', 'recorded public testnet transaction'),
        step.public.map(evidence))),
    h('p', { class: 'note' }, step.note));
}

stepList.addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) show(tabs.indexOf(tab), false);
});
stepList.addEventListener('keydown', (event) => {
  const moves = { ArrowRight: current + 1, ArrowDown: current + 1, ArrowLeft: current - 1, ArrowUp: current - 1, Home: 0, End: steps.length - 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  show(moves[event.key], true);
});
document.getElementById('prev').addEventListener('click', () => show(current - 1, false));
document.getElementById('next').addEventListener('click', () => show(current + 1, false));
// #step-1 … #step-4 deep-link to a step, for example when recording.
show(Number(/^#step-(\d)$/.exec(location.hash)?.[1] ?? 1) - 1, false);

// -------------------------------------------------------------- inference

function inference() {
  const close = tx.profit_close.expect;
  const open = round(1);
  const mark = round(close.oracle.round);
  const funding = mark.funding_cents - open.funding_cents;
  const gross = close.args.refund - units.escrow_cents + funding;
  // Close refund = escrow − margin + max(margin − funding + min(PnL, cap), 0).
  // A refund ≥ escrow rules out the zero branch, so margin cancels; gross below
  // the cap means PnL was not clipped. Both are checked from public values.
  const positive = close.args.refund >= units.escrow_cents;
  const uncapped = gross < units.pnl_cap_cents;
  const band = Math.floor(open.price_ticks * units.maker_band_percent / 100);
  // Search every size and every entry the demo maker's 1% band would approve.
  const candidates = [];
  for (let lots = 1; positive && uncapped && lots <= units.max_lots; lots += 1) {
    for (let entry = open.price_ticks - band; entry <= open.price_ticks + band; entry += 1) {
      if ((mark.price_ticks - entry) * lots === gross) candidates.push({ lots, entry });
    }
  }
  const searched = units.max_lots * (2 * band + 1);
  const unique = candidates.length === 1;
  const found = candidates[0];

  return h('div', { class: 'split' },
    h('div', { class: 'col' },
      label('replay', 'derived only from public data'),
      h('ol', { class: 'derivation' },
        h('li', {}, 'Public refund in the close call and position_closed log: ', h('strong', {}, musdc(close.args.refund))),
        h('li', {}, 'Minus the fixed escrow every open locks: ', musdc(units.escrow_cents)),
        h('li', {}, 'Plus funding owed, from public oracle rounds 1 → 2: ', musdc(funding)),
        h('li', {}, `Refund ≥ escrow, so equity was positive and margin cancels out of the refund: `,
          verdict(positive, 'holds', 'does not hold')),
        h('li', {}, 'Gross PnL: ', h('strong', {}, musdc(gross)), `, below the ${musdc(units.pnl_cap_cents)} PnL cap, so it was not clipped: `,
          verdict(uncapped, 'holds', 'does not hold')),
        h('li', {}, `Public opening mark ${usd(open.price_ticks)}, close mark ${usd(mark.price_ticks)}. Assuming the maker followed its off-chain policy `
          + `(not enforced by the contract), it approved only entries within ${units.maker_band_percent}% `
          + `(${usd(open.price_ticks - band)}–${usd(open.price_ticks + band)}) and sizes 1–${units.max_lots} lots of ${units.lot_btc} BTC.`),
        h('li', {}, `Solve (close − entry) × lots = gross over all ${searched.toLocaleString('en-US')} candidates: `,
          h('strong', { class: 'warn' }, `${candidates.length} match${unique ? '' : 'es'}`),
          unique ? ` → ${found.lots} lots = ${btc(found.lots)} at ${usd(found.entry)}.` : '.')),
      unique && h('p', { class: 'note' },
        'Under these conditions, size and entry are uniquely recoverable after this profitable close. Margin stays hidden; the open-time '
        + 'leverage rule and the maximum margin only bound it to ',
        `${musdc(Math.ceil(found.entry * found.lots / units.max_leverage))}–${musdc(units.max_margin_cents)}. `
        + 'This is the documented inference limit of a singleton market (docs/SPEC.md, Public trace and evidence).')),
    h('div', { class: 'col col-public' },
      label('replay', 'recorded public testnet transactions'),
      ['profit_open', 'profit_close', 'trader_payout'].map(evidence)));
}
document.getElementById('inference-body').append(inference());

// ------------------------------------------------------------- deployment

document.getElementById('deployment-body').append(h('div', { class: 'split' },
  h('div', { class: 'col' },
    label('replay', 'public account state checked by the verifier'),
    rows([
      ['Clearing contract', h('code', {}, market.account)],
      ['Wasm SHA-256', h('code', { class: 'hash' }, market.code_sha256)],
      ['Market domain', h('code', { class: 'hash' }, market.domain_b64)],
      ['Deployment ID', h('code', { class: 'hash' }, market.deployment_id_b64)],
      ['Open VK SHA-256', h('code', { class: 'hash' }, market.vk_sha256_b64.open)],
      ['Close VK SHA-256', h('code', { class: 'hash' }, market.vk_sha256_b64.close)],
      ['Liquidation VK SHA-256', h('code', { class: 'hash' }, market.vk_sha256_b64.liquidation)],
      ['Collateral', h('span', {}, h('code', {}, market.token.account), ` · ${market.token.symbol}, ${market.token.decimals} decimals, mock`)],
      ['Mock token Wasm SHA-256', h('code', { class: 'hash' }, market.token.code_sha256)],
    ])),
  h('div', { class: 'col col-public' },
    label('replay', 'recorded public testnet transactions'),
    ['market_deploy', 'token_deploy'].map(evidence))));

// ----------------------------------------------------------------- ledger

document.getElementById('ledger-body').append(h('table', {},
  h('thead', {}, h('tr', {}, ['Step', 'Outcome', 'Signer', 'Transaction'].map((text) => h('th', { scope: 'col' }, text)))),
  h('tbody', {}, data.transactions.map((entry) => h('tr', {},
    h('th', { scope: 'row' }, entry.title),
    h('td', {}, verdict(entry.expect.status === 'success', 'ACCEPTED', 'REJECTED · ' + entry.expect.error)),
    h('td', {}, h('code', {}, entry.signer)),
    h('td', {}, h('a', { class: 'hash', href: network.explorer_tx + entry.hash, target: '_blank', rel: 'noopener noreferrer' }, entry.hash)))))));

document.getElementById('footer').append(
  h('p', {}, `Source: ${data.source.record} at commit ${data.source.commit.slice(0, 7)}. Explorer links open NearBlocks testnet. `
    + 'Assets are synthetic mock USDC on a test-controlled oracle; nothing here has monetary value.'));
