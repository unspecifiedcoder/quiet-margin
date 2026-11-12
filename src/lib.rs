//! Xythum native NEAR funded-market prototype.
//!
//! Default build: the single-slot confidential BTC/mock-USDC clearing contract
//! described in `docs/FUNDED-MARKET.md` (v2), which overrides the v1
//! `docs/SPEC.md`. With `--features mock-token` the crate instead builds a
//! mock NEP-141 demo test asset and the clearing contract is not compiled.

#[cfg(feature = "mock-token")]
pub mod mock_token;

#[cfg(not(feature = "mock-token"))]
mod verifier;

#[cfg(not(feature = "mock-token"))]
pub use clearing::*;

#[cfg(not(feature = "mock-token"))]
mod clearing {
    use crate::verifier::{self, liquidation_inputs, open_inputs};
    use near_sdk::json_types::{Base64VecU8, U128};
    use near_sdk::serde_json::{Value, json};
    use near_sdk::{
        AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
        ext_contract, log, near, require,
    };

    // ---------------------------------------------------------------------
    // Fixed v2 market parameters (cents / ticks / lots).
    // ---------------------------------------------------------------------

    /// Escrow locked from trader available funds per open.
    pub const ESCROW: u64 = 60_000;
    /// Maker vault reservation per open (escrow-sized PnL cap plus bounty).
    pub const RESERVE: u64 = 60_100;
    /// Constant liquidation bounty credited to the submitting keeper.
    pub const BOUNTY: u64 = 100;
    /// Largest liquidation refund the settlement formula can produce:
    /// `60000 - margin + (margin + 60000 - 100)`.
    pub const MAX_REFUND: u64 = ESCROW + ESCROW - BOUNTY;
    /// Largest close refund (no bounty): `60000 - margin + (margin + 60000)`.
    pub const MAX_CLOSE_REFUND: u64 = ESCROW + ESCROW;
    pub const MAX_PRICE_TICKS: u32 = 20_000;
    /// Largest funding index increase over an active position's checkpoint.
    pub const MAX_FUNDING_DELTA_CENTS: u32 = 200;
    /// Oracle freshness window in blocks, inclusive.
    pub const ORACLE_FRESHNESS_BLOCKS: u32 = 1_000;
    const CIPHERTEXT_LEN: usize = 144;
    pub const KEEPER_COUNT: usize = 2;
    pub const KEY_VERSION: u32 = 1;

    pub const MARKET_PREFIX: &[u8] = b"xythum:BTC-USDC:v2:";
    pub const POSITION_PREFIX: &[u8] = b"xythum:position:v2:";
    pub const ACK_PREFIX: &[u8] = b"xythum:keeper-ack:v2:";
    /// Prefix of the off-chain `quote_terms` digest; the contract stores the
    /// digest only and the open proof binds it to the commitment.
    pub const QUOTE_PREFIX: &[u8] = b"xythum:quote:v2:";

    pub const DEPOSIT_MSG_TRADER: &str = "trader";
    pub const DEPOSIT_MSG_MAKER: &str = "maker";

    /// Fixed gas for the outgoing `ft_transfer`.
    pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
    /// Fixed gas reserved for `resolve_withdraw`.
    pub const GAS_RESOLVE_WITHDRAW: Gas = Gas::from_tgas(10);
    /// Minimum prepaid gas for `withdraw`: both fixed budgets plus local work.
    pub const GAS_WITHDRAW_MIN_PREPAID: Gas = Gas::from_tgas(40);
    /// Bound on the bytes read back from the token's `ft_transfer` result.
    const MAX_FT_RESULT_LEN: usize = 64;

    /// Stable error messages, suitable for receipt-failure matching.
    pub mod errors {
        pub const ERR_NOT_TRADER: &str = "ERR_NOT_TRADER";
        pub const ERR_NOT_MAKER: &str = "ERR_NOT_MAKER";
        pub const ERR_NOT_ORACLE: &str = "ERR_NOT_ORACLE";
        pub const ERR_NOT_KEEPER: &str = "ERR_NOT_KEEPER";
        pub const ERR_NOT_CLAIMANT: &str = "ERR_NOT_CLAIMANT";
        pub const ERR_WRONG_TOKEN: &str = "ERR_WRONG_TOKEN";
        pub const ERR_KEEPER_COUNT: &str = "ERR_KEEPER_COUNT";
        pub const ERR_ACK_KEY_LEN: &str = "ERR_ACK_KEY_LEN";
        pub const ERR_ROLES_NOT_DISTINCT: &str = "ERR_ROLES_NOT_DISTINCT";
        pub const ERR_KEYS_NOT_DISTINCT: &str = "ERR_KEYS_NOT_DISTINCT";
        pub const ERR_DEPLOYMENT_ID_LEN: &str = "ERR_DEPLOYMENT_ID_LEN";
        pub const ERR_OPEN_VK_LEN: &str = "ERR_OPEN_VK_LEN";
        pub const ERR_LIQUIDATION_VK_LEN: &str = "ERR_LIQUIDATION_VK_LEN";
        pub const ERR_CLOSE_VK_LEN: &str = "ERR_CLOSE_VK_LEN";
        pub const ERR_INVALID_VK: &str = "ERR_INVALID_VK";
        pub const ERR_VKS_NOT_DISTINCT: &str = "ERR_VKS_NOT_DISTINCT";
        pub const ERR_ROUND_ZERO: &str = "ERR_ROUND_ZERO";
        pub const ERR_ROUND_NOT_INCREASING: &str = "ERR_ROUND_NOT_INCREASING";
        pub const ERR_PRICE_RANGE: &str = "ERR_PRICE_RANGE";
        /// Funding index would exceed the active checkpoint by more than 200.
        pub const ERR_FUNDING_RANGE: &str = "ERR_FUNDING_RANGE";
        pub const ERR_FUNDING_DECREASED: &str = "ERR_FUNDING_DECREASED";
        pub const ERR_QUOTE_TERMS_LEN: &str = "ERR_QUOTE_TERMS_LEN";
        /// Latest oracle price or funding index differs from the staged opening.
        pub const ERR_OPENING_CHANGED: &str = "ERR_OPENING_CHANGED";
        pub const ERR_HEIGHT_RANGE: &str = "ERR_HEIGHT_RANGE";
        pub const ERR_HALTED: &str = "ERR_HALTED";
        pub const ERR_SLOT_OCCUPIED: &str = "ERR_SLOT_OCCUPIED";
        pub const ERR_BAD_NONCE: &str = "ERR_BAD_NONCE";
        pub const ERR_COMMITMENT_LEN: &str = "ERR_COMMITMENT_LEN";
        pub const ERR_CIPHERTEXT_COUNT: &str = "ERR_CIPHERTEXT_COUNT";
        pub const ERR_CIPHERTEXT_LEN: &str = "ERR_CIPHERTEXT_LEN";
        pub const ERR_NO_PENDING: &str = "ERR_NO_PENDING";
        pub const ERR_PENDING_MISMATCH: &str = "ERR_PENDING_MISMATCH";
        pub const ERR_EXPIRY_NOT_FUTURE: &str = "ERR_EXPIRY_NOT_FUTURE";
        pub const ERR_NO_QUOTE: &str = "ERR_NO_QUOTE";
        pub const ERR_QUOTE_EXPIRED: &str = "ERR_QUOTE_EXPIRED";
        pub const ERR_NO_ORACLE: &str = "ERR_NO_ORACLE";
        pub const ERR_ORACLE_STALE: &str = "ERR_ORACLE_STALE";
        pub const ERR_INSUFFICIENT_ESCROW: &str = "ERR_INSUFFICIENT_ESCROW";
        pub const ERR_INSUFFICIENT_RESERVE: &str = "ERR_INSUFFICIENT_RESERVE";
        pub const ERR_ACK_COUNT: &str = "ERR_ACK_COUNT";
        pub const ERR_ACK_LEN: &str = "ERR_ACK_LEN";
        pub const ERR_ACK_INVALID: &str = "ERR_ACK_INVALID";
        pub const ERR_PROOF_INVALID: &str = "ERR_PROOF_INVALID";
        pub const ERR_NO_ACTIVE: &str = "ERR_NO_ACTIVE";
        pub const ERR_ACTIVE_MISMATCH: &str = "ERR_ACTIVE_MISMATCH";
        pub const ERR_ROUND_MISMATCH: &str = "ERR_ROUND_MISMATCH";
        pub const ERR_REFUND_RANGE: &str = "ERR_REFUND_RANGE";
        pub const ERR_RESERVE_COVERAGE: &str = "ERR_RESERVE_COVERAGE";
        pub const ERR_LEDGER_OVERFLOW: &str = "ERR_LEDGER_OVERFLOW";
        pub const ERR_LEDGER_UNDERFLOW: &str = "ERR_LEDGER_UNDERFLOW";
        pub const ERR_NONCE_EXHAUSTED: &str = "ERR_NONCE_EXHAUSTED";
        pub const ERR_ZERO_AMOUNT: &str = "ERR_ZERO_AMOUNT";
        pub const ERR_AMOUNT_RANGE: &str = "ERR_AMOUNT_RANGE";
        pub const ERR_INSUFFICIENT_BALANCE: &str = "ERR_INSUFFICIENT_BALANCE";
        pub const ERR_WITHDRAW_IN_FLIGHT: &str = "ERR_WITHDRAW_IN_FLIGHT";
        pub const ERR_ONE_YOCTO: &str = "ERR_ONE_YOCTO";
        pub const ERR_PREPAID_GAS: &str = "ERR_PREPAID_GAS";
        pub const ERR_NO_PROMISE_RESULT: &str = "ERR_NO_PROMISE_RESULT";
        pub const ERR_NO_IN_FLIGHT: &str = "ERR_NO_IN_FLIGHT";
    }
    use errors::*;

    // ---------------------------------------------------------------------
    // Encodings shared with the proof and integration tooling.
    // ---------------------------------------------------------------------

    /// `SHA256("xythum:BTC-USDC:v2:" || deployment_id || contract_account_utf8)`.
    pub fn market_hash(deployment_id: &[u8; 32], contract_id: &AccountId) -> [u8; 32] {
        let mut data = Vec::with_capacity(MARKET_PREFIX.len() + 32 + contract_id.len());
        data.extend_from_slice(MARKET_PREFIX);
        data.extend_from_slice(deployment_id);
        data.extend_from_slice(contract_id.as_bytes());
        env::sha256_array(&data)
    }

    /// `SHA256("xythum:position:v2:" || market || nonce_u32_le ||
    /// funding_checkpoint_u32_le || trader_account_utf8)`.
    pub fn position_context(
        market: &[u8; 32],
        nonce: u32,
        funding_checkpoint: u32,
        trader_id: &AccountId,
    ) -> [u8; 32] {
        let mut data = Vec::with_capacity(POSITION_PREFIX.len() + 40 + trader_id.len());
        data.extend_from_slice(POSITION_PREFIX);
        data.extend_from_slice(market);
        data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(&funding_checkpoint.to_le_bytes());
        data.extend_from_slice(trader_id.as_bytes());
        env::sha256_array(&data)
    }

    /// Off-chain maker quote digest, provided for tooling cross-checks:
    /// `SHA256("xythum:quote:v2:" || context || quote_blinder || lots_u16_le ||
    /// entry_ticks_u16_le)`. The contract only stores and forwards it.
    pub fn quote_terms_digest(
        context: &[u8; 32],
        quote_blinder: &[u8; 32],
        lots: u16,
        entry_ticks: u16,
    ) -> [u8; 32] {
        let mut data = Vec::with_capacity(QUOTE_PREFIX.len() + 64 + 4);
        data.extend_from_slice(QUOTE_PREFIX);
        data.extend_from_slice(context);
        data.extend_from_slice(quote_blinder);
        data.extend_from_slice(&lots.to_le_bytes());
        data.extend_from_slice(&entry_ticks.to_le_bytes());
        env::sha256_array(&data)
    }

    /// Keeper acknowledgment message for keeper `keeper_index` (zero-based).
    pub fn ack_message(
        market: &[u8; 32],
        nonce: u32,
        commitment: &[u8; 32],
        ciphertext: &[u8],
        keeper_index: u8,
    ) -> Vec<u8> {
        let mut data = Vec::with_capacity(ACK_PREFIX.len() + 32 + 4 + 32 + 32 + 1 + 4);
        data.extend_from_slice(ACK_PREFIX);
        data.extend_from_slice(market);
        data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(commitment);
        data.extend_from_slice(&env::sha256_array(ciphertext));
        data.push(keeper_index);
        data.extend_from_slice(&KEY_VERSION.to_le_bytes());
        data
    }

