# Shielded collateral proposal

Quiet Margin currently credits mock collateral to a named trader account.
Each trade locks 600 mUSDC from the trader's public market balance. The
Groth16 proof covers the position opening and settlement. This proposal
adds a way for users to bring their own tokens in multiple deposits while
keeping the link between those deposits and later trades out of the public
transaction data.

## User flow

1. Connect an existing NEAR wallet and unlock the private trading wallet.
   The unlock signature stays local. A faucet may fund the connected wallet
   with test tokens for a testnet run.
2. Choose an amount and sign a deposit from the connected wallet. The token
   contract sends the amount to a shared pool via NEP-141
   `ft_transfer_call`. The deposit creates a note the private wallet can
   spend. The public receipt shows the depositing account, the pool and the
   deposit amount. It carries a randomized commitment with no private
   trader account identifier.
3. Repeat the deposit whenever more collateral is needed. For example,
   deposits of 60 and 40 can fund one proof that puts 30 into margin and
   returns 70 as a private change note, excluding any fees. This is an
   example for the proposed market. The current fixed-escrow market cannot
   open that trade against 100 in collateral.
4. Close or liquidate against the authenticated oracle round. Credit the
   resulting trader balance to a shielded note. An explicit withdrawal to
   a regular wallet reveals the recipient and withdrawn amount.

## Protocol and verification

- Keep the pool shared across traders on the same chain and token. Bind the
  note and its spend proof to the deployment and asset. Accept deposits
  only from the configured token contract and bind the committed value to
  the received amount. Reject duplicate commitments and refund rejected
  deposits in full.
- Prove note ownership and Merkle membership, prevent double spends with
  nullifiers, and conserve value across the consumed notes, locked margin
  and private change. Bind the spend proof to the intended position and
  its change commitments. A spend that publicly transfers the exact
  margin to a named trader account does not deliver this privacy property.
- Design the pool and market transitions together. Prefer atomic accounting
  for note consumption and margin reservation. For any cross-contract
  payout, test failed receipts and retries before accepting deposits. The
  circuit and keeper flow must support settlement into a note payable to the
  trader even when the trader is offline. Recheck maker solvency and loss
  limits when replacing the fixed escrow.
- Provide note recovery and a proof-based exit. Recovering the signing key
  alone is insufficient if the browser has lost the data needed to discover
  and spend its notes. A testnet demonstration should cover recovery,
  partial spend, change, double-spend rejection, failed withdrawal and
  settlement while the trader is offline before opening the pool to users.
- Use several independent test wallets when checking the public trace.
  Verify that the original account appears on its deposit and that the
  trade and settlement receipts do not identify the original account or its
  note. Timing, distinctive amounts and sparse pool activity can still
  allow inference.

## Submission wording

Until the new path is verified, describe it as a proposed extension.

> The current NEAR testnet demo uses mock collateral. The next milestone
> lets traders deposit their own USDC into a shared pool in multiple
> top-ups and use part of the balance as private margin.

Verify the token contract, decimals and accounting on testnet before
considering a mainnet USDC deployment. The current prototype's tests and
recorded receipts establish its fixed-escrow behavior.

[NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) ·
[Funded market specification](FUNDED-MARKET.md)

## Implemented on the experimental branch

`prover/src/collateral.rs` implements a two-note R1CS spend. It checks both
private note paths against one public root, derives two distinct nullifiers,
binds the private margin to the same position commitment format as the current
market, and conserves value into that margin and a private change note. The
test fixture uses 60 + 40 → 30 + 70; it also tries an inflated change note,
a duplicate input, a false Merkle path, and a substituted position commitment.

Run `cargo test --manifest-path prover/Cargo.toml --release --test collateral`.
This circuit has no custody or NEAR integration. Its shallow test tree, root
and nullifier checks in contract state, binding a deposit to token amount,
note discovery, and the final settlement and exit paths must be addressed
before the pool can accept deposits. This branch does not change the live
testnet market or its fixed escrow.
