#!/usr/bin/env bash
# Builds the browser prover (wasm-bindgen --target web).
#
#   prover/browser/build.sh [out_dir]      # default: prover/target/browser/pkg
#
# Output: xythum_prover.js, xythum_prover_bg.wasm, *.d.ts, snippets/.
# Needs the pinned toolchain (rust-toolchain.toml, wasm32-unknown-unknown)
# and wasm-bindgen-cli 0.2.130 on PATH or in prover/target/tools/bin; the
# latter is installed with `cargo install --locked` when missing. wasm-opt is
# used only if XYTHUM_WASM_OPT=1 and it is on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prover="$(cd "$here/.." && pwd)"
out="${1:-$prover/target/browser/pkg}"
bindgen_version="0.2.130"
tools="$prover/target/tools"

cd "$prover"
cargo rustc --locked --release --lib --target wasm32-unknown-unknown --crate-type cdylib

bindgen=""
for candidate in "$tools/bin/wasm-bindgen" "$tools/bin/wasm-bindgen.exe" "$(command -v wasm-bindgen || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] \
    && "$candidate" --version | grep -qx "wasm-bindgen $bindgen_version"; then
    bindgen="$candidate"
    break
  fi
done
if [ -z "$bindgen" ]; then
  cargo install wasm-bindgen-cli --version "=$bindgen_version" --locked --root "$tools"
  bindgen="$tools/bin/wasm-bindgen"
  [ -x "$bindgen" ] || bindgen="$tools/bin/wasm-bindgen.exe"
fi

mkdir -p "$out"
"$bindgen" --target web --out-dir "$out" --out-name xythum_prover \
  "$prover/target/wasm32-unknown-unknown/release/xythum_prover.wasm"

if [ "${XYTHUM_WASM_OPT:-0}" = "1" ] && command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int \
    --enable-sign-ext --enable-mutable-globals --enable-reference-types \
    --enable-multivalue -o "$out/xythum_prover_bg.wasm" "$out/xythum_prover_bg.wasm"
fi

ls -l "$out"
