//! Test-only fungible token: `mint` creates a public token whose whole supply anyone can take.
use tari_template_lib::prelude::*;

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
    }
}
