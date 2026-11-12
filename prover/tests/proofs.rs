//! End-to-end Groth16 tests: Arkworks proofs encoded per NEP-488 and checked by
//! the contract verifier on nearcore's host functions, plus R1CS
//! unsatisfiability tests that bypass the host-side `settle` refusal.

mod common;

use std::sync::OnceLock;

use ark_bls12_381::{Bls12_381, Fr};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{Groth16, ProvingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_snark::SNARK;

use common::{fixture_opening, native_validate_vk, native_verify, oracle, verifier};
use xythum_prover::api::{self, prove_liquidation_with, prove_open_with};
use xythum_prover::circuit::{
    LiquidationCircuit, LiquidationStatement, OpenCircuit, OpenStatement,
};
use xythum_prover::encoding::{self, scalars_to_fr, vk_bytes};
use xythum_prover::model::{self, ModelError, Opening, Oracle, Settlement};

struct Keys {
    open: ProvingKey<Bls12_381>,
    liq: ProvingKey<Bls12_381>,
    open_vk: Vec<u8>,
    liq_vk: Vec<u8>,
}

fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let (open, liq) = api::generate_keys().unwrap();
        let open_vk = vk_bytes(&open.vk);
        let liq_vk = vk_bytes(&liq.vk);
        Keys {
            open,
            liq,
            open_vk,
            liq_vk,
        }
    })
}

fn liq_satisfied(opening: &Opening, statement: LiquidationStatement) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    LiquidationCircuit {
        opening: *opening,
        statement,
    }
    .generate_constraints(cs.clone())
    .unwrap();
    cs.is_satisfied().unwrap()
}

fn open_satisfied(opening: &Opening, statement: OpenStatement) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    OpenCircuit {
        opening: *opening,
        statement,
    }
    .generate_constraints(cs.clone())
    .unwrap();
    cs.is_satisfied().unwrap()
}

/// Statement with the would-be formula outputs, ignoring health.
fn formula_statement(o: &Opening, or: &Oracle) -> LiquidationStatement {
    let (refund, bad_debt) = model::settlement_formula(o, or);
    LiquidationStatement {
        commitment: model::commitment(o),
        context: o.context,
        round: or.round,
        price_ticks: or.price_ticks as u64,
        funding_cents: or.funding_cents as u64,
        refund: u64::try_from(refund).unwrap(),
        bad_debt: u64::try_from(bad_debt).unwrap(),
    }
}

fn ark_verify(pk: &ProvingKey<Bls12_381>, inputs: &[[u8; 32]], proof: &[u8]) -> bool {
    use ark_serialize::CanonicalDeserialize;
    let Ok(p) = ark_groth16::Proof::<Bls12_381>::deserialize_uncompressed(proof) else {
        return false;
    };
    Groth16::<Bls12_381>::verify(&pk.vk, &scalars_to_fr(inputs), &p).unwrap_or(false)
}

// ---------------------------------------------------------------- encodings

#[test]
fn verifier_helpers_match_prover_encoding() {
    let o = fixture_opening();
    let cm = model::commitment(&o);
    assert_eq!(
        verifier::open_inputs(&cm, &o.context),
        encoding::open_inputs(&cm, &o.context)
    );
    assert_eq!(
        verifier::liquidation_inputs(&cm, &o.context, 7, 5_200, 200, 11_700, 0),
        encoding::liquidation_inputs(&cm, &o.context, 7, 5_200, 200, 11_700, 0)
    );
    assert_eq!(verifier::OPEN_VK_LEN, encoding::OPEN_VK_LEN);
    assert_eq!(verifier::LIQUIDATION_VK_LEN, encoding::LIQUIDATION_VK_LEN);
    assert_eq!(verifier::PROOF_LEN, encoding::PROOF_LEN);
}

