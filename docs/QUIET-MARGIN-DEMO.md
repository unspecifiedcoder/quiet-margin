# Quiet Margin demo evidence

[Watch the 2:41 demo](media/quiet-margin-judge-demo.mp4) · [English captions](media/quiet-margin-judge-demo.srt)

All transactions are on NEAR testnet. The funding approval is from a separate take using the same public wallet. The deposit, open, close, and withdrawal are one browser session. The controlled test uses the same pool contract code at a separate address, with two distinct trading signers.

## Live settlement and withdrawal

| Step | Outcome | Transaction | Inclusion block |
| --- | --- | --- | --- |
| Faucet sends 100 mUSDC | `Success` | [Transaction](https://testnet.near.rocks/tx/3YMYh85pPR7WSaCGcd5uQjDEaReBx4jsQgBJUh6p9mgp) | [Block 277,532,425](https://testnet.near.rocks/block/Gpcv3HwVXFMkWVoEbnabZarbhE8wD33orTMnCHeqQN2t) |
| Deposit 100 mUSDC | `Success` | [Transaction](https://testnet.near.rocks/tx/HGHk63g5bzsZgeRXQ3tSbuQqZmaDwJqnWVr9wMrrJrtX) | [Block 277,532,652](https://testnet.near.rocks/block/3Q6Km5QpUHwXR8AgisQ7WBB69qgjfRtHjDY7XNU32pGp) |
| Publish live settlement mark | `Success` | [Transaction](https://testnet.near.rocks/tx/GU3TJQpjP9AzCLaynxaGL9AQCYZGbgRcFBurwszzGebH) | [Block 277,532,668](https://testnet.near.rocks/block/FJSCxkhm5zhZm81MLVETGP8HqVGmCAurCU5TL8ci7m46) |
| Open private short | `Success` | [Transaction](https://testnet.near.rocks/tx/BGybEoyQKLCATUvRGDxdsishSuZyjBvRxfFGeypT3Ric) | [Block 277,532,703](https://testnet.near.rocks/block/ANGxQ6xyZxLNeMaSq8XmjRdtsE8SWcC41FoQYFf4mjr) |
| Close private short | `Success` | [Transaction](https://testnet.near.rocks/tx/FyJDJ9JLSWYDiq2w4xZ4ggmHPa7BBqL827HexR4L3Vrm) | [Block 277,532,721](https://testnet.near.rocks/block/BA9Q8EEwajPb13BAoV499MhvyrHp7V5T4xxRnsHcSdTY) |
| Withdraw 10 mUSDC | `Success` | [Transaction](https://testnet.near.rocks/tx/C1HYGked2ZzYB6Swmbx2MXxWfq23adoZfC7X1WXJwiQr) | [Block 277,532,750](https://testnet.near.rocks/block/CDS5d4zLj7b4WK3hy73dcn1QnE3Vcfddz9gL7D5QqVkj) |

## Controlled liquidation test

| Step | Outcome | Transaction | Inclusion block |
| --- | --- | --- | --- |
| Long private open | `Success` | [Transaction](https://testnet.near.rocks/tx/3gVEWDridZMcUBgxEtfAp8YHnd1wV695vBSCJ9rSYstR) | [Block 277,531,699](https://testnet.near.rocks/block/HwufRKa4E1Ca2t5tnqAuPEX7aT9cGYBist2WoR4LpgdF) |
| Long healthy mark | `Success` | [Transaction](https://testnet.near.rocks/tx/7yMgaXddG6dCEkabaZgBP7edZdH9oZVvEYx7SAiaHoQr) | [Block 277,531,901](https://testnet.near.rocks/block/5J1DcaJZMrCM78YGk5VvtZj2FkVfNesEXeJTufmLrsHw) |
| Long healthy liquidation rejected | `ERR_PROOF_INVALID` | [Transaction](https://testnet.near.rocks/tx/D1hgei3NKNQ6PRnuFcHKsRE7GF62Yedqq5FRGQ4vkmMe) | [Block 277,531,914](https://testnet.near.rocks/block/AFszpNxp6TXpDCh2DidbuBA2R1gqKbB3XPZQkrdnkQ7B) |
| Long adverse mark | `Success` | [Transaction](https://testnet.near.rocks/tx/9odGXYP2vVAkobyQujAqZVBf886opiGRMZg34wQ2DcUR) | [Block 277,531,921](https://testnet.near.rocks/block/CxjtLH9Es87YrwiV4B6L15ZB3kkTncwUzQQtEhaCkL7q) |
| Long offline liquidation accepted | `Success` | [Transaction](https://testnet.near.rocks/tx/6bQcmpib6JQYXakzmdotbWkm2Eh9ZWMZ1To7zs5Gsoh3) | [Block 277,531,931](https://testnet.near.rocks/block/DkFYXas8KMYghdXSEJXA4ywzRe6gs4bND3yRBuN5iy4X) |
| Short private open | `Success` | [Transaction](https://testnet.near.rocks/tx/GPwm7b3UG9wKtHAer22RU6Pe5gEgukZnUPEa6cHg9NQV) | [Block 277,531,781](https://testnet.near.rocks/block/D2KcrjymCF3cAdP5XddgUVEcq8J2AReFY5qLizwBEkb1) |
| Short healthy mark | `Success` | [Transaction](https://testnet.near.rocks/tx/9VnGqi9vSVEZweSz1TuH1prgCaLkdfxzpSiWwav5s28E) | [Block 277,531,945](https://testnet.near.rocks/block/76eNoE8T2SyCP5usafCJQAjbjcb96JqYZJvvfRJUS1qv) |
| Short healthy liquidation rejected | `ERR_PROOF_INVALID` | [Transaction](https://testnet.near.rocks/tx/9uhkxSao7pi6AmfBnLyyzreYT5pks6nkyJXo9FEjaUPE) | [Block 277,531,954](https://testnet.near.rocks/block/Cw6qgVzHrke3bLQi98njSwqYZD73ySSCe9jrKmvBPaDy) |
| Short adverse mark | `Success` | [Transaction](https://testnet.near.rocks/tx/Dm1n6dRNm3QVk48X8g3uahzjUZfWJt9j19MHazGHLDMm) | [Block 277,531,961](https://testnet.near.rocks/block/H6FmbrKYdNzcSamggikCAYKxPScj3xtrWbyksVYuddz9) |
| Short offline liquidation accepted | `Success` | [Transaction](https://testnet.near.rocks/tx/Cg3PtAXJx1PUwLaq6GfzUgYANu5LjtWzFZTHL3Ujv4K8) | [Block 277,531,970](https://testnet.near.rocks/block/E9PgMWwGGtK7U2dN5euUdpwt1oS4WLh9jpms1j4m9Xez) |

## Verify from a checkout

`node scripts/verify-judge-demo.mjs` checks the 16 transactions above against public testnet RPC. It requires Node.js 22+ and internet access.

The verifier checks finality, the transaction and block identities, the expected method and outcome, and selected public fields. The receipts show which account signed each call. Trader and Keeper A shutdown were part of the recorded run, which is evidence about how the run was operated.
