//! Sandbox-only mock NEP-141 token (`mUSDC`, 2 decimals). It has no backing
//! asset. The whole supply is minted to `owner_id` at initialization.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PanicOnDefault, PromiseOrValue, log, near};

pub const MOCK_NAME: &str = "Mock USDC (sandbox only)";
pub const MOCK_SYMBOL: &str = "mUSDC";
pub const MOCK_DECIMALS: u8 = 2;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockToken {
    token: FungibleToken,
}

#[near]
impl MockToken {
    /// Mints `total_supply` raw units to `owner_id`. Only the token account
    /// itself may initialize.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("mock supply minted"),
        }
        .emit();
        Self { token }
    }
}

#[near]
impl FungibleTokenCore for MockToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for MockToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: MOCK_NAME.to_string(),
            symbol: MOCK_SYMBOL.to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: MOCK_DECIMALS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor);
        b
    }

    #[test]
    fn init_mints_supply_and_metadata() {
        testing_env!(ctx(accounts(0)).build());
        let c = MockToken::new(accounts(1), U128(1_000_000));
        assert_eq!(c.ft_total_supply().0, 1_000_000);
        assert_eq!(c.ft_balance_of(accounts(1)).0, 1_000_000);
        let m = c.ft_metadata();
        assert_eq!(m.symbol, "mUSDC");
        assert_eq!(m.decimals, 2);
        m.assert_valid();
    }

    #[test]
    fn transfer_between_registered_accounts() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = MockToken::new(accounts(1), U128(1_000));
        let mut b = ctx(accounts(2));
        b.attached_deposit(c.storage_balance_bounds().min);
        testing_env!(b.build());
        c.storage_deposit(None, None);
        let mut b = ctx(accounts(1));
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        c.ft_transfer(accounts(2), U128(250), None);
        assert_eq!(c.ft_balance_of(accounts(1)).0, 750);
        assert_eq!(c.ft_balance_of(accounts(2)).0, 250);
    }
}
