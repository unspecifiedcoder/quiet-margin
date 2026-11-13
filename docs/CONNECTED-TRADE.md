# Quiet Margin: connected wallet recording

The connected wallet path runs on NEAR testnet. The recording uses an
external Intear Wallet approval to connect, a signed message to derive the
separate trader, and a second signed message to claim 600 mUSDC. The trader
deposits the grant, opens a BTC long, closes and withdraws. A fresh browser
signs again and recovers the same trader account.

| Evidence | NEAR testnet |
| --- | --- |
| 600 mUSDC grant | [Final token transfer](https://testnet.near.rocks/tx/EuHymLJySKsNPuue3HGmQWCG2DJX9VSg1GvditmRPosb) |
| Open with browser proof | [Final open](https://testnet.near.rocks/tx/4m1Zutu6RmJsabJmpYe9Qz93xRjbeLNmUqpcx172zeG5) |
| Open execution block | [Block 277489197](https://testnet.near.rocks/block/nRyYD3FbLoBsiAGFtPNKPGaqsRtLa1qFsxipgkMjVKK) |
| Close with browser proof | [Final close](https://testnet.near.rocks/tx/GUVF8KhHzcL8Tsnbkqge7DVJ7YS6X4jQ7HW2D43y2kHc) |
| Withdraw 500 mUSDC | [Final withdrawal](https://testnet.near.rocks/tx/4oHWCuzypdZDPXmTZgwqDM8LK7caLvjZ4H2x5d1wsnkP) |

The open transaction's only call arguments are the nonce, commitment,
keeper acknowledgments and proof. Its signer is the separate trader.
The connected public wallet does not appear in the grant, open, close or
withdraw receipts. The faucet operator sees both identities during the
claim. The NEAR mark and 600 mUSDC escrow are public, and later settlement
can allow further inference. This client opens at the oracle mark, so a
public observer can infer entry from that mark even without an entry
field in the open call.

The film's healthy rejection and Keeper B liquidation are from a
separate controlled-price run. See [the judge guide](../JUDGES.md) for
those receipts and the native sandbox reproduction.

For a fresh local run, [start the coordinator](../exchange/server/README.md)
with `XYTHUM_WALLET_FAUCET=1`, `XYTHUM_LIVE_MARKET=1` and an explicit
session quota. The original fixture is still available separately. The
shared pool is a separate milestone; this recording uses a capped
testnet grant and the existing market's fixed escrow.
