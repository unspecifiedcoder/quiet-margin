// Background Keeper B watcher. Runs regardless of browser presence and tries
// each armed session on each oracle round (with bounded retries of transient
// failures, see Coordinator.attemptKeeper), one prover at a time.
import { safeMessage } from './util.mjs';

export class KeeperWorker {
  #timer = null;
  #running = null;
  #again = false;
  #stopped = true;

  constructor({ coordinator, intervalMs, log = () => {} }) {
    this.coordinator = coordinator;
    this.intervalMs = intervalMs;
    this.log = log;
    coordinator.setWake(() => this.wake());
  }

  start() {
    this.#stopped = false;
    this.#timer = setInterval(() => this.wake(), this.intervalMs);
    this.wake();
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#running;
  }

  wake() {
    if (this.#stopped) return this.#running;
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#tick().finally(() => {
      this.#running = null;
      if (this.#again && !this.#stopped) {
        this.#again = false;
        this.wake();
      }
    });
    return this.#running;
  }

  async #tick() {
    for (const record of this.coordinator.armedSessions()) {
      if (this.#stopped) return;
      try {
        const { receipt } = await this.coordinator.attemptKeeper(record);
        if (receipt) this.log('keeper ' + record.key + ' ' + receipt.label + ' ' + receipt.hash);
      } catch (error) {
        this.log('keeper ' + record.key + ' check failed: ' + safeMessage(error, 120));
      }
    }
  }
}
