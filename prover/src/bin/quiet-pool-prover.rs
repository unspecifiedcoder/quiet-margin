use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::Path;

use ark_bls12_381::{Bls12_381, Fr};
use ark_groth16::{Groth16, ProvingKey};
use ark_relations::r1cs::ConstraintSynthesizer;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::rngs::OsRng;
use xythum_prover::{
    encoding::{proof_bytes, scalars_to_fr, vk_bytes},
    model::sha256,
    pool::{self, Close, Spend},
    pool_fast::{FastClose, FastSpend, Liquidation},
};

fn setup<C: ConstraintSynthesizer<Fr>>(
    dir: &Path,
    kind: &str,
    circuit: C,
) -> Result<(), Box<dyn std::error::Error>> {
    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(circuit, &mut OsRng)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(format!("{kind}.pk")))?;
    let mut writer = BufWriter::new(file);
    pk.serialize_uncompressed(&mut writer)?;
    writer.flush()?;
    let raw = vk_bytes(&vk);
    fs::write(dir.join(format!("{kind}.vk")), &raw)?;
    eprintln!("{kind} key: {}", STANDARD.encode(sha256(&[&raw])));
    Ok(())
}

fn prove<C: ConstraintSynthesizer<Fr>>(
    key: &ProvingKey<Bls12_381>,
    circuit: C,
    inputs: &[[u8; 32]],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let proof = Groth16::<Bls12_381>::prove(key, circuit, &mut OsRng)?;
    let prepared = Groth16::<Bls12_381>::process_vk(&key.vk)?;
    if !Groth16::<Bls12_381>::verify_with_processed_vk(&prepared, &scalars_to_fr(inputs), &proof)? {
        return Err("Proof does not verify.".into());
    }
    Ok(proof_bytes(&proof).to_vec())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command, dir] if command == "setup" => {
            let dir = Path::new(dir);
            fs::create_dir(dir)?;
            setup(dir, "spend", Spend::default())?;
            setup(dir, "close", Close::default())?;
        }
        [command, dir] if command == "setup-browser" => {
            let dir = Path::new(dir);
            fs::create_dir(dir)?;
            setup(dir, "spend", FastSpend::<4>::default())?;
            setup(dir, "close", FastClose::<false>::default())?;
        }
        [command, dir] if command == "setup-judge" => {
            let dir = Path::new(dir);
            fs::create_dir(dir)?;
            setup(dir, "spend", FastSpend::<6>::default())?;
            setup(dir, "close", FastClose::<true>::default())?;
        }
        [command, dir] if command == "setup-liquidation" => {
            let dir = Path::new(dir);
            fs::create_dir(dir)?;
            setup(dir, "liquidation", Liquidation::default())?;
        }
        [command, dir, kind] if command == "prove-pool-v3" => {
            let dir = Path::new(dir);
            let key = ProvingKey::<Bls12_381>::deserialize_uncompressed(
                std::io::BufReader::new(fs::File::open(dir.join(format!("{kind}.pk")))?),
            )?;
            let mut input = String::new();
            std::io::stdin().take(20_001).read_to_string(&mut input)?;
            let (proof, extra) = match kind.as_str() {
                "liquidation" => {
                    let w: Liquidation = serde_json::from_str(&input)?;
                    let public = w.public();
                    let credit = u64::from_le_bytes(public[7][..8].try_into()?);
                    (prove(&key, w, &public)?,
                        serde_json::json!({"payout": STANDARD.encode(public[4]), "maker_credit": credit.to_string()}))
                }
                "close" => {
                    let w = FastClose::<true>(serde_json::from_str(&input)?);
                    let public = w.public();
                    (prove(&key, w, &public)?, serde_json::json!({}))
                }
                "spend" => {
                    let w = FastSpend::<6>(serde_json::from_str(&input)?);
                    let public = w.public();
                    (prove(&key, w, &public)?, serde_json::json!({}))
                }
                _ => return Err("Unknown v3 pool proof.".into()),
            };
            println!("{}", serde_json::json!({"proof": STANDARD.encode(proof), "settlement": extra}));
        }
        [command, source, output] if command == "uncompress" => {
            let file = std::fs::File::open(source)?;
            let key = ProvingKey::<Bls12_381>::deserialize_compressed_unchecked(
                std::io::BufReader::new(file),
            )?;
            let output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)?;
            let mut writer = BufWriter::new(output);
            key.serialize_uncompressed(&mut writer)?;
            writer.flush()?;
        }
        [command, dir, kind] | [command, dir, kind, _]
            if command == "prove" && ["spend", "close"].contains(&kind.as_str()) =>
        {
            let dir = Path::new(dir);
            let key = fs::read(dir.join(format!("{kind}.pk")))?;
            let vk = fs::read(dir.join(format!("{kind}.vk")))?;
            let fingerprint = STANDARD.encode(sha256(&[&vk]));
            if args.get(3).is_some_and(|expected| expected != &fingerprint) {
                return Err("Pool verifying key fingerprint differs from the requested deployment.".into());
            }
            let mut input = String::new();
            std::io::stdin().take(20_001).read_to_string(&mut input)?;
            println!(
                "{}",
                pool::prove_json(kind, key.as_slice(), &fingerprint, &input)?
            );
        }
        _ => return Err(
            "Usage: quiet-pool-prover setup|setup-browser DIR | prove DIR spend|close [VK_FINGERPRINT] | uncompress SOURCE OUTPUT"
                .into(),
        ),
    }
    Ok(())
}