    fn verify_proof(vk: &[u8], proof: &[u8], inputs: &[[u8; 32]]) -> bool {
        #[cfg(not(test))]
        {
            verifier::verify(vk, proof, inputs)
        }
        #[cfg(test)]
        {
            // Keep the verifier signature statically checked in test builds.
            let _: fn(&[u8], &[u8], &[[u8; 32]]) -> bool = verifier::verify;
            tests::proof_hook_accepts(vk, proof, inputs)
        }
    }

    fn emit(event: &str, data: Value) {
        let payload = json!({
            "standard": "xythum_near_perps",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        });
        env::log_str(&format!("EVENT_JSON:{payload}"));
    }

    fn hash32(bytes: &[u8], err: &str) -> [u8; 32] {
        bytes.try_into().unwrap_or_else(|_| env::panic_str(err))
    }

    fn current_height() -> u32 {
        u32::try_from(env::block_height()).unwrap_or_else(|_| env::panic_str(ERR_HEIGHT_RANGE))
    }

    fn add(a: u64, b: u64) -> u64 {
        a.checked_add(b)
            .unwrap_or_else(|| env::panic_str(ERR_LEDGER_OVERFLOW))
    }

    fn sub(a: u64, b: u64) -> u64 {
        a.checked_sub(b)
            .unwrap_or_else(|| env::panic_str(ERR_LEDGER_UNDERFLOW))
    }

    #[ext_contract(ext_ft)]
    #[allow(dead_code)]
    trait FungibleTokenTransfer {
        fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    }

    // ---------------------------------------------------------------------
    // State and JSON types.
    // ---------------------------------------------------------------------

    #[near(serializers = [borsh])]
    #[derive(Clone)]
    pub struct Keeper {
        pub account_id: AccountId,
        pub ack_key: [u8; 32],
    }

    #[near(serializers = [json])]
    #[derive(Clone)]
    pub struct KeeperInput {
        pub account_id: AccountId,
        pub ack_key: Base64VecU8,
    }

    #[near(serializers = [borsh])]
    #[derive(Clone)]
    pub struct Slot {
        pub nonce: u32,
        pub commitment: [u8; 32],
        /// Salted maker quote digest bound to the commitment by the open proof.
        pub quote_terms: [u8; 32],
        /// Authenticated oracle price fixed at staging; the opening mark.
        pub open_price_ticks: u32,
        /// Oracle funding index fixed at staging and committed in the context.
        pub funding_checkpoint: u32,
        pub ciphertexts: Vec<Vec<u8>>,
    }

    impl Slot {
        fn context(&self, market: &[u8; 32], trader_id: &AccountId) -> [u8; 32] {
            position_context(market, self.nonce, self.funding_checkpoint, trader_id)
        }
    }

    #[near(serializers = [borsh])]
    pub struct Pending {
        pub slot: Slot,
        /// Maker approval expiry height; `None` until approved.
        pub quote_expires_at: Option<u32>,
    }

    #[near(serializers = [json])]
    pub struct SlotView {
        pub nonce: u32,
        pub commitment: Base64VecU8,
        pub quote_terms: Base64VecU8,
        pub open_price_ticks: u32,
        pub funding_checkpoint: u32,
        pub ciphertexts: Vec<Base64VecU8>,
    }

    impl From<&Slot> for SlotView {
        fn from(s: &Slot) -> Self {
            Self {
                nonce: s.nonce,
                commitment: s.commitment.to_vec().into(),
                quote_terms: s.quote_terms.to_vec().into(),
                open_price_ticks: s.open_price_ticks,
                funding_checkpoint: s.funding_checkpoint,
                ciphertexts: s.ciphertexts.iter().map(|c| c.clone().into()).collect(),
            }
        }
    }

    #[near(serializers = [json])]
    pub struct QuoteView {
        pub nonce: u32,
        pub commitment: Base64VecU8,
        pub quote_terms: Base64VecU8,
        pub open_price_ticks: u32,
        pub expires_at: u32,
    }

    /// Settlement mode shared by `close` and `liquidate`.
    #[derive(Clone, Copy)]
    enum Settlement {
        Close,
        Liquidation { keeper_index: usize },
    }

    impl Settlement {
        fn bounty(self) -> u64 {
            match self {
                Self::Close => 0,
                Self::Liquidation { .. } => BOUNTY,
            }
        }
    }

