# Funded market v2

The v1 [Sandbox evidence](SANDBOX-EVIDENCE.md) remains reproducible at its
recorded commit. V2 deploys a fresh clearing contract and fresh Groth16 keys.
The market stays single-slot and long-only with mock NEP-141 collateral.
Unless overridden here, the v1 [Sandbox specification](SPEC.md) applies.

## Admission and maker quote

A live oracle publishes the price in $10 ticks and a cumulative per-position
funding index in mock cents. One lot is 0.001 BTC. Each admitted position
locks 60,000 cents and reserves 60,100 cents in the funded maker vault.
Opening checks `entry_ticks * lots <= 3 * margin_cents` and the position is
healthy at the authenticated opening mark:
`20 * (margin + (open_price_ticks - entry_ticks) * lots) >= open_price_ticks * lots`.

Hash inputs are fixed-width little endian with UTF-8 account IDs. Tags are
ASCII, without a terminating null.

- `market = SHA256("xythum:BTC-USDC:v2:" || deployment_id[32] || contract_account_utf8)`
- `context = SHA256("xythum:position:v2:" || market[32] || nonce_u32 || funding_checkpoint_u32 || trader_account_utf8)`
- `commitment = SHA256(context[32] || blinder[32] || lots_u16 || entry_ticks_u16 || margin_cents_u32)`
- `quote_terms = SHA256("xythum:quote:v2:" || context[32] || quote_blinder[32] || lots_u16 || entry_ticks_u16)`

A fresh random 32-byte position blinder keeps margin and the opening hidden.
The maker receives the exact quote terms and an independent 32-byte quote
blinder off chain, recomputes the quote digest, and signs its on-chain
approval. The maker sees size and entry and can check them against its
quote policy. Margin and the position blinder remain available to the trader
and two keepers. Public observers see only the salted digests and fixed
escrow before settlement. The open circuit proves that both digests use the
same lots and entry and independently enforces risk and opening health.

- `stage_position(nonce, commitment, quote_terms, ciphertexts)` fixes the
  latest fresh `funding_checkpoint` and `open_price_ticks` for the pending
  slot. `get_pending()` and `get_active()` include those fields and
  `quote_terms` alongside v1 fields. Both payloads retain the 144-byte
  envelope with the same 72-byte private preimage. An acknowledgment uses
  the v1 message layout with the prefix `xythum:keeper-ack:v2:`.
- `approve_quote(nonce, commitment, quote_terms, expires_at)` authenticates
  the maker, exact pending position and terms digests, and future height.
  Expiry is inclusive for open. Restaging discards the prior approval.
- `open` keeps its v1 arguments and requires the latest fresh oracle to
  match the staged opening price and funding checkpoint. The contract
  constructs proof inputs from the slot and authenticates both keeper
  acknowledgments and the quote before locking funds. A new round with
  the same price and index preserves the prepared opening.

## Funding and settlement

Oracle updates keep round strictly increasing and the u32 funding index
nondecreasing. An active position uses a committed opening checkpoint and
pays `funding = current_funding_index - funding_checkpoint` at settlement.
While a slot is active, the index cannot exceed its checkpoint by more than
200 cents. When empty, a subsequent position starts at the then-current
index. This is a deterministic demo debit denominated in cents per slot.

Let `pnl = (price - entry) * lots`, `equity = margin - funding + pnl`,
and `capped_equity = margin - funding + min(pnl, 60000)`. Liquidation
requires `20 * equity < price * lots`. A trader can close voluntarily
regardless of health, so a trader and keeper can both have valid settlement
proofs for the same unhealthy slot and oracle round.

- `bounty = 100` on liquidation, `0` on close.
- `refund = 60000 - margin + max(capped_equity - bounty, 0)`
- `bad_debt = max(-equity, 0)`
- `vault_after = vault_before + 60000 - refund - bounty`

`close(nonce, root, round, refund, bad_debt, proof)` authorizes only the
trader. `liquidate` retains keeper authorization and its v1 arguments.
Both methods authenticate the latest fresh oracle round and exact active
slot, construct the expected proof statement, and use one shared atomic
settlement path. Once the first successful receipt clears the slot, the
other fails with `ERR_NO_ACTIVE` and transfers no value. Debt still halts
new staging, approval and admission. A successful close emits
`position_closed` with nonce, round, refund and debt. Liquidation retains
its existing event and adds the keeper bounty to the submitting keeper.

The maker may withdraw from unreserved vault funds with the existing
`withdraw` method. In-flight withdrawals debit the appropriate bucket
before transferring tokens, leave reserves covered, and restore the
appropriate bucket on failed transfer. One in-flight withdrawal is
permitted per claimant.

## Proof and RPC interface

The initializer adds `close_vk` and validates all three keys. `get_config`
adds `close_vk_sha256`. JSON byte fields are padded Base64. Each digest
splits into two 128-bit little-endian limbs. Public field scalars remain
32-byte LE. Uncompressed NEP-488 key and proof point encodings stay the same.

- Open public scalars
  `[commitment_low, commitment_high, context_low, context_high, quote_terms_low, quote_terms_high, open_price_ticks]`
- Liquidation and close public scalars
  `[commitment_low, commitment_high, context_low, context_high, round, price_ticks, funding_delta_cents, refund, bad_debt]`

Close and liquidation use distinct keys and constraint shapes. The open key
has seven inputs and 1,440 bytes. Each settlement key has nine inputs and
1,632 bytes. The verifier exposes `OPEN_INPUTS`, `OPEN_VK_LEN`,
`LIQUIDATION_INPUTS`, `LIQUIDATION_VK_LEN`, and
`open_inputs(commitment, context, quote_terms, open_price_ticks: u32)`.
Both settlement modes share the existing `liquidation_inputs` encoder.

The standalone prover keeps `commit` and `prove-liquidation <dir>`.
`prove-open <dir>` now additionally takes `quote_blinder` (32 Base64
bytes) and `open_price_ticks` and returns `quote_terms`. The command
`prove-close <dir>` takes the same input as `prove-liquidation <dir>` and
returns the same JSON shape. `funding_cents` supplied to these proof
commands is the authenticated index delta. `setup <dir>` emits
`close_vk` and `close_vk_sha256` alongside existing public keys and writes
three proving key files. Existing directories with key material must never
be overwritten. `keys <dir>` reads existing proving keys and emits the same
public verifying keys and fingerprints without generating new material.

## Acceptance

- Reject tampered quote terms and an opening that is unhealthy at its mark.
- With ten lots at $100,000, $500 margin, $2 funding, and a $120,000 mark,
  close refunds $798 including unused escrow. The maker loses $198 from
  funded collateral. The trader can withdraw the $198 profit while keeping
  $600 available to reopen at the new funding checkpoint.
- At the second position's $70,000 mark, reject liquidation. At $52,000
  allow Keeper B to recover its witness and liquidate with the trader
  and Keeper A offline. Reconcile $117 claimable, $1 keeper bounty, and
  $482 credited to the vault for the second position.
- A race submits valid close and liquidation for the same distressed slot
  and round. Exactly one succeeds. Close pays $118 and no keeper bounty.
  Liquidation pays $117 and a $1 bounty. Maker accounting is identical.
- Retain native receipt checks for proof tampering, wrong domain/round/root,
  replay, failed FT payout recovery, maintenance equality, and bad debt.
- Deploy a fresh copy to NEAR testnet with the dedicated demo accounts.
  Use synthetic assets, retain the public addresses and receipts in the
  repo, and keep the local signing keys and proving artifacts out of Git.
