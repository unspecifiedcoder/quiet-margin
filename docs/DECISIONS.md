# Build decisions

- Rust 1.95.0 and cargo-near 0.23.0 scaffold and build on Windows. Linux
  x86-64 runs NEAR Sandbox 2.14.0 via near-sandbox 0.4.0 or the corresponding
  pinned upstream binary. The upstream distribution does not support Windows.
- Claude Code 2.1.322 reported the exact `claude-opus-5-5` model on the initial
  probe. Proof and contract implementation have disjoint worktrees. Codex
  owns the spec, Sandbox integration, and verification.

