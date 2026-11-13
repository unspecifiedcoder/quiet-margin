//! Browser prover: the open and close statements compiled to
//! `wasm32-unknown-unknown` and exported through wasm-bindgen (`--target web`).
//!
//! # Interface
//!
//! ```text
//! prove_open (pk_bytes: Uint8Array, expected_vk_sha256_b64: string, input_json: string) -> string
//! prove_close(pk_bytes: Uint8Array, expected_vk_sha256_b64: string, input_json: string) -> string
//! key_info   (pk_bytes: Uint8Array) -> string
//! ```
//!
//! `prove_open` returns exactly the `xythum-prover prove-open` stdout JSON
//! `{commitment, quote_terms, proof, proving_ms}` and `prove_close` exactly the
//! `prove-close` JSON `{commitment, proof, proving_ms, refund, bad_debt}`.
//! Failures throw a JS `Error` whose message never echoes a witness value.
//!
//! Input is one JSON object of at most [`MAX_INPUT_JSON_BYTES`] bytes with
//! no unknown, duplicate, or other-statement fields:
//!
//! * open:  `{context, size_lots, entry_ticks, margin_cents, blinder,
//!   quote_blinder, open_price_ticks}`
//! * close: `{context, size_lots, entry_ticks, margin_cents, blinder,
//!   round, price_ticks, funding_cents}`
//!
//! Byte fields are canonical standard padded Base64 of exactly 32 bytes;
//! integers are JSON integers within their Rust types and then within the
//! model bounds (checked before any key bytes are decoded).
//!
//! `pk_bytes` is either an original `setup` proving key (arkworks
//! uncompressed, ~101 MB open / ~51 MB close) or the compressed export of
//! `xythum-browser-keys compress` (arkworks compressed, about half the size,
//! slower to decode). The format is detected from the byte layout before any
//! allocation sized by the untrusted length prefixes. Before the key body is
//! decoded, the embedded verifying key is decoded with full point validation,
//! re-encoded in the NEP-488 layout, and its SHA-256 compared with
//! `expected_vk_sha256_b64`, which the caller must take from the finalized
//! contract's `get_config().open_vk_sha256` / `close_vk_sha256`.
//!
//! The key body (the large query vectors) is decoded without subgroup checks,
//! as the CLI does. `delta_g1` is fully validated, and every proof is
//! self-verified against the pinned verifying key (with proof points checked
//! to be in the prime-order groups) before it is returned, so a corrupted key
//! cannot produce output that the contract would accept or that is not
//! distributed like an honest zero-knowledge proof.
//!
//! The key is read from the JS `Uint8Array` in 1 MiB chunks, so wasm linear
//! memory holds only the decoded key (about the original size) plus proving
//! scratch, not a second copy of the key bytes.

use std::io::{BufReader, Read};

use ark_bls12_381::{Bls12_381, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::api;
use crate::encoding::{LIQUIDATION_INPUTS, OPEN_INPUTS, vk_bytes, vk_len};
use crate::model::{self, Opening, Oracle, sha256};

/// Largest accepted `input_json`, in bytes. Valid inputs are under 400 bytes.
pub const MAX_INPUT_JSON_BYTES: usize = 4096;

/// Read granularity when pulling key bytes out of a JS `Uint8Array`.
const READ_CHUNK: usize = 1 << 20;

/// Random-access byte source holding a serialized proving key.
pub trait KeySource {
    fn byte_len(&self) -> u64;
    /// Copies `buf.len()` bytes starting at `offset`. Callers only request
    /// ranges inside `0..byte_len()`.
    fn copy_at(&self, offset: u64, buf: &mut [u8]);
}

impl KeySource for [u8] {
    fn byte_len(&self) -> u64 {
        self.len() as u64
    }
    fn copy_at(&self, offset: u64, buf: &mut [u8]) {
        let start = offset as usize;
        buf.copy_from_slice(&self[start..start + buf.len()]);
    }
}

struct SourceReader<'a, S: KeySource + ?Sized> {
    src: &'a S,
    pos: u64,
}

impl<S: KeySource + ?Sized> Read for SourceReader<'_, S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self.src.byte_len().saturating_sub(self.pos);
        let n = (buf.len() as u64).min(remaining) as usize;
        if n > 0 {
            self.src.copy_at(self.pos, &mut buf[..n]);
            self.pos += n as u64;
        }
        Ok(n)
    }
}

