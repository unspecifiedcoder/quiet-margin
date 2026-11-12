// Main-thread wrapper around the dedicated proving worker. Inputs use the
// native CLI JSON schema; outputs are validated before use.

import { fromBase64 } from './bytes.js';

const OPEN_FIELDS = ['context', 'size_lots', 'entry_ticks', 'margin_cents', 'blinder', 'quote_blinder', 'open_price_ticks'];
const CLOSE_FIELDS = ['context', 'size_lots', 'entry_ticks', 'margin_cents', 'blinder', 'round', 'price_ticks', 'funding_cents'];

const pick = (input, fields) => Object.fromEntries(fields.map((f) => {
  if (input[f] === undefined) throw new Error('prover input is missing ' + f);
  return [f, input[f]];
}));

export function parseProofOutput(kind, text) {
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error('prover returned malformed JSON');
  }
  fromBase64(out.commitment, 32);
  if (typeof out.proof !== 'string' || fromBase64(out.proof).length === 0) throw new Error('prover returned no proof');
  if (kind === 'open') fromBase64(out.quote_terms, 32);
  if (kind === 'close' && !(Number.isSafeInteger(out.refund) && Number.isSafeInteger(out.bad_debt))) {
    throw new Error('prover returned malformed settlement values');
  }
  return out;
}

/**
 * Runs each proof in a fresh dedicated worker and terminates it as soon as
 * the proof settles, so at most one proving key (open ~100 MB or close
 * ~51 MB) and one wasm heap are alive at a time. Proofs are serialized.
 */
export class ProverClient {
  constructor(createWorker = () => new Worker(new URL('./prover.worker.js', import.meta.url), { type: 'module', name: 'xythum-prover' })) {
    this.createWorker = createWorker;
    this.queue = Promise.resolve();
    this.nextId = 1;
  }

  runInWorker(message, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = this.createWorker();
      const settle = (fn, value) => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        fn(value);
      };
      worker.onmessage = ({ data }) => {
        if (data?.id !== message.id) return;
        if (data.progress) {
          onProgress?.(data.progress);
          return;
        }
        if (data.ok) settle(resolve, data.output);
        else settle(reject, new Error('local proving failed: ' + data.error));
      };
      worker.onerror = (event) => {
        settle(reject, new Error('proving worker crashed: ' + (event?.message ?? 'unknown error')));
      };
      worker.postMessage(message);
    });
  }

  async prove(kind, vkSha256, input, onProgress) {
    const fields = kind === 'open' ? OPEN_FIELDS : CLOSE_FIELDS;
    const json = JSON.stringify(pick(input, fields));
    const id = this.nextId++;
    const run = this.queue.then(() => this.runInWorker({ id, kind, vkSha256, input: json }, onProgress));
    this.queue = run.catch(() => {});
    return parseProofOutput(kind, await run);
  }
}
