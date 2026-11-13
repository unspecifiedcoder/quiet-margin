import { PoolClient, poseidonPool } from '../protocol/shielded-pool.js';
import { unlockConnectedTrader, verifyWalletSignature } from '../protocol/connected-wallet.js';
import { isAccountId } from '../protocol/api.js';
import { btcToLots, usdToCents } from '../protocol/model.js';
import { toBase64 } from '../protocol/bytes.js';
import { poolFundingAuthorization } from '../protocol/wallet-messages.js';
import { createSpotChart } from './spot-chart.js';
import './shielded.css';

const money = (cents) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const el = (id) => document.getElementById('sp-' + id);
const hasSides = (version) => ['poseidon-v2', 'poseidon-v3'].includes(version);
const explorer = 'https://testnet.near.rocks';

function localProof(kind, fingerprint, witness, version) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../protocol/shielded-prover.worker.js', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => finish(new Error('Local proving timed out. Try again on a desktop browser.')), 12 * 60_000);
    function finish(error, proof) {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error); else resolve(proof);
    }
    worker.onmessage = ({ data }) => {
      if (data.stage) el('status').textContent = data.stage + ' in your browser…';
      else if (data.proof) finish(null, data.proof);
      else finish(new Error(data.error));
    };
    worker.onerror = () => finish(new Error('The browser ran out of memory or could not start the prover.'));
    worker.postMessage({ kind, fingerprint, witness, version });
  });
}

async function helperProof(kind, fingerprint, witness) {
  el('status').textContent = 'Generating proof with the local desktop helper…';
  const response = await fetch('/api/proving/local-pool', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, fingerprint, witness }), signal: AbortSignal.timeout(12 * 60_000),
  });
  const result = await response.json();
  if (!response.ok || typeof result.proof !== 'string') throw new Error(result.message || 'The local proof helper failed.');
  return result.proof;
}

function receipt(list, label, hash) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = explorer + '/tx/' + encodeURIComponent(hash);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = 'xc-link';
  a.textContent = hash.slice(0, 10) + '…' + hash.slice(-6);
  li.append(label, a);
  list.prepend(li);
}

