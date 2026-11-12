# Independent Keeper B

This guide covers the tooling a separate operator uses to run Keeper B on
their own machine for a fresh NEAR testnet market. The operator never
receives a trader, coordinator or Keeper A secret, and never sends one of
their own. The coordinator receives only a public manifest and public
acknowledgment records.

**Status: tooling only.** No independent Keeper B run has been executed or
recorded. The verified testnet lifecycle in
[Testnet addresses](TESTNET-ADDRESSES.md) used a coordinator-controlled
Keeper B, so it is not evidence of an independent keeper.

## Scope

`scripts/keeper-operator.mjs` provides these steps for the operator.

1. Generate a Keeper B key file on the operator's machine.
2. Export a public manifest.
3. Check a deployed market against the local key file and the public
   proving parameters.
4. Acknowledge the exact ciphertext staged on chain.
5. Later, cold, recover the witness from chain and prove and submit
   liquidation.

The online steps reuse `actor('ack')`, `actor('prove')` and
`actor('liquidate')` from `tests/actor.mjs` and the testnet guard in
`scripts/testnet-client.mjs`. The guard pins `https://test.rpc.fastnear.com`
and requires `chain_id` `testnet`.

The coordinator side is out of scope. The existing `scripts/testnet-demo.mjs`
cannot drive this flow as written. `loadDemoEnv` requires every role,
including `KEEPER_B`, to be a coordinator subaccount with its secret key in
`.env`. `withKeepers` writes Keeper B's encryption, acknowledgment and
transaction secrets to a temporary file. A coordinator runner for an
independent keeper must take Keeper B only as the output of
`check-manifest`. It must also take Keeper B's acknowledgment as a returned
record rather than calling `actor('ack', ...)` itself.

## Key file and manifest

