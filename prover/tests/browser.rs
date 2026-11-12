//! Native tests of the browser prover entry points (`xythum_prover::browser`,
//! the bodies of the wasm `prove_open` / `prove_close` / `key_info` exports):
//! CLI-identical JSON, NEP-488 verification of the returned proofs on
//! nearcore's host functions, both key formats, and fail-closed validation.

mod common;

use std::sync::OnceLock;

use ark_bls12_381::Bls12_381;
use ark_groth16::{Groth16, ProvingKey};
use ark_serialize::CanonicalSerialize;
use ark_snark::SNARK;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rand::rngs::OsRng;
use serde_json::Value;

use common::{OPEN_PRICE, QUOTE_BLINDER, fixture_opening, native_verify, verifier};
use xythum_prover::browser::{self, KeyFormat, MAX_INPUT_JSON_BYTES};
use xythum_prover::circuit::{CloseCircuit, OpenCircuit};
use xythum_prover::encoding::vk_bytes;
use xythum_prover::{api, cli, model};

struct Key {
    uncompressed: Vec<u8>,
    compressed: Vec<u8>,
    vk: Vec<u8>,
    vk_sha256: String,
}

struct Keys {
    open: Key,
    close: Key,
}

fn key(pk: ProvingKey<Bls12_381>) -> Key {
    let mut uncompressed = Vec::new();
    pk.serialize_uncompressed(&mut uncompressed).unwrap();
    let mut compressed = Vec::new();
    pk.serialize_compressed(&mut compressed).unwrap();
    let vk = vk_bytes(&pk.vk);
    let vk_sha256 = STANDARD.encode(model::sha256(&[&vk]));
    Key {
        uncompressed,
        compressed,
        vk,
        vk_sha256,
    }
}

fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let open = Groth16::<Bls12_381>::circuit_specific_setup(OpenCircuit::setup_shape(), &mut OsRng)
            .unwrap()
            .0;
        let close =
            Groth16::<Bls12_381>::circuit_specific_setup(CloseCircuit::setup_shape(), &mut OsRng)
                .unwrap()
                .0;
        Keys {
            open: key(open),
            close: key(close),
        }
    })
}

fn b64(b: &[u8]) -> String {
    STANDARD.encode(b)
}

fn opening_json() -> serde_json::Map<String, Value> {
    let o = fixture_opening();
    serde_json::json!({
        "context": b64(&o.context),
        "size_lots": o.lots,
        "entry_ticks": o.entry_ticks,
        "margin_cents": o.margin_cents,
        "blinder": b64(&o.blinder),
    })
    .as_object()
    .unwrap()
    .clone()
}

fn open_input() -> Value {
    let mut m = opening_json();
    m.insert("quote_blinder".into(), b64(&QUOTE_BLINDER).into());
    m.insert("open_price_ticks".into(), OPEN_PRICE.into());
    Value::Object(m)
}

fn close_input(round: u64, price: u32, funding: u32) -> Value {
    let mut m = opening_json();
    m.insert("round".into(), round.into());
    m.insert("price_ticks".into(), price.into());
    m.insert("funding_cents".into(), funding.into());
    Value::Object(m)
}

fn with(v: &Value, field: &str, value: Value) -> String {
    let mut v = v.clone();
    v.as_object_mut().unwrap().insert(field.into(), value);
    v.to_string()
}

fn without(v: &Value, field: &str) -> String {
    let mut v = v.clone();
    v.as_object_mut().unwrap().remove(field);
    v.to_string()
}

