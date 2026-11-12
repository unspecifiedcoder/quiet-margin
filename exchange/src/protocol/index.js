// Browser wiring for the exchange protocol.

import { Api } from './api.js';
import { ExchangeController } from './controller.js';
import { ProverClient } from './prover.js';
import { indexedDbBackend, Store } from './store.js';

export { ExchangeController } from './controller.js';

export function createExchange({ onState, allowSandbox = false } = {}) {
  const controller = new ExchangeController({
    api: new Api({ base: '/api' }),
    store: new Store(indexedDbBackend()),
    prover: new ProverClient(),
    allowSandbox,
    onState,
  });
  const handlers = {
    onStart: () => controller.onStart(),
    onDeposit: (amount) => controller.onDeposit(amount),
    onOpen: (params) => controller.onOpen(params),
    onClose: () => controller.onClose(),
    onWithdraw: (amount) => controller.onWithdraw(amount),
    onSetMark: (priceUsd) => controller.onSetMark(priceUsd),
    onArmKeeper: () => controller.onArmKeeper(),
  };
  return { controller, handlers };
}
