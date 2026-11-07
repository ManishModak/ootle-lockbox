//! lockbox-cli: publishes the Lockbox template and drives a lock / claim from a local key.
//!
//! Usage: `lockbox-cli <esmeralda|mainnet> <command> [args] [--submit]`
//!   init                                     create the key file (never overwrites)
//!   address                                  print the Ootle address, account and public key
//!   status                                   current epoch and account balances
//!   publish <wasm>                           publish the template
//!   lock <template> <microtari> <unlock_epoch>  lock native TARI from this account for this key
//!   claim <lock_component>                   claim a lock into this account
//!
//! Every transaction is dry-run first; `--submit` then sends that same transaction. It reserves
//! at most `MAX_FEE` for fees (the unused part returns to the account) and refuses a dry run
//! that needs more. The key lives in `~/.config/secrets/ootle-lockbox-<network>.key` (mode 600;
//! lines: network name, account secret hex, view secret hex) and is never printed.

use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use ootle_rs::{
    Network,
    ToAccountAddress,
    TransactionRequest,
    builtin_templates::{
        UnsignedTransactionBuilder,
        component::{ComponentInvokeBuilder, IComponent, TransactionBuildable},
    },
    default_indexer_url,
    key_provider::PrivateKeyProvider,
    keys::OotleSecretKey,
    provider::{IndexerProvider, ProviderBuilder, WalletProvider},
    template_types::{Amount, ComponentAddress, constants::TARI_TOKEN},
    wallet::OotleWallet,
};
use tari_crypto::{ristretto::RistrettoSecretKey, tari_utilities::hex::Hex};
use tari_ootle_common_types::engine_types::published_template::PublishedTemplateAddress;
use tari_ootle_transaction::{Epoch, args};

