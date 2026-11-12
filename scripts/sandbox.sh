#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This runner requires Linux x86-64. On Windows use the private GitHub Actions workflow.' >&2
  exit 1
fi

tools="$PWD/.sandbox"
mkdir -p "$tools"
export PATH="$tools/cargo-near:$PATH"
export NEAR_SANDBOX_BIN_PATH=1
export NEAR_SANDBOX_BINARY_PATH="$tools/near-sandbox"
export PROVER_BIN="$PWD/prover/target/release/xythum-prover"
export EVIDENCE_FILE="$tools/evidence.json"
rm -f "$EVIDENCE_FILE"

download() {
  local url="$1" archive="$2" checksum="$3"
  curl --fail --silent --show-error --location --retry 3 --max-time 120 "$url" -o "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
}

if [[ ! -x "$tools/cargo-near/cargo-near" ]]; then
  asset=cargo-near-x86_64-unknown-linux-gnu.tar.gz
  download "https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/$asset" \
    "$tools/$asset" 94008b827a457750257eced4b571c33736062cc3bd1ffda3e7af70e2bc9a4073
  mkdir -p "$tools/cargo-near"
  tar -xzf "$tools/$asset" -C "$tools/cargo-near" --strip-components=1
fi
if [[ ! -x "$NEAR_SANDBOX_BINARY_PATH/near-sandbox" ]]; then
  archive="$tools/near-sandbox-2.14.0.tar.gz"
  download 'https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz' \
    "$archive" a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691
  mkdir -p "$NEAR_SANDBOX_BINARY_PATH"
  tar -xzf "$archive" -C "$NEAR_SANDBOX_BINARY_PATH" --strip-components=1
fi

rustc --version
cargo near --version
rustup target list --installed
node --version
"$NEAR_SANDBOX_BINARY_PATH/near-sandbox" --version
npm ci --ignore-scripts --no-audit --no-fund
cargo fmt --all -- --check
cargo fmt --manifest-path prover/Cargo.toml --all -- --check
cargo near build non-reproducible-wasm --locked --no-abi
cargo near build non-reproducible-wasm --locked --no-abi --features mock-token --out-dir target/mock
cargo test --locked --lib
cargo test --locked --manifest-path prover/Cargo.toml --release
cargo build --locked --manifest-path prover/Cargo.toml --release
npm run sandbox

