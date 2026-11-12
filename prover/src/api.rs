//! Key generation, key export, and proving used by the CLI.
//!
//! Setup is ephemeral and sandbox-only: each `setup` samples fresh toxic waste
//! from the OS RNG, writes the three proving keys under the caller's
//! directory, and discards the trapdoor. Generated keys must never be
//! committed. `export_keys` re-derives the public verifying keys from existing
//! proving keys without generating any new material.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;

use ark_bls12_381::{Bls12_381, Fr};
use ark_groth16::{Groth16, Proof, ProvingKey, VerifyingKey};
use ark_relations::r1cs::ConstraintSynthesizer;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use rand::rngs::OsRng;

use crate::circuit::{
    CloseCircuit, LiquidationCircuit, LiquidationStatement, OpenCircuit, OpenStatement,
};
use crate::encoding::{LIQUIDATION_VK_LEN, OPEN_VK_LEN, proof_bytes, scalars_to_fr, vk_bytes};
use crate::model::{self, Opening, Oracle, Settlement, SettlementKind, sha256};

pub const OPEN_PK_FILE: &str = "open.pk";
pub const LIQUIDATION_PK_FILE: &str = "liquidation.pk";
pub const CLOSE_PK_FILE: &str = "close.pk";
pub const OPEN_VK_FILE: &str = "open.vk";
pub const LIQUIDATION_VK_FILE: &str = "liquidation.vk";
pub const CLOSE_VK_FILE: &str = "close.vk";

/// Every file `setup` writes; `setup` refuses a directory holding any of them.
pub const KEY_FILES: [&str; 6] = [
    OPEN_PK_FILE,
    LIQUIDATION_PK_FILE,
    CLOSE_PK_FILE,
    OPEN_VK_FILE,
    LIQUIDATION_VK_FILE,
    CLOSE_VK_FILE,
];

#[derive(Debug)]
pub enum Error {
    Model(model::ModelError),
    Io(String),
    Key(String),
    Proof(String),
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::Model(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "i/o error: {e}"),
            Error::Key(e) => write!(f, "key error: {e}"),
            Error::Proof(e) => write!(f, "proof error: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<model::ModelError> for Error {
    fn from(e: model::ModelError) -> Self {
        Error::Model(e)
    }
}

/// The three proving keys of one deployment.
pub struct ProvingKeys {
    pub open: ProvingKey<Bls12_381>,
    pub liquidation: ProvingKey<Bls12_381>,
    pub close: ProvingKey<Bls12_381>,
}

/// Public verifying keys (NEP-488 encoding) and their SHA-256 fingerprints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupOutput {
    pub open_vk: Vec<u8>,
    pub liquidation_vk: Vec<u8>,
    pub close_vk: Vec<u8>,
    pub open_vk_sha256: [u8; 32],
    pub liquidation_vk_sha256: [u8; 32],
    pub close_vk_sha256: [u8; 32],
}

pub struct ProofOutput {
    pub commitment: [u8; 32],
    pub proof: Vec<u8>,
    pub proving_ms: u64,
}

pub struct OpenOutput {
    pub proof: ProofOutput,
    pub quote_terms: [u8; 32],
}

/// Output of a liquidation or close proof.
pub struct LiquidationOutput {
    pub proof: ProofOutput,
    pub settlement: Settlement,
}

pub type SettlementOutput = LiquidationOutput;

fn write_new(
    path: &Path,
    bytes: impl FnOnce(&mut BufWriter<File>) -> Result<(), Error>,
) -> Result<(), Error> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| Error::Io(format!("cannot create {}: {e}", path.display())))?;
    let mut w = BufWriter::new(file);
    bytes(&mut w)?;
    w.flush().map_err(|e| Error::Io(e.to_string()))
}

fn circuit_setup<C: ConstraintSynthesizer<Fr>>(
    circuit: C,
    rng: &mut OsRng,
) -> Result<ProvingKey<Bls12_381>, Error> {
    Groth16::<Bls12_381>::circuit_specific_setup(circuit, rng)
        .map(|(pk, _)| pk)
        .map_err(|e| Error::Key(e.to_string()))
}

/// Fresh OS-random Groth16 setup for all three statements. Each key has its
/// own independent toxic waste.
pub fn generate_keys() -> Result<ProvingKeys, Error> {
    let mut rng = OsRng;
    Ok(ProvingKeys {
        open: circuit_setup(OpenCircuit::setup_shape(), &mut rng)?,
        liquidation: circuit_setup(LiquidationCircuit::setup_shape(), &mut rng)?,
        close: circuit_setup(CloseCircuit::setup_shape(), &mut rng)?,
    })
}

