//! R1CS relations for the open and liquidation statements.
//!
//! Every integer that participates in an inequality is decomposed into
//! booleans, so that a comparison `a <= b` is encoded as "`b - a` is a sum of
//! at most `k` bits" with `k` far below the 255-bit field size. Every base value
//! is bounded first (`lots`, `entry`, `margin` from their byte encodings and
//! bounds, `price` and `round` by explicit decompositions), so all derived
//! linear combinations have integer magnitude below 2^46 and a negative value
//! can never wrap into the accepted range.
//!
//! Public input order (each an Fr element, see `encoding`):
//! open:        `[commitment_lo, commitment_hi, context_lo, context_hi]`
//! liquidation: open || `[round, price_ticks, funding_cents, refund, bad_debt]`

use ark_bls12_381::Fr;
use ark_crypto_primitives::crh::sha256::constraints::Sha256Gadget;
use ark_ff::{BigInteger, PrimeField};
use ark_r1cs_std::prelude::*;
use ark_r1cs_std::{fields::fp::FpVar, uint8::UInt8};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use crate::encoding::{SCALAR_LEN, liquidation_inputs, open_inputs, scalars_to_fr};
use crate::model::{
    BOUNTY_CENTS, ESCROW_CENTS, MAINTENANCE_DIVISOR, MAX_ENTRY_TICKS, MAX_FUNDING_CENTS,
    MAX_LEVERAGE, MAX_LOTS, MAX_MARGIN_CENTS, MIN_ENTRY_TICKS, MIN_LOTS, MIN_MARGIN_CENTS, Opening,
    Oracle, PNL_CAP_CENTS, Settlement, commitment,
};

/// Bit width for comparison slack of derived (signed) quantities.
const SLACK_BITS: usize = 64;

/// Public statement of a liquidation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationStatement {
    pub commitment: [u8; 32],
    pub context: [u8; 32],
    pub round: u64,
    pub price_ticks: u64,
    pub funding_cents: u64,
    pub refund: u64,
    pub bad_debt: u64,
}

impl LiquidationStatement {
    pub fn inputs(&self) -> Vec<[u8; SCALAR_LEN]> {
        liquidation_inputs(
            &self.commitment,
            &self.context,
            self.round,
            self.price_ticks,
            self.funding_cents,
            self.refund,
            self.bad_debt,
        )
        .to_vec()
    }

    pub fn honest(opening: &Opening, oracle: &Oracle, s: &Settlement) -> Self {
        Self {
            commitment: commitment(opening),
            context: opening.context,
            round: oracle.round,
            price_ticks: oracle.price_ticks as u64,
            funding_cents: oracle.funding_cents as u64,
            refund: s.refund,
            bad_debt: s.bad_debt,
        }
    }
}

/// Public statement of an open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenStatement {
    pub commitment: [u8; 32],
    pub context: [u8; 32],
}

impl OpenStatement {
    pub fn inputs(&self) -> Vec<[u8; SCALAR_LEN]> {
        open_inputs(&self.commitment, &self.context).to_vec()
    }

    pub fn honest(opening: &Opening) -> Self {
        Self {
            commitment: commitment(opening),
            context: opening.context,
        }
    }
}

/// Open relation: the commitment opens to in-bounds position parameters.
#[derive(Clone)]
pub struct OpenCircuit {
    pub opening: Opening,
    pub statement: OpenStatement,
}

/// Liquidation relation: open relation, oracle bounds, strict deficiency,
/// and exact refund and bad debt.
#[derive(Clone)]
pub struct LiquidationCircuit {
    pub opening: Opening,
    pub statement: LiquidationStatement,
}

/// Placeholder witness for key generation (values are never read in setup).
pub fn dummy_opening() -> Opening {
    Opening {
        context: [0; 32],
        blinder: [0; 32],
        lots: 1,
        entry_ticks: 1,
        margin_cents: 1,
    }
}

impl OpenCircuit {
    pub fn setup_shape() -> Self {
        let o = dummy_opening();
        Self {
            opening: o,
            statement: OpenStatement::honest(&o),
        }
    }
}

impl LiquidationCircuit {
    pub fn setup_shape() -> Self {
        let o = dummy_opening();
        Self {
            opening: o,
            statement: LiquidationStatement {
                commitment: commitment(&o),
                context: o.context,
                round: 1,
                price_ticks: 1,
                funding_cents: 0,
                refund: 0,
                bad_debt: 0,
            },
        }
    }
}

fn constant(cs: &ConstraintSystemRef<Fr>, v: u64) -> FpVar<Fr> {
    let _ = cs;
    FpVar::Constant(Fr::from(v))
}

/// Interprets a field element as a signed integer (values above (p-1)/2 are
/// negative). Only used to pick witness values; soundness never depends on it.
fn signed_value(f: Fr) -> i128 {
    let half = Fr::from(-1i64).into_bigint();
    let mut half = half;
    half.div2();
    let big = f.into_bigint();
    if big > half {
        let neg = (-f).into_bigint();
        -(u128_from_bigint(&neg) as i128)
    } else {
        u128_from_bigint(&big) as i128
    }
}

