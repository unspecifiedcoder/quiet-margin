import { Api, ApiError, isAccountId } from '../protocol/api.js';
import { toBase64 } from '../protocol/bytes.js';
import { unlockConnectedTrader, verifyWalletSignature } from '../protocol/connected-wallet.js';
import { sessionProof } from '../protocol/signer.js';
import { faucetAuthorization } from '../protocol/wallet-messages.js';

function node(tag, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

export function startConnectedExchange(root, { createExchange, mountExchange, allowSandbox }) {
  const api = new Api();
  const panel = node('section', 'xc-wallet-bar');
  panel.setAttribute('aria-label', 'NEAR wallet');
  const status = node('span', 'xc-muted');
  status.setAttribute('role', 'status');
  const notice = node('span', 'xc-small');
  notice.setAttribute('role', 'alert');
  const action = node('button', 'xc-btn xc-btn--act');
  action.type = 'button';
  const disconnect = node('button', 'xc-btn xc-btn--ghost');
  disconnect.type = 'button';
  disconnect.textContent = 'Disconnect';
  panel.append(status, notice, action, disconnect);

  let connector;
  let connection;
  let trader;
  let controller;
  let view;
  let working = false;

  function show() {
    const busy = Boolean(controller?.snapshot().busy);
    status.textContent = connection ? connection.accountId + ' · NEAR testnet' : 'NEAR testnet';
    action.textContent = working ? 'Waiting…'
      : !connection ? 'Connect Wallet'
        : !trader ? 'Unlock private wallet'
          : !controller ? 'Claim 600 test mUSDC' : 'Lock trading wallet';
    action.disabled = working || busy;
    disconnect.hidden = !connection;
    disconnect.disabled = working || busy;
  }

  function mount(handlers = {}) {
    view?.destroy();
    view = mountExchange(root, handlers, {
      spot: true,
      banner: panel,
      cold: {
        title: 'Trade from a private wallet',
        body: 'Connect and unlock your NEAR testnet wallet to begin.',
        note: ['One test collateral grant per connected account.'],
      },
      hideStart: true,
    });
    if (controller) view.update(controller.snapshot());
  }

  async function connect() {
    const { NearConnector } = await import('@hot-labs/near-connect');
    connector ??= new NearConnector({
      network: 'testnet',
      autoConnect: false,
      features: { testnet: true, signMessage: true, signInWithoutAddKey: true },
      footerBranding: null,
    });
    const wallet = await connector.connect();
    const accounts = await wallet.getAccounts();
    if (!isAccountId(accounts?.[0]?.accountId)) throw new Error('Select a NEAR testnet account in your wallet.');
    connection = { wallet, accountId: accounts[0].accountId };
  }

  async function attach() {
    const next = createExchange({ store: trader.store, allowSandbox, onState: (state) => {
      view?.update(state);
      show();
    } });
    controller = next.controller;
    const { onSetMark, ...handlers } = next.handlers;
    mount(handlers);
    if (!await controller.onStart({ recoverOnly: true })) {
      const message = controller.snapshot().error || 'The trader session could not be restored.';
      lockWallet();
      throw new Error(message);
    }
  }

  async function unlock() {
    trader = await unlockConnectedTrader(connection.wallet, connection.accountId, location.origin);
    try {
      await api.createSession(trader.signer.publicKey, await sessionProof(trader.signer), { recoverOnly: true });
    } catch (error) {
      if (error instanceof ApiError && ['session_not_found', 'session_not_ready'].includes(error.code)) return;
      trader = null;
      throw error;
    }
    await attach();
  }

  async function claim() {
    const expiresAt = Date.now() + 4 * 60_000;
    const authorization = await faucetAuthorization(location.origin, connection.accountId, trader.signer.publicKey, expiresAt);
    const signed = await verifyWalletSignature(connection.wallet, connection.accountId, authorization);
    try {
      await api.claimFaucet(trader.signer.publicKey, await sessionProof(trader.signer), {
        accountId: signed.accountId, publicKey: signed.publicKey,
        signature: toBase64(signed.signature), expiresAt,
      });
    } finally {
      signed.signature.fill(0);
    }
    await attach();
  }

  function lockWallet() {
    controller?.stop();
    controller = null;
    trader = null;
    mount();
  }

  async function run(operation) {
    if (working || controller?.snapshot().busy) return;
    working = true;
    notice.textContent = '';
    show();
    try {
      await operation();
    } catch (error) {
      notice.textContent = error instanceof ApiError && error.code === 'wallet_already_funded'
        ? 'This account already claimed. Use the wallet key that originally unlocked the trader.'
        : String(error?.message || 'The wallet request failed. Try again.').slice(0, 220);
    } finally {
      working = false;
      show();
    }
  }

  action.addEventListener('click', () => run(!connection ? connect : !trader ? unlock : !controller ? claim : lockWallet));
  disconnect.addEventListener('click', () => run(async () => {
    const { wallet } = connection;
    connection = null;
    lockWallet();
    await connector.disconnect(wallet);
  }));
  mount();
  show();
}
