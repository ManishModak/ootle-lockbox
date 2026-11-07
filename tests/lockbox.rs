//! Engine tests for the Lockbox template: lock, early and wrong-key claim refusal, claim by the
//! beneficiary into an account of their choice, input checks and events. Each test runs in-process
//! on the real Ootle engine.

use tari_template_lib::prelude::{Amount, ComponentAddress, ResourceAddress, RistrettoPublicKeyBytes};
use tari_template_test_tooling::TemplateTest;
use tari_template_test_tooling::byte_type::ToByteType;
use tari_template_test_tooling::crypto::{PublicKey, RistrettoPublicKey, RistrettoSecretKey};
use tari_template_test_tooling::engine_types::commit_result::ExecuteResult;
use tari_template_test_tooling::engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_template_test_tooling::support::confidential::generate_confidential_output_statement;
use tari_template_test_tooling::template_lib_types::NonFungibleAddress;
use tari_template_test_tooling::transaction::{Transaction, args};

const SUPPLY: u128 = 1_000_000;
const LOCKED: u128 = 250_000;
const UNLOCK_EPOCH: u64 = 100;

type Account = (ComponentAddress, NonFungibleAddress, RistrettoSecretKey);

struct Env {
    test: TemplateTest,
    resource: ResourceAddress,
    owner: Account,
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
    Env { test, resource, owner }
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
}

fn public_key(account: &Account) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(&account.2).to_byte_type()
}

/// Locks `LOCKED` tokens from the owner's account for `beneficiary`; returns the lock and the result.
fn lock(env: &mut Env, beneficiary: RistrettoPublicKeyBytes) -> (ComponentAddress, ExecuteResult) {
    let lockbox = env.test.get_template_address("Lockbox");
    let result = env.test.execute_expect_success(
        env.test
            .transaction()
            .call_method(env.owner.0, "withdraw", args![env.resource, Amount::new(LOCKED)])
            .put_last_instruction_output_on_workspace("tokens")
            .call_function(lockbox, "lock", args![Workspace("tokens"), UNLOCK_EPOCH, beneficiary, "team tokens"])
            .build_and_seal(&env.owner.2),
        vec![env.owner.1.clone()],
    );
    // Instruction 1 (putting the bucket on the workspace) also has a return slot.
    (env.test.expect_return::<ComponentAddress>(2), result)
}

/// Claims `lock` signed by `signer`, depositing the tokens into `destination`.
fn claim_tx(test: &TemplateTest, lock: ComponentAddress, signer: &Account, destination: ComponentAddress) -> Transaction {
    test.transaction()
        .call_method(lock, "claim", args![])
        .put_last_instruction_output_on_workspace("tokens")
        .call_method(destination, "deposit", args![Workspace("tokens")])
        .build_and_seal(&signer.2)
}

fn balance(env: &mut Env, account: ComponentAddress) -> Amount {
    env.test.call_method(account, "balance", args![env.resource], vec![])
}

/// Asserts a rejected transaction failed with a message containing `expected`.
fn assert_rejected(reason: impl std::fmt::Debug, expected: &str) {
    let text = format!("{reason:?}");
    assert!(text.contains(expected), "expected rejection containing {expected:?}, got {text}");
}

#[test]
fn only_the_beneficiary_can_claim_only_after_unlock_and_only_once() {
    let mut env = setup();
    let beneficiary = env.test.create_funded_account();
    let (lock_addr, _) = lock(&mut env, public_key(&beneficiary));
    let owner_account = env.owner.0;
    assert_eq!(balance(&mut env, owner_account), Amount::new(SUPPLY - LOCKED));

    // The beneficiary one epoch early.
    set_epoch(&mut env.test, UNLOCK_EPOCH - 1);
    let tx = claim_tx(&env.test, lock_addr, &beneficiary, beneficiary.0);
    let reason = env.test.execute_expect_failure(tx, vec![beneficiary.1.clone()]);
    assert_rejected(reason, "Locked until epoch 100");

    // Another key at the unlock epoch, including the locker itself.
    set_epoch(&mut env.test, UNLOCK_EPOCH);
    let stranger = env.test.create_funded_account();
    for other in [stranger, env.owner.clone()] {
        let tx = claim_tx(&env.test, lock_addr, &other, other.0);
        let reason = env.test.execute_expect_failure(tx, vec![other.1.clone()]);
        assert_rejected(reason, "AccessDenied");
    }

    // The beneficiary claims into a fresh account of their choice.
    let destination = env.test.create_empty_account();
    let tx = claim_tx(&env.test, lock_addr, &beneficiary, destination.0);
    env.test.execute_expect_success(tx, vec![beneficiary.1.clone()]);
    assert_eq!(balance(&mut env, destination.0), Amount::new(LOCKED));

    // A second claim fails.
    let tx = claim_tx(&env.test, lock_addr, &beneficiary, beneficiary.0);
    let reason = env.test.execute_expect_failure(tx, vec![beneficiary.1.clone()]);
    assert_rejected(reason, "Lock already claimed");
}

