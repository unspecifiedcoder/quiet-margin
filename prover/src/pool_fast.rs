//! Browser pool statements with field-native commitments and hidden membership paths.
use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::{
    constraints::CryptographicSpongeVar, poseidon::constraints::PoseidonSpongeVar,
};
use ark_r1cs_std::{fields::fp::FpVar, prelude::*};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use base64::{Engine, engine::general_purpose::STANDARD};

use crate::circuit::{enforce_bits, max_zero};
use crate::model::{MAX_LOTS, MAX_MARGIN_CENTS, PNL_CAP_CENTS};
use crate::pool::{Close, Input, Note, Spend};
use crate::pool_poseidon::{self as h, Hash, encode, field, hash};

type Var = FpVar<Fr>;
const ZERO: Hash = [0; 32];

fn hash_var(
    cs: &ConstraintSystemRef<Fr>,
    domain: u64,
    fields: Vec<Var>,
) -> Result<Var, SynthesisError> {
    let mut sponge = PoseidonSpongeVar::new(cs.clone(), h::params());
    sponge.state[0] = Var::Constant(Fr::from(domain));
    sponge.absorb(&fields)?;
    Ok(sponge.squeeze_field_elements(1)?.remove(0))
}

pub fn note_fields(domain: &Hash, owner: &Hash, note: &Note) -> [Hash; 4] {
    let tag = hash(h::OWNER, &[field(domain), field(owner)]);
    let inner = encode(hash(h::INNER, &[tag, field(&note.salt)]));
    let leaf = h::leaf(domain, &inner, note.cents);
    let nullifier = encode(hash(h::NULLIFIER, &[field(owner), field(&leaf)]));
    [inner, leaf, nullifier, encode(tag)]
}

fn packed_position(lots: u16, entry: u16, margin: u32) -> u64 {
    u64::from(lots) | (u64::from(entry) << 16) | (u64::from(margin) << 32)
}

pub fn commitment(context: &Hash, blinder: &Hash, lots: u16, entry: u16, margin: u32) -> Hash {
    encode(hash(
        h::POSITION,
        &[
            field(context),
            field(blinder),
            Fr::from(packed_position(lots, entry, margin)),
        ],
    ))
}

fn allocate(cs: &ConstraintSystemRef<Fr>, public: &[Hash]) -> Result<Vec<Var>, SynthesisError> {
    public
        .iter()
        .map(|x| Var::new_input(cs.clone(), || Ok(field(x))))
        .collect()
}

fn note_vars(
    cs: &ConstraintSystemRef<Fr>,
    domain: &Var,
    tag: &Var,
    note: &Note,
) -> Result<(Var, Var), SynthesisError> {
    let salt = Var::new_witness(cs.clone(), || Ok(field(&note.salt)))?;
    let value = Var::new_witness(cs.clone(), || Ok(Fr::from(note.cents)))?;
    enforce_bits(cs, &value, 20)?;
    let inner = hash_var(cs, h::INNER, vec![tag.clone(), salt])?;
    let leaf = hash_var(cs, h::LEAF, vec![domain.clone(), inner, value.clone()])?;
    Ok((leaf, value))
}

fn member(
    cs: &ConstraintSystemRef<Fr>,
    input: &Input,
    domain: &Var,
    owner: &Var,
    tag: &Var,
    root: &Var,
    nullifier: &Var,
    enabled: &Boolean<Fr>,
) -> Result<Var, SynthesisError> {
    let (mut node, value) = note_vars(cs, domain, tag, &input.note)?;
    let nf = hash_var(cs, h::NULLIFIER, vec![owner.clone(), node.clone()])?;
    enabled
        .select(&nf, &Var::zero())?
        .enforce_equal(nullifier)?;
    for (sibling, right) in input.siblings.iter().zip(input.right) {
        let other = Var::new_witness(cs.clone(), || Ok(field(sibling)))?;
        let right = Boolean::new_witness(cs.clone(), || Ok(right))?;
        let left = right.select(&other, &node)?;
        let right = right.select(&node, &other)?;
        node = hash_var(cs, h::BRANCH, vec![left, right])?;
    }
    node.conditional_enforce_equal(root, enabled)?;
    enabled
        .select(&value, &Var::one())?
        .enforce_not_equal(&Var::zero())?;
    enabled.select(&value, &Var::zero())
}

