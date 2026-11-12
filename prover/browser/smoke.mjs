// Proof smoke test for the browser prover build, run under Node (>= 20).
//
//   node prover/browser/smoke.mjs [pkg_dir]     # default: prover/target/browser/pkg
//
// Uses only fresh synthetic keys: it runs `xythum-prover setup` into a new
// directory under the OS temp dir, exports compressed keys with
// `xythum-browser-keys compress`, and deletes everything afterwards. It never
// reads .env, .testnet, or any existing key directory. Requires the native
// release binaries (`cargo build --release` in prover/) and the wasm package
// (`browser/build.sh` or `browser/build.ps1`).
//
// Each proving case runs in its own Node process so the reported wasm linear
// memory is that case's high-water mark (wasm memory never shrinks).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const prover = resolve(here, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = (name) => join(prover, 'target', 'release', name + exe);

const b64 = (byte) => Buffer.alloc(32, byte).toString('base64');
const OPENING = {
  context: b64(0x11),
  size_lots: 10,
  entry_ticks: 10_000,
  margin_cents: 50_000,
  blinder: b64(0xa5),
};
const OPEN_INPUT = { ...OPENING, quote_blinder: b64(0x3c), open_price_ticks: 10_000 };
const CLOSE_INPUT = { ...OPENING, round: 7, price_ticks: 9_500, funding_cents: 3 };

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

async function load(pkgDir) {
  const mod = await import(pathToFileURL(join(pkgDir, 'xythum_prover.js')).href);
  const wasm = mod.initSync({ module: readFileSync(join(pkgDir, 'xythum_prover_bg.wasm')) });
  return { mod, memory: wasm.memory };
}

const mib = (n) => (n / (1 << 20)).toFixed(1);

// Child: one proving case. Prints one JSON line.
async function child(pkgDir, kind, keyFile, fingerprint) {
  const { mod, memory } = await load(pkgDir);
  const pk = new Uint8Array(readFileSync(keyFile));
  const info = JSON.parse(mod.key_info(pk));
  const input = JSON.stringify(kind === 'open' ? OPEN_INPUT : CLOSE_INPUT);
  const t0 = performance.now();
  const out = (kind === 'open' ? mod.prove_open : mod.prove_close)(pk, fingerprint, input);
  const wall_ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ info, out: JSON.parse(out), raw: out, wall_ms, wasm_memory: memory.buffer.byteLength }));
}

function expectThrow(fn, pattern) {
  assert.throws(fn, (e) => e instanceof Error && pattern.test(e.message), `expected ${pattern}`);
}

