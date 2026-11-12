# Builds the browser prover (wasm-bindgen --target web).
#
#   powershell -File prover/browser/build.ps1 [-OutDir <dir>]   # default: prover/target/browser/pkg
#
# Same steps as build.sh: pinned toolchain cdylib build, then wasm-bindgen-cli
# 0.2.130 (PATH or prover/target/tools/bin, installed with --locked if missing).
param([string]$OutDir = "")
$ErrorActionPreference = "Stop"

$prover = Split-Path -Parent $PSScriptRoot
if ($OutDir -eq "") { $OutDir = Join-Path $prover "target/browser/pkg" }
$bindgenVersion = "0.2.130"
$tools = Join-Path $prover "target/tools"

Push-Location $prover
try {
    & cargo rustc --locked --release --lib --target wasm32-unknown-unknown --crate-type cdylib
    if ($LASTEXITCODE -ne 0) { throw "cargo rustc failed" }

    $bindgen = $null
    $candidates = @((Join-Path $tools "bin/wasm-bindgen.exe"), (Join-Path $tools "bin/wasm-bindgen"))
    $onPath = Get-Command wasm-bindgen -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    foreach ($c in $candidates) {
        if ((Test-Path $c) -and ((& $c --version) -eq "wasm-bindgen $bindgenVersion")) { $bindgen = $c; break }
    }
    if (-not $bindgen) {
        & cargo install wasm-bindgen-cli --version "=$bindgenVersion" --locked --root $tools
        if ($LASTEXITCODE -ne 0) { throw "cargo install wasm-bindgen-cli failed" }
        $bindgen = Join-Path $tools "bin/wasm-bindgen.exe"
    }

    New-Item -ItemType Directory -Force $OutDir | Out-Null
    & $bindgen --target web --out-dir $OutDir --out-name xythum_prover `
        (Join-Path $prover "target/wasm32-unknown-unknown/release/xythum_prover.wasm")
    if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed" }
    Get-ChildItem $OutDir
} finally {
    Pop-Location
}