pub fn setup_output(
    open_vk: &VerifyingKey<Bls12_381>,
    liq_vk: &VerifyingKey<Bls12_381>,
    close_vk: &VerifyingKey<Bls12_381>,
) -> Result<SetupOutput, Error> {
    let open_vk = vk_bytes(open_vk);
    let liquidation_vk = vk_bytes(liq_vk);
    let close_vk = vk_bytes(close_vk);
    for (name, vk, len) in [
        ("open", &open_vk, OPEN_VK_LEN),
        ("liquidation", &liquidation_vk, LIQUIDATION_VK_LEN),
        ("close", &close_vk, LIQUIDATION_VK_LEN),
    ] {
        if vk.len() != len {
            return Err(Error::Key(format!(
                "{name} verifying key has {} bytes, expected {len}",
                vk.len()
            )));
        }
    }
    if close_vk == liquidation_vk {
        return Err(Error::Key(
            "close and liquidation verifying keys must differ".into(),
        ));
    }
    Ok(SetupOutput {
        open_vk_sha256: sha256(&[&open_vk]),
        liquidation_vk_sha256: sha256(&[&liquidation_vk]),
        close_vk_sha256: sha256(&[&close_vk]),
        open_vk,
        liquidation_vk,
        close_vk,
    })
}

fn keys_output(keys: &ProvingKeys) -> Result<SetupOutput, Error> {
    setup_output(&keys.open.vk, &keys.liquidation.vk, &keys.close.vk)
}

/// Generates keys and writes them under `dir`. Refuses a directory that
/// already holds any key file so a deployed VK is never silently orphaned.
pub fn setup(dir: &Path) -> Result<SetupOutput, Error> {
    fs::create_dir_all(dir)
        .map_err(|e| Error::Io(format!("cannot create {}: {e}", dir.display())))?;
    for name in KEY_FILES {
        if dir.join(name).exists() {
            return Err(Error::Io(format!(
                "{} already exists; use a fresh directory",
                dir.join(name).display()
            )));
        }
    }
    let keys = generate_keys()?;
    let out = keys_output(&keys)?;
    for (name, pk) in [
        (OPEN_PK_FILE, &keys.open),
        (LIQUIDATION_PK_FILE, &keys.liquidation),
        (CLOSE_PK_FILE, &keys.close),
    ] {
        write_new(&dir.join(name), |w| {
            pk.serialize_uncompressed(w)
                .map_err(|e| Error::Io(e.to_string()))
        })?;
    }
    for (name, vk) in [
        (OPEN_VK_FILE, &out.open_vk),
        (LIQUIDATION_VK_FILE, &out.liquidation_vk),
        (CLOSE_VK_FILE, &out.close_vk),
    ] {
        write_new(&dir.join(name), |w| {
            w.write_all(vk).map_err(|e| Error::Io(e.to_string()))
        })?;
    }
    Ok(out)
}

/// Reads the three existing proving keys under `dir` and returns the same
/// public output as `setup`, without generating or writing anything. Any
/// `.vk` file present must match the key derived from its proving key.
pub fn export_keys(dir: &Path) -> Result<SetupOutput, Error> {
    let keys = ProvingKeys {
        open: load_pk(dir, OPEN_PK_FILE)?,
        liquidation: load_pk(dir, LIQUIDATION_PK_FILE)?,
        close: load_pk(dir, CLOSE_PK_FILE)?,
    };
    let out = keys_output(&keys)?;
    for (name, vk) in [
        (OPEN_VK_FILE, &out.open_vk),
        (LIQUIDATION_VK_FILE, &out.liquidation_vk),
        (CLOSE_VK_FILE, &out.close_vk),
    ] {
        let path = dir.join(name);
        match fs::read(&path) {
            Ok(bytes) if &bytes == vk => {}
            Ok(_) => {
                return Err(Error::Key(format!(
                    "{} does not match its proving key",
                    path.display()
                )));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Io(format!("cannot read {}: {e}", path.display()))),
        }
    }
    Ok(out)
}

pub fn load_pk(dir: &Path, name: &str) -> Result<ProvingKey<Bls12_381>, Error> {
    let path = dir.join(name);
    let file =
        File::open(&path).map_err(|e| Error::Io(format!("cannot open {}: {e}", path.display())))?;
    // The key file is produced locally by `setup`; skip the (slow) subgroup
    // checks. Every proof is verified against the embedded VK before output,
    // and the contract validates every exported VK at initialization.
    ProvingKey::<Bls12_381>::deserialize_uncompressed_unchecked(BufReader::new(file))
        .map_err(|e| Error::Key(format!("cannot decode {}: {e}", path.display())))
}

