# Xythum EVM contract map for Quiet Margin

This inventory covers the pinned Xythum Labs source at
`e5cbe25965ec546ac6e691704d9c176137cf561c`. It separates the contracts
referenced by the checked-in Ignition deployments from the alternate
implementations, libraries and interfaces in the source tree.
[Pinned source](https://github.com/Xythum-Labs/darkpool-gateway/tree/e5cbe25965ec546ac6e691704d9c176137cf561c/contracts) ·
[Deployment module](https://github.com/Xythum-Labs/darkpool-gateway/blob/e5cbe25965ec546ac6e691704d9c176137cf561c/contracts/ignition/modules/DeployPerpDex.ts)

| EVM deployment component | Role in Xythum | Quiet Margin equivalent and gap |
| --- | --- | --- |
| `ClearingHouseV2` | Public position storage, collateral, long/short trades, margin changes and liquidation | Native NEAR clearing contract in [src/lib.rs](../src/lib.rs). It uses a fixed escrow, funded maker vault and proofs for open, close and liquidation. One long per market is supported. Shorts, margin edits, multiple positions and a public trading mode would need changes to the market and its risk rules. |
| `PrivacyProxy` | Holds clearing positions and free collateral on behalf of pseudonymous keys and checks signatures authorizing operations | [Connected wallet](../exchange/src/protocol/connected-wallet.js) derives a separate NEAR trader key. The market accepts proof-bound commitments and keeper envelopes. A Solidity-style proxy would not supply a shared collateral pool. A scoped adapter could become useful if pool and market live in separate contracts. |
| `TokenPool` | Shielded ERC-20 notes with deposits, claims, transfers, withdrawals, Merkle roots and spent nullifiers | The current NEP-141 transfer goes directly to named market escrow. The experimental shielded collateral branch has a two-note spend relation. It still needs custody, token amount binding, note recovery, a root/nullifier ledger and integration with open, close, liquidation and exits. |
| `ClaimHonkVerifier` | Verifies a note claim | [NEAR Groth16 verifier](../src/verifier.rs) supplies verification for the three trading proofs. The note claim needs its own defined authorization and, if the pool design uses a separate claim, its own proof statement. |
| `WithdrawTransferHonkVerifier` | Verifies a private transfer or withdrawal against pool state | The current withdrawal pays a public claimant with a ledger balance. A shared pool needs a proof-based exit and a private change or settlement note, with explicit withdrawal recipient and amount. |
| `Poseidon2` | Linked hash library used by the note pool | The current market and experimental note relation use SHA-256. Choose a hash that the NEAR contract and the note circuit can both reproduce within the measured gas and proving budget. Porting Poseidon2 is optional. |
| `Oracle` | Role-gated BTC price storage | The NEAR clearing contract exposes `publish_oracle` and `get_oracle`. The exchange displays Binance spot and the coordinator publishes a signed mark for the connected demo. Independent price attestation and continuous publishing for offline liquidation in the live market remain separate work. |
| `MockERC20` | Mock USDC with role-gated minting | [Mock NEP-141 token](../src/mock_token.rs). The maker vault funds payouts from test tokens. Real collateral would need a designated NEP-141 asset and a custody and solvency design. |
| `PublicFaucet` | Mints mock tokens to the transaction origin, with a 10,000-token cap per request | [Capped NEAR faucet](../exchange/server/coordinator.mjs) verifies the connected account and sends one 600 mUSDC grant to the separate trader. The operator sees both identities. The planned shared-pool demo can fund the connected public wallet first and let it sign each deposit. |

The deployment module uses the deployer as the pool entry point.
`EntryPoint` in `Entrypoint.sol` can route deposits, claims, transfers and
withdrawals to asset pools. It is relevant if Quiet Margin adds multiple
shielded assets. `EthPool` handles native ETH notes, so the first
NEP-141 collateral market has no corresponding requirement.

The earlier minimal `ClearingHouse` and `vAMM` are outside that
deployment. The `dump/perp-dex` tree contains another `ClearingHouse`,
`PositionLedger`, `VirtualAMM` and `MockPriceOracle`. Quiet Margin keeps
the position ledger in its clearing contract and prices against its oracle
and maker quote. It needs a virtual AMM only if the execution design changes.

The rest of the contract tree consists of supporting code:

- Pool interfaces `IAssetPool`, `IDefiAdaptor`, `IEntryPoint`, `IVerifier`
  and the test contract `TestMerkleTree`.
- Hashing and proof helpers `EllipticCurve`, `MerkleTreeLib`, `Pedersen`,
  `Field`, `Poseidon2Lib` and `ProofLib`.
- Older market interfaces `IClearingHouse`, `IPositionLedger`, `IPriceOracle`,
  `IVirtualAMM` and arithmetic helper `SafeDecimalMath`.
- The standalone generated `contracts/verifier.sol` contains `HonkVerifier`,
  `BaseHonkVerifier`, its interface and Honk libraries. The deployment
  references the two named note verifiers under `contracts/contracts/darkpool`.

Xythum's Position Explorer is a frontend backed by its indexer. Its private
trading mode changes which account owns the position in the clearing house.
The baseline still emits the size, margin, side and entry. Its frontend also
submits the proxy call from the connected EVM account. Quiet Margin's
Position Explorer reads public NEAR state, and its trade calls are signed
by the separate trader. The exact margin and size are committed at open.
The public mark, escrow and settlement can still reveal information.
[Xythum Explorer](https://github.com/Xythum-Labs/darkpool-gateway/blob/e5cbe25965ec546ac6e691704d9c176137cf561c/frontend/src/pages/ExplorerPage.tsx) ·
[Xythum trade submission](https://github.com/Xythum-Labs/darkpool-gateway/blob/e5cbe25965ec546ac6e691704d9c176137cf561c/frontend/src/components/TradingPanel.tsx)

For incremental user funding, the next contract milestone is a shared
NEP-141 pool with note membership, nullifiers, conserved value, private
change and a tested exit. It also needs settlement back into a spendable
note while the trader is offline. For exchange feature parity, public mode,
shorts and margin adjustments are distinct additions. A public history feed
can be indexed off chain and linked to receipts without adding a contract.