`init` creates one exclusive local file. It is opened with `wx`, so an
existing file is never overwritten, and with mode `0600`. The filename must
end with `.keeper-keys.json`, a pattern this repository's `.gitignore`
ignores. Keep the file outside the repository anyway, for example in
`%USERPROFILE%\xythum-keeper\`.

Every command that loads the key file checks its permissions first. On
POSIX the mode must grant nothing to group or others. Windows ignores the
mode, so the tool runs `icacls <file>` instead. This check only reads the
ACL and never changes it. Every entry must name the current user
(`%USERDOMAIN%\%USERNAME%`), `NT AUTHORITY\SYSTEM` or
`BUILTIN\Administrators`. Any other entry stops the command. So does
`icacls` output the tool cannot parse, which includes localized group
names and non-ASCII account names. The check therefore fails closed.

On Windows, `init` runs the same check on the new, still empty key file,
which carries the ACL inherited from its directory. It runs before any key
byte is written. If the check refuses, `init` removes the empty key file and
the manifest reservation, writes nothing and prints a command that restricts
the directory. Make the directory private before `init` and review it:

```text
icacls <dir> /inheritance:r /grant:r "<USERDOMAIN>\<USERNAME>:(OI)(CI)F"
icacls <dir>
```

The first command removes inherited entries and replaces only the
operator's own explicit grant. It does not touch explicit grants to other
accounts. If the second command still lists another account, remove that
account's grant by its exact listed name and recheck:

```text
icacls <dir> /remove:g "<account>"
icacls <dir>
```

Repeat until only the operator, `NT AUTHORITY\SYSTEM` or
`BUILTIN\Administrators` remain. A later refused check on an existing key
file prints the same steps for the file, with the actual path and account:
`icacls <file> /inheritance:r /grant:r "<USERDOMAIN>\<USERNAME>:F"`, then
`icacls <file> /remove:g "<account>"` for each other listed account, then
`icacls <file>` to recheck. The tool itself never changes an ACL.

The file holds three independent keys, using the field names
`tests/actor.mjs` reads.

| Field | Key | Use |
| --- | --- | --- |
| `txKey` | NEAR Ed25519 `ed25519:<base58 seed‖public>` | Signs the `liquidate` transaction |
| `encryption` | X25519 PKCS#8 DER, Base64 | Decrypts the 144-byte Keeper B envelope |
| `signing` | Ed25519 PKCS#8 DER, Base64 | Signs the `xythum:keeper-ack:v2:` message |

The manifest holds exactly these public fields. `check-manifest` rejects any
extra field, so a private value cannot be included by accident.

| Field | Content |
| --- | --- |
| `schema` | `xythum-keeper-manifest/v1` |
| `network` | `testnet` |
| `role`, `keeper_index` | `KEEPER_B`, `1` |
| `account_id` | Operator-owned named `.testnet` account |
| `tx_public_key` | `ed25519:<base58>` public key for `txKey` |
| `encryption_key` | 44-byte X25519 SPKI DER, Base64, used as `recipients[1]` |
| `ack_key` | 32-byte raw Ed25519 key, Base64, registered at `init` |

No command accepts a private key as an argument, and none prints one.
Online commands pass the key file path to `tests/actor.mjs` over stdin.
Write outputs with `--manifest` and `--out` rather than shell redirection.
Windows PowerShell 5.1 `>` writes UTF-16.

Output files follow these rules.

- The tool creates the `--out` or `--manifest` file exclusively (`wx`) as
  its first step. This happens before key generation, any network read,
  proving or signing. An existing path, or a path in a missing directory,
  stops the command with "Nothing was generated, signed or sent".
- A command that fails after that removes the empty reserved file.
- The final JSON goes to stdout before it is written to the file. If the
  file write fails anyway, stdout still holds the complete result. The
  partial file is removed, and the error says what to do next. After a
  submitted `liquidate`, the error says the transaction is final and must
  not be resubmitted.
- `init` handles its two files separately. If the key file cannot be
  created or written, no key file or manifest is kept, and `init` can be
  rerun. If the key file was written but the manifest write failed, the
  key file is complete. Do not rerun `init` in that case. Recreate the
  manifest with `manifest --keys <key file> --out <new path>`.

## Commands

Run all commands from a checkout of the agreed commit. The online commands
need `npm ci --ignore-scripts` and the release prover
(`cargo build --locked --manifest-path prover/Cargo.toml --release`) or
`PROVER_BIN`.

| Command | Required flags | Optional | Network |
| --- | --- | --- | --- |
| `init` | `--account <id.testnet> --keys <path.keeper-keys.json> --manifest <path>` | | None |
| `manifest` | `--keys <path>` | `--out <path>` | None |
| `check-manifest` | `--manifest <path> --coordinator <root.testnet>` | `--out <path>` | None |
| `check` | `--keys <path> --market <id.testnet> --proving <dir>` | `--out <path>` | Testnet reads |
| `ack` | `--keys <path> --market <id.testnet>` | `--out <path>` | Testnet reads |
| `liquidate` | `--keys <path> --market <id.testnet> --proving <dir>` | `--dry-run`, `--out <path>` | Testnet reads; one transaction unless `--dry-run` |
| `self-test` | | | None |

Every account ID must be a named `.testnet` account of at most 64
characters. Unknown flags are rejected.

- `check-manifest` is run by the coordinator. It also rejects the
  coordinator account and every subaccount of `--coordinator`. It prints
  the `keepers[1]` registration `{ account_id, ack_key }` and the
  `encryption_key`.
- `check`, `ack` and `liquidate` first require
  `get_config().keepers[1]` to equal the key file's account ID and
  acknowledgment key. They also require `get_config().key_version` to be
  `1`, the `KEY_VERSION` that ends every acknowledgment message. They read
  `trader_id` from the same config.
- `ack` reads `get_pending()`, runs `actor('ack')` against
  `ciphertexts[1]`, and verifies the returned signature over the slot it
  read. A restage during the call is reported, and no record is written.
  The record holds the nonce, commitment, ciphertext SHA-256 and signature.
- `check` and `liquidate` require the transaction key to be a full-access
  key, or a function-call key for the market that permits `liquidate`.
  `check` also reports the account balance and the pending and active
  nonces.
- `liquidate` requires `get_active()` to hold a position. `--dry-run`
  builds the proof with `actor('prove')` and submits nothing. Without it,
  `actor('liquidate')` recovers the witness from
  `get_active().ciphertexts[1]`, proves against the latest oracle, signs
  with `txKey`, and waits for finality. The tool stores no witness between
  `ack` and `liquidate`.
- In both modes `liquidate` pins the actor to the `get_active()` nonce and
  commitment it read, through `expectedNonce` and `expectedCommitment`.
  The actor reads `get_active()` again and refuses any other slot before it
  decrypts, proves or signs, so the proof and the recovery nonce always
  describe the same position. That refusal means nothing was sent, so no
  recovery steps are printed. If the slot changes after the actor's read,
  the contract rejects the proof, which binds the nonce and commitment.

### After an uncertain `liquidate` error

If `actor('liquidate')` fails without `--dry-run`, the tool cannot tell
whether the transaction reached the chain. The cause could be a proving
error, an RPC error, a finality timeout or a failed receipt. The tool
prints the following steps with the actual paths and nonce.

1. Keep the key file and delete nothing. Wait a minute, then run `check`
   with a new `--out` path. `check` reads final state.
2. If `active_nonce` is `null`, the position was settled. Find the
   `liquidate` transaction in the Keeper B account's history. Confirm that
   its signer is the Keeper B account and that its final status is
   success. `get_ledger().keeper_available[1]` holds the bounty. If a
   different account settled the position, there is no Keeper B
   liquidation to record. Do not resubmit.
3. If `active_nonce` still equals the nonce, nothing settled. Rerun
   `liquidate --dry-run`, then `liquidate` with a new `--out` path. A
   duplicate submission cannot settle twice. The contract clears the slot
   in the settling receipt and rejects a second settlement with
   `ERR_NO_ACTIVE`.

## Proving parameters

Groth16 proving keys are public parameters, not secrets. The coordinator
generates them once per market with `prover setup <dir>`. The coordinator
then publishes the full directory: `open.pk`, `liquidation.pk`, `close.pk`
and the three `.vk` files. The operator places the directory locally and
passes it as `--proving`.

The operator does not need to trust the file transfer. `check` and
`liquidate` run `prover keys <dir>`, which derives each verifying key from
its proving key. It also rejects any `.vk` file that disagrees. The command
then requires the open, liquidation and close SHA-256 fingerprints to equal
`open_vk_sha256`, `liquidation_vk_sha256` and `close_vk_sha256` from the
deployed market's `get_config()`. A mismatch stops before any transaction.

The coordinator still ran the trusted setup. This tooling does not make the
setup independent.

## Operator account

The transaction key must be authorized on an account only the operator
controls. Use either route. These are
[near-cli-rs](https://github.com/near/near-cli-rs) commands that the
operator runs manually. Confirm the exact syntax with `--help` for the
installed version.

- A new faucet-sponsored account with the generated public key:

  ```text
  near account create-account sponsor-by-faucet-service <account>.testnet use-manually-provided-public-key <tx_public_key> network-config testnet create
  ```

- An existing operator-owned account, adding only the new key. A
  function-call key limited to `liquidate` on the market is enough for
  submission. Withdrawing a bounty needs a different key, because
  `withdraw(amount)` requires a 1 yoctoNEAR deposit.

  ```text
  near account add-key <account>.testnet grant-function-call-access --allowance '0.5 NEAR' --contract-account-id <market>.testnet --function-names liquidate use-manually-provided-public-key <tx_public_key> network-config testnet sign-with-keychain send
  ```

Never give the coordinator a key for this account, and never create it as
a coordinator subaccount.

## Fresh market requirement

Keepers are fixed at `init(token_id, trader_id, maker_id, oracle_id,
keepers, deployment_id, open_vk, liquidation_vk, close_vk)`. The contract
has no keeper update method. Therefore the deployed
`market.xythum-perps-demo.testnet` keeps its coordinator-controlled Keeper B,
and an independent Keeper B needs a fresh market account. That deployment
needs a fresh `deployment_id` and a fresh proving directory. The
coordinator passes only the public `check-manifest` registration as
`keepers[1]`.

## Sequence

`O` is the operator. `C` is the coordinator, who holds the trader, maker,
oracle and Keeper A keys. Each arrow is a public message.

1. **O** `init --account <account>.testnet --keys <dir>\keeper-b.keeper-keys.json --manifest keeper-b.manifest.json`.
   On Windows, O first makes `<dir>` private (see "Key file and
   manifest").
2. **O** creates or authorizes the account (see "Operator account") and
   funds it with testnet NEAR for gas.
3. **O → C** `keeper-b.manifest.json` and its SHA-256. O hashes the exact
   file bytes. C recomputes the hash on receipt, and the two values must
   match.

   ```text
   Get-FileHash -Algorithm SHA256 keeper-b.manifest.json    # PowerShell
   certutil -hashfile keeper-b.manifest.json SHA256         # cmd.exe
   sha256sum keeper-b.manifest.json                         # Linux
   shasum -a 256 keeper-b.manifest.json                     # macOS
   ```

4. **C** `check-manifest --manifest keeper-b.manifest.json --coordinator <root>.testnet --out keeper-b.registration.json`
5. **C** runs `prover setup <fresh dir>` and deploys a fresh market. The
   deployment calls `init(...)` with
   `keepers: [{ account_id: <keeper A>, ack_key: <A ack> }, registration.keeper]`.
   C publishes the market ID, the init transaction hash and the proving
   directory.
6. **C** calls `storage_deposit({ account_id: <keeper B>, registration_only: true })`
   on the token, so a later bounty withdrawal can pay out. C funds the
   trader and maker and publishes the entry oracle round with
   `publish_oracle(round, price_ticks, funding_cents)`.
7. **O** `check --keys … --market <market>.testnet --proving <dir> --out check.json`
   and confirms that every check passes.
8. **C** prepares the position with
   `recipients: [<A encryption key>, registration.encryption_key]`. C then
   calls `stage_position(nonce, commitment, quote_terms, ciphertexts)`, and
   the maker calls `approve_quote(nonce, commitment, quote_terms,
   open_price_ticks, expires_at)`.
9. **O** `ack --keys … --market <market>.testnet --out ack-<nonce>.json`
10. **O → C** `ack-<nonce>.json`.
11. **C** calls `open(nonce, commitment, acknowledgments: [<A signature>, ack.signature], proof)`.
    The contract verifies both signatures against the registered keys.
12. **O** goes offline and keeps only the key file. C stops using the
    trader and Keeper A keys and publishes a distressed oracle round.
13. **O**, cold: `liquidate --keys … --market <market>.testnet --proving <dir> --dry-run`,
    then `liquidate … --out liquidation-<nonce>.json`. The contract call is
    `liquidate(nonce, root, round, refund, bad_debt, proof)`, signed by the
    Keeper B account.
14. **O → C, public** the liquidation record and transaction hash.

The [Funded market](FUNDED-MARKET.md) acceptance fixture applies. The
position has ten lots, an entry of 10,000 ticks and 50,000 cents of margin.
The opening checkpoint is 200 cents, and the distressed round is 5,200
ticks at a 400-cent index. The expected outcome is `refund` 11,700,
`bad_debt` 0, and a 100-cent bounty credited to
`get_ledger().keeper_available[1]`.

## Sample fixture

The following public manifest was generated with `init` for illustration.
Its private key file was deleted immediately. The account is not
registered, and no market references these keys. Do not register it.

```json
{
  "schema": "xythum-keeper-manifest/v1",
  "network": "testnet",
  "role": "KEEPER_B",
  "keeper_index": 1,
  "account_id": "sample-keeper-op.testnet",
  "tx_public_key": "ed25519:GLphRrxsLDYYYPHxS8kkMJQ22kzMvH3c5D5ksbaxJgsp",
  "encryption_key": "MCowBQYDK2VuAyEA9QzqJBrFTLpPfcMrH70xxu7xvgx7Xx0xnpBYy6U4bnA=",
  "ack_key": "msBfC/usHhJBpSk7/hldNa4959rAUrK5+ubcNTiIEtk="
}
```

`check-manifest --coordinator xythum-perps-demo.testnet` returns this output
for the sample.

```json
{
  "keeper": {
    "account_id": "sample-keeper-op.testnet",
    "ack_key": "msBfC/usHhJBpSk7/hldNa4959rAUrK5+ubcNTiIEtk="
  },
  "encryption_key": "MCowBQYDK2VuAyEA9QzqJBrFTLpPfcMrH70xxu7xvgx7Xx0xnpBYy6U4bnA=",
  "tx_public_key": "ed25519:GLphRrxsLDYYYPHxS8kkMJQ22kzMvH3c5D5ksbaxJgsp"
}
```

## Conditions for an independent claim

Describe a run as having an independent Keeper B only when all of the
following hold and are published.

- A different person ran `init` on a machine they control. The key file
  never left that machine. The coordinator had no access to that machine,
  through a remote session or otherwise.
- The Keeper B account is not the coordinator account and not one of its
  subaccounts. A final-finality `view_access_key_list` taken at
  liquidation lists only keys the operator controls.
- The manifest and its SHA-256 were published before the market `init`.
  `get_config().keepers[1]` equals the manifest's account ID and ack key.
- The `open` transaction carries the signature from the operator's ack
  record.
- The successful `liquidate` transaction's signer is the Keeper B account.
  It was submitted from the operator's machine with this tool at a stated
  commit. The trader and Keeper A signed nothing between `open` and
  settlement.
- The public record keeps the manifest, the init and open transaction
  hashes, `check.json`, the ack record, the liquidation record and its
  final transaction hash. It also keeps a short statement from the
  operator.

Even then, the claim covers only Keeper B key custody and submission. The
coordinator still controls the trader, maker, oracle and Keeper A. The
coordinator also ran the Groth16 trusted setup.

## Self-test

```text
node scripts/keeper-operator.mjs self-test
```

The self-test runs offline in a temporary directory and needs no
`npm ci` or prover. Each CLI invocation runs as a child process with a
loader that makes every socket connection throw. A first check confirms the
loader blocks sockets. The self-test covers these cases.

- Key generation and file fields, and on POSIX the `0600` mode.
- On Windows, the `icacls` check. The self-test makes its temporary
  directory private, so the key file `init` creates passes unchanged. In a
  subdirectory that grants `Everyone` inherited read, `init` must refuse
  before writing any key and leave no key file and no manifest. It then adds
  an `Everyone` read entry to the key file and confirms that `manifest`
  refuses the file. On that temporary file only, it runs the printed
  `/inheritance:r /grant:r` command and confirms that `manifest` still
  refuses the explicit `Everyone` entry. It then removes the entry with
  `/remove:g` and confirms that `manifest` accepts the file.
- Exclusive writes: an existing key file or manifest is never overwritten.
  A refused `init` leaves no key file and no manifest, including when the
  manifest or key path is in a missing directory.
- An existing `--out` path, or one in a missing directory, stops
  `liquidate`, `liquidate --dry-run`, `check`, `ack`, `manifest` and
  `check-manifest` before any network access. Their stderr shows no
  network attempt, their stdout is empty, and the existing file is
  unchanged. A control run with a fresh `--out` reaches the network stage,
  where the loader blocks it, and then removes its empty reservation.
- When a file write fails after the reservation, the complete JSON is
  already on stdout and the partial file is removed.
- Rejection of non-`.keeper-keys.json` paths, non-testnet IDs, unknown
  flags, a missing `--proving` and a missing `--coordinator`.
- The manifest holds exactly the public fields. Its keys match the private
  keys, checked by an Ed25519 sign and verify, an X25519 agreement and NEAR
  key derivation.
- `check-manifest` acceptance and rejection of an extra `txKey` field,
  mainnet, a coordinator subaccount, a wrong-length or reused ack key, a
  non-X25519 encryption key, and a correctly encoded all-zero X25519 key.
  `check-manifest` accepts an encryption key only if an X25519 agreement
  with a fresh transient private key succeeds and yields a nonzero secret.
- No private key, seed or encoding of one appears in the manifest or any
  stdout.
- When `node_modules` is installed, the actor's slot pin. A different
  nonce, or the same nonce with a different commitment, is refused. A pin
  missing one of its two fields makes `actor('prove')` and
  `actor('liquidate')` fail before any network access. Without
  `node_modules` this check is skipped and reported as skipped.
- Git ignores `*.keeper-keys.json`.

The self-test never deploys or submits anything, and it makes no network
request. `check`, `ack` and `liquidate` have no automated testnet coverage.
