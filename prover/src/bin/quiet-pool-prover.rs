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
    encoding::vk_bytes,
    model::sha256,
    pool::{self, Close, Spend},
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
    pk.serialize_compressed(&mut writer)?;
    writer.flush()?;
    let raw = vk_bytes(&vk);
    fs::write(dir.join(format!("{kind}.vk")), &raw)?;
    eprintln!("{kind} key: {}", STANDARD.encode(sha256(&[&raw])));
    Ok(())
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
        [command, dir, kind]
            if command == "prove" && ["spend", "close"].contains(&kind.as_str()) =>
        {
            let dir = Path::new(dir);
            let key = fs::read(dir.join(format!("{kind}.pk")))?;
            let vk = fs::read(dir.join(format!("{kind}.vk")))?;
            let fingerprint = STANDARD.encode(sha256(&[&vk]));
            let mut input = String::new();
            std::io::stdin().take(20_001).read_to_string(&mut input)?;
            println!(
                "{}",
                pool::prove_json(kind, key.as_slice(), &fingerprint, &input)?
            );
        }
        _ => return Err(
            "Usage: quiet-pool-prover setup DIR | prove DIR spend|close | uncompress SOURCE OUTPUT"
                .into(),
        ),
    }
    Ok(())
}
