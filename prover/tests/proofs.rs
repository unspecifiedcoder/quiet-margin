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

use common::{
    OPEN_PRICE, QUOTE_BLINDER, fixture_opening, native_validate_vk, native_verify, oracle, verifier,
};
use xythum_prover::api::{self, prove_close_with, prove_liquidation_with, prove_open_with};
use xythum_prover::circuit::{
    CloseCircuit, LiquidationCircuit, LiquidationStatement, OpenCircuit, OpenStatement,
};
use xythum_prover::encoding::{self, scalars_to_fr, vk_bytes};
use xythum_prover::model::{self, ModelError, Opening, Oracle, Settlement, SettlementKind};

struct Keys {
    open: ProvingKey<Bls12_381>,
    liq: ProvingKey<Bls12_381>,
    close: ProvingKey<Bls12_381>,
    open_vk: Vec<u8>,
    liq_vk: Vec<u8>,
    close_vk: Vec<u8>,
}

fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let k = api::generate_keys().unwrap();
        let open_vk = vk_bytes(&k.open.vk);
        let liq_vk = vk_bytes(&k.liquidation.vk);
        let close_vk = vk_bytes(&k.close.vk);
        Keys {
            open: k.open,
            liq: k.liquidation,
            close: k.close,
            open_vk,
            liq_vk,
            close_vk,
        }
    })
}

fn honest_open(o: &Opening) -> OpenStatement {
    OpenStatement::honest(o, &QUOTE_BLINDER, OPEN_PRICE)
}

fn open_inputs_of(st: &OpenStatement) -> [[u8; 32]; verifier::OPEN_INPUTS] {
    verifier::open_inputs(
        &st.commitment,
        &st.context,
        &st.quote_terms,
        st.open_price_ticks,
    )
}

fn close_satisfied(opening: &Opening, statement: LiquidationStatement) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    CloseCircuit {
        opening: *opening,
        statement,
    }
    .generate_constraints(cs.clone())
    .unwrap();
    cs.is_satisfied().unwrap()
}

/// Close statement with the formula outputs for the given mode.
fn kind_statement(kind: SettlementKind, o: &Opening, or: &Oracle) -> LiquidationStatement {
    let (refund, bad_debt) = model::settlement_formula_for(kind, o, or);
    LiquidationStatement {
        refund: u64::try_from(refund).unwrap(),
        bad_debt: u64::try_from(bad_debt).unwrap(),
        ..formula_statement(o, or)
    }
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
    open_satisfied_with(opening, &QUOTE_BLINDER, statement)
}