fn position_vars(
    cs: &ConstraintSystemRef<Fr>,
    context: Var,
    blinder: &Hash,
    lots: u16,
    entry: u16,
    margin: u32,
) -> Result<(Var, Var, Var, Var), SynthesisError> {
    let lots = Var::new_witness(cs.clone(), || Ok(Fr::from(lots)))?;
    let entry = Var::new_witness(cs.clone(), || Ok(Fr::from(entry)))?;
    let margin = Var::new_witness(cs.clone(), || Ok(Fr::from(margin)))?;
    enforce_bits(cs, &lots, 16)?;
    enforce_bits(cs, &entry, 16)?;
    enforce_bits(cs, &margin, 32)?;
    enforce_bits(cs, &(Var::Constant(Fr::from(MAX_LOTS)) - &lots), 16)?;
    enforce_bits(
        cs,
        &(Var::Constant(Fr::from(MAX_MARGIN_CENTS)) - &margin),
        32,
    )?;
    enforce_bits(cs, &(&margin * Fr::from(3u64) - &entry * &lots), 48)?;
    let blinder = Var::new_witness(cs.clone(), || Ok(field(blinder)))?;
    let packed = &lots + &entry * Fr::from(1u64 << 16) + &margin * Fr::from(1u64 << 32);
    Ok((
        hash_var(cs, h::POSITION, vec![context, blinder, packed])?,
        lots,
        entry,
        margin,
    ))
}

fn bind_note(leaf: Var, cents: &Var, output: &Var) -> Result<(), SynthesisError> {
    cents
        .is_neq(&Var::zero())?
        .select(&leaf, &Var::zero())?
        .enforce_equal(output)
}

#[derive(Default)]
pub struct FastSpend(pub Spend);

impl FastSpend {
    pub fn public(&self) -> Vec<Hash> {
        let w = &self.0;
        let fields = |note: &Note| note_fields(&w.domain, &w.owner, note);
        let [_, change, _, tag] = fields(&w.change);
        let exit = w.withdraw != 0;
        vec![
            w.domain,
            w.root,
            fields(&w.inputs[0].note)[2],
            if w.two_inputs {
                fields(&w.inputs[1].note)[2]
            } else {
                ZERO
            },
            if exit {
                w.recipient
            } else {
                commitment(&w.context, &w.blinder, w.lots, w.entry, w.margin)
            },
            if w.change.cents != 0 { change } else { ZERO },
            if exit { ZERO } else { w.context },
            if exit { ZERO } else { tag },
            crate::encoding::u64_scalar(u64::from(w.two_inputs)),
            crate::encoding::u64_scalar(u64::from(w.entry)),
            crate::encoding::u64_scalar(w.withdraw),
        ]
    }
}

impl ConstraintSynthesizer<Fr> for FastSpend {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = allocate(&cs, &self.public())?;
        let w = self.0;
        let owner = Var::new_witness(cs.clone(), || Ok(field(&w.owner)))?;
        let tag = hash_var(&cs, h::OWNER, vec![p[0].clone(), owner.clone()])?;
        let second = Boolean::new_witness(cs.clone(), || Ok(w.two_inputs))?;
        Boolean::le_bits_to_fp(std::slice::from_ref(&second))?.enforce_equal(&p[8])?;
        (p[2].is_eq(&p[3])? & second.clone()).enforce_equal(&Boolean::FALSE)?;
        let first = member(
            &cs,
            &w.inputs[0],
            &p[0],
            &owner,
            &tag,
            &p[1],
            &p[2],
            &Boolean::TRUE,
        )?;
        let next = member(
            &cs,
            &w.inputs[1],
            &p[0],
            &owner,
            &tag,
            &p[1],
            &p[3],
            &second,
        )?;
        let (change, remaining) = note_vars(&cs, &p[0], &tag, &w.change)?;
        bind_note(change, &remaining, &p[5])?;

