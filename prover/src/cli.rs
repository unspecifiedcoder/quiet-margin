//! JSON command-line interface.
//!
//! ```text
//! xythum-prover setup <directory>
//! xythum-prover keys <directory>
//! xythum-prover commit                        < input.json
//! xythum-prover prove-open <directory>        < input.json
//! xythum-prover prove-liquidation <directory> < input.json
//! xythum-prover prove-close <directory>       < input.json
//! ```
//!
//! Input is one JSON object:
//! `{context, size_lots, entry_ticks, margin_cents, blinder, quote_blinder?,
//!   open_price_ticks?, round?, price_ticks?, funding_cents?}`
//! with `context`, `blinder`, and `quote_blinder` as standard padded Base64
//! of 32 bytes. `prove-open` requires `quote_blinder` and `open_price_ticks`;
//! `prove-liquidation` and `prove-close` require `round`, `price_ticks`, and
//! `funding_cents`, where `funding_cents` is the authenticated funding index
//! delta `current_funding_index - funding_checkpoint`. `commit` also returns
//! `quote_terms` when `quote_blinder` is supplied.
//!
//! `setup` writes fresh keys into a directory that holds no key material;
//! `keys` re-exports the public keys of an existing directory.
//! Byte arrays in all outputs are standard padded Base64.
//! Errors are reported on stderr without echoing any witness value.

use std::io::Read;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::api;
use crate::model::{self, Opening, Oracle};

const USAGE: &str = "usage: xythum-prover <setup <dir> | keys <dir> | commit | prove-open <dir> \
                     | prove-liquidation <dir> | prove-close <dir>>";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    context: String,
    size_lots: u16,
    entry_ticks: u16,
    margin_cents: u32,
    blinder: String,
    #[serde(default)]
    quote_blinder: Option<String>,
    #[serde(default)]
    open_price_ticks: Option<u32>,
    #[serde(default)]
    round: Option<u64>,
    #[serde(default)]
    price_ticks: Option<u32>,
    #[serde(default)]
    funding_cents: Option<u32>,
}

struct Parsed {
    opening: Opening,
    quote_blinder: Option<[u8; 32]>,
    open_price_ticks: Option<u32>,
    oracle: Option<Oracle>,
}

#[derive(Serialize)]
struct SetupJson {
    open_vk: String,
    liquidation_vk: String,
    close_vk: String,
    open_vk_sha256: String,
    liquidation_vk_sha256: String,
    close_vk_sha256: String,
}

#[derive(Serialize)]
struct CommitJson {
    commitment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    quote_terms: Option<String>,
}

#[derive(Serialize)]
struct OpenJson {
    commitment: String,
    quote_terms: String,
    proof: String,
    proving_ms: u64,
}

/// Shared by `prove-liquidation` and `prove-close`.
#[derive(Serialize)]
struct SettlementJson {
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

fn parse_input(raw: &str) -> Result<Parsed, String> {
    let input: Input = serde_json::from_str(raw).map_err(|e| {
        // serde_json messages reference field names and positions, not values
        // of valid fields; still avoid echoing the input.
        format!(
            "invalid input JSON (line {}, column {}): expected {{context, size_lots, entry_ticks, \
             margin_cents, blinder, quote_blinder?, open_price_ticks?, round?, price_ticks?, \
             funding_cents?}} with in-range integers",
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
    let quote_blinder = input
        .quote_blinder
        .as_deref()
        .map(|s| decode32("quote_blinder", s))
        .transpose()?;
    let oracle = match (input.round, input.price_ticks, input.funding_cents) {
        (Some(round), Some(price_ticks), Some(funding_cents)) => Some(Oracle {
            round,
            price_ticks,
            funding_cents,
        }),
        _ => None,
    };
    Ok(Parsed {
        opening,
        quote_blinder,
        open_price_ticks: input.open_price_ticks,
        oracle,
    })
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

fn setup_json(out: &api::SetupOutput) -> String {
    to_json(&SetupJson {
        open_vk: b64(&out.open_vk),
        liquidation_vk: b64(&out.liquidation_vk),
        close_vk: b64(&out.close_vk),
        open_vk_sha256: b64(&out.open_vk_sha256),
        liquidation_vk_sha256: b64(&out.liquidation_vk_sha256),
        close_vk_sha256: b64(&out.close_vk_sha256),
    })
}

fn settlement_json(out: &api::SettlementOutput) -> String {
    to_json(&SettlementJson {
        commitment: b64(&out.proof.commitment),
        proof: b64(&out.proof.proof),
        proving_ms: out.proof.proving_ms,
        refund: out.settlement.refund,
        bad_debt: out.settlement.bad_debt,
    })
}

fn require_oracle(cmd: &str, p: &Parsed) -> Result<Oracle, String> {
    p.oracle
        .ok_or_else(|| format!("{cmd} requires round, price_ticks, and funding_cents"))
}

/// Runs a command; returns the stdout JSON line or an error message.
pub fn run(
    args: &[String],
    stdin: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    match args {
        [cmd, dir] if cmd == "setup" => {
            let out = api::setup(Path::new(dir)).map_err(|e| e.to_string())?;
            Ok(setup_json(&out))
        }
        [cmd, dir] if cmd == "keys" => {
            let out = api::export_keys(Path::new(dir)).map_err(|e| e.to_string())?;
            Ok(setup_json(&out))
        }
        [cmd] if cmd == "commit" => {
            let p = parse_input(&stdin()?)?;
            model::check_open(&p.opening).map_err(|e| e.to_string())?;
            Ok(to_json(&CommitJson {
                commitment: b64(&model::commitment(&p.opening)),
                quote_terms: p
                    .quote_blinder
                    .map(|qb| b64(&model::quote_terms(&p.opening, &qb))),
            }))
        }
        [cmd, dir] if cmd == "prove-open" => {
            let p = parse_input(&stdin()?)?;
            let (Some(quote_blinder), Some(open_price_ticks)) =
                (p.quote_blinder, p.open_price_ticks)
            else {
                return Err("prove-open requires quote_blinder and open_price_ticks".to_string());
            };
            let out = api::prove_open(Path::new(dir), &p.opening, &quote_blinder, open_price_ticks)
                .map_err(|e| e.to_string())?;
            Ok(to_json(&OpenJson {
                commitment: b64(&out.proof.commitment),
                quote_terms: b64(&out.quote_terms),
                proof: b64(&out.proof.proof),
                proving_ms: out.proof.proving_ms,
            }))
        }
        [cmd, dir] if cmd == "prove-liquidation" => {
            let p = parse_input(&stdin()?)?;
            let oracle = require_oracle(cmd, &p)?;
            let out = api::prove_liquidation(Path::new(dir), &p.opening, &oracle)
                .map_err(|e| e.to_string())?;
            Ok(settlement_json(&out))
        }
        [cmd, dir] if cmd == "prove-close" => {
            let p = parse_input(&stdin()?)?;
            let oracle = require_oracle(cmd, &p)?;
            let out =
                api::prove_close(Path::new(dir), &p.opening, &oracle).map_err(|e| e.to_string())?;
            Ok(settlement_json(&out))
        }
        _ => Err(USAGE.to_string()),
    }
}

pub fn main_with_stdin(args: &[String]) -> Result<String, String> {
    run(args, read_stdin)
}