fn open_satisfied_with(
    opening: &Opening,
    quote_blinder: &[u8; 32],
    statement: OpenStatement,
) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    OpenCircuit {
        opening: *opening,
        quote_blinder: *quote_blinder,
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
    let qt = model::quote_terms(&o, &QUOTE_BLINDER);
    for price in [1, OPEN_PRICE, 20_000, u32::MAX] {
        assert_eq!(
            verifier::open_inputs(&cm, &o.context, &qt, price),
            encoding::open_inputs(&cm, &o.context, &qt, price)
        );
    }
    assert_eq!(verifier::OPEN_INPUTS, encoding::OPEN_INPUTS);
    assert_eq!(verifier::LIQUIDATION_INPUTS, encoding::LIQUIDATION_INPUTS);
    assert_eq!(verifier::OPEN_VK_LEN, 1_440);
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
    assert_eq!(k.close_vk.len(), verifier::LIQUIDATION_VK_LEN);
    assert!(native_validate_vk(
        &k.close_vk,
        verifier::LIQUIDATION_INPUTS
    ));
    assert!(!native_validate_vk(
        &k.open_vk,
        verifier::LIQUIDATION_INPUTS
    ));
    // Close and liquidation keys are independent.
    assert_ne!(k.close_vk, k.liq_vk);
    // Every public input has a distinct, non-identity IC point, so each input
    // is bound (an unused input would have IC = 0 and be malleable).
    for vk in [&k.open.vk, &k.liq.vk, &k.close.vk] {
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
    let out = prove_open_with(&k.open, &o, &QUOTE_BLINDER, OPEN_PRICE).unwrap();
    assert_eq!(out.proof.commitment, model::commitment(&o));
    assert_eq!(out.quote_terms, model::quote_terms(&o, &QUOTE_BLINDER));
    let st = honest_open(&o);
    let inputs = open_inputs_of(&st);
    let proof = &out.proof.proof;
    assert!(ark_verify(&k.open, &inputs, proof));
    let (ok, gas) = native_verify(&k.open_vk, proof, &inputs);
    assert!(ok);
    eprintln!("open native verify gas: {gas}");

    // Mutated statement: each public input changed alone.
    for i in 0..inputs.len() {
        let mut m = inputs;
        m[i][0] ^= 1;
        assert!(!native_verify(&k.open_vk, proof, &m).0, "input {i}");
        assert!(!ark_verify(&k.open, &m, proof));
    }
    // Another context (nonce 2, or a later funding checkpoint) fails.
    for ctx in [
        common::fixture_context(2),
        common::fixture_context_at(1, common::CHECKPOINT + 1),
    ] {
        let other = verifier::open_inputs(&st.commitment, &ctx, &st.quote_terms, OPEN_PRICE);
        assert!(!native_verify(&k.open_vk, proof, &other).0);
    }
    // A different opening mark fails, even one at which the position is healthy.
    let moved = verifier::open_inputs(&st.commitment, &o.context, &st.quote_terms, 12_000);
    assert!(!native_verify(&k.open_vk, proof, &moved).0);
    // The quote digest under another quote blinder fails.
    let other_qt = model::quote_terms(&o, &[0x3d; 32]);
    let m = verifier::open_inputs(&st.commitment, &o.context, &other_qt, OPEN_PRICE);
    assert!(!native_verify(&k.open_vk, proof, &m).0);
    // The open proof does not verify under the settlement keys.
    assert!(!native_verify(&k.liq_vk, proof, &inputs).0);
    assert!(!native_verify(&k.close_vk, proof, &inputs).0);
}

#[test]
fn open_rejects_bad_quote_terms() {
    let o = fixture_opening();
    let honest = honest_open(&o);
    assert!(open_satisfied(&o, honest));

    // Tampered digest bytes in each limb.
    for byte in [0usize, 15, 16, 31] {
        let mut st = honest;
        st.quote_terms[byte] ^= 1;
        assert!(!open_satisfied(&o, st), "byte {byte}");
    }
    // Wrong quote blinder witness against the honest digest.
    assert!(!open_satisfied_with(&o, &[0x3d; 32], honest));
    // A quote for different size or entry than the committed position, with
    // the commitment still honest for the real opening.
    for f in [
        (|q: &mut Opening| q.lots = 9) as fn(&mut Opening),
        |q| q.entry_ticks = 9_990,
        |q| q.context = common::fixture_context(2),
    ] {
        let mut quoted = o;
        f(&mut quoted);
        let mut st = honest;
        st.quote_terms = model::quote_terms(&quoted, &QUOTE_BLINDER);
        assert!(!open_satisfied(&o, st));
    }
    // A commitment to different terms cannot reuse an honest quote either.
    let mut other = o;
    other.lots = 9;
    let mut st = OpenStatement::honest(&other, &QUOTE_BLINDER, OPEN_PRICE);
    st.quote_terms = honest.quote_terms;
    assert!(!open_satisfied(&other, st));
    // The quote omits margin and blinder: a different margin keeps the quote.
    let mut m = o;
    m.margin_cents = 40_000;
    let st = OpenStatement::honest(&m, &QUOTE_BLINDER, OPEN_PRICE);
    assert_eq!(st.quote_terms, honest.quote_terms);
    assert!(open_satisfied(&m, st));
}

#[test]
fn open_rejects_bad_mark() {
    let k = keys();
    let o = fixture_opening();
    // 190 * p >= 1,000,000 for the fixture: 5,264 healthy, 5,263 not.
    let at = |p| OpenStatement::honest(&o, &QUOTE_BLINDER, p);
    assert!(open_satisfied(&o, at(5_264)));
    assert!(open_satisfied(&o, at(12_000)));
    assert!(open_satisfied(&o, at(20_000)));
    assert!(!open_satisfied(&o, at(5_263)));
    assert!(!open_satisfied(&o, at(1)));
    assert!(!open_satisfied(&o, at(0)));
    assert!(!open_satisfied(&o, at(20_001)));
    assert!(!open_satisfied(&o, at(u32::MAX)));
    assert!(matches!(
        prove_open_with(&k.open, &o, &QUOTE_BLINDER, 5_263),
        Err(api::Error::Model(ModelError::UnhealthyAtOpen))
    ));
    assert!(matches!(
        prove_open_with(&k.open, &o, &QUOTE_BLINDER, 0),
        Err(api::Error::Model(ModelError::OpenPriceOutOfRange))
    ));

    // Maintenance equality at the opening mark is healthy.
    let mut eq = o;
    eq.margin_cents = 49_992;
    assert_eq!(model::check_open_at(&eq, 5_264), Ok(()));
    assert!(open_satisfied(
        &eq,
        OpenStatement::honest(&eq, &QUOTE_BLINDER, 5_264)
    ));
    assert!(!open_satisfied(
        &eq,
        OpenStatement::honest(&eq, &QUOTE_BLINDER, 5_263)
    ));
    let out = prove_open_with(&k.open, &eq, &QUOTE_BLINDER, 5_264).unwrap();
    let st = OpenStatement::honest(&eq, &QUOTE_BLINDER, 5_264);
    assert!(native_verify(&k.open_vk, &out.proof.proof, &open_inputs_of(&st)).0);
    let mut lower = st;
    lower.open_price_ticks = 5_263;
    assert!(!native_verify(&k.open_vk, &out.proof.proof, &open_inputs_of(&lower)).0);
}

#[cfg(not(debug_assertions))]
#[test]
fn forced_proof_of_unhealthy_open_fails_verification() {
    let k = keys();
    let o = fixture_opening();
    let st = OpenStatement::honest(&o, &QUOTE_BLINDER, 5_263);
    let proof = Groth16::<Bls12_381>::prove(
        &k.open,
        OpenCircuit {
            opening: o,
            quote_blinder: QUOTE_BLINDER,
            statement: st,
        },
        &mut rand::rngs::OsRng,
    )
    .unwrap();
    let bytes = encoding::proof_bytes(&proof);
    assert!(!native_verify(&k.open_vk, &bytes, &st.inputs()).0);
}

#[test]
fn open_relation_enforces_bounds() {
    let base = fixture_opening();
    assert!(open_satisfied(&base, honest_open(&base)));
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
        assert!(!open_satisfied(&o, honest_open(&o)), "{name}");
    }
    // Leverage equality is admitted (each opened at its own entry mark).
    let mut o = base;
    o.margin_cents = 33_334; // 100000 <= 100002
    assert!(open_satisfied(&o, honest_open(&o)));
    let mut o = base;
    o.lots = 3;
    o.entry_ticks = 20_000;
    o.margin_cents = 20_000; // 60000 == 60000
    assert!(open_satisfied(
        &o,
        OpenStatement::honest(&o, &QUOTE_BLINDER, 20_000)
    ));

    // Wrong commitment or context for a valid opening.
    let mut st = honest_open(&base);
    st.commitment[31] ^= 0x80;
    assert!(!open_satisfied(&base, st));
    let mut st = honest_open(&base);
    st.context[0] ^= 1;
    assert!(!open_satisfied(&base, st));
    // A different blinder does not open the same commitment.
    let mut o = base;
    o.blinder[5] ^= 1;
    assert!(!open_satisfied(&o, honest_open(&base)));
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

// ---------------------------------------------------------------- close

#[test]
fn funded_close_verifies_natively() {
    // Ten lots at $100,000, $500 margin, $2 funding delta, $120,000 mark.
    let k = keys();
    let o = fixture_opening();
    let or = oracle(7, 12_000, 200);
    assert_eq!(model::settle(&o, &or), Err(ModelError::Healthy));
    let out = prove_close_with(&k.close, &o, &or).unwrap();
    assert_eq!(
        out.settlement,
        Settlement {
            refund: 79_800,
            bad_debt: 0
        }
    );
    assert_eq!(out.proof.commitment, model::commitment(&o));
    let inputs =
        verifier::liquidation_inputs(&out.proof.commitment, &o.context, 7, 12_000, 200, 79_800, 0);
    let (ok, gas) = native_verify(&k.close_vk, &out.proof.proof, &inputs);
    assert!(ok);
    eprintln!("close native verify gas: {gas}");
    assert!(ark_verify(&k.close, &inputs, &out.proof.proof));
    for i in 0..inputs.len() {
        let mut m = inputs;
        m[i][0] ^= 1;
        assert!(
            !native_verify(&k.close_vk, &out.proof.proof, &m).0,
            "input {i}"
        );
    }
    // A healthy close never verifies as a liquidation.
    assert!(!native_verify(&k.liq_vk, &out.proof.proof, &inputs).0);
    // The liquidation key refuses to prove it at all.
    assert!(matches!(
        prove_liquidation_with(&k.liq, &o, &or),
        Err(api::Error::Model(ModelError::Healthy))
    ));
}

#[test]
fn close_and_liquidation_keys_are_separate() {
    // Distressed slot at $52,000: both modes can prove the same round.
    let k = keys();
    let o = fixture_opening();
    let or = oracle(9, 5_200, 200);
    let close = prove_close_with(&k.close, &o, &or).unwrap();
    let liq = prove_liquidation_with(&k.liq, &o, &or).unwrap();
    assert_eq!(close.settlement.refund, 11_800);
    assert_eq!(liq.settlement.refund, 11_700);
    assert_eq!(close.settlement.bad_debt, liq.settlement.bad_debt);

    let cm = model::commitment(&o);
    let st = |refund| verifier::liquidation_inputs(&cm, &o.context, 9, 5_200, 200, refund, 0);
    assert!(native_verify(&k.close_vk, &close.proof.proof, &st(11_800)).0);
    assert!(native_verify(&k.liq_vk, &liq.proof.proof, &st(11_700)).0);
    // Neither proof crosses keys, with either mode's statement.
    for refund in [11_700, 11_800] {
        assert!(!native_verify(&k.liq_vk, &close.proof.proof, &st(refund)).0);
        assert!(!native_verify(&k.close_vk, &liq.proof.proof, &st(refund)).0);
    }
    // Each relation rejects the other mode's refund.
    let close_st = LiquidationStatement::honest(&o, &or, &close.settlement);
    let liq_st = LiquidationStatement::honest(&o, &or, &liq.settlement);
    assert!(close_satisfied(&o, close_st));
    assert!(!close_satisfied(&o, liq_st));
    assert!(liq_satisfied(&o, liq_st));
    assert!(!liq_satisfied(&o, close_st));
}

#[test]
fn close_refund_is_exact_regardless_of_health() {
    let o = fixture_opening();
    for or in [
        oracle(1, 12_000, 200), // funded profit
        oracle(1, 20_000, 0),   // pnl 100,000 capped at 60,000
        oracle(1, 10_000, 0),   // flat
        oracle(1, 7_000, 200),  // healthy loss
        oracle(1, 5_300, 200),  // just above maintenance
        oracle(1, 5_200, 200),  // distressed
        oracle(1, 5_023, 200),  // equity 30, below the liquidation bounty
        oracle(1, 100, 200),    // bad debt
    ] {
        let s = model::close(&o, &or).unwrap();
        let st = LiquidationStatement::honest(&o, &or, &s);
        assert!(close_satisfied(&o, st), "{or:?}");
        for d in [-1i64, 1, 100, -100] {
            let mut m = st;
            m.refund = (s.refund as i64 + d) as u64;
            assert!(!close_satisfied(&o, m), "{or:?} {d}");
        }
        let mut m = st;
        m.bad_debt += 1;
        assert!(!close_satisfied(&o, m), "{or:?}");
        // Close and liquidation formulas agree exactly except for the bounty.
        let (lr, lb) = model::settlement_formula(&o, &or);
        assert_eq!(lb as u64, s.bad_debt);
        let capped = model::equity(&o, &or) - (model::pnl(&o, or.price_ticks) - 60_000).max(0);
        assert_eq!(s.refund as i128 - lr, capped.max(0) - (capped - 100).max(0));
    }
    // Pnl cap: 10000 + (50000 + 60000) = 120,000.
    assert_eq!(
        model::close(&o, &oracle(1, 20_000, 0)).unwrap().refund,
        120_000
    );
    // Below-bounty equity is refunded in full on close.
    assert_eq!(
        model::close(&o, &oracle(1, 5_023, 200)).unwrap().refund,
        10_030
    );
}

#[test]
fn close_relation_enforces_bounds_independently() {
    let o = fixture_opening();
    let or = oracle(1, 12_000, 200);
    let honest = kind_statement(SettlementKind::Close, &o, &or);
    assert!(close_satisfied(&o, honest));

    // Funding delta above 200.
    assert!(!close_satisfied(
        &o,
        kind_statement(SettlementKind::Close, &o, &oracle(1, 12_000, 201))
    ));
    // Round zero; price zero, above range, and beyond u32.
    let mut m = honest;
    m.round = 0;
    assert!(!close_satisfied(&o, m));
    for price in [0u32, 20_001] {
        assert!(!close_satisfied(
            &o,
            kind_statement(SettlementKind::Close, &o, &oracle(1, price, 200))
        ));
    }
    let mut m = honest;
    m.price_ticks = 1 << 32;
    assert!(!close_satisfied(&o, m));
    // Out-of-range opening.
    let mut bad = o;
    bad.margin_cents = 33_333;
    assert!(!close_satisfied(
        &bad,
        kind_statement(SettlementKind::Close, &bad, &or)
    ));
    // Wrong commitment and wrong context (other nonce or funding checkpoint).
    let mut m = honest;
    m.commitment[0] ^= 1;
    assert!(!close_satisfied(&o, m));
    for ctx in [
        common::fixture_context(2),
        common::fixture_context_at(1, common::CHECKPOINT + 1),
    ] {
        let mut m = honest;
        m.context = ctx;
        assert!(!close_satisfied(&o, m));
    }
}

// ---------------------------------------------------------------- malformed

#[test]
fn malformed_and_mutated_proofs_fail_closed() {
    let k = keys();
    let o = fixture_opening();
    let out = prove_open_with(&k.open, &o, &QUOTE_BLINDER, OPEN_PRICE).unwrap();
    let inputs = open_inputs_of(&honest_open(&o));
    let p = &out.proof.proof;
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
    assert!(!native_verify(&k.open_vk[..verifier::OPEN_VK_LEN - 1], p, &inputs).0);
    assert!(!native_verify(&k.open_vk, p, &inputs[..verifier::OPEN_INPUTS - 1]).0);
    // Mutated VK.
    let mut vk = k.open_vk.clone();
    vk[96 + 192 + 50] ^= 1; // gamma
    assert!(!native_verify(&vk, p, &inputs).0);
    let mut vk = k.open_vk.clone();
    vk[verifier::OPEN_VK_LEN - 1] ^= 1; // last IC
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
