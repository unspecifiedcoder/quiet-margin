//! Pure Rust reference model for the v1 BTC/mock-USDC long market.
//!
//! This module is the arithmetic oracle shared by the circuit tests, the CLI,
//! and the contract fixtures. It follows `docs/SPEC.md` ("Position and reference
//! arithmetic" and "Commitment, proofs, and encodings") exactly. All arithmetic
//! is done in `i128` so no intermediate value can overflow.

use sha2::{Digest, Sha256};

/// Inclusive position bounds.
pub const MIN_LOTS: u16 = 1;
pub const MAX_LOTS: u16 = 50;
pub const MIN_ENTRY_TICKS: u16 = 1;
pub const MAX_ENTRY_TICKS: u16 = 20_000;
pub const MIN_MARGIN_CENTS: u32 = 1;
pub const MAX_MARGIN_CENTS: u32 = 60_000;
/// `entry * lots <= MAX_LEVERAGE * margin`.
pub const MAX_LEVERAGE: u32 = 3;
/// Escrow locked by every open (cents).
pub const ESCROW_CENTS: u32 = 60_000;
/// Positive PnL cap used in settlement (cents).
pub const PNL_CAP_CENTS: u32 = 60_000;
/// Liquidation bounty paid to the submitting keeper (cents).
pub const BOUNTY_CENTS: u32 = 100;
/// Maximum cumulative funding debit (cents), inclusive.
pub const MAX_FUNDING_CENTS: u32 = 200;
/// Maintenance is `price * lots / MAINTENANCE_DIVISOR` (5%).
pub const MAINTENANCE_DIVISOR: u32 = 20;

/// The circuit binds oracle rounds as nonzero `u64` values.
pub const MIN_ROUND: u64 = 1;
/// The circuit binds oracle prices as nonzero `u32` tick values.
pub const MIN_PRICE_TICKS: u32 = 1;

pub const MARKET_PREFIX: &[u8] = b"xythum:BTC-USDC:v1:";
pub const CONTEXT_PREFIX: &[u8] = b"xythum:position:v1:";

/// The private opening of a position commitment.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Opening {
    pub context: [u8; 32],
    pub blinder: [u8; 32],
    pub lots: u16,
    pub entry_ticks: u16,
    pub margin_cents: u32,
}

impl core::fmt::Debug for Opening {
    // Never print private witness values.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Opening { .. }")
    }
}

/// Public oracle values bound by the liquidation statement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Oracle {
    pub round: u64,
    pub price_ticks: u32,
    pub funding_cents: u32,
}

/// Exact liquidation outputs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub refund: u64,
    pub bad_debt: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelError {
    LotsOutOfRange,
    EntryOutOfRange,
    MarginOutOfRange,
    LeverageExceeded,
    ZeroRound,
    ZeroPrice,
    FundingOutOfRange,
    /// `20 * equity >= price * lots`; equality is healthy.
    Healthy,
}

impl core::fmt::Display for ModelError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let msg = match self {
            ModelError::LotsOutOfRange => "size_lots must be in 1..=50",
            ModelError::EntryOutOfRange => "entry_ticks must be in 1..=20000",
            ModelError::MarginOutOfRange => "margin_cents must be in 1..=60000",
            ModelError::LeverageExceeded => "entry_ticks * size_lots must be <= 3 * margin_cents",
            ModelError::ZeroRound => "round must be nonzero",
            ModelError::ZeroPrice => "price_ticks must be nonzero",
            ModelError::FundingOutOfRange => "funding_cents must be in 0..=200",
            ModelError::Healthy => {
                "position is healthy at this oracle round (equity is at least 5% \
                 maintenance); liquidation cannot be proven"
            }
        };
        f.write_str(msg)
    }
}

impl std::error::Error for ModelError {}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// `SHA256("xythum:BTC-USDC:v1:" || deployment_id[32] || contract_account_utf8)`
pub fn market(deployment_id: &[u8; 32], contract_account: &str) -> [u8; 32] {
    sha256(&[MARKET_PREFIX, deployment_id, contract_account.as_bytes()])
}

