self.onmessage = async ({ data: { kind, fingerprint, witness, version } }) => {
  try {
    if (kind !== 'spend' && kind !== 'close') throw new Error('Unknown proof type.');
    const judge = version === 'poseidon-v2';
    const browserPool = judge || version === 'poseidon-v1';
    const directory = judge ? '/shielded/judge-pool' : '/shielded/browser-pool';
    const artifact = browserPool ? directory + '/xythum_prover.js' : '/shielded/prover/xythum_prover.js';
    const [wasm, response] = await Promise.all([
      import(/* @vite-ignore */ artifact),
      fetch(browserPool ? `${directory}/${kind}.pk` : `/api/proving/pool-${kind}.pk`,
        { signal: AbortSignal.timeout(5 * 60_000) }),
    ]);
    if (!response.ok) throw new Error('The pool proving key is unavailable.');
    const [, key] = await Promise.all([wasm.default(), response.arrayBuffer()]);
    self.postMessage({ stage: 'Preparing proving key' });
    const prove = judge ? wasm.prove_judge_pool : browserPool ? wasm.prove_browser_pool : wasm.prove_pool;
    const result = JSON.parse(prove(kind, new Uint8Array(key), fingerprint, JSON.stringify(witness),
      () => self.postMessage({ stage: 'Generating proof' })));
    self.postMessage({ proof: result.proof });
  } catch (error) {
    self.postMessage({ error: String(error.message || 'The browser could not generate a proof.').slice(0, 200) });
  }
};