fn reader<S: KeySource + ?Sized>(src: &S) -> BufReader<SourceReader<'_, S>> {
    BufReader::with_capacity(READ_CHUNK, SourceReader { src, pos: 0 })
}

/// Serialization of a proving key. Both are arkworks `CanonicalSerialize`
/// encodings of `ark_groth16::ProvingKey<Bls12_381>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyFormat {
    /// `serialize_uncompressed`, as written by `xythum-prover setup`.
    Uncompressed,
    /// `serialize_compressed`, as written by `xythum-browser-keys compress`.
    Compressed,
}

impl KeyFormat {
    pub fn name(self) -> &'static str {
        match self {
            KeyFormat::Uncompressed => "uncompressed",
            KeyFormat::Compressed => "compressed",
        }
    }
    fn compress(self) -> Compress {
        match self {
            KeyFormat::Uncompressed => Compress::No,
            KeyFormat::Compressed => Compress::Yes,
        }
    }
    fn g1(self) -> u64 {
        G1Affine::zero().serialized_size(self.compress()) as u64
    }
    fn g2(self) -> u64 {
        G2Affine::zero().serialized_size(self.compress()) as u64
    }
}

/// Element counts recovered from the length prefixes of a proving key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyLayout {
    pub format: KeyFormat,
    pub bytes: u64,
    pub public_inputs: usize,
    pub variables: u64,
    pub h_len: u64,
    pub l_len: u64,
}

struct Cursor<'a, S: KeySource + ?Sized> {
    src: &'a S,
    off: u64,
}

impl<S: KeySource + ?Sized> Cursor<'_, S> {
    fn skip(&mut self, n: u64) -> Option<()> {
        let end = self.off.checked_add(n)?;
        (end <= self.src.byte_len()).then(|| self.off = end)
    }
    fn vec(&mut self, elem: u64) -> Option<u64> {
        let start = self.off;
        self.skip(8)?;
        let mut b = [0u8; 8];
        self.src.copy_at(start, &mut b);
        let n = u64::from_le_bytes(b);
        self.skip(n.checked_mul(elem)?)?;
        Some(n)
    }
}

/// Walks the `ProvingKey` field layout
/// `vk{alpha, beta, gamma, delta, Vec<ic>}, beta_g1, delta_g1, Vec<a>,
/// Vec<b_g1>, Vec<b_g2>, Vec<h>, Vec<l>` with `fmt` point sizes, reading
/// only the 8-byte length prefixes. Accepts only an exact, consistent fit.
fn walk<S: KeySource + ?Sized>(src: &S, fmt: KeyFormat) -> Option<KeyLayout> {
    let (g1, g2) = (fmt.g1(), fmt.g2());
    let mut c = Cursor { src, off: 0 };
    c.skip(g1 + 3 * g2)?;
    let ic = c.vec(g1)?;
    c.skip(2 * g1)?;
    let a = c.vec(g1)?;
    let b1 = c.vec(g1)?;
    let b2 = c.vec(g2)?;
    let h = c.vec(g1)?;
    let l = c.vec(g1)?;
    let consistent = c.off == src.byte_len()
        && ic >= 1
        && a == b1
        && a == b2
        && Some(a) == ic.checked_add(l)
        && h > 0;
    // Lazily: `ic - 1` is only meaningful once `ic >= 1` holds.
    consistent.then(|| KeyLayout {
        format: fmt,
        bytes: src.byte_len(),
        public_inputs: (ic - 1) as usize,
        variables: a,
        h_len: h,
        l_len: l,
    })
}

/// Detects the key format from its layout without decoding any point.
pub fn key_layout<S: KeySource + ?Sized>(src: &S) -> Result<KeyLayout, String> {
    match (
        walk(src, KeyFormat::Uncompressed),
        walk(src, KeyFormat::Compressed),
    ) {
        (Some(l), None) | (None, Some(l)) => Ok(l),
        (Some(_), Some(_)) => Err("proving key layout is ambiguous".into()),
        (None, None) => Err(format!(
            "proving key is not an arkworks Groth16 BLS12-381 proving key \
             (uncompressed or compressed); got {} bytes",
            src.byte_len()
        )),
    }
}

/// Statement a proving key must belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Statement {
    Open,
    Close,
}