#[test]
fn generated_vks_are_well_formed() {
    let k = keys();
    assert_eq!(k.open_vk.len(), verifier::OPEN_VK_LEN);
    assert_eq!(k.liq_vk.len(), verifier::LIQUIDATION_VK_LEN);
    assert!(native_validate_vk(&k.open_vk, verifier::OPEN_INPUTS));
    assert!(native_validate_vk(&k.liq_vk, verifier::LIQUIDATION_INPUTS));
    assert!(!native_validate_vk(
        &k.open_vk,
        verifier::LIQUIDATION_INPUTS
    ));
    // Every public input has a distinct, non-identity IC point, so each input
    // is bound (an unused input would have IC = 0 and be malleable).
    for vk in [&k.open.vk, &k.liq.vk] {
        for (i, a) in vk.gamma_abc_g1.iter().enumerate() {
            assert!(!a.is_zero());
            for b in &vk.gamma_abc_g1[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
    // A point off the curve is rejected.
    let mut bad = k.open_vk.clone();
    bad[95] ^= 1;
    assert!(!native_validate_vk(&bad, verifier::OPEN_INPUTS));
}

// ---------------------------------------------------------------- open

#[test]
fn open_proof_verifies_natively() {
    let k = keys();
    let o = fixture_opening();
    let out = prove_open_with(&k.open, &o).unwrap();
    assert_eq!(out.commitment, model::commitment(&o));
    let inputs = verifier::open_inputs(&out.commitment, &o.context);
    assert!(ark_verify(&k.open, &inputs, &out.proof));
    let (ok, gas) = native_verify(&k.open_vk, &out.proof, &inputs);
    assert!(ok);
    eprintln!("open native verify gas: {gas}");

    // Mutated statement: each public input changed alone.
    for i in 0..inputs.len() {
        let mut m = inputs;
        m[i][0] ^= 1;
        assert!(!native_verify(&k.open_vk, &out.proof, &m).0, "input {i}");
        assert!(!ark_verify(&k.open, &m, &out.proof));
    }
    // Another context (nonce 2) with the same commitment fails.
    let other = verifier::open_inputs(&out.commitment, &common::fixture_context(2));
    assert!(!native_verify(&k.open_vk, &out.proof, &other).0);
    // The open proof does not verify under the liquidation key.
    assert!(!native_verify(&k.liq_vk, &out.proof, &inputs).0);
}

#[test]
fn open_relation_enforces_bounds() {
    let base = fixture_opening();
    assert!(open_satisfied(&base, OpenStatement::honest(&base)));
    let cases: [(&str, fn(&mut Opening)); 7] = [
        ("lots 0", |o| o.lots = 0),
        ("lots 51", |o| o.lots = 51),
        ("entry 0", |o| o.entry_ticks = 0),
        ("entry 20001", |o| o.entry_ticks = 20_001),
        ("margin 0", |o| o.margin_cents = 0),
        ("margin 60001", |o| o.margin_cents = 60_001),
        ("leverage", |o| {
            o.margin_cents = 33_333; // 100000 > 99999
        }),
    ];
    for (name, f) in cases {
        let mut o = base;
        f(&mut o);
        assert!(model::check_open(&o).is_err(), "{name}");
        assert!(!open_satisfied(&o, OpenStatement::honest(&o)), "{name}");
    }
    // Leverage equality is admitted.
    let mut o = base;
    o.margin_cents = 33_334; // 100000 <= 100002
    assert!(open_satisfied(&o, OpenStatement::honest(&o)));
    let mut o = base;
    o.lots = 3;
    o.entry_ticks = 20_000;
    o.margin_cents = 20_000; // 60000 == 60000
    assert!(open_satisfied(&o, OpenStatement::honest(&o)));

    // Wrong commitment or context for a valid opening.
    let mut st = OpenStatement::honest(&base);
    st.commitment[31] ^= 0x80;
    assert!(!open_satisfied(&base, st));
    let mut st = OpenStatement::honest(&base);
    st.context[0] ^= 1;
    assert!(!open_satisfied(&base, st));
    // A different blinder does not open the same commitment.
    let mut o = base;
    o.blinder[5] ^= 1;
    assert!(!open_satisfied(&o, OpenStatement::honest(&base)));
}

// ---------------------------------------------------------------- liquidation

#[test]
fn spec_fixture_liquidation_verifies_natively() {
    let k = keys();
    let o = fixture_opening();
    let or = oracle(3, 5_200, 200);
    let out = prove_liquidation_with(&k.liq, &o, &or).unwrap();
    assert_eq!(
        out.settlement,
        Settlement {
            refund: 11_700,
            bad_debt: 0
        }
    );
    let inputs =
        verifier::liquidation_inputs(&model::commitment(&o), &o.context, 3, 5_200, 200, 11_700, 0);
    let (ok, gas) = native_verify(&k.liq_vk, &out.proof.proof, &inputs);
    assert!(ok);
    eprintln!("liquidation native verify gas: {gas}");
    assert!(ark_verify(&k.liq, &inputs, &out.proof.proof));

    // Every public input mutated alone fails, including refund and bad debt.
    for i in 0..inputs.len() {
        for delta in [1u8, 2] {
            let mut m = inputs;
            m[i][0] = m[i][0].wrapping_add(delta);
            assert!(
                !native_verify(&k.liq_vk, &out.proof.proof, &m).0,
                "input {i}"
            );
        }
    }
    // Same oracle values under a different round: fails.
    let next_round =
        verifier::liquidation_inputs(&model::commitment(&o), &o.context, 4, 5_200, 200, 11_700, 0);
    assert!(!native_verify(&k.liq_vk, &out.proof.proof, &next_round).0);
    assert!(!ark_verify(&k.liq, &next_round, &out.proof.proof));
}

#[test]
fn changing_round_alone_breaks_verification() {
    let k = keys();
    let o = fixture_opening();
    let a = prove_liquidation_with(&k.liq, &o, &oracle(10, 5_200, 200)).unwrap();
    let b = prove_liquidation_with(&k.liq, &o, &oracle(11, 5_200, 200)).unwrap();
    assert_eq!(a.settlement, b.settlement);
    let cm = model::commitment(&o);
    let st = |round| verifier::liquidation_inputs(&cm, &o.context, round, 5_200, 200, 11_700, 0);
    assert!(native_verify(&k.liq_vk, &a.proof.proof, &st(10)).0);
    assert!(native_verify(&k.liq_vk, &b.proof.proof, &st(11)).0);
    assert!(!native_verify(&k.liq_vk, &a.proof.proof, &st(11)).0);
    assert!(!native_verify(&k.liq_vk, &b.proof.proof, &st(10)).0);
    // Large rounds are bound too (u64 range).
    assert!(!native_verify(&k.liq_vk, &a.proof.proof, &st(10 + (1 << 40))).0);
    // Round zero is outside the relation.
    let mut zero = LiquidationStatement::honest(&o, &oracle(10, 5_200, 200), &a.settlement);
    assert!(liq_satisfied(&o, zero));
    zero.round = 0;
    assert!(!liq_satisfied(&o, zero));
    zero.round = u64::MAX;
    assert!(liq_satisfied(&o, zero));
}

#[test]
fn healthy_position_is_unsatisfiable_in_circuit() {
    let o = fixture_opening();
    // Spec healthy point: 7,000 ticks, equity 19,800 vs maintenance 3,500.
    let healthy = oracle(5, 7_000, 200);
    assert_eq!(model::settle(&o, &healthy), Err(ModelError::Healthy));
    let st = formula_statement(&o, &healthy);
    assert!(!liq_satisfied(&o, st));
    // Every plausible output pair still fails for a healthy position.
    for refund in [0u64, 10_000, 59_700, 69_700, 120_000] {
        for bad_debt in [0u64, 1] {
            let mut s = st;
            s.refund = refund;
            s.bad_debt = bad_debt;
            assert!(!liq_satisfied(&o, s));
        }
    }
}

#[test]
fn maintenance_equality_is_healthy_in_circuit() {
    let mut o = fixture_opening();
    o.margin_cents = 50_002;
    let eq = oracle(1, 5_284, 200);
    assert_eq!(20 * model::equity(&o, &eq), 5_284 * 10);
    assert_eq!(model::settle(&o, &eq), Err(ModelError::Healthy));
    assert!(!liq_satisfied(&o, formula_statement(&o, &eq)));
    let below = oracle(1, 5_283, 200);
    let s = model::settle(&o, &below).unwrap();
    assert_eq!(s.refund, 12_530);
    assert!(liq_satisfied(
        &o,
        LiquidationStatement::honest(&o, &below, &s)
    ));
}

#[cfg(not(debug_assertions))]
#[test]
fn forced_proof_of_healthy_position_fails_verification() {
    // Bypass the host refusal: run the Groth16 prover on the unsatisfied
    // healthy assignment (release builds skip arkworks' debug satisfiability
    // assertion) and check the resulting proof is rejected.
    let k = keys();
    let o = fixture_opening();
    let healthy = oracle(5, 7_000, 200);
    let st = formula_statement(&o, &healthy);
    let proof = Groth16::<Bls12_381>::prove(
        &k.liq,
        LiquidationCircuit {
            opening: o,
            statement: st,
        },
        &mut rand::rngs::OsRng,
    )
    .unwrap();
    let bytes = encoding::proof_bytes(&proof);
    assert!(!native_verify(&k.liq_vk, &bytes, &st.inputs()).0);
    assert!(!ark_verify(&k.liq, &st.inputs(), &bytes));
}

#[test]
fn price_gap_bad_debt_is_exact() {
    let k = keys();
    let o = fixture_opening();
    let gap = oracle(9, 100, 200);
    let out = prove_liquidation_with(&k.liq, &o, &gap).unwrap();
    assert_eq!(
        out.settlement,
        Settlement {
            refund: 10_000,
            bad_debt: 49_200
        }
    );
    let st = LiquidationStatement::honest(&o, &gap, &out.settlement);
    assert!(native_verify(&k.liq_vk, &out.proof.proof, &st.inputs()).0);
    for (refund, bad_debt) in [
        (10_000, 0),
        (10_000, 49_199),
        (10_000, 49_201),
        (9_999, 49_200),
    ] {
        let mut s = st;
        s.refund = refund;
        s.bad_debt = bad_debt;
        assert!(!liq_satisfied(&o, s), "{refund} {bad_debt}");
        assert!(!native_verify(&k.liq_vk, &out.proof.proof, &s.inputs()).0);
    }
}

#[test]
fn refund_is_exact() {
    let o = fixture_opening();
    for or in [
        oracle(1, 5_200, 200),
        oracle(1, 5_023, 200), // equity 30, below bounty
        oracle(1, 4_000, 0),
        oracle(1, 1, 0),
    ] {
        let s = model::settle(&o, &or).unwrap();
        let st = LiquidationStatement::honest(&o, &or, &s);
        assert!(liq_satisfied(&o, st), "{or:?}");
        for d in [-1i64, 1, 100, -100] {
            let mut m = st;
            m.refund = (s.refund as i64 + d) as u64;
            assert!(!liq_satisfied(&o, m), "{or:?} {d}");
        }
        let mut m = st;
        m.bad_debt += 1;
        assert!(!liq_satisfied(&o, m));
    }
}

#[test]
fn liquidation_relation_enforces_bounds_independently() {
    let o = fixture_opening();
    let or = oracle(1, 5_200, 200);
    let s = model::settle(&o, &or).unwrap();
    let honest = LiquidationStatement::honest(&o, &or, &s);
    assert!(liq_satisfied(&o, honest));

    // Funding above 200: formula outputs still unsatisfiable.
    let f = oracle(1, 5_200, 201);
    assert!(!liq_satisfied(&o, formula_statement(&o, &f)));
    // Price zero.
    let mut p = honest;
    p.price_ticks = 0;
    let (r, b) = model::settlement_formula(&o, &oracle(1, 0, 200));
    p.refund = r as u64;
    p.bad_debt = b as u64;
    assert!(!liq_satisfied(&o, p));
    // Price beyond u32.
    let mut p = honest;
    p.price_ticks = 1 << 32;
    assert!(!liq_satisfied(&o, p));

    // Out-of-range openings are rejected by the liquidation relation itself.
    let mut bad = o;
    bad.lots = 60;
    bad.margin_cents = 60_000; // leverage still violated: 600000 > 180000
    let st = formula_statement(&bad, &or);
    assert!(!liq_satisfied(&bad, st));
    let mut bad = o;
    bad.margin_cents = 60_001;
    let st = formula_statement(&bad, &or);
    assert!(!liq_satisfied(&bad, st));

    // Wrong root (commitment) and wrong context.
    let mut m = honest;
    m.commitment[0] ^= 1;
    assert!(!liq_satisfied(&o, m));
    let mut m = honest;
    m.context = common::fixture_context(2);
    assert!(!liq_satisfied(&o, m));
}

// ---------------------------------------------------------------- malformed

#[test]
fn malformed_and_mutated_proofs_fail_closed() {
    let k = keys();
    let o = fixture_opening();
    let out = prove_open_with(&k.open, &o).unwrap();
    let inputs = verifier::open_inputs(&out.commitment, &o.context);
    let p = &out.proof;
    assert!(native_verify(&k.open_vk, p, &inputs).0);

    // Byte flips inside A, B, and C coordinates.
    for off in [10usize, 95, 96 + 10, 96 + 100, 287, 288 + 40, 383] {
        let mut m = p.clone();
        m[off] ^= 0x01;
        assert!(!native_verify(&k.open_vk, &m, &inputs).0, "offset {off}");
    }
    // Compression or sign flags set on each point.
    for off in [0usize, 96, 288] {
        for flag in [0x80u8, 0x20, 0x40] {
            let mut m = p.clone();
            m[off] |= flag;
            assert!(!native_verify(&k.open_vk, &m, &inputs).0);
        }
    }
    // Points at infinity.
    let mut m = p.clone();
    m[..96].fill(0);
    m[0] = 0x40;
    assert!(!native_verify(&k.open_vk, &m, &inputs).0);
    let mut m = p.clone();
    m[96..288].fill(0);
    m[96] = 0x40;
    assert!(!native_verify(&k.open_vk, &m, &inputs).0);
    // Swapped A and C.
    let mut m = p.clone();
    m[..96].copy_from_slice(&p[288..]);
    m[288..].copy_from_slice(&p[..96]);
    assert!(!native_verify(&k.open_vk, &m, &inputs).0);
    // Negated proof (A -> -A) is not accepted.
    let proof = ark_groth16::Proof::<Bls12_381> {
        a: (-<ark_bls12_381::G1Affine as AffineRepr>::into_group(
            ark_serialize::CanonicalDeserialize::deserialize_uncompressed(&p[..96]).unwrap(),
        ))
        .into(),
        ..ark_serialize::CanonicalDeserialize::deserialize_uncompressed(p.as_slice()).unwrap()
    };
    assert!(!native_verify(&k.open_vk, &encoding::proof_bytes(&proof), &inputs).0);
    // Wrong lengths.
    assert!(!native_verify(&k.open_vk, &p[..383], &inputs).0);
    let mut longer = p.clone();
    longer.push(0);
    assert!(!native_verify(&k.open_vk, &longer, &inputs).0);
    assert!(!native_verify(&k.open_vk[..1151], p, &inputs).0);
    assert!(!native_verify(&k.open_vk, p, &inputs[..3]).0);
    // Mutated VK.
    let mut vk = k.open_vk.clone();
    vk[96 + 192 + 50] ^= 1; // gamma
    assert!(!native_verify(&vk, p, &inputs).0);
    let mut vk = k.open_vk.clone();
    vk[1152 - 1] ^= 1; // last IC
    assert!(!native_verify(&vk, p, &inputs).0);

    // Non-canonical scalar: x + r is rejected even though x + r == x mod r.
    let modulus = Fr::MODULUS.to_bytes_le();
    let mut non_canonical = inputs;
    let mut carry = 0u16;
    for j in 0..32 {
        let s = non_canonical[0][j] as u16 + modulus[j] as u16 + carry;
        non_canonical[0][j] = s as u8;
        carry = s >> 8;
    }
    assert_eq!(carry, 0);
    assert!(!native_verify(&k.open_vk, p, &non_canonical).0);
}