    #[near(serializers = [borsh, json])]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct OracleRound {
        pub round: u64,
        pub price_ticks: u32,
        pub funding_cents: u32,
        pub height: u32,
    }

    #[near(serializers = [borsh, json])]
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Ledger {
        pub trader_available: u64,
        pub trader_locked: u64,
        /// Inclusive of `maker_reserved`.
        pub maker_vault: u64,
        pub maker_reserved: u64,
        pub keeper_available: [u64; KEEPER_COUNT],
        /// Total cents currently in flight to claimants.
        pub pending_withdrawals: u64,
        pub bad_debt: u64,
        pub halted: bool,
        pub next_nonce: u32,
    }

    impl Ledger {
        /// Sum of every token-backed bucket; equals the contract's FT balance.
        pub fn total_holdings(&self) -> Option<u64> {
            self.trader_available
                .checked_add(self.trader_locked)?
                .checked_add(self.maker_vault)?
                .checked_add(self.keeper_available[0])?
                .checked_add(self.keeper_available[1])?
                .checked_add(self.pending_withdrawals)
        }

        fn maker_free(&self) -> u64 {
            sub(self.maker_vault, self.maker_reserved)
        }
    }

    #[near(serializers = [json])]
    pub struct ConfigView {
        pub token_id: AccountId,
        pub trader_id: AccountId,
        pub maker_id: AccountId,
        pub oracle_id: AccountId,
        pub keepers: Vec<KeeperInput>,
        pub deployment_id: Base64VecU8,
        pub key_version: u32,
        pub open_vk_sha256: Base64VecU8,
        pub liquidation_vk_sha256: Base64VecU8,
        pub close_vk_sha256: Base64VecU8,
    }

    /// Claimant index: 0 trader, 1 keeper A, 2 keeper B, 3 maker.
    const CLAIMANTS: usize = 1 + KEEPER_COUNT + 1;
    const MAKER_CLAIMANT: usize = 1 + KEEPER_COUNT;

    #[near(contract_state)]
    #[derive(PanicOnDefault)]
    pub struct Contract {
        token_id: AccountId,
        trader_id: AccountId,
        maker_id: AccountId,
        oracle_id: AccountId,
        keepers: [Keeper; KEEPER_COUNT],
        deployment_id: [u8; 32],
        market: [u8; 32],
        open_vk: Vec<u8>,
        liquidation_vk: Vec<u8>,
        close_vk: Vec<u8>,
        oracle: Option<OracleRound>,
        pending: Option<Pending>,
        active: Option<Slot>,
        ledger: Ledger,
        in_flight: [Option<u64>; CLAIMANTS],
    }

    #[near]
    impl Contract {
        #[init]
        #[private]
        #[allow(clippy::too_many_arguments)]
        pub fn init(
            token_id: AccountId,
            trader_id: AccountId,
            maker_id: AccountId,
            oracle_id: AccountId,
            keepers: Vec<KeeperInput>,
            deployment_id: Base64VecU8,
            open_vk: Base64VecU8,
            liquidation_vk: Base64VecU8,
            close_vk: Base64VecU8,
        ) -> Self {
            require!(keepers.len() == KEEPER_COUNT, ERR_KEEPER_COUNT);
            let keepers: Vec<Keeper> = keepers
                .into_iter()
                .map(|k| Keeper {
                    account_id: k.account_id,
                    ack_key: hash32(&k.ack_key.0, ERR_ACK_KEY_LEN),
                })
                .collect();
            let keepers: [Keeper; KEEPER_COUNT] = [keepers[0].clone(), keepers[1].clone()];
            require!(
                keepers[0].ack_key != keepers[1].ack_key,
                ERR_KEYS_NOT_DISTINCT
            );

            let contract_id = env::current_account_id();
            let roles = [
                &contract_id,
                &token_id,
                &trader_id,
                &maker_id,
                &oracle_id,
                &keepers[0].account_id,
                &keepers[1].account_id,
            ];
            for (i, a) in roles.iter().enumerate() {
                for b in &roles[i + 1..] {
                    require!(a != b, ERR_ROLES_NOT_DISTINCT);
                }
            }

            let deployment_id = hash32(&deployment_id.0, ERR_DEPLOYMENT_ID_LEN);
            require!(open_vk.0.len() == verifier::OPEN_VK_LEN, ERR_OPEN_VK_LEN);
            require!(
                liquidation_vk.0.len() == verifier::LIQUIDATION_VK_LEN,
                ERR_LIQUIDATION_VK_LEN
            );
            // Close shares the settlement statement shape but has its own key.
            require!(
                close_vk.0.len() == verifier::LIQUIDATION_VK_LEN,
                ERR_CLOSE_VK_LEN
            );
            require!(close_vk.0 != liquidation_vk.0, ERR_VKS_NOT_DISTINCT);

            require!(
                verifier::validate_vk(&open_vk.0, verifier::OPEN_INPUTS)
                    && verifier::validate_vk(&liquidation_vk.0, verifier::LIQUIDATION_INPUTS)
                    && verifier::validate_vk(&close_vk.0, verifier::LIQUIDATION_INPUTS),
                ERR_INVALID_VK
            );

            Self {
                market: market_hash(&deployment_id, &contract_id),
                token_id,
                trader_id,
                maker_id,
                oracle_id,
                keepers,
                deployment_id,
                open_vk: open_vk.0,
                liquidation_vk: liquidation_vk.0,
                close_vk: close_vk.0,
                oracle: None,
                pending: None,
                active: None,
                ledger: Ledger {
                    trader_available: 0,
                    trader_locked: 0,
                    maker_vault: 0,
                    maker_reserved: 0,
                    keeper_available: [0; KEEPER_COUNT],
                    pending_withdrawals: 0,
                    bad_debt: 0,
                    halted: false,
                    next_nonce: 1,
                },
                in_flight: [None; CLAIMANTS],
            }
        }

        // -----------------------------------------------------------------
        // Deposits.
        // -----------------------------------------------------------------

        /// NEP-141 receiver. Accepts the configured token only. Returns the
        /// unused amount, so anything not credited is refunded in full.
        pub fn ft_on_transfer(
            &mut self,
            sender_id: AccountId,
            amount: U128,
            msg: String,
        ) -> PromiseOrValue<U128> {
            require!(
                env::predecessor_account_id() == self.token_id,
                ERR_WRONG_TOKEN
            );
            let refund_all = PromiseOrValue::Value(amount);
            let Ok(cents) = u64::try_from(amount.0) else {
                log!("deposit refunded: amount exceeds u64");
                return refund_all;
            };
            let to_trader = msg == DEPOSIT_MSG_TRADER && sender_id == self.trader_id;
            let to_maker = msg == DEPOSIT_MSG_MAKER && sender_id == self.maker_id;
            if !to_trader && !to_maker {
                log!("deposit refunded: unsupported sender or msg");
                return refund_all;
            }
            let fits = self
                .ledger
                .total_holdings()
                .and_then(|t| t.checked_add(cents))
                .is_some();
            if !fits {
                log!("deposit refunded: ledger would exceed u64");
                return refund_all;
            }
            if to_trader {
                self.ledger.trader_available = add(self.ledger.trader_available, cents);
            } else {
                self.ledger.maker_vault = add(self.ledger.maker_vault, cents);
            }
            emit(
                "collateral_deposited",
                json!({ "cents": cents, "bucket": msg }),
            );
            PromiseOrValue::Value(U128(0))
        }

        // -----------------------------------------------------------------
        // Oracle.
        // -----------------------------------------------------------------

        pub fn publish_oracle(&mut self, round: u64, price_ticks: u32, funding_cents: u32) {
            require!(
                env::predecessor_account_id() == self.oracle_id,
                ERR_NOT_ORACLE
            );
            require!(round > 0, ERR_ROUND_ZERO);
            require!(
                (1..=MAX_PRICE_TICKS).contains(&price_ticks),
                ERR_PRICE_RANGE
            );
            if let Some(prev) = &self.oracle {
                require!(round > prev.round, ERR_ROUND_NOT_INCREASING);
                require!(funding_cents >= prev.funding_cents, ERR_FUNDING_DECREASED);
            }
            // An active position's settlement funding delta stays in 0..=200.
            if let Some(active) = &self.active {
                let cap = u64::from(active.funding_checkpoint) + u64::from(MAX_FUNDING_DELTA_CENTS);
                require!(u64::from(funding_cents) <= cap, ERR_FUNDING_RANGE);
            }
            self.oracle = Some(OracleRound {
                round,
                price_ticks,
                funding_cents,
                height: current_height(),
            });
        }

        // -----------------------------------------------------------------
        // Admission.
        // -----------------------------------------------------------------

        /// Stages the single pending position. The latest fresh oracle round
        /// fixes the opening mark and the funding checkpoint committed in the
        /// position context. Restaging replaces the item and its approval.
        pub fn stage_position(
            &mut self,
            nonce: u32,
            commitment: Base64VecU8,
            quote_terms: Base64VecU8,
            ciphertexts: Vec<Base64VecU8>,
        ) {
            require!(
                env::predecessor_account_id() == self.trader_id,
                ERR_NOT_TRADER
            );
            require!(!self.ledger.halted, ERR_HALTED);
            require!(self.active.is_none(), ERR_SLOT_OCCUPIED);
            require!(nonce == self.ledger.next_nonce, ERR_BAD_NONCE);
            let commitment = hash32(&commitment.0, ERR_COMMITMENT_LEN);
            let quote_terms = hash32(&quote_terms.0, ERR_QUOTE_TERMS_LEN);
            require!(ciphertexts.len() == KEEPER_COUNT, ERR_CIPHERTEXT_COUNT);
            for c in &ciphertexts {
                require!(c.0.len() == CIPHERTEXT_LEN, ERR_CIPHERTEXT_LEN);
            }
            let oracle = self.fresh_oracle(current_height());
            // Replacing an existing pending item drops its maker approval.
            self.pending = Some(Pending {
                slot: Slot {
                    nonce,
                    commitment,
                    quote_terms,
                    open_price_ticks: oracle.price_ticks,
                    funding_checkpoint: oracle.funding_cents,
                    ciphertexts: ciphertexts.into_iter().map(|c| c.0).collect(),
                },
                quote_expires_at: None,
            });
        }

        /// Maker approval of the exact pending position and quote digest.
        /// Expiry must be a future height and is inclusive for `open`.
        pub fn approve_quote(
            &mut self,
            nonce: u32,
            commitment: Base64VecU8,
            quote_terms: Base64VecU8,
            open_price_ticks: u32,
            expires_at: u32,
        ) {
            require!(
                env::predecessor_account_id() == self.maker_id,
                ERR_NOT_MAKER
            );
            require!(!self.ledger.halted, ERR_HALTED);
            let commitment = hash32(&commitment.0, ERR_COMMITMENT_LEN);
            let quote_terms = hash32(&quote_terms.0, ERR_QUOTE_TERMS_LEN);
            require!(expires_at > current_height(), ERR_EXPIRY_NOT_FUTURE);
            let pending = self
                .pending
                .as_mut()
                .unwrap_or_else(|| env::panic_str(ERR_NO_PENDING));
            require!(
                pending.slot.nonce == nonce
                    && pending.slot.commitment == commitment
                    && pending.slot.quote_terms == quote_terms
                    && pending.slot.open_price_ticks == open_price_ticks,
                ERR_PENDING_MISMATCH
            );
            pending.quote_expires_at = Some(expires_at);
        }

        pub fn open(
            &mut self,
            nonce: u32,
            commitment: Base64VecU8,
            acknowledgments: Vec<Base64VecU8>,
            proof: Base64VecU8,
        ) {
            require!(
                env::predecessor_account_id() == self.trader_id,
                ERR_NOT_TRADER
            );
            require!(!self.ledger.halted, ERR_HALTED);
            require!(self.active.is_none(), ERR_SLOT_OCCUPIED);
            let commitment = hash32(&commitment.0, ERR_COMMITMENT_LEN);
            let now = current_height();

            let pending = self
                .pending
                .as_ref()
                .unwrap_or_else(|| env::panic_str(ERR_NO_PENDING));
            require!(
                pending.slot.nonce == nonce && pending.slot.commitment == commitment,
                ERR_PENDING_MISMATCH
            );
            require!(nonce == self.ledger.next_nonce, ERR_BAD_NONCE);
            let expires_at = pending
                .quote_expires_at
                .unwrap_or_else(|| env::panic_str(ERR_NO_QUOTE));
            require!(now <= expires_at, ERR_QUOTE_EXPIRED);

            // A later round with the same price and index keeps the opening.
            let oracle = self.fresh_oracle(now);
            require!(
                oracle.price_ticks == pending.slot.open_price_ticks
                    && oracle.funding_cents == pending.slot.funding_checkpoint,
                ERR_OPENING_CHANGED
            );

            require!(
                self.ledger.trader_available >= ESCROW,
                ERR_INSUFFICIENT_ESCROW
            );
            require!(
                self.ledger.maker_free() >= RESERVE,
                ERR_INSUFFICIENT_RESERVE
            );

            require!(acknowledgments.len() == KEEPER_COUNT, ERR_ACK_COUNT);
            for (i, (keeper, ack)) in self.keepers.iter().zip(&acknowledgments).enumerate() {
                let sig: [u8; 64] = ack
                    .0
                    .as_slice()
                    .try_into()
                    .unwrap_or_else(|_| env::panic_str(ERR_ACK_LEN));
                let msg = ack_message(
                    &self.market,
                    nonce,
                    &commitment,
                    &pending.slot.ciphertexts[i],
                    i as u8,
                );
                require!(
                    env::ed25519_verify(&sig, &msg, &keeper.ack_key),
                    ERR_ACK_INVALID
                );
            }

            let context = pending.slot.context(&self.market, &self.trader_id);
            let inputs = open_inputs(
                &commitment,
                &context,
                &pending.slot.quote_terms,
                pending.slot.open_price_ticks,
            );
            require!(
                verify_proof(&self.open_vk, &proof.0, &inputs),
                ERR_PROOF_INVALID
            );

            // Effects: all checks passed.
            let next_nonce = nonce
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str(ERR_NONCE_EXHAUSTED));
            let mut ledger = self.ledger.clone();
            ledger.trader_available = sub(ledger.trader_available, ESCROW);
            ledger.trader_locked = add(ledger.trader_locked, ESCROW);
            ledger.maker_reserved = add(ledger.maker_reserved, RESERVE);
            ledger.next_nonce = next_nonce;
            let pending = self
                .pending
                .take()
                .unwrap_or_else(|| env::panic_str(ERR_NO_PENDING));
            self.active = Some(pending.slot);
            self.ledger = ledger;
            emit("position_opened", json!({ "nonce": nonce }));
        }

        // -----------------------------------------------------------------
        // Settlement.
        // -----------------------------------------------------------------

        /// Voluntary trader close, regardless of health. No keeper bounty.
        pub fn close(
            &mut self,
            nonce: u32,
            root: Base64VecU8,
            round: u64,
            refund: u64,
            bad_debt: u64,
            proof: Base64VecU8,
        ) {
            require!(
                env::predecessor_account_id() == self.trader_id,
                ERR_NOT_TRADER
            );
            self.settle(
                Settlement::Close,
                nonce,
                root,
                round,
                refund,
                bad_debt,
                proof,
            );
        }

        /// Keeper liquidation of an unhealthy position; credits the bounty to
        /// the submitting keeper.
        pub fn liquidate(
            &mut self,
            nonce: u32,
            root: Base64VecU8,
            round: u64,
            refund: u64,
            bad_debt: u64,
            proof: Base64VecU8,
        ) {
            let keeper_index = self
                .keeper_index(&env::predecessor_account_id())
                .unwrap_or_else(|| env::panic_str(ERR_NOT_KEEPER));
            self.settle(
                Settlement::Liquidation { keeper_index },
                nonce,
                root,
                round,
                refund,
                bad_debt,
                proof,
            );
        }

        // -----------------------------------------------------------------
        // Claims.
        // -----------------------------------------------------------------

        #[payable]
        pub fn withdraw(&mut self, amount: U128) -> Promise {
            require!(
                env::attached_deposit() == NearToken::from_yoctonear(1),
                ERR_ONE_YOCTO
            );
            let account_id = env::predecessor_account_id();
            let claimant = self
                .claimant_index(&account_id)
                .unwrap_or_else(|| env::panic_str(ERR_NOT_CLAIMANT));
            require!(amount.0 > 0, ERR_ZERO_AMOUNT);
            let cents =
                u64::try_from(amount.0).unwrap_or_else(|_| env::panic_str(ERR_AMOUNT_RANGE));
            require!(self.in_flight[claimant].is_none(), ERR_WITHDRAW_IN_FLIGHT);
            require!(
                env::prepaid_gas() >= GAS_WITHDRAW_MIN_PREPAID,
                ERR_PREPAID_GAS
            );
            // The maker may only draw unreserved vault funds, so every active
            // reservation stays covered while the transfer is in flight.
            let withdrawable = if claimant == MAKER_CLAIMANT {
                self.ledger.maker_free()
            } else {
                *self.available_mut(claimant)
            };
            require!(withdrawable >= cents, ERR_INSUFFICIENT_BALANCE);
            let bucket = self.available_mut(claimant);
            *bucket = sub(*bucket, cents);
            self.ledger.pending_withdrawals = add(self.ledger.pending_withdrawals, cents);
            self.in_flight[claimant] = Some(cents);

            ext_ft::ext(self.token_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .with_unused_gas_weight(0)
                .ft_transfer(account_id.clone(), amount, None)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_RESOLVE_WITHDRAW)
                        .with_unused_gas_weight(0)
                        .resolve_withdraw(account_id),
                )
        }

        /// Clears the in-flight claim on success, or restores it exactly once
        /// on failure. Returns whether the transfer succeeded.
        #[private]
        pub fn resolve_withdraw(&mut self, account_id: AccountId) -> bool {
            require!(env::promise_results_count() == 1, ERR_NO_PROMISE_RESULT);
            let claimant = self
                .claimant_index(&account_id)
                .unwrap_or_else(|| env::panic_str(ERR_NOT_CLAIMANT));
            let cents = self.in_flight[claimant]
                .take()
                .unwrap_or_else(|| env::panic_str(ERR_NO_IN_FLIGHT));
            self.ledger.pending_withdrawals = sub(self.ledger.pending_withdrawals, cents);
            let ok = match env::promise_result_checked(0, MAX_FT_RESULT_LEN) {
                Ok(_) | Err(PromiseError::TooLong(_)) => true,
                Err(_) => false,
            };
            if !ok {
                let available = self.available_mut(claimant);
                *available = add(*available, cents);
            }
            emit(
                "withdrawal_resolved",
                json!({ "cents": cents, "account_id": account_id, "success": ok }),
            );
            ok
        }

        // -----------------------------------------------------------------
        // Views.
        // -----------------------------------------------------------------

        pub fn get_market(&self) -> Base64VecU8 {
            self.market.to_vec().into()
        }

        pub fn get_pending(&self) -> Option<SlotView> {
            self.pending.as_ref().map(|p| SlotView::from(&p.slot))
        }

        pub fn get_active(&self) -> Option<SlotView> {
            self.active.as_ref().map(SlotView::from)
        }

        pub fn get_quote(&self) -> Option<QuoteView> {
            let p = self.pending.as_ref()?;
            Some(QuoteView {
                nonce: p.slot.nonce,
                commitment: p.slot.commitment.to_vec().into(),
                quote_terms: p.slot.quote_terms.to_vec().into(),
                open_price_ticks: p.slot.open_price_ticks,
                expires_at: p.quote_expires_at?,
            })
        }

        pub fn get_oracle(&self) -> Option<OracleRound> {
            self.oracle
        }

        pub fn get_ledger(&self) -> Ledger {
            self.ledger.clone()
        }

        pub fn get_config(&self) -> ConfigView {
            ConfigView {
                token_id: self.token_id.clone(),
                trader_id: self.trader_id.clone(),
                maker_id: self.maker_id.clone(),
                oracle_id: self.oracle_id.clone(),
                keepers: self
                    .keepers
                    .iter()
                    .map(|k| KeeperInput {
                        account_id: k.account_id.clone(),
                        ack_key: k.ack_key.to_vec().into(),
                    })
                    .collect(),
                deployment_id: self.deployment_id.to_vec().into(),
                key_version: KEY_VERSION,
                open_vk_sha256: env::sha256(&self.open_vk).into(),
                liquidation_vk_sha256: env::sha256(&self.liquidation_vk).into(),
                close_vk_sha256: env::sha256(&self.close_vk).into(),
            }
        }
    }

    impl Contract {
        /// Shared atomic settlement for `close` and `liquidate`. The caller
        /// has already authorized the mode. Every check runs before any
        /// effect, and the slot is cleared in the same receipt that pays out,
        /// so a second settlement of the same slot fails with `ERR_NO_ACTIVE`.
        #[allow(clippy::too_many_arguments)]
        fn settle(
            &mut self,
            mode: Settlement,
            nonce: u32,
            root: Base64VecU8,
            round: u64,
            refund: u64,
            bad_debt: u64,
            proof: Base64VecU8,
        ) {
            let root = hash32(&root.0, ERR_COMMITMENT_LEN);
            let active = self
                .active
                .as_ref()
                .unwrap_or_else(|| env::panic_str(ERR_NO_ACTIVE));
            require!(
                active.nonce == nonce && active.commitment == root,
                ERR_ACTIVE_MISMATCH
            );
            let oracle = self.fresh_oracle(current_height());
            require!(oracle.round == round, ERR_ROUND_MISMATCH);
            // Nondecreasing and capped by `publish_oracle`: 0..=200.
            let funding_delta = oracle
                .funding_cents
                .checked_sub(active.funding_checkpoint)
                .unwrap_or_else(|| env::panic_str(ERR_FUNDING_RANGE));
            require!(funding_delta <= MAX_FUNDING_DELTA_CENTS, ERR_FUNDING_RANGE);

            // Reserve coverage: refund plus bounty is paid from escrow and the
            // maker reservation, and the vault must still cover its remaining
            // reservations afterwards.
            let bounty = mode.bounty();
            let (max_refund, vk) = match mode {
                Settlement::Close => (MAX_CLOSE_REFUND, &self.close_vk),
                Settlement::Liquidation { .. } => (MAX_REFUND, &self.liquidation_vk),
            };
            require!(refund <= max_refund, ERR_REFUND_RANGE);
            let l = &self.ledger;
            require!(
                l.trader_locked >= ESCROW && l.maker_reserved >= RESERVE,
                ERR_RESERVE_COVERAGE
            );
            let payout = add(refund, bounty);
            let vault_after = add(l.maker_vault, ESCROW)
                .checked_sub(payout)
                .unwrap_or_else(|| env::panic_str(ERR_RESERVE_COVERAGE));
            let reserved_after = sub(l.maker_reserved, RESERVE);
            require!(vault_after >= reserved_after, ERR_RESERVE_COVERAGE);

            let context = active.context(&self.market, &self.trader_id);
            let inputs = liquidation_inputs(
                &root,
                &context,
                oracle.round,
                oracle.price_ticks.into(),
                funding_delta.into(),
                refund,
                bad_debt,
            );
            require!(verify_proof(vk, &proof.0, &inputs), ERR_PROOF_INVALID);

            // Effects: all checks passed.
            let mut ledger = self.ledger.clone();
            ledger.trader_locked = sub(ledger.trader_locked, ESCROW);
            ledger.trader_available = add(ledger.trader_available, refund);
            if let Settlement::Liquidation { keeper_index } = mode {
                ledger.keeper_available[keeper_index] =
                    add(ledger.keeper_available[keeper_index], bounty);
            }
            ledger.maker_vault = vault_after;
            ledger.maker_reserved = reserved_after;
            ledger.bad_debt = add(ledger.bad_debt, bad_debt);
            if bad_debt > 0 {
                ledger.halted = true;
            }
            self.active = None;
            self.ledger = ledger;
            match mode {
                Settlement::Close => emit(
                    "position_closed",
                    json!({
                        "nonce": nonce,
                        "round": round,
                        "refund": refund,
                        "bad_debt": bad_debt,
                    }),
                ),
                Settlement::Liquidation { keeper_index } => emit(
                    "position_liquidated",
                    json!({
                        "nonce": nonce,
                        "round": round,
                        "refund": refund,
                        "bad_debt": bad_debt,
                        "keeper_index": keeper_index,
                    }),
                ),
            }
        }

        fn fresh_oracle(&self, now: u32) -> OracleRound {
            let oracle = self.oracle.unwrap_or_else(|| env::panic_str(ERR_NO_ORACLE));
            let age = now.saturating_sub(oracle.height);
            require!(age <= ORACLE_FRESHNESS_BLOCKS, ERR_ORACLE_STALE);
            oracle
        }

        fn keeper_index(&self, account_id: &AccountId) -> Option<usize> {
            self.keepers
                .iter()
                .position(|k| &k.account_id == account_id)
        }

        fn claimant_index(&self, account_id: &AccountId) -> Option<usize> {
            if account_id == &self.trader_id {
                Some(0)
            } else if account_id == &self.maker_id {
                Some(MAKER_CLAIMANT)
            } else {
                self.keeper_index(account_id).map(|i| i + 1)
            }
        }

        /// Bucket debited by a claimant's withdrawal and restored on failure.
        /// For the maker this is the vault; callers check free funds first.
        fn available_mut(&mut self, claimant: usize) -> &mut u64 {
            match claimant {
                0 => &mut self.ledger.trader_available,
                MAKER_CLAIMANT => &mut self.ledger.maker_vault,
                i => &mut self.ledger.keeper_available[i - 1],
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use ed25519_dalek::{Signer, SigningKey};
        use near_sdk::borsh;
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};
        use std::cell::RefCell;
        use std::panic::{AssertUnwindSafe, catch_unwind};

        type Accepted = (Vec<u8>, Vec<u8>, Vec<[u8; 32]>);

        thread_local! {
            static ACCEPT: RefCell<Vec<Accepted>> = const { RefCell::new(Vec::new()) };
        }

        /// Test stand-in for Groth16: accepts only exact (vk, proof, inputs)
        /// triples registered by the test.
        pub(super) fn proof_hook_accepts(vk: &[u8], proof: &[u8], inputs: &[[u8; 32]]) -> bool {
            ACCEPT.with(|a| {
                a.borrow()
                    .iter()
                    .any(|(v, p, i)| v == vk && p == proof && i == inputs)
            })
        }

        fn accept(vk: &[u8], proof: &[u8], inputs: impl Into<Vec<[u8; 32]>>) {
            ACCEPT.with(|a| {
                a.borrow_mut()
                    .push((vk.to_vec(), proof.to_vec(), inputs.into()))
            });
        }

        fn clear_accepted() {
            ACCEPT.with(|a| a.borrow_mut().clear());
        }

        fn acc(s: &str) -> AccountId {
            s.parse().unwrap()
        }
        fn contract_id() -> AccountId {
            acc("perps.test.near")
        }
        fn token() -> AccountId {
            acc("musdc.test.near")
        }
        fn trader() -> AccountId {
            acc("trader.test.near")
        }
        fn maker() -> AccountId {
            acc("maker.test.near")
        }
        fn oracle() -> AccountId {
            acc("oracle.test.near")
        }
        fn keeper(i: usize) -> AccountId {
            acc(["keeper-a.test.near", "keeper-b.test.near"][i])
        }

        const DEPLOYMENT: [u8; 32] = [9; 32];
        const COMMIT: [u8; 32] = [0xC0; 32];
        const COMMIT2: [u8; 32] = [0xC1; 32];
        const QUOTE: [u8; 32] = [0xD0; 32];
        const QUOTE2: [u8; 32] = [0xD1; 32];
        const OPEN_PROOF: &[u8] = b"open-proof";
        const LIQ_PROOF: &[u8] = b"liquidation-proof";
        const CLOSE_PROOF: &[u8] = b"close-proof";

        /// Valid structural key; `seed` varies the IC points so close and
        /// liquidation keys differ.
        fn fixture_vk(n_inputs: usize, seed: u8) -> Vec<u8> {
            let g1 = env::bls12381_map_fp_to_g1([0; 48]).unwrap();
            let mut fp = [0u8; 48];
            fp[47] = seed;
            let ic = env::bls12381_map_fp_to_g1(fp).unwrap();
            let g2 = env::bls12381_map_fp2_to_g2([0; 96]).unwrap();
            [g1, g2.repeat(3), ic.repeat(n_inputs + 1)].concat()
        }

        fn open_vk() -> Vec<u8> {
            fixture_vk(verifier::OPEN_INPUTS, 0)
        }
        fn liq_vk() -> Vec<u8> {
            fixture_vk(verifier::LIQUIDATION_INPUTS, 0)
        }
        fn close_vk() -> Vec<u8> {
            fixture_vk(verifier::LIQUIDATION_INPUTS, 1)
        }

        fn keys() -> [SigningKey; 2] {
            [
                SigningKey::from_bytes(&[11; 32]),
                SigningKey::from_bytes(&[22; 32]),
            ]
        }
        fn ciphertexts() -> Vec<Vec<u8>> {
            vec![vec![0xA1; CIPHERTEXT_LEN], vec![0xB2; CIPHERTEXT_LEN]]
        }

        fn ctx_full(pred: AccountId, height: u64, deposit: u128, results: Vec<PromiseResult>) {
            let mut b = VMContextBuilder::new();
            b.current_account_id(contract_id())
                .signer_account_id(pred.clone())
                .predecessor_account_id(pred)
                .block_height(height)
                .attached_deposit(NearToken::from_yoctonear(deposit));
            testing_env!(
                b.build(),
                test_vm_config(),
                RuntimeFeesConfig::test(),
                Default::default(),
                results
            );
        }
        fn ctx(pred: AccountId, height: u64) {
            ctx_full(pred, height, 0, vec![]);
        }

        fn keeper_inputs() -> Vec<KeeperInput> {
            keys()
                .iter()
                .enumerate()
                .map(|(i, k)| KeeperInput {
                    account_id: keeper(i),
                    ack_key: k.verifying_key().to_bytes().to_vec().into(),
                })
                .collect()
        }

        fn init_full(
            keepers: Vec<KeeperInput>,
            trader_id: AccountId,
            vks: [Vec<u8>; 3],
        ) -> Contract {
            clear_accepted();
            ctx(contract_id(), 100);
            let [open, liq, close] = vks;
            Contract::init(
                token(),
                trader_id,
                maker(),
                oracle(),
                keepers,
                DEPLOYMENT.to_vec().into(),
                open.into(),
                liq.into(),
                close.into(),
            )
        }

        fn init_with(keepers: Vec<KeeperInput>, trader_id: AccountId) -> Contract {
            init_full(keepers, trader_id, [open_vk(), liq_vk(), close_vk()])
        }

        fn setup() -> Contract {
            init_with(keeper_inputs(), trader())
        }

        fn deposit(c: &mut Contract, sender: AccountId, msg: &str, amount: u128) -> u128 {
            ctx(token(), 100);
            match c.ft_on_transfer(sender, U128(amount), msg.to_string()) {
                PromiseOrValue::Value(v) => v.0,
                PromiseOrValue::Promise(_) => panic!("unexpected promise"),
            }
        }

        fn publish(c: &mut Contract, round: u64, price: u32, funding: u32, height: u64) {
            ctx(oracle(), height);
            c.publish_oracle(round, price, funding);
        }

        fn b64(v: &[u8]) -> Base64VecU8 {
            v.to_vec().into()
        }

        fn b64s(v: Vec<Vec<u8>>) -> Vec<Base64VecU8> {
            v.into_iter().map(Into::into).collect()
        }

        fn acks(
            c: &Contract,
            nonce: u32,
            commitment: &[u8; 32],
            cts: &[Vec<u8>],
        ) -> Vec<Base64VecU8> {
            keys()
                .iter()
                .enumerate()
                .map(|(i, k)| {
                    let m = ack_message(&c.market, nonce, commitment, &cts[i], i as u8);
                    k.sign(&m).to_bytes().to_vec().into()
                })
                .collect()
        }

        fn stage(c: &mut Contract, nonce: u32, commit: &[u8; 32], quote: &[u8; 32], h: u64) {
            ctx(trader(), h);
            c.stage_position(nonce, b64(commit), b64(quote), b64s(ciphertexts()));
        }

        fn approve(c: &mut Contract, nonce: u32, commit: &[u8; 32], quote: &[u8; 32], h: u64) {
            ctx(maker(), h);
            let mark = c.pending.as_ref().unwrap().slot.open_price_ticks;
            c.approve_quote(nonce, b64(commit), b64(quote), mark, 500);
        }

        fn stage_and_approve(c: &mut Contract, nonce: u32) {
            stage(c, nonce, &COMMIT, &QUOTE, 110);
            approve(c, nonce, &COMMIT, &QUOTE, 111);
        }

        /// Registers the open proof for the pending slot's exact statement.
        fn accept_open(c: &Contract) {
            let slot = &c.pending.as_ref().unwrap().slot;
            let context = slot.context(&c.market, &trader());
            accept(
                &open_vk(),
                OPEN_PROOF,
                open_inputs(
                    &slot.commitment,
                    &context,
                    &slot.quote_terms,
                    slot.open_price_ticks,
                ),
            );
        }

        /// Funded, oracle round 1 at $100,000 and index zero, staged and
        /// approved, open proof registered.
        fn ready_to_open() -> Contract {
            let mut c = setup();
            assert_eq!(deposit(&mut c, trader(), "trader", 60_000), 0);
            assert_eq!(deposit(&mut c, maker(), "maker", 100_000), 0);
            publish(&mut c, 1, 10_000, 0, 105);
            stage_and_approve(&mut c, 1);
            accept_open(&c);
            c
        }

        fn open_as(c: &mut Contract, nonce: u32, commit: &[u8; 32], height: u64) {
            ctx(trader(), height);
            let a = acks(c, nonce, commit, &ciphertexts());
            c.open(nonce, b64(commit), a, b64(OPEN_PROOF));
        }

        fn do_open(c: &mut Contract, height: u64) {
            open_as(c, 1, &COMMIT, height);
        }

        fn opened() -> Contract {
            let mut c = ready_to_open();
            do_open(&mut c, 120);
            c
        }

        /// Settlement statement for the active slot with an explicit
        /// funding delta.
        fn settle_inputs(
            c: &Contract,
            round: u64,
            price: u32,
            delta: u32,
            refund: u64,
            debt: u64,
        ) -> [[u8; 32]; verifier::LIQUIDATION_INPUTS] {
            let slot = c.active.as_ref().unwrap();
            let context = slot.context(&c.market, &trader());
            liquidation_inputs(
                &slot.commitment,
                &context,
                round,
                price.into(),
                delta.into(),
                refund,
                debt,
            )
        }

        fn accept_liq(c: &Contract, round: u64, price: u32, delta: u32, refund: u64, debt: u64) {
            let i = settle_inputs(c, round, price, delta, refund, debt);
            accept(&liq_vk(), LIQ_PROOF, i);
        }

        fn accept_close(c: &Contract, round: u64, price: u32, delta: u32, refund: u64, debt: u64) {
            let i = settle_inputs(c, round, price, delta, refund, debt);
            accept(&close_vk(), CLOSE_PROOF, i);
        }

        #[allow(clippy::too_many_arguments)]
        fn liquidate_n(
            c: &mut Contract,
            who: AccountId,
            nonce: u32,
            commit: &[u8; 32],
            height: u64,
            round: u64,
            refund: u64,
            debt: u64,
        ) {
            ctx(who, height);
            c.liquidate(nonce, b64(commit), round, refund, debt, b64(LIQ_PROOF));
        }

        fn liquidate_as(
            c: &mut Contract,
            who: AccountId,
            height: u64,
            round: u64,
            refund: u64,
            debt: u64,
        ) {
            liquidate_n(c, who, 1, &COMMIT, height, round, refund, debt);
        }

        #[allow(clippy::too_many_arguments)]
        fn close_n(
            c: &mut Contract,
            nonce: u32,
            commit: &[u8; 32],
            height: u64,
            round: u64,
            refund: u64,
            debt: u64,
        ) {
            ctx(trader(), height);
            c.close(nonce, b64(commit), round, refund, debt, b64(CLOSE_PROOF));
        }

        fn panic_message(e: Box<dyn std::any::Any + Send>) -> String {
            if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "<non-string panic>".into()
            }
        }

        /// Runs `f`, requires a panic containing `err`, and requires the full
        /// contract state to be byte-identical afterwards.
        fn assert_rejects(c: &mut Contract, err: &str, f: impl FnOnce(&mut Contract)) {
            let before = borsh::to_vec(c).unwrap();
            let r = catch_unwind(AssertUnwindSafe(|| f(c)));
            let msg = panic_message(r.expect_err("call unexpectedly succeeded"));
            assert!(msg.contains(err), "expected {err}, got {msg}");
            assert_eq!(borsh::to_vec(c).unwrap(), before, "state changed on {err}");
        }

        fn snapshot(c: &Contract) -> Contract {
            borsh::from_slice(&borsh::to_vec(c).unwrap()).unwrap()
        }

        /// Reference model from the spec, used to cross-check fixtures.
        /// Returns `(liquidatable, refund, bad_debt)` for the given bounty.
        fn reference(
            lots: i64,
            entry: i64,
            margin: i64,
            price: i64,
            funding: i64,
            bounty: i64,
        ) -> (bool, i64, i64) {
            let pnl = (price - entry) * lots;
            let equity = margin - funding + pnl;
            let liquidatable = 20 * equity < price * lots;
            let capped = margin - funding + pnl.min(60_000);
            let refund = 60_000 - margin + (capped - bounty).max(0);
            let bad_debt = (-equity).max(0);
            (liquidatable, refund, bad_debt)
        }

        /// Spec admission checks: risk limit and health at the opening mark.
        fn admissible(lots: i64, entry: i64, margin: i64, mark: i64) -> bool {
            entry * lots <= 3 * margin && 20 * (margin + (mark - entry) * lots) >= mark * lots
        }

        // ------------------------------------------------------------------

        #[test]
        fn reference_fixture_values() {
            let b = BOUNTY as i64;
            assert!(!reference(10, 10_000, 50_000, 7_000, 200, b).0);
            assert_eq!(
                reference(10, 10_000, 50_000, 5_200, 200, b),
                (true, 11_700, 0)
            );
            assert_eq!(
                reference(10, 10_000, 50_000, 5_200, 200, 0),
                (true, 11_800, 0)
            );
            assert_eq!(
                reference(10, 10_000, 50_000, 1_000, 200, b),
                (true, 10_000, 40_200)
            );
            // Acceptance close: $798 refund at a $120,000 mark with $2 funding.
            assert_eq!(
                reference(10, 10_000, 50_000, 12_000, 200, 0),
                (false, 79_800, 0)
            );
            // 20 * equity == price * lots is healthy; one tick lower is not.
            assert!(!reference(1, 57, 19, 40, 0, b).0);
            assert!(reference(1, 57, 19, 39, 0, b).0);
            // Largest refunds equal the coverage bounds.
            assert_eq!(reference(50, 1, 60_000, 20_000, 0, b).1 as u64, MAX_REFUND);
            assert_eq!(
                reference(50, 1, 60_000, 20_000, 0, 0).1 as u64,
                MAX_CLOSE_REFUND
            );
            // Admission: the fixture is admissible; a mark far below entry is not.
            assert!(admissible(10, 10_000, 50_000, 10_000));
            assert!(!admissible(10, 10_000, 50_000, 5_200));
            assert!(!admissible(10, 15_001, 50_000, 15_001));
        }

        #[test]
        fn encodings() {
            let c = setup();
            let mut m = b"xythum:BTC-USDC:v2:".to_vec();
            m.extend_from_slice(&DEPLOYMENT);
            m.extend_from_slice(b"perps.test.near");
            assert_eq!(c.market, env::sha256_array(&m));
            assert_eq!(c.get_market().0, c.market.to_vec());

            let mut x = b"xythum:position:v2:".to_vec();
            x.extend_from_slice(&c.market);
            x.extend_from_slice(&[7, 0, 0, 0]);
            x.extend_from_slice(&[0x2C, 0x01, 0, 0]);
            x.extend_from_slice(b"trader.test.near");
            let context = position_context(&c.market, 7, 300, &trader());
            assert_eq!(context, env::sha256_array(&x));
            assert_ne!(context, position_context(&c.market, 7, 301, &trader()));

            let mut q = b"xythum:quote:v2:".to_vec();
            q.extend_from_slice(&context);
            q.extend_from_slice(&[3; 32]);
            q.extend_from_slice(&[10, 0]);
            q.extend_from_slice(&[0x10, 0x27]);
            assert_eq!(
                quote_terms_digest(&context, &[3; 32], 10, 10_000),
                env::sha256_array(&q)
            );

            let msg = ack_message(&c.market, 7, &COMMIT, b"ct", 1);
            assert_eq!(msg.len(), 21 + 32 + 4 + 32 + 32 + 1 + 4);
            assert_eq!(&msg[..21], b"xythum:keeper-ack:v2:");
            assert_eq!(&msg[53..57], &[7, 0, 0, 0]);
            assert_eq!(&msg[89..121], &env::sha256_array(b"ct"));
            assert_eq!(msg[121], 1);
            assert_eq!(&msg[122..], &[1, 0, 0, 0]);

            let mut d = [0u8; 32];
            for (i, b) in d.iter_mut().enumerate() {
                *b = i as u8;
            }
            let [lo, hi] = verifier::digest_scalars(&d);
            assert_eq!(&lo[..16], &d[..16]);
            assert_eq!(&hi[..16], &d[16..]);
            assert!(lo[16..].iter().chain(&hi[16..]).all(|b| *b == 0));
            assert_eq!(verifier::u64_scalar(0x0102)[..3], [2, 1, 0]);

            let oi = open_inputs(&d, &context, &QUOTE, 10_000);
            assert_eq!(oi.len(), verifier::OPEN_INPUTS);
            assert_eq!(oi.len(), 7);
            assert_eq!(oi[..2], verifier::digest_scalars(&d));
            assert_eq!(oi[2..4], verifier::digest_scalars(&context));
            assert_eq!(oi[4..6], verifier::digest_scalars(&QUOTE));
            assert_eq!(oi[6], verifier::u64_scalar(10_000));

            let li = liquidation_inputs(&d, &context, 3, 5_200, 200, 11_700, 0);
            assert_eq!(li.len(), 9);
            assert_eq!(li[..4], oi[..4]);
            assert_eq!(li[4], verifier::u64_scalar(3));
            assert_eq!(li[5], verifier::u64_scalar(5_200));
            assert_eq!(li[6], verifier::u64_scalar(200));
            assert_eq!(li[7], verifier::u64_scalar(11_700));
            assert_eq!(li[8], verifier::u64_scalar(0));
        }

        #[test]
        #[should_panic(expected = "ERR_ROLES_NOT_DISTINCT")]
        fn init_rejects_shared_role() {
            init_with(keeper_inputs(), maker());
        }

        #[test]
        #[should_panic(expected = "ERR_ROLES_NOT_DISTINCT")]
        fn init_rejects_keeper_as_trader() {
            init_with(keeper_inputs(), keeper(1));
        }

        #[test]
        #[should_panic(expected = "ERR_KEYS_NOT_DISTINCT")]
        fn init_rejects_shared_key() {
            let mut k = keeper_inputs();
            k[1].ack_key = k[0].ack_key.clone();
            init_with(k, trader());
        }

        #[test]
        #[should_panic(expected = "ERR_KEEPER_COUNT")]
        fn init_rejects_keeper_count() {
            let mut k = keeper_inputs();
            k.pop();
            init_with(k, trader());
        }

        #[test]
        #[should_panic(expected = "ERR_ACK_KEY_LEN")]
        fn init_rejects_key_len() {
            let mut k = keeper_inputs();
            k[0].ack_key = vec![1; 31].into();
            init_with(k, trader());
        }

        #[test]
        #[should_panic(expected = "ERR_OPEN_VK_LEN")]
        fn init_rejects_vk_len() {
            let mut vk = open_vk();
            vk.push(0);
            init_full(keeper_inputs(), trader(), [vk, liq_vk(), close_vk()]);
        }

        #[test]
        #[should_panic(expected = "ERR_LIQUIDATION_VK_LEN")]
        fn init_rejects_liquidation_vk_len() {
            init_full(
                keeper_inputs(),
                trader(),
                [open_vk(), open_vk(), close_vk()],
            );
        }

        #[test]
        #[should_panic(expected = "ERR_CLOSE_VK_LEN")]
        fn init_rejects_close_vk_len() {
            init_full(keeper_inputs(), trader(), [open_vk(), liq_vk(), open_vk()]);
        }

        #[test]
        #[should_panic(expected = "ERR_VKS_NOT_DISTINCT")]
        fn init_rejects_shared_settlement_vk() {
            init_full(keeper_inputs(), trader(), [open_vk(), liq_vk(), liq_vk()]);
        }

        #[test]
        #[should_panic(expected = "ERR_INVALID_VK")]
        fn init_rejects_invalid_close_vk() {
            let bad = vec![0u8; verifier::LIQUIDATION_VK_LEN];
            init_full(keeper_inputs(), trader(), [open_vk(), liq_vk(), bad]);
        }

        #[test]
        fn init_state_and_config() {
            let c = setup();
            let l = c.get_ledger();
            assert_eq!(l.next_nonce, 1);
            assert_eq!(l.total_holdings(), Some(0));
            assert!(c.get_pending().is_none() && c.get_active().is_none());
            assert!(c.get_oracle().is_none());
            let cfg = c.get_config();
            assert_eq!(cfg.keepers[1].account_id, keeper(1));
            assert_eq!(cfg.open_vk_sha256.0, env::sha256(open_vk()));
            assert_eq!(cfg.liquidation_vk_sha256.0, env::sha256(liq_vk()));
            assert_eq!(cfg.close_vk_sha256.0, env::sha256(close_vk()));
            assert_eq!(cfg.key_version, 1);
        }

        #[test]
        fn deposits() {
            let mut c = setup();
            assert_eq!(deposit(&mut c, trader(), "trader", 70_000), 0);
            assert_eq!(deposit(&mut c, maker(), "maker", 80_000), 0);
            // Wrong msg, swapped role, unknown sender, keeper: full refund.
            assert_eq!(deposit(&mut c, trader(), "maker", 5), 5);
            assert_eq!(deposit(&mut c, maker(), "trader", 6), 6);
            assert_eq!(deposit(&mut c, acc("x.test.near"), "trader", 7), 7);
            assert_eq!(deposit(&mut c, keeper(0), "keeper", 8), 8);
            assert_eq!(deposit(&mut c, trader(), "", 9), 9);
            // Out of u64, and total holdings overflow: full refund.
            let big = u128::from(u64::MAX) + 1;
            assert_eq!(deposit(&mut c, trader(), "trader", big), big);
            let near_max = u128::from(u64::MAX - 100_000);
            assert_eq!(deposit(&mut c, maker(), "maker", near_max), near_max);
            let l = c.get_ledger();
            assert_eq!((l.trader_available, l.maker_vault), (70_000, 80_000));

            ctx(trader(), 1);
            assert_rejects(&mut c, ERR_WRONG_TOKEN, |c| {
                let _ = c.ft_on_transfer(trader(), U128(1), "trader".into());
            });
        }

        #[test]
        fn oracle_rules() {
            let mut c = setup();
            ctx(trader(), 1);
            assert_rejects(&mut c, ERR_NOT_ORACLE, |c| c.publish_oracle(1, 1, 0));
            ctx(oracle(), 1);
            assert_rejects(&mut c, ERR_ROUND_ZERO, |c| c.publish_oracle(0, 1, 0));
            assert_rejects(&mut c, ERR_PRICE_RANGE, |c| c.publish_oracle(1, 0, 0));
            assert_rejects(&mut c, ERR_PRICE_RANGE, |c| c.publish_oracle(1, 20_001, 0));
            // With no active slot the cumulative index is unbounded.
            publish(&mut c, 5, 20_000, 100_000, 42);
            assert_eq!(
                c.get_oracle(),
                Some(OracleRound {
                    round: 5,
                    price_ticks: 20_000,
                    funding_cents: 100_000,
                    height: 42
                })
            );
            ctx(oracle(), 43);
            assert_rejects(&mut c, ERR_ROUND_NOT_INCREASING, |c| {
                c.publish_oracle(5, 1, 100_000)
            });
            assert_rejects(&mut c, ERR_ROUND_NOT_INCREASING, |c| {
                c.publish_oracle(4, 1, 100_000)
            });
            assert_rejects(&mut c, ERR_FUNDING_DECREASED, |c| {
                c.publish_oracle(6, 1, 99_999)
            });
            publish(&mut c, 6, 1, u32::MAX, 43);
            ctx(oracle(), u64::from(u32::MAX) + 1);
            assert_rejects(&mut c, ERR_HEIGHT_RANGE, |c| {
                c.publish_oracle(7, 1, u32::MAX)
            });
        }

        #[test]
        fn oracle_funding_capped_by_active_checkpoint() {
            // Pending (not active) items do not cap the index.
            let mut c = setup();
            deposit(&mut c, trader(), "trader", 60_000);
            deposit(&mut c, maker(), "maker", 100_000);
            publish(&mut c, 1, 10_000, 1_000, 105);
            stage_and_approve(&mut c, 1);
            accept_open(&c);
            publish(&mut c, 2, 10_000, 1_201, 106);
            assert_eq!(c.get_pending().unwrap().funding_checkpoint, 1_000);

            // Restage at the new index, then open with checkpoint 1201.
            stage(&mut c, 1, &COMMIT, &QUOTE, 110);
            approve(&mut c, 1, &COMMIT, &QUOTE, 111);
            accept_open(&c);
            do_open(&mut c, 120);
            assert_eq!(c.get_active().unwrap().funding_checkpoint, 1_201);

            ctx(oracle(), 130);
            assert_rejects(&mut c, ERR_FUNDING_RANGE, |c| {
                c.publish_oracle(3, 10_000, 1_402)
            });
            publish(&mut c, 3, 10_000, 1_401, 130);

            // Settlement uses the delta (200), not the cumulative index.
            accept_close(&c, 3, 10_000, 200, 59_800, 0);
            close_n(&mut c, 1, &COMMIT, 131, 3, 59_800, 0);
            assert!(c.get_active().is_none());
            // Once empty, the cap lifts.
            publish(&mut c, 4, 10_000, 5_000, 132);
        }

        #[test]
        fn staging_and_quotes() {
            let mut c = setup();
            let commit = || b64(&COMMIT);
            let quote = || b64(&QUOTE);
            ctx(maker(), 110);
            assert_rejects(&mut c, ERR_NOT_TRADER, |c| {
                c.stage_position(1, commit(), quote(), b64s(ciphertexts()))
            });
            ctx(trader(), 110);
            assert_rejects(&mut c, ERR_BAD_NONCE, |c| {
                c.stage_position(2, commit(), quote(), b64s(ciphertexts()))
            });
            assert_rejects(&mut c, ERR_COMMITMENT_LEN, |c| {
                c.stage_position(1, vec![0; 31].into(), quote(), b64s(ciphertexts()))
            });
            assert_rejects(&mut c, ERR_QUOTE_TERMS_LEN, |c| {
                c.stage_position(1, commit(), vec![0; 33].into(), b64s(ciphertexts()))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_COUNT, |c| {
                c.stage_position(1, commit(), quote(), b64s(vec![vec![1]]))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_COUNT, |c| {
                c.stage_position(1, commit(), quote(), b64s(vec![vec![1], vec![2], vec![3]]))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_LEN, |c| {
                c.stage_position(1, commit(), quote(), b64s(vec![vec![1], vec![]]))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_LEN, |c| {
                c.stage_position(
                    1,
                    commit(),
                    quote(),
                    b64s(vec![vec![1; CIPHERTEXT_LEN + 1], vec![2; CIPHERTEXT_LEN]]),
                )
            });
            // Staging fixes a fresh oracle round.
            assert_rejects(&mut c, ERR_NO_ORACLE, |c| {
                c.stage_position(1, commit(), quote(), b64s(ciphertexts()))
            });
            publish(&mut c, 1, 10_000, 40, 105);
            ctx(trader(), 1_106);
            assert_rejects(&mut c, ERR_ORACLE_STALE, |c| {
                c.stage_position(1, commit(), quote(), b64s(ciphertexts()))
            });
            ctx(maker(), 110);
            assert_rejects(&mut c, ERR_NO_PENDING, |c| {
                c.approve_quote(1, commit(), quote(), 10_000, 500)
            });

            ctx(trader(), 110);
            c.stage_position(1, commit(), quote(), b64s(ciphertexts()));
            let p = c.get_pending().unwrap();
            assert_eq!((p.nonce, p.commitment.0.clone()), (1, COMMIT.to_vec()));
            assert_eq!(p.quote_terms.0, QUOTE.to_vec());
            assert_eq!((p.open_price_ticks, p.funding_checkpoint), (10_000, 40));
            assert_eq!(p.ciphertexts[0].0.len(), CIPHERTEXT_LEN);

            ctx(trader(), 110);
            assert_rejects(&mut c, ERR_NOT_MAKER, |c| {
                c.approve_quote(1, commit(), quote(), 10_000, 500)
            });
            ctx(maker(), 110);
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.approve_quote(2, commit(), quote(), 10_000, 500)
            });
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.approve_quote(1, vec![1; 32].into(), quote(), 10_000, 500)
            });
            // Tampered quote terms digest.
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.approve_quote(1, commit(), b64(&QUOTE2), 10_000, 500)
            });
            assert_rejects(&mut c, ERR_QUOTE_TERMS_LEN, |c| {
                c.approve_quote(1, commit(), vec![0; 31].into(), 10_000, 500)
            });
            assert_rejects(&mut c, ERR_EXPIRY_NOT_FUTURE, |c| {
                c.approve_quote(1, commit(), quote(), 10_000, 110)
            });
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.approve_quote(1, commit(), quote(), 9_999, 500)
            });
            c.approve_quote(1, commit(), quote(), 10_000, 111);
            let q = c.get_quote().unwrap();
            assert_eq!((q.nonce, q.expires_at), (1, 111));
            assert_eq!(q.quote_terms.0, QUOTE.to_vec());

            // Restaging clears approval and refixes the opening.
            publish(&mut c, 2, 12_000, 90, 112);
            stage(&mut c, 1, &[5; 32], &QUOTE2, 113);
            assert!(c.get_quote().is_none());
            let p = c.get_pending().unwrap();
            assert_eq!(p.commitment.0, vec![5; 32]);
            assert_eq!(p.quote_terms.0, QUOTE2.to_vec());
            assert_eq!((p.open_price_ticks, p.funding_checkpoint), (12_000, 90));
        }

        #[test]
        fn open_success() {
            let c = opened();
            let l = c.get_ledger();
            assert_eq!(
                l,
                Ledger {
                    trader_available: 0,
                    trader_locked: 60_000,
                    maker_vault: 100_000,
                    maker_reserved: 60_100,
                    keeper_available: [0, 0],
                    pending_withdrawals: 0,
                    bad_debt: 0,
                    halted: false,
                    next_nonce: 2,
                }
            );
            assert!(c.get_pending().is_none() && c.get_quote().is_none());
            let a = c.get_active().unwrap();
            assert_eq!(a.nonce, 1);
            assert_eq!(a.commitment.0, COMMIT.to_vec());
            assert_eq!(a.quote_terms.0, QUOTE.to_vec());
            assert_eq!((a.open_price_ticks, a.funding_checkpoint), (10_000, 0));
            assert_eq!(
                a.ciphertexts
                    .iter()
                    .map(|x| x.0.clone())
                    .collect::<Vec<_>>(),
                ciphertexts()
            );
        }

        #[test]
        fn open_rejections_leave_state_unchanged() {
            let mut c = ready_to_open();
            let commit = || b64(&COMMIT);
            let good = acks(&c, 1, &COMMIT, &ciphertexts());
            let proof = || b64(OPEN_PROOF);

            ctx(maker(), 120);
            assert_rejects(&mut c, ERR_NOT_TRADER, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            ctx(trader(), 120);
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.open(2, commit(), good.clone(), proof())
            });
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.open(1, vec![1; 32].into(), good.clone(), proof())
            });
            // Swapped keeper order.
            let swapped = vec![good[1].clone(), good[0].clone()];
            assert_rejects(&mut c, ERR_ACK_INVALID, |c| {
                c.open(1, commit(), swapped, proof())
            });
            // Keeper signed a different ciphertext.
            let wrong_ct = acks(&c, 1, &COMMIT, &[vec![0xA1; 119], ciphertexts()[1].clone()]);
            assert_rejects(&mut c, ERR_ACK_INVALID, |c| {
                c.open(1, commit(), wrong_ct, proof())
            });
            // Keeper signed a different commitment.
            let wrong_commit = acks(&c, 1, &[1; 32], &ciphertexts());
            assert_rejects(&mut c, ERR_ACK_INVALID, |c| {
                c.open(1, commit(), wrong_commit, proof())
            });
            assert_rejects(&mut c, ERR_ACK_COUNT, |c| {
                c.open(1, commit(), vec![good[0].clone()], proof())
            });
            assert_rejects(&mut c, ERR_ACK_LEN, |c| {
                c.open(
                    1,
                    commit(),
                    vec![vec![0; 63].into(), good[1].clone()],
                    proof(),
                )
            });
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.open(1, commit(), good.clone(), b64(b"mutated"))
            });
            // Quote expiry is inclusive: 500 opens, 501 does not.
            ctx(trader(), 501);
            assert_rejects(&mut c, ERR_QUOTE_EXPIRED, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            let mut at_expiry = snapshot(&c);
            ctx(trader(), 500);
            at_expiry.open(1, commit(), good.clone(), proof());
            assert!(at_expiry.get_active().is_some());

            // Freshness: 1000 blocks inclusive (oracle at 105).
            let mut stale = ready_to_open();
            ctx(maker(), 111);
            stale.approve_quote(1, commit(), b64(&QUOTE), 10_000, 5_000);
            ctx(trader(), 1_106);
            assert_rejects(&mut stale, ERR_ORACLE_STALE, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            ctx(trader(), 1_105);
            stale.open(1, commit(), good.clone(), proof());
            assert!(stale.get_active().is_some());

            // A later round must keep both the staged price and index.
            let mut moved = snapshot(&c);
            publish(&mut moved, 2, 10_010, 0, 130);
            ctx(trader(), 131);
            assert_rejects(&mut moved, ERR_OPENING_CHANGED, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            let mut funded = snapshot(&c);
            publish(&mut funded, 2, 10_000, 1, 130);
            ctx(trader(), 131);
            assert_rejects(&mut funded, ERR_OPENING_CHANGED, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            publish(&mut c, 2, 10_000, 0, 130);
            ctx(trader(), 131);
            c.open(1, commit(), good.clone(), proof());
            assert!(c.get_active().is_some());
        }

        #[test]
        fn open_proof_binds_quote_terms_and_mark() {
            let commit = || b64(&COMMIT);
            let proof = || b64(OPEN_PROOF);
            // Proof was made for different quote terms than the slot holds,
            // or for a different opening mark (e.g. one where it is healthy).
            for (quote, mark) in [(QUOTE2, 10_000), (QUOTE, 10_010)] {
                let mut c = setup();
                deposit(&mut c, trader(), "trader", 60_000);
                deposit(&mut c, maker(), "maker", 100_000);
                publish(&mut c, 1, 10_000, 0, 105);
                stage_and_approve(&mut c, 1);
                let slot = &c.pending.as_ref().unwrap().slot;
                let context = slot.context(&c.market, &trader());
                accept(
                    &open_vk(),
                    OPEN_PROOF,
                    open_inputs(&COMMIT, &context, &quote, mark),
                );
                // Same statement under a settlement key is not an open proof.
                accept(
                    &liq_vk(),
                    OPEN_PROOF,
                    open_inputs(&COMMIT, &context, &QUOTE, 10_000),
                );
                let good = acks(&c, 1, &COMMIT, &ciphertexts());
                ctx(trader(), 120);
                assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                    c.open(1, commit(), good.clone(), proof())
                });
            }
        }

        #[test]
        fn open_requires_funds_and_quote() {
            let commit = || b64(&COMMIT);
            let proof = || b64(OPEN_PROOF);

            let mut c = setup();
            deposit(&mut c, trader(), "trader", 59_999);
            deposit(&mut c, maker(), "maker", 60_100);
            publish(&mut c, 1, 10_000, 0, 105);
            stage_and_approve(&mut c, 1);
            accept_open(&c);
            let good = acks(&c, 1, &COMMIT, &ciphertexts());
            ctx(trader(), 120);
            assert_rejects(&mut c, ERR_INSUFFICIENT_ESCROW, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            deposit(&mut c, trader(), "trader", 1);

            let mut c2 = setup();
            deposit(&mut c2, trader(), "trader", 60_000);
            deposit(&mut c2, maker(), "maker", 60_099);
            publish(&mut c2, 1, 10_000, 0, 105);
            stage_and_approve(&mut c2, 1);
            ctx(trader(), 120);
            assert_rejects(&mut c2, ERR_INSUFFICIENT_RESERVE, |c| {
                c.open(1, commit(), good.clone(), proof())
            });

            // Unapproved (re-staged) item cannot open.
            stage(&mut c, 1, &COMMIT, &QUOTE, 115);
            ctx(trader(), 120);
            assert_rejects(&mut c, ERR_NO_QUOTE, |c| {
                c.open(1, commit(), good.clone(), proof())
            });

            let mut c3 = setup();
            ctx(trader(), 120);
            assert_rejects(&mut c3, ERR_NO_PENDING, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
        }

        #[test]
        fn slot_occupied_after_open() {
            let mut c = opened();
            ctx(trader(), 130);
            assert_rejects(&mut c, ERR_SLOT_OCCUPIED, |c| {
                c.stage_position(2, b64(&COMMIT), b64(&QUOTE), b64s(ciphertexts()))
            });
        }

        #[test]
        fn liquidation_fixture_keeper_b() {
            let mut c = opened();
            let before = c.get_ledger().total_holdings();
            publish(&mut c, 2, 7_000, 200, 200);
            publish(&mut c, 3, 5_200, 200, 201);
            accept_liq(&c, 3, 5_200, 200, 11_700, 0);
            liquidate_as(&mut c, keeper(1), 1_201, 3, 11_700, 0);
            let l = c.get_ledger();
            assert_eq!(
                l,
                Ledger {
                    trader_available: 11_700,
                    trader_locked: 0,
                    maker_vault: 148_200,
                    maker_reserved: 0,
                    keeper_available: [0, 100],
                    pending_withdrawals: 0,
                    bad_debt: 0,
                    halted: false,
                    next_nonce: 2,
                }
            );
            assert_eq!(l.total_holdings(), before);
            assert!(c.get_active().is_none());

            // Replay fails and leaves state unchanged.
            ctx(keeper(1), 1_201);
            assert_rejects(&mut c, ERR_NO_ACTIVE, |c| {
                c.liquidate(1, b64(&COMMIT), 3, 11_700, 0, b64(LIQ_PROOF))
            });
            // Cleared nonce is never reused; next position uses nonce 2.
            ctx(trader(), 1_201);
            assert_rejects(&mut c, ERR_BAD_NONCE, |c| {
                c.stage_position(1, b64(&COMMIT), b64(&QUOTE), b64s(ciphertexts()))
            });
            c.stage_position(2, b64(&COMMIT), b64(&QUOTE), b64s(ciphertexts()));
        }

        #[test]
        fn liquidation_rejections_leave_state_unchanged() {
            let mut c = opened();
            publish(&mut c, 2, 5_200, 200, 200);
            publish(&mut c, 3, 5_200, 200, 201);
            accept_liq(&c, 3, 5_200, 200, 11_700, 0);
            let root = || b64(&COMMIT);
            let proof = || b64(LIQ_PROOF);

            ctx(trader(), 300);
            assert_rejects(&mut c, ERR_NOT_KEEPER, |c| {
                c.liquidate(1, root(), 3, 11_700, 0, proof())
            });
            ctx(keeper(0), 300);
            assert_rejects(&mut c, ERR_ACTIVE_MISMATCH, |c| {
                c.liquidate(2, root(), 3, 11_700, 0, proof())
            });
            assert_rejects(&mut c, ERR_ACTIVE_MISMATCH, |c| {
                c.liquidate(1, vec![0; 32].into(), 3, 11_700, 0, proof())
            });
            assert_rejects(&mut c, ERR_COMMITMENT_LEN, |c| {
                c.liquidate(1, vec![0; 33].into(), 3, 11_700, 0, proof())
            });
            // Stale round with identical values.
            assert_rejects(&mut c, ERR_ROUND_MISMATCH, |c| {
                c.liquidate(1, root(), 2, 11_700, 0, proof())
            });
            // Tampered refund / debt, mutated proof.
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.liquidate(1, root(), 3, 11_701, 0, proof())
            });
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.liquidate(1, root(), 3, 11_700, 1, proof())
            });
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.liquidate(1, root(), 3, 11_700, 0, b64(b"mutated"))
            });
            // A close proof for the same statement is not a liquidation proof.
            accept_close(&c, 3, 5_200, 200, 11_700, 0);
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.liquidate(1, root(), 3, 11_700, 0, b64(CLOSE_PROOF))
            });
            assert_rejects(&mut c, ERR_REFUND_RANGE, |c| {
                c.liquidate(1, root(), 3, MAX_REFUND + 1, 0, proof())
            });
            // Oracle freshness, inclusive at 1000 blocks (round 3 at 201).
            ctx(keeper(0), 1_202);
            assert_rejects(&mut c, ERR_ORACLE_STALE, |c| {
                c.liquidate(1, root(), 3, 11_700, 0, proof())
            });
            ctx(keeper(0), 1_201);
            c.liquidate(1, root(), 3, 11_700, 0, proof());
            assert_eq!(c.get_ledger().keeper_available, [100, 0]);
        }

        #[test]
        fn liquidation_price_gap_halts() {
            let mut c = opened();
            publish(&mut c, 2, 1_000, 200, 200);
            accept_liq(&c, 2, 1_000, 200, 10_000, 40_200);
            liquidate_as(&mut c, keeper(0), 210, 2, 10_000, 40_200);
            let l = c.get_ledger();
            assert_eq!(l.trader_available, 10_000);
            assert_eq!(l.maker_vault, 149_900);
            assert_eq!(l.maker_reserved, 0);
            assert_eq!(l.keeper_available, [100, 0]);
            assert_eq!(l.bad_debt, 40_200);
            assert!(l.halted);
            assert_eq!(l.total_holdings(), Some(160_000));
            ctx(trader(), 211);
            assert_rejects(&mut c, ERR_HALTED, |c| {
                c.stage_position(2, b64(&COMMIT), b64(&QUOTE), b64s(ciphertexts()))
            });
        }

        #[test]
        fn liquidation_max_refund_is_covered() {
            let mut c = opened();
            publish(&mut c, 2, 20_000, 0, 200);
            accept_liq(&c, 2, 20_000, 0, MAX_REFUND, 0);
            liquidate_as(&mut c, keeper(0), 210, 2, MAX_REFUND, 0);
            let l = c.get_ledger();
            assert_eq!(l.maker_vault, 100_000 + 60_000 - MAX_REFUND - BOUNTY);
            assert_eq!(l.total_holdings(), Some(160_000));
        }

        #[test]
        fn close_rejections_leave_state_unchanged() {
            let mut c = opened();
            publish(&mut c, 2, 12_000, 200, 200);
            accept_close(&c, 2, 12_000, 200, 79_800, 0);
            let root = || b64(&COMMIT);
            let proof = || b64(CLOSE_PROOF);

            for who in [keeper(0), keeper(1), maker(), oracle()] {
                ctx(who, 201);
                assert_rejects(&mut c, ERR_NOT_TRADER, |c| {
                    c.close(1, root(), 2, 79_800, 0, proof())
                });
            }
            ctx(trader(), 201);
            assert_rejects(&mut c, ERR_ACTIVE_MISMATCH, |c| {
                c.close(2, root(), 2, 79_800, 0, proof())
            });
            assert_rejects(&mut c, ERR_ACTIVE_MISMATCH, |c| {
                c.close(1, b64(&COMMIT2), 2, 79_800, 0, proof())
            });
            assert_rejects(&mut c, ERR_ROUND_MISMATCH, |c| {
                c.close(1, root(), 1, 79_800, 0, proof())
            });
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.close(1, root(), 2, 79_801, 0, proof())
            });
            assert_rejects(&mut c, ERR_REFUND_RANGE, |c| {
                c.close(1, root(), 2, MAX_CLOSE_REFUND + 1, 0, proof())
            });
            // A liquidation proof for the same statement is not a close proof.
            accept_liq(&c, 2, 12_000, 200, 79_800, 0);
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.close(1, root(), 2, 79_800, 0, b64(LIQ_PROOF))
            });
            // The proof statement uses the delta, not the cumulative index.
            let slot = c.active.as_ref().unwrap();
            let context = slot.context(&c.market, &trader());
            clear_accepted();
            accept(
                &close_vk(),
                CLOSE_PROOF,
                liquidation_inputs(&COMMIT, &context, 2, 12_000, 400, 79_800, 0),
            );
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.close(1, root(), 2, 79_800, 0, proof())
            });
            ctx(trader(), 1_201);
            accept_close(&c, 2, 12_000, 200, 79_800, 0);
            assert_rejects(&mut c, ERR_ORACLE_STALE, |c| {
                c.close(1, root(), 2, 79_800, 0, proof())
            });
        }

        #[test]
        fn close_max_refund_is_covered_and_debt_halts() {
            let mut c = opened();
            publish(&mut c, 2, 20_000, 0, 200);
            accept_close(&c, 2, 20_000, 0, MAX_CLOSE_REFUND, 0);
            close_n(&mut c, 1, &COMMIT, 201, 2, MAX_CLOSE_REFUND, 0);
            let l = c.get_ledger();
            assert_eq!(l.maker_vault, 100_000 + 60_000 - MAX_CLOSE_REFUND);
            assert_eq!(l.keeper_available, [0, 0]);
            assert_eq!(l.total_holdings(), Some(160_000));

            let mut d = opened();
            publish(&mut d, 2, 1_000, 200, 200);
            accept_close(&d, 2, 1_000, 200, 10_000, 40_200);
            close_n(&mut d, 1, &COMMIT, 201, 2, 10_000, 40_200);
            let l = d.get_ledger();
            assert_eq!((l.bad_debt, l.halted), (40_200, true));
            assert_eq!(l.maker_vault, 150_000);
            ctx(maker(), 202);
            assert_rejects(&mut d, ERR_HALTED, |c| {
                c.approve_quote(2, b64(&COMMIT), b64(&QUOTE), 10_000, 500)
            });
            ctx(trader(), 202);
            assert_rejects(&mut d, ERR_HALTED, |c| {
                c.stage_position(2, b64(&COMMIT), b64(&QUOTE), b64s(ciphertexts()))
            });
        }

        /// Acceptance flow: profitable close, profit withdrawal, reopen at
        /// the new checkpoint, then a close/liquidation race on one round.
        #[test]
        fn funded_acceptance_flow_and_settlement_race() {
            let mut c = opened();
            let total = c.get_ledger().total_holdings().unwrap();
            assert_eq!(total, 160_000);

            // $120,000 mark with $2 funding: close refunds $798.
            publish(&mut c, 2, 12_000, 200, 200);
            accept_close(&c, 2, 12_000, 200, 79_800, 0);
            close_n(&mut c, 1, &COMMIT, 201, 2, 79_800, 0);
            let l = c.get_ledger();
            assert_eq!(
                (
                    l.trader_available,
                    l.trader_locked,
                    l.maker_vault,
                    l.maker_reserved
                ),
                (79_800, 0, 80_200, 0)
            );
            assert_eq!(100_000 - l.maker_vault, 19_800);
            assert_eq!(l.total_holdings(), Some(total));
            assert!(c.get_active().is_none());

            // Withdraw the $198 profit, keeping $600 to reopen.
            ctx_full(trader(), 202, 1, vec![]);
            let _ = c.withdraw(U128(19_800));
            ctx_full(
                contract_id(),
                203,
                0,
                vec![PromiseResult::Successful(vec![])],
            );
            assert!(c.resolve_withdraw(trader()));
            assert_eq!(c.get_ledger().trader_available, 60_000);

            // Reopen at the new funding checkpoint (200).
            publish(&mut c, 3, 10_000, 200, 300);
            stage(&mut c, 2, &COMMIT2, &QUOTE2, 301);
            approve(&mut c, 2, &COMMIT2, &QUOTE2, 302);
            accept_open(&c);
            open_as(&mut c, 2, &COMMIT2, 303);
            let a = c.get_active().unwrap();
            assert_eq!(
                (a.nonce, a.funding_checkpoint, a.open_price_ticks),
                (2, 200, 10_000)
            );

            // $70,000 with another $2 funding: healthy, no liquidation proof.
            publish(&mut c, 4, 7_000, 400, 400);
            assert!(!reference(10, 10_000, 50_000, 7_000, 200, 100).0);
            ctx(keeper(1), 401);
            assert_rejects(&mut c, ERR_PROOF_INVALID, |c| {
                c.liquidate(2, b64(&COMMIT2), 4, 12_700, 0, b64(LIQ_PROOF))
            });

            // $52,000: both a close and a liquidation proof are valid.
            publish(&mut c, 5, 5_200, 400, 500);
            accept_liq(&c, 5, 5_200, 200, 11_700, 0);
            accept_close(&c, 5, 5_200, 200, 11_800, 0);
            let base = c.get_ledger();

            // Liquidation wins; the close then fails and moves nothing.
            let mut liq_first = snapshot(&c);
            liquidate_n(&mut liq_first, keeper(1), 2, &COMMIT2, 501, 5, 11_700, 0);
            ctx(trader(), 501);
            assert_rejects(&mut liq_first, ERR_NO_ACTIVE, |c| {
                c.close(2, b64(&COMMIT2), 5, 11_800, 0, b64(CLOSE_PROOF))
            });
            let l1 = liq_first.get_ledger();
            assert_eq!(l1.trader_available, 11_700);
            assert_eq!(l1.keeper_available, [0, 100]);
            assert_eq!(l1.maker_vault - base.maker_vault, 48_200);

            // Close wins; the liquidation then fails and moves nothing.
            let mut close_first = snapshot(&c);
            close_n(&mut close_first, 2, &COMMIT2, 501, 5, 11_800, 0);
            ctx(keeper(1), 501);
            assert_rejects(&mut close_first, ERR_NO_ACTIVE, |c| {
                c.liquidate(2, b64(&COMMIT2), 5, 11_700, 0, b64(LIQ_PROOF))
            });
            let l2 = close_first.get_ledger();
            assert_eq!(l2.trader_available, 11_800);
            assert_eq!(l2.keeper_available, [0, 0]);

            // Maker accounting is identical either way.
            assert_eq!(
                (l1.maker_vault, l1.maker_reserved),
                (l2.maker_vault, l2.maker_reserved)
            );
            assert_eq!(l1.total_holdings(), l2.total_holdings());
            assert_eq!(l1.total_holdings(), Some(total - 19_800));
        }

        fn liquidated() -> Contract {
            let mut c = opened();
            publish(&mut c, 2, 5_200, 200, 200);
            accept_liq(&c, 2, 5_200, 200, 11_700, 0);
            liquidate_as(&mut c, keeper(1), 210, 2, 11_700, 0);
            c
        }

        #[test]
        fn withdraw_rules() {
            let mut c = liquidated();
            let set = |who: AccountId, deposit: u128| ctx_full(who, 300, deposit, vec![]);

            set(trader(), 0);
            assert_rejects(&mut c, ERR_ONE_YOCTO, |c| {
                let _ = c.withdraw(U128(1));
            });
            set(trader(), 2);
            assert_rejects(&mut c, ERR_ONE_YOCTO, |c| {
                let _ = c.withdraw(U128(1));
            });
            for who in [oracle(), token(), acc("x.test.near")] {
                set(who, 1);
                assert_rejects(&mut c, ERR_NOT_CLAIMANT, |c| {
                    let _ = c.withdraw(U128(1));
                });
            }
            set(trader(), 1);
            assert_rejects(&mut c, ERR_ZERO_AMOUNT, |c| {
                let _ = c.withdraw(U128(0));
            });
            assert_rejects(&mut c, ERR_AMOUNT_RANGE, |c| {
                let _ = c.withdraw(U128(u128::from(u64::MAX) + 1));
            });
            assert_rejects(&mut c, ERR_INSUFFICIENT_BALANCE, |c| {
                let _ = c.withdraw(U128(11_701));
            });
            set(keeper(0), 1);
            assert_rejects(&mut c, ERR_INSUFFICIENT_BALANCE, |c| {
                let _ = c.withdraw(U128(1));
            });
            set(maker(), 1);
            assert_rejects(&mut c, ERR_INSUFFICIENT_BALANCE, |c| {
                let _ = c.withdraw(U128(148_201));
            });

            let mut b = VMContextBuilder::new();
            b.current_account_id(contract_id())
                .predecessor_account_id(trader())
                .attached_deposit(NearToken::from_yoctonear(1))
                .prepaid_gas(Gas::from_tgas(39));
            testing_env!(b.build());
            assert_rejects(&mut c, ERR_PREPAID_GAS, |c| {
                let _ = c.withdraw(U128(1));
            });
        }

        #[test]
        fn withdraw_success_and_restore_exactly_once() {
            let mut c = liquidated();
            let total = c.get_ledger().total_holdings();

            ctx_full(trader(), 300, 1, vec![]);
            let _ = c.withdraw(U128(11_000));
            let l = c.get_ledger();
            assert_eq!((l.trader_available, l.pending_withdrawals), (700, 11_000));
            assert_eq!(l.total_holdings(), total);
            assert_rejects(&mut c, ERR_WITHDRAW_IN_FLIGHT, |c| {
                let _ = c.withdraw(U128(1));
            });

            // Keeper B claims concurrently with the trader.
            ctx_full(keeper(1), 300, 1, vec![]);
            let _ = c.withdraw(U128(100));
            assert_eq!(c.get_ledger().pending_withdrawals, 11_100);

            // The callback requires a promise result.
            ctx_full(contract_id(), 301, 0, vec![]);
            assert_rejects(&mut c, ERR_NO_PROMISE_RESULT, |c| {
                c.resolve_withdraw(trader());
            });

            // Failed transfer restores the trader claim once.
            ctx_full(contract_id(), 301, 0, vec![PromiseResult::Failed]);
            assert!(!c.resolve_withdraw(trader()));
            let l = c.get_ledger();
            assert_eq!((l.trader_available, l.pending_withdrawals), (11_700, 100));
            assert_rejects(&mut c, ERR_NO_IN_FLIGHT, |c| {
                c.resolve_withdraw(trader());
            });

            // Successful transfer clears keeper B's claim.
            ctx_full(
                contract_id(),
                302,
                0,
                vec![PromiseResult::Successful(vec![])],
            );
            assert!(c.resolve_withdraw(keeper(1)));
            let l = c.get_ledger();
            assert_eq!((l.keeper_available[1], l.pending_withdrawals), (0, 0));
            assert_eq!(l.total_holdings(), total.map(|t| t - 100));
            assert_rejects(&mut c, ERR_NO_IN_FLIGHT, |c| {
                c.resolve_withdraw(keeper(1));
            });

            // A new claim is allowed after resolution.
            ctx_full(trader(), 303, 1, vec![]);
            let _ = c.withdraw(U128(11_700));
            assert_eq!(c.get_ledger().trader_available, 0);
        }

        #[test]
        fn maker_withdraws_only_free_collateral() {
            let mut c = opened();
            let total = c.get_ledger().total_holdings();
            // Vault 100,000 with 60,100 reserved: 39,900 free.
            ctx_full(maker(), 130, 1, vec![]);
            assert_rejects(&mut c, ERR_INSUFFICIENT_BALANCE, |c| {
                let _ = c.withdraw(U128(39_901));
            });
            let _ = c.withdraw(U128(39_900));
            let l = c.get_ledger();
            assert_eq!(
                (l.maker_vault, l.maker_reserved, l.pending_withdrawals),
                (60_100, 60_100, 39_900)
            );
            assert_eq!(l.total_holdings(), total);
            // One in-flight withdrawal per claimant.
            assert_rejects(&mut c, ERR_WITHDRAW_IN_FLIGHT, |c| {
                let _ = c.withdraw(U128(1));
            });

            // Failed transfer restores the vault exactly once.
            ctx_full(contract_id(), 131, 0, vec![PromiseResult::Failed]);
            assert!(!c.resolve_withdraw(maker()));
            let l = c.get_ledger();
            assert_eq!((l.maker_vault, l.pending_withdrawals), (100_000, 0));
            assert_rejects(&mut c, ERR_NO_IN_FLIGHT, |c| {
                c.resolve_withdraw(maker());
            });

            // With all free funds in flight, the reservation still covers
            // the largest liquidation payout.
            ctx_full(maker(), 132, 1, vec![]);
            let _ = c.withdraw(U128(39_900));
            publish(&mut c, 2, 20_000, 0, 200);
            accept_liq(&c, 2, 20_000, 0, MAX_REFUND, 0);
            liquidate_as(&mut c, keeper(0), 201, 2, MAX_REFUND, 0);
            let l = c.get_ledger();
            assert_eq!((l.maker_vault, l.maker_reserved), (100, 0));
            ctx_full(
                contract_id(),
                202,
                0,
                vec![PromiseResult::Successful(vec![])],
            );
            assert!(c.resolve_withdraw(maker()));
            let l = c.get_ledger();
            assert_eq!((l.maker_vault, l.pending_withdrawals), (100, 0));
            assert_eq!(l.total_holdings(), total.map(|t| t - 39_900));

            // The remaining free vault is withdrawable once empty.
            ctx_full(maker(), 203, 1, vec![]);
            let _ = c.withdraw(U128(100));
            assert_eq!(c.get_ledger().maker_vault, 0);
        }
    }
}
