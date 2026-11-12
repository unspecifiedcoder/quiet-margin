# Build decisions

- The native contract uses Rust 1.95.0, near-sdk 5.30.1, and cargo-near
  0.23.0. The private CI uses Node 22.10.0, near-workspaces 5.0.0, and the
  checksum-pinned Linux x86-64 NEAR Sandbox 2.14.0 binary. The upstream
  Sandbox distribution has no Windows build. Windows can build both Wasm
  targets and run the Rust unit suites.
- The Arkworks 0.5 Groth16 prover creates fresh sandbox keys per run. The
  contract checks verifying-key point encodings and subgroup membership at
  initialization and uses the NEP-488 host functions for proof verification.
- Keeper payloads use fixed-size authenticated encryption and persist on
  chain. The Sandbox admission rule trusts both keepers to decrypt and check
  their copy before signing. The deterministic oracle publishes on test
  steps so a keeper has time to prove against the latest round.
- Claude Code 2.1.322 reported `claude-opus-5-5` in `modelUsage` for the
  architecture review and both scoped implementations. Proof and contract
  implementation used disjoint worktrees. Codex integrated the result,
  independently reviewed standards and spec conformance, and ran verification.
