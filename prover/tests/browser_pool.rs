use ark_bls12_381::Fr;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use xythum_prover::{
    pool::{Close, Input, Note, Spend},
    pool_fast::{FastClose, FastSpend, note_fields},
    pool_poseidon::branch,
};

fn spend() -> Spend {
    let domain = [2; 32];
    let owner = [3; 32];
    let a = Note {
        cents: 6000,
        salt: [4; 32],
    };
    let b = Note {
        cents: 4000,
        salt: [5; 32],
    };
    let leaf_a = note_fields(&domain, &owner, &a)[1];
    let leaf_b = note_fields(&domain, &owner, &b)[1];
    let mut root = branch(&leaf_a, &leaf_b);
    let mut empty = [0; 32];
    let mut siblings = [leaf_b; 4];
    for sibling in siblings.iter_mut().skip(1) {
        empty = branch(&empty, &empty);
        *sibling = empty;
        root = branch(&root, &empty);
    }
    let first = Input {
        note: a,
        siblings,
        right: [false; 4],
    };
    siblings[0] = leaf_a;
    let second = Input {
        note: b,
        siblings,
        right: [true, false, false, false],
    };
    Spend {
        domain,
        owner,
        root,
        inputs: [first, second],
        two_inputs: true,
        context: [7; 32],
        blinder: [8; 32],
        lots: 1,
        entry: 6880,
        margin: 3000,
        change: Note {
            cents: 7000,
            salt: [6; 32],
        },
        ..Spend::default()
    }
}

fn satisfied(circuit: impl ConstraintSynthesizer<Fr>) -> bool {
    let cs = ConstraintSystem::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    assert!(
        cs.num_constraints() < 10_000,
        "browser circuit grew beyond the proving budget"
    );
    cs.is_satisfied().unwrap()
}

#[test]
fn spend_preserves_membership_and_conservation() {
    let valid = spend();
    assert!(satisfied(FastSpend(valid.clone())));
    let mut inflated = valid.clone();
    inflated.change.cents += 1;
    assert!(!satisfied(FastSpend(inflated)));
    let mut replay = valid.clone();
    replay.inputs[1] = replay.inputs[0].clone();
    replay.change.cents = 9000;
    assert!(!satisfied(FastSpend(replay)));
    let mut forged = valid.clone();
    forged.inputs[0].right[0] = true;
    assert!(!satisfied(FastSpend(forged)));

    let mut exit = valid;
    exit.context = [0; 32];
    exit.blinder = [0; 32];
    exit.lots = 0;
    exit.entry = 0;
    exit.margin = 0;
    exit.change.cents = 0;
    exit.withdraw = 10000;
    exit.recipient = [9; 32];
    assert!(satisfied(FastSpend(exit)));
}

#[test]
fn close_returns_the_margin_at_an_unchanged_mark() {
    let open = spend();
    let close = Close {
        domain: open.domain,
        owner: open.owner,
        context: open.context,
        blinder: open.blinder,
        lots: open.lots,
        entry: open.entry,
        margin: open.margin,
        price: open.entry,
        round: 1,
        short: false,
        payout: Note {
            cents: 3000,
            salt: [10; 32],
        },
    };
    assert!(satisfied(FastClose::<false>(close.clone())));
    let mut inflated = close;
    inflated.payout.cents += 1;
    assert!(!satisfied(FastClose::<false>(inflated)));
}

#[test]
fn a_short_gains_when_the_mark_falls_and_loses_when_it_rises() {
    let open = spend();
    let mut close = Close {
        domain: open.domain,
        owner: open.owner,
        context: open.context,
        blinder: open.blinder,
        lots: 1,
        entry: 6880,
        margin: 3000,
        price: 6780,
        round: 2,
        short: true,
        payout: Note {
            cents: 3100,
            salt: [10; 32],
        },
    };
    let short_commitment = FastClose::<true>(close.clone()).public()[0];
    assert!(satisfied(FastClose::<true>(close.clone())));
    close.short = false;
    assert_ne!(
        FastClose::<true>(close.clone()).public()[0],
        short_commitment
    );
    assert!(!satisfied(FastClose::<true>(close.clone())));
    close.short = true;
    close.price = 6980;
    close.payout.cents = 2900;
    assert!(satisfied(FastClose::<true>(close)));
}

#[test]
fn liquidation_requires_unhealthy_equity_and_preserves_the_traders_note() {
    use xythum_prover::pool_fast::{Liquidation, commitment, note_fields};
    for (short, price, expected_cents) in [(false, 4000, 120), (true, 9600, 280)] {
        let context = [13; 32];
        let blinder = [3; 32];
        let domain = [4; 32];
        let owner = [8; 32];
        let opening = Liquidation {
            commitment: commitment(&context, &blinder, 1, 6880, 3000, short),
            context,
            blinder,
            lots: 1,
            entry: 6880,
            margin: 3000,
            short,
            domain,
            owner_tag: note_fields(&domain, &owner, &Note::default())[3],
            price,
            round: 8,
        };
        assert_eq!(opening.payout(), expected_cents);
        assert_eq!(
            opening.public()[4],
            note_fields(
                &domain,
                &owner,
                &Note {
                    cents: expected_cents,
                    salt: blinder
                }
            )[1]
        );
        let cs = ConstraintSystem::new_ref();
        let healthy = Liquidation {
            price: 6880,
            ..opening.clone()
        };
        healthy.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
        let cs = ConstraintSystem::new_ref();
        let invalid = Liquidation {
            short: !short,
            ..opening.clone()
        };
        invalid.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
        let cs = ConstraintSystem::new_ref();
        opening.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
    }
}
