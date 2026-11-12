# Xythum NEAR Perps

Native NEAR testnet exchange for confidential BTC/mock-USDC long positions.
The protocol supports funded voluntary close and keeper liquidation.

## Testnet exchange

The consumer app lives in `exchange/`. Nothing happens until the visitor
clicks Start. Then the browser creates its own key and gets its own trader
account and market on NEAR testnet. The visitor deposits mock mUSDC, proves a
position locally, opens it, and closes or withdraws. Every step links to its
receipt on testnet.
**[docs/EXCHANGE.md](docs/EXCHANGE.md)** covers the recorded run, the user
walkthrough, privacy disclosures, and operator setup (Node 22.12 or later).

**Status: one full local run against NEAR testnet has been recorded** at
`milestone/exchange-funding` (`9211f49`). The run used a local coordinator
and Edge. The browser was the trader's only signer, and the market was
keyless. It covered deposit, a user-chosen long open, close at a profit,
withdraw, a second open, and liquidation by a separate keeper after the
browser tab was closed. The final balances reconciled with zero bad debt.
Transaction links are in
[docs/EXCHANGE.md](docs/EXCHANGE.md#verified-local-testnet-run).

Limits of that run: long-only mock assets on testnet, no hosted instance, and
no mainnet. The maker, oracle, and both keepers shared one operator's keys,
so it was not an independent-operator trial. Shorts, margin edits, multiple
slots, and shielded notes are planned as separate later layers.

| Layer | Tag | Commit |
| --- | --- | --- |
| 0: native testnet | `milestone/native-testnet` | `0413bd2` |
| 0: judge evidence | `milestone/judge-evidence` | `8911974` |
| 1: browser exchange | `milestone/exchange-funding` | `9211f49` |

## Evidence: judges start here

[JUDGES.md](JUDGES.md) is the short guide. The replay below is recorded
evidence from the earlier operator-driven testnet run. It is not the app. It
is kept unchanged as the fallback if the live exchange can't be run. Its
96/96 live receipt checks still pass at both layer 0 tags.
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

- [Testnet exchange: recorded run, user and operator guide](docs/EXCHANGE.md)
- [Browser prover build and smoke tests](prover/browser/README.md)
- [Funded market specification](docs/FUNDED-MARKET.md)
- [Testnet addresses and local credential locations](docs/TESTNET-ADDRESSES.md)
- [Original Sandbox specification](docs/SPEC.md)
- [Build decisions](docs/DECISIONS.md)
- [Verified Sandbox evidence](docs/SANDBOX-EVIDENCE.md)
- [Submission checklist and recording shot list](docs/SUBMISSION-CHECKLIST.md)

## License

[MIT](LICENSE), proposed for the public release.
