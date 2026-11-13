//! Experimental two-note margin spend relation. This module is independent of
//! the deployed market and must not be used to receive or custody tokens.
//!
//! Public inputs: pool domain, known Merkle root, two nullifiers, the new
//! position commitment and a private change commitment, in that order.
//! Each digest is represented by two 128-bit little-endian field elements.

use ark_bls12_381::Fr;
use ark_crypto_primitives::crh::sha256::constraints::Sha256Gadget;
use ark_r1cs_std::{fields::fp::FpVar, prelude::*, uint8::UInt8};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use sha2::{Digest as _, Sha256};

use crate::encoding::{SCALAR_LEN, digest_scalars, scalars_to_fr};
use crate::model::{Opening, commitment};

pub const TREE_DEPTH: usize = 4;
pub type Hash = [u8; 32];
type Byte = UInt8<Fr>;
const NOTE: &[u8] = b"QM:note:1";
const SPEND: &[u8] = b"QM:spend:1";
const BRANCH: &[u8] = b"QM:branch:1";

fn digest(parts: &[&[u8]]) -> Hash {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part);
    }
    hash.finalize().into()
}

/// Bind the pool to a chain, deployment, and asset using length-delimited IDs.
pub fn pool_domain(chain: &str, pool: &str, token: &str) -> Hash {
    let mut hash = Sha256::new();
    hash.update(b"QM:pool:1");
    for part in [chain, pool, token] {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

#[derive(Clone)]
pub struct Note {
    pub cents: u64,
    pub salt: Hash,
}

impl Note {
    pub fn commitment(&self, domain: &Hash, owner: &Hash) -> Hash {
        digest(&[NOTE, domain, owner, &self.salt, &self.cents.to_le_bytes()])
    }

    pub fn nullifier(&self, domain: &Hash, owner: &Hash) -> Hash {
        digest(&[SPEND, domain, owner, &self.commitment(domain, owner)])
    }
}

pub fn merkle_parent(left: &Hash, right: &Hash) -> Hash {
    digest(&[BRANCH, left, right])
}

#[derive(Clone)]
pub struct Path {
    pub siblings: [Hash; TREE_DEPTH],
    /// True if the witness node is the right child at this level.
    pub right: [bool; TREE_DEPTH],
}

impl Path {
    pub fn root(&self, leaf: Hash) -> Hash {
        let mut node = leaf;
        for (sibling, right) in self.siblings.iter().zip(self.right) {
            node = if right {
                merkle_parent(sibling, &node)
            } else {
                merkle_parent(&node, sibling)
            };
        }
        node
    }
}

#[derive(Clone)]
pub struct Statement {
    pub domain: Hash,
    pub root: Hash,
    pub nullifiers: [Hash; 2],
    pub position: Hash,
    pub change: Hash,
}

impl Statement {
    pub fn inputs(&self) -> Vec<[u8; SCALAR_LEN]> {
        [
            self.domain,
            self.root,
            self.nullifiers[0],
            self.nullifiers[1],
            self.position,
            self.change,
        ]
        .iter()
        .flat_map(digest_scalars)
        .collect()
    }
}

#[derive(Clone)]
pub struct Spend {
    pub statement: Statement,
    /// Secret unique to this pool, shared by the two input notes and change.
    pub owner: Hash,
    pub notes: [(Note, Path); 2],
    pub opening: Opening,
    pub change: Note,
}

fn sha(prefix: &[u8], parts: &[&[Byte]]) -> Result<Vec<Byte>, SynthesisError> {
    let mut bytes = Byte::constant_vec(prefix);
    for part in parts {
        bytes.extend_from_slice(part);
    }
    Ok(Sha256Gadget::digest(&bytes)?.0)
}

fn pack(bytes: &[Byte]) -> Result<FpVar<Fr>, SynthesisError> {
    let mut bits = Vec::with_capacity(bytes.len() * 8);
    for byte in bytes {
        bits.extend(byte.to_bits_le()?);
    }
    Boolean::le_bits_to_fp(&bits)
}

fn bind(bytes: &[Byte], public: &[FpVar<Fr>]) -> Result<(), SynthesisError> {
    pack(&bytes[..16])?.enforce_equal(&public[0])?;
    pack(&bytes[16..])?.enforce_equal(&public[1])
}

fn note(
    cs: &ConstraintSystemRef<Fr>,
    note: &Note,
    domain: &[Byte],
    owner: &[Byte],
) -> Result<(Vec<Byte>, FpVar<Fr>), SynthesisError> {
    let cents = Byte::new_witness_vec(cs.clone(), &note.cents.to_le_bytes())?;
    let salt = Byte::new_witness_vec(cs.clone(), &note.salt)?;
    Ok((sha(NOTE, &[domain, owner, &salt, &cents])?, pack(&cents)?))
}

impl ConstraintSynthesizer<Fr> for Spend {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let public: Vec<_> = scalars_to_fr(&self.statement.inputs())
            .into_iter()
            .map(|value| FpVar::new_input(cs.clone(), || Ok(value)))
            .collect::<Result<_, _>>()?;
        let domain = Byte::new_witness_vec(cs.clone(), &self.statement.domain)?;
        let owner = Byte::new_witness_vec(cs.clone(), &self.owner)?;
        bind(&domain, &public[..2])?;

        // Two copies of the same note in one proof must fail independently of
        // the consumer's cross-transaction spent-nullifier set.
        let same_lo = public[4].is_eq(&public[6])?;
        let same_hi = public[5].is_eq(&public[7])?;
        (&same_lo & &same_hi).enforce_equal(&Boolean::FALSE)?;

        let mut balance = FpVar::zero();
        for (index, (input, path)) in self.notes.iter().enumerate() {
            let (mut node, cents) = note(&cs, input, &domain, &owner)?;
            cents.enforce_not_equal(&FpVar::zero())?;
            balance += cents;
            let nullifier = sha(SPEND, &[&domain, &owner, &node])?;
            bind(&nullifier, &public[4 + 2 * index..6 + 2 * index])?;
            for (sibling, right) in path.siblings.iter().zip(path.right) {
                let right = Boolean::new_witness(cs.clone(), || Ok(right))?;
                let sibling = Byte::new_witness_vec(cs.clone(), sibling)?;
                let left_vars = sibling
                    .iter()
                    .zip(&node)
                    .map(|(sibling, node)| right.select(sibling, node))
                    .collect::<Result<Vec<_>, _>>()?;
                let right_vars = sibling
                    .iter()
                    .zip(&node)
                    .map(|(sibling, node)| right.select(node, sibling))
                    .collect::<Result<Vec<_>, _>>()?;
                node = sha(BRANCH, &[&left_vars, &right_vars])?;
            }
            bind(&node, &public[2..4])?;
        }

        let position = self.opening;
        let context = Byte::new_witness_vec(cs.clone(), &position.context)?;
        let blinder = Byte::new_witness_vec(cs.clone(), &position.blinder)?;
        let lots = Byte::new_witness_vec(cs.clone(), &position.lots.to_le_bytes())?;
        let entry = Byte::new_witness_vec(cs.clone(), &position.entry_ticks.to_le_bytes())?;
        let margin = Byte::new_witness_vec(cs.clone(), &position.margin_cents.to_le_bytes())?;
        bind(
            &sha(b"", &[&context, &blinder, &lots, &entry, &margin])?,
            &public[8..10],
        )?;
        let margin = pack(&margin)?;
        margin.enforce_not_equal(&FpVar::zero())?;

        let (change, remaining) = note(&cs, &self.change, &domain, &owner)?;
        bind(&change, &public[10..12])?;
        // Two u64 inputs, one u64 change and one u32 margin. Their integer
        // difference has magnitude < 2^66, so field equality cannot wrap.
        balance.enforce_equal(&(margin + remaining))
    }
}

impl Spend {
    pub fn statement(
        domain: Hash,
        root: Hash,
        owner: &Hash,
        notes: [&Note; 2],
        opening: &Opening,
        change: &Note,
    ) -> Statement {
        Statement {
            domain,
            root,
            nullifiers: notes.map(|input| input.nullifier(&domain, owner)),
            position: commitment(opening),
            change: change.commitment(&domain, owner),
        }
    }
}
