// Private wallet route (?wallet=burner): a built-in NEAR testnet burner that
// unlocks a private trading wallet, then the unchanged trading workspace.
//
// Custody rules held by this module:
// - The burner's secret material is never rendered, logged, put in a URL or
//   kept in a string longer than one download. The only path out is the
//   backup file the user explicitly downloads.
// - Nothing unlocks without an explicit click on the sign button. A reload, a
//   back/forward cache restore or Lock returns to this landing; there is no
//   automatic resume here.
// - Backups are bound to this site's origin, passed explicitly to every
//   export, import, request and unlock.
// - An imported wallet only ever recovers (onStart({ recoverOnly: true })); it
//   never provisions a new trader. A new wallet uses the plain onStart().
// - One wallet unlock and one exchange controller per page. While an action is
//   pending every control that could start another one is disabled.

import { shortHash } from './format.js';

/**
 * A backup is a small ASCII JSON document; anything larger is not one. Matches
 * MAX_BACKUP_LENGTH (1024) in protocol/burner-wallet.js, which rejects longer text.
 */
export const MAX_BACKUP_BYTES = 1024;
const NETWORK_LABEL = 'NEAR testnet';
const IMPORT_FAILED = 'That file is not a usable burner backup for this site. A backup only works on the site that made it; choose the JSON file you downloaded here.';

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

function setText(el, text) {
  const t = text ?? '';
  if (el.textContent !== t) el.textContent = t;
}

const row = (label, value) => h('div', { class: 'xc-row' }, h('dt', { text: label }), h('dd', {}, value));

/** Short, user-facing text for a failure that never echoes file contents. */
function failure(err, fallback) {
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  if (!msg) return fallback;
  return msg.length > 240 ? `${msg.slice(0, 239)}…` : msg;
}

