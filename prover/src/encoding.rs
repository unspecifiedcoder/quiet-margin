//! NEP-488 byte encodings for Groth16 proofs, verifying keys, and public inputs.
//!
//! The layout was checked against the nearcore reference host implementation
//! (`near-vm-runner` 0.38.1, `src/logic/bls12381.rs`, which delegates to blst's
//! ZCash serialization) and its tests:
//!
//! * G1 uncompressed: `x[48] || y[48]`, each big-endian. The top bit (0x80,
//!   compression flag) must be clear. The point at infinity is encoded with the
//!   0x40 flag set in the first byte and every other bit zero. The third flag
//!   bit (0x20, sign) must be clear for uncompressed points.
//! * G2 uncompressed: `x.c1 || x.c0 || y.c1 || y.c0`, each 48-byte big-endian,
//!   i.e. the imaginary component first. Flags as for G1.
//! * Scalars for `bls12381_g1_multiexp`: 32-byte little-endian.
//! * `bls12381_p1_sum` items: `sign_u8 || point[96]`, sign 0 adds and 1 negates.
//! * `bls12381_pairing_check`: concatenated `G1[96] || G2[192]` pairs,
//!   returning success iff the product of pairings is the identity.

use ark_bls12_381::{Bls12_381, Fq, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{Proof, VerifyingKey};

pub const G1_LEN: usize = 96;
pub const G2_LEN: usize = 192;
pub const SCALAR_LEN: usize = 32;
pub const PROOF_LEN: usize = 2 * G1_LEN + G2_LEN;
pub const OPEN_INPUTS: usize = 7;
/// Shared by the liquidation and close statements (distinct keys).
pub const LIQUIDATION_INPUTS: usize = 9;

pub const fn vk_len(n_inputs: usize) -> usize {
    G1_LEN + 3 * G2_LEN + (n_inputs + 1) * G1_LEN
}

pub const OPEN_VK_LEN: usize = vk_len(OPEN_INPUTS);
pub const LIQUIDATION_VK_LEN: usize = vk_len(LIQUIDATION_INPUTS);

const INFINITY_FLAG: u8 = 0x40;

fn fq_be(f: &Fq) -> [u8; 48] {
    let be = f.into_bigint().to_bytes_be();
    let mut out = [0u8; 48];
    out.copy_from_slice(&be);
    out
}

pub fn g1_bytes(p: &G1Affine) -> [u8; G1_LEN] {
    let mut out = [0u8; G1_LEN];
    match p.xy() {
        None => out[0] = INFINITY_FLAG,
        Some((x, y)) => {
            out[..48].copy_from_slice(&fq_be(&x));
            out[48..].copy_from_slice(&fq_be(&y));
        }
    }
    out
}

pub fn g2_bytes(p: &G2Affine) -> [u8; G2_LEN] {
    let mut out = [0u8; G2_LEN];
    match p.xy() {
        None => out[0] = INFINITY_FLAG,
        Some((x, y)) => {
            out[..48].copy_from_slice(&fq_be(&x.c1));
            out[48..96].copy_from_slice(&fq_be(&x.c0));
            out[96..144].copy_from_slice(&fq_be(&y.c1));
            out[144..].copy_from_slice(&fq_be(&y.c0));
        }
    }
    out
}

/// `A || B || C`
pub fn proof_bytes(proof: &Proof<Bls12_381>) -> Vec<u8> {
    let mut out = Vec::with_capacity(PROOF_LEN);
    out.extend_from_slice(&g1_bytes(&proof.a));
    out.extend_from_slice(&g2_bytes(&proof.b));
    out.extend_from_slice(&g1_bytes(&proof.c));
    out
}

/// `alpha_g1 || beta_g2 || gamma_g2 || delta_g2 || IC[0..=n]`
pub fn vk_bytes(vk: &VerifyingKey<Bls12_381>) -> Vec<u8> {
    let mut out = Vec::with_capacity(vk_len(vk.gamma_abc_g1.len() - 1));
    out.extend_from_slice(&g1_bytes(&vk.alpha_g1));
    out.extend_from_slice(&g2_bytes(&vk.beta_g2));
    out.extend_from_slice(&g2_bytes(&vk.gamma_g2));
    out.extend_from_slice(&g2_bytes(&vk.delta_g2));
    for ic in &vk.gamma_abc_g1 {
        out.extend_from_slice(&g1_bytes(ic));
    }
    out
}

/// 32-byte little-endian scalar encoding of a field element.
pub fn fr_bytes(f: &Fr) -> [u8; SCALAR_LEN] {
    let le = f.into_bigint().to_bytes_le();
    let mut out = [0u8; SCALAR_LEN];
    out.copy_from_slice(&le);
    out
}

pub fn u64_scalar(v: u64) -> [u8; SCALAR_LEN] {
    let mut out = [0u8; SCALAR_LEN];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

/// `[low128, high128]`: the first 16 digest bytes interpreted as a
/// little-endian integer, then the last 16 bytes likewise.
pub fn digest_scalars(d: &[u8; 32]) -> [[u8; SCALAR_LEN]; 2] {
    let mut lo = [0u8; SCALAR_LEN];
    let mut hi = [0u8; SCALAR_LEN];
    lo[..16].copy_from_slice(&d[..16]);
    hi[..16].copy_from_slice(&d[16..]);
    [lo, hi]
}

/// `[commitment_low128, commitment_high128, context_low128, context_high128,
///   quote_terms_low128, quote_terms_high128, open_price_ticks]`
pub fn open_inputs(
    commitment: &[u8; 32],
    context: &[u8; 32],
    quote_terms: &[u8; 32],
    open_price_ticks: u32,
) -> [[u8; SCALAR_LEN]; OPEN_INPUTS] {
    let [c0, c1] = digest_scalars(commitment);
    let [x0, x1] = digest_scalars(context);
    let [q0, q1] = digest_scalars(quote_terms);
    [c0, c1, x0, x1, q0, q1, u64_scalar(open_price_ticks as u64)]
}

/// Liquidation and close statement:
/// `[commitment_low128, commitment_high128, context_low128, context_high128,
///   round, price_ticks, funding_delta_cents, refund, bad_debt]`.
pub fn liquidation_inputs(
    commitment: &[u8; 32],
    context: &[u8; 32],
    round: u64,
    price_ticks: u64,
    funding_cents: u64,
    refund: u64,
    bad_debt: u64,
) -> [[u8; SCALAR_LEN]; LIQUIDATION_INPUTS] {
    let [c0, c1] = digest_scalars(commitment);
    let [x0, x1] = digest_scalars(context);
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

/// Decodes canonical 32-byte LE scalars (all public inputs are < 2^128).
pub fn scalars_to_fr(inputs: &[[u8; SCALAR_LEN]]) -> Vec<Fr> {
    inputs
        .iter()
        .map(|b| Fr::from_le_bytes_mod_order(b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::{AffineRepr, CurveGroup};
    use ark_serialize::CanonicalSerialize;
    use ark_std::UniformRand;

    #[test]
    fn manual_encoding_matches_arkworks_zcash_format() {
        // nearcore's own NEP-488 tests serialize with ark-bls12-381
        // `Compress::No`; the manual encoder must agree byte for byte.
        let mut rng = ark_std::test_rng();
        for _ in 0..8 {
            let p1 = (G1Affine::generator() * Fr::rand(&mut rng)).into_affine();
            let p2 = (G2Affine::generator() * Fr::rand(&mut rng)).into_affine();
            let mut a = Vec::new();
            p1.serialize_uncompressed(&mut a).unwrap();
            assert_eq!(a.as_slice(), g1_bytes(&p1).as_slice());
            let mut b = Vec::new();
            p2.serialize_uncompressed(&mut b).unwrap();
            assert_eq!(b.as_slice(), g2_bytes(&p2).as_slice());
            assert_eq!(g1_bytes(&p1)[0] & 0xe0, 0);
            assert_eq!(g2_bytes(&p2)[0] & 0xe0, 0);
        }
        let mut z1 = Vec::new();
        G1Affine::zero().serialize_uncompressed(&mut z1).unwrap();
        assert_eq!(z1.as_slice(), g1_bytes(&G1Affine::zero()).as_slice());
        assert_eq!(g1_bytes(&G1Affine::zero())[0], 0x40);
        let mut z2 = Vec::new();
        G2Affine::zero().serialize_uncompressed(&mut z2).unwrap();
        assert_eq!(z2.as_slice(), g2_bytes(&G2Affine::zero()).as_slice());
    }

    #[test]
    fn scalar_endianness() {
        assert_eq!(fr_bytes(&Fr::from(0x0102u64))[..2], [0x02, 0x01]);
        assert_eq!(u64_scalar(0x0102), fr_bytes(&Fr::from(0x0102u64)));
        let d: [u8; 32] = core::array::from_fn(|i| i as u8 + 1);
        let [lo, hi] = digest_scalars(&d);
        assert_eq!(
            Fr::from_le_bytes_mod_order(&lo),
            Fr::from(u128::from_le_bytes(d[..16].try_into().unwrap()))
        );
        assert_eq!(
            Fr::from_le_bytes_mod_order(&hi),
            Fr::from(u128::from_le_bytes(d[16..].try_into().unwrap()))
        );
    }

    #[test]
    fn lengths() {
        assert_eq!(PROOF_LEN, 384);
        assert_eq!(OPEN_VK_LEN, 1440);
        assert_eq!(LIQUIDATION_VK_LEN, 1632);
    }
}
