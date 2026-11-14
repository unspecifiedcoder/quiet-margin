import { inspectPosition } from '../protocol/position-explorer.js';
import { formatCents, formatPriceUsd, TICK_USD } from './format.js';

const connectedTrader = 'trader-1589da8d996a.qm-treasury-a280bef3.testnet';
const recordedLong = {
  open: '4m1Zutu6RmJsabJmpYe9Qz93xRjbeLNmUqpcx172zeG5',
  trader: connectedTrader,
  settlement: 'GUVF8KhHzcL8Tsnbkqge7DVJ7YS6X4jQ7HW2D43y2kHc',
  settler: connectedTrader,
};

function el(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children);
  return element;
}

function link(text, href) {
  const element = el('a', 'xc-link', text);
  element.href = href;
  return element;
}

function field(name, label, limit) {
  const input = el('input', 'pe-input');
  input.name = name;
  input.maxLength = limit;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return { input, label: el('label', 'pe-field', el('span', '', label), input) };
}

const code = (value) => el('code', '', String(value));
const chain = 'https://testnet.near.rocks';
const txLink = (hash) => link(hash, chain + '/tx/' + hash);
const blockLink = (hash, number) => link(number ? 'Block ' + number.toLocaleString('en-US') : 'Execution block', chain + '/block/' + hash);
const mark = (ticks) => ticks == null ? 'Awaiting an oracle mark' : '$' + formatPriceUsd(ticks * TICK_USD);
const collateral = (cents) => formatCents(cents) + ' mUSDC';

function row(label, value) {
  return el('div', 'pe-row', el('dt', '', label), el('dd', '', value));
}

function positionView(record) {
  const { position, settlement, open } = record;
  const heading = open ? 'Recorded position #' + position.nonce
    : position ? 'Active position #' + position.nonce : 'No active position';
  const details = el('dl', 'pe-rows',
    row('Market account', link(record.market, 'https://' + record.market + '.near.rocks')),
    row('Trading account', code(record.trader)),
    row('State as of', blockLink(record.blockHash, record.block)),
    row('NEAR oracle mark', mark(record.mark) + (record.round ? ' · round ' + record.round : '')));
  if (position) details.append(
    row('Opening mark', mark(position.openMark)),
    row('Public escrow', collateral(position.escrow)),
    row('Position commitment', code(position.commitment)),
    row('Keeper witnesses', position.envelopes + ' encrypted envelopes'),
    row('Exact size and margin', 'Committed and encrypted at open'),
  );
  if (open) details.append(row('Open transaction', txLink(open.hash)));
  const result = el('article', 'xc-card pe-card', el('h2', '', heading), details);
  if (open && !settlement) {
    result.append(el('p', 'xc-muted pe-note', 'This snapshot proves the position opened. Add its settlement transaction to check the outcome.'));
  }
  if (settlement) {
    const evidence = el('dl', 'pe-rows',
      row('Transaction', txLink(settlement.hash)), row('Signer', code(settlement.signer)),
      row('Oracle round', String(settlement.round)));
    if (settlement.reason) evidence.append(row('Rejection reason', code(settlement.reason)));
    else evidence.append(
      row('Public refund', collateral(settlement.refund)), row('Bad debt', collateral(settlement.badDebt)),
      row('Execution block', blockLink(settlement.blockHash)));
    result.append(el('h3', 'pe-subtitle', settlement.status), evidence);
  }
  return result;
}

export function mountPositionExplorer(root, params) {
  document.title = 'Position Explorer · Quiet Margin';
  root.classList.add('xc');
  const market = field('market', 'Market account', 64);
  const open = field('open', 'Open transaction hash', 44);
  const signer = field('trader', 'Transaction signer', 64);
  const settle = field('settlement', 'Close or liquidation hash', 44);
  const settler = field('settler', 'Settlement signer', 64);
  const mode = el('select', 'pe-input', new Option('Market account', 'market'), new Option('Open transaction', 'open'));
  const marketFields = el('div', 'pe-fields', market.label);
  const txFields = el('div', 'pe-fields', open.label, signer.label);
  const settlementFields = el('details', 'pe-optional',
    el('summary', '', 'Check a close or liquidation'), el('div', 'pe-fields', settle.label, settler.label));
  const submit = el('button', 'xc-btn xc-btn--act', 'Look up position');
  const form = el('form', 'pe-form',
    el('label', 'pe-field', el('span', '', 'Search by'), mode),
    marketFields, txFields, settlementFields, submit);
  const status = el('p', 'pe-status xc-muted');
  status.setAttribute('role', 'status');
  const results = el('div', 'pe-result');

  for (const { input } of [market, open, signer, settle, settler]) {
    input.value = (params.get(input.name) ?? '').slice(0, input.maxLength);
  }
  mode.value = open.input.value ? 'open' : 'market';
  settlementFields.open = Boolean(settle.input.value);
  const sync = () => {
    marketFields.hidden = mode.value !== 'market';
    txFields.hidden = settlementFields.hidden = mode.value !== 'open';
  };
  mode.addEventListener('change', sync);
  sync();

  const sampleLinks = [
    link('Recorded BTC long', '/positions?' + new URLSearchParams(recordedLong)),
    link('Keeper B liquidation receipt', chain + '/tx/7BzALdUFVXpJUwckBTvZnw9es7Eu1XAfrYMp7ZatMLV'),
    link('Healthy liquidation rejection receipt', chain + '/tx/8FsX9uhupmkZyLGimggiFmYat1Va975uKsGQJTswNPod'),
  ];
  const header = el('header', 'xc-top pe-top', el('span', 'xc-brand', 'Quiet Margin'),
    el('span', 'xc-tag', 'NEAR testnet'), link('Trading terminal', '/'));
  const main = el('main', 'pe-main',
    el('h1', '', 'Position Explorer'),
    el('p', 'xc-muted pe-intro', 'Inspect public NEAR state and receipts for a Quiet Margin position. No wallet needed.'),
    form, el('nav', 'pe-examples', ...sampleLinks), status, results,
    el('p', 'xc-muted pe-note', 'The opening mark and escrow are public. In the trading terminal, entry follows the opening mark. Settlement amounts may reveal more about the position.'));
  root.replaceChildren(header, main);

  async function search() {
    if (submit.disabled) return;
    const value = (input) => input.value.trim();
    const marketMode = mode.value === 'market';
    const query = marketMode ? { market: value(market.input) } : {
      open: value(open.input), trader: value(signer.input), settlement: value(settle.input), settler: value(settler.input),
    };
    const url = new URL(location.href);
    url.search = new URLSearchParams(Object.entries(query).filter(([, input]) => input));
    history.replaceState(null, '', url);
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Reading NEAR testnet…';
    results.replaceChildren();
    try {
      const record = await inspectPosition(marketMode ? query : {
        open: { hash: query.open, signer: query.trader },
        settlement: query.settlement || query.settler ? { hash: query.settlement, signer: query.settler } : undefined,
      });
      results.append(positionView(record));
      status.textContent = 'Finalized NEAR data loaded.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      form.removeAttribute('aria-busy');
      submit.disabled = false;
    }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); search(); });
  if (market.input.value || open.input.value) search();
}
