//! Xythum native NEAR Sandbox prototype.
//!
//! Default build: the single-slot confidential BTC/mock-USDC clearing contract
//! described in `docs/SPEC.md`. With `--features mock-token` the crate instead
//! builds a sandbox-only mock NEP-141 token and the clearing contract is not
//! compiled.

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
    // Fixed v1 market parameters (cents / ticks / lots).
    // ---------------------------------------------------------------------

    /// Escrow locked from trader available funds per open.
    pub const ESCROW: u64 = 60_000;
    /// Maker vault reservation per open (escrow-sized PnL cap plus bounty).
    pub const RESERVE: u64 = 60_100;
    /// Constant liquidation bounty credited to the submitting keeper.
    pub const BOUNTY: u64 = 100;
    /// Largest refund the settlement formula can produce:
    /// `60000 - margin + (margin + 60000 - 100)`.
    pub const MAX_REFUND: u64 = ESCROW + ESCROW - BOUNTY;
    pub const MAX_PRICE_TICKS: u32 = 20_000;
    pub const MAX_FUNDING_CENTS: u32 = 200;
    /// Oracle freshness window in blocks, inclusive.
    pub const ORACLE_FRESHNESS_BLOCKS: u32 = 1_000;
    const CIPHERTEXT_LEN: usize = 144;
    pub const KEEPER_COUNT: usize = 2;
    pub const KEY_VERSION: u32 = 1;

    pub const MARKET_PREFIX: &[u8] = b"xythum:BTC-USDC:v1:";
    pub const POSITION_PREFIX: &[u8] = b"xythum:position:v1:";
    pub const ACK_PREFIX: &[u8] = b"xythum:keeper-ack:v1:";

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
        pub const ERR_INVALID_VK: &str = "ERR_INVALID_VK";
        pub const ERR_ROUND_ZERO: &str = "ERR_ROUND_ZERO";
        pub const ERR_ROUND_NOT_INCREASING: &str = "ERR_ROUND_NOT_INCREASING";
        pub const ERR_PRICE_RANGE: &str = "ERR_PRICE_RANGE";
        pub const ERR_FUNDING_RANGE: &str = "ERR_FUNDING_RANGE";
        pub const ERR_FUNDING_DECREASED: &str = "ERR_FUNDING_DECREASED";
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
        pub const ERR_FUNDING_NONZERO: &str = "ERR_FUNDING_NONZERO";
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

    /// `SHA256("xythum:BTC-USDC:v1:" || deployment_id || contract_account_utf8)`.
    pub fn market_hash(deployment_id: &[u8; 32], contract_id: &AccountId) -> [u8; 32] {
        let mut data = Vec::with_capacity(MARKET_PREFIX.len() + 32 + contract_id.len());
        data.extend_from_slice(MARKET_PREFIX);
        data.extend_from_slice(deployment_id);
        data.extend_from_slice(contract_id.as_bytes());
        env::sha256_array(&data)
    }

    /// `SHA256("xythum:position:v1:" || market || nonce_u32_le || trader_account_utf8)`.
    pub fn position_context(market: &[u8; 32], nonce: u32, trader_id: &AccountId) -> [u8; 32] {
        let mut data = Vec::with_capacity(POSITION_PREFIX.len() + 36 + trader_id.len());
        data.extend_from_slice(POSITION_PREFIX);
        data.extend_from_slice(market);
        data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(trader_id.as_bytes());
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
        pub ciphertexts: Vec<Vec<u8>>,
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
        pub ciphertexts: Vec<Base64VecU8>,
    }

    impl From<&Slot> for SlotView {
        fn from(s: &Slot) -> Self {
            Self {
                nonce: s.nonce,
                commitment: s.commitment.to_vec().into(),
                ciphertexts: s.ciphertexts.iter().map(|c| c.clone().into()).collect(),
            }
        }
    }

    #[near(serializers = [json])]
    pub struct QuoteView {
        pub nonce: u32,
        pub commitment: Base64VecU8,
        pub expires_at: u32,
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
    }

    /// Claimant index: 0 trader, 1 keeper A, 2 keeper B.
    const CLAIMANTS: usize = 1 + KEEPER_COUNT;

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

            require!(
                verifier::validate_vk(&open_vk.0, verifier::OPEN_INPUTS)
                    && verifier::validate_vk(&liquidation_vk.0, verifier::LIQUIDATION_INPUTS),
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
            require!(funding_cents <= MAX_FUNDING_CENTS, ERR_FUNDING_RANGE);
            if let Some(prev) = &self.oracle {
                require!(round > prev.round, ERR_ROUND_NOT_INCREASING);
                require!(funding_cents >= prev.funding_cents, ERR_FUNDING_DECREASED);
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

        pub fn stage_position(
            &mut self,
            nonce: u32,
            commitment: Base64VecU8,
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
            require!(ciphertexts.len() == KEEPER_COUNT, ERR_CIPHERTEXT_COUNT);
            for c in &ciphertexts {
                require!(c.0.len() == CIPHERTEXT_LEN, ERR_CIPHERTEXT_LEN);
            }
            // Replacing an existing pending item drops its maker approval.
            self.pending = Some(Pending {
                slot: Slot {
                    nonce,
                    commitment,
                    ciphertexts: ciphertexts.into_iter().map(|c| c.0).collect(),
                },
                quote_expires_at: None,
            });
        }

        pub fn approve_quote(&mut self, nonce: u32, commitment: Base64VecU8, expires_at: u32) {
            require!(
                env::predecessor_account_id() == self.maker_id,
                ERR_NOT_MAKER
            );
            require!(!self.ledger.halted, ERR_HALTED);
            let commitment = hash32(&commitment.0, ERR_COMMITMENT_LEN);
            require!(expires_at > current_height(), ERR_EXPIRY_NOT_FUTURE);
            let pending = self
                .pending
                .as_mut()
                .unwrap_or_else(|| env::panic_str(ERR_NO_PENDING));
            require!(
                pending.slot.nonce == nonce && pending.slot.commitment == commitment,
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
            require!(now < expires_at, ERR_QUOTE_EXPIRED);

            let oracle = self.fresh_oracle(now);
            require!(oracle.funding_cents == 0, ERR_FUNDING_NONZERO);

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

            let context = position_context(&self.market, nonce, &self.trader_id);
            let inputs = open_inputs(&commitment, &context);
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
        // Liquidation.
        // -----------------------------------------------------------------

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

            // Reserve coverage: refund plus bounty is paid from escrow and the
            // maker reservation, and the vault must still cover its remaining
            // reservations afterwards.
            require!(refund <= MAX_REFUND, ERR_REFUND_RANGE);
            let l = &self.ledger;
            require!(
                l.trader_locked >= ESCROW && l.maker_reserved >= RESERVE,
                ERR_RESERVE_COVERAGE
            );
            let payout = add(refund, BOUNTY);
            let vault_after = add(l.maker_vault, ESCROW)
                .checked_sub(payout)
                .unwrap_or_else(|| env::panic_str(ERR_RESERVE_COVERAGE));
            let reserved_after = sub(l.maker_reserved, RESERVE);
            require!(vault_after >= reserved_after, ERR_RESERVE_COVERAGE);

            let context = position_context(&self.market, nonce, &self.trader_id);
            let inputs = liquidation_inputs(
                &root,
                &context,
                oracle.round,
                oracle.price_ticks.into(),
                oracle.funding_cents.into(),
                refund,
                bad_debt,
            );
            require!(
                verify_proof(&self.liquidation_vk, &proof.0, &inputs),
                ERR_PROOF_INVALID
            );

            // Effects: all checks passed.
            let mut ledger = self.ledger.clone();
            ledger.trader_locked = sub(ledger.trader_locked, ESCROW);
            ledger.trader_available = add(ledger.trader_available, refund);
            ledger.keeper_available[keeper_index] =
                add(ledger.keeper_available[keeper_index], BOUNTY);
            ledger.maker_vault = vault_after;
            ledger.maker_reserved = reserved_after;
            ledger.bad_debt = add(ledger.bad_debt, bad_debt);
            if bad_debt > 0 {
                ledger.halted = true;
            }
            self.active = None;
            self.ledger = ledger;
            emit(
                "position_liquidated",
                json!({
                    "nonce": nonce,
                    "round": round,
                    "refund": refund,
                    "bad_debt": bad_debt,
                    "keeper_index": keeper_index,
                }),
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
            let available = self.available_mut(claimant);
            require!(*available >= cents, ERR_INSUFFICIENT_BALANCE);
            *available -= cents;
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
            }
        }
    }

    impl Contract {
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
            } else {
                self.keeper_index(account_id).map(|i| i + 1)
            }
        }

        fn available_mut(&mut self, claimant: usize) -> &mut u64 {
            match claimant {
                0 => &mut self.ledger.trader_available,
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
            static ACCEPT: RefCell<Option<Accepted>> = const { RefCell::new(None) };
        }

        /// Test stand-in for Groth16: accepts only the exact (vk, proof,
        /// inputs) triple registered by the test.
        pub(super) fn proof_hook_accepts(vk: &[u8], proof: &[u8], inputs: &[[u8; 32]]) -> bool {
            ACCEPT.with(|a| {
                a.borrow()
                    .as_ref()
                    .is_some_and(|(v, p, i)| v == vk && p == proof && i == inputs)
            })
        }

        fn accept(vk: &[u8], proof: &[u8], inputs: impl Into<Vec<[u8; 32]>>) {
            ACCEPT.with(|a| *a.borrow_mut() = Some((vk.to_vec(), proof.to_vec(), inputs.into())));
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
        const OPEN_PROOF: &[u8] = b"open-proof";
        const LIQ_PROOF: &[u8] = b"liquidation-proof";

        fn fixture_vk(n_inputs: usize) -> Vec<u8> {
            let g1 = env::bls12381_map_fp_to_g1([0; 48]).unwrap();
            let g2 = env::bls12381_map_fp2_to_g2([0; 96]).unwrap();
            [g1.clone(), g2.repeat(3), g1.repeat(n_inputs + 1)].concat()
        }

        fn open_vk() -> Vec<u8> {
            fixture_vk(verifier::OPEN_INPUTS)
        }
        fn liq_vk() -> Vec<u8> {
            fixture_vk(verifier::LIQUIDATION_INPUTS)
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

        fn init_with(keepers: Vec<KeeperInput>, trader_id: AccountId) -> Contract {
            ctx(contract_id(), 100);
            Contract::init(
                token(),
                trader_id,
                maker(),
                oracle(),
                keepers,
                DEPLOYMENT.to_vec().into(),
                open_vk().into(),
                liq_vk().into(),
            )
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

        fn stage_and_approve(c: &mut Contract, nonce: u32) {
            ctx(trader(), 110);
            c.stage_position(nonce, COMMIT.to_vec().into(), b64s(ciphertexts()));
            ctx(maker(), 111);
            c.approve_quote(nonce, COMMIT.to_vec().into(), 500);
        }

        fn accept_open(c: &Contract, nonce: u32) {
            let context = position_context(&c.market, nonce, &trader());
            accept(&open_vk(), OPEN_PROOF, open_inputs(&COMMIT, &context));
        }

        /// Funded, oracle round 1 at funding zero, staged and approved, open
        /// proof registered. Returns ready-to-open contract.
        fn ready_to_open() -> Contract {
            let mut c = setup();
            assert_eq!(deposit(&mut c, trader(), "trader", 60_000), 0);
            assert_eq!(deposit(&mut c, maker(), "maker", 100_000), 0);
            publish(&mut c, 1, 10_000, 0, 105);
            stage_and_approve(&mut c, 1);
            accept_open(&c, 1);
            c
        }

        fn do_open(c: &mut Contract, height: u64) {
            ctx(trader(), height);
            let a = acks(c, 1, &COMMIT, &ciphertexts());
            c.open(1, COMMIT.to_vec().into(), a, OPEN_PROOF.to_vec().into());
        }

        fn opened() -> Contract {
            let mut c = ready_to_open();
            do_open(&mut c, 120);
            c
        }

        fn accept_liq(c: &Contract, round: u64, price: u32, funding: u32, refund: u64, debt: u64) {
            let context = position_context(&c.market, 1, &trader());
            accept(
                &liq_vk(),
                LIQ_PROOF,
                liquidation_inputs(
                    &COMMIT,
                    &context,
                    round,
                    price.into(),
                    funding.into(),
                    refund,
                    debt,
                ),
            );
        }

        fn liquidate_as(
            c: &mut Contract,
            who: AccountId,
            height: u64,
            round: u64,
            refund: u64,
            debt: u64,
        ) {
            ctx(who, height);
            c.liquidate(
                1,
                COMMIT.to_vec().into(),
                round,
                refund,
                debt,
                LIQ_PROOF.to_vec().into(),
            );
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

        /// Reference model from the spec, used to cross-check fixtures.
        fn reference(
            lots: i64,
            entry: i64,
            margin: i64,
            price: i64,
            funding: i64,
        ) -> (bool, i64, i64) {
            let pnl = (price - entry) * lots;
            let equity = margin - funding + pnl;
            let liquidatable = 20 * equity < price * lots;
            let capped = margin - funding + pnl.min(60_000);
            let refund = 60_000 - margin + (capped - 100).max(0);
            let bad_debt = (-equity).max(0);
            (liquidatable, refund, bad_debt)
        }

        // ------------------------------------------------------------------

        #[test]
        fn reference_fixture_values() {
            assert!(!reference(10, 10_000, 50_000, 7_000, 200).0);
            assert_eq!(reference(10, 10_000, 50_000, 5_200, 200), (true, 11_700, 0));
            assert_eq!(
                reference(10, 10_000, 50_000, 1_000, 200),
                (true, 10_000, 40_200)
            );
            // 20 * equity == price * lots is healthy; one tick lower is not.
            assert!(!reference(1, 57, 19, 40, 0).0);
            assert!(reference(1, 57, 19, 39, 0).0);
            // Largest refund equals MAX_REFUND.
            assert_eq!(reference(50, 1, 60_000, 20_000, 0).1 as u64, MAX_REFUND);
        }

        #[test]
        fn encodings() {
            let c = setup();
            let mut m = b"xythum:BTC-USDC:v1:".to_vec();
            m.extend_from_slice(&DEPLOYMENT);
            m.extend_from_slice(b"perps.test.near");
            assert_eq!(c.market, env::sha256_array(&m));
            assert_eq!(c.get_market().0, c.market.to_vec());

            let mut x = b"xythum:position:v1:".to_vec();
            x.extend_from_slice(&c.market);
            x.extend_from_slice(&[7, 0, 0, 0]);
            x.extend_from_slice(b"trader.test.near");
            let context = position_context(&c.market, 7, &trader());
            assert_eq!(context, env::sha256_array(&x));

            let msg = ack_message(&c.market, 7, &COMMIT, b"ct", 1);
            assert_eq!(msg.len(), 21 + 32 + 4 + 32 + 32 + 1 + 4);
            assert_eq!(&msg[..21], b"xythum:keeper-ack:v1:");
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

            let li = liquidation_inputs(&d, &context, 3, 5_200, 200, 11_700, 0);
            assert_eq!(li.len(), 9);
            assert_eq!(li[..4], open_inputs(&d, &context)[..]);
            assert_eq!(li[4], verifier::u64_scalar(3));
            assert_eq!(li[5], verifier::u64_scalar(5_200));
            assert_eq!(li[7], verifier::u64_scalar(11_700));
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
            ctx(contract_id(), 1);
            let mut vk = open_vk();
            vk.push(0);
            let _ = Contract::init(
                token(),
                trader(),
                maker(),
                oracle(),
                keeper_inputs(),
                DEPLOYMENT.to_vec().into(),
                vk.into(),
                liq_vk().into(),
            );
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
            assert_rejects(&mut c, ERR_FUNDING_RANGE, |c| c.publish_oracle(1, 1, 201));
            publish(&mut c, 5, 20_000, 100, 42);
            assert_eq!(
                c.get_oracle(),
                Some(OracleRound {
                    round: 5,
                    price_ticks: 20_000,
                    funding_cents: 100,
                    height: 42
                })
            );
            ctx(oracle(), 43);
            assert_rejects(&mut c, ERR_ROUND_NOT_INCREASING, |c| {
                c.publish_oracle(5, 1, 100)
            });
            assert_rejects(&mut c, ERR_ROUND_NOT_INCREASING, |c| {
                c.publish_oracle(4, 1, 100)
            });
            assert_rejects(&mut c, ERR_FUNDING_DECREASED, |c| {
                c.publish_oracle(6, 1, 99)
            });
            publish(&mut c, 6, 1, 100, 43);
            ctx(oracle(), u64::from(u32::MAX) + 1);
            assert_rejects(&mut c, ERR_HEIGHT_RANGE, |c| c.publish_oracle(7, 1, 100));
        }

        #[test]
        fn staging_and_quotes() {
            let mut c = setup();
            let commit = || -> Base64VecU8 { COMMIT.to_vec().into() };
            ctx(maker(), 110);
            assert_rejects(&mut c, ERR_NOT_TRADER, |c| {
                c.stage_position(1, commit(), b64s(ciphertexts()))
            });
            ctx(trader(), 110);
            assert_rejects(&mut c, ERR_BAD_NONCE, |c| {
                c.stage_position(2, commit(), b64s(ciphertexts()))
            });
            assert_rejects(&mut c, ERR_COMMITMENT_LEN, |c| {
                c.stage_position(1, vec![0; 31].into(), b64s(ciphertexts()))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_COUNT, |c| {
                c.stage_position(1, commit(), b64s(vec![vec![1]]))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_COUNT, |c| {
                c.stage_position(1, commit(), b64s(vec![vec![1], vec![2], vec![3]]))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_LEN, |c| {
                c.stage_position(1, commit(), b64s(vec![vec![1], vec![]]))
            });
            assert_rejects(&mut c, ERR_CIPHERTEXT_LEN, |c| {
                c.stage_position(
                    1,
                    commit(),
                    b64s(vec![vec![1; CIPHERTEXT_LEN + 1], vec![2; CIPHERTEXT_LEN]]),
                )
            });
            ctx(maker(), 110);
            assert_rejects(&mut c, ERR_NO_PENDING, |c| {
                c.approve_quote(1, commit(), 500)
            });

            ctx(trader(), 110);
            c.stage_position(1, commit(), b64s(ciphertexts()));
            let p = c.get_pending().unwrap();
            assert_eq!((p.nonce, p.commitment.0.clone()), (1, COMMIT.to_vec()));
            assert_eq!(p.ciphertexts[0].0.len(), CIPHERTEXT_LEN);

            ctx(trader(), 110);
            assert_rejects(&mut c, ERR_NOT_MAKER, |c| c.approve_quote(1, commit(), 500));
            ctx(maker(), 110);
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.approve_quote(2, commit(), 500)
            });
            assert_rejects(&mut c, ERR_PENDING_MISMATCH, |c| {
                c.approve_quote(1, vec![1; 32].into(), 500)
            });
            assert_rejects(&mut c, ERR_EXPIRY_NOT_FUTURE, |c| {
                c.approve_quote(1, commit(), 110)
            });
            c.approve_quote(1, commit(), 111);
            assert_eq!(c.get_quote().unwrap().expires_at, 111);

            // Replacing the pending item clears approval.
            ctx(trader(), 110);
            c.stage_position(1, vec![5; 32].into(), b64s(ciphertexts()));
            assert!(c.get_quote().is_none());
            assert_eq!(c.get_pending().unwrap().commitment.0, vec![5; 32]);
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
            let commit = || -> Base64VecU8 { COMMIT.to_vec().into() };
            let good = acks(&c, 1, &COMMIT, &ciphertexts());
            let proof = || -> Base64VecU8 { OPEN_PROOF.to_vec().into() };

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
                c.open(1, commit(), good.clone(), b"mutated".to_vec().into())
            });
            // Quote expiry is exclusive.
            ctx(trader(), 500);
            assert_rejects(&mut c, ERR_QUOTE_EXPIRED, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            // Freshness: 1000 blocks inclusive (oracle at 105).
            let mut stale = ready_to_open();
            ctx(maker(), 111);
            stale.approve_quote(1, commit(), 5_000);
            ctx(trader(), 1_106);
            assert_rejects(&mut stale, ERR_ORACLE_STALE, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            ctx(trader(), 1_105);
            stale.open(1, commit(), good.clone(), proof());
            assert!(stale.get_active().is_some());

            // Funding must be zero.
            publish(&mut c, 2, 10_000, 1, 130);
            ctx(trader(), 131);
            assert_rejects(&mut c, ERR_FUNDING_NONZERO, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
        }

        #[test]
        fn open_requires_funds_and_quote() {
            let commit = || -> Base64VecU8 { COMMIT.to_vec().into() };
            let proof = || -> Base64VecU8 { OPEN_PROOF.to_vec().into() };

            let mut c = setup();
            deposit(&mut c, trader(), "trader", 59_999);
            deposit(&mut c, maker(), "maker", 60_100);
            publish(&mut c, 1, 10_000, 0, 105);
            stage_and_approve(&mut c, 1);
            accept_open(&c, 1);
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
            ctx(trader(), 115);
            c.stage_position(1, commit(), b64s(ciphertexts()));
            ctx(trader(), 120);
            assert_rejects(&mut c, ERR_NO_QUOTE, |c| {
                c.open(1, commit(), good.clone(), proof())
            });

            let mut c3 = setup();
            ctx(trader(), 120);
            assert_rejects(&mut c3, ERR_NO_PENDING, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
            stage_and_approve(&mut c3, 1);
            ctx(trader(), 120);
            assert_rejects(&mut c3, ERR_NO_ORACLE, |c| {
                c.open(1, commit(), good.clone(), proof())
            });
        }

        #[test]
        fn slot_occupied_after_open() {
            let mut c = opened();
            ctx(trader(), 130);
            assert_rejects(&mut c, ERR_SLOT_OCCUPIED, |c| {
                c.stage_position(2, COMMIT.to_vec().into(), b64s(ciphertexts()))
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
                c.liquidate(
                    1,
                    COMMIT.to_vec().into(),
                    3,
                    11_700,
                    0,
                    LIQ_PROOF.to_vec().into(),
                )
            });
            // Cleared nonce is never reused; next position uses nonce 2.
            ctx(trader(), 1_202);
            assert_rejects(&mut c, ERR_BAD_NONCE, |c| {
                c.stage_position(1, COMMIT.to_vec().into(), b64s(ciphertexts()))
            });
            c.stage_position(2, COMMIT.to_vec().into(), b64s(ciphertexts()));
        }

        #[test]
        fn liquidation_rejections_leave_state_unchanged() {
            let mut c = opened();
            publish(&mut c, 2, 5_200, 200, 200);
            publish(&mut c, 3, 5_200, 200, 201);
            accept_liq(&c, 3, 5_200, 200, 11_700, 0);
            let root = || -> Base64VecU8 { COMMIT.to_vec().into() };
            let proof = || -> Base64VecU8 { LIQ_PROOF.to_vec().into() };

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
                c.liquidate(1, root(), 3, 11_700, 0, b"mutated".to_vec().into())
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
                c.stage_position(2, COMMIT.to_vec().into(), b64s(ciphertexts()))
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
            set(maker(), 1);
            assert_rejects(&mut c, ERR_NOT_CLAIMANT, |c| {
                let _ = c.withdraw(U128(1));
            });
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
    }
}