        enforce_bits(&cs, &p[10], 64)?;
        let exit = p[10].is_neq(&Var::zero())?;
        let (commitment, lots, entry, margin) =
            position_vars(&cs, p[6].clone(), &w.blinder, w.lots, w.entry, w.margin)?;
        // The recipient occupies the commitment slot on exits and is supplied by the contract.
        commitment.conditional_enforce_equal(&p[4], &!exit.clone())?;
        // Bind the recipient public input even for circuits compiled without a witness.
        let recipient = Var::new_witness(cs.clone(), || Ok(field(&w.recipient)))?;
        recipient.conditional_enforce_equal(&p[4], &exit)?;
        exit.select(&Var::zero(), &tag)?.enforce_equal(&p[7])?;
        p[6].conditional_enforce_equal(&Var::zero(), &exit)?;
        entry.enforce_equal(&p[9])?;
        for var in [&lots, &entry, &margin] {
            var.conditional_enforce_equal(&Var::zero(), &exit)?;
            exit.select(&Var::one(), var)?
                .enforce_not_equal(&Var::zero())?;
        }
        (first + next).enforce_equal(&(margin + remaining + &p[10]))
    }
}

#[derive(Default)]
pub struct FastClose(pub Close);

impl FastClose {
    pub fn public(&self) -> Vec<Hash> {
        let w = &self.0;
        let [_, leaf, _, tag] = note_fields(&w.domain, &w.owner, &w.payout);
        vec![
            commitment(&w.context, &w.blinder, w.lots, w.entry, w.margin),
            w.context,
            w.domain,
            tag,
            if w.payout.cents != 0 { leaf } else { ZERO },
            crate::encoding::u64_scalar(u64::from(w.price)),
            crate::encoding::u64_scalar(w.round),
            crate::encoding::u64_scalar(w.maker_delta()),
        ]
    }
}

impl ConstraintSynthesizer<Fr> for FastClose {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = allocate(&cs, &self.public())?;
        let w = self.0;
        let (commitment, lots, entry, margin) =
            position_vars(&cs, p[1].clone(), &w.blinder, w.lots, w.entry, w.margin)?;
        commitment.enforce_equal(&p[0])?;
        let owner = Var::new_witness(cs.clone(), || Ok(field(&w.owner)))?;
        let tag = hash_var(&cs, h::OWNER, vec![p[2].clone(), owner])?;
        tag.enforce_equal(&p[3])?;
        let (leaf, cents) = note_vars(&cs, &p[2], &tag, &w.payout)?;
        bind_note(leaf, &cents, &p[4])?;
        enforce_bits(&cs, &p[5], 16)?;
        enforce_bits(&cs, &p[6], 64)?;
        let pnl = (&p[5] - entry) * lots;
        let cap = Var::Constant(Fr::from(PNL_CAP_CENTS));
        let excess = max_zero(&cs, &(&pnl - &cap))?;
        cents.enforce_equal(&max_zero(&cs, &(&margin + pnl - excess))?)?;
        (&cap + margin - cents).enforce_equal(&p[7])
    }
}

pub(crate) fn prove_json<S: crate::browser::KeySource + ?Sized>(
    kind: &str,
    key: &S,
    fingerprint: &str,
    input: &str,
    key_loaded: impl FnOnce(),
) -> Result<String, String> {
    if input.len() > 20_000 {
        return Err("Pool proof input is too large.".into());
    }
    let count = match kind {
        "spend" => 11,
        "close" => 8,
        _ => return Err("Unknown pool proof.".into()),
    };
    let key = crate::browser::load_key_for_inputs(key, count, kind, fingerprint)?;
    key_loaded();
    let (proof, proving_ms) = if kind == "spend" {
        let w = FastSpend(serde_json::from_str(input).map_err(|_| "Invalid spend input.")?);
        let public = w.public();
        crate::api::timed_prove(&key, w, &public)
    } else {
        let w = FastClose(serde_json::from_str(input).map_err(|_| "Invalid close input.")?);
        let public = w.public();
        crate::api::timed_prove(&key, w, &public)
    }
    .map_err(|_| "Pool proof did not verify. Review the amounts and current root.")?;
    Ok(
        serde_json::json!({ "proof": STANDARD.encode(proof), "proving_ms": proving_ms })
            .to_string(),
    )
}