impl Statement {
    fn name(self) -> &'static str {
        match self {
            Statement::Open => "open",
            Statement::Close => "close",
        }
    }
    fn public_inputs(self) -> usize {
        match self {
            Statement::Open => OPEN_INPUTS,
            Statement::Close => LIQUIDATION_INPUTS,
        }
    }
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Canonical standard padded Base64 of exactly 32 bytes (the base64 crate's
/// `STANDARD` engine rejects missing padding and nonzero trailing bits).
fn decode32(field: &str, s: &str) -> Result<[u8; 32], String> {
    let v = STANDARD
        .decode(s)
        .map_err(|_| format!("{field} must be canonical standard padded Base64"))?;
    v.try_into()
        .map_err(|_| format!("{field} must decode to exactly 32 bytes"))
}

/// Decodes the embedded verifying key with full validation and returns it
/// with the SHA-256 of its NEP-488 encoding (the `get_config` fingerprint).
fn read_vk<S: KeySource + ?Sized>(
    src: &S,
    layout: &KeyLayout,
) -> Result<(VerifyingKey<Bls12_381>, [u8; 32]), String> {
    let vk = VerifyingKey::<Bls12_381>::deserialize_with_mode(
        reader(src),
        layout.format.compress(),
        Validate::Yes,
    )
    .map_err(|e| format!("cannot decode the proving key's verifying key: {e}"))?;
    if vk.delta_g2.is_zero() || vk.gamma_g2.is_zero() {
        return Err("proving key has a degenerate verifying key".into());
    }
    let bytes = vk_bytes(&vk);
    if bytes.len() != vk_len(layout.public_inputs) {
        return Err("proving key has a malformed verifying key".into());
    }
    let digest = sha256(&[&bytes]);
    Ok((vk, digest))
}

/// Decodes a proving key for `statement` after checking its layout and that
/// its verifying key hashes to `expected_vk_sha256_b64`.
pub fn load_checked_key<S: KeySource + ?Sized>(
    src: &S,
    statement: Statement,
    expected_vk_sha256_b64: &str,
) -> Result<ProvingKey<Bls12_381>, String> {
    load_key_for_inputs(
        src,
        statement.public_inputs(),
        statement.name(),
        expected_vk_sha256_b64,
    )
}

pub(crate) fn load_key_for_inputs<S: KeySource + ?Sized>(
    src: &S,
    count: usize,
    name: &str,
    expected_vk_sha256_b64: &str,
) -> Result<ProvingKey<Bls12_381>, String> {
    let expected = decode32("expected_vk_sha256_b64", expected_vk_sha256_b64)?;
    let layout = key_layout(src)?;
    if layout.public_inputs != count {
        return Err(format!(
            "proving key has {} public inputs; the {} statement has {}",
            layout.public_inputs, name, count
        ));
    }
    let (vk, digest) = read_vk(src, &layout)?;
    if digest != expected {
        return Err(format!(
            "proving key's verifying key SHA-256 is {}, not the expected {} fingerprint",
            b64(&digest),
            name
        ));
    }
    let pk = ProvingKey::<Bls12_381>::deserialize_with_mode(
        reader(src),
        layout.format.compress(),
        Validate::No,
    )
    .map_err(|e| format!("cannot decode the {name} proving key: {e}"))?;
    if pk.vk != vk {
        return Err("proving key changed while it was decoded".into());
    }
    // A uniform `A = ... + r * delta_g1` (and `B` via the pinned delta_g2) is
    // what makes the self-verified proof witness-independent.
    let d = pk.delta_g1;
    if d.is_zero() || !d.is_on_curve() || !d.is_in_correct_subgroup_assuming_on_curve() {
        return Err("proving key has an invalid delta_g1".into());
    }
    Ok(pk)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenInput {
    context: String,
    size_lots: u16,
    entry_ticks: u16,
    margin_cents: u32,
    blinder: String,
    quote_blinder: String,
    open_price_ticks: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseInput {
    context: String,
    size_lots: u16,
    entry_ticks: u16,
    margin_cents: u32,
    blinder: String,
    round: u64,
    price_ticks: u32,
    funding_cents: u32,
}

/// Same field order as the CLI `prove-open` output.
#[derive(Serialize)]
struct OpenJson {
    commitment: String,
    quote_terms: String,
    proof: String,
    proving_ms: u64,
}

/// Same field order as the CLI `prove-close` output.
#[derive(Serialize)]
struct SettlementJson {
    commitment: String,
    proof: String,
    proving_ms: u64,
    refund: u64,
    bad_debt: u64,
}

fn parse<'a, T: Deserialize<'a>>(raw: &'a str, expected: &str) -> Result<T, String> {
    if raw.len() > MAX_INPUT_JSON_BYTES {
        return Err(format!("input_json exceeds {MAX_INPUT_JSON_BYTES} bytes"));
    }
    // serde_json errors may quote a field name but never a field value we
    // could leak; still report only the position.
    serde_json::from_str(raw).map_err(|e| {
        format!(
            "invalid input JSON (line {}, column {}): expected exactly {{{expected}}} \
             with in-range integers",
            e.line(),
            e.column()
        )
    })
}

fn opening(
    context: &str,
    blinder: &str,
    lots: u16,
    entry_ticks: u16,
    margin_cents: u32,
) -> Result<Opening, String> {
    Ok(Opening {
        context: decode32("context", context)?,
        blinder: decode32("blinder", blinder)?,
        lots,
        entry_ticks,
        margin_cents,
    })
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable output")
}

/// Platform-independent body of the `prove_open` export.
pub fn prove_open_json<S: KeySource + ?Sized>(
    pk_bytes: &S,
    expected_vk_sha256_b64: &str,
    input_json: &str,
) -> Result<String, String> {
    let i: OpenInput = parse(
        input_json,
        "context, size_lots, entry_ticks, margin_cents, blinder, quote_blinder, \
         open_price_ticks",
    )?;
    let opening = opening(
        &i.context,
        &i.blinder,
        i.size_lots,
        i.entry_ticks,
        i.margin_cents,
    )?;
    let quote_blinder = decode32("quote_blinder", &i.quote_blinder)?;
    model::check_open_at(&opening, i.open_price_ticks).map_err(|e| e.to_string())?;
    let pk = load_checked_key(pk_bytes, Statement::Open, expected_vk_sha256_b64)?;
    let out = api::prove_open_with(&pk, &opening, &quote_blinder, i.open_price_ticks)
        .map_err(|e| e.to_string())?;
    Ok(to_json(&OpenJson {
        commitment: b64(&out.proof.commitment),
        quote_terms: b64(&out.quote_terms),
        proof: b64(&out.proof.proof),
        proving_ms: out.proof.proving_ms,
    }))
}

/// Platform-independent body of the `prove_close` export.
pub fn prove_close_json<S: KeySource + ?Sized>(
    pk_bytes: &S,
    expected_vk_sha256_b64: &str,
    input_json: &str,
) -> Result<String, String> {
    let i: CloseInput = parse(
        input_json,
        "context, size_lots, entry_ticks, margin_cents, blinder, round, price_ticks, \
         funding_cents",
    )?;
    let opening = opening(
        &i.context,
        &i.blinder,
        i.size_lots,
        i.entry_ticks,
        i.margin_cents,
    )?;
    let oracle = Oracle {
        round: i.round,
        price_ticks: i.price_ticks,
        funding_cents: i.funding_cents,
    };
    model::close(&opening, &oracle).map_err(|e| e.to_string())?;
    let pk = load_checked_key(pk_bytes, Statement::Close, expected_vk_sha256_b64)?;
    let out = api::prove_close_with(&pk, &opening, &oracle).map_err(|e| e.to_string())?;
    Ok(to_json(&SettlementJson {
        commitment: b64(&out.proof.commitment),
        proof: b64(&out.proof.proof),
        proving_ms: out.proof.proving_ms,
        refund: out.settlement.refund,
        bad_debt: out.settlement.bad_debt,
    }))
}

#[derive(Serialize)]
struct KeyInfoJson {
    format: &'static str,
    bytes: u64,
    public_inputs: usize,
    vk_sha256: String,
}

/// Platform-independent body of the `key_info` export: the detected format
/// and the verifying-key fingerprint, decoding only the verifying key.
pub fn key_info_json<S: KeySource + ?Sized>(pk_bytes: &S) -> Result<String, String> {
    let layout = key_layout(pk_bytes)?;
    let (_, digest) = read_vk(pk_bytes, &layout)?;
    Ok(to_json(&KeyInfoJson {
        format: layout.format.name(),
        bytes: layout.bytes,
        public_inputs: layout.public_inputs,
        vk_sha256: b64(&digest),
    }))
}

/// A compressed proving-key export written by [`compress_proving_key`].
pub struct CompressedKey {
    pub bytes: u64,
    /// SHA-256 of the exported file, for download integrity pinning.
    pub sha256: [u8; 32],
    /// SHA-256 of the NEP-488 verifying key (equals `get_config`'s).
    pub vk_sha256: [u8; 32],
}

/// Re-encodes the existing uncompressed key `dir/name` with arkworks point
/// compression into the new file `out`. The source key and every existing
/// file are left untouched; the export is decoded back and must equal the
/// source key before it is written.
pub fn compress_proving_key(
    dir: &std::path::Path,
    name: &str,
    out: &std::path::Path,
) -> Result<CompressedKey, api::Error> {
    use std::io::Write;
    let pk = api::load_pk(dir, name)?;
    let mut bytes = Vec::with_capacity(pk.compressed_size());
    pk.serialize_compressed(&mut bytes)
        .map_err(|e| api::Error::Key(e.to_string()))?;
    let back = ProvingKey::<Bls12_381>::deserialize_compressed_unchecked(&bytes[..])
        .map_err(|e| api::Error::Key(e.to_string()))?;
    if back != pk {
        return Err(api::Error::Key(
            "compressed export does not round-trip".into(),
        ));
    }
    let layout = key_layout(&bytes[..]).map_err(api::Error::Key)?;
    if layout.format != KeyFormat::Compressed {
        return Err(api::Error::Key(
            "compressed export has an unexpected layout".into(),
        ));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out)
        .map_err(|e| api::Error::Io(format!("cannot create {}: {e}", out.display())))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| api::Error::Io(e.to_string()))?;
    Ok(CompressedKey {
        bytes: bytes.len() as u64,
        sha256: sha256(&[&bytes]),
        vk_sha256: sha256(&[&vk_bytes(&pk.vk)]),
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod wasm {
    use js_sys::Uint8Array;
    use wasm_bindgen::JsCast;
    use wasm_bindgen::prelude::*;

    use super::KeySource;

    struct JsBytes(Uint8Array);

    impl KeySource for JsBytes {
        fn byte_len(&self) -> u64 {
            self.0.length() as u64
        }
        fn copy_at(&self, offset: u64, buf: &mut [u8]) {
            let start = offset as u32;
            self.0
                .subarray(start, start + buf.len() as u32)
                .copy_to(buf);
        }
    }

    fn bytes(v: &JsValue) -> Result<JsBytes, JsError> {
        v.dyn_ref::<Uint8Array>()
            .cloned()
            .map(JsBytes)
            .ok_or_else(|| JsError::new("pk_bytes must be a Uint8Array"))
    }

    fn js<T>(r: Result<T, String>) -> Result<T, JsError> {
        r.map_err(|e| JsError::new(&e))
    }

    /// Proves the open statement; returns the CLI `prove-open` JSON.
    #[wasm_bindgen]
    pub fn prove_open(
        #[wasm_bindgen(unchecked_param_type = "Uint8Array")] pk_bytes: &JsValue,
        expected_vk_sha256_b64: &str,
        input_json: &str,
    ) -> Result<String, JsError> {
        js(super::prove_open_json(
            &bytes(pk_bytes)?,
            expected_vk_sha256_b64,
            input_json,
        ))
    }

    /// Proves the voluntary close statement; returns the CLI `prove-close`
    /// JSON.
    #[wasm_bindgen]
    pub fn prove_close(
        #[wasm_bindgen(unchecked_param_type = "Uint8Array")] pk_bytes: &JsValue,
        expected_vk_sha256_b64: &str,
        input_json: &str,
    ) -> Result<String, JsError> {
        js(super::prove_close_json(
            &bytes(pk_bytes)?,
            expected_vk_sha256_b64,
            input_json,
        ))
    }

    /// `{format, bytes, public_inputs, vk_sha256}` of a proving key, decoding
    /// only its verifying key.
    #[wasm_bindgen]
    pub fn key_info(
        #[wasm_bindgen(unchecked_param_type = "Uint8Array")] pk_bytes: &JsValue,
    ) -> Result<String, JsError> {
        js(super::key_info_json(&bytes(pk_bytes)?))
    }

    #[wasm_bindgen]
    pub fn prove_pool(
        kind: &str,
        pk_bytes: &JsValue,
        fingerprint: &str,
        input: &str,
    ) -> Result<String, JsError> {
        js(crate::pool::prove_json(
            kind,
            &bytes(pk_bytes)?,
            fingerprint,
            input,
        ))
    }
}
