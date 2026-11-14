# Try Quiet Margin on NEAR testnet

Use a desktop browser and a NEAR testnet wallet. The exchange uses test NEAR
and mock USDC (mUSDC).

1. Open the [live BTC pool](https://quietmargin.outcomeseal.com/shielded?pool=live).
   Click **Connect Wallet** and select your NEAR testnet wallet.
2. Click **Unlock private wallet** and approve the signature. Use the same
   wallet key and website to unlock this trading key again.
3. Click **Claim test funds** if shown and approve the signature. The hosted
   faucet grants 100 mUSDC and test NEAR while its allocation lasts.
4. Set **Deposit amount** to `100`, click **Deposit to pool**, and confirm the
   transaction in your NEAR wallet. Check that **Shielded balance** shows 100.
5. Set **Margin** to `30` and **Size (BTC)** to `0.001`. Click
   **Open private short** and wait for confirmation. The shielded balance
   should show 70 mUSDC available and the position should show 30 mUSDC margin.
   If the mark changes during proving, retry with the refreshed mark.
6. Click **Close position**. The shielded balance receives the remaining
   margin and P&L. A mark move between open and close changes the amount.
7. Open **Send to a public address or back up notes**. Keep your connected
   testnet account as **Public NEAR recipient**, enter `10`, and click
   **Withdraw to NEAR**. Your public wallet gains 10 mUSDC. The remaining
   collateral stays shielded.
8. Open the links under **NEAR receipts** to inspect the transactions. The
   private open uses a separate signer and publishes a commitment and proof.
   The withdrawal publishes its amount and recipient. Public funding and
   settlement data can also support correlation and inference.

## Verified hosted run

The test signed with a real testnet key using the app's wallet interface and
loaded the deployed WebAssembly and proving keys. It exercised the hosted
faucet and keeper endpoints and verified the finalized transactions through
NEAR RPC. The run used a wallet test harness.

| Live BTC pool | Transaction | Inclusion block |
| --- | --- | --- |
| Deposit 100 mUSDC | [Deposit](https://testnet.near.rocks/tx/6Y5VZEixHeiSQ72hEpVxqNVJfEr2Ei5DuUcqktYd98k3) | [Block](https://testnet.near.rocks/block/4EmLB217ibhbZFqpbvmFDD57dPradkBmsprPNivT5KKB) |
| Open 0.001 BTC short with 30 mUSDC margin | [Open](https://testnet.near.rocks/tx/TJYQbdBxjpZ3DMmVsPQHcBiZMZ54e4oqHfBNL77Ds1b) | [Block](https://testnet.near.rocks/block/DUw5NWurvp9DgJpxNai7ESi74EzqaXgmraCyuTjEuC6S) |
| Close to 100 mUSDC shielded | [Close](https://testnet.near.rocks/tx/GQSNCj8pUHCrwjKTMRorX7sCfgS3oXStvQLia8Rfqkm7) | [Block](https://testnet.near.rocks/block/F4peLgYQ1Yw4kE1gUhJU1zvLB8v36ohqoRmVypmcxenu) |
| Withdraw 50 mUSDC to the connected wallet | [Withdrawal](https://testnet.near.rocks/tx/ABzMAcSembBJeFSaL8UVAtxDUw1R78BB9QA1u2VRxCgk) | [Block](https://testnet.near.rocks/block/ANzStVuwGUAcNzi59vW53brr5FergrW6ThWwZgaoDiGx) |

The [controlled pool](https://quietmargin.outcomeseal.com/shielded?pool=keeper)
lets the oracle operator reproduce liquidation on demand. Judges can follow
these receipts without a wallet. To repeat the price change live, arrange a
run with the oracle operator. The trading page has no price control.

| Controlled pool | Transaction | Inclusion block |
| --- | --- | --- |
| Open a long at $68,800 | [Open](https://testnet.near.rocks/tx/EeZDDevETXSKHDPF3cdJWHJkmmomjXuecZRyg4yg8rYP) | [Block](https://testnet.near.rocks/block/8MUDcnLRXtvJWGYvKTzgV49AZETLQo1BSuWq97VZ6KXA) |
| NEAR rejects liquidation at the healthy mark | [Rejection](https://testnet.near.rocks/tx/8FsX9uhupmkZyLGimggiFmYat1Va975uKsGQJTswNPod) | [Block](https://testnet.near.rocks/block/DGJ8uGtTp6PVgXnnqHHrAniyfDbjFJrtH7Ubyc6fa6wa) |
| Oracle operator moves the mark to $40,000 | [Mark update](https://testnet.near.rocks/tx/2bzwNRSrUUWHQ7A4SQKHyXuTRsgTCxj9mZZbihmSYyX7) | [Block](https://testnet.near.rocks/block/4auG2CKBmcYXjrGM52TjoyBPK2gwJ28MHg1EodTJfyMM) |
| Fly-hosted Keeper B settles while the trader is offline | [Liquidation](https://testnet.near.rocks/tx/7BzALdUFVXpJUwckBTvZnw9es7Eu1XAfrYMp7ZatMLV) | [Block](https://testnet.near.rocks/block/9e6kjGori5QSsj5DX6NghJfjdKtcvJCY4ugSKemCVsmQ) |

The rejected proof was built for the lower mark. NEAR verified it against
the healthy on-chain mark and returned `ERR_PROOF_INVALID`. The successful
receipt emits `position_liquidated` for the same commitment and credits a
shielded note worth 1.20 mUSDC. The [recorded demo](QUIET-MARGIN-DEMO.md)
also shows the earlier long and short liquidation runs.
