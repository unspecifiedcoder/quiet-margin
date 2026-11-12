import { mountExchange } from './ui/exchange.js';
import { createExchange } from './protocol/index.js';

const root = document.getElementById('app') ?? document.body;
const allowSandbox = import.meta.env.VITE_ALLOW_SANDBOX === '1';
const PRIVATE_WALLET_ROUTE = '?wallet=burner';

if (new URLSearchParams(globalThis.location.search).get('wallet') === 'burner') {
  // Private wallet route: a built-in testnet burner unlocks a separate private
  // trading wallet. It never auto-unlocks; the user signs explicitly each load.
  startPrivateWallet();
} else {
  startDefault();
}

function startDefault() {
  let view;
  const pending = [];
  const render = (state) => {
    if (!view) {
      pending.push(state);
      return;
    }
    if (typeof view === 'function') view(state);
    else (view.update ?? view.render)?.call(view, state);
  };

  const { controller, handlers } = createExchange({
    onState: render,
    allowSandbox,
  });

  view = mountExchange(root, handlers, { privateWalletHref: PRIVATE_WALLET_ROUTE });
  render(pending.pop() ?? controller.snapshot());
  pending.length = 0;

  // Reattach a session this browser already saved. This never creates a key or
  // enrolls: a fresh visit stays idle until the user clicks Start session.
  controller.onResume();
}

async function startPrivateWallet() {
  const homeHref = globalThis.location.pathname || '/';
  try {
    const [{ startBurnerRoute }, burner] = await Promise.all([
      import('./ui/burner.js'),
      import('./protocol/burner-wallet.js'),
    ]);
    startBurnerRoute(root, {
      burner: {
        createBurnerWallet: burner.createBurnerWallet,
        importBurnerWallet: burner.importBurnerWallet,
        burnerSignRequest: burner.burnerSignRequest,
        unlockBurnerStore: burner.unlockBurnerStore,
      },
      createExchange,
      mountExchange,
      allowSandbox,
      origin: globalThis.location.origin,
      homeHref,
      routeHref: `${homeHref}${PRIVATE_WALLET_ROUTE}`,
    });
  } catch {
    // Plain, retryable fallback: the route's code could not load or mount
    // (offline, a DNS error or a stale deploy). Nothing was unlocked, so a
    // retry is safe. The default session remains available.
    root.classList.add('xc');
    const box = document.createElement('main');
    box.className = 'xc-bw';
    const card = document.createElement('section');
    card.className = 'xc-card xc-bw__card';
    const msg = document.createElement('p');
    msg.setAttribute('role', 'alert');
    msg.textContent = 'The private wallet could not load. Try again, or use the original session.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'xc-btn xc-btn--act';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      retry.textContent = 'Loading…';
      startPrivateWallet();
    }, { once: true });
    const back = document.createElement('a');
    back.className = 'xc-link';
    back.href = homeHref;
    back.textContent = 'Back to Start session';
    card.append(msg, retry, ' ', back);
    box.append(card);
    root.replaceChildren(box);
    retry.focus();
  }
}
