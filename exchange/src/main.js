import { mountExchange } from './ui/exchange.js';
import { createExchange } from './protocol/index.js';

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
  allowSandbox: import.meta.env.VITE_ALLOW_SANDBOX === '1',
});

const root = document.getElementById('app') ?? document.body;
view = mountExchange(root, handlers);
render(pending.pop() ?? controller.snapshot());
pending.length = 0;

// Reattach a session this browser already saved. This never creates a key or
// enrolls: a fresh visit stays idle until the user clicks Start session.
controller.onResume();
