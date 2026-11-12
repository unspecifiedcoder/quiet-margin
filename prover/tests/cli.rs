//! CLI fixtures: runs the `xythum-prover` binary end to end and checks the
//! JSON outputs with the contract verifier.

mod common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use common::{fixture_opening, native_verify, verifier};
use xythum_prover::model;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_xythum-prover"))
}

fn run(args: &[&str], stdin: Option<&str>) -> Output {
    let mut child = bin()
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut s = child.stdin.take().unwrap();
        if let Some(input) = stdin {
            s.write_all(input.as_bytes()).unwrap();
        }
    }
    child.wait_with_output().unwrap()
}

fn ok_json(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn b64(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().unwrap()).unwrap()
}

fn fresh_dir(tag: &str) -> PathBuf {
    let mut rnd = [0u8; 8];
    getrandom(&mut rnd);
    let d = std::env::temp_dir().join(format!(
        "xythum-prover-{tag}-{}",
        rnd.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    assert!(!d.exists());
    d
}

fn getrandom(buf: &mut [u8]) {
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(buf);
}

fn input(round: Option<u64>, price: Option<u32>, funding: Option<u32>) -> String {
    let o = fixture_opening();
    let mut v = json!({
        "context": STANDARD.encode(o.context),
        "size_lots": o.lots,
        "entry_ticks": o.entry_ticks,
        "margin_cents": o.margin_cents,
        "blinder": STANDARD.encode(o.blinder),
    });
    if let Some(r) = round {
        v["round"] = json!(r);
    }
    if let Some(p) = price {
        v["price_ticks"] = json!(p);
    }
    if let Some(f) = funding {
        v["funding_cents"] = json!(f);
    }
    v.to_string()
}

#[test]
fn cli_end_to_end() {
    let dir = fresh_dir("e2e");
    let d = dir.to_str().unwrap();

    // setup
    let setup = ok_json(&run(&["setup", d], None));
    let open_vk = b64(&setup["open_vk"]);
    let liq_vk = b64(&setup["liquidation_vk"]);
    assert_eq!(open_vk.len(), verifier::OPEN_VK_LEN);
    assert_eq!(liq_vk.len(), verifier::LIQUIDATION_VK_LEN);
    assert_eq!(b64(&setup["open_vk_sha256"]), model::sha256(&[&open_vk]));
    assert_eq!(
        b64(&setup["liquidation_vk_sha256"]),
        model::sha256(&[&liq_vk])
    );
    for f in ["open.pk", "liquidation.pk", "open.vk", "liquidation.vk"] {
        assert!(dir.join(f).is_file(), "{f}");
    }
    assert_eq!(std::fs::read(dir.join("open.vk")).unwrap(), open_vk);

    // setup refuses to overwrite keys
    let again = run(&["setup", d], None);
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("already exists"));

    // commit
    let o = fixture_opening();
    let commit = ok_json(&run(&["commit"], Some(&input(None, None, None))));
    let cm: [u8; 32] = b64(&commit["commitment"]).try_into().unwrap();
    assert_eq!(cm, model::commitment(&o));
    assert_eq!(commit.as_object().unwrap().len(), 1);

    // prove-open
    let open = ok_json(&run(&["prove-open", d], Some(&input(None, None, None))));
    assert_eq!(b64(&open["commitment"]), cm);
    assert!(open["proving_ms"].is_u64());
    let proof = b64(&open["proof"]);
    assert_eq!(proof.len(), verifier::PROOF_LEN);
    assert!(native_verify(&open_vk, &proof, &verifier::open_inputs(&cm, &o.context)).0);

    // prove-liquidation (spec fixture at 5,200 ticks)
    let liq = ok_json(&run(
        &["prove-liquidation", d],
        Some(&input(Some(42), Some(5_200), Some(200))),
    ));
    assert_eq!(liq["refund"], json!(11_700));
    assert_eq!(liq["bad_debt"], json!(0));
    assert_eq!(b64(&liq["commitment"]), cm);
    let lproof = b64(&liq["proof"]);
    let st = |round| verifier::liquidation_inputs(&cm, &o.context, round, 5_200, 200, 11_700, 0);
    assert!(native_verify(&liq_vk, &lproof, &st(42)).0);
    assert!(!native_verify(&liq_vk, &lproof, &st(43)).0);

    // healthy position: nonzero exit, explanation, no panic, no witness dump
    let healthy = run(
        &["prove-liquidation", d],
        Some(&input(Some(43), Some(7_000), Some(200))),
    );
    assert!(!healthy.status.success());
    assert!(healthy.stdout.is_empty());
    let err = String::from_utf8_lossy(&healthy.stderr);
    assert!(err.contains("healthy"), "{err}");
    assert!(!err.contains("panicked"));
    assert!(!err.contains(&STANDARD.encode(o.blinder)));
    assert!(!err.contains("50000"));

    // missing oracle fields
    let missing = run(&["prove-liquidation", d], Some(&input(Some(1), None, None)));
    assert!(!missing.status.success());

    // open with keys from another directory still requires the key file
    let empty = fresh_dir("empty");
    let nokeys = run(
        &["prove-open", empty.to_str().unwrap()],
        Some(&input(None, None, None)),
    );
    assert!(!nokeys.status.success());

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn cli_rejects_bad_input() {
    let o = fixture_opening();
    let cases = [
        // unpadded base64
        json!({"context": STANDARD.encode(o.context).trim_end_matches('='), "size_lots": 10,
               "entry_ticks": 10000, "margin_cents": 50000, "blinder": STANDARD.encode(o.blinder)}),
        // wrong length
        json!({"context": STANDARD.encode([0u8; 31]), "size_lots": 10,
               "entry_ticks": 10000, "margin_cents": 50000, "blinder": STANDARD.encode(o.blinder)}),
        // out of u16 range
        json!({"context": STANDARD.encode(o.context), "size_lots": 70000,
               "entry_ticks": 10000, "margin_cents": 50000, "blinder": STANDARD.encode(o.blinder)}),
        // out of position bounds
        json!({"context": STANDARD.encode(o.context), "size_lots": 51,
               "entry_ticks": 10000, "margin_cents": 50000, "blinder": STANDARD.encode(o.blinder)}),
        // leverage
        json!({"context": STANDARD.encode(o.context), "size_lots": 10,
               "entry_ticks": 10000, "margin_cents": 33333, "blinder": STANDARD.encode(o.blinder)}),
        // unknown field
        json!({"context": STANDARD.encode(o.context), "size_lots": 10, "x": 1,
               "entry_ticks": 10000, "margin_cents": 50000, "blinder": STANDARD.encode(o.blinder)}),
    ];
    for c in cases {
        let out = run(&["commit"], Some(&c.to_string()));
        assert!(!out.status.success(), "{c}");
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("panicked"));
    }
    let out = run(&["bogus"], None);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}