function backupFileName(accountId) {
  const tag = String(accountId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'wallet';
  return `xythum-testnet-burner-${tag}.json`;
}

/**
 * Requests a download of the origin-bound wallet backup. The JSON lives only
 * in a Blob for the duration of the click; it is never attached to the
 * document. The browser may still block or cancel the download, so callers
 * report only that it was requested.
 */
function downloadBackup(wallet, origin) {
  const name = backupFileName(wallet.accountId);
  const blob = new Blob([wallet.exportBackup(origin)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return name;
}

/** Accessible confirm dialog on the native <dialog>. Resolves true on confirm. */
function createConfirm(host) {
  const id = `bwd${++uid}`;
  const title = h('h2', { id: `${id}-t`, class: 'xc-dialog__title' });
  const desc = h('p', { id: `${id}-d`, class: 'xc-small' });
  const cancel = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Cancel' });
  const confirm = h('button', { type: 'button', class: 'xc-btn xc-btn--risk' });
  const dialog = h('dialog', { class: 'xc-dialog', 'aria-labelledby': title.id, 'aria-describedby': desc.id },
    title, desc, h('div', { class: 'xc-dialog__actions' }, cancel, confirm));
  host.append(dialog);
  let settle = null;
  // mountExchange clears the root, so the workspace re-attaches this dialog.
  const attach = (to) => { if (dialog.parentNode !== to) to.append(dialog); };
  const done = (value) => {
    const fn = settle;
    settle = null;
    if (dialog.open) dialog.close();
    fn?.(value);
  };
  cancel.addEventListener('click', () => done(false));
  confirm.addEventListener('click', () => done(true));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
  const ask = (spec) => new Promise((resolve) => {
    if (settle || !dialog.isConnected) { resolve(false); return; }
    const back = document.activeElement;
    settle = (v) => { resolve(v); if (back?.isConnected && typeof back.focus === 'function') back.focus(); };
    setText(title, spec.title);
    setText(desc, spec.body);
    setText(confirm, spec.confirm);
    dialog.showModal();
    cancel.focus();
  });
  return { ask, attach };
}

function topBar(...extra) {
  return h('header', { class: 'xc-top' },
    h('div', { class: 'xc-brand' },
      h('span', { class: 'xc-brand__x', 'aria-hidden': 'true' }),
      h('span', { class: 'xc-brand__name' }, 'Xythum', h('span', { class: 'xc-brand__sub', text: ' Perps' }))),
    h('div', { class: 'xc-top__ctx' },
      h('span', { class: 'xc-tag xc-net is-testnet' }, h('span', { class: 'xc-dot', 'aria-hidden': 'true' }), NETWORK_LABEL),
      h('span', { class: 'xc-tag' }, h('strong', { text: 'Private wallet' })),
      ...extra));
}

/**
 * Starts the private wallet route.
 *
 * burner: { createBurnerWallet, importBurnerWallet, burnerSignRequest, unlockBurnerStore }
 * createExchange / mountExchange: the same factories the default route uses.
 */
export function startBurnerRoute(root, {
  burner, createExchange, mountExchange, allowSandbox = false,
  origin = globalThis.location?.origin ?? '', homeHref = './', routeHref = '?wallet=burner',
} = {}) {
  if (!root) throw new Error('startBurnerRoute: root element required');
  const id = `bw${++uid}`;
  const s = {
    wallet: null, mode: null, backedUp: false, backupName: '',
    request: null, requestError: null, busy: null, error: null, notice: null,
  };
  let generation = 0;
  let unlocked = null;
  let opened = false;
  let lockRef = null;

  // Leaving with a fresh, un-backed-up burner would lose it for good.
  const guardUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
  let guarded = false;
  function syncUnloadGuard() {
    const want = Boolean(s.wallet && s.mode === 'new' && !s.backedUp);
    if (want === guarded) return;
    guarded = want;
    if (want) window.addEventListener('beforeunload', guardUnload);
    else window.removeEventListener('beforeunload', guardUnload);
  }

  root.classList.add('xc');
  root.replaceChildren();
  const r = {};

  // ---------- choose: create or recover ----------
  r.create = h('button', { type: 'button', class: 'xc-btn xc-btn--act xc-btn--block', text: 'Create burner wallet', onclick: () => create() });
  r.file = h('input', {
    type: 'file', id: `${id}-file`, class: 'xc-bw__file', accept: '.json,application/json',
    'aria-describedby': `${id}-file-hint`,
  });
  r.fileLabel = h('label', { for: r.file.id, class: 'xc-btn xc-btn--ghost xc-btn--block xc-bw__file-label', text: 'Recover from a backup file' });
  r.file.addEventListener('change', () => importFile());
  r.choose = h('div', { class: 'xc-bw__choose' },
    r.create,
    h('p', { class: 'xc-bw__or', 'aria-hidden': 'true', text: 'or' }),
    r.file, r.fileLabel,
    h('p', { class: 'xc-field__hint', id: `${id}-file-hint`, text: `The JSON file (up to ${MAX_BACKUP_BYTES / 1024} KB) downloaded from this same site. It is read in this browser only.` }),
    h('details', { class: 'xc-disclose' },
      h('summary', { text: 'What a private wallet is' }),
      h('ul', { class: 'xc-list' },
        h('li', { text: 'A burner is a NEAR testnet implicit account created in this browser.' }),
        h('li', { text: 'Signing happens locally and sends nothing on chain. It opens a private trading wallet: a separate trader, not your burner address.' }),
        h('li', { text: 'The coordinator then provisions that trader on testnet, or reattaches it when you recover.' }),
        h('li', { text: 'A backup recovers the same wallet only on this same site (origin), in any browser.' }),
        h('li', { text: 'A position opening stays in the browser that made it. Keep that browser to close an active position voluntarily.' }))));

  // ---------- wallet: authorization summary and sign first, backup second ----------
  r.account = h('code', { class: 'xc-bw__mono' });
  r.reqOrigin = h('span', { class: 'xc-bw__mono' });
  r.reqRecipient = h('span', { class: 'xc-bw__mono' });
  r.reqRecipientRow = row('Recipient', r.reqRecipient);
  r.reqMessage = h('pre', { class: 'xc-bw__msg', tabindex: '0', 'aria-label': 'Full signed text' });
  r.reqWait = h('p', { class: 'xc-muted xc-small' });
  r.reqFull = h('details', { class: 'xc-disclose' },
    h('summary', { text: 'Show the full signed text' }),
    r.reqMessage);
  r.sign = h('button', { type: 'button', class: 'xc-btn xc-btn--act xc-btn--block', onclick: () => sign(), 'aria-describedby': `${id}-sign-note` });
  r.signNote = h('p', { class: 'xc-small xc-muted', id: `${id}-sign-note` });
  r.signSec = h('section', { class: 'xc-bw__sign', 'aria-labelledby': `${id}-sg-h` },
    h('h2', { class: 'xc-bw__h', id: `${id}-sg-h`, text: 'You are signing' }),
    h('dl', { class: 'xc-rows xc-bw__ids' },
      row('Site', r.reqOrigin),
      row('Network', NETWORK_LABEL),
      row('Burner', r.account),
      r.reqRecipientRow),
    r.reqWait, r.reqFull, r.sign, r.signNote);

  r.backupBtn = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost xc-btn--block', text: 'Download backup file', onclick: () => backup() });
  r.backupState = h('p', { class: 'xc-small', 'aria-live': 'polite' });
  r.backup = h('section', { class: 'xc-bw__sec', 'aria-labelledby': `${id}-bk-h` },
    h('h2', { class: 'xc-bw__h', id: `${id}-bk-h`, text: 'Backup (optional)' }),
    r.backupState,
    r.backupBtn,
    h('p', { class: 'xc-small xc-muted', text: 'Anyone with the file controls this demo wallet. It works only on this site and is never shown or sent to the server.' }));
  r.discard = h('button', { type: 'button', class: 'xc-link', text: 'Use a different wallet', onclick: () => discard() });
  r.walletView = h('div', { class: 'xc-bw__wallet' },
    r.signSec, r.backup,
    h('p', { class: 'xc-bw__alt' }, r.discard));

  // ---------- shared: heading, status, alert ----------
  r.title = h('h1', { class: 'xc-bw__title', id: `${id}-h`, tabindex: '-1' });
  r.lead = h('p', { class: 'xc-bw__lead' });
  r.status = h('p', { class: 'xc-bw__status', role: 'status', 'aria-live': 'polite' });
  r.alertText = h('span');
  r.alertRetry = h('button', { type: 'button', class: 'xc-link', text: 'Try again', onclick: () => fetchRequest() });
  r.alert = h('div', { class: 'xc-alert', role: 'alert', hidden: true }, r.alertText, r.alertRetry);
  r.card = h('section', { class: 'xc-card xc-bw__card', 'aria-labelledby': r.title.id },
    h('p', { class: 'xc-label', text: 'Private wallet · built-in testnet burner' }),
    r.title, r.lead, r.alert, r.choose, r.walletView, r.status);

  // The landing nodes are kept so a failed workspace mount can restore them.
  const landing = [
    topBar(),
    h('main', { class: 'xc-bw' },
      r.card,
      h('p', { class: 'xc-bw__back' }, h('a', { class: 'xc-link', href: homeHref, text: 'Back to Start session' }),
        h('span', { class: 'xc-muted xc-small', text: ' · the original browser session, unchanged' }))),
    h('footer', { class: 'xc-foot' },
      h('p', { text: 'mUSDC is mock collateral on a NEAR test network with no cash value. The burner is a demo wallet for this testnet market only.' })),
  ];
  root.append(...landing);
  const confirmDialog = createConfirm(root);
  const { ask } = confirmDialog;

  // A back/forward cache restore would resurrect in-memory keys without a new
  // signature, so it re-locks to a fresh landing instead.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && (opened || s.wallet)) lock();
  });

  // ---------- behaviour ----------
  function render() {
    const has = Boolean(s.wallet);
    const busy = Boolean(s.busy);
    r.choose.hidden = has;
    r.walletView.hidden = !has;
    root.setAttribute('aria-busy', busy ? 'true' : 'false');

    if (!has) {
      setText(r.title, 'Trade from a private wallet');
      setText(r.lead, 'Create a NEAR testnet burner, or recover one from a backup made on this site, then sign one readable request locally.');
    } else if (s.mode === 'new') {
      setText(r.title, 'New burner wallet');
      setText(r.lead, 'Sign locally to open this burner\'s private trading wallet.');
    } else {
      setText(r.title, 'Burner wallet recovered');
      setText(r.lead, 'Sign locally to reopen this burner\'s private trading wallet.');
    }

    r.create.disabled = busy;
    setText(r.create, s.busy === 'create' ? 'Creating…' : 'Create burner wallet');
    r.file.disabled = busy;
    r.fileLabel.classList.toggle('is-disabled', busy);
    r.fileLabel.setAttribute('aria-disabled', busy ? 'true' : 'false');
    setText(r.fileLabel, s.busy === 'import' ? 'Reading backup…' : 'Recover from a backup file');

    if (has) {
      setText(r.account, s.wallet.accountId);
      const isNew = s.mode === 'new';
      r.backup.hidden = !isNew;
      r.backupBtn.disabled = busy;
      setText(r.backupBtn, s.backedUp ? 'Download backup again' : 'Download backup file');
      // The page cannot see whether the browser saved the file, only that the
      // download was requested.
      setText(r.backupState, s.backedUp
        ? `Download requested (${s.backupName}). Check that it saved and keep it private.`
        : 'Without a backup, this burner is lost for good when you leave this page.');
      r.backupState.className = `xc-small ${s.backedUp ? 'is-pos' : 'is-warn'}`;

      const req = s.request;
      setText(r.reqOrigin, origin);
      r.reqRecipientRow.hidden = !req;
      r.reqFull.hidden = !req;
      r.reqWait.hidden = Boolean(req);
      setText(r.reqWait, s.busy === 'request' ? 'Preparing the request…' : s.requestError ? 'The request could not be prepared.' : '');
      if (req) {
        setText(r.reqRecipient, String(req.recipient ?? ''));
        setText(r.reqMessage, String(req.message ?? ''));
      }
      const label = isNew ? 'Sign and open private wallet' : 'Sign and recover private wallet';
      r.sign.disabled = busy || !req || opened;
      setText(r.sign, s.busy === 'sign' ? 'Signing…' : label);
      setText(r.signNote, isNew
        ? 'Local signature, no transaction. The coordinator then provisions this wallet\'s testnet trader.'
        : 'Local signature, no transaction. The coordinator then reattaches the existing testnet trader; it never creates one.');
      r.discard.disabled = busy;
    }

    const err = s.error ?? s.requestError;
    r.alert.hidden = !err;
    setText(r.alertText, err ?? '');
    r.alertRetry.hidden = !s.requestError || Boolean(s.error) || busy;
    setText(r.status, s.busy === 'sign' ? 'Waiting for the private wallet to open…'
      : s.busy === 'create' ? 'Creating a burner wallet…'
        : s.busy === 'import' ? 'Reading the backup file…'
          : s.notice ?? '');
    syncUnloadGuard();
  }

  function setWallet(wallet, mode) {
    generation += 1;
    unlocked = null;
    Object.assign(s, { wallet, mode, backedUp: false, backupName: '', request: null, requestError: null, error: null });
    render();
    r.title.focus();
    fetchRequest();
  }

  async function fetchRequest() {
    if (!s.wallet || s.busy) return;
    const gen = generation;
    s.busy = 'request';
    s.requestError = null;
    render();
    try {
      const req = await burner.burnerSignRequest(s.wallet, origin);
      if (gen !== generation) return;
      if (!req || typeof req.message !== 'string' || !req.message) throw new Error('The sign request is empty.');
      s.request = { message: req.message, recipient: req.recipient };
    } catch (err) {
      if (gen !== generation) return;
      s.requestError = `Could not prepare the sign request: ${failure(err, 'unknown error')}`;
    } finally {
      if (gen === generation) { s.busy = null; render(); }
    }
  }

  async function create() {
    if (s.busy || s.wallet) return;
    s.busy = 'create';
    s.error = null;
    render();
    let wallet = null;
    try {
      wallet = await burner.createBurnerWallet();
      if (!wallet?.accountId) throw new Error('The new burner has no account id.');
    } catch (err) {
      s.error = `Could not create a burner wallet: ${failure(err, 'unknown error')}`;
      wallet = null;
    }
    s.busy = null;
    if (wallet) setWallet(wallet, 'new');
    else { render(); r.create.focus(); }
  }

  async function importFile() {
    const file = r.file.files?.[0];
    // Clear the picker right away so the selection is not retained.
    r.file.value = '';
    if (!file || s.busy || s.wallet) return;
    s.error = null;
    if (file.size === 0 || file.size > MAX_BACKUP_BYTES) {
      s.error = file.size === 0 ? 'That file is empty.' : `That file is larger than ${MAX_BACKUP_BYTES / 1024} KB, so it is not a burner backup.`;
      render();
      r.file.focus();
      return;
    }
    s.busy = 'import';
    render();
    let wallet = null;
    try {
      const text = await file.text();
      wallet = await burner.importBurnerWallet(text, origin);
      if (!wallet?.accountId) wallet = null;
    } catch {
      wallet = null;
    }
    s.busy = null;
    if (wallet) setWallet(wallet, 'import');
    else { s.error = IMPORT_FAILED; render(); r.file.focus(); }
  }

  /** Requests the backup download. Returns null, or the error text to show. */
  function backup() {
    if (!s.wallet || s.busy) return null;
    let error = null;
    try {
      s.backupName = downloadBackup(s.wallet, origin);
      // "Requested", not "saved": the browser may still block the download.
      s.backedUp = true;
    } catch (err) {
      error = `Could not request the backup download: ${failure(err, 'unknown error')}`;
    }
    s.error = error;
    render();
    return error;
  }

  async function discard() {
    if (s.busy || !s.wallet) return;
    if (s.mode === 'new' && !s.backedUp) {
      const ok = await ask({
        title: 'Discard this burner?',
        body: 'No backup download was requested, so it cannot be recovered once discarded.',
        confirm: 'Discard burner',
      });
      if (!ok || s.busy) return;
    }
    generation += 1;
    unlocked = null;
    Object.assign(s, { wallet: null, mode: null, backedUp: false, backupName: '', request: null, requestError: null, error: null, busy: null });
    render();
    r.title.focus();
  }

  async function sign() {
    if (s.busy || opened || !s.wallet || !s.request) return;
    const gen = generation;
    const wallet = s.wallet;
    s.busy = 'sign';
    s.error = null;
    render();
    try {
      const result = unlocked ?? await burner.unlockBurnerStore(wallet, origin);
      if (gen !== generation) return;
      if (!result?.store) throw new Error('the private wallet store did not open');
      if (result.ownerAccountId && result.ownerAccountId !== wallet.accountId) {
        throw new Error('the private wallet belongs to a different burner account, so it was not opened');
      }
      unlocked = result;
    } catch (err) {
      if (gen !== generation) return;
      s.busy = null;
      s.error = `Signing did not open the private wallet: ${failure(err, 'unknown error')}. You can try again.`;
      render();
      r.sign.focus();
      return;
    }
    s.busy = null;
    try {
      openWorkspace(wallet, unlocked);
    } catch (err) {
      // openWorkspace restored the landing; the unlocked store is reused on retry.
      s.error = `The trading workspace did not load: ${failure(err, 'unknown error')}. You can try again.`;
      render();
      r.sign.focus();
    }
  }

  // ---------- trading workspace ----------
  function openWorkspace(wallet, { store, ownerAccountId, traderPublicKey }) {
    if (opened) return;
    opened = true;
    const mode = s.mode;
    const recovering = mode === 'import';
    let view = null;
    const queued = [];
    const banner = createBanner({
      wallet, ownerAccountId: ownerAccountId ?? wallet.accountId, traderPublicKey, homeHref,
      backedUp: () => mode !== 'new' || s.backedUp,
      onBackup: () => backup(),
      onLock: () => lock(),
    });
    const onState = (state) => {
      if (!view) { queued.push(state); return; }
      view.update(state);
      banner.update(state);
    };
    let exchange;
    try {
      exchange = createExchange({ store, onState, allowSandbox });
    } catch (err) {
      // No controller exists yet, so a retry cannot duplicate one.
      opened = false;
      throw err;
    }
    const { controller } = exchange;
    // An imported wallet only reattaches its existing trader, on first launch
    // and on every Retry; a new wallet provisions with the plain onStart().
    const start = recovering ? () => controller.onStart({ recoverOnly: true }) : () => controller.onStart();
    const handlers = { ...exchange.handlers, onStart: start };
    try {
      view = mountExchange(root, handlers, {
        banner: banner.el,
        cold: recovering ? {
          title: 'Private session not recovered',
          body: 'Your local signature reopened the private wallet, but its testnet trader is not reattached yet. Retry recovers the same trader; it never creates one.',
          button: 'Retry recovery',
          noteSummary: 'What recovery does',
          note: [
            'Proves the private trader key to the coordinator, which reattaches the testnet trader already provisioned for it on this site.',
            'If this wallet was never started on this site, recovery fails and nothing is created.',
            'The page then checks the market config and the key on chain before showing balances.',
          ],
        } : {
          title: 'Private session not started',
          body: 'Your local signature opened the private wallet, but its testnet trader is not provisioned yet. Retry uses the same private wallet; it never creates a second one.',
          button: 'Retry private session',
          noteSummary: 'What this step does',
          note: [
            'Proves the private trader key to the coordinator, which provisions its NEAR testnet trader account with mock mUSDC.',
            'The page then checks the market config and the key on chain before showing balances.',
            'It never creates a new burner or a second private wallet.',
          ],
        },
      });
      // mountExchange cleared the root; keep the confirm dialog usable here.
      confirmDialog.attach(root);
    } catch (err) {
      // Make the mount retryable: drop this controller and restore the landing.
      try { controller.stop(); } catch { /* already stopped */ }
      view = null;
      opened = false;
      root.classList.add('xc');
      root.replaceChildren(...landing);
      confirmDialog.attach(root);
      throw err;
    }
    lockRef = () => controller.stop();
    const first = queued.pop() ?? controller.snapshot();
    queued.length = 0;
    view.update(first);
    banner.update(first);
    banner.focus();
    // The explicit signature above is the user's Start session for this wallet.
    Promise.resolve(start()).catch(() => {});
  }

  function lock() {
    lockRef?.();
    window.removeEventListener('beforeunload', guardUnload);
    guarded = false;
    // A fresh load drops every in-memory key, store handle and timer.
    globalThis.location.replace(routeHref);
  }

  // ---------- banner shown above the workspace ----------
  function createBanner({ wallet, ownerAccountId, traderPublicKey, homeHref: home, backedUp, onBackup, onLock }) {
    const bid = `${id}-bar`;
    const burnerId = h('code', { class: 'xc-bw__mono', title: ownerAccountId, text: shortHash(ownerAccountId, 10, 6) });
    const trader = h('code', { class: 'xc-bw__mono' });
    const traderKey = h('code', { class: 'xc-bw__mono', title: traderPublicKey ?? '', text: traderPublicKey ? shortHash(traderPublicKey, 14, 6) : '—' });
    const warn = h('p', { class: 'xc-notice', role: 'alert', hidden: true });
    const backupBtn = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost' });
    const lockBtn = h('button', { type: 'button', class: 'xc-btn xc-btn--ghost', text: 'Lock private wallet', 'aria-describedby': `${bid}-lock` });
    const lockNote = h('span', { class: 'xc-sr', id: `${bid}-lock` });
    const title = h('h2', { class: 'xc-bw-bar__title', id: `${bid}-h`, tabindex: '-1', text: 'Private wallet' });
    // Backup outcome, visible in the banner itself: an error, or only that the
    // download was requested (the page cannot confirm the file was saved).
    const backupMsg = h('p', { class: 'xc-small xc-bw-bar__backup', 'aria-live': 'polite', hidden: true });
    let busy = false;
    backupBtn.addEventListener('click', () => {
      const error = onBackup();
      backupMsg.hidden = false;
      backupMsg.setAttribute('role', error ? 'alert' : 'status');
      backupMsg.className = `xc-small xc-bw-bar__backup ${error ? 'is-neg' : 'is-pos'}`;
      setText(backupMsg, error ?? 'Download requested.');
      paint();
    });
    lockBtn.addEventListener('click', async () => {
      if (busy || lockBtn.disabled) return;
      if (!backedUp()) {
        const ok = await ask({
          title: 'Lock without a backup?',
          body: 'No backup download was requested for this burner. After locking, it and its private trading wallet cannot be reopened.',
          confirm: 'Lock anyway',
        });
        if (!ok || busy) return;
      }
      onLock();
    });
    const el = h('section', { class: 'xc-bw-bar', 'aria-labelledby': title.id },
      h('div', { class: 'xc-bw-bar__head' },
        title,
        h('span', { class: 'xc-pill', text: 'Built-in testnet burner' }),
        h('span', { class: 'xc-pill', text: 'Demo collateral' })),
      h('dl', { class: 'xc-bw-bar__ids' },
        h('div', {}, h('dt', { class: 'xc-label', text: 'Burner wallet' }), h('dd', {}, burnerId)),
        h('div', {}, h('dt', { class: 'xc-label', text: 'Private trader' }), h('dd', {}, trader)),
        h('div', {}, h('dt', { class: 'xc-label', text: 'Trader key' }), h('dd', {}, traderKey))),
      h('div', { class: 'xc-bw-bar__actions' },
        backupBtn, lockBtn, lockNote,
        h('a', { class: 'xc-link', href: home, text: 'Back to Start session' })),
      backupMsg,
      h('p', { class: 'xc-small xc-muted xc-bw-bar__note', text: 'The backup controls this demo wallet and recovers it only on this site, in any browser. A position opening stays local: keep this browser to close an active position voluntarily.' }),
      warn);
    function paint(state) {
      if (state) busy = Boolean(state.busy);
      const ok = backedUp();
      backupBtn.className = `xc-btn ${ok ? 'xc-btn--ghost' : 'xc-btn--act'}`;
      setText(backupBtn, ok ? 'Download backup' : 'Download backup (not requested yet)');
      lockBtn.disabled = busy;
      setText(lockNote, busy ? 'Available when the current action finishes.' : '');
    }
    return {
      el,
      focus: () => title.focus(),
      update(state) {
        const sess = state?.session;
        setText(trader, sess?.traderId ? shortHash(sess.traderId, 12, 6) : state?.busy ? 'Opening…' : 'Not started');
        trader.title = sess?.traderId ?? '';
        const mismatch = sess?.publicKey && traderPublicKey && sess.publicKey !== traderPublicKey;
        warn.hidden = !mismatch;
        setText(warn, mismatch ? 'The session key does not match the private trader key from your signature. Lock and sign again before trading.' : '');
        paint(state);
      },
    };
  }

  render();
  r.create.focus({ preventScroll: true });
  return { lock };
}
