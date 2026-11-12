//! Native Groth16 (BLS12-381) verifier over the NEP-488 host functions.
//!
//! Encodings (checked against nearcore `near-vm-runner` 0.38.1
//! `src/logic/bls12381.rs`, which uses blst's ZCash serialization):
//!
//! * G1 point: 96 bytes, `x || y` big-endian. G2 point: 192 bytes,
//!   `x.c1 || x.c0 || y.c1 || y.c0` big-endian (imaginary part first).
//!   The 0x80 compression flag must be clear; infinity is 0x40 then zeros.
//! * Proof: `A[G1] || B[G2] || C[G1]` (384 bytes).
//! * VK: `alpha_g1 || beta_g2 || gamma_g2 || delta_g2 || IC[0..=n]`.
//! * Public inputs: canonical 32-byte little-endian scalars (`< r`).
//!
//! Check: `e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1`
//! with `vk_x = IC[0] + sum_i x_i * IC[i + 1]`.
//!
//! The verifying keys are raw (unprepared) keys fixed by the contract at
//! initialization; `e(alpha, beta)` is recomputed on every call, so no
//! caller-supplied prepared key is ever trusted. Every malformed input fails
//! closed by returning `false`; host-level aborts are impossible because all
//! host buffers are built with exact item sizes.

use near_sdk::env;

pub(crate) const G1_LEN: usize = 96;
pub(crate) const G2_LEN: usize = 192;
pub(crate) const SCALAR_LEN: usize = 32;
pub(crate) const PROOF_LEN: usize = 2 * G1_LEN + G2_LEN;
pub(crate) const OPEN_INPUTS: usize = 4;
pub(crate) const LIQUIDATION_INPUTS: usize = 9;

pub(crate) const fn vk_len(n_inputs: usize) -> usize {
    G1_LEN + 3 * G2_LEN + (n_inputs + 1) * G1_LEN
}

/// 1152 bytes.
pub(crate) const OPEN_VK_LEN: usize = vk_len(OPEN_INPUTS);
/// 1632 bytes.
pub(crate) const LIQUIDATION_VK_LEN: usize = vk_len(LIQUIDATION_INPUTS);

const COMPRESSION_FLAG: u8 = 0x80;
const INFINITY_FLAG: u8 = 0x40;
const SIGN_FLAG: u8 = 0x20;

/// BLS12-381 scalar field modulus r, little-endian.
const R_LE: [u8; 32] = [
    0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0x02, 0xa4, 0xbd, 0x53,
    0x05, 0xd8, 0xa1, 0x09, 0x08, 0xd8, 0x39, 0x33, 0x48, 0x7d, 0x9d, 0x29, 0x53, 0xa7, 0xed, 0x73,
];

const ONE_LE: [u8; 32] = {
    let mut one = [0u8; 32];
    one[0] = 1;
    one
};

fn is_canonical_scalar(s: &[u8; 32]) -> bool {
    // Little-endian comparison s < r.
    for i in (0..32).rev() {
        if s[i] != R_LE[i] {
            return s[i] < R_LE[i];
        }
    }
    false
}

/// Uncompressed encoding flag sanity (the host re-validates curve/subgroup).
fn flags_ok(point: &[u8]) -> bool {
    point[0] & (COMPRESSION_FLAG | SIGN_FLAG) == 0
}

fn is_infinity(point: &[u8]) -> bool {
    point[0] & INFINITY_FLAG != 0
}

