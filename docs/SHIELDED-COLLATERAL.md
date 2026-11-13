# Shielded collateral on NEAR testnet

Open **Shielded Pool** in Quiet Margin. Connect a NEAR testnet wallet, then sign
the NEP-413 unlock message. The same wallet key and app origin derive the same
private trading key. The signature stays in the browser.

## Verified deposits

The connected wallet signed separate deposits of 60 and 40 mUSDC into the
same NEAR testnet pool. Run `node scripts/verify-shielded-receipts.mjs` to
check finality, token, pool, amount, and distinct note commitments through
public RPC. [60 mUSDC deposit](https://testnet.near.rocks/tx/4jmNQpzBxzeXeSzDy4F5Yt9eBzwkvuqdwa6eTdFVzwp2) ·
[40 mUSDC deposit](https://testnet.near.rocks/tx/9hNTdytrFupLxtABGDGECJEzkALbT2m32tZTJMrP6yeC)

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

The shared pool is a 16-leaf testnet prototype with long-only BTC and mock USDC.
The demo uses a controlled on-chain settlement mark. The original exchange
covers offline keeper liquidation and healthy-position rejection. The shared
pool currently supports trader-initiated close and proof-based withdrawal.
A real USDC deployment would need an independently reviewed setup, expanded
capacity, operational gas sponsorship, oracle and liquidation coverage, and
accounting against the actual token's decimals.

## Operator setup

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

[NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) ·
[Original market and keeper](FUNDED-MARKET.md)
