# Xythum NEAR Perps

Native NEAR Sandbox prototype for confidential BTC/mock-USDC liquidation.

## Run the Sandbox suite

On Linux x86-64 with rustup, Node 22.10.0, npm, curl, and tar:

```bash
bash scripts/sandbox.sh
```

The script builds the native Wasm contracts and the Rust prover, starts a
local NEAR Sandbox, and runs the funded keeper-failover scenario. The private
GitHub Actions workflow runs the same command from a clean checkout. Windows
can build the Wasm with cargo-near 0.23.0, but the pinned Sandbox executable is
built for Linux. The Sandbox run needs no wallet, RPC key, or external feed.

The JSON evidence is written to `.sandbox/evidence.json` and uploaded by CI.
It includes public proof and receipt data, Wasm and verifying-key hashes,
timings, and ledger snapshots. Sandbox-only proving keys and keeper keys
live in a temporary directory for the run. The fixture is synthetic.

- [Sandbox specification](docs/SPEC.md)
- [Build decisions](docs/DECISIONS.md)
