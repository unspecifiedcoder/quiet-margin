# Native NEAR Sandbox evidence

The [Linux x86-64 run](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43163396217)
passed at commit `962f317cfd4417bd61c266a32427b2f01163947f`. It used native
NEAR Sandbox 2.14.0, protocol 88, Rust 1.95.0, cargo-near 0.23.0,
near-sdk 5.30.1, Arkworks 0.5, Node 22.10.0, and near-workspaces 5.0.0.
All 63 Rust tests passed in the same run. The
[JSON artifact](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43163396217/artifacts/13919053497)
contains the public proof bytes, oracle rounds, gas profiles, and ledger
snapshots.

## Funded failover

The trader locked 60,000 mock cents and the maker funded 100,000 mock cents.
The position had 50,000 cents of private margin. Keeper A and Keeper B each
fetched and decrypted their persisted ciphertext before signing admission.
The trader process exited and the harness removed the trader and Keeper A
transaction signers before liquidation. Keeper B started in a fresh process,
read and decrypted its on-chain copy, generated a proof, and signed the
liquidation transaction.

| Check | Sandbox transaction | Outcome |
| --- | --- | --- |
| Committed open | `HXabK6EKxoPVTpzcmAcVeEPSq3fmopmv2WNqtmzmK7C6` | Opened at oracle round 1 |
| Healthy at $70,000 | `DF6oVtHLNYngUCxc6DNzgiPmEUhSVk26BvoBvaKNDP1C` | `ERR_PROOF_INVALID` in receipt `CfKTgLHcrVzRg9F7yAL9QPcA5Zy8RohhL9QH7ykQi2zg` |
| Distressed at $52,000 | `42XPv4jx33QDzWhheZN8VRpsqQheVN3rTWJ4tBHjZJGV` | Keeper B settled nonce 1 in receipt `3snck1V7B9FV7WEmTUkm7Suh3bRSGWn8czkNz2Yi4kEy` |
| Replay | `5STNXCnMAf56Puup7CHQvzxAhygbCZ27S4caA4dVyW8w` | `ERR_NO_ACTIVE` |
| Failed keeper payout | `3bA9419X3WiGB3wjyjXBtYjPAmseAdQ2DdMeRPCrjBNy` | Token receipt failed and callback restored 100 cents |
| Retried keeper payout | `7v3L8Yw5XtR3eYqgrdtcA7fzGvma7h6HhnuY7GqqRMzX` | Keeper B received 100 cents once |

At the healthy price, the fixture has $198 equity versus $35 maintenance.
At the distressed price, it has $18 equity versus $26 maintenance. The
healthy receipt exercised the BLS host functions against the contract's
current oracle inputs and left the ledger and active slot intact.

At settlement, 11,700 cents became claimable by the trader, including 10,000
unassigned escrow cents. Keeper B accrued 100 cents. The maker vault rose
to 148,200 cents, the active slot cleared, and bad debt stayed at zero.
The 160,000 funded cents reconciled before payout. After payout, the contract
held 159,900 cents and Keeper B held 100 cents.

The suite also rejected missing, undecryptable, mismatched, and incorrectly
acknowledged witness payloads under the trusted-keeper rule. On-chain cases
covered malformed keys, mutated proofs, superseded oracle rounds, a changed
round with identical prices, a wrong root or deployment context, a tampered
refund, unauthorized initialization and callback calls, and replay.

A second market rejected maintenance equality in
`CKDELb7gdgokE9XuoxXvondXoQSDKbbEA4k7khbSLnD5`. A price gap then
liquidated in `5GSAdyz5wnpVDh2Rvw1iJ97rPLXPvMNv73iaxGNLTFAW`. The
ledger recorded 37 cents of bad debt, conserved all funded tokens, and
rejected new staging after the halt.

## Measurements

| Item | Result |
| --- | --- |
| Clearing Wasm | 187,848 bytes |
| Mock token Wasm | 145,532 bytes |
| Ephemeral Groth16 setup | 16.319 s |
| Open proof generation | 2.922 s |
| Liquidation proof generation | 2.981 s |
| Open contract receipt / BLS host functions | 17.629 / 15.339 Tgas |
| Liquidation contract receipt / BLS host functions | 21.817 / 19.989 Tgas |
| Full liquidation transaction | 22.155 Tgas |

The open verifying-key SHA-256 is
`xL3FI37RxHWa1GTlGi+lRnuYC7n6+xFDambm82L9LAI=` in Base64. The
liquidation key SHA-256 is
`Oa/bzOmhDpc0l3Zryemmz8ZTeEsOkrz6yN4NKy8MdQI=`.
New runs generate fresh sandbox-only keys.

Run `bash scripts/sandbox.sh` from a clean checkout on Linux x86-64. The
synthetic openings live in the test harness. The public trace exposes
accounts, commitments, oracle updates, and settlement amounts. The
[specification](SPEC.md) records the inference limits and keeper assumptions.
