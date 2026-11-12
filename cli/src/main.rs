//! lockbox-cli: publishes the Lockbox template and drives a lock / claim from a local key.
//!
//! Usage: `lockbox-cli <esmeralda|mainnet> <command> [args] [--submit]`
//!   init                                     create the key file (never overwrites)
//!   address                                  print the Ootle address, account and public key
//!   status                                   current epoch and account balances
//!   fund <utxo_commitment> <microtari> <fee>  move a stealth TARI UTXO sent to this key into its account
//!   publish <wasm>                           publish the template
//!   lock <template> <microtari> <unlock_epoch>  lock native TARI from this account for this key
//!   claim <lock_component>                   claim a lock into this account
//!
//! Every transaction is dry-run first; `--submit` then sends that same transaction. It reserves
//! at most `MAX_FEE` for fees (the unused part returns to the account) and refuses a dry run
//! that needs more. The key file and transaction runner are in `lib.rs`, shared with launch-cli.

use std::str::FromStr;

use anyhow::{Result, anyhow, bail, ensure};
use lockbox_cli::{Session, init_key, key_path, load_key, parse_network};
use ootle_rs::{
    ToAccountAddress,
    builtin_templates::component::TransactionBuildable,
    template_types::{Amount, ComponentAddress, constants::TARI_TOKEN},
};
use tari_ootle_common_types::engine_types::published_template::PublishedTemplateAddress;
use tari_ootle_transaction::args;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let submit = take_flag(&mut args, "--submit");
    let [network, command, rest @ ..] = args.as_slice() else {
        bail!("usage: lockbox-cli <esmeralda|mainnet> <init|address|status|fund|publish|lock|claim> [args] [--submit]");
    };
    let network = parse_network(network)?;
    let key_path = key_path(network)?;

    if command == "init" {
        return init_key(&key_path, network);
    }
    let secret = load_key(&key_path, network)?;
    let address = secret.to_address();
    let account = address.to_account_address();
    let public_key = *address.account_public_key();

    if command == "address" {
        println!("address:    {address}");
        println!("account:    {account}");
        println!("public key: {public_key}");
        return Ok(());
    }

    let session = Session::connect(secret, network).await?;
    let epoch = session.epoch;
    match (command.as_str(), rest) {
        ("status", []) => session.print_status(account).await?,
        ("fund", [commitment, microtari, fee]) => {
            session
                .fund_from_stealth(address.clone(), public_key, account, commitment, microtari.parse()?, fee.parse()?, submit)
                .await?
        },
        ("publish", [wasm]) => session.publish(account, wasm, submit).await?,
        ("lock", [template, microtari, unlock_epoch]) => {
            let template = PublishedTemplateAddress::from_str(template)
                .map_err(|e| anyhow!("bad template address: {e:?}"))?
                .as_template_address();
            let amount = Amount::new(microtari.parse()?);
            let unlock_epoch: u64 = unlock_epoch.parse()?;
            ensure!(unlock_epoch > epoch, "unlock epoch {unlock_epoch} must be after the current epoch {epoch}");
            session
                .run(account, amount, submit, |b| {
                    b.call_method(account, "withdraw", args![TARI_TOKEN, amount])
                        .put_last_instruction_output_on_workspace("tokens")
                        .call_function(template, "lock", args![
                            Workspace("tokens"),
                            unlock_epoch,
                            public_key,
                            "lockbox-cli demo"
                        ])
                })
                .await?;
        },
        ("claim", [lock]) => {
            let lock = ComponentAddress::from_str(lock).map_err(|e| anyhow!("bad component address: {e:?}"))?;
            session
                .run(account, Amount::zero(), submit, |b| {
                    b.call_method(lock, "claim", args![])
                        .put_last_instruction_output_on_workspace("tokens")
                        .call_method(account, "deposit", args![Workspace("tokens")])
                })
                .await?;
        },
        _ => bail!("unknown command or wrong arguments: {command} {rest:?}"),
    }
    Ok(())
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let before = args.len();
    args.retain(|a| a != flag);
    args.len() != before
}
