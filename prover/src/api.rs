//! Key generation and proving used by the CLI.
//!
//! Setup is ephemeral and sandbox-only: each `setup` samples fresh toxic waste
//! from the OS RNG, writes the proving keys under the caller's directory, and
//! discards the trapdoor. Generated keys must never be committed.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use ark_bls12_381::Bls12_381;
use ark_groth16::{Groth16, Proof, ProvingKey, VerifyingKey};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use rand::rngs::OsRng;

use crate::circuit::{
    LiquidationCircuit, LiquidationStatement, OpenCircuit, OpenStatement,
};
use crate::encoding::{
    LIQUIDATION_VK_LEN, OPEN_VK_LEN, proof_bytes, scalars_to_fr, vk_bytes,
};
use crate::model::{self, Opening, Oracle, Settlement, sha256};

pub const OPEN_PK_FILE: &str = "open.pk";
pub const LIQUIDATION_PK_FILE: &str = "liquidation.pk";
pub const OPEN_VK_FILE: &str = "open.vk";
pub const LIQUIDATION_VK_FILE: &str = "liquidation.vk";

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

pub struct SetupOutput {
    pub open_vk: Vec<u8>,
    pub liquidation_vk: Vec<u8>,
    pub open_vk_sha256: [u8; 32],
    pub liquidation_vk_sha256: [u8; 32],
}

pub struct ProofOutput {
    pub commitment: [u8; 32],
    pub proof: Vec<u8>,
    pub proving_ms: u64,
}

pub struct LiquidationOutput {
    pub proof: ProofOutput,
    pub settlement: Settlement,
}

fn write_new(path: &Path, bytes: impl FnOnce(&mut BufWriter<File>) -> Result<(), Error>) -> Result<(), Error> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| Error::Io(format!("cannot create {}: {e}", path.display())))?;
    let mut w = BufWriter::new(file);
    bytes(&mut w)?;
    w.flush().map_err(|e| Error::Io(e.to_string()))
}

/// Fresh OS-random Groth16 setup for both statements.
pub fn generate_keys() -> Result<
    (ProvingKey<Bls12_381>, ProvingKey<Bls12_381>),
    Error,
> {
    let mut rng = OsRng;
    let (open_pk, _) =
        Groth16::<Bls12_381>::circuit_specific_setup(OpenCircuit::setup_shape(), &mut rng)
            .map_err(|e| Error::Key(e.to_string()))?;
    let (liq_pk, _) =
        Groth16::<Bls12_381>::circuit_specific_setup(LiquidationCircuit::setup_shape(), &mut rng)
            .map_err(|e| Error::Key(e.to_string()))?;
    Ok((open_pk, liq_pk))
}

pub fn setup_output(open_vk: &VerifyingKey<Bls12_381>, liq_vk: &VerifyingKey<Bls12_381>) -> SetupOutput {
    let open_vk = vk_bytes(open_vk);
    let liquidation_vk = vk_bytes(liq_vk);
    assert_eq!(open_vk.len(), OPEN_VK_LEN);
    assert_eq!(liquidation_vk.len(), LIQUIDATION_VK_LEN);
    SetupOutput {
        open_vk_sha256: sha256(&[&open_vk]),
        liquidation_vk_sha256: sha256(&[&liquidation_vk]),
        open_vk,
        liquidation_vk,
    }
}

/// Generates keys and writes them under `dir`. Refuses to overwrite existing
/// key files so a deployed VK is never silently orphaned.
pub fn setup(dir: &Path) -> Result<SetupOutput, Error> {
    fs::create_dir_all(dir)
        .map_err(|e| Error::Io(format!("cannot create {}: {e}", dir.display())))?;
    for name in [OPEN_PK_FILE, LIQUIDATION_PK_FILE, OPEN_VK_FILE, LIQUIDATION_VK_FILE] {
        if dir.join(name).exists() {
            return Err(Error::Io(format!(
                "{} already exists; use a fresh directory",
                dir.join(name).display()
            )));
        }
    }
    let (open_pk, liq_pk) = generate_keys()?;
    let out = setup_output(&open_pk.vk, &liq_pk.vk);
    for (name, pk) in [(OPEN_PK_FILE, &open_pk), (LIQUIDATION_PK_FILE, &liq_pk)] {
        write_new(&dir.join(name), |w| {
            pk.serialize_uncompressed(w)
                .map_err(|e| Error::Io(e.to_string()))
        })?;
    }
    for (name, vk) in [
        (OPEN_VK_FILE, &out.open_vk),
        (LIQUIDATION_VK_FILE, &out.liquidation_vk),
    ] {
        write_new(&dir.join(name), |w| {
            w.write_all(vk).map_err(|e| Error::Io(e.to_string()))
        })?;
    }
    Ok(out)
}

pub fn load_pk(dir: &Path, name: &str) -> Result<ProvingKey<Bls12_381>, Error> {
    let path = dir.join(name);
    let file =
        File::open(&path).map_err(|e| Error::Io(format!("cannot open {}: {e}", path.display())))?;
    // The key file is produced locally by `setup`; skip the (slow) subgroup
    // checks. Every proof is verified against the embedded VK before output.
    ProvingKey::<Bls12_381>::deserialize_uncompressed_unchecked(BufReader::new(file))
        .map_err(|e| Error::Key(format!("cannot decode {}: {e}", path.display())))
}

pub fn prove_open_with(pk: &ProvingKey<Bls12_381>, opening: &Opening) -> Result<ProofOutput, Error> {
    model::check_open(opening)?;
    let statement = OpenStatement::honest(opening);
    let circuit = OpenCircuit {
        opening: *opening,
        statement,
    };
    let start = Instant::now();
    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut OsRng)
        .map_err(|e| Error::Proof(e.to_string()))?;
    let proving_ms = start.elapsed().as_millis() as u64;
    self_check(&pk.vk, &statement.inputs(), &proof)?;
    Ok(ProofOutput {
        commitment: statement.commitment,
        proof: proof_bytes(&proof),
        proving_ms,
    })
}

pub fn prove_liquidation_with(
    pk: &ProvingKey<Bls12_381>,
    opening: &Opening,
    oracle: &Oracle,
) -> Result<LiquidationOutput, Error> {
    // Refuses healthy positions before any proving work.
    let settlement = model::settle(opening, oracle)?;
    let statement = LiquidationStatement::honest(opening, oracle, &settlement);
    let circuit = LiquidationCircuit {
        opening: *opening,
        statement,
    };
    let start = Instant::now();
    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut OsRng)
        .map_err(|e| Error::Proof(e.to_string()))?;
    let proving_ms = start.elapsed().as_millis() as u64;
    self_check(&pk.vk, &statement.inputs(), &proof)?;
    Ok(LiquidationOutput {
        proof: ProofOutput {
            commitment: statement.commitment,
            proof: proof_bytes(&proof),
            proving_ms,
        },
        settlement,
    })
}

fn self_check(
    vk: &VerifyingKey<Bls12_381>,
    inputs: &[[u8; 32]],
    proof: &Proof<Bls12_381>,
) -> Result<(), Error> {
    let ok = Groth16::<Bls12_381>::verify(vk, &scalars_to_fr(inputs), proof)
        .map_err(|e| Error::Proof(e.to_string()))?;
    if ok {
        Ok(())
    } else {
        Err(Error::Proof("generated proof failed self-verification".into()))
    }
}

pub fn prove_open(dir: &Path, opening: &Opening) -> Result<ProofOutput, Error> {
    model::check_open(opening)?;
    let pk = load_pk(dir, OPEN_PK_FILE)?;
    prove_open_with(&pk, opening)
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
