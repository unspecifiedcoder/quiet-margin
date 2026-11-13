self.onmessage = async ({ data: { kind, fingerprint, witness } }) => {
  try {
    if (kind !== 'spend' && kind !== 'close') throw new Error('Unknown proof type.');
    const artifact = '/shielded/prover/xythum_prover.js';
    const [wasm, response] = await Promise.all([
      import(/* @vite-ignore */ artifact),
      fetch(`/api/proving/pool-${kind}.pk`, { signal: AbortSignal.timeout(180_000) }),
    ]);
    if (!response.ok) throw new Error('The pool proving key is unavailable.');
    const [, key] = await Promise.all([wasm.default(), response.arrayBuffer()]);
    self.postMessage({ stage: 'Proving locally' });
    const result = JSON.parse(wasm.prove_pool(kind, new Uint8Array(key), fingerprint, JSON.stringify(witness)));
    self.postMessage({ proof: result.proof });
  } catch (error) {
    self.postMessage({ error: String(error.message || 'The browser could not generate a proof.').slice(0, 200) });
  }
};
