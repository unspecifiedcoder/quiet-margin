//! Fixed-length, domain-separated Poseidon hashes for the browser pool.
use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::{
    CryptographicSponge, FieldBasedCryptographicSponge,
    poseidon::{PoseidonConfig, PoseidonSponge, find_poseidon_ark_and_mds},
};
use ark_ff::{BigInteger, PrimeField};
use std::sync::OnceLock;

pub type Hash = [u8; 32];
pub const OWNER: u64 = 1;
pub const INNER: u64 = 2;
pub const LEAF: u64 = 3;
pub const NULLIFIER: u64 = 4;
pub const BRANCH: u64 = 5;
pub const POSITION: u64 = 6;

pub fn params() -> &'static PoseidonConfig<Fr> {
    static CONFIG: OnceLock<PoseidonConfig<Fr>> = OnceLock::new();
    CONFIG.get_or_init(|| {
        // Poseidon-128 over BLS12-381 Fr, t=3, alpha=5, R_F=8, R_P=57.
        let (ark, mds) = find_poseidon_ark_and_mds(255, 2, 8, 57, 0);
        PoseidonConfig::new(8, 57, 5, mds, ark, 2, 1)
    })
}

pub fn field(bytes: &Hash) -> Fr {
    Fr::from_le_bytes_mod_order(bytes)
}

pub fn encode(value: Fr) -> Hash {
    value
        .into_bigint()
        .to_bytes_le()
        .try_into()
        .expect("32-byte scalar")
}

pub fn canonical(bytes: &Hash) -> bool {
    encode(field(bytes)) == *bytes
}

pub fn hash(domain: u64, fields: &[Fr]) -> Fr {
    let mut sponge = PoseidonSponge::new(params());
    sponge.state[0] = Fr::from(domain);
    sponge.absorb(&fields.to_vec());
    sponge.squeeze_native_field_elements(1)[0]
}

pub fn leaf(domain: &Hash, inner: &Hash, cents: u64) -> Hash {
    encode(hash(LEAF, &[field(domain), field(inner), Fr::from(cents)]))
}

pub fn branch(left: &Hash, right: &Hash) -> Hash {
    encode(hash(BRANCH, &[field(left), field(right)]))
}
