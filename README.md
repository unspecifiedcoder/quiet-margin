# Quiet Margin — Private Perps on NEAR

Quiet Margin is a native NEAR testnet exchange for confidential
BTC/mock-USDC long positions. Opens, voluntary closes, and keeper
liquidations are gated by Groth16 proofs checked on chain through the NEP-488
BLS12-381 host functions. A keeper can liquidate an eligible position while
the trader is offline.

## Judge path

Start with the [judge guide](JUDGES.md) for the demo video, public explorer links, and commands to verify the result.

The [Shielded Pool](docs/SHIELDED-COLLATERAL.md) adds a shared testnet market at `/shielded`. The connected NEAR wallet deposits mock USDC, and a separate private trading key can spend part of that balance as margin.

| Path | What it is | Needs |
| --- | --- | --- |
| [A. Testnet app](#a-testnet-app-real-browser-workflow) | The real consumer app signing real testnet transactions | A local funded coordinator, which needs **operator setup** (keys judges don't have) |
| [B. Credential-free evidence](#b-credential-free-evidence) | Read-only replay of recorded testnet transactions plus a strict receipt check against public RPC | Node 22, no install, **no credentials** |
| [C. Reproduce from source](#c-reproduce-from-source-linux-sandbox) | Build everything and run the funded scenario in a local NEAR Sandbox | Linux x86-64 toolchain, **no credentials** |

### A. Testnet app (real browser workflow)

The consumer app lives in [`exchange/`](exchange/). Its **Private wallet**
route (`?wallet=burner`) is the current workflow:

1. **Burner.** Create a NEAR testnet burner wallet in the browser, or
   **recover** one from a local backup file.
2. **Sign.** Sign the shown text locally. This sends no transaction. A new
   burner offers an optional backup download.
3. **Deposit** mock mUSDC into the session's market (signed in the browser).
4. **Open** a long. The browser proves `open` locally and submits it.
5. **Close** at a fresh oracle mark (proved locally), then **withdraw**.

The coordinator that provisions and funds each session runs locally and needs
the operator's `.env` and proving keys, so judges can't run this path without
the operator. The demo video and the explorer links in
[JUDGES.md](JUDGES.md#first-look) show it instead.
[docs/EXCHANGE.md](docs/EXCHANGE.md) has the walkthrough, disclosures, and
operator setup (Node 22.12 or later).

**Earlier recorded run** (default route, before the burner wallet) at
`milestone/exchange-funding` (`9211f49`). The run used a local coordinator
and Edge. The browser was the trader's only signer, and the market was
keyless. It covered deposit, a user-chosen long open, close at a profit,
withdraw, a second open, and liquidation by a separate keeper after the
browser tab was closed. The final balances reconciled with zero bad debt.
Transaction links are in
[docs/EXCHANGE.md](docs/EXCHANGE.md#verified-local-testnet-run).

Limits of that run include long-only mock assets and a local instance on
testnet. The same operator ran the maker, oracle, and both keepers. The
Shielded Pool is a separate market with its own limits and receipts.

Original milestone tags and source revisions from the working repository.

| Layer | Tag | Commit |
| --- | --- | --- |
| 0: native testnet | `milestone/native-testnet` | `0413bd2` |
| 0: judge evidence | `milestone/judge-evidence` | `8911974` |
| 1: browser exchange | `milestone/exchange-funding` | `9211f49` |
| 2: burner wallet and recovery | `milestone/burner-wallet` | `908bb33` |

### B. Credential-free evidence

Recorded evidence from the earlier operator-driven testnet run. It is **not
the app**. Node 22 on Windows or Linux, no install step:

```text
node scripts/serve-demo.mjs                       # read-only replay at http://127.0.0.1:8787/
node scripts/verify-demo-receipts.mjs --strict    # check every replayed receipt against public RPC
```

The replay serves only [`demo/`](demo/) on loopback. It never signs, never
reads live state, and cannot create trades. The verifier needs no keys and
sends only read-only public RPC queries. It checks hashes, `FINAL` status,
signers, receivers, methods, listed public arguments, failure reasons, event
logs, oracle state at execution, Wasm hashes, roles, verifying-key
fingerprints, and final ledger balances. A complete run ends with
`96 passed, 0 failed, 0 skipped`; `--strict` makes any archival `SKIP` fail.
The 96/96 result was recorded at both layer 0 tags. Details are in
[JUDGES.md](JUDGES.md#2-check-the-receipts-yourself-1-minute).

### C. Reproduce from source (Linux Sandbox)

On Ubuntu 24.04 x86-64 with rustup, Node 22.10.0, npm, curl, and tar, from a clean
checkout:

```bash
bash scripts/sandbox.sh
```

The script downloads checksum-pinned cargo-near 0.23.0 and NEAR Sandbox
2.14.0, builds the native Wasm contracts and the Rust prover, runs the funded
keeper-failover scenario in a local Sandbox, then runs the Rust suites. It
needs no wallet, RPC key, or external feed. The pinned Sandbox binary needs Linux x86-64 with glibc 2.39 or newer. The fixture is synthetic, and Sandbox-only proving and keeper keys
live in a temporary directory. Evidence (public proofs, receipts, Wasm and
verifying-key hashes, timings, ledger snapshots) goes to
`.sandbox/evidence.json`; [`docs/SANDBOX-EVIDENCE.md`](docs/SANDBOX-EVIDENCE.md)
records a reviewed run.

Provenance, not part of the judge path: the same command runs in the
repository's [Sandbox workflow](.github/workflows/sandbox.yml). A run recorded
while the repository was private is
[actions/runs/43179059728](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43179059728).

## What the public can see

- The open transaction includes a nonce, salted commitment, keeper
  acknowledgments, and proof. The staging transaction stores two keeper
  ciphertexts. Neither publishes the plaintext size, entry, or margin.
- The fixed 600 mUSDC escrow, oracle rounds and prices, accounts, settlement
  amounts, and withdrawals are **public**.
- The **maker** sees size and entry off chain so it can price the quote.
- Both **keepers** can decrypt the full witness, including margin, so either
  can liquidate alone. They are trusted to keep it private.
- **Settlement may allow inference.** Public refunds, marks, and the maker's
  price band can narrow or fix hidden values after a close or liquidation
  ([JUDGES.md](JUDGES.md#5-threat-model-and-limits)).

## Hackathon changes and prior work

The Xythum EVM `Xythum-Labs/darkpool-gateway` at
`e5cbe25965ec546ac6e691704d9c176137cf561c` was a **read-only design
reference**. No Solidity contracts or circuits were reused. The exchange UI
reuses its layout and visual language only; the headers of
[`exchange/src/ui/exchange.js`](exchange/src/ui/exchange.js) and
[`exchange/src/ui/exchange.css`](exchange/src/ui/exchange.css) list the
source files ([design provenance](docs/EXCHANGE.md#design-provenance)).

New in this repository:

| Area | Source |
| --- | --- |
| NEAR clearing contract and on-chain Groth16 verifier | [`src/lib.rs`](src/lib.rs), [`src/verifier.rs`](src/verifier.rs) |
| Proof statements, reference model, native prover | [`prover/src/circuit.rs`](prover/src/circuit.rs), [`prover/src/model.rs`](prover/src/model.rs), [`prover/`](prover/) |
| Browser prover | [`prover/browser/`](prover/browser/) |
| Consumer app, burner wallet, coordinator | [`exchange/src/`](exchange/src/), [`exchange/src/ui/burner.js`](exchange/src/ui/burner.js), [`exchange/server/`](exchange/server/) |
| Keeper actors, Sandbox and testnet runners | [`tests/`](tests/), [`scripts/`](scripts/) |
| Replay and receipt verifier | [`demo/`](demo/), [`scripts/verify-demo-receipts.mjs`](scripts/verify-demo-receipts.mjs) |

The root commit contains the [NEAR Basic Auction starter](https://docs.near.org/tutorials/auction/basic-auction) imported before implementing Quiet Margin. Compare it with this checkout to see the NEAR work built for the hackathon.

```text
git diff $(git rev-list --max-parents=0 HEAD) HEAD
```

- [Testnet exchange: recorded run, user and operator guide](docs/EXCHANGE.md)
- [Browser prover build and smoke tests](prover/browser/README.md)
- [Funded market specification](docs/FUNDED-MARKET.md)
- [Testnet addresses and local credential locations](docs/TESTNET-ADDRESSES.md)
- [Original Sandbox specification](docs/SPEC.md)
- [Build decisions](docs/DECISIONS.md)
- [Verified Sandbox evidence](docs/SANDBOX-EVIDENCE.md)
- [Submission checklist and recording](docs/SUBMISSION-CHECKLIST.md)

## License

[MIT](LICENSE), proposed for the public release.
