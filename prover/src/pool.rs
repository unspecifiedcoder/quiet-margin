//! Relations used by the shared NEP-141 pool. Hash limbs use the same encoding
//! as the clearing market. All amounts are cents of the mock asset.
use ark_bls12_381::Fr;
use ark_crypto_primitives::crh::sha256::constraints::Sha256Gadget;
use ark_r1cs_std::{fields::fp::FpVar, prelude::*, uint8::UInt8};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::circuit::{enforce_bits, max_zero, position_relation};
use crate::encoding::{digest_scalars, scalars_to_fr, u64_scalar};
use crate::model::{MAX_LOTS, MAX_MARGIN_CENTS, Opening, PNL_CAP_CENTS};

pub type Hash = [u8; 32];
const DEPTH: usize = 4;
type Byte = UInt8<Fr>;
const INNER: &[u8] = b"QM:note-inner:2";
const LEAF: &[u8] = b"QM:note-leaf:2";
const NULLIFIER: &[u8] = b"QM:nullifier:2";
const BRANCH: &[u8] = b"QM:branch:1";
const OWNER: &[u8] = b"QM:owner:2";

pub fn digest(parts: &[&[u8]]) -> Hash {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part);
    }
    hash.finalize().into()
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

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Note {
    pub cents: u64,
    pub salt: Hash,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Input {
    pub note: Note,
    pub siblings: [Hash; DEPTH],
    pub right: [bool; DEPTH],
}

fn note_vars(
    cs: &ConstraintSystemRef<Fr>,
    domain: &[Byte],
    owner_tag: &[Byte],
    note: &Note,
) -> Result<(Vec<Byte>, FpVar<Fr>), SynthesisError> {
    let salt = Byte::new_witness_vec(cs.clone(), &note.salt)?;
    let cents = Byte::new_witness_vec(cs.clone(), &note.cents.to_le_bytes())?;
    let inner = sha(INNER, &[domain, owner_tag, &salt])?;
    Ok((sha(LEAF, &[domain, &inner, &cents])?, pack(&cents)?))
}

fn add_membership(
    cs: &ConstraintSystemRef<Fr>,
    input: &Input,
    domain: &[Byte],
    owner: &[Byte],
    tag: &[Byte],
    root: &[FpVar<Fr>],
    nullifier: &[FpVar<Fr>],
    enabled: &Boolean<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let (mut node, value) = note_vars(cs, domain, tag, &input.note)?;
    let nf = sha(NULLIFIER, &[domain, owner, &node])?;
    for (limb, field) in nf.chunks_exact(16).zip(nullifier) {
        enabled
            .select(&pack(limb)?, &FpVar::zero())?
            .enforce_equal(field)?;
    }
    for (sibling, right) in input.siblings.iter().zip(input.right) {
        let right = Boolean::new_witness(cs.clone(), || Ok(right))?;
        let sibling = Byte::new_witness_vec(cs.clone(), sibling)?;
        let l = sibling
            .iter()
            .zip(&node)
            .map(|(s, n)| right.select(s, n))
            .collect::<Result<Vec<_>, _>>()?;
        let r = sibling
            .iter()
            .zip(&node)
            .map(|(s, n)| right.select(n, s))
            .collect::<Result<Vec<_>, _>>()?;
        node = sha(BRANCH, &[&l, &r])?;
    }
    for (limb, field) in node.chunks_exact(16).zip(root) {
        pack(limb)?.conditional_enforce_equal(field, enabled)?;
    }
    enabled
        .select(&value, &FpVar::one())?
        .enforce_not_equal(&FpVar::zero())?;
    enabled.select(&value, &FpVar::zero())
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Spend {
    pub domain: Hash,
    pub root: Hash,
    pub owner: Hash,
    pub inputs: [Input; 2],
    pub two_inputs: bool,
    pub context: Hash,
    pub blinder: Hash,
    pub lots: u16,
    pub entry: u16,
    pub margin: u32,
    pub change: Note,
    pub withdraw: u64,
    pub recipient: Hash,
}

impl Spend {
    pub fn tag(&self) -> Hash {
        digest(&[OWNER, &self.owner])
    }
    pub fn note_leaf(&self, note: &Note) -> Hash {
        let inner = digest(&[INNER, &self.domain, &self.tag(), &note.salt]);
        digest(&[LEAF, &self.domain, &inner, &note.cents.to_le_bytes()])
    }
    pub fn nullifiers(&self) -> [Hash; 2] {
        let nullifier = |i: usize| {
            digest(&[
                NULLIFIER,
                &self.domain,
                &self.owner,
                &self.note_leaf(&self.inputs[i].note),
            ])
        };
        [
            nullifier(0),
            if self.two_inputs {
                nullifier(1)
            } else {
                [0; 32]
            },
        ]
    }
    pub fn opening(&self) -> Opening {
        Opening {
            context: self.context,
            blinder: self.blinder,
            lots: self.lots,
            entry_ticks: self.entry,
            margin_cents: self.margin,
        }
    }
    pub fn position(&self) -> Hash {
        if self.withdraw > 0 {
            self.recipient
        } else {
            crate::model::commitment(&self.opening())
        }
    }
    pub fn public(&self) -> Vec<Hash> {
        let n = self.nullifiers();
        inputs(
            &[
                self.domain,
                self.root,
                n[0],
                n[1],
                self.position(),
                if self.change.cents == 0 {
                    [0; 32]
                } else {
                    self.note_leaf(&self.change)
                },
                if self.withdraw == 0 {
                    self.context
                } else {
                    [0; 32]
                },
                if self.withdraw == 0 {
                    self.tag()
                } else {
                    [0; 32]
                },
            ],
            &[
                u64::from(self.two_inputs),
                u64::from(self.entry),
                self.withdraw,
            ],
        )
    }
}

fn inputs(digests: &[Hash], numbers: &[u64]) -> Vec<Hash> {
    digests
        .iter()
        .flat_map(digest_scalars)
        .chain(numbers.iter().copied().map(u64_scalar))
        .collect()
}

fn allocate(
    cs: &ConstraintSystemRef<Fr>,
    public: &[Hash],
) -> Result<Vec<FpVar<Fr>>, SynthesisError> {
    scalars_to_fr(public)
        .into_iter()
        .map(|value| FpVar::new_input(cs.clone(), || Ok(value)))
        .collect()
}

impl ConstraintSynthesizer<Fr> for Spend {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = allocate(&cs, &self.public())?;
        let domain = Byte::new_witness_vec(cs.clone(), &self.domain)?;
        let owner = Byte::new_witness_vec(cs.clone(), &self.owner)?;
        let tag = sha(OWNER, &[&owner])?;
        bind(&domain, &p[..2])?;
        let second = Boolean::new_witness(cs.clone(), || Ok(self.two_inputs))?;
        Boolean::le_bits_to_fp(std::slice::from_ref(&second))?.enforce_equal(&p[16])?;
        let same = p[4].is_eq(&p[6])? & p[5].is_eq(&p[7])?;
        (same & second.clone()).enforce_equal(&Boolean::FALSE)?;
        let first = add_membership(
            &cs,
            &self.inputs[0],
            &domain,
            &owner,
            &tag,
            &p[2..4],
            &p[4..6],
            &Boolean::TRUE,
        )?;
        let next = add_membership(
            &cs,
            &self.inputs[1],
            &domain,
            &owner,
            &tag,
            &p[2..4],
            &p[6..8],
            &second,
        )?;
        let (change, remaining) = note_vars(&cs, &domain, &tag, &self.change)?;
        let has_change = remaining.is_neq(&FpVar::zero())?;
        for (limb, field) in change.chunks_exact(16).zip(&p[10..12]) {
            has_change
                .select(&pack(limb)?, &FpVar::zero())?
                .enforce_equal(field)?;
        }

        // An exit has zero entry and margin. An open has zero withdrawal and
        // publishes the entry mark while binding margin into its commitment.
        let exit = p[18].is_neq(&FpVar::zero())?;
        enforce_bits(&cs, &p[18], 64)?;
        let context = Byte::new_witness_vec(cs.clone(), &self.context)?;
        let blinder = Byte::new_witness_vec(cs.clone(), &self.blinder)?;
        let lots = Byte::new_witness_vec(cs.clone(), &self.lots.to_le_bytes())?;
        let entry = Byte::new_witness_vec(cs.clone(), &self.entry.to_le_bytes())?;
        let margin = Byte::new_witness_vec(cs.clone(), &self.margin.to_le_bytes())?;
        let pos = sha(b"", &[&context, &blinder, &lots, &entry, &margin])?;
        let recipient = Byte::new_witness_vec(cs.clone(), &self.recipient)?;
        let selected = pos
            .iter()
            .zip(&recipient)
            .map(|(a, b)| exit.select(b, a))
            .collect::<Result<Vec<_>, _>>()?;
        bind(&selected, &p[8..10])?;
        for (bytes, fields) in [(&context, &p[12..14]), (&tag, &p[14..16])] {
            for (limb, field) in bytes.chunks_exact(16).zip(fields) {
                exit.select(&FpVar::zero(), &pack(limb)?)?
                    .enforce_equal(field)?;
            }
        }
        let (lots, entry, margin) = (pack(&lots)?, pack(&entry)?, pack(&margin)?);
        entry.enforce_equal(&p[17])?;
        for var in [&lots, &entry, &margin] {
            var.conditional_enforce_equal(&FpVar::zero(), &exit)?;
        }
        exit.select(&FpVar::one(), &lots)?
            .enforce_not_equal(&FpVar::zero())?;
        exit.select(&FpVar::one(), &margin)?
            .enforce_not_equal(&FpVar::zero())?;
        enforce_bits(&cs, &(FpVar::Constant(Fr::from(MAX_LOTS)) - &lots), 16)?;
        enforce_bits(
            &cs,
            &(FpVar::Constant(Fr::from(MAX_MARGIN_CENTS)) - &margin),
            32,
        )?;
        let notional = &entry * &lots;
        enforce_bits(&cs, &(&margin * Fr::from(3u64) - notional), 48)?;
        (first + next).enforce_equal(&(margin + remaining + &p[18]))
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Close {
    pub domain: Hash,
    pub owner: Hash,
    pub context: Hash,
    pub blinder: Hash,
    pub lots: u16,
    pub entry: u16,
    pub margin: u32,
    pub price: u16,
    pub round: u64,
    pub payout: Note,
}

impl Close {
    fn opening(&self) -> Opening {
        Opening {
            context: self.context,
            blinder: self.blinder,
            lots: self.lots,
            entry_ticks: self.entry,
            margin_cents: self.margin,
        }
    }
    pub fn maker_delta(&self) -> u64 {
        let pnl = (i64::from(self.price) - i64::from(self.entry)) * i64::from(self.lots);
        let credit = (i64::from(self.margin) + pnl.min(i64::from(PNL_CAP_CENTS))).max(0);
        (i64::from(PNL_CAP_CENTS) + i64::from(self.margin) - credit) as u64
    }
    pub fn note_leaf(&self) -> Hash {
        Spend {
            domain: self.domain,
            owner: self.owner,
            ..Default::default()
        }
        .note_leaf(&self.payout)
    }
    pub fn public(&self) -> Vec<Hash> {
        inputs(
            &[
                crate::model::commitment(&self.opening()),
                self.context,
                self.domain,
                digest(&[OWNER, &self.owner]),
                if self.payout.cents == 0 {
                    [0; 32]
                } else {
                    self.note_leaf()
                },
            ],
            &[u64::from(self.price), self.round, self.maker_delta()],
        )
    }
}

impl ConstraintSynthesizer<Fr> for Close {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = allocate(&cs, &self.public())?;
        let position = position_relation(&cs, &self.opening(), &p[..4])?;
        let domain = Byte::new_witness_vec(cs.clone(), &self.domain)?;
        bind(&domain, &p[4..6])?;
        let owner = Byte::new_witness_vec(cs.clone(), &self.owner)?;
        let tag = sha(OWNER, &[&owner])?;
        bind(&tag, &p[6..8])?;
        let (leaf, cents) = note_vars(&cs, &domain, &tag, &self.payout)?;
        let has_payout = cents.is_neq(&FpVar::zero())?;
        for (limb, field) in leaf.chunks_exact(16).zip(&p[8..10]) {
            has_payout
                .select(&pack(limb)?, &FpVar::zero())?
                .enforce_equal(field)?;
        }
        enforce_bits(&cs, &p[10], 16)?;
        // Bind the round even when two consecutive marks are identical.
        enforce_bits(&cs, &p[11], 64)?;
        let pnl = (&p[10] - position.entry) * position.lots;
        let cap = FpVar::Constant(Fr::from(PNL_CAP_CENTS));
        let excess = max_zero(&cs, &(&pnl - &cap))?;
        let payout = max_zero(&cs, &(&position.margin + pnl - excess))?;
        cents.enforce_equal(&payout)?;
        (&cap + position.margin - cents).enforce_equal(&p[12])
    }
}

pub fn prove_json<S: crate::browser::KeySource + ?Sized>(
    kind: &str,
    key: &S,
    fingerprint: &str,
    input: &str,
) -> Result<String, String> {
    prove_json_with_progress(kind, key, fingerprint, input, || {})
}

pub(crate) fn prove_json_with_progress<S: crate::browser::KeySource + ?Sized>(
    kind: &str,
    key: &S,
    fingerprint: &str,
    input: &str,
    key_loaded: impl FnOnce(),
) -> Result<String, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    if input.len() > 20_000 {
        return Err("Pool proof input is too large.".into());
    }
    let count = match kind {
        "spend" => 19,
        "close" => 13,
        _ => return Err("Unknown pool proof.".into()),
    };
    let key = crate::browser::load_key_for_inputs(key, count, kind, fingerprint)?;
    key_loaded();
    let proof = if kind == "spend" {
        let witness: Spend = serde_json::from_str(input).map_err(|_| "Invalid spend input.")?;
        let public = witness.public();
        crate::api::timed_prove(&key, witness, &public)
    } else {
        let witness: Close = serde_json::from_str(input).map_err(|_| "Invalid close input.")?;
        let public = witness.public();
        crate::api::timed_prove(&key, witness, &public)
    }
    .map_err(|_| "Pool proof did not verify. Review the amounts and current root.")?;
    Ok(serde_json::json!({ "proof": STANDARD.encode(proof.0), "proving_ms": proof.1 }).to_string())
}