fn u128_from_bigint(b: &<Fr as PrimeField>::BigInt) -> u128 {
    // Values used here are far below 2^127; higher limbs are ignored on
    // purpose because the witness is only a hint.
    (b.0[0] as u128) | ((b.0[1] as u128) << 64)
}

fn fr_from_i128(v: i128) -> Fr {
    if v < 0 {
        -Fr::from(v.unsigned_abs())
    } else {
        Fr::from(v as u128)
    }
}

/// Enforces `0 <= v < 2^bits` (as an integer) by boolean decomposition.
fn enforce_bits(
    cs: &ConstraintSystemRef<Fr>,
    v: &FpVar<Fr>,
    bits: usize,
) -> Result<(), SynthesisError> {
    assert!(bits < 128);
    let mut booleans = Vec::with_capacity(bits);
    for i in 0..bits {
        let b = Boolean::new_witness(cs.clone(), || {
            let x = v.value()?.into_bigint();
            Ok(x.get_bit(i))
        })?;
        booleans.push(b);
    }
    Boolean::le_bits_to_fp(&booleans)?.enforce_equal(v)
}

/// Enforces `z = max(x, 0)` for integers `x` with `|x| < 2^SLACK_BITS`:
/// `z >= 0`, `z - x >= 0`, and `z * (z - x) = 0`.
fn enforce_max_zero(
    cs: &ConstraintSystemRef<Fr>,
    z: &FpVar<Fr>,
    x: &FpVar<Fr>,
) -> Result<(), SynthesisError> {
    enforce_bits(cs, z, SLACK_BITS)?;
    let gap = z - x;
    enforce_bits(cs, &gap, SLACK_BITS)?;
    z.mul_equals(&gap, &FpVar::zero())
}

/// Allocates `max(x, 0)` as a witness and constrains it.
fn max_zero(cs: &ConstraintSystemRef<Fr>, x: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let z = FpVar::new_witness(cs.clone(), || {
        Ok(fr_from_i128(signed_value(x.value()?).max(0)))
    })?;
    enforce_max_zero(cs, &z, x)?;
    Ok(z)
}

/// Little-endian packing of bytes into one field element.
fn pack_le(bytes: &[UInt8<Fr>]) -> Result<FpVar<Fr>, SynthesisError> {
    assert!(bytes.len() * 8 < 254);
    let bits: Vec<Boolean<Fr>> = bytes.iter().flat_map(|b| b.to_bits_le().unwrap()).collect();
    Boolean::le_bits_to_fp(&bits)
}

/// Enforces `lo <= v <= hi` for a value known to be below 2^bits.
fn enforce_range(
    cs: &ConstraintSystemRef<Fr>,
    v: &FpVar<Fr>,
    lo: u64,
    hi: u64,
    bits: usize,
) -> Result<(), SynthesisError> {
    enforce_bits(cs, &(v - constant(cs, lo)), bits)?;
    enforce_bits(cs, &(constant(cs, hi) - v), bits)
}

struct PositionVars {
    lots: FpVar<Fr>,
    entry: FpVar<Fr>,
    margin: FpVar<Fr>,
}

fn alloc_scalar_inputs(
    cs: &ConstraintSystemRef<Fr>,
    inputs: &[[u8; SCALAR_LEN]],
) -> Result<Vec<FpVar<Fr>>, SynthesisError> {
    scalars_to_fr(inputs)
        .into_iter()
        .map(|f| FpVar::new_input(cs.clone(), || Ok(f)))
        .collect()
}

