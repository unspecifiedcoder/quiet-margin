# Native NEAR sandbox specification

## Baseline and scope

The read-only EVM reference is Xythum-Labs/darkpool-gateway at
`e5cbe25965ec546ac6e691704d9c176137cf561c`. It exposes position parameters
in the clearing house and uses zero knowledge for note operations. This
repository starts a new native NEAR clearing contract and new proof statements.
The private baseline is excluded from worktree tasks. The public verifier
references are [NEP-488](https://github.com/near/NEPs/blob/master/neps/nep-0488.md)
and [Antumbra](https://github.com/Valentine1898/antumbra/blob/d684c3e380cb0da47cad16803741cff16861bb8d/contracts/pool/src/groth16.rs).
The [NEAR smart-contract skill](https://github.com/near/agent-skills/tree/cb32b6af195e636c1e9c2efe2ea75a6d85b6b67b/skills/near-smart-contracts)
applies.

Version 1 is a sandbox-only, single-slot isolated BTC/mock-USDC long market
for one configured trader and one maker. The maker authorizes a quote by
approving its position commitment on chain before a height-based expiry.
Voluntary close, short positions, additional slots, variable funding rates,
and production setup are later milestones. An authenticated test oracle
publishes deterministic fixture prices and a cumulative funding debit. All
token amounts below are in cents, with one raw mock-FT unit per cent.

## Position and reference arithmetic

One lot is 0.001 BTC and one price tick is $10. Lots times ticks gives cents.
The position has 1–50 lots and entry in 1–20,000 ticks. Margin is 1–60,000 cents.
Initial leverage is at most 3x, enforced by `entry * lots <= 3 * margin`.
Every open locks 60,000 cents of escrow and reserves 60,100 cents in the
prefunded maker vault. Unassigned escrow equals escrow minus private margin.
The maker caps the positive PnL used in settlement at 60,000 cents. The bounty
is 100 cents. The funding checkpoint is zero and the contract allows entry only
at zero funding. The oracle index is a nondecreasing debit in 0–200 cents.

Let `pnl = (price - entry) * lots` and `equity = margin - funding + pnl`.
Liquidation requires `20 * equity < price * lots`, equivalent to equity less
than the ceiling of exact 5% maintenance. Equal maintenance is healthy.
Let `capped_equity = margin - funding + min(pnl, 60000)`. Then

- `refund = 60000 - margin + max(capped_equity - 100, 0)`
- `bad_debt = max(-equity, 0)`
- `vault_after = vault_before + 60000 - refund - 100`

A loss first consumes margin. The maker absorbs any deficit and covers any
bounty shortfall from its reserve. Nonzero bad debt halts new positions.
Refund and bounty become available balances in the same receipt that consumes
the position. Claims transfer the configured NEP-141 token using pending
balances and a private callback. Failure restores the claim exactly once.

Fixture. Ten lots enter at 10,000 ticks, with 50,000 cents of private margin.
After funding of 200 cents, 7,000 ticks gives equity 19,800 and maintenance
3,500, so liquidation fails. At 5,200 ticks equity is 1,800 and maintenance
2,600. The trader receives 11,700 including 10,000 unassigned escrow, Keeper B
receives 100, the maker gains 48,200, and debt is zero. Test the boundary
at equality and a price gap as well.

## Commitment, proofs, and encodings

All concatenations are raw bytes, integers use fixed-width little endian,
and textual prefixes are ASCII without a terminal null. Byte arrays in
the JSON interface are standard padded Base64 strings.

`market = SHA256("xythum:BTC-USDC:v1:" || deployment_id[32] || contract_account_utf8)`

The initializer takes a unique 32-byte deployment ID for the chain/instance.
The account and deployment ID jointly scope every position and proof. Do not
reuse a deployment ID for the same contract account on another chain.
For each globally monotonic nonce (u32, starting at 1),

`context = SHA256("xythum:position:v1:" || market[32] || nonce_u32 || trader_account_utf8)`

`commitment = SHA256(context[32] || blinder[32] || lots_u16 || entry_u16 || margin_u32)`

The blinder is randomly generated. Direction, configuration, and funding
checkpoint are fixed by v1. The sole active slot uses its commitment as its
single-leaf state root. The nonce is a one-time spend marker and is consumed
atomically with the slot. Cleared nonces are never reused.

Two BLS12-381 Groth16 keys from ephemeral sandbox-only Arkworks setup. The
circuit and reference model share arithmetic fixtures. Open proves a valid
commitment and all entry/risk bounds. Liquidation independently enforces those
bounds, current oracle inputs, strictly deficient margin, and exact refund
and debt. The settlement bounty is a constant in the contract. Keys are fixed
at initialization, and key hashes and tooling are recorded per evidence run.
R1CS arithmetic enforces integer ranges and signs, including for comparison
slack and output calculations, so field wrap cannot satisfy a false statement.

Public scalar order for open is
`[commitment_low128, commitment_high128, context_low128, context_high128]`.
Liquidation appends `[round, price_ticks, funding_cents, refund, bad_debt]`.
Use the first 16 digest bytes for low128 and the last 16 for high128. All
inputs are encoded as 32-byte LE scalars. A proof binds the exact oracle round
even when successive rounds carry the same values. Proof encoding uses NEP-488
uncompressed big-endian G1/G2 points. Proof is `A || B || C`. VK is
`alpha_g1 || beta_g2 || gamma_g2 || delta_g2 || IC[0..=n]`.
The verifier must enforce exact lengths and call NEP-488 pairing checks.
A false relation, mutated proof, or malformed encoding fails closed.

## API and state transitions

NEAR accounts are role-separated. Only the contract account initializes.
In the following API names, numbers are JSON integers except token transfer
amounts (NEP-141 U128 strings). Oracle block heights and quote expiry are u32
in this bounded test instance.

- `init(token_id, trader_id, maker_id, oracle_id, keepers, deployment_id, open_vk, liquidation_vk)`.
  `keepers` is a two-entry ordered array of `{account_id, ack_key}` objects.
  Both key versions are fixed at 1. Each ack key is a raw 32-byte Ed25519 key.
  Role accounts and keeper keys must be distinct.
- `ft_on_transfer(sender_id, amount, msg)` accepts the configured token only.
  Trader with `"trader"` credits available funds. Maker with `"maker"` credits
  the vault. Reject or refund everything else. Keep balances within u64.
- `publish_oracle(round, price_ticks, funding_cents)` is oracle-only.
  Require a strictly increasing round from a nonzero first round and valid
  price in 1–20,000 ticks and monotonic funding. Store publication height. Freshness is 1,000
  blocks inclusive for the deterministic Sandbox.
- `stage_position(nonce, commitment, ciphertexts)` is trader-only while the
  slot is empty. Exactly two 144-byte ciphertexts in keeper
  order are persisted on chain, visible via `get_pending()`. Replacing the
  pending item clears maker approval. Reject a nonce other than the next one.
- `approve_quote(nonce, commitment, expires_at)` is maker-only. Match the
  exact staged nonce and commitment and require a future expiry height.
- `open(nonce, commitment, acknowledgments, proof)` is trader-only. Match
  staged data, active quote, fresh oracle at funding zero, funded escrow and
  reserve, both signatures in keeper order, and the open proof. On success,
  move the ciphertexts into the active slot, consume the pending quote, and
  lock funds. Increment the next nonce on open. Keepers retrieve the active
  ciphertexts from `get_active()`.
- `liquidate(nonce, root, round, refund, bad_debt, proof)` is callable by
  either designated keeper. Check active nonce and root, exact latest fresh
  oracle round, proof against contract-owned statement, and reserve coverage
  before settlement. Credit the submitting keeper, clear the active slot,
  and record debt and halt as applicable. Every failed receipt leaves
  accounting, slots, and nonce unchanged.
- `withdraw(amount)` uses a U128 amount string and exactly one yoctoNEAR.
  Available balances are claimable by the trader and keeper accounts.
  Deduct balance before transfer, allow one in-flight claim per account,
  and use private `resolve_withdraw(account_id)` to clear or restore it.
- Views. `get_market()` returns base64 market hash. `get_pending()` and
  `get_active()` return null or `{nonce, commitment, ciphertexts}`.
  `get_oracle()` returns null or `{round, price_ticks, funding_cents, height}`.
  `get_ledger()` returns `{trader_available, trader_locked, maker_vault,
  maker_reserved, keeper_available, pending_withdrawals, bad_debt, halted,
  next_nonce}` as integer values, with keeper balances as an array, pending
  withdrawals as total cents, and maker_vault inclusive of maker_reserved.

Each ack signature is over
`"xythum:keeper-ack:v1:" || market[32] || nonce_u32 || commitment[32] || SHA256(ciphertext)[32] || keeper_index_u8 || key_version_u32`.
The keeper index is zero-based. A trusted keeper independently reads its
persisted ciphertext from the contract, decrypts it with its own key,
validates context and the exact commitment, then signs the message. A keeper
that cannot retrieve, decrypt, or verify a witness withholds its signature.
The contract checks the exact ciphertext hash and signature. The Sandbox
uses X25519 recipient/ephemeral keys, HKDF-SHA256, and AES-256-GCM with a fresh
96-bit nonce. HKDF uses the commitment as salt and ASCII
`xythum:keeper-envelope:v1` as info. AES-GCM uses the commitment as
associated data. Each ciphertext is the 44-byte ephemeral X25519 DER SPKI,
the 12-byte nonce, the 16-byte tag, and the encrypted 72-byte commitment
preimage. The keeper retains its encryption and signing keys across
restarts. Trader and Keeper A are offline after admission. Keeper B starts
in a fresh process, reads the active ciphertext by RPC, decrypts, and proves.
The two keeper processes exercise failover under one operator.

## Public trace and evidence

Public observers see accounts, fixed escrow and reserve, ciphertext lengths,
commitment, oracle rounds, settlement, withdrawals and balances. Direction
and funding checkpoint are fixed in this market. When post-bounty equity is
positive, the refund can reveal net PnL.
When no post-bounty equity remains, the refund directly reveals assigned
margin from the unused escrow. Prior knowledge can further narrow feasible
openings in a singleton market.
The encrypted witness and exact opening are available to the trader and
both keepers. The Sandbox maker approves a commitment subject to the proof's
public risk policy. The contract authenticates that approval and its expiry.
A stalled oracle or loss of both keeper keys leaves an active slot locked.
A superseded oracle round requires a fresh proof. The maker vault has no
withdrawal method in this milestone. Malicious keeper attestations can cause
witness unavailability, and the same-team test assumes honest attestations.

Run with synthetic assets on native NEAR Sandbox. Check final receipt status
and conservation. Try missing, undecryptable, and mismatched payloads, a
wrongly signed ciphertext, healthy liquidation through the verifier, stale
round, wrong root/domain, mutated proof, tampered refund, and replay. Compare
full ledger and active state across failures. Record contract bytes, VK
fingerprints, proof times, verification transaction gas, and receipt hashes.

