# Shielded collateral on NEAR testnet

Open **Shielded Pool** in Quiet Margin. Connect a NEAR testnet wallet, then sign
the NEP-413 unlock message. The same wallet key and app origin derive the same
private trading key. The signature stays in the browser.

## Browser-only build

The default `/shielded` route uses `browser-pool.qm-treasury-a280bef3.testnet`.
The app serves its public proving keys and Wasm from static assets. The browser
proves opens, closes, and withdrawals and submits signed transactions directly
to NEAR testnet. The spend key is 3.50 MB and the close key is 1.15 MB. The
Poseidon circuit uses the BLS12-381 parameters from the paper and retains
hidden membership, note nullifiers, and balance conservation.

Build the site with `npm ci --prefix exchange` and
`npm run build --prefix exchange`. Serve `exchange/dist` over HTTPS with
`/shielded` routed to `index.html`, or run `npm run preview --prefix exchange`
for a local preview. Static hosting needs no wallet credentials, NEAR SDK,
Rust build, or proving service. Testers need a NEAR testnet wallet with mock
USDC and a funded private signer. The unlock signature is scoped to the site
origin, so the operator must activate the signer shown on the actual judge URL.
Run `node scripts/provision-shielded-pool.mjs --browser-pool --activate <implicit-testnet-account>`
to fund that signer separately.

Existing deposits and backups belong to the original SHA-256 pool. Access it
at `/shielded?pool=legacy` on a host configured with its original assets.
Withdraw there before depositing into the browser pool.