async function main(pkgDir) {
  const work = mkdtempSync(join(tmpdir(), 'xythum-browser-smoke-'));
  try {
    const keys = join(work, 'keys');
    const packed = join(work, 'packed');
    let t = performance.now();
    const setup = JSON.parse(run(bin('xythum-prover'), ['setup', keys]));
    console.log(`setup (synthetic keys) ${Math.round(performance.now() - t)} ms`);
    const exported = JSON.parse(run(bin('xythum-browser-keys'), ['compress', keys, packed]));
    assert.equal(exported.open.vk_sha256, setup.open_vk_sha256);
    assert.equal(exported.close.vk_sha256, setup.close_vk_sha256);

    // Native CLI reference outputs for the same inputs.
    const cliOpen = JSON.parse(run(bin('xythum-prover'), ['prove-open', keys], JSON.stringify(OPEN_INPUT)));
    const cliClose = JSON.parse(run(bin('xythum-prover'), ['prove-close', keys], JSON.stringify(CLOSE_INPUT)));

    const cases = [
      ['open', join(keys, 'open.pk'), setup.open_vk_sha256, 'uncompressed', cliOpen],
      ['close', join(keys, 'close.pk'), setup.close_vk_sha256, 'uncompressed', cliClose],
      ['open', join(packed, exported.open.file), setup.open_vk_sha256, 'compressed', cliOpen],
      ['close', join(packed, exported.close.file), setup.close_vk_sha256, 'compressed', cliClose],
    ];
    for (const [kind, file, fp, format, cli] of cases) {
      const r = JSON.parse(run(process.execPath, [fileURLToPath(import.meta.url), '--child', pkgDir, kind, file, fp]));
      assert.equal(r.info.format, format);
      assert.equal(r.info.vk_sha256, fp);
      assert.equal(r.info.public_inputs, kind === 'open' ? 7 : 9);
      // Same keys, same order, same deterministic values as the CLI.
      assert.deepEqual(Object.keys(r.out), Object.keys(cli));
      assert.ok(/^\{"commitment":/.test(r.raw) && !/\s/.test(r.raw));
      for (const [k, v] of Object.entries(cli)) {
        if (k === 'proof') assert.equal(Buffer.from(r.out.proof, 'base64').length, 384);
        else if (k === 'proving_ms') assert.ok(Number.isInteger(r.out.proving_ms));
        else assert.equal(r.out[k], v, k);
      }
      console.log(
        `${kind} ${format}: key ${mib(r.info.bytes)} MiB, proving_ms ${r.out.proving_ms}, ` +
          `call ${r.wall_ms} ms, wasm memory ${mib(r.wasm_memory)} MiB`,
      );
    }

    // Fail-closed checks (each fails before or at the fingerprint).
    const { mod } = await load(pkgDir);
    const openPk = new Uint8Array(readFileSync(join(keys, 'open.pk')));
    const closePk = new Uint8Array(readFileSync(join(packed, exported.close.file)));
    const open = JSON.stringify(OPEN_INPUT);
    expectThrow(() => mod.prove_open(openPk, setup.close_vk_sha256, open), /not the expected open fingerprint/);
    expectThrow(() => mod.prove_open(closePk, setup.close_vk_sha256, open), /9 public inputs; the open statement has 7/);
    expectThrow(() => mod.prove_close(openPk, setup.open_vk_sha256, JSON.stringify(CLOSE_INPUT)), /7 public inputs/);
    expectThrow(() => mod.prove_open(openPk.subarray(0, openPk.length - 1), setup.open_vk_sha256, open), /not an arkworks/);
    expectThrow(() => mod.prove_open(openPk, 'AAAA', open), /expected_vk_sha256_b64/);
    expectThrow(() => mod.prove_open([1, 2, 3], setup.open_vk_sha256, open), /must be a Uint8Array/);
    expectThrow(() => mod.prove_open(openPk, setup.open_vk_sha256, JSON.stringify({ ...OPEN_INPUT, round: 1 })), /invalid input JSON/);
    expectThrow(() => mod.prove_open(openPk, setup.open_vk_sha256, JSON.stringify({ ...OPEN_INPUT, size_lots: 51 })), /size_lots must be in 1..=50/);
    expectThrow(() => mod.prove_open(openPk, setup.open_vk_sha256, JSON.stringify({ ...OPEN_INPUT, size_lots: 1.5 })), /invalid input JSON/);
    expectThrow(() => mod.prove_open(openPk, setup.open_vk_sha256, JSON.stringify({ ...OPEN_INPUT, blinder: OPEN_INPUT.blinder.replace('=', '') })), /blinder must be canonical/);
    expectThrow(() => mod.prove_close(closePk, setup.close_vk_sha256, JSON.stringify({ ...CLOSE_INPUT, round: 0 })), /round must be nonzero/);
    // Huge length prefix: rejected by the layout walk without allocating.
    const evil = new Uint8Array(4096);
    new DataView(evil.buffer).setBigUint64(96 + 3 * 192, 0xffff_ffff_ffff_ffffn, true);
    expectThrow(() => mod.key_info(evil), /not an arkworks/);
    console.log('fail-closed checks: 12 passed');
    console.log('browser smoke: OK');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--child') await child(...argv.slice(1));
else await main(resolve(argv[0] ?? join(prover, 'target', 'browser', 'pkg')));