export async function mountShieldedPool(root) {
  root.classList.add('xc');
  root.innerHTML = `
    <header class="xc-top">
      <a class="xc-brand xc-link" href="/"><span class="xc-brand__mark" aria-hidden="true"></span>Quiet Margin</a>
      <nav class="sp-nav" aria-label="Exchange">
        <a class="xc-link" href="/">Exchange</a><a class="xc-link" href="/positions">Position Explorer</a>
        <span class="xc-tag">NEAR testnet</span>
      </nav>
    </header>
    <main class="sp-main">
      <div class="sp-title"><div><h1>Shielded Pool</h1><p class="xc-muted">Deposit from NEAR. Trade BTC with private collateral.</p></div>
        <button class="xc-btn xc-btn--act" id="sp-connect" disabled>Connect Wallet</button>
      </div>
      <p class="sp-status" role="status" id="sp-status">Loading pool…</p>
      <section class="sp-panel sp-chart" aria-labelledby="sp-chart-title">
        <div class="sp-chart-head"><div><h2 id="sp-chart-title">BTC / USDT spot</h2><p id="sp-spot-meta" class="xc-small xc-muted"></p></div>
          <strong id="sp-spot-price" class="xc-fig xc-fig--lg">—</strong></div>
        <div id="sp-chart" class="xc-chart-host"></div>
      </section>
      <div class="sp-grid" id="sp-desk" hidden>
        <section class="sp-panel" aria-labelledby="sp-funding">
          <h2 id="sp-funding">Collateral</h2>
          <dl class="sp-stats">
            <div><dt>Public wallet</dt><dd><strong id="sp-wallet">—</strong> <small>mUSDC</small></dd></div>
            <div><dt>Shielded balance</dt><dd class="is-pos"><strong id="sp-balance">—</strong> <small>mUSDC</small></dd></div>
          </dl>
          <button id="sp-fund" class="xc-btn xc-btn--act" type="button" hidden>Claim test funds</button>
          <form id="sp-deposit">
            <label>Deposit amount <input class="sp-input" name="amount" type="text" inputmode="decimal" required placeholder="0.00" autocomplete="off"></label>
            <button class="xc-btn xc-btn--act">Deposit to pool</button>
          </form>
          <p id="sp-note-count" class="xc-muted xc-small"></p>
          <details>
            <summary>Send to a public address or back up notes</summary>
            <p class="xc-small xc-muted">Leave funds in your shielded balance to trade again. A standard token withdrawal shows its amount and destination on NEAR.</p>
            <form id="sp-exit">
              <label>Public NEAR recipient <input class="sp-input" name="recipient" type="text" required autocomplete="off"></label>
              <label>Amount <input class="sp-input" name="amount" type="text" inputmode="decimal" required placeholder="0.00" autocomplete="off"></label>
              <button class="xc-btn xc-btn--ghost">Withdraw to NEAR</button>
            </form>
            <p class="xc-small xc-muted">Keep an encrypted backup after each change to recover your notes on another browser.</p>
            <div class="sp-tools"><button id="sp-export" class="xc-btn xc-btn--ghost" type="button">Export backup</button>
            <label class="xc-small">Restore backup<input id="sp-import" type="file" accept="application/json,.json"></label></div>
          </details>
        </section>
        <section class="sp-panel" aria-labelledby="sp-position">
          <h2 id="sp-position">BTC / USD Perpetual</h2>
          <dl class="sp-stats">
            <div><dt><span id="sp-mark-label">Testnet settlement mark</span></dt><dd><strong id="sp-mark">—</strong></dd></div>
            <div><dt>Private margin</dt><dd class="is-pos"><strong id="sp-margin">—</strong> <small>mUSDC</small></dd></div>
          </dl>
          <form id="sp-open">
            <label>Margin <input class="sp-input" name="margin" type="text" inputmode="decimal" required placeholder="0.00" autocomplete="off"></label>
            <label>Size (BTC) <input class="sp-input" name="size" type="text" inputmode="decimal" required value="0.001" autocomplete="off"></label>
            <p id="sp-order-preview" class="xc-muted xc-small"></p>
            <div class="sp-order-actions"><button class="xc-btn xc-btn--act" value="long">Open private long</button>
              <button class="xc-btn xc-btn--ghost" id="sp-short" value="short" hidden>Open private short</button></div>
          </form>
          <div id="sp-active" hidden><p id="sp-position-info"></p><p class="xc-small xc-muted" id="sp-liquidation"></p><p id="sp-pnl" class="xc-small"></p><button id="sp-close" class="xc-btn xc-btn--ghost">Close position</button></div>
          <p class="xc-muted xc-small">Test assets · maximum 3× leverage</p>
        </section>
        <section class="sp-panel sp-evidence" aria-labelledby="sp-evidence">
          <h2 id="sp-evidence">NEAR receipts</h2>
          <a class="xc-link" id="sp-contract" target="_blank" rel="noopener noreferrer">Pool contract</a>
          <ul class="sp-receipts" id="sp-receipts"></ul>
          <p class="xc-small xc-muted">Deposits and withdrawals show public accounts and amounts. A trade shows the private transaction signer, its proof, and commitments.</p>
        </section>
      </div>
    </main>`;

  let config, wallet, account, client, data, desktopHelper = false, funding = false, gasReady = false, working = false;
  createSpotChart(el('chart'), el('spot-meta'), el('spot-price'));
  const connect = el('connect');
  const status = el('status');
  const lock = () => {
    connect.textContent = working ? 'Please wait…' : client ? 'Lock private wallet' : account ? 'Unlock private wallet' : 'Connect Wallet';
    connect.disabled = working || !config;
    el('desk').hidden = !client;
    for (const element of el('desk').querySelectorAll('button, input')) element.disabled = working;
    for (const element of el('desk').querySelectorAll('form button, #sp-close')) element.disabled ||= !gasReady;
    if (data?.oracle && (!data.oracle.observed_at || Date.now() / 1000 - data.oracle.observed_at > 90)) {
      for (const button of el('open').querySelectorAll('button')) button.disabled = true;
      el('close').disabled = true;
    }
    el('fund').hidden = !funding || !client || (gasReady && (data?.wallet || data?.balance || data?.position));
  };

  function showOrderPreview() {
    const preview = el('order-preview');
    const mark = data?.state?.price_ticks;
    if (!mark) return;
    const { margin, size } = el('open').elements;
    let lots;
    try { lots = btcToLots(size.value); } catch { /* The input may be incomplete. */ }
    if (!lots) {
      preview.textContent = 'Enter a BTC size to see the required margin.';
      return;
    }
    const notional = mark * lots;
    const minimum = Math.ceil(notional / 3);
    let cents;
    try { cents = usdToCents(margin.value); } catch { /* Margin can be blank while editing. */ }
    preview.textContent = '$' + money(notional) + ' notional � ' + money(minimum) + ' mUSDC minimum margin'
      + (cents ? ' � ' + (notional / cents).toFixed(2) + '� leverage' : '');
  }

  el('open').addEventListener('input', showOrderPreview);

  function show() {
    if (!data) return;
    el('wallet').textContent = money(data.wallet);
    el('balance').textContent = money(data.balance);
    const stale = data.oracle && (!data.oracle.observed_at || Date.now() / 1000 - data.oracle.observed_at > 90);
    el('mark').textContent = stale ? 'Stale' : '$' + (data.state.price_ticks * 10).toLocaleString('en-US');
    el('margin').textContent = money(data.position?.margin ?? 0);
    const newest = data.records.positions.at(-1);
    const liquidated = newest && data.liquidations?.find((row) => row.commitment === newest.commitment);
    el('position').textContent = liquidated ? 'BTC / USD Perpetual � Last position liquidated' : 'BTC / USD Perpetual';
    el('note-count').textContent = data.live.length + (data.live.length === 1 ? ' available note' : ' available notes');
    el('open').hidden = Boolean(data.position);
    el('active').hidden = !data.position;
    showOrderPreview();
    if (data.position) {
      el('position-info').textContent = (data.position.short ? 'Short ' : 'Long ') + (data.position.lots / 1_000).toFixed(3) + ' BTC · entry $' + (data.position.entry * 10).toLocaleString('en-US');
      const pnl = Math.max(-data.position.margin, Math.min(60_000, (data.state.price_ticks - data.position.entry) * data.position.lots * (data.position.short ? -1 : 1)));
      el('liquidation').textContent = client.keeperConfig
        ? 'Offline keeper protection � liquidates at or below 5% maintenance margin' : '';
      el('pnl').textContent = 'Estimated P&L ' + (pnl > 0 ? '+' : '') + money(pnl) + ' mUSDC at the testnet mark';
    }
  }

  async function run(message, operation) {
    if (working) return;
    working = true;
    status.textContent = message;
    status.classList.remove('is-neg');
    lock();
    try {
      status.textContent = await operation();
    } catch (error) {
      status.textContent = String(error.message || 'The request did not complete.').slice(0, 240);
      status.classList.add('is-neg');
    } finally {
      if (client) {
        try { data = await client.read(); show(); }
        catch { status.textContent += ' · The pool state could not be refreshed.'; }
      }
      working = false;
      lock();
    }
  }

  connect.onclick = () => run('Waiting for your NEAR wallet…', async () => {
    if (client) {
      client = null;
      data = null;
      el('receipts').replaceChildren();
      return 'Private wallet locked.';
    }
    if (!wallet) {
      const { NearConnector } = await import('@hot-labs/near-connect');
      const connector = new NearConnector({ network: 'testnet', autoConnect: false,
        features: { testnet: true, signMessage: true, signInWithoutAddKey: true, signAndSendTransaction: true },
        footerBranding: null });
      const selected = await connector.connect();
      const id = (await selected.getAccounts())?.[0]?.accountId;
      if (!isAccountId(id)) throw new Error('Choose a NEAR testnet account.');
      wallet = selected;
      account = id;
      el('exit').elements.recipient.value = id;
      return 'Connected · ' + account;
    }
    const trader = await unlockConnectedTrader(wallet, account, location.origin);
    let hashes;
    if (config.proofVersion) {
      const artifact = '/shielded/' + (hasSides(config.proofVersion) ? 'judge-pool' : 'browser-pool') + '/xythum_prover.js';
      const wasm = await import(/* @vite-ignore */ artifact);
      await wasm.default();
      hashes = poseidonPool(wasm, hasSides(config.proofVersion));
    }
    const next = new PoolClient({ account, wallet, trader, pool: config.pool, token: config.token, hashes,
      async keeperAck(index, payload) {
        const response = await fetch('/api/pool/keeper-ack', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pool: config.pool, index, ...payload }), signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('Keeper acknowledgment unavailable. Try again.');
        return (await response.json()).acknowledgment;
      },
      prove(kind, fingerprint, witness) {
        const expected = kind === 'spend' ? config.spendVk : config.closeVk;
        if (fingerprint !== expected) throw new Error('The pool verifying key differs from this deployment.');
        return desktopHelper ? helperProof(kind, fingerprint, witness) : localProof(kind, fingerprint, witness, config.proofVersion);
      } });
    data = await next.initialize();
    gasReady = await next.gasReady();
    client = next;
    if (funding && (!gasReady || !data.wallet && !data.balance && !data.position)) return 'Claim test funds to start trading.';
    return gasReady ? 'Private wallet unlocked · ' + account : 'Testnet gas is required for the private signer: ' + client.privateAccount;
  });

  el('fund').onclick = () => run('Approve the test funding request in your NEAR wallet…', async () => {
    const traderKey = client.trader.signer.publicKey;
    const expiresAt = Date.now() + 240_000;
    const approval = await verifyWalletSignature(wallet, account,
      await poolFundingAuthorization(location.origin, account, traderKey, expiresAt));
    status.textContent = 'Sending test funds on NEAR…';
    const response = await fetch('/api/pool/funding', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, publicKey: approval.publicKey, traderKey, signature: toBase64(approval.signature), expiresAt }),
      signal: AbortSignal.timeout(120_000) });
    const result = await response.json();
    if (!response.ok || !result.funded) throw new Error(result.message || 'Test funding failed. Try again.');
    gasReady = await client.gasReady();
    return 'Test funds ready. Choose an amount to deposit.';
  });

  const tx = (pending, label, operation) => run(pending, async () => client.exclusive(async () => {
    const hash = await operation();
    receipt(el('receipts'), label, hash);
    return label + ' confirmed on NEAR.';
  }));
  el('deposit').onsubmit = (event) => {
    event.preventDefault();
    const amount = event.currentTarget.elements.amount.value;
    tx('Approve the deposit in your NEAR wallet…', 'Deposit', () => client.deposit(amount));
  };
  el('open').onsubmit = (event) => {
    event.preventDefault();
    const { margin, size } = event.currentTarget.elements;
    const short = event.submitter?.value === 'short';
    tx('Loading the spend proving key…', 'Private open', () => client.open(margin.value, btcToLots(size.value), short));
  };
  el('close').onclick = () => tx('Loading the close proving key…', 'Private close', () => client.close());
  el('exit').onsubmit = (event) => {
    event.preventDefault();
    const { amount, recipient } = event.currentTarget.elements;
    tx('Loading the spend proving key…', 'Withdrawal', () => client.withdraw(amount.value, recipient.value));
  };
  el('export').onclick = () => run('Encrypting note backup…', async () => {
    const url = URL.createObjectURL(new Blob([await client.exportBackup()], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'quiet-margin-pool-backup.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    return 'Encrypted backup exported.';
  });
  el('import').onchange = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    run('Opening note backup…', async () => client.exclusive(async () => {
      if (file.size > 500_000) throw new Error('The backup file is too large.');
      await client.importBackup(await file.text());
      return 'Pool notes restored.';
    }));
  };
  await run('Loading pool…', async () => {
    const selected = new URLSearchParams(location.search).get('pool');
    const original = selected === 'legacy';
    const keeper = selected === 'keeper' || selected === 'live';
    const path = keeper ? '/shielded/judge-pool/' + selected + '-config.json' : original ? '/shielded/config.json' : '/shielded/' + (selected === 'browser' ? 'browser-pool' : 'judge-pool') + '/config.json';
    const response = await fetch(path,
      { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('The shielded pool is unavailable on this host.');
    const deployment = await response.json();
    if (![deployment.pool, deployment.token].every(isAccountId)) throw new Error('Invalid shielded pool deployment.');
    config = deployment;
    if (deployment.liveOracle) el('mark-label').textContent = 'Live BTC settlement mark';
    el('short').hidden = !hasSides(deployment.proofVersion);
    const health = await fetch('/api/health', { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok ? response.json() : null).catch(() => null);
    funding = hasSides(deployment.proofVersion) && health?.pool_funding === true;
    if (!deployment.proofVersion && location.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
      desktopHelper = health?.local_pool_prover === true;
    }
    el('contract').href = explorer + '/account/' + encodeURIComponent(config.pool);
    return 'Connect your NEAR testnet wallet to begin.' + (desktopHelper ? ' Local desktop prover enabled.' : '');
  });
}
