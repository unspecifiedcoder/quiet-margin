# NEAR testnet demo addresses

The dedicated demo account is `xythum-perps-demo.testnet`. Its sponsored
creation transaction was
`5vWVRkacDsZqW76oxV1NxRs9pWZzuaXtjj5hHpzNeudh`. The following accounts
exist on NEAR testnet and their full-access keys were verified by final RPC
queries.

| Role | Account ID | Signing variable in local `.env` |
| --- | --- | --- |
| Demo parent and mock-token mint recipient | `xythum-perps-demo.testnet` | `NEAR_DEMO_SECRET_KEY` |
| Clearing contract | `market.xythum-perps-demo.testnet` | `NEAR_MARKET_SECRET_KEY` |
| Mock USDC contract | `musdc.xythum-perps-demo.testnet` | `NEAR_TOKEN_SECRET_KEY` |
| Trader | `trader.xythum-perps-demo.testnet` | `NEAR_TRADER_SECRET_KEY` |
| Maker | `maker.xythum-perps-demo.testnet` | `NEAR_MAKER_SECRET_KEY` |
| Deterministic test oracle | `oracle.xythum-perps-demo.testnet` | `NEAR_ORACLE_SECRET_KEY` |
| Keeper A | `keeper-a.xythum-perps-demo.testnet` | `NEAR_KEEPER_A_SECRET_KEY` |
| Keeper B | `keeper-b.xythum-perps-demo.testnet` | `NEAR_KEEPER_B_SECRET_KEY` |

The project-root `.env` contains the account IDs, testnet signing keys,
and both keepers' encryption and acknowledgment keys. It is Git-ignored.
The provisioning journal `.testnet/accounts.json` records public access keys.
The proving keys used by this deployment live in `.testnet/proving/` after
deployment. Preserve `.env` and that directory together to rerun the demo
with the same accounts and verifier. Keep the signing keys private.

The public testnet RPC is `https://test.rpc.fastnear.com`. The demo uses
mock collateral and a test-controlled oracle.

## Deployment and replay

The account keys are already provisioned. To verify the accounts or
provision any remaining subaccounts, run `node scripts/provision-testnet.mjs`.
Add `--top-up-signers` to replenish the demo role balances from the parent's
test NEAR before a later run.

Build the deployable Wasm and prover from the repository root:

```text
npm ci --ignore-scripts
cargo near build non-reproducible-wasm --locked --no-abi
cargo near build non-reproducible-wasm --locked --no-abi --features mock-token --out-dir target/mock
cargo build --locked --manifest-path prover/Cargo.toml --release
node scripts/testnet-demo.mjs deploy
node scripts/testnet-demo.mjs run
```

The deployment command verifies any existing code and keys. The demo command
opens and settles new positions on an empty, funded market and records its
transactions in `.testnet/demo-<starting-nonce>.json`. Public deployment and
fixture receipts will be recorded here after verification.

If a run stops with an active built-in demo position, run
`node scripts/testnet-demo.mjs resume-active` to settle it using the matching
fixture and save a recovery journal. Settlement leaves the resulting balances
claimable through `withdraw`.

## Verified testnet deployment

The contracts are deployed and initialized on NEAR testnet. The deployed
market source is the reviewed `ee2aa7c` contract. The testnet runner used
the same code with the signer gas budget recorded in `0686c94`.

| Deployment | Final transaction |
| --- | --- |
| Clearing contract and verifier initialization | `Ggk4jPYwAHhBvJ9x5hLMRvsG9YUA4M1T3JzkuihEjJLf` |
| Mock USDC deployment and mint | `6FdjkqQKbnk62QuBWVmybeNjgZccz4H4XqhHvxaZTqKR` |

