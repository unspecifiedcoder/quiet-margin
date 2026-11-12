//! Xythum NEAR sandbox prover: Groth16 (BLS12-381) circuits for the open,
//! liquidation, and close statements of `docs/FUNDED-MARKET.md` (falling back
//! to `docs/SPEC.md`), a pure Rust reference model, and
//! NEP-488 encodings consumed by the contract verifier (`src/verifier.rs`).
//!
//! The verifier construction (negate `A` with `bls12381_p1_sum`, fold public
//! inputs with `bls12381_g1_multiexp`, one four-pair `bls12381_pairing_check`)
//! is the textbook Groth16 check mapped onto the NEP-488 host functions. The
//! SPEC lists the public Antumbra verifier (github.com/Valentine1898/antumbra,
//! `contracts/pool/src/groth16.rs` at d684c3e) as a reference; no Antumbra code
//! was copied. Encodings were checked against nearcore's `near-vm-runner`.

pub mod api;
pub mod circuit;
pub mod cli;
pub mod encoding;
pub mod model;