/// Verifies a Groth16 proof. `inputs.len()` must match the key exactly.
pub(crate) fn verify(vk: &[u8], proof: &[u8], inputs: &[[u8; 32]]) -> bool {
    let n = inputs.len();
    if n == 0 || vk.len() != vk_len(n) || proof.len() != PROOF_LEN {
        return false;
    }
    if !inputs.iter().all(is_canonical_scalar) {
        return false;
    }

    let (alpha, rest) = vk.split_at(G1_LEN);
    let (beta, rest) = rest.split_at(G2_LEN);
    let (gamma, rest) = rest.split_at(G2_LEN);
    let (delta, ic) = rest.split_at(G2_LEN);
    let (a, rest) = proof.split_at(G1_LEN);
    let (b, c) = rest.split_at(G2_LEN);

    let fixed = [alpha, beta, gamma, delta];
    if fixed.iter().any(|p| !flags_ok(p) || is_infinity(p)) {
        return false;
    }
    if ic.chunks_exact(G1_LEN).any(|p| !flags_ok(p)) || [a, b, c].iter().any(|p| !flags_ok(p)) {
        return false;
    }

    // vk_x = 1 * IC[0] + sum x_i * IC[i + 1]; multiexp also checks that every
    // IC point is on the curve and in G1.
    let mut msm = Vec::with_capacity((n + 1) * (G1_LEN + SCALAR_LEN));
    let mut ic_points = ic.chunks_exact(G1_LEN);
    let Some(ic0) = ic_points.next() else {
        return false;
    };
    msm.extend_from_slice(ic0);
    msm.extend_from_slice(&ONE_LE);
    for (point, scalar) in ic_points.zip(inputs) {
        msm.extend_from_slice(point);
        msm.extend_from_slice(scalar);
    }
    let Some(vk_x) = env::bls12381_g1_multiexp(&msm) else {
        return false;
    };
    if vk_x.len() != G1_LEN {
        return false;
    }

    // -A via p1_sum with sign byte 1.
    let mut neg_input = [0u8; 1 + G1_LEN];
    neg_input[0] = 1;
    neg_input[1..].copy_from_slice(a);
    let Some(neg_a) = env::bls12381_p1_sum(neg_input) else {
        return false;
    };
    if neg_a.len() != G1_LEN {
        return false;
    }

    // The pairing check validates curve and subgroup membership of every
    // point (including -A, B, C, alpha, beta, gamma, delta).
    let mut pairs = Vec::with_capacity(4 * (G1_LEN + G2_LEN));
    for (g1, g2) in [
        (neg_a.as_slice(), b),
        (alpha, beta),
        (vk_x.as_slice(), gamma),
        (c, delta),
    ] {
        pairs.extend_from_slice(g1);
        pairs.extend_from_slice(g2);
    }
    env::bls12381_pairing_check(&pairs) == Some(true)
}

/// Structural validation of a raw verifying key for initialization: exact
/// length, noninfinite alpha/beta/gamma/delta, every point on the curve and in
/// its prime-order subgroup.
pub(crate) fn validate_vk(vk: &[u8], n_inputs: usize) -> bool {
    if vk.len() != vk_len(n_inputs) {
        return false;
    }
    let (alpha, rest) = vk.split_at(G1_LEN);
    let (g2s, ic) = rest.split_at(3 * G2_LEN);
    if is_infinity(alpha) || g2s.chunks_exact(G2_LEN).any(is_infinity) {
        return false;
    }
    if !flags_ok(alpha)
        || g2s.chunks_exact(G2_LEN).any(|p| !flags_ok(p))
        || ic.chunks_exact(G1_LEN).any(|p| !flags_ok(p))
    {
        return false;
    }
    // Multiexp with zero scalars rejects off-curve and out-of-subgroup points.
    let mut g1 = Vec::with_capacity((n_inputs + 2) * (G1_LEN + SCALAR_LEN));
    for p in core::iter::once(alpha).chain(ic.chunks_exact(G1_LEN)) {
        g1.extend_from_slice(p);
        g1.extend_from_slice(&[0u8; SCALAR_LEN]);
    }
    let mut g2 = Vec::with_capacity(3 * (G2_LEN + SCALAR_LEN));
    for p in g2s.chunks_exact(G2_LEN) {
        g2.extend_from_slice(p);
        g2.extend_from_slice(&[0u8; SCALAR_LEN]);
    }
    env::bls12381_g1_multiexp(&g1).is_some() && env::bls12381_g2_multiexp(&g2).is_some()
}