/// `SHA256("xythum:position:v1:" || market[32] || nonce_u32 || trader_account_utf8)`
pub fn context(market: &[u8; 32], nonce: u32, trader_account: &str) -> [u8; 32] {
    sha256(&[
        CONTEXT_PREFIX,
        market,
        &nonce.to_le_bytes(),
        trader_account.as_bytes(),
    ])
}

/// The 72-byte commitment preimage
/// `context[32] || blinder[32] || lots_u16 || entry_u16 || margin_u32`.
pub fn commitment_preimage(o: &Opening) -> [u8; 72] {
    let mut out = [0u8; 72];
    out[..32].copy_from_slice(&o.context);
    out[32..64].copy_from_slice(&o.blinder);
    out[64..66].copy_from_slice(&o.lots.to_le_bytes());
    out[66..68].copy_from_slice(&o.entry_ticks.to_le_bytes());
    out[68..72].copy_from_slice(&o.margin_cents.to_le_bytes());
    out
}

pub fn commitment(o: &Opening) -> [u8; 32] {
    sha256(&[&commitment_preimage(o)])
}

/// Entry and risk bounds enforced by both statements.
pub fn check_open(o: &Opening) -> Result<(), ModelError> {
    if !(MIN_LOTS..=MAX_LOTS).contains(&o.lots) {
        return Err(ModelError::LotsOutOfRange);
    }
    if !(MIN_ENTRY_TICKS..=MAX_ENTRY_TICKS).contains(&o.entry_ticks) {
        return Err(ModelError::EntryOutOfRange);
    }
    if !(MIN_MARGIN_CENTS..=MAX_MARGIN_CENTS).contains(&o.margin_cents) {
        return Err(ModelError::MarginOutOfRange);
    }
    let notional = o.entry_ticks as u64 * o.lots as u64;
    if notional > MAX_LEVERAGE as u64 * o.margin_cents as u64 {
        return Err(ModelError::LeverageExceeded);
    }
    Ok(())
}

pub fn check_oracle(oracle: &Oracle) -> Result<(), ModelError> {
    if oracle.round < MIN_ROUND {
        return Err(ModelError::ZeroRound);
    }
    if oracle.price_ticks < MIN_PRICE_TICKS {
        return Err(ModelError::ZeroPrice);
    }
    if oracle.funding_cents > MAX_FUNDING_CENTS {
        return Err(ModelError::FundingOutOfRange);
    }
    Ok(())
}

/// `pnl = (price - entry) * lots`
pub fn pnl(o: &Opening, price_ticks: u32) -> i128 {
    (price_ticks as i128 - o.entry_ticks as i128) * o.lots as i128
}

/// `equity = margin - funding + pnl`
pub fn equity(o: &Opening, oracle: &Oracle) -> i128 {
    o.margin_cents as i128 - oracle.funding_cents as i128 + pnl(o, oracle.price_ticks)
}

/// `20 * equity < price * lots`
pub fn is_liquidatable(o: &Opening, oracle: &Oracle) -> bool {
    MAINTENANCE_DIVISOR as i128 * equity(o, oracle)
        < oracle.price_ticks as i128 * o.lots as i128
}

/// Settlement formulas evaluated without the health or bounds checks.
/// Used by tests that need the "would-be" outputs of a healthy position.
pub fn settlement_formula(o: &Opening, oracle: &Oracle) -> (i128, i128) {
    let eq = equity(o, oracle);
    let capped = o.margin_cents as i128 - oracle.funding_cents as i128
        + pnl(o, oracle.price_ticks).min(PNL_CAP_CENTS as i128);
    let refund =
        ESCROW_CENTS as i128 - o.margin_cents as i128 + (capped - BOUNTY_CENTS as i128).max(0);
    let bad_debt = (-eq).max(0);
    (refund, bad_debt)
}

/// Exact liquidation outputs; refuses healthy positions.
pub fn settle(o: &Opening, oracle: &Oracle) -> Result<Settlement, ModelError> {
    check_open(o)?;
    check_oracle(oracle)?;
    if !is_liquidatable(o, oracle) {
        return Err(ModelError::Healthy);
    }
    let (refund, bad_debt) = settlement_formula(o, oracle);
    // Bounds keep both values small and nonnegative.
    Ok(Settlement {
        refund: u64::try_from(refund).expect("refund is nonnegative and bounded"),
        bad_debt: u64::try_from(bad_debt).expect("bad debt is nonnegative and bounded"),
    })
}

