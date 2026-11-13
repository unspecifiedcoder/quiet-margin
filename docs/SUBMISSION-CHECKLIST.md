# Quiet Margin submission checklist

[Official NEAR Hackathon rules](https://nearhackathon.com/HACKATHON.md)

The submission deadline is **2026-11-14 at 23:59 UTC**, or **2026-11-15 at 5:29 a.m. IST**. Testnet and local demos are eligible. The repository must be public by the deadline and stay public through judging.

- [x] The README explains the problem, native NEAR verification, prior work, and how to reproduce or inspect the demo.
- [x] The [2:41 recording](media/quiet-margin-judge-demo.mp4) and [16 finalized transactions and blocks](QUIET-MARGIN-DEMO.md) are ready.
- [x] Run `node scripts/verify-judge-demo.mjs` to check the video receipts. It uses read-only testnet RPC and requires no credentials.
- [x] Include a [license file](../LICENSE).
- [ ] Check the native Sandbox CI run for the exact commit used for submission.
- [ ] Make the repository public before the deadline. Confirm the submitted repository URL lands on the current README.
- [ ] Publish the public X demo post from a team-controlled account. Attach the video, say it was built at NEAR Hackathon, and include `@NEARProtocol` and `#NEARHackathon`.
- [ ] Submit one entry. Proposed tracks are **Privacy & Private AI** (`privacy`) and **Unstoppable DeFi** (`defi`). Confirm the team lead, email, team size, mainnet NEAR payout account, repository URL, public demo post URL, and contact consent.

Keep local wallet backups, keeper keys, and environment files outside Git. The demo uses test assets. The payout account must be a team-controlled mainnet NEAR account.
