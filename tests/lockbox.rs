//! Engine tests for the Lockbox template: lock, early-claim refusal, claim at the unlock epoch,
//! and the input checks. Each test runs in-process on the real Ootle engine.

use tari_template_lib::prelude::{Amount, ComponentAddress, ResourceAddress};
use tari_template_test_tooling::crypto::RistrettoSecretKey;
use tari_template_test_tooling::engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_template_test_tooling::template_lib_types::NonFungibleAddress;
use tari_template_test_tooling::transaction::args;
use tari_template_test_tooling::TemplateTest;

const SUPPLY: u128 = 1_000_000;
const LOCKED: u128 = 250_000;
const UNLOCK_EPOCH: u64 = 100;

struct Env {
    test: TemplateTest,
    token: ComponentAddress,
    resource: ResourceAddress,
    owner: (ComponentAddress, NonFungibleAddress, RistrettoSecretKey),
}

/// Sets up the engine at epoch 10, a test token, and an account holding the whole supply.
fn setup() -> Env {
    let mut test = TemplateTest::new(".", [".", "tests/templates/test_token"]);
    set_epoch(&mut test, 10);
    let token: ComponentAddress = test.call_function("TestToken", "mint", args![Amount::new(SUPPLY)], vec![]);
    let resource: ResourceAddress = test.call_method(token, "resource_address", args![], vec![]);
    let owner = test.create_funded_account();
    test.execute_expect_success(
        test.transaction()
            .call_method(token, "take", args![Amount::new(SUPPLY)])
            .put_last_instruction_output_on_workspace("coins")
            .call_method(owner.0, "deposit", args![Workspace("coins")])
            .build_and_seal(&owner.2),
        vec![owner.1.clone()],
    );
    Env { test, token, resource, owner }
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
}

/// Locks `LOCKED` tokens from the owner's account for `beneficiary`; returns the lock component.
fn lock(env: &mut Env, unlock_epoch: u64, beneficiary: ComponentAddress) -> ComponentAddress {
    let lockbox = env.test.get_template_address("Lockbox");
    env.test.execute_expect_success(
        env.test
            .transaction()
            .call_method(env.owner.0, "withdraw", args![env.resource, Amount::new(LOCKED)])
            .put_last_instruction_output_on_workspace("tokens")
            .call_function(lockbox, "lock", args![Workspace("tokens"), unlock_epoch, beneficiary, "team tokens"])
            .build_and_seal(&env.owner.2),
        vec![env.owner.1.clone()],
    );
    env.test.expect_return::<ComponentAddress>(2)
}

/// Asserts a rejected transaction failed with a message containing `expected`.
fn assert_rejected(reason: impl std::fmt::Debug, expected: &str) {
    let text = format!("{reason:?}");
    assert!(text.contains(expected), "expected rejection containing {expected:?}, got {text}");
}

fn balance(env: &mut Env, account: ComponentAddress) -> Amount {
    env.test.call_method(account, "balance", args![env.resource], vec![])
}

#[test]
fn claim_before_unlock_is_refused_and_claim_after_pays_the_beneficiary_once() {
    let mut env = setup();
    let beneficiary = env.test.create_empty_account();
    let lock_addr = lock(&mut env, UNLOCK_EPOCH, beneficiary.0);
    let owner_account = env.owner.0;
    assert_eq!(balance(&mut env, owner_account), Amount::new(SUPPLY - LOCKED));

    // A stranger tries one epoch early.
    let stranger = env.test.create_funded_account();
    set_epoch(&mut env.test, UNLOCK_EPOCH - 1);
    let reason = env.test.execute_expect_failure(
        env.test.transaction().call_method(lock_addr, "claim", args![]).build_and_seal(&stranger.2),
        vec![stranger.1.clone()],
    );
    assert_rejected(reason, "Locked until epoch 100");

    // At the unlock epoch anyone can trigger the claim, but the tokens go to the beneficiary.
    set_epoch(&mut env.test, UNLOCK_EPOCH);
    env.test.execute_expect_success(
        env.test.transaction().call_method(lock_addr, "claim", args![]).build_and_seal(&stranger.2),
        vec![stranger.1.clone()],
    );
    assert_eq!(balance(&mut env, beneficiary.0), Amount::new(LOCKED));
    assert_eq!(balance(&mut env, stranger.0), Amount::ZERO);

    // A second claim fails.
    let reason = env.test.execute_expect_failure(
        env.test.transaction().call_method(lock_addr, "claim", args![]).build_and_seal(&stranger.2),
        vec![stranger.1.clone()],
    );
    assert_rejected(reason, "Lock already claimed");
}

#[test]
fn info_reports_the_lock() {
    let mut env = setup();
    let beneficiary = env.owner.0;
    let lock_addr = lock(&mut env, UNLOCK_EPOCH, beneficiary);
    // `LockInfo` is CBOR-encoded positionally, so it decodes as a tuple in field order.
    let info: (ResourceAddress, Amount, Amount, ComponentAddress, u64, u64, String, bool) =
        env.test.call_method(lock_addr, "info", args![], vec![]);
    assert_eq!(
        info,
        (env.resource, Amount::new(LOCKED), Amount::new(LOCKED), beneficiary, UNLOCK_EPOCH, 10, "team tokens".to_string(), false)
    );
}

#[test]
fn lock_rejects_bad_inputs() {
    let mut env = setup();
    let lockbox = env.test.get_template_address("Lockbox");
    let owner = env.owner.0;
    let cases = [
        (Amount::new(LOCKED), 10u64, owner, "x".to_string(), "must be after the current epoch"),
        (Amount::new(LOCKED), UNLOCK_EPOCH, env.token, "x".to_string(), "Beneficiary must be an account"),
        (Amount::ZERO, UNLOCK_EPOCH, owner, "x".to_string(), "Cannot lock an empty bucket"),
        (Amount::new(LOCKED), UNLOCK_EPOCH, owner, "m".repeat(281), "Memo is longer than 280 bytes"),
    ];
    for (amount, unlock_epoch, beneficiary, memo, expected) in cases {
        let reason = env.test.execute_expect_failure(
            env.test
                .transaction()
                .call_method(owner, "withdraw", args![env.resource, amount])
                .put_last_instruction_output_on_workspace("tokens")
                .call_function(lockbox, "lock", args![Workspace("tokens"), unlock_epoch, beneficiary, memo])
                .build_and_seal(&env.owner.2),
            vec![env.owner.1.clone()],
        );
        assert_rejected(reason, expected);
    }
    // Nothing left the owner's account.
    assert_eq!(balance(&mut env, owner), Amount::new(SUPPLY));
}
