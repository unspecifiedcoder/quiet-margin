# Quiet Margin judge guide

Quiet Margin is a native NEAR clearing contract for a confidential
BTC/mock-USDC long position. The open transaction carries no plaintext exact
size, entry, or margin. Staging stores encrypted openings for the keepers.
The [privacy limits](#5-threat-model-and-limits) cover what the maker, keepers,
and public observers can learn. Groth16 proofs, checked on chain through the NEP-488
BLS12-381 host functions, gate opening, voluntary close, and keeper
liquidation. Either of two keepers can liquidate alone from an encrypted
copy of the opening stored on chain, so liquidation works while the trader
is offline.

## First look

[Watch the Quiet Margin demo](docs/media/quiet-margin-demo.mp4). It shows burner creation, local signing, recovery in a fresh browser, deposit, open, close, and withdrawal. The split view shows the trader terminal beside the explorer for the same open.

### Public testnet explorer

| Run | Step | Link |
| --- | --- | --- |
| Browser burner app | Deposit 600 mUSDC | [Deposit](https://testnet.near.rocks/tx/3XPCMQMkxQnHcRFv5yTBxk4J6zVXPjb3qwCnG9rwF9hd) |
| Browser burner app | Open, signed and proved in the browser | [Open](https://testnet.near.rocks/tx/3yVTY63LVDGnKSzGohorQXfwWeYvoiorZRBvhX1iLi8b) in [block 277375833](https://testnet.near.rocks/block/277375833) |
| Browser burner app | Close, then withdraw 20 mUSDC | [Close](https://testnet.near.rocks/tx/A67nEyP4THpeRruJrLZYf65TupaMWYDA29GGHythGkx6), [withdrawal](https://testnet.near.rocks/tx/EWkWUg8PiUHrJFrvoTDy4aaQheaf96sWi1qZVCC4fVhF) |
| Earlier operator-driven run (replayed below) | Healthy liquidation proof rejected (`ERR_PROOF_INVALID`) | [tx `GsbCfnM5…BTpW`](https://testnet.near.rocks/tx/GsbCfnM5Z8dyHgPV9VT5ns75HWkfxsmtD3ynYZZVBTpW) |
| Earlier operator-driven run (replayed below) | Cold Keeper B liquidation succeeds | [tx `BDRSCJmv…7MYW`](https://testnet.near.rocks/tx/BDRSCJmvMfzCGwtsbtgvwpd1CKaqpZkmFcTj7Gwu7MYW) |

The rejection and the Keeper B success are a pair from the same position in
a separate run from the browser open.

### Try it

1. **Testnet consumer app.** The real app in [`exchange/`](exchange/). Its
   funded coordinator runs locally and needs operator setup and keys, so the
   video and the open link above stand in for it
   ([`docs/EXCHANGE.md`](docs/EXCHANGE.md)).
2. **Credential-free evidence.** Sections 1 and 2: a read-only replay and a
   strict receipt check. Node 22 on Windows or Linux, no install, no keys.
3. **Reproducible source.** Section 3: one Linux command builds everything
   and runs the funded scenario in a local NEAR Sandbox.

## 1. Watch the testnet replay (2 minutes)

```text
node scripts/serve-demo.mjs
```

Open <http://127.0.0.1:8787/>. The server binds to loopback and serves only
the four files in [`demo/`](demo/). It reads nothing else from the repository.

The page steps through the second testnet position: the private open at
$100,000, a liquidation refused at $70,000 because the position is healthy,
cold Keeper B liquidating at $52,000 while the trader and Keeper A are offline,
and the refused replay and bounty payout. The testnet runner resubmitted the
same liquidation arguments, proof included, for the replay
([`scripts/testnet-demo.mjs`](scripts/testnet-demo.mjs#L311)); the receipt
verifier below does not compare proof bytes. Each step shows the synthetic trader
values beside the recorded public transaction, with its hash and NearBlocks
link. Use the tabs, arrow keys, or Previous and Next. `#step-1` to `#step-4`
link to a step.

A separate section shows what a public observer can infer after the profitable
close of the first position: the public refund determines the hidden size and
entry exactly, but not the margin. That holds because the refund shows positive
equity, the gross PnL is below the 600 mUSDC PnL cap, and the maker follows its
off-chain 1% price band, which the contract does not enforce.

Step 1 notes that the runner removed the trader and Keeper A keys from its
in-memory signer after admission. The testnet operator controlled both
keepers, so this shows Keeper B acting alone, not independent operators.

The page is a read-only static replay. It never signs, submits, or reads live
chain state, and it cannot create trades. Values labeled synthetic are the
published fixture from [`tests/actor.mjs`](tests/actor.mjs#L171-L186). In the
testnet run the maker saw size and entry, and the trader and both keepers saw
the full witness. The blinders are random per position and never public in
plaintext.

## 2. Check the receipts yourself (1 minute)

```text
node scripts/verify-demo-receipts.mjs --strict
```

The verifier reads [`demo/receipts.json`](demo/receipts.json), the same
manifest the page renders, and checks it against the public testnet RPC. It
needs no keys and sends only read-only queries. For each listed transaction it
checks that the RPC returned the requested hash, `FINAL` execution status,
signer and receiver, the method and the subset of public arguments listed in
the manifest, the expected failure reason, and the receipt event logs.
Arguments the manifest does not list, including proof bytes and ciphertexts,
are not compared. The separate `stage_position` and maker `approve_quote`
transactions are not in the manifest and are not checked. For opens and
settlements it reads `get_oracle` at the block where the market executed the
call, which shows the oracle round and price the contract used. It also checks
the deployed Wasm hashes, roles, verifying-key fingerprints, and the ledger and
token balance at the market receipt that emitted the final payout's
`withdrawal_resolved` event. Expected output ends with:

```text
PASS healthy_refused        failed in market.xythum-perps-demo.testnet with Smart contract panicked: ERR_PROOF_INVALID
...
PASS keeper_payout          market holds 140100 mUSDC cents

96 passed, 0 failed, 0 skipped
```

Historical views fall back to the FastNEAR archival endpoint. If both
endpoints report the old block as unavailable, that check prints `SKIP`. Any
other error fails. A complete check has 0 skipped; `--strict` makes skips
fail too.

## 3. Reproduce from source in NEAR Sandbox

On Ubuntu 24.04 x86-64 with rustup, Node 22.10.0, npm, curl, and tar, from a clean
checkout:

```bash
bash scripts/sandbox.sh
```

The script downloads checksum-pinned cargo-near 0.23.0 and NEAR Sandbox
2.14.0, builds both Wasm contracts and the Rust prover, runs the funded
Sandbox scenario, and then runs the Rust suites. It needs no wallet, RPC key,
or external price feed. The pinned Sandbox binary needs Linux x86-64 with glibc 2.39 or newer. On
Windows, use Ubuntu 24.04 in WSL or the repository's
[Sandbox workflow](.github/workflows/sandbox.yml). Provenance only: a run
recorded while the repository was private is
[actions/runs/43179059728](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43179059728).
A clean Linux checkout is the reproducible path. The Sandbox scenario prints one JSON summary line, then the Node
test runner reports one passing test. In a terminal it looks like this:

```text
✔ funded close, cold keeper liquidation, and settlement race
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

When output is piped, as in CI, Node prints the same result in TAP form
(`ok 1 - funded close, …` and `# pass 1`, `# fail 0`). Every Rust suite
should end with `test result: ok.` and the script should exit 0. The public proof bytes,
receipts, gas profiles, and ledger snapshots are written to
`.sandbox/evidence.json`. The Sandbox scenario also covers a simultaneous
close-versus-liquidation race, tampered proofs and refunds, wrong root and
domain, stale rounds, failed payout recovery, maintenance equality, and bad
debt. [`docs/SANDBOX-EVIDENCE.md`](docs/SANDBOX-EVIDENCE.md) records a
reviewed run.

## 4. Code walkthrough

| Piece | Where to look |
| --- | --- |
| Reference arithmetic | [`prover/src/model.rs`](prover/src/model.rs#L250-L313): PnL, equity, liquidation test, refund, bad debt, vault update |
| Commitment and quote digests | [`prover/src/model.rs`](prover/src/model.rs#L143-L198) |
| Open circuit | [`prover/src/circuit.rs`](prover/src/circuit.rs#L387-L422): one witness hashed into both digests, leverage and opening health |
| Close and liquidation circuits | [`prover/src/circuit.rs`](prover/src/circuit.rs#L424-L486): shared settlement relation with separate keys |
| Range discipline | [`prover/src/circuit.rs`](prover/src/circuit.rs#L1-L20) and [`enforce_range`](prover/src/circuit.rs#L279-L289) |
| On-chain Groth16 verifier | [`src/verifier.rs`](src/verifier.rs#L1-L20) for encodings, [`verify`](src/verifier.rs#L77) on NEP-488 host functions |
| Oracle, staging, maker approval, open | [`src/lib.rs`](src/lib.rs#L569-L765) |
| Close and liquidate | [`src/lib.rs`](src/lib.rs#L772-L819) |
| Atomic settlement | [`src/lib.rs` `settle`](src/lib.rs#L960-L1058): the contract builds the proof statement from its own oracle and slot, then clears the slot and credits the refund and any keeper bounty as claims in the same receipt. Tokens move later, in separate `withdraw` receipts |
| Claims and callback recovery | [`src/lib.rs`](src/lib.rs#L826-L894) |
| Keeper envelopes and acknowledgments | [`tests/actor.mjs`](tests/actor.mjs#L77-L144) |
| Maker quote check | [`makerApproval`](tests/actor.mjs#L159-L169): 1% price band and exact quote digest |
| Native proof tests | [`prover/tests/proofs.rs`](prover/tests/proofs.rs#L458-L516) (healthy positions are unprovable), [`#L685`](prover/tests/proofs.rs#L685) (close refund) |
| Sandbox scenario | [`tests/sandbox.test.mjs`](tests/sandbox.test.mjs#L272-L310) (healthy refusal and cold Keeper B), [`#L346`](tests/sandbox.test.mjs#L346-L370) (race) |
| Testnet runner | [`scripts/testnet-demo.mjs`](scripts/testnet-demo.mjs#L156-L329) |
| Specifications | [`docs/SPEC.md`](docs/SPEC.md), [`docs/FUNDED-MARKET.md`](docs/FUNDED-MARKET.md) |

## 5. Threat model and limits

- **Public observers** see accounts, the fixed 600 mUSDC escrow and 601 mUSDC
  maker reserve, salted digests, two 144-byte ciphertexts, oracle rounds,
  settlement amounts, and withdrawals.
- **The maker** learns the exact size and entry off chain so it can price the
  quote, then signs an approval bound to the quote digest and opening mark.
  It does not learn the margin or the position blinder.
- **The trader and both keepers** hold the full witness. The keepers decrypt
  it before acknowledging admission,
  so either one can liquidate alone. They are trusted to keep it private and
  to attest honestly.
- **Settlement amounts leak.** In this single-slot market, a refund with
  positive equity after any bounty and PnL below the 600 mUSDC cap fixes the
  gross PnL. If the maker follows its off-chain 1% band, the profitable close
  leaves exactly one size and entry. The margin
  cancels out of the refund. The page derives this from public data only.
- **Demo trust model.** The oracle is a test-controlled account, the
  collateral is a mock token, the Groth16 setup is single-party, and the
  testnet operator controlled both keepers. A stalled oracle leaves a
  position locked. Losing both keeper keys disables keeper liquidation, but
  the trader can still close voluntarily while they keep their witness and a
  fresh oracle round is available. [`docs/TESTNET-REVIEW.md`](docs/TESTNET-REVIEW.md)
  lists the remaining production-readiness items.

## 6. Sources and baseline disclosure

- The EVM reference is Xythum-Labs/darkpool-gateway at
  `e5cbe25965ec546ac6e691704d9c176137cf561c`. It was used read-only as a
  design baseline. That design exposes position parameters in the clearing
  house and uses zero knowledge for note operations. This repository is a new
  native NEAR clearing contract with new proof statements; no Solidity
  contracts or circuits were reused. The exchange UI reuses the baseline's
  layout and visual language only
  ([design provenance](docs/EXCHANGE.md#design-provenance)). The baseline is
  private and was excluded from the implementation worktrees.
  See [`docs/SPEC.md`](docs/SPEC.md#baseline-and-scope) and the
  [README](README.md#hackathon-changes-and-prior-work) for the
  new-code map and a diff command.
- The verifier follows [NEP-488](https://github.com/near/NEPs/blob/master/neps/nep-0488.md).
  The public [Antumbra Groth16 verifier](https://github.com/Valentine1898/antumbra/blob/d684c3e380cb0da47cad16803741cff16861bb8d/contracts/pool/src/groth16.rs)
  was a reference only. No Antumbra code was copied
  ([`prover/src/lib.rs`](prover/src/lib.rs#L6-L11)). Point encodings were
  checked against nearcore's `near-vm-runner`.
- The [NEAR smart-contract agent skill](https://github.com/near/agent-skills/tree/cb32b6af195e636c1e9c2efe2ea75a6d85b6b67b/skills/near-smart-contracts)
  guided the contract review.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) records toolchains and how Claude
  Code and Codex divided authoring and review. The evidence replay, receipt
  verifier, and this guide were drafted with Claude Code (`claude-opus-5-5`)
  for Codex review.
