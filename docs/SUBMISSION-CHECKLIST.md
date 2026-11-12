# Submission checklist

This is a working checklist for the team. Nothing here has been posted or
submitted. The requirements below come from the team's brief. Confirm each one
against the official
[hackathon rules](https://nearhackathon.com/HACKATHON.md), in particular
Q-012 and Q-014, before submitting.

## Requirements

- [ ] Submit before **2026-11-14 23:59 UTC**
  ([official rules](https://nearhackathon.com/HACKATHON.md)).
- [ ] Make the repository public. It is private until the team approves.
- [ ] Approve the proposed MIT [`LICENSE`](../LICENSE)
  (`Copyright (c) 2026 Xythum NEAR Perps contributors`) before the
  repository becomes public.
- [ ] Record the demo video (shot list below).
- [ ] A team member posts the video on X, tagging `@NEARProtocol` with
  `#NEARHackathon`, from a team-controlled account.
- [ ] Provide a team-controlled **mainnet** NEAR account for any payout.
  The testnet demo accounts must not be used for this.
- [ ] Submit once, only after the team approves the final repository,
  video, and post.

## Before going public

- [ ] `git status` is clean and `.env`, `.testnet/`, `.sandbox/`, and any
  `*.witness.json` file are untracked. They are listed in `.gitignore`.
- [ ] Search the full history for secrets before changing visibility. For
  example, `git log -p --all | grep -qE "ed25519:[1-9A-HJ-NP-Za-km-z]{60,}" && echo "FOUND: inspect privately" || echo "clean"`
  prints only `clean`. The `-q` flag keeps any match from being printed. NEAR
  secret keys are about 88 Base58 characters and public keys about 44.
- [ ] `node scripts/verify-demo-receipts.mjs --strict` exits 0 and ends with
  `96 passed, 0 failed, 0 skipped`. Skips mean an archival block was
  unavailable and are not acceptable for submission.
- [ ] The latest `bash scripts/sandbox.sh` run passed on the commit being
  submitted, in the [Sandbox workflow](../.github/workflows/sandbox.yml)
  (last verified: [run 43179059728](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43179059728))
  or on a clean Linux checkout.
- [ ] Links in [`README.md`](../README.md) and [`JUDGES.md`](../JUDGES.md) resolve on the
  public repository, including the GitHub Actions run and artifact links.

## Recording shot list (draft)

Target length is about three minutes. Record the browser at 1280 px or wider
with the terminal beside it. Do not show `.env`, `.testnet/`, wallet screens,
or any signing key.

| # | Shot | On screen | Say |
| --- | --- | --- | --- |
| 1 | Title | README heading | Confidential BTC perp on native NEAR: hidden size, entry, and margin, with on-chain Groth16 checks through NEP-488. |
| 2 | Start | `node scripts/serve-demo.mjs`, then the page header | This is a read-only static replay of final testnet transactions. It signs nothing, reads nothing live, and cannot create trades. |
| 3 | Open | `#step-1` | Left is the synthetic trader view. Right is the public transaction. The chain sees only digests, two encrypted keeper envelopes, and fixed escrow. |
| 4 | Healthy refusal | `#step-2` | At $70,000 equity is $198 against $35 maintenance. The contract supplies its own oracle price to the verifier, so the keeper's proof fails with `ERR_PROOF_INVALID`. |
| 5 | Cold keeper | `#step-3` | At $52,000 equity is $18 against $26. Keeper B alone decrypts its envelope and liquidates while the trader and Keeper A are offline. The derived refund matches the public 117 mUSDC. |
| 6 | Settlement | `#step-4` | The runner resubmitted the same liquidation, and it fails with `ERR_NO_ACTIVE`. Keeper B withdraws its 1 mUSDC bounty. Claims equal the market's token balance. |
| 7 | Inference | Inference section | Honest limit: after a profitable close, 798 minus 600 plus 2 gives $200 gross, below the PnL cap. If the maker follows its off-chain 1% band, there is exactly one answer, 0.01 BTC at $100,000. Margin stays hidden. |
| 8 | Verify | `node scripts/verify-demo-receipts.mjs --strict` scrolling to `96 passed, 0 failed, 0 skipped` | Anyone can check the listed receipts and the manifest's public arguments against public RPC without keys. |
| 9 | Explorer | One NearBlocks link from the page | The same hash on a public explorer. |
| 10 | Code | `src/lib.rs` `settle`, then `prover/src/circuit.rs` settlement relation | The contract builds the statement from its own state and clears the slot and credits the refund and bounty as claims in the same receipt. Later withdraw receipts pay the tokens. |
| 11 | Close | `JUDGES.md` threat model | Test oracle, mock token, single-party setup, and the testnet operator controlled both keepers. These are the next production steps. |