/// `vault_after = vault_before + 60000 - refund - 100` (may be negative for
/// callers to reject; returned as i128).
pub fn vault_after(vault_before: u64, s: &Settlement) -> i128 {
    vault_before as i128 + ESCROW_CENTS as i128 - s.refund as i128 - BOUNTY_CENTS as i128
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(margin: u32) -> Opening {
        Opening {
            context: [7u8; 32],
            blinder: [9u8; 32],
            lots: 10,
            entry_ticks: 10_000,
            margin_cents: margin,
        }
    }

    fn oracle(price: u32, funding: u32) -> Oracle {
        Oracle {
            round: 1,
            price_ticks: price,
            funding_cents: funding,
        }
    }

    #[test]
    fn spec_fixture_healthy_at_7000() {
        let o = fixture(50_000);
        assert_eq!(equity(&o, &oracle(7_000, 200)), 19_800);
        assert_eq!(settle(&o, &oracle(7_000, 200)), Err(ModelError::Healthy));
    }

    #[test]
    fn spec_fixture_liquidates_at_5200() {
        let o = fixture(50_000);
        let or = oracle(5_200, 200);
        assert_eq!(equity(&o, &or), 1_800);
        let s = settle(&o, &or).unwrap();
        assert_eq!(
            s,
            Settlement {
                refund: 11_700,
                bad_debt: 0
            }
        );
        // Maker gains 48,200.
        assert_eq!(vault_after(0, &s), 48_200);
    }

    #[test]
    fn maintenance_equality_is_healthy() {
        let o = fixture(50_002);
        let eq = oracle(5_284, 200);
        assert_eq!(20 * equity(&o, &eq), 5_284 * 10);
        assert_eq!(settle(&o, &eq), Err(ModelError::Healthy));
        let below = oracle(5_283, 200);
        let s = settle(&o, &below).unwrap();
        // equity 2632, capped 2632, refund = 10000 - 2 + 2532
        assert_eq!(
            s,
            Settlement {
                refund: 12_530,
                bad_debt: 0
            }
        );
    }

    #[test]
    fn price_gap_creates_bad_debt() {
        let o = fixture(50_000);
        let s = settle(&o, &oracle(100, 200)).unwrap();
        assert_eq!(
            s,
            Settlement {
                refund: 10_000,
                bad_debt: 49_200
            }
        );
        assert_eq!(vault_after(0, &s), 49_900);
    }

    #[test]
    fn small_equity_below_bounty_refunds_only_unassigned_escrow() {
        let o = fixture(50_000);
        // equity = 50000 - 200 + (5023-10000)*10 = 30 -> below bounty
        assert_eq!(equity(&o, &oracle(5_023, 200)), 30);
        let s = settle(&o, &oracle(5_023, 200)).unwrap();
        assert_eq!(
            s,
            Settlement {
                refund: 10_000,
                bad_debt: 0
            }
        );
    }

    #[test]
    fn open_bounds() {
        let mut o = fixture(50_000);
        assert!(check_open(&o).is_ok());
        o.lots = 0;
        assert_eq!(check_open(&o), Err(ModelError::LotsOutOfRange));
        o.lots = 51;
        assert_eq!(check_open(&o), Err(ModelError::LotsOutOfRange));
        o.lots = 50;
        o.entry_ticks = 20_001;
        assert_eq!(check_open(&o), Err(ModelError::EntryOutOfRange));
        o.entry_ticks = 3;
        o.margin_cents = 50;
        assert!(check_open(&o).is_ok()); // 150 <= 150
        o.entry_ticks = 4;
        assert_eq!(check_open(&o), Err(ModelError::LeverageExceeded));
        o.margin_cents = 60_001;
        assert_eq!(check_open(&o), Err(ModelError::MarginOutOfRange));
    }

    #[test]
    fn commitment_layout() {
        let o = fixture(50_000);
        let pre = commitment_preimage(&o);
        assert_eq!(&pre[64..66], &10u16.to_le_bytes());
        assert_eq!(&pre[66..68], &10_000u16.to_le_bytes());
        assert_eq!(&pre[68..72], &50_000u32.to_le_bytes());
        assert_eq!(commitment(&o), sha256(&[&pre]));
    }
}
