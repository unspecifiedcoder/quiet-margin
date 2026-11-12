# Xythum NEAR Perps

Native NEAR testnet exchange for confidential BTC/mock-USDC long positions.
The protocol supports funded voluntary close and keeper liquidation.

## Testnet exchange

The consumer app lives in `exchange/`. Each visitor's browser creates its own
key and gets its own trader account and market on NEAR testnet. The visitor
then deposits mock mUSDC, proves a position locally, opens it, and closes or
withdraws. Every step links to its receipt on testnet.
**[docs/EXCHANGE.md](docs/EXCHANGE.md)** covers the user walkthrough,
privacy disclosures, and operator setup.

Status: the app is still being integrated. No end-to-end browser run on testnet
has been recorded yet, and there is no public hosted instance. The app
uses testnet only, with mock collateral and no real assets.

## Evidence: judges start here

[JUDGES.md](JUDGES.md) is the short guide. The replay below is recorded
evidence from the earlier operator-driven testnet run. It is not the app.
It needs Node 22 on Windows or Linux and no install step:

```text
node scripts/serve-demo.mjs               # static testnet replay at http://127.0.0.1:8787/
node scripts/verify-demo-receipts.mjs     # read-only check of every replayed receipt
```

The replay serves only [`demo/`](demo/) on loopback. It is read-only: it never
signs or reads live state and cannot create trades. The verifier needs no keys and only sends public RPC queries.

## Run the Sandbox suite

On Linux x86-64 with rustup, Node 22.10.0, npm, curl, and tar:

```bash
bash scripts/sandbox.sh
```

The script builds the native Wasm contracts and the Rust prover, starts a
local NEAR Sandbox, and runs the funded keeper-failover scenario. The private
[Sandbox workflow](.github/workflows/sandbox.yml) runs the same command from a
clean checkout; a freshly verified run is
[actions/runs/43179059728](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43179059728).
A clean Linux checkout is the reproducible alternative. Windows
can build the Wasm with cargo-near 0.23.0, but the pinned Sandbox executable is
built for Linux. The Sandbox run needs no wallet, RPC key, or external feed.

The JSON evidence is written to `.sandbox/evidence.json` and uploaded by CI.
It includes public proof and receipt data, Wasm and verifying-key hashes,
timings, and ledger snapshots. Sandbox-only proving keys and keeper keys
live in a temporary directory for the run. The fixture is synthetic.

- [Testnet exchange: user and operator guide](docs/EXCHANGE.md)
- [Funded market specification](docs/FUNDED-MARKET.md)
- [Testnet addresses and local credential locations](docs/TESTNET-ADDRESSES.md)
- [Original Sandbox specification](docs/SPEC.md)
- [Build decisions](docs/DECISIONS.md)
- [Verified Sandbox evidence](docs/SANDBOX-EVIDENCE.md)
- [Submission checklist and recording shot list](docs/SUBMISSION-CHECKLIST.md)

## License

[MIT](LICENSE), proposed for the public release.
