//! Test-only tokens: `mint` creates a public token whose whole supply anyone can take;
//! `confidential` returns a bucket of a new confidential resource holding blinded commitments.
use tari_template_lib::prelude::*;
use tari_template_lib::types::confidential::ConfidentialOutputStatement;

#[template]
mod test_token {
    use super::*;

    pub struct TestToken {
        vault: Vault,
    }

    impl TestToken {
        pub fn mint(supply: Amount) -> Component<Self> {
            let coins = ResourceBuilder::public_fungible().with_token_symbol("TEST").initial_supply(supply);
            Component::new(Self { vault: Vault::from_bucket(coins) })
                .with_access_rules(ComponentAccessRules::allow_all())
                .create()
        }

        pub fn resource_address(&self) -> ResourceAddress {
            self.vault.resource_address()
        }

        pub fn take(&mut self, amount: Amount) -> Bucket {
            self.vault.withdraw(amount)
        }

        pub fn confidential(statement: ConfidentialOutputStatement) -> Bucket {
            ResourceBuilder::confidential()
                .with_token_symbol("CONF")
                .disable_total_supply_tracking()
                .initial_supply(statement)
        }
    }
}