/// Runs the native CLI against `pk` written into a fresh temp key directory.
fn cli_output(cmd: &str, file: &str, pk: &[u8], input: &str) -> Value {
    let dir = std::env::temp_dir().join(format!(
        "xythum-browser-test-{cmd}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(file), pk).unwrap();
    let args = [cmd.to_string(), dir.display().to_string()];
    let input = input.to_string();
    let out = cli::run(&args, move || Ok(input));
    std::fs::remove_dir_all(&dir).unwrap();
    serde_json::from_str(&out.unwrap()).unwrap()
}

fn keys_of(v: &Value) -> Vec<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

/// `serde_json` sorts object keys without `preserve_order`; compare the raw
/// field order of the returned string with the CLI's struct order instead.
fn field_order(raw: &str) -> Vec<String> {
    raw.trim_matches(['{', '}'])
        .split(',')
        .map(|kv| kv.split(':').next().unwrap().trim_matches('"').to_string())
        .collect()
}

fn decode_proof(v: &Value) -> Vec<u8> {
    STANDARD.decode(v["proof"].as_str().unwrap()).unwrap()
}

#[test]
fn key_layout_detects_both_formats() {
    let k = keys();
    for (key, inputs) in [(&k.open, 7), (&k.close, 9)] {
        let u = browser::key_layout(&key.uncompressed[..]).unwrap();
        let c = browser::key_layout(&key.compressed[..]).unwrap();
        assert_eq!(u.format, KeyFormat::Uncompressed);
        assert_eq!(c.format, KeyFormat::Compressed);
        assert_eq!((u.public_inputs, c.public_inputs), (inputs, inputs));
        assert_eq!((u.variables, u.h_len, u.l_len), (c.variables, c.h_len, c.l_len));
        for bytes in [&key.uncompressed, &key.compressed] {
            let info: Value = serde_json::from_str(&browser::key_info_json(&bytes[..]).unwrap())
                .unwrap();
            assert_eq!(info["vk_sha256"], key.vk_sha256.as_str());
            assert_eq!(info["public_inputs"], inputs);
            assert_eq!(info["bytes"], bytes.len());
        }
        eprintln!(
            "{inputs}-input key: {} bytes uncompressed, {} compressed, {} variables, \
             h {}, l {}",
            u.bytes, c.bytes, u.variables, u.h_len, u.l_len
        );
    }
}

#[test]
fn open_matches_cli_and_verifies_on_nep488() {
    let k = keys();
    let o = fixture_opening();
    let input = open_input().to_string();
    let cli = cli_output("prove-open", api::OPEN_PK_FILE, &k.open.uncompressed, &input);
    for pk in [&k.open.uncompressed, &k.open.compressed] {
        let raw = browser::prove_open_json(&pk[..], &k.open.vk_sha256, &input).unwrap();
        assert_eq!(
            field_order(&raw),
            ["commitment", "quote_terms", "proof", "proving_ms"]
        );
        let out: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(keys_of(&out), keys_of(&cli));
        assert_eq!(out["commitment"], cli["commitment"]);
        assert_eq!(out["quote_terms"], cli["quote_terms"]);
        assert_eq!(out["commitment"], b64(&model::commitment(&o)).as_str());
        assert!(out["proving_ms"].is_u64());
        let proof = decode_proof(&out);
        let inputs = verifier::open_inputs(
            &model::commitment(&o),
            &o.context,
            &model::quote_terms(&o, &QUOTE_BLINDER),
            OPEN_PRICE,
        );
        assert!(native_verify(&k.open.vk, &proof, &inputs).0);
        assert!(!native_verify(&k.close.vk, &proof, &inputs).0);
    }
}

#[test]
fn close_matches_cli_and_verifies_on_nep488() {
    let k = keys();
    let o = fixture_opening();
    let input = close_input(7, 12_000, 200).to_string();
    let cli = cli_output("prove-close", api::CLOSE_PK_FILE, &k.close.uncompressed, &input);
    assert_eq!((cli["refund"].as_u64(), cli["bad_debt"].as_u64()), (Some(79_800), Some(0)));
    for pk in [&k.close.uncompressed, &k.close.compressed] {
        let raw = browser::prove_close_json(&pk[..], &k.close.vk_sha256, &input).unwrap();
        assert_eq!(
            field_order(&raw),
            ["commitment", "proof", "proving_ms", "refund", "bad_debt"]
        );
        let out: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(keys_of(&out), keys_of(&cli));
        for f in ["commitment", "refund", "bad_debt"] {
            assert_eq!(out[f], cli[f], "{f}");
        }
        let proof = decode_proof(&out);
        let inputs = verifier::liquidation_inputs(
            &model::commitment(&o),
            &o.context,
            7,
            12_000,
            200,
            79_800,
            0,
        );
        assert!(native_verify(&k.close.vk, &proof, &inputs).0);
    }
}

#[test]
fn keys_fail_closed() {
    let k = keys();
    let open = open_input().to_string();
    let close = close_input(7, 12_000, 200).to_string();
    let err = |r: Result<String, String>| r.unwrap_err();

    // Wrong fingerprint, wrong statement, malformed fingerprint.
    assert!(
        err(browser::prove_open_json(&k.open.uncompressed[..], &k.close.vk_sha256, &open))
            .contains("not the expected open fingerprint")
    );
    assert!(
        err(browser::prove_open_json(&k.close.compressed[..], &k.close.vk_sha256, &open))
            .contains("9 public inputs; the open statement has 7")
    );
    assert!(
        err(browser::prove_close_json(&k.open.uncompressed[..], &k.open.vk_sha256, &close))
            .contains("7 public inputs; the close statement has 9")
    );
    for fp in ["", "AAAA", &k.open.vk_sha256[..43]] {
        assert!(
            err(browser::prove_open_json(&k.open.uncompressed[..], fp, &open))
                .contains("expected_vk_sha256_b64")
        );
    }

    // Truncated, extended, empty, and length-prefix-forged keys never decode
    // (and never allocate by a forged length).
    let u = &k.open.uncompressed;
    let mut extended = u.clone();
    extended.push(0);
    for bad in [&u[..u.len() - 1], &extended[..], &[][..], &u[..4096]] {
        assert!(
            err(browser::prove_open_json(bad, &k.open.vk_sha256, &open)).contains("not an arkworks")
        );
    }
    let mut forged = u[..4096].to_vec();
    forged[672..680].copy_from_slice(&u64::MAX.to_le_bytes());
    assert!(browser::key_layout(&forged[..]).is_err());
    let zeros = vec![0u8; 4096];
    assert!(browser::key_layout(&zeros[..]).is_err());

    // A key whose embedded verifying key bytes are corrupted fails the
    // fingerprint (or point validation) before the body is decoded.
    let mut corrupt = u.clone();
    corrupt[10] ^= 1;
    assert!(browser::prove_open_json(&corrupt[..], &k.open.vk_sha256, &open).is_err());

    // Uncompressed layout: vk = 96 + 3*192 + 8 + 8*96 = 1440 bytes, then
    // beta_g1, delta_g1, and the a_query length prefix.
    let vk_end = 96 + 3 * 192 + 8 + 8 * 96;
    let delta_g1 = vk_end + 96;
    let a0 = delta_g1 + 96 + 8;
    // An off-curve delta_g1 is rejected before proving.
    let mut bad_delta = u.clone();
    bad_delta[delta_g1 + 95] ^= 1;
    assert!(
        err(browser::prove_open_json(&bad_delta[..], &k.open.vk_sha256, &open))
            .contains("invalid delta_g1")
    );
    // A corrupted body point that the witness always uses (a_query[0], the
    // constant-one variable) passes the fingerprint but never yields output.
    // (Corrupting a point whose witness coefficient is zero is harmless: the
    // proof still verifies against the pinned key.)
    let mut body = u.clone();
    body[a0 + 95] ^= 1;
    assert!(
        err(browser::prove_open_json(&body[..], &k.open.vk_sha256, &open)).starts_with("proof error")
    );
}

#[test]
fn inputs_are_canonical_and_bounded() {
    // Every input error is reported before any key byte is examined: the key
    // argument here is empty.
    let open = open_input();
    let close = close_input(7, 12_000, 200);
    let fp = &keys().open.vk_sha256;
    let open_err = |s: String| browser::prove_open_json(&[][..], fp, &s).unwrap_err();
    let close_err = |s: String| browser::prove_close_json(&[][..], fp, &s).unwrap_err();
    let json = "invalid input JSON";
    let witness = b64(&fixture_opening().blinder);

    for (bad, msg) in [
        (with(&open, "round", 1.into()), json),
        (with(&open, "extra", 1.into()), json),
        (without(&open, "quote_blinder"), json),
        (without(&open, "open_price_ticks"), json),
        (with(&open, "size_lots", 1.5.into()), json),
        (with(&open, "size_lots", (-1).into()), json),
        (with(&open, "size_lots", 65_536.into()), json),
        (with(&open, "size_lots", "10".into()), json),
        (with(&open, "size_lots", Value::Null), json),
        (with(&open, "size_lots", 51.into()), "size_lots must be in 1..=50"),
        (with(&open, "open_price_ticks", 0.into()), "open_price_ticks must be in"),
        (with(&open, "open_price_ticks", 1.into()), "below 5% maintenance"),
        (with(&open, "margin_cents", 1.into()), "entry_ticks * size_lots"),
        (with(&open, "blinder", b64(&[1; 31]).into()), "exactly 32 bytes"),
        // Missing padding, non-canonical trailing bits, URL-safe alphabet.
        (with(&open, "context", b64(&[1; 32]).trim_end_matches('=').into()), "canonical"),
        (with(&open, "context", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQF=".into()), "canonical"),
        (with(&open, "quote_blinder", b64(&[0xff; 32]).replace('/', "_").into()), "canonical"),
        (format!("{} ", open) + &" ".repeat(MAX_INPUT_JSON_BYTES), "exceeds"),
        (r#"{"context":"a","context":"b"}"#.to_string(), json),
        ("[]".to_string(), json),
    ] {
        let e = open_err(bad);
        assert!(e.contains(msg), "{e}");
        assert!(!e.contains(&witness[..12]), "no witness echo: {e}");
    }
    for (bad, msg) in [
        (with(&close, "quote_blinder", b64(&[1; 32]).into()), json),
        (with(&close, "open_price_ticks", 1.into()), json),
        (without(&close, "funding_cents"), json),
        (with(&close, "round", 0.into()), "round must be nonzero"),
        (with(&close, "round", (-1).into()), json),
        (with(&close, "price_ticks", 20_001.into()), "price_ticks must be in"),
        (with(&close, "funding_cents", 201.into()), "funding_cents must be in"),
    ] {
        let e = close_err(bad);
        assert!(e.contains(msg), "{e}");
    }
    // A u64 round is accepted beyond JS's 2^53 safe range when sent as an
    // exact JSON integer.
    let big = with(&close, "round", u64::MAX.into());
    assert!(close_err(big).contains("not an arkworks"));
}