/// Wall-clock timing for `proving_ms`. `std::time::Instant` panics on
/// `wasm32-unknown-unknown`, so the browser build reads the JS clock
/// (`performance.now()`, available in windows and web workers).
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod clock {
    pub struct Start(std::time::Instant);

    pub fn start() -> Start {
        Start(std::time::Instant::now())
    }

    impl Start {
        pub fn elapsed_ms(&self) -> u64 {
            self.0.elapsed().as_millis() as u64
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod clock {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(inline_js = "export function xythum_now_ms() {         const p = globalThis.performance;         return p && typeof p.now === 'function' ? p.now() : Date.now(); }")]
    extern "C" {
        fn xythum_now_ms() -> f64;
    }

    pub struct Start(f64);

    pub fn start() -> Start {
        Start(xythum_now_ms())
    }

    impl Start {
        pub fn elapsed_ms(&self) -> u64 {
            let d = xythum_now_ms() - self.0;
            if d.is_finite() && d > 0.0 { d as u64 } else { 0 }
        }
    }
}

fn timed_prove<C: ConstraintSynthesizer<Fr>>(
    pk: &ProvingKey<Bls12_381>,
    circuit: C,
    inputs: &[[u8; 32]],
) -> Result<(Vec<u8>, u64), Error> {
    let start = clock::start();
    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut OsRng)
        .map_err(|e| Error::Proof(e.to_string()))?;
    let proving_ms = start.elapsed_ms();
    self_check(&pk.vk, inputs, &proof)?;
    Ok((proof_bytes(&proof), proving_ms))
}

/// Proves the open statement. Refuses out-of-bounds openings, marks outside
/// 1..=20000, and positions unhealthy at the opening mark.
pub fn prove_open_with(
    pk: &ProvingKey<Bls12_381>,
    opening: &Opening,
    quote_blinder: &[u8; 32],
    open_price_ticks: u32,
) -> Result<OpenOutput, Error> {
    model::check_open_at(opening, open_price_ticks)?;
    let statement = OpenStatement::honest(opening, quote_blinder, open_price_ticks);
    let circuit = OpenCircuit {
        opening: *opening,
        quote_blinder: *quote_blinder,
        statement,
    };
    let (proof, proving_ms) = timed_prove(pk, circuit, &statement.inputs())?;
    Ok(OpenOutput {
        proof: ProofOutput {
            commitment: statement.commitment,
            proof,
            proving_ms,
        },
        quote_terms: statement.quote_terms,
    })
}

fn prove_settlement_with(
    kind: SettlementKind,
    pk: &ProvingKey<Bls12_381>,
    opening: &Opening,
    oracle: &Oracle,
) -> Result<SettlementOutput, Error> {
    // Liquidation refuses healthy positions before any proving work.
    let settlement = model::settle_as(kind, opening, oracle)?;
    let statement = LiquidationStatement::honest(opening, oracle, &settlement);
    let inputs = statement.inputs();
    let (proof, proving_ms) = match kind {
        SettlementKind::Liquidation => timed_prove(
            pk,
            LiquidationCircuit {
                opening: *opening,
                statement,
            },
            &inputs,
        )?,
        SettlementKind::Close => timed_prove(
            pk,
            CloseCircuit {
                opening: *opening,
                statement,
            },
            &inputs,
        )?,
    };
    Ok(LiquidationOutput {
        proof: ProofOutput {
            commitment: statement.commitment,
            proof,
            proving_ms,
        },
        settlement,
    })
}

pub fn prove_liquidation_with(
    pk: &ProvingKey<Bls12_381>,
    opening: &Opening,
    oracle: &Oracle,
) -> Result<LiquidationOutput, Error> {
    prove_settlement_with(SettlementKind::Liquidation, pk, opening, oracle)
}

/// Voluntary close: no health requirement and no bounty.
pub fn prove_close_with(
    pk: &ProvingKey<Bls12_381>,
    opening: &Opening,
    oracle: &Oracle,
) -> Result<SettlementOutput, Error> {
    prove_settlement_with(SettlementKind::Close, pk, opening, oracle)
}

fn self_check(
    vk: &VerifyingKey<Bls12_381>,
    inputs: &[[u8; 32]],
    proof: &Proof<Bls12_381>,
) -> Result<(), Error> {
    // Proving keys are decoded without subgroup checks; never emit a proof
    // whose points are outside the prime-order groups.
    let in_groups = [proof.a, proof.c]
        .iter()
        .all(|p| p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve())
        && proof.b.is_on_curve()
        && proof.b.is_in_correct_subgroup_assuming_on_curve();
    if !in_groups {
        return Err(Error::Proof(
            "generated proof has points outside the prime-order groups".into(),
        ));
    }
    let ok = Groth16::<Bls12_381>::verify(vk, &scalars_to_fr(inputs), proof)
        .map_err(|e| Error::Proof(e.to_string()))?;
    if ok {
        Ok(())
    } else {
        Err(Error::Proof(
            "generated proof failed self-verification".into(),
        ))
    }
}

pub fn prove_open(
    dir: &Path,
    opening: &Opening,
    quote_blinder: &[u8; 32],
    open_price_ticks: u32,
) -> Result<OpenOutput, Error> {
    model::check_open_at(opening, open_price_ticks)?;
    let pk = load_pk(dir, OPEN_PK_FILE)?;
    prove_open_with(&pk, opening, quote_blinder, open_price_ticks)
}

pub fn prove_liquidation(
    dir: &Path,
    opening: &Opening,
    oracle: &Oracle,
) -> Result<LiquidationOutput, Error> {
    model::settle(opening, oracle)?;
    let pk = load_pk(dir, LIQUIDATION_PK_FILE)?;
    prove_liquidation_with(&pk, opening, oracle)
}

pub fn prove_close(
    dir: &Path,
    opening: &Opening,
    oracle: &Oracle,
) -> Result<SettlementOutput, Error> {
    model::close(opening, oracle)?;
    let pk = load_pk(dir, CLOSE_PK_FILE)?;
    prove_close_with(&pk, opening, oracle)
}
