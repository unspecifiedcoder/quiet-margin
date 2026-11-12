//! JSON command-line interface.
//!
//! ```text
//! xythum-prover setup <directory>
//! xythum-prover commit                      < input.json
//! xythum-prover prove-open <directory>      < input.json
//! xythum-prover prove-liquidation <directory> < input.json
//! ```
//!
//! Input is one JSON object:
//! `{context, size_lots, entry_ticks, margin_cents, blinder, round?, price_ticks?, funding_cents?}`
//! with `context` and `blinder` as standard padded Base64 of 32 bytes.
//! Byte arrays in all outputs are standard padded Base64.
//! Errors are reported on stderr without echoing any witness value.

use std::io::Read;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::api;
use crate::model::{self, Opening, Oracle};

const USAGE: &str = "usage: xythum-prover <setup <dir> | commit | prove-open <dir> | prove-liquidation <dir>>";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    context: String,
    size_lots: u16,
    entry_ticks: u16,
    margin_cents: u32,
    blinder: String,
    #[serde(default)]
    round: Option<u64>,
    #[serde(default)]
    price_ticks: Option<u32>,
    #[serde(default)]
    funding_cents: Option<u32>,
}

#[derive(Serialize)]
struct SetupJson {
    open_vk: String,
    liquidation_vk: String,
    open_vk_sha256: String,
    liquidation_vk_sha256: String,
}

#[derive(Serialize)]
struct CommitJson {
    commitment: String,
}

#[derive(Serialize)]
struct ProofJson {
    commitment: String,
    proof: String,
    proving_ms: u64,
}

#[derive(Serialize)]
struct LiquidationJson {
    commitment: String,
    proof: String,
    proving_ms: u64,
    refund: u64,
    bad_debt: u64,
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn decode32(field: &str, s: &str) -> Result<[u8; 32], String> {
    let v = STANDARD
        .decode(s)
        .map_err(|_| format!("{field} must be standard padded Base64"))?;
    v.try_into()
        .map_err(|_| format!("{field} must decode to exactly 32 bytes"))
}

fn parse_input(raw: &str) -> Result<(Opening, Option<Oracle>), String> {
    let input: Input = serde_json::from_str(raw).map_err(|e| {
        // serde_json messages reference field names and positions, not values
        // of valid fields; still avoid echoing the input.
        format!(
            "invalid input JSON (line {}, column {}): expected {{context, size_lots, entry_ticks, \
             margin_cents, blinder, round?, price_ticks?, funding_cents?}} with in-range integers",
            e.line(),
            e.column()
        )
    })?;
    let opening = Opening {
        context: decode32("context", &input.context)?,
        blinder: decode32("blinder", &input.blinder)?,
        lots: input.size_lots,
        entry_ticks: input.entry_ticks,
        margin_cents: input.margin_cents,
    };
    let oracle = match (input.round, input.price_ticks, input.funding_cents) {
        (Some(round), Some(price_ticks), Some(funding_cents)) => Some(Oracle {
            round,
            price_ticks,
            funding_cents,
        }),
        _ => None,
    };
    Ok((opening, oracle))
}

fn read_stdin() -> Result<String, String> {
    let mut s = String::new();
    std::io::stdin()
        .read_to_string(&mut s)
        .map_err(|e| format!("cannot read stdin: {e}"))?;
    Ok(s)
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable output")
}

/// Runs a command; returns the stdout JSON line or an error message.
pub fn run(args: &[String], stdin: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    match args {
        [cmd, dir] if cmd == "setup" => {
            let out = api::setup(Path::new(dir)).map_err(|e| e.to_string())?;
            Ok(to_json(&SetupJson {
                open_vk: b64(&out.open_vk),
                liquidation_vk: b64(&out.liquidation_vk),
                open_vk_sha256: b64(&out.open_vk_sha256),
                liquidation_vk_sha256: b64(&out.liquidation_vk_sha256),
            }))
        }
        [cmd] if cmd == "commit" => {
            let (opening, _) = parse_input(&stdin()?)?;
            model::check_open(&opening).map_err(|e| e.to_string())?;
            Ok(to_json(&CommitJson {
                commitment: b64(&model::commitment(&opening)),
            }))
        }
        [cmd, dir] if cmd == "prove-open" => {
            let (opening, _) = parse_input(&stdin()?)?;
            let out = api::prove_open(Path::new(dir), &opening).map_err(|e| e.to_string())?;
            Ok(to_json(&ProofJson {
                commitment: b64(&out.commitment),
                proof: b64(&out.proof),
                proving_ms: out.proving_ms,
            }))
        }
        [cmd, dir] if cmd == "prove-liquidation" => {
            let (opening, oracle) = parse_input(&stdin()?)?;
            let oracle = oracle.ok_or_else(|| {
                "prove-liquidation requires round, price_ticks, and funding_cents".to_string()
            })?;
            let out = api::prove_liquidation(Path::new(dir), &opening, &oracle)
                .map_err(|e| e.to_string())?;
            Ok(to_json(&LiquidationJson {
                commitment: b64(&out.proof.commitment),
                proof: b64(&out.proof.proof),
                proving_ms: out.proof.proving_ms,
                refund: out.settlement.refund,
                bad_debt: out.settlement.bad_debt,
            }))
        }
        _ => Err(USAGE.to_string()),
    }
}

pub fn main_with_stdin(args: &[String]) -> Result<String, String> {
    run(args, read_stdin)
}
