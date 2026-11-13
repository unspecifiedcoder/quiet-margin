self.onmessage = async ({ data: { kind, fingerprint, witness, version } }) => {
  try {
    if (kind !== 'spend' && kind !== 'close') throw new Error('Unknown proof type.');
    const artifact = '/shielded/prover/xythum_prover.js';
    const [wasm, response] = await Promise.all([
      import(/* @vite-ignore */ artifact),
      fetch(`/api/proving/${version === 'poseidon-v1' ? 'browser-pool' : 'pool'}-${kind}.pk`,
        { signal: AbortSignal.timeout(5 * 60_000) }),
    ]);
    if (!response.ok) throw new Error('The pool proving key is unavailable.');
    const [, key] = await Promise.all([wasm.default(), response.arrayBuffer()]);
    self.postMessage({ stage: 'Preparing proving key' });
    const prove = version === 'poseidon-v1' ? wasm.prove_browser_pool : wasm.prove_pool;
    const result = JSON.parse(prove(kind, new Uint8Array(key), fingerprint, JSON.stringify(witness),
      () => self.postMessage({ stage: 'Generating proof' })));
    self.postMessage({ proof: result.proof });
  } catch (error) {
    self.postMessage({ error: String(error.message || 'The browser could not generate a proof.').slice(0, 200) });
  }
};
