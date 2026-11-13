//! Browser pool statements with field-native commitments and hidden membership paths.
use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::{
    constraints::CryptographicSpongeVar, poseidon::constraints::PoseidonSpongeVar,
};
use ark_r1cs_std::{fields::fp::FpVar, prelude::*};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
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

pub fn commitment(
    context: &Hash,
    blinder: &Hash,
    lots: u16,
    entry: u16,
    margin: u32,
    short: bool,
) -> Hash {
    encode(hash(
        h::POSITION,
        &[
            field(context),
            field(blinder),
            Fr::from(packed_position(lots, entry, margin)) + Fr::from(u128::from(short) << 64),
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

fn member<const D: usize>(
    cs: &ConstraintSystemRef<Fr>,
    input: &Input<D>,
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
    blinder_bytes: &Hash,
    lots: u16,
    entry: u16,
    margin: u32,
    short: &Boolean<Fr>,
) -> Result<(Var, Var, Var, Var, Var), SynthesisError> {
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
    let blinder = Var::new_witness(cs.clone(), || Ok(field(blinder_bytes)))?;
    let packed = &lots
        + &entry * Fr::from(1u64 << 16)
        + &margin * Fr::from(1u64 << 32)
        + Boolean::le_bits_to_fp(std::slice::from_ref(short))? * Fr::from(1u128 << 64);
    Ok((
        hash_var(cs, h::POSITION, vec![context, blinder.clone(), packed])?,
        lots,
        entry,
        margin,
        blinder,
    ))
}

fn bind_note(leaf: Var, cents: &Var, output: &Var) -> Result<(), SynthesisError> {
    cents
        .is_neq(&Var::zero())?
        .select(&leaf, &Var::zero())?
        .enforce_equal(output)
}

#[derive(Default)]
pub struct FastSpend<const D: usize = 4>(pub Spend<D>);

impl<const D: usize> FastSpend<D> {
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
                commitment(
                    &w.context,
                    &w.blinder,
                    w.lots,
                    w.entry,
                    w.margin,
                    D == 6 && w.short,
                )
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

impl<const D: usize> ConstraintSynthesizer<Fr> for FastSpend<D> {
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
        let short = if D == 6 {
            Boolean::new_witness(cs.clone(), || Ok(w.short))?
        } else {
            Boolean::FALSE
        };
        let (commitment, lots, entry, margin, _) = position_vars(
            &cs,
            p[6].clone(),
            &w.blinder,
            w.lots,
            w.entry,
            w.margin,
            &short,
        )?;
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
pub struct FastClose<const SIDES: bool = false>(pub Close);

impl<const SIDES: bool> FastClose<SIDES> {
    pub fn public(&self) -> Vec<Hash> {
        let w = &self.0;
        let [_, leaf, _, tag] = note_fields(&w.domain, &w.owner, &w.payout);
        vec![
            commitment(
                &w.context,
                &w.blinder,
                w.lots,
                w.entry,
                w.margin,
                SIDES && w.short,
            ),
            w.context,
            w.domain,
            tag,
            if w.payout.cents != 0 { leaf } else { ZERO },
            crate::encoding::u64_scalar(u64::from(w.price)),
            crate::encoding::u64_scalar(w.round),
            crate::encoding::u64_scalar(if SIDES && w.short {
                let pnl = (i64::from(w.entry) - i64::from(w.price)) * i64::from(w.lots);
                let payout = (i64::from(w.margin) + pnl.min(i64::from(PNL_CAP_CENTS))).max(0);
                (i64::from(PNL_CAP_CENTS) + i64::from(w.margin) - payout) as u64
            } else {
                w.maker_delta()
            }),
        ]
    }
}

impl<const SIDES: bool> ConstraintSynthesizer<Fr> for FastClose<SIDES> {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = allocate(&cs, &self.public())?;
        let w = self.0;
        let short = if SIDES {
            Boolean::new_witness(cs.clone(), || Ok(w.short))?
        } else {
            Boolean::FALSE
        };
        let (commitment, lots, entry, margin, _) = position_vars(
            &cs,
            p[1].clone(),
            &w.blinder,
            w.lots,
            w.entry,
            w.margin,
            &short,
        )?;
        commitment.enforce_equal(&p[0])?;
        let owner = Var::new_witness(cs.clone(), || Ok(field(&w.owner)))?;
        let tag = hash_var(&cs, h::OWNER, vec![p[2].clone(), owner])?;
        tag.enforce_equal(&p[3])?;
        let (leaf, cents) = note_vars(&cs, &p[2], &tag, &w.payout)?;
        bind_note(leaf, &cents, &p[4])?;
        enforce_bits(&cs, &p[5], 16)?;
        enforce_bits(&cs, &p[6], 64)?;
        let movement = &p[5] - entry;
        let pnl = if SIDES {
            short.select(&(Var::zero() - &movement), &movement)? * lots
        } else {
            movement * lots
        };
        let cap = Var::Constant(Fr::from(PNL_CAP_CENTS));
        let excess = max_zero(&cs, &(&pnl - &cap))?;
        cents.enforce_equal(&max_zero(&cs, &(&margin + pnl - excess))?)?;
        (&cap + margin - cents).enforce_equal(&p[7])
    }
}

/// The keeper receives the position opening, but never the note owner secret.
/// The payout salt is fixed by the opening, so the trader can recover the note.
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct Liquidation {
    pub commitment: Hash,
    pub context: Hash,
    pub blinder: Hash,
    pub lots: u16,
    pub entry: u16,
    pub margin: u32,
    pub short: bool,
    pub domain: Hash,
    pub owner_tag: Hash,
    pub price: u16,
    pub round: u64,
}

impl Liquidation {
    pub fn payout(&self) -> u64 {
        let movement =
            (i64::from(self.price) - i64::from(self.entry)) * if self.short { -1 } else { 1 };
        (i64::from(self.margin) + (movement * i64::from(self.lots)).min(PNL_CAP_CENTS as i64))
            .max(0) as u64
    }

    pub fn public(&self) -> Vec<Hash> {
        let cents = self.payout();
        let inner = encode(hash(
            h::INNER,
            &[field(&self.owner_tag), field(&self.blinder)],
        ));
        let payout = if cents == 0 {
            ZERO
        } else {
            h::leaf(&self.domain, &inner, cents)
        };
        vec![
            self.commitment,
            self.context,
            self.domain,
            self.owner_tag,
            payout,
            crate::encoding::u64_scalar(u64::from(self.price)),
            crate::encoding::u64_scalar(self.round),
            crate::encoding::u64_scalar(u64::from(PNL_CAP_CENTS) + u64::from(self.margin) - cents),
        ]
    }
}

impl ConstraintSynthesizer<Fr> for Liquidation {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = allocate(&cs, &self.public())?;
        let short = Boolean::new_witness(cs.clone(), || Ok(self.short))?;
        let (commitment, lots, entry, margin, blinder) = position_vars(
            &cs,
            p[1].clone(),
            &self.blinder,
            self.lots,
            self.entry,
            self.margin,
            &short,
        )?;
        commitment.enforce_equal(&p[0])?;
        enforce_bits(&cs, &p[5], 16)?;
        enforce_bits(&cs, &p[6], 64)?;
        let movement = &p[5] - entry;
        let pnl = short.select(&(Var::zero() - &movement), &movement)? * &lots;
        let equity = &margin + &pnl;
        // Liquidate at or below 5% maintenance, using exact integer math.
        let threshold = &p[5] * lots - equity * Fr::from(20u64);
        enforce_bits(&cs, &threshold, 48)?;
        let cap = Var::Constant(Fr::from(PNL_CAP_CENTS));
        let excess = max_zero(&cs, &(&pnl - &cap))?;
        let cents = max_zero(&cs, &(&margin + pnl - excess))?;
        let inner = hash_var(&cs, h::INNER, vec![p[3].clone(), blinder])?;
        let leaf = hash_var(&cs, h::LEAF, vec![p[2].clone(), inner, cents.clone()])?;
        bind_note(leaf, &cents, &p[4])?;
        (&cap + margin - cents).enforce_equal(&p[7])
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub(crate) fn prove_json<S: crate::browser::KeySource + ?Sized>(
    kind: &str,
    version: &str,
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
    let (proof, proving_ms) = if kind == "spend" && version == "poseidon-v2" {
        let w = FastSpend::<6>(serde_json::from_str(input).map_err(|_| "Invalid spend input.")?);
        let public = w.public();
        crate::api::timed_prove(&key, w, &public)
    } else if kind == "spend" {
        let w = FastSpend::<4>(serde_json::from_str(input).map_err(|_| "Invalid spend input.")?);
        let public = w.public();
        crate::api::timed_prove(&key, w, &public)
    } else if version == "poseidon-v2" {
        let w = FastClose::<true>(serde_json::from_str(input).map_err(|_| "Invalid close input.")?);
        let public = w.public();
        crate::api::timed_prove(&key, w, &public)
    } else {
        let w =
            FastClose::<false>(serde_json::from_str(input).map_err(|_| "Invalid close input.")?);
        let public = w.public();
        crate::api::timed_prove(&key, w, &public)
    }
    .map_err(|_| "Pool proof did not verify. Review the amounts and current root.")?;
    Ok(
        serde_json::json!({ "proof": STANDARD.encode(proof), "proving_ms": proving_ms })
            .to_string(),
    )
}
