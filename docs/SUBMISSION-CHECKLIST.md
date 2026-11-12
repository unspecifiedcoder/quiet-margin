# Quiet Margin submission checklist

Review the [official hackathon rules](https://nearhackathon.com/HACKATHON.md) before submitting.

## Requirements

- [ ] Submit before **2026-11-14 23:59 UTC**.
- [x] Testnet deployments are eligible.
- [ ] Submit **one application** for **Privacy & Private AI** (`privacy`) and **Unstoppable DeFi** (`defi`).
- [ ] Make the repository public only with the team's **explicit approval**.
  A reviewed public release copy of the repository is an option instead of
  flipping this one.
- [ ] Approve the proposed MIT [`LICENSE`](../LICENSE)
  (`Copyright (c) 2026 Xythum NEAR Perps contributors`) before anything
  becomes public.
- [x] The demo video includes the real browser trade, its public explorer view, and the separately labeled keeper evidence.
- [ ] A team member posts the video publicly on X from a team-controlled account, says it was built at NEAR Hackathon, and tags `@NEARProtocol` and `#NEARHackathon`.
- [ ] The team explicitly approves the team-controlled **mainnet** NEAR
  account for any payout. Testnet demo accounts must not be used.
- [ ] The team explicitly approves the **exact** submission (repository URL
  and commit, video, post, tracks, team lead, contact email, team size,
  mainnet account, and contact consent), then submits once.

## Before going public

- [ ] `git status` is clean and `.env`, `.testnet/`, `.sandbox/`, and any
  `*.witness.json` file are untracked. They are listed in `.gitignore`.
- [ ] No burner backup export, signing key, or `.env` value appears in the
  repository, the video, screenshots, or the X post. Backup files control the
  demo wallet; keep them local.
- [ ] Search the full history for secrets before changing visibility. For
  example, `git log -p --all | grep -qE "ed25519:[1-9A-HJ-NP-Za-km-z]{60,}" && echo "FOUND: inspect privately" || echo "clean"`
  prints only `clean`. The `-q` flag keeps any match from being printed. NEAR
  secret keys are about 88 Base58 characters and public keys about 44.
- [x] `node scripts/verify-demo-receipts.mjs --strict` exits 0 and ends with
  `96 passed, 0 failed, 0 skipped`. Skips mean an archival block was
  unavailable and are not acceptable for submission.
- [ ] The latest `bash scripts/sandbox.sh` run passed on the commit being
  submitted, in the [Sandbox workflow](../.github/workflows/sandbox.yml)
  (earlier private provenance: [run 43179059728](https://github.com/unspecifiedcoder/xythum-near-perps/actions/runs/43179059728))
  or on a clean Linux checkout.
- [ ] Links in [`README.md`](../README.md) and [`JUDGES.md`](../JUDGES.md)
  resolve on the public repository, including the video and the NEAR Rocks
  explorer links. The private Actions run link stays marked as provenance.

## Recording and receipts

[Watch the Quiet Margin demo](media/quiet-margin-demo.mp4). It records a real
browser opening and recovering a private testnet wallet, depositing mock
collateral, opening a long, closing, and withdrawing. The same open appears
beside the public transaction and block explorer. The video then compares a
healthy proof rejection with Keeper B settling the same position in a
separate testnet run and shows what public settlement can reveal.

The [judge guide](../JUDGES.md#public-testnet-explorer) links the actual
receipts and blocks. Keep wallet backup files and keys out of the post.
