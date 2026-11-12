//! Shared pieces of the Ootle CLIs (lockbox-cli here, launch-cli in Launch Commitments): the
//! network and key file, connecting to the indexer, and `run`, which dry-runs a transaction and
//! sends it only with `--submit`.
//!
//! The key lives in `~/.config/secrets/ootle-lockbox-<network>.key` (mode 600; lines: network
//! name, account secret hex, view secret hex) and is never printed.

use std::{
    collections::HashSet,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
pub use ootle_rs::Network;
use ootle_rs::{
    TransactionRequest,
    builtin_templates::{
        UnsignedTransactionBuilder,
        component::{ComponentInvokeBuilder, IComponent, TransactionBuildable},
    },
    default_indexer_url,
    key_provider::PrivateKeyProvider,
    keys::OotleSecretKey,
    provider::{IndexerProvider, Provider as _, ProviderBuilder, WalletProvider, WantInput},
    stealth::StealthTransfer,
    template_types::{
        Amount,
        ComponentAddress,
        UtxoAddress,
        constants::TARI_TOKEN,
        crypto::{PedersenCommitmentBytes, RistrettoPublicKeyBytes},
    },
    wallet::OotleWallet,
};
use tari_crypto::{ristretto::RistrettoSecretKey, tari_utilities::hex::Hex};
use tari_ootle_transaction::{Epoch, Transaction};

/// Most a transaction may reserve, and so spend, on network fees: 5 TARI, in µT.
pub const MAX_FEE: u64 = 5_000_000;
/// How many epochs ahead a transaction may still be sequenced.
const EPOCH_WINDOW: u64 = 10;

pub type Provider = IndexerProvider<OotleWallet>;
pub type Builder<'p> = ComponentInvokeBuilder<'p, Provider>;

/// `esmeralda` or `mainnet`.
pub fn parse_network(name: &str) -> Result<Network> {
    match name {
        "esmeralda" => Ok(Network::Esmeralda),
        "mainnet" => Ok(Network::MainNet),
        other => bail!("unknown network {other}"),
    }
}

fn network_name(network: Network) -> &'static str {
    match network {
        Network::MainNet => "mainnet",
        _ => "esmeralda",
    }
}

pub fn key_path(network: Network) -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    Ok(PathBuf::from(home).join(format!(".config/secrets/ootle-lockbox-{}.key", network_name(network))))
}