#[test]
fn info_and_events_describe_the_lock() {
    let mut env = setup();
    let beneficiary = public_key(&env.owner);
    let (lock_addr, created) = lock(&mut env, beneficiary);

    // `LockInfo` is CBOR-encoded positionally, so it decodes as a tuple in field order.
    let info: (ResourceAddress, Amount, Amount, RistrettoPublicKeyBytes, u64, u64, String, bool) =
        env.test.call_method(lock_addr, "info", args![], vec![]);
    assert_eq!(
        info,
        (env.resource, Amount::new(LOCKED), Amount::new(LOCKED), beneficiary, UNLOCK_EPOCH, 10, "team tokens".to_string(), false)
    );

    // Both events come from this template and name the lock's own address.
    let lockbox = env.test.get_template_address("Lockbox");
    let names_lock = |result: &ExecuteResult, topic: &str| {
        result.finalize.events.iter().any(|e| {
            e.topic().ends_with(topic)
                && *e.template_address() == lockbox
                && e.payload().get_str("lock") == Some(lock_addr.to_string().as_str())
        })
    };
    assert!(names_lock(&created, "LockCreated"), "LockCreated must name the lock: {:?}", created.finalize.events);

    set_epoch(&mut env.test, UNLOCK_EPOCH);
    let owner = env.owner.clone();
    let tx = claim_tx(&env.test, lock_addr, &owner, owner.0);
    let claimed = env.test.execute_expect_success(tx, vec![owner.1.clone()]);
    assert!(names_lock(&claimed, "LockClaimed"), "LockClaimed must name the lock: {:?}", claimed.finalize.events);
}

#[test]
fn lock_rejects_bad_inputs() {
    let mut env = setup();
    let lockbox = env.test.get_template_address("Lockbox");
    let owner = env.owner.0;
    let key = public_key(&env.owner);
    let cases = [
        (Amount::new(LOCKED), 10u64, "x".to_string(), "must be after the current epoch"),
        (Amount::ZERO, UNLOCK_EPOCH, "x".to_string(), "Cannot lock an empty bucket"),
        (Amount::new(LOCKED), UNLOCK_EPOCH, "m".repeat(281), "Memo is longer than 280 bytes"),
    ];
    for (amount, unlock_epoch, memo, expected) in cases {
        let reason = env.test.execute_expect_failure(
            env.test
                .transaction()
                .call_method(owner, "withdraw", args![env.resource, amount])
                .put_last_instruction_output_on_workspace("tokens")
                .call_function(lockbox, "lock", args![Workspace("tokens"), unlock_epoch, key, memo])
                .build_and_seal(&env.owner.2),
            vec![env.owner.1.clone()],
        );
        assert_rejected(reason, expected);
    }
    // Nothing left the owner's account.
    assert_eq!(balance(&mut env, owner), Amount::new(SUPPLY));
}

#[test]
fn lock_rejects_blinded_confidential_funds() {
    let mut env = setup();
    let lockbox = env.test.get_template_address("Lockbox");
    let token = env.test.get_template_address("TestToken");
    let (statement, _mask, _change) = generate_confidential_output_statement(1_000, None);
    let key = public_key(&env.owner);
    let reason = env.test.execute_expect_failure(
        env.test
            .transaction()
            .call_function(token, "confidential", args![statement])
            .put_last_instruction_output_on_workspace("tokens")
            .call_function(lockbox, "lock", args![Workspace("tokens"), UNLOCK_EPOCH, key, "x"])
            .build_and_seal(&env.owner.2),
        vec![env.owner.1.clone()],
    );
    assert_rejected(reason, "confidential");
}