/// Shared relation: commitment opening, context binding, and entry/risk bounds.
fn position_relation(
    cs: &ConstraintSystemRef<Fr>,
    opening: &Opening,
    public: &[FpVar<Fr>],
) -> Result<PositionVars, SynthesisError> {
    let (cm_lo, cm_hi, ctx_lo, ctx_hi) = (&public[0], &public[1], &public[2], &public[3]);

    let ctx = UInt8::new_witness_vec(cs.clone(), &opening.context)?;
    let blinder = UInt8::new_witness_vec(cs.clone(), &opening.blinder)?;
    let lots_b = UInt8::new_witness_vec(cs.clone(), &opening.lots.to_le_bytes())?;
    let entry_b = UInt8::new_witness_vec(cs.clone(), &opening.entry_ticks.to_le_bytes())?;
    let margin_b = UInt8::new_witness_vec(cs.clone(), &opening.margin_cents.to_le_bytes())?;

    pack_le(&ctx[..16])?.enforce_equal(ctx_lo)?;
    pack_le(&ctx[16..])?.enforce_equal(ctx_hi)?;

    let mut preimage = Vec::with_capacity(72);
    preimage.extend_from_slice(&ctx);
    preimage.extend_from_slice(&blinder);
    preimage.extend_from_slice(&lots_b);
    preimage.extend_from_slice(&entry_b);
    preimage.extend_from_slice(&margin_b);
    let digest = Sha256Gadget::digest(&preimage)?;
    let d = &digest.0;
    assert_eq!(d.len(), 32);
    pack_le(&d[..16])?.enforce_equal(cm_lo)?;
    pack_le(&d[16..])?.enforce_equal(cm_hi)?;

    // Byte decompositions bound lots, entry < 2^16 and margin < 2^32.
    let lots = pack_le(&lots_b)?;
    let entry = pack_le(&entry_b)?;
    let margin = pack_le(&margin_b)?;
    enforce_range(cs, &lots, MIN_LOTS as u64, MAX_LOTS as u64, 16)?;
    enforce_range(
        cs,
        &entry,
        MIN_ENTRY_TICKS as u64,
        MAX_ENTRY_TICKS as u64,
        16,
    )?;
    enforce_range(
        cs,
        &margin,
        MIN_MARGIN_CENTS as u64,
        MAX_MARGIN_CENTS as u64,
        32,
    )?;
    // Leverage: 3 * margin - entry * lots >= 0.
    let notional = &entry * &lots;
    let lev_slack = &margin * Fr::from(MAX_LEVERAGE as u64) - &notional;
    enforce_bits(cs, &lev_slack, 32)?;

    Ok(PositionVars {
        lots,
        entry,
        margin,
    })
}

impl ConstraintSynthesizer<Fr> for OpenCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let public = alloc_scalar_inputs(&cs, &self.statement.inputs())?;
        position_relation(&cs, &self.opening, &public)?;
        Ok(())
    }
}

impl ConstraintSynthesizer<Fr> for LiquidationCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let public = alloc_scalar_inputs(&cs, &self.statement.inputs())?;
        let pos = position_relation(&cs, &self.opening, &public[..4])?;
        let (round, price, funding, refund, bad_debt) =
            (&public[4], &public[5], &public[6], &public[7], &public[8]);

        // round: nonzero u64 (strictly bound; any change alters the statement).
        enforce_bits(&cs, round, 64)?;
        enforce_bits(&cs, &(round - constant(&cs, 1)), 64)?;
        // The authenticated oracle supports the same bounds as the entry price.
        enforce_bits(&cs, price, 32)?;
        enforce_range(
            &cs,
            price,
            crate::model::MIN_PRICE_TICKS as u64,
            crate::model::MAX_PRICE_TICKS as u64,
            32,
        )?;
        // funding in 0..=200.
        enforce_range(&cs, funding, 0, MAX_FUNDING_CENTS as u64, 8)?;

        let price_lots = price * &pos.lots; // < 2^38
        let entry_lots = &pos.entry * &pos.lots; // < 2^20
        let pnl = &price_lots - &entry_lots;
        let base = &pos.margin - funding; // margin - funding
        let equity = &base + &pnl;

        // Strict deficiency: price * lots - 20 * equity - 1 >= 0.
        let deficiency =
            &price_lots - &equity * Fr::from(MAINTENANCE_DIVISOR as u64) - constant(&cs, 1);
        enforce_bits(&cs, &deficiency, SLACK_BITS)?;

        // bad_debt = max(-equity, 0)
        enforce_max_zero(&cs, bad_debt, &(FpVar::zero() - &equity))?;

        // capped_equity = margin - funding + min(pnl, cap)
        //               = margin - funding + pnl - max(pnl - cap, 0)
        let excess = max_zero(&cs, &(&pnl - constant(&cs, PNL_CAP_CENTS as u64)))?;
        let capped = &equity - &excess;
        // refund = escrow - margin + max(capped - bounty, 0)
        let above_bounty = max_zero(&cs, &(&capped - constant(&cs, BOUNTY_CENTS as u64)))?;
        let expected_refund = constant(&cs, ESCROW_CENTS as u64) - &pos.margin + &above_bounty;
        enforce_bits(&cs, refund, SLACK_BITS)?;
        refund.enforce_equal(&expected_refund)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    #[test]
    fn signed_value_round_trips() {
        for v in [-5i128, 0, 1, 1 << 70, -(1 << 70)] {
            assert_eq!(signed_value(fr_from_i128(v)), v);
        }
    }

    #[test]
    fn setup_shapes_are_satisfiable_shapes() {
        let cs = ConstraintSystem::<Fr>::new_ref();
        OpenCircuit::setup_shape()
            .generate_constraints(cs.clone())
            .unwrap();
        assert_eq!(cs.num_instance_variables(), 1 + 4);
        let cs = ConstraintSystem::<Fr>::new_ref();
        LiquidationCircuit::setup_shape()
            .generate_constraints(cs.clone())
            .unwrap();
        assert_eq!(cs.num_instance_variables(), 1 + 9);
    }
}