/// Most a transaction may reserve, and so spend, for fees: 5 TARI, in µT.
const MAX_FEE: u64 = 5_000_000;
/// How many epochs ahead a transaction may still be sequenced.
const EPOCH_WINDOW: u64 = 10;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let submit = take_flag(&mut args, "--submit");
    let [network, command, rest @ ..] = args.as_slice() else {
        bail!("usage: lockbox-cli <esmeralda|mainnet> <init|address|status|publish|lock|claim> [args] [--submit]");
    };
    let network = match network.as_str() {
        "esmeralda" => Network::Esmeralda,
        "mainnet" => Network::MainNet,
        other => bail!("unknown network {other}"),
    };
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

    let provider = ProviderBuilder::new()
        .wallet(OotleWallet::from(PrivateKeyProvider::new(secret)))
        .connect_with_transaction_timeout(default_indexer_url(network), Duration::from_secs(180))
        .await
        .context("connect to indexer")?;
    let epoch = provider.get_epoch().await?.as_u64();
    let max_epoch = Epoch(epoch + EPOCH_WINDOW);
    match (command.as_str(), rest) {
        ("status", []) => {
            println!("epoch: {epoch}");
            for (resource, balance) in provider.get_account_balances(account).await? {
                println!("{resource}: {balance}");
            }
        },
        ("publish", [wasm]) => {
            let binary = fs::read(wasm).with_context(|| format!("read {wasm}"))?;
            println!("template size: {} bytes", binary.len());
            run(provider, account, max_epoch, Amount::zero(), submit, |b| {
                b.then(|t| t.publish_template(binary.clone()))
            })
            .await?;
        },
        ("lock", [template, microtari, unlock_epoch]) => {
            let template = PublishedTemplateAddress::from_str(template)
                .map_err(|e| anyhow!("bad template address: {e:?}"))?
                .as_template_address();
            let amount = Amount::new(microtari.parse()?);
            let unlock_epoch: u64 = unlock_epoch.parse()?;
            ensure!(unlock_epoch > epoch, "unlock epoch {unlock_epoch} must be after the current epoch {epoch}");
            run(provider, account, max_epoch, amount, submit, |b| {
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
            run(provider, account, max_epoch, Amount::zero(), submit, |b| {
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

type Provider = IndexerProvider<OotleWallet>;
type Builder<'p> = ComponentInvokeBuilder<'p, Provider>;

/// Builds `instructions` with this account paying the fee and the provider filling in the
/// inputs they need, dry-runs it, prints the fee, and with `submit` sends exactly that
/// transaction. `spend` is the TARI the instructions themselves withdraw, kept out of the fee
/// reservation. Fails unless the transaction fully commits.
async fn run<F>(
    mut provider: Provider,
    account: ComponentAddress,
    max_epoch: Epoch,
    spend: Amount,
    submit: bool,
    instructions: F,
) -> Result<()>
where
    F: FnOnce(Builder<'_>) -> Builder<'_>,
{
    let tari = provider.get_account_balance(account, TARI_TOKEN).await?;
    let available = tari
        .checked_sub(spend)
        .filter(Amount::is_positive)
        .ok_or_else(|| anyhow!("the account holds {tari} µT, not enough for {spend} µT plus fees"))?;
    let reserve = available.to_u64_checked().map_or(MAX_FEE, |a| a.min(MAX_FEE));
    // A fresh nonce keeps two identical commands from producing the same transaction id.
    let nonce: u64 = rand::random();
    let tx = instructions(IComponent::new(&provider, max_epoch).pay_fee(reserve).then(|t| t.with_nonce(nonce)))
        .prepare()
        .await?;

    let dry = provider.sign_and_send_dry_run(tx.clone()).await?;
    if let Some(reason) = dry.finalize.any_reject() {
        bail!("dry run rejected: {reason}");
    }
    // Dry runs are not rejected for an insufficient fee, so check the reservation covers it.
    let fee = dry.finalize.required_fees();
    ensure!(fee <= reserve, "the transaction needs {fee} µT in fees but only {reserve} µT is reserved");
    println!("dry run ok; fee {fee} µT ({:.6} TARI) of {reserve} µT reserved", fee as f64 / 1e6);
    if !submit {
        println!("not sent (add --submit to send)");
        return Ok(());
    }

    let signed = TransactionRequest::default().with_transaction(tx).build(provider.wallet()).await?;
    let pending = provider.send_transaction(signed).await?;
    println!("sent {}", pending.tx_id());
    let outcome = pending.watch().await?;
    ensure!(outcome.is_commit(), "transaction {} did not commit: {outcome:?}", pending.tx_id());
    let receipt = pending.get_receipt().await?;
    println!("committed in epoch {}, fee paid {} µT", receipt.epoch, receipt.fee_receipt.total_fees_paid());
    for up in &receipt.diff_summary.upped {
        println!("upped: {}", up.substate_id);
    }
    for event in &receipt.events {
        println!("event: {} {{{}}}", event.topic(), event.payload());
    }
    Ok(())
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let before = args.len();
    args.retain(|a| a != flag);
    args.len() != before
}

fn network_name(network: Network) -> &'static str {
    match network {
        Network::MainNet => "mainnet",
        _ => "esmeralda",
    }
}

fn key_path(network: Network) -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home).join(format!(".config/secrets/ootle-lockbox-{}.key", network_name(network))))
}

/// Creates a fresh random key file with mode 600. Refuses if one exists.
fn init_key(file: &PathBuf, network: Network) -> Result<()> {
    let secret = OotleSecretKey::random(network);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(file)
        .with_context(|| format!("create {} (it must not exist yet)", file.display()))?;
    writeln!(f, "{}", network_name(network))?;
    writeln!(f, "{}", secret.account_secret().to_hex())?;
    writeln!(f, "{}", secret.view_only_secret().to_hex())?;
    f.sync_all()?;
    println!("created {}", file.display());
    println!("address: {}", secret.to_address());
    Ok(())
}

/// Loads the key file, refusing one that other users can read or that was made for another
/// network (the secrets alone would sign on any network).
fn load_key(file: &PathBuf, network: Network) -> Result<OotleSecretKey> {
    let mode = fs::metadata(file)
        .with_context(|| format!("read {} (run init first)", file.display()))?
        .permissions()
        .mode();
    ensure!(mode & 0o077 == 0, "{} must be mode 600", file.display());
    let text = fs::read_to_string(file)?;
    let [file_network, account, view] = <[&str; 3]>::try_from(text.lines().map(str::trim).collect::<Vec<_>>())
        .map_err(|_| anyhow!("key file must have three lines"))?;
    ensure!(file_network == network_name(network), "{} holds a {file_network} key, not {}", file.display(), network_name(network));
    let parse = |hex: &str| RistrettoSecretKey::from_hex(hex).map_err(|_| anyhow!("malformed key file"));
    let (account, view) = (parse(account)?, parse(view)?);
    Ok(OotleSecretKey::new(network, account, view))
}
