# Funded market pre-deployment review

Codex reviewed the implementation from v1 commit `80b705c` through the
first integrated v2 commit `acedc3b` along the standards and spec axes.
The contract review followed the NEAR contract-audit guidance for
authorization, arithmetic, receipt order, and callback recovery.

## Standards

- Maker approval now signs the exact staged opening mark with the position
  and quote digests. The Sandbox regression rejects an approval carrying a different
  opening mark.
- The testnet deployer generates keys in a temporary sibling directory
  and publishes the complete set together. A failed setup can be retried.
- Each liquidation or close consumes the active slot in the same receipt
  that debits the funded reserve and credits settlement. The maker can
  claim unreserved collateral.
- The private withdrawal callback restores a failed token transfer. A
  failure of the callback receipt itself can leave the withdrawal pending.
  Recovery from that failure remains a production-readiness item.

## Spec

- A trader can reopen at a new funding checkpoint after a profitable
  close. Separate close and liquidation proofs authenticate the same
  current oracle and active slot. The first successful receipt wins.
- The testnet runner has a recovery command for an interrupted built-in
  fixture with an active position. It records the recovery receipts and
  leaves settlement credits claimable.
- Testnet account IDs, signing-variable names, and deployment and demo
  receipt references belong in [the address record](TESTNET-ADDRESSES.md).
  Testnet signing keys stay in the ignored local `.env`.

This review covers the synthetic test deployment. Its deterministic oracle,
single-party proving setup, and same-operator keeper keys define the demo's
trust model.
