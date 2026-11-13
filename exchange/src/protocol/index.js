// Browser wiring for the exchange protocol.

import { Api } from './api.js';
import { ExchangeController } from './controller.js';
import { ProverClient } from './prover.js';
import { indexedDbBackend, Store } from './store.js';

export { ExchangeController } from './controller.js';
export { burnerSignRequest, createBurnerWallet, importBurnerWallet, unlockBurnerStore } from './burner-wallet.js';

/**
 * `store` is optional: omit it for the legacy Start session browser key (the
 * `xythum-exchange` database), or pass `(await unlockBurnerStore(wallet,
 * location.origin)).store` to trade with that burner's trading wallet.
 */
export function createExchange({ onState, allowSandbox = false, store } = {}) {
  const controller = new ExchangeController({
    api: new Api({ base: '/api' }),
    store: store ?? new Store(indexedDbBackend()),
    prover: new ProverClient(),
    allowSandbox,
    onState,
  });
  const handlers = {
    onStart: () => controller.onStart(),
    onDeposit: (amount) => controller.onDeposit(amount),
    onOpen: (params) => controller.onOpen(params),
    onRefreshQuote: () => controller.onRefreshQuote(),
    onClose: () => controller.onClose(),
    onWithdraw: (amount) => controller.onWithdraw(amount),
    onSetMark: (priceUsd) => controller.onSetMark(priceUsd),
    onArmKeeper: () => controller.onArmKeeper(),
  };
  return { controller, handlers };
}
