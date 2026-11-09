//! Ootle Lockbox: time-locked vaults for tokens and LP shares on Tari Ootle.
//!
//! `Lockbox::lock` takes a bucket and creates one `Lockbox` component that holds it until
//! `unlock_epoch`. From that epoch on, only the beneficiary key may call `claim`, which returns the
//! whole balance as a bucket; the beneficiary deposits it into any account in the same
//! transaction, so a full or deposit-restricted account can never strand the funds.
//! The component has no owner, no admin methods and no upgrade path, so Lockbox itself never
//! releases funds early.
//!
//! What Lockbox cannot control: the locked resource's own rules. If the token's issuer kept
//! recall, freeze or withdraw authority (or owns the resource), the engine lets them act on the
//! vault directly. The web app reads each resource's rules from the indexer and only marks a lock
//! "verified" when no such authority exists.
//!
//! Locks are discovered through the `Lockbox.LockCreated` / `Lockbox.LockClaimed` events, which
//! carry the lock's component address. Verifiers must also check that the component was created
//! from this template's address, since any template can emit an event with the same topic.

use tari_template_lib::prelude::*;

/// Longest memo accepted, in bytes. Keeps component state small.
const MAX_MEMO_BYTES: usize = 280;

#[template]
mod lockbox {
    use super::*;

    pub struct Lockbox {
        vault: Vault,
        beneficiary: RistrettoPublicKeyBytes,
        unlock_epoch: u64,
        locked_at_epoch: u64,
        locked_amount: Amount,
        memo: String,
        claimed: bool,
    }

    impl Lockbox {
        /// Locks `tokens` until `unlock_epoch`; only `beneficiary` may claim them afterwards.
        /// Panics if the bucket is empty or holds blinded confidential funds, the epoch is not in
        /// the future, the memo is too long, or the beneficiary is not a valid public key.
        pub fn lock(
            tokens: Bucket,
            unlock_epoch: u64,
            beneficiary: RistrettoPublicKeyBytes,
            memo: String,
        ) -> Component<Self> {
            let now = Consensus::current_epoch();
            assert!(!tokens.is_empty(), "Cannot lock an empty bucket");
            // `withdraw_all` only moves revealed funds, so blinded commitments would be stranded.
            tokens.assert_contains_no_confidential_funds();
            assert!(unlock_epoch > now, "Unlock epoch {unlock_epoch} must be after the current epoch {now}");
            assert!(memo.len() <= MAX_MEMO_BYTES, "Memo is longer than {MAX_MEMO_BYTES} bytes");
            // Nobody can sign for a non-canonical or identity key, so its lock could never be claimed.
            assert!(
                tari_template_lib::intrinsics::ristretto_is_canonical(&beneficiary) && !beneficiary.is_zero(),
                "Beneficiary {beneficiary} is not a valid public key"
            );

            // Allocate the address first so the creation event can name the lock.
            let allocation = CallerContext::allocate_component_address(None);
            let lock_address = allocation.get_address();
            let resource = tokens.resource_address();
            let amount = tokens.amount();
            emit_event("LockCreated", metadata![
                "lock" => lock_address.to_string(),
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
            .with_address_allocation(allocation)
            .with_access_rules(
                ComponentAccessRules::new()
                    .method("claim", rule!(public_key(beneficiary)))
                    .method("info", rule!(allow_all))
                    .default(rule!(deny_all)),
            )
            .with_owner_rule(OwnerRule::None)
            .create()
        }

        /// Returns the whole balance once `unlock_epoch` has been reached. Only the beneficiary
        /// key may call it (component access rule). Panics before the epoch or if already claimed.
        pub fn claim(&mut self) -> Bucket {
            let now = Consensus::current_epoch();
            assert!(!self.claimed, "Lock already claimed");
            assert!(now >= self.unlock_epoch, "Locked until epoch {} (current epoch {now})", self.unlock_epoch);

            self.claimed = true;
            let tokens = self.vault.withdraw_all();
            emit_event("LockClaimed", metadata![
                "lock" => CallerContext::current_component_address().to_string(),
                "resource" => tokens.resource_address().to_string(),
                "amount" => tokens.amount().to_string(),
                "claimed_at_epoch" => now.to_string(),
            ]);
            tokens
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
        pub beneficiary: RistrettoPublicKeyBytes,
        pub unlock_epoch: u64,
        pub locked_at_epoch: u64,
        pub memo: String,
        pub claimed: bool,
    }
}
