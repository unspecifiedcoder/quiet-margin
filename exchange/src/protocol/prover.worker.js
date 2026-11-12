// Dedicated proving worker. It is the only place that downloads proving
// keys, and it makes no other network request: the witness it receives is
// passed straight into the same-origin wasm prover and is never posted.
//
// The wasm module is the wasm-bindgen `--target web` build served from the
// Vite public directory at `/prover/xythum_prover.js` (with its generated
// `snippets/`), with a default init export and
//   prove_open(pk_bytes, expected_vk_sha256_b64, input_json) -> json
//   prove_close(pk_bytes, expected_vk_sha256_b64, input_json) -> json
// whose JSON output matches the native `xythum-prover` CLI.
//
// The main thread runs one proof per worker and then terminates it, so a
// proving key and the wasm heap never outlive their proof.

import { KINDS, runJob } from './prover-core.js';
import { resolvePins } from './prover-pins.js';

const pins = resolvePins(import.meta.env ?? {});
let modulePromise;

function loadProver() {
  modulePromise ??= (async () => {
    const url = new URL('/prover/xythum_prover.js', self.location.origin);
    const mod = await import(/* @vite-ignore */ url.href);
    if (typeof mod.default !== 'function') throw new Error('prover module has no default init export');
    await mod.default();
    for (const name of Object.values(KINDS)) {
      if (typeof mod[name] !== 'function') throw new Error('prover module does not export ' + name);
    }
    return mod;
  })().catch((error) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

self.onmessage = ({ data }) => runJob(data, {
  fetchImpl: fetch, origin: self.location.origin, loadProver, pins,
  post: (message) => self.postMessage(message),
});