pub(crate) fn u64_scalar(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

/// `[low128, high128]` with the first 16 digest bytes as a little-endian
/// integer for low128 and the last 16 for high128.
pub(crate) fn digest_scalars(d: &[u8; 32]) -> [[u8; 32]; 2] {
    let mut lo = [0u8; 32];
    let mut hi = [0u8; 32];
    lo[..16].copy_from_slice(&d[..16]);
    hi[..16].copy_from_slice(&d[16..]);
    [lo, hi]
}

/// Contract-owned open statement:
/// `[commitment_low128, commitment_high128, context_low128, context_high128]`.
pub(crate) fn open_inputs(commitment: &[u8; 32], context: &[u8; 32]) -> [[u8; 32]; OPEN_INPUTS] {
    let [c0, c1] = digest_scalars(commitment);
    let [x0, x1] = digest_scalars(context);
    [c0, c1, x0, x1]
}

/// Contract-owned liquidation statement: open inputs followed by
/// `[round, price_ticks, funding_cents, refund, bad_debt]`.
pub(crate) fn liquidation_inputs(
    commitment: &[u8; 32],
    context: &[u8; 32],
    round: u64,
    price_ticks: u64,
    funding_cents: u64,
    refund: u64,
    bad_debt: u64,
) -> [[u8; 32]; LIQUIDATION_INPUTS] {
    let [c0, c1, x0, x1] = open_inputs(commitment, context);
    [
        c0,
        c1,
        x0,
        x1,
        u64_scalar(round),
        u64_scalar(price_ticks),
        u64_scalar(funding_cents),
        u64_scalar(refund),
        u64_scalar(bad_debt),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths() {
        assert_eq!(PROOF_LEN, 384);
        assert_eq!(OPEN_VK_LEN, 1152);
        assert_eq!(LIQUIDATION_VK_LEN, 1632);
    }

    #[test]
    fn canonical_scalars() {
        assert!(is_canonical_scalar(&[0u8; 32]));
        assert!(is_canonical_scalar(&ONE_LE));
        assert!(!is_canonical_scalar(&R_LE));
        let mut r_minus_1 = R_LE;
        r_minus_1[0] = 0;
        assert!(is_canonical_scalar(&r_minus_1));
        assert!(!is_canonical_scalar(&[0xff; 32]));
    }

    #[test]
    fn rejects_bad_lengths_without_host_calls() {
        let vk = vec![0u8; OPEN_VK_LEN];
        let proof = vec![0u8; PROOF_LEN];
        let inputs = [[0u8; 32]; OPEN_INPUTS];
        assert!(!verify(&vk[..OPEN_VK_LEN - 1], &proof, &inputs));
        assert!(!verify(&vk, &proof[..PROOF_LEN - 1], &inputs));
        assert!(!verify(&vk, &proof, &inputs[..3]));
        assert!(!verify(&vk, &proof, &[]));
        assert!(!validate_vk(&vk[..10], OPEN_INPUTS));
    }

    #[test]
    fn rejects_all_zero_encodings() {
        // All-zero bytes are not a valid point (missing infinity flag), and
        // alpha..delta at infinity are rejected outright.
        let vk = vec![0u8; OPEN_VK_LEN];
        let proof = vec![0u8; PROOF_LEN];
        assert!(!verify(&vk, &proof, &[[0u8; 32]; OPEN_INPUTS]));
        assert!(!validate_vk(&vk, OPEN_INPUTS));
        let mut inf = vec![0u8; OPEN_VK_LEN];
        for off in [0, 96, 288, 480] {
            inf[off] = INFINITY_FLAG;
        }
        assert!(!validate_vk(&inf, OPEN_INPUTS));
    }
}
