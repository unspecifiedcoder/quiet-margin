//! Operator tool for the browser prover.
//!
//! ```text
//! xythum-browser-keys compress <key_dir> <out_dir>
//! xythum-browser-keys info <proving_key_file>
//! ```
//!
//! `compress` reads the existing uncompressed `open.pk` and `close.pk` under
//! `<key_dir>` (never modified) and writes new `open.compressed.pk` and
//! `close.compressed.pk` under `<out_dir>`, refusing to overwrite. It prints
//! `{open: {file, bytes, sha256, vk_sha256}, close: {...}}`; `vk_sha256`
//! equals `get_config().open_vk_sha256` / `close_vk_sha256` of a deployment
//! using these keys, and `sha256` pins the download.
//!
//! `info` prints `{format, bytes, public_inputs, vk_sha256}` for a key file
//! in either format (the same JSON as the wasm `key_info` export).

use std::path::Path;
use std::process::ExitCode;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use xythum_prover::api::{CLOSE_PK_FILE, OPEN_PK_FILE};
use xythum_prover::browser;

const USAGE: &str =
    "usage: xythum-browser-keys <compress <key_dir> <out_dir> | info <proving_key_file>>";

pub const OPEN_COMPRESSED_FILE: &str = "open.compressed.pk";
pub const CLOSE_COMPRESSED_FILE: &str = "close.compressed.pk";

fn compress(key_dir: &Path, out_dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(out_dir)
        .map_err(|e| format!("cannot create {}: {e}", out_dir.display()))?;
    let mut parts = Vec::new();
    for (label, src, dst) in [
        ("open", OPEN_PK_FILE, OPEN_COMPRESSED_FILE),
        ("close", CLOSE_PK_FILE, CLOSE_COMPRESSED_FILE),
    ] {
        let out = out_dir.join(dst);
        let k = browser::compress_proving_key(key_dir, src, &out).map_err(|e| e.to_string())?;
        parts.push(format!(
            "\"{label}\":{}",
            serde_json::json!({
                "file": dst,
                "bytes": k.bytes,
                "sha256": STANDARD.encode(k.sha256),
                "vk_sha256": STANDARD.encode(k.vk_sha256),
            })
        ));
    }
    Ok(format!("{{{}}}", parts.join(",")))
}

fn info(file: &Path) -> Result<String, String> {
    let bytes = std::fs::read(file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    browser::key_info_json(&bytes[..])
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [cmd, key_dir, out_dir] if cmd == "compress" => {
            compress(Path::new(key_dir), Path::new(out_dir))
        }
        [cmd, file] if cmd == "info" => info(Path::new(file)),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::FAILURE
        }
    }
}