/// Creates a fresh random key file with mode 600. Refuses if one exists.
pub fn init_key(file: &Path, network: Network) -> Result<()> {
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
pub fn load_key(file: &Path, network: Network) -> Result<OotleSecretKey> {
    let mode = fs::metadata(file)
        .with_context(|| format!("read {} (create it with lockbox-cli <network> init)", file.display()))?
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

/// An indexer connection signing with the key file's key, and the current epoch.
pub struct Session {
    pub provider: Provider,
    pub epoch: u64,
}

impl Session {
    pub async fn connect(secret: OotleSecretKey, network: Network) -> Result<Self> {
        let provider = ProviderBuilder::new()
            .wallet(OotleWallet::from(PrivateKeyProvider::new(secret)))
            .connect_with_transaction_timeout(default_indexer_url(network), Duration::from_secs(180))
            .await
            .context("connect to indexer")?;
        let epoch = provider.get_epoch().await?.as_u64();
        Ok(Self { provider, epoch })
    }

    /// Builds `instructions` with `account` paying the network fee and the provider filling in
    /// the inputs they need, dry-runs it, prints the fee, and with `submit` sends exactly that
    /// transaction. `spend` is the TARI the instructions themselves withdraw, kept out of the fee
    /// reservation. Fails unless the transaction fully commits.
    pub async fn run<F>(mut self, account: ComponentAddress, spend: Amount, submit: bool, instructions: F) -> Result<()>
    where
        F: FnOnce(Builder<'_>) -> Builder<'_>,
    {
        let provider = &mut self.provider;
        let tari = provider.get_account_balance(account, TARI_TOKEN).await?;
        let available = tari
            .checked_sub(spend)
            .filter(Amount::is_positive)
            .ok_or_else(|| anyhow!("the account holds {tari} µT, not enough for {spend} µT plus fees"))?;
        let reserve = available.to_u64_checked().map_or(MAX_FEE, |a| a.min(MAX_FEE));
        // A fresh nonce keeps two identical commands from producing the same transaction id.
        let nonce: u64 = rand::random();
        let max_epoch = Epoch(self.epoch + EPOCH_WINDOW);
        let tx = instructions(IComponent::new(provider, max_epoch).pay_fee(reserve).then(|t| t.with_nonce(nonce)))
            .prepare()
            .await?;

        let dry = provider.sign_and_send_dry_run(tx.clone()).await?;
        if let Some(reason) = dry.finalize.any_reject() {
            bail!("dry run rejected: {reason}");
        }
        // Dry runs are not rejected for an insufficient fee, so check the reservation covers it.
        let fee = dry.finalize.required_fees();
        ensure!(fee <= reserve, "the transaction needs {fee} µT in fees but only {reserve} µT is reserved");
        println!("dry run ok; network fee {fee} µT ({:.6} TARI) of {reserve} µT reserved", fee as f64 / 1e6);
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

    /// Moves a stealth TARI UTXO owned by this key (wallets such as Tari Universe send stealth
    /// TARI) into this key's public account, creating the account if needed. The whole `value`
    /// is revealed; `fee` of it pays the network fee (an overpayment is kept by validators, so
    /// pass about what the dry run reports) and the rest is deposited.
    pub async fn fund_from_stealth(
        mut self,
        owner: ootle_rs::Address,
        public_key: RistrettoPublicKeyBytes,
        account: ComponentAddress,
        commitment: &str,
        value: u64,
        fee: u64,
        submit: bool,
    ) -> Result<()> {
        ensure!(fee < value, "the fee {fee} µT must be below the UTXO value {value} µT");
        // The fee bucket is never refunded, so a typo here would be lost: cap it like `run` does.
        ensure!(fee <= MAX_FEE, "the fee {fee} µT is above the {MAX_FEE} µT limit");
        let provider = &self.provider;
        let commitment =
            PedersenCommitmentBytes::from_hex(commitment).map_err(|e| anyhow!("bad commitment: {e:?}"))?;
        let (statement, signers) = StealthTransfer::new(TARI_TOKEN, provider)
            .spend_stealth_input(owner, commitment)
            .to_revealed_output(value)
            .prepare()
            .await
            .context("prepare the stealth spend (is this UTXO ours, and is the value exact?)")?;
        let nonce: u64 = rand::random();
        let tx = Transaction::builder(provider.network(), Epoch(self.epoch + EPOCH_WINDOW))
            .with_fee_instructions_builder(|b| {
                b.stealth_transfer(TARI_TOKEN, statement)
                    .put_last_instruction_output_on_workspace("all")
                    .take_from_bucket("all", fee, "fee")
                    .pay_fee_from_bucket("fee")
                    .create_account_with_bucket(public_key, "all")
            })
            .add_input(TARI_TOKEN)
            .add_input(UtxoAddress::new(TARI_TOKEN, commitment.into()))
            .with_nonce(nonce)
            .build_unsigned();
        // If the account already exists, CreateAccount deposits into it and needs it and its
        // TARI vault as inputs; both stay optional so a first deposit still creates them.
        let wants = HashSet::from([
            WantInput::SpecificSubstate { substate_id: account.into(), required: false },
            WantInput::VaultForResource { component_address: account, resource_address: TARI_TOKEN, required: false },
        ]);
        let tx = provider.resolve_input_want_list(tx, &wants).await?;
        let authorizer = provider.wallet().stealth_authorizer(signers);

        let dry = provider.sign_and_send_dry_run_with(&authorizer, tx.clone()).await?;
        if let Some(reason) = dry.finalize.any_reject() {
            bail!("dry run rejected: {reason}");
        }
        let required = dry.finalize.required_fees();
        println!("dry run ok; network fee {required} µT, paying {fee} µT; {} µT goes to {account}", value - fee);
        ensure!(required <= fee, "the transaction needs {required} µT in fees but only {fee} µT is paid");
        if !submit {
            println!("not sent (add --submit to send)");
            return Ok(());
        }
        let signed = TransactionRequest::default().with_transaction(tx).build(&authorizer).await?;
        let pending = self.provider.send_transaction(signed).await?;
        println!("sent {}", pending.tx_id());
        let outcome = pending.watch().await?;
        ensure!(outcome.is_commit(), "transaction {} did not commit: {outcome:?}", pending.tx_id());
        let receipt = pending.get_receipt().await?;
        println!("committed in epoch {}, fee paid {} µT", receipt.epoch, receipt.fee_receipt.total_fees_paid());
        Ok(())
    }

    /// Publishes the template WASM at `wasm`, paid from `account`.
    pub async fn publish(self, account: ComponentAddress, wasm: &str, submit: bool) -> Result<()> {
        let binary = fs::read(wasm).with_context(|| format!("read {wasm}"))?;
        println!("template size: {} bytes", binary.len());
        self.run(account, Amount::zero(), submit, |b| b.then(|t| t.publish_template(binary))).await
    }

    /// Prints the epoch and every balance of `account`.
    pub async fn print_status(&self, account: ComponentAddress) -> Result<()> {
        println!("epoch: {}", self.epoch);
        for (resource, balance) in self.provider.get_account_balances(account).await? {
            println!("{resource}: {balance}");
        }
        Ok(())
    }
}
