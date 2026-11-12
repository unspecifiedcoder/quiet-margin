// Proving-job logic run inside the dedicated proving worker (see
// `prover.worker.js`), kept free of worker globals so it can be tested.
//
// The proving key is downloaded completely and its SHA-256 compared with the
// pinned release digest before any byte reaches the wasm prover; the wasm
// prover then still checks the decoded verifying key against the on-chain VK
// fingerprint (`vkSha256`).

export const KINDS = { open: 'prove_open', close: 'prove_close' };
export const DEFAULT_MAX_PK_BYTES = 512 * 1024 * 1024;
const PK_TIMEOUT_MS = 10 * 60_000;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function fetchKey(fetchImpl, origin, kind, maxBytes, progress) {
  const url = new URL('/api/proving/' + kind + '.pk', origin);
  const response = await fetchImpl(url, {
    method: 'GET', credentials: 'omit', cache: 'default', redirect: 'error',
    signal: AbortSignal.timeout(PK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`proving key ${kind}.pk unavailable (HTTP ${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(`proving key ${kind}.pk exceeds ${maxBytes} bytes`);
  const reader = response.body.getReader();
  let buffer = new Uint8Array(declared > 0 ? declared : 16 * 1024 * 1024);
  let size = 0;
  let reported = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > maxBytes) {
      await reader.cancel();
      throw new Error(`proving key ${kind}.pk exceeds ${maxBytes} bytes`);
    }
    if (size + value.length > buffer.length) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(buffer.length * 2, size + value.length)));
      grown.set(buffer.subarray(0, size));
      buffer = grown;
    }
    buffer.set(value, size);
    size += value.length;
    if (size - reported >= 4 * 1024 * 1024) {
      reported = size;
      progress(`Downloading ${kind} proving key: ${(size / 1048576).toFixed(0)} MiB`
        + (declared > 0 ? ` of ${(declared / 1048576).toFixed(0)} MiB` : ''));
    }
  }
  if (declared > 0 && size !== declared) throw new Error(`proving key ${kind}.pk was truncated`);
  return buffer.subarray(0, size);
}

/** Throws unless the complete key bytes hash to the pinned digest. */
export async function verifyProvingKey(kind, bytes, expectedHex) {
  const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (digest !== expectedHex) {
    throw new Error(`proving key ${kind}.pk does not match the pinned release digest`);
  }
}

/**
 * Runs one proving request. `loadProver` resolves the initialized wasm
 * module; `pins` maps kind to the pinned proving-key SHA-256 (hex).
 */
export async function runJob(data, { fetchImpl, origin, loadProver, pins, post }) {
  const { id, kind, vkSha256, input, maxPkBytes } = data ?? {};
  const progress = (status) => post({ id, progress: status });
  try {
    if (!Object.hasOwn(KINDS, kind)) throw new Error('unknown proof kind');
    if (typeof vkSha256 !== 'string' || typeof input !== 'string') throw new Error('malformed proving request');
    progress('Loading prover');
    const maxBytes = Math.min(maxPkBytes ?? DEFAULT_MAX_PK_BYTES, DEFAULT_MAX_PK_BYTES);
    const [mod, pk] = await Promise.all([loadProver(), fetchKey(fetchImpl, origin, kind, maxBytes, progress)]);
    progress(`Verifying ${kind} proving key`);
    await verifyProvingKey(kind, pk, pins[kind]);
    progress(`Generating ${kind} proof locally`);
    const output = mod[KINDS[kind]](pk, vkSha256, input);
    post({ id, ok: true, output: typeof output === 'string' ? output : JSON.stringify(output) });
  } catch (error) {
    post({ id, ok: false, error: String(error?.message ?? error) });
  }
}