- Market domain, Base64 `xBGQVL1fFbYws/wyAEhC+DCAh23EHzOYt0NVtTAqxiM=`
- Deployment ID, Base64 `ZWr2mhFGqdZePtgDGg94LIxI3Zqm2dS/dvZRHMqCVKk=`
- Clearing Wasm SHA-256 `9004770854c3d3a1aa8c71d7a19d258fac568abb41cda1dd2ad1827b5c80db7c`
- Mock token Wasm SHA-256 `ed4ffe1bcf2af0bab19278c4a3c10a24bae0c625245511cf324350a6daae6477`

The deployed verifying-key SHA-256 fingerprints are Base64.

| Proof | Fingerprint |
| --- | --- |
| Open | `3sesQDTxpTB6+wdunP8crHc4Hnxv9V4TQqFQiBKIsDA=` |
| Close | `66lAStu/S3ID1d4pkYQEJHubw9EGWDNIO+giKUDfcIs=` |
| Liquidation | `hvfOfFq80ldBwlvMRH7dEgQfqvUeULcKpYIjnabxyOg=` |

## Verified testnet lifecycle

| Step | Final transaction | Observed result |
| --- | --- | --- |
| Trader deposit | `EwmGiURcyHe9nW8ZWwL1iEdSwgerX9eycPh3fnC5cqHi` | 600 mUSDC credited |
| Maker deposit | `3yjK8ZpPR7aLoWs5tMxQHsXg4KRu8k3cnCDwgvzomQzs` | 1,000 mUSDC funded the vault |
| First private open | `NuRmmJTDPeitF1rcNPU2JowbUhhGACPA4LGPN6mq7rk` | Nonce 1 active at funding checkpoint 0 |
| Profitable close | `DXm8nbNxBHoGjSUeYho6WnC8vMBb1UmJG3pn24CaNowE` | 798 mUSDC claimable, including 198 mUSDC profit after funding |
| Trader payout | `DxWVg4roKapKVAwD5mGZafQCGbwgVqdTodLEjqFrPV2J` | 198 mUSDC transferred from the market to the trader |
| Second private open | `5CNs5rAr7KLh8yfTHkMY2dQ9c8zrMtJ22eM3B4xJT1c7` | Nonce 2 active at funding checkpoint 200 cents |
| Healthy liquidation attempt | `GsbCfnM5Z8dyHgPV9VT5ns75HWkfxsmtD3ynYZZVBTpW` | `ERR_PROOF_INVALID` at the $70,000 mark |
| Cold Keeper B liquidation | `BDRSCJmvMfzCGwtsbtgvwpd1CKaqpZkmFcTj7Gwu7MYW` | Nonce 2 settled at $52,000 while the trader and Keeper A were offline |
| Replay | `BnTNBAHZHHG4rMh6keQ77ead2TdGfTVXyfDNrecpQek5` | `ERR_NO_ACTIVE` |
| Keeper payout | `6Cg85J5iVzdd9QT12FSFSKFafbiTSQkdKfc6zLJtZB1m` | 1 mUSDC transferred to Keeper B |

The five oracle rounds used BTC marks of $100,000, $120,000, $100,000,
$70,000, and $52,000. The funding index advanced through 0, 200, 200, 400,
and 400 cents. The final RPC read found an empty active slot, a 117 mUSDC
trader claim, a 1,284 mUSDC maker vault, and zero debt or pending withdrawals.
The market held 1,401 mUSDC, the trader wallet held 198 mUSDC, and Keeper B
held 1 mUSDC. The successful close burned 22.370 Tgas and the successful
liquidation burned 22.383 Tgas, including transaction receipts.

The local public journals are `.testnet/deployment.json` and
`.testnet/demo-1.json`. For the simultaneous close-versus-liquidation
race and negative cases, see the [reviewed Sandbox run](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43173872146)
and its [receipt artifact](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43173872146/artifacts/13923741437).
In that run, liquidation won and close returned `ERR_NO_ACTIVE`.
The [pre-deployment review](TESTNET-REVIEW.md) records the testnet scope and
the remaining production-readiness limits.
