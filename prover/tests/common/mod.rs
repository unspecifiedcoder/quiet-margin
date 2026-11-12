#![allow(dead_code)]

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{Gas, testing_env};
use xythum_prover::model::{self, Opening, Oracle};

/// The contract verifier, compiled against near-sdk's mocked blockchain which
/// runs nearcore's `near-vm-runner` NEP-488 host functions.
#[path = "../../../src/verifier.rs"]
pub mod verifier;

pub const DEPLOYMENT_ID: [u8; 32] = [0x11; 32];
pub const CONTRACT: &str = "perps.test.near";
pub const TRADER: &str = "trader.test.near";

/// Funding checkpoint of the fixture position.
pub const CHECKPOINT: u32 = 0;
/// Fixture quote blinder.
pub const QUOTE_BLINDER: [u8; 32] = [0x3c; 32];
/// Fixture opening mark ($100,000).
pub const OPEN_PRICE: u32 = 10_000;

pub fn fixture_context_at(nonce: u32, funding_checkpoint: u32) -> [u8; 32] {
    let market = model::market(&DEPLOYMENT_ID, CONTRACT);
    model::context(&market, nonce, funding_checkpoint, TRADER)
}

pub fn fixture_context(nonce: u32) -> [u8; 32] {
    fixture_context_at(nonce, CHECKPOINT)
}

/// Spec fixture: 10 lots at 10,000 ticks with 50,000 cents margin.
pub fn fixture_opening() -> Opening {
    Opening {
        context: fixture_context(1),
        blinder: [0xa5; 32],
        lots: 10,
        entry_ticks: 10_000,
        margin_cents: 50_000,
    }
}

pub fn oracle(round: u64, price_ticks: u32, funding_cents: u32) -> Oracle {
    Oracle {
        round,
        price_ticks,
        funding_cents,
    }
}

/// Runs the contract verifier in a fresh mocked receipt; returns the result
/// and gas burnt.
pub fn native_verify(vk: &[u8], proof: &[u8], inputs: &[[u8; 32]]) -> (bool, u64) {
    let mut ctx = VMContextBuilder::new();
    ctx.prepaid_gas(Gas::from_tgas(300));
    testing_env!(ctx.build());
    let ok = verifier::verify(vk, proof, inputs);
    (ok, near_sdk::env::used_gas().as_gas())
}

pub fn native_validate_vk(vk: &[u8], n: usize) -> bool {
    let mut ctx = VMContextBuilder::new();
    ctx.prepaid_gas(Gas::from_tgas(300));
    testing_env!(ctx.build());
    verifier::validate_vk(vk, n)
}
