//! Ootle Lockbox: time-locked vaults for tokens and LP shares on Tari Ootle.
//!
//! `Lockbox::lock` takes a bucket and creates one `Lockbox` component that holds it until
//! `unlock_epoch`. After that epoch anyone may call `claim`, which always delivers the whole
//! balance to the beneficiary account fixed at creation. Nobody can withdraw early, change the
//! beneficiary or the epoch, or upgrade the code: the component has no owner and is locked.
//! Explorers and the Lockbox web app find locks through the `LockCreated` / `LockClaimed` events.

use tari_template_lib::prelude::*;

/// Built-in Account template (`0000…0000`); beneficiaries must be accounts so funds stay spendable.
const ACCOUNT_TEMPLATE: TemplateAddress = TemplateAddress::from_array([0; 32]);
/// Longest memo accepted, in bytes. Keeps component state small.
const MAX_MEMO_BYTES: usize = 280;

#[template]
mod lockbox {
    use super::*;

    pub struct Lockbox {
        vault: Vault,
        beneficiary: ComponentAddress,
        unlock_epoch: u64,
        locked_at_epoch: u64,
        locked_amount: Amount,
        memo: String,
        claimed: bool,
    }

    impl Lockbox {
        /// Locks `tokens` until `unlock_epoch` for the `beneficiary` account.
        /// Panics if the bucket is empty, the epoch is not in the future, the beneficiary is not
        /// an account, or the memo is too long.
        pub fn lock(tokens: Bucket, unlock_epoch: u64, beneficiary: ComponentAddress, memo: String) -> Component<Self> {
            let now = Consensus::current_epoch();
            assert!(!tokens.is_empty(), "Cannot lock an empty bucket");
            assert!(unlock_epoch > now, "Unlock epoch {unlock_epoch} must be after the current epoch {now}");
            assert!(memo.len() <= MAX_MEMO_BYTES, "Memo is longer than {MAX_MEMO_BYTES} bytes");
            assert_eq!(
                ComponentManager::get(beneficiary).get_template_address(),
                ACCOUNT_TEMPLATE,
                "Beneficiary must be an account"
            );

            let resource = tokens.resource_address();
            let amount = tokens.amount();
            emit_event("LockCreated", metadata![
                "resource" => resource.to_string(),
                "amount" => amount.to_string(),
                "beneficiary" => beneficiary.to_string(),
                "unlock_epoch" => unlock_epoch.to_string(),
                "locked_at_epoch" => now.to_string(),
            ]);

            Component::new(Self {
                vault: Vault::from_bucket(tokens),
                beneficiary,
                unlock_epoch,
                locked_at_epoch: now,
                locked_amount: amount,
                memo,
                claimed: false,
            })
            .with_access_rules(
                ComponentAccessRules::new()
                    .method("claim", rule!(allow_all))
                    .method("info", rule!(allow_all))
                    .default(rule!(deny_all)),
            )
            .with_owner_rule(OwnerRule::None)
            .create()
        }

        /// Sends the whole balance to the beneficiary once `unlock_epoch` has been reached.
        /// Callable by anyone, since the destination is fixed. Panics before the epoch or if
        /// already claimed.
        pub fn claim(&mut self) {
            let now = Consensus::current_epoch();
            assert!(!self.claimed, "Lock already claimed");
            assert!(now >= self.unlock_epoch, "Locked until epoch {} (current epoch {now})", self.unlock_epoch);

            self.claimed = true;
            let tokens = self.vault.withdraw_all();
            let amount = tokens.amount();
            ComponentManager::get(self.beneficiary).invoke("deposit", args![tokens]);
            emit_event("LockClaimed", metadata![
                "resource" => self.vault.resource_address().to_string(),
                "amount" => amount.to_string(),
                "beneficiary" => self.beneficiary.to_string(),
                "claimed_at_epoch" => now.to_string(),
            ]);
        }

        /// Read-only view of the lock for proof pages and explorers.
        pub fn info(&self) -> LockInfo {
            LockInfo {
                resource: self.vault.resource_address(),
                balance: self.vault.balance(),
                locked_amount: self.locked_amount,
                beneficiary: self.beneficiary,
                unlock_epoch: self.unlock_epoch,
                locked_at_epoch: self.locked_at_epoch,
                memo: self.memo.clone(),
                claimed: self.claimed,
            }
        }
    }

    /// What `info` returns. Declared after the component so the macro picks `Lockbox` as the component.
    pub struct LockInfo {
        pub resource: ResourceAddress,
        pub balance: Amount,
        pub locked_amount: Amount,
        pub beneficiary: ComponentAddress,
        pub unlock_epoch: u64,
        pub locked_at_epoch: u64,
        pub memo: String,
        pub claimed: bool,
    }
}
