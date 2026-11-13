use ark_bls12_381::Fr;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use xythum_prover::collateral::{Hash, Note, Path, Spend, TREE_DEPTH, merkle_parent, pool_domain};
use xythum_prover::model::Opening;

fn fixture() -> Spend {
    let domain = pool_domain("sandbox", "pool.test", "musdc.test");
    let owner = [0xab; 32];
    let first = Note {
        cents: 6_000,
        salt: [1; 32],
    };
    let second = Note {
        cents: 4_000,
        salt: [2; 32],
    };
    let leaves = [
        first.commitment(&domain, &owner),
        second.commitment(&domain, &owner),
    ];
    let mut empty: Hash = [0; 32];
    let mut siblings = [[0; 32]; TREE_DEPTH];
    for sibling in siblings.iter_mut().skip(1) {
        empty = merkle_parent(&empty, &empty);
        *sibling = empty;
    }
    siblings[0] = leaves[1];
    let first_path = Path {
        siblings,
        right: [false; TREE_DEPTH],
    };
    let root = first_path.root(leaves[0]);
    siblings[0] = leaves[0];
    let mut right = [false; TREE_DEPTH];
    right[0] = true;
    let second_path = Path { siblings, right };
    assert_eq!(root, second_path.root(leaves[1]));
    let opening = Opening {
        context: [9; 32],
        blinder: [8; 32],
        lots: 1,
        entry_ticks: 6_800,
        margin_cents: 3_000,
    };
    let change = Note {
        cents: 7_000,
        salt: [3; 32],
    };
    let statement = Spend::statement(domain, root, &owner, [&first, &second], &opening, &change);
    Spend {
        statement,
        owner,
        notes: [(first, first_path), (second, second_path)],
        opening,
        change,
    }
}

fn satisfied(spend: Spend) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    spend.generate_constraints(cs.clone()).unwrap();
    cs.is_satisfied().unwrap()
}

#[test]
fn two_top_ups_fund_private_margin_and_change() {
    let spend = fixture();
    assert!(satisfied(spend.clone()));
    assert_eq!(spend.statement.inputs().len(), 12);

    // Recompute the public change commitment as a malicious prover would. The
    // proof must still fail because the amounts do not balance.
    let mut inflation = spend.clone();
    inflation.change.cents += 1;
    inflation.statement.change = inflation
        .change
        .commitment(&inflation.statement.domain, &inflation.owner);
    assert!(!satisfied(inflation));
}

#[test]
fn replay_forged_path_and_public_output_substitution_fail() {
    let spend = fixture();
    let mut duplicate = spend.clone();
    duplicate.notes[1] = duplicate.notes[0].clone();
    duplicate.statement.nullifiers[1] = duplicate.statement.nullifiers[0];
    duplicate.change.cents = 9_000;
    duplicate.statement.change = duplicate
        .change
        .commitment(&duplicate.statement.domain, &duplicate.owner);
    assert!(!satisfied(duplicate));

    let mut wrong_branch = spend.clone();
    wrong_branch.notes[0].1.right[0] = true;
    assert!(!satisfied(wrong_branch));

    let mut wrong_position = spend;
    wrong_position.statement.position[0] ^= 1;
    assert!(!satisfied(wrong_position));
}
