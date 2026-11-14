# Quiet Margin | Shielded BTC Perpetuals on NEAR

Trading on a public ledger can expose position size, direction, and margin before a trade settles. Quiet Margin lets a trader open a BTC long or short with shielded test collateral on NEAR. A backup keeper can liquidate an under-margined position while the trader is offline.

The browser generates Groth16 proofs for trader actions. The NEAR contract verifies proofs with the NEP-488 BLS12-381 host functions, applies the on-chain mark, and settles balances. The testnet build uses mock USDC (mUSDC).

## Start here

**[Watch the 2:41 demo](docs/media/quiet-margin-judge-demo.mp4)** · [English captions](docs/media/quiet-margin-judge-demo.srt) · [All 16 transactions and blocks](docs/QUIET-MARGIN-DEMO.md)

| In the video | What to check |
| --- | --- |
| 0:09–0:30 · Connect and deposit | A connected NEAR wallet signs to unlock a separate trading key. The public deposit adds 100 mUSDC to the shielded balance. |
| 0:30–1:10 · Open and inspect | The live BTC/USDT publisher posts a $68,820 mark. The trader opens a 0.001 BTC short with 30 mUSDC margin and 70 mUSDC available. The public open shows the mark and proof. |
| 1:10–1:32 · Close | The short closes at the same mark. The shielded balance returns to 100 mUSDC and the public wallet stays at 21 mUSDC. |
| 1:32–1:45 · Withdraw | The trader sends 10 mUSDC to the connected public address. The balances become 90 shielded and 31 public. |
| 1:45–2:41 · Test liquidation | In a separate pool running the same contract code, NEAR rejects healthy long and short attempts. After controlled price moves, Keeper B settles both while the trader is offline. |

### Verify without a wallet

1. From the repository root, run the command below with **Node.js 22+** and internet access. It needs no package installation or credentials.
2. Expect two `PASS` lines covering 16 finalized NEAR testnet transactions, their inclusion blocks, the trade and withdrawal, and both keeper outcomes.
3. In the [explorer evidence](docs/QUIET-MARGIN-DEMO.md), compare each rejected liquidation with the accepted call for the same position commitment. The rejected calls return `ERR_PROOF_INVALID`. The accepted calls emit `position_liquidated` and show Keeper B as signer.

```sh
node scripts/verify-judge-demo.mjs
```

### Reproduce the keeper scenario locally

On Ubuntu 24.04 x86-64 with glibc 2.39+, rustup, Node.js 22.10.0, npm, curl, and tar:

```bash
bash scripts/sandbox.sh
```

The script builds the NEAR contracts and prover, runs the original funded long-market scenario in NEAR Sandbox, and runs Rust tests. It uses synthetic test data and local keys. Look for the healthy liquidation rejection and backup keeper success in `.sandbox/evidence.json`. The separate [Shielded Pool testnet verifier](docs/QUIET-MARGIN-DEMO.md#verify-from-a-checkout) covers the recorded long and short.

### Try a trade in a running testnet session

Open the [hosted testnet exchange](https://quietmargin.outcomeseal.com/shielded?pool=live) in a desktop browser. See the [judge walkthrough and hosted receipts](docs/HOSTED-JUDGE-WALKTHROUGH.md) and the [hosting configuration](exchange/deploy/shielded/).

1. Connect a NEAR testnet wallet and sign the unlock message. The app derives the separate trading key for that wallet and site.
2. Claim test funds if enabled, then deposit 100 mUSDC from the connected wallet. The shielded balance increases by 100.
3. Choose 0.001 BTC and 30 mUSDC of isolated margin at a mark within the ticket’s 3× cap. Open a private short. NEAR confirms the proof and the balance shows 70 mUSDC available.
4. Close to return proceeds to the shielded balance. A withdrawal is optional. Its amount and recipient are visible in the standard NEAR token transfer.

## Privacy and operating limits

- **Open:** The public call contains a separate signer, an entry mark, commitments, and a proof. It omits plaintext direction, exact size, and margin. Public funding and timing can help correlate activity.
- **Settlement:** A close or liquidation can create a new shielded note. Public maker accounting and price moves can reveal P&L and sometimes help infer position terms. Ordinary withdrawals publish the recipient and amount.
- **Keepers and prices:** Both designated keepers verify encrypted copies at open and can read the position terms. Either can settle an eligible liquidation alone. One trusted publisher relays live Binance BTC/USDT data to the live test pool. A controlled mark in the separate test pool makes liquidation repeatable.
- **Scope:** The testnet prototype uses one BTC market, isolated margin with a 3× cap, mock collateral, and a funded maker vault.

## Hackathon changes and prior work

The starting point was the [NEAR Basic Auction tutorial](https://github.com/near-examples/auctions-tutorial/tree/main/contract-rs/01-basic-auction), recorded in the [baseline commit](https://github.com/unspecifiedcoder/quiet-margin/commit/2cce65a). The pre-existing Xythum EVM project was a design reference. The trading UI adapts its layout and visual language. The NEAR contracts and circuits were built in this repository during the hackathon. [Hackathon diff](https://github.com/unspecifiedcoder/quiet-margin/compare/2cce65a...main) · [UI provenance](docs/EXCHANGE.md#design-provenance)

| Built for NEAR | Source |
| --- | --- |
| Shielded pool, margin settlement, and native verification | [Pool contract](src/shielded_pool.rs), [verifier](src/verifier.rs) |
| Groth16 proof statements and browser prover | [Pool circuits](prover/src/pool_fast.rs), [browser build](prover/browser/README.md) |
| Wallet connection, trading UI, and operator services | [Exchange](exchange/), [keeper services](exchange/server/pool-keepers.mjs) |
| Testnet evidence and local reproduction | [Demo receipts](docs/QUIET-MARGIN-DEMO.md), [Sandbox evidence](docs/SANDBOX-EVIDENCE.md) |

Libraries and tools include NEAR SDK, near-workspaces, Arkworks, wasm-bindgen, NEAR Connect, and Vite. Claude Code and Codex assisted with implementation, review, and verification. Dependency versions are pinned in the lockfiles.

[Detailed judge guide](JUDGES.md) · [Submission checklist](docs/SUBMISSION-CHECKLIST.md) · [MIT license](LICENSE)