[Poseidon paper](https://eprint.iacr.org/2019/458.pdf)

### Browser-only testnet receipts

A fresh Edge profile connected to the static preview and signed deposits of
60 and 40 mUSDC. Opening a 0.001 BTC long locked 30 mUSDC and returned 70
as shielded change. Closing at the same mark brought the balance back to
100 mUSDC, and withdrawing returned it to the connected wallet.

| Action | Click to NEAR finality | Explorer |
| --- | --- | --- |
| Deposit 60 mUSDC | | [Receipt](https://testnet.near.rocks/tx/EcaPh8otubQUj2U7AY5M3iEnHBW9Pbevvdm77GgMEDcs) |
| Deposit 40 mUSDC | | [Receipt](https://testnet.near.rocks/tx/6Cg5MmQ9TstQKbo5kMnyXfkQXppQiufDsGhjJQYVBti8) |
| Open | 9.8 s | [Receipt](https://testnet.near.rocks/tx/EedGeSChT5gqS1M1fzhN3Afwsw9v5hsNwLc14U317dXv) · [Opening block](https://testnet.near.rocks/block/2o3VtaSwvRLNRGBJW3vSTZtvGhmpWr7rdpjbq6rvwhTz) |
| Close | 8.1 s | [Receipt](https://testnet.near.rocks/tx/DNVUqZpR9opjpL2nnsHUtPUUtAQwCTyMAW78AQpBZwT5) |
| Withdraw | 11.4 s | [Receipt](https://testnet.near.rocks/tx/8Fm7x7U2xguxWNo68kGX5h3QYckwAEx5ufSomonPwnH8) |

The recorded timings include proving and testnet confirmation on one machine.
The test blocked the desktop helper endpoint and asserted that the browser
loaded only the three public proving key requests. Check the final receipts
and public fields with `node scripts/verify-shielded-receipts.mjs --browser`.

## Earlier desktop-prover testnet trade

[Watch the full clicking demo](media/quiet-margin-shielded-pool.mp4).

The connected wallet signed 60 and 40 mUSDC deposits. The private trader
opened a 0.001 BTC long with 30 mUSDC margin and 70 mUSDC in shielded change.
Closing at the same mark returned the original 30 as a new note. A withdrawal
sent 100 mUSDC back to the connected wallet.

| Step | Final NEAR evidence |
| --- | --- |
| Deposit 60 mUSDC | [Receipt](https://testnet.near.rocks/tx/13rxnZz1S8ReVZTpd8x6EDdDvf1icgzbPU2vTYzVUyg8) |
| Deposit 40 mUSDC | [Receipt](https://testnet.near.rocks/tx/ENVE3ir58UJGBjtdti2VYfuzEscqz3N38jj4sp5YvnwZ) |
| Open the private long | [Receipt](https://testnet.near.rocks/tx/5ibU1UBpeLXgppNqQ7SLAEp9P7SWQjAZit1QBmLXbwiB) · [Block 277514961](https://testnet.near.rocks/block/AvyYXreSAWwoRssGB6s7qibcFhuXtJDGqCgS5Uz5fVaB) |
| Close the long | [Receipt](https://testnet.near.rocks/tx/A4hYKgcQ6xMjLhiYx15UqT14uz3m4bHrLwm4nqkRgtvu) |
| Withdraw 100 mUSDC | [Receipt](https://testnet.near.rocks/tx/CTeExcWJj4rPQCHbvTe395sh3w9vHiR1QDtj9HoGMppS) |

Run `node scripts/verify-shielded-receipts.mjs` for an independent check of
the final receipts, transaction fields, pool events, and opening block. The
browser recording shows the 30 and 70 balances. The public verifier checks
their commitments and the successful NEAR execution.

## Walkthrough

1. Start with 100 mUSDC in your connected testnet wallet and gas in the derived
   private signer. The operator can register and fund a demo wallet as described below.
2. Deposit 60 mUSDC. Approve the NEP-141 transfer in your connected wallet.
   Deposit another 40 and approve a second transfer. Both credits appear as
   separate notes in the same pool.
3. Enter 30 mUSDC margin and 0.001 BTC. The browser proves both input notes
   belong to the trader and that the trade consumes 30 and returns 70 as a
   new shielded note. The pool checks the proof, consumes the notes, and opens
   the position atomically.
4. Close at the contract oracle mark. With an unchanged mark the payout note
   returns the original 30. Withdraw the resulting 100 mUSDC to a registered
   NEAR testnet wallet.
5. Export an encrypted backup after each change. On a new browser, unlock with
   the original wallet on the same app origin, then restore the backup to
   recover the note and position secrets.

## What observers can see

| Action | Public data |
| --- | --- |
| Deposit | Sender, amount, token, pool, and note commitment |
| Private open | Separate signer, public entry mark, input nullifiers, position and change commitments, owner tag, and proof |
| Private close | Position commitment, settlement round, payout commitment, and maker credit |
| Withdrawal | Recipient, amount, input nullifiers, and any change commitment |

The public wallet address is absent from the private open arguments. Size,
margin, and input-note membership paths are private witness data. A recurring
private signer or owner tag links its own activity. Deposit and withdrawal
timing, distinctive amounts, sparse pool activity, and public maker credit can
reveal relationships or position details through inference.

Each shared pool is a 16-leaf testnet prototype with long-only BTC and mock USDC.
Deposits and change use append-only leaves, so the demo can serve a limited
number of independent live trades before the pool fills.
The demo uses a controlled on-chain settlement mark. The original exchange
covers offline keeper liquidation and healthy-position rejection. The shared
pool currently supports trader-initiated close and proof-based withdrawal.
A real USDC deployment would need an independently reviewed setup, expanded
capacity, operational gas sponsorship, oracle and liquidation coverage, and
accounting against the actual token's decimals.

## Legacy pool operator setup

The existing testnet operator credential files stay in the ignored
`.testnet/quiet-margin-wallet-recording/` folder. The provisioning script uses
those roles to deploy the pool, register the token accounts, fund the maker
reserve, and give the demo wallet up to 100 mUSDC on initial setup.

1. Create `.testnet/shielded`, then run
   `cargo run --release --locked --manifest-path prover/Cargo.toml --bin quiet-pool-prover -- setup .testnet/shielded/keys`.
   Run setup once for each new deployment. The generated keys must match the
   verifying keys initialized on the contract.
2. Build the contract with the optional `shielded-pool` feature and
   `--target-dir target/pool-build`. With the NEAR SDK's raw cargo build,
   set `RUSTFLAGS='--cfg near -C link-arg=-s'` and run
   `cargo build --release --locked --target wasm32-unknown-unknown --features shielded-pool --target-dir target/pool-build`.
3. Run `node scripts/provision-shielded-pool.mjs`. It writes public browser
   configuration in `exchange/public/shielded/` and deployment receipts in
   `.testnet/shielded/deployment.json`.
4. Build the browser prover into `exchange/public/shielded/prover` with
   `prover/browser/build.ps1 -OutDir (Join-Path $PWD 'exchange/public/shielded/prover')`
   or `prover/browser/build.sh "$PWD/exchange/public/shielded/prover"`. Build the
   exchange with `npm --prefix exchange run build`. Run the [exchange server](../exchange/server/README.md)
   and visit `/shielded` on its origin.
5. If the wallet screen displays an unfunded private signer, activate it with
   `node scripts/provision-shielded-pool.mjs --activate <implicit-testnet-account>`.
   Reload and unlock from the same origin. The operator funds the signer
   separately from the public collateral wallet.

For an existing deployment with compressed proving keys, export both keys to
a separate directory with `quiet-pool-prover uncompress SOURCE OUTPUT`. Use
`spend.pk` and `close.pk` as the output names and set `XYTHUM_POOL_PROVING_DIR`
to that directory before starting the exchange server. The verifying key
fingerprints and deployed contract stay the same. The uncompressed spend key
is about 862 MB and the close key about 183 MB. These files are generated
locally and are outside Git. Use a desktop browser with enough free memory
to load the key and construct the proof.

### Local desktop prover

For machines where the full spend circuit is too slow in Wasm, build
`quiet-pool-prover` in release mode and set `XYTHUM_LOCAL_POOL_PROVER` to the
absolute binary path before starting the exchange server. Point
`XYTHUM_POOL_PROVING_DIR` at the folder containing both `.pk` and `.vk` files.
Open the exchange on its HTTP loopback address. The page shows when the
desktop helper is active. It receives the witness on the same machine and
returns a proof. The wallet key and transaction signing stay in the browser.
Hosted deployments use the browser worker. The desktop helper is disabled on
non-loopback binds and accepts only same-origin browser requests.

[NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) ·
[Original market and keeper](FUNDED-MARKET.md)
