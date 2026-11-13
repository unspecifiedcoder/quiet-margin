import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { childEnv } from './actors.mjs';
import { HttpError } from './util.mjs';

export function createLocalPoolProver(config) {
  const bin = config.localPoolProverBin;
  if (!bin || config.hosted) return undefined;
  if (!isAbsolute(bin) || !existsSync(bin)) throw new Error('Set XYTHUM_LOCAL_POOL_PROVER to the absolute prover binary path.');
  let running = false;
  return async ({ kind, fingerprint, witness }) => {
    if (!['spend', 'close'].includes(kind) || !/^[A-Za-z0-9+/]{43}=$/.test(fingerprint ?? '')
      || !witness || typeof witness !== 'object' || Array.isArray(witness)) {
      throw new HttpError(400, 'pool_proof_input', 'invalid local proof request');
    }
    if (running) throw new HttpError(409, 'pool_prover_busy', 'the local prover is already working');
    running = true;
    try {
      return await new Promise((resolve, reject) => {
        const fail = () => reject(new HttpError(422, 'pool_proof_failed', 'the local prover could not generate this proof'));
        const child = spawn(bin, ['prove', config.poolProvingDir, kind, fingerprint], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(),
          timeout: 11 * 60_000,
        });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
          output += chunk;
          if (output.length > 2048) child.kill();
        });
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.on('close', (code) => {
          if (code !== 0) return fail();
          try {
            const { proof } = JSON.parse(output);
            if (typeof proof !== 'string' || !/^[A-Za-z0-9+/]{512}$/.test(proof)) return fail();
            resolve({ proof });
          } catch { fail(); }
        });
        child.stdin.end(JSON.stringify(witness));
      });
    } finally {
      running = false;
    }
  };
}
