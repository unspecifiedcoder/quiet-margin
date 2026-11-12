# Browser prover

The open and voluntary-close Groth16 provers of `xythum-prover`, compiled to
`wasm32-unknown-unknown` and bound with wasm-bindgen `--target web`. It uses the
same circuits, model, NEP-488 encodings, `prove_*_with` API and self-check as the
CLI. Liquidation is not exported because keepers prove liquidations with the CLI.

## Build

```sh
prover/browser/build.sh   [out_dir]                     # bash
powershell -File prover/browser/build.ps1 [-OutDir dir] # PowerShell
```

The default output is `prover/target/browser/pkg/` (ignored):
`xythum_prover.js`, `xythum_prover_bg.wasm` (~0.9 MB), `xythum_prover.d.ts`, and
`snippets/` (the JS clock). Both scripts use the pinned 1.95 toolchain with
`cargo rustc --locked --release --lib --crate-type cdylib`. The native `[lib]`
crate type is unchanged. They also need wasm-bindgen-cli **0.2.130**, which must
match the locked `wasm-bindgen` crate. The scripts take it from PATH or from
`prover/target/tools/bin`; if neither has it, they install it there with
`cargo install --locked`.

## Exports

```ts
export default function init(module_or_path?): Promise<InitOutput>;
export function initSync(module): InitOutput;
export function prove_open (pk_bytes: Uint8Array, expected_vk_sha256_b64: string, input_json: string): string;
export function prove_close(pk_bytes: Uint8Array, expected_vk_sha256_b64: string, input_json: string): string;
export function key_info   (pk_bytes: Uint8Array): string;  // {"format","bytes","public_inputs","vk_sha256"}
```

* `prove_open` returns exactly the `xythum-prover prove-open` stdout line:
  `{"commitment","quote_terms","proof","proving_ms"}`.
* `prove_close` returns exactly the `prove-close` line:
  `{"commitment","proof","proving_ms","refund","bad_debt"}`.
* Byte values are standard padded Base64. Each proof is the 384-byte NEP-488
  `A‖B‖C`.
* On failure, a JS `Error` is thrown. Its message never contains a witness value.

### Input

`input_json` is one JSON object of at most 4096 bytes. It must not contain
unknown, duplicate, or other-statement fields. This is stricter than the CLI,
which ignores the other statement's fields.

| call | fields |
|---|---|
| open | `context, size_lots, entry_ticks, margin_cents, blinder, quote_blinder, open_price_ticks` |
| close | `context, size_lots, entry_ticks, margin_cents, blinder, round, price_ticks, funding_cents` |

* `context`, `blinder` and `quote_blinder` are canonical standard padded Base64
  of exactly 32 bytes. Missing padding, nonzero trailing bits and the URL-safe
  alphabet are rejected.
* Integers must be JSON integers that fit `u16`/`u32`/`u64` as in the CLI.
  Floats, strings, null and negative values are rejected.
* The model bounds (`check_open_at`, or `close`) are checked before any key byte
  is read.
* `funding_cents` is the funding index delta since the checkpoint, as in the CLI.
* `round` is a `u64`. If it can exceed 2^53, build the JSON from a string or
  BigInt rather than a JS number.

### Fingerprint

`expected_vk_sha256_b64` must be the deployment's
`get_config().open_vk_sha256` or `close_vk_sha256`, taken after the config has
been finalized. Before proving, the prover:

1. checks the key layout and statement (7 public inputs for open, 9 for close);
2. decodes the embedded verifying key with full point validation;
3. re-encodes it as NEP-488 bytes and compares its SHA-256 with the fingerprint.

Only after these checks does it decode the large key body.

## Proving keys

`pk_bytes` can be in either format. The format is detected from the layout of the
length prefixes, and every prefix is bounded by the actual byte length before
anything is allocated.

| key | original `setup` file (arkworks uncompressed) | `xythum-browser-keys compress` (arkworks compressed) |
|---|---|---|
| open  | `open.pk`  ~96.3 MiB (101 MB) | `open.compressed.pk` ~half the size |
| close | `close.pk` ~49.0 MiB (51 MB)  | `close.compressed.pk` ~half the size |

```sh
cargo build --release   # in prover/
target/release/xythum-browser-keys compress <key_dir> <out_dir>
target/release/xythum-browser-keys info <file>
```

* `compress` reads the existing `open.pk` and `close.pk` and never modifies
  them. It writes new files and refuses to overwrite.
* Before writing, it checks that each export round-trips to an identical key.
* It prints `{open:{bytes,file,sha256,vk_sha256}, close:{...}}`. Here
  `vk_sha256` is the `get_config` fingerprint, and `sha256` pins the download
  (for example as Subresource Integrity).
* No existing format, key, CLI command or deployment changes.

Trade-off: a compressed key halves the download, but decompressing it costs one
square root per point at decode time. See the timings below.

Like the CLI, the key body is decoded without subgroup checks, which would cost
minutes in wasm. In their place:

* `delta_g1` is validated as non-zero, on the curve and in the subgroup.
* Every proof must have its points in the prime-order groups and must verify
  against the pinned verifying key before it is returned.

A proof that verifies with uniform `A` and `B` is therefore distributed like an
honest proof, whatever the rest of the key contains. A corrupt or wrong key
fails closed.

## Runtime notes

* **Randomness:** `OsRng` uses `getrandom` 0.2 with the `js` feature, which calls
  `crypto.getRandomValues`. It is available in windows and workers.
* **Timing:** `std::time::Instant` is not used on bare wasm. `proving_ms` comes
  from `performance.now()` (falling back to `Date.now()`) in the calling realm.
* **Threading:** the prover is single-threaded with no rayon, SharedArrayBuffer
  or COOP/COEP. Run it in a dedicated **module Web Worker**: each call blocks its
  thread for tens of seconds. Do not call it on the main thread.
* **Memory:** the key is read from the JS `Uint8Array` in 1 MiB chunks, so wasm
  memory never holds a second copy of the key bytes. The JS side holds the
  downloaded buffer; drop the reference after the call. wasm memory only grows,
  so terminate the worker after a proof to return it. Each statement needs its
  own worker (or one sequential worker) to stay near the peaks below.

### Measured

These figures come from synthetic keys on the developer machine: Node 22 and
headless Chrome, single-threaded release wasm with no wasm-opt. The keys have the
same circuits and sizes as deployed keys.

<!-- MEASUREMENTS -->

## Smoke tests

```sh
cargo build --release   # in prover/ (native binaries used to generate keys)
prover/browser/build.sh
node prover/browser/smoke.mjs          # Node: 4 proofs vs CLI output + 12 fail-closed checks
node prover/browser/worker-smoke.mjs   # headless Chrome/Edge module Worker, 127.0.0.1 only
cargo test --release --test browser    # native: browser entry points -> NEP-488 verifier
```

Both smokes generate fresh synthetic keys in the OS temp directory and delete
them afterwards. They never read `.env`, `.testnet` or existing key
directories, and they make no network requests beyond 127.0.0.1.
