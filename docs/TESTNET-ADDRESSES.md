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
The proving keys used by this deployment live in `.testnet/proving/` after
deployment. Preserve `.env` and that directory together to rerun the demo
with the same accounts and verifier. Keep the signing keys private.

The public testnet RPC is `https://test.rpc.fastnear.com`. The demo uses
mock collateral and a test-controlled oracle.

## Deployment and replay

The account keys are already provisioned. To verify the accounts or
provision any remaining subaccounts, run `node scripts/provision-testnet.mjs`.

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
