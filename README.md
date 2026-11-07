# Ootle Lockbox

Time-locked vaults for tokens and LP shares on [Tari Ootle](https://ootle.tari.com).

A token team calls `Lockbox::lock(tokens, unlock_epoch, beneficiary, memo)`. The tokens sit in a new lock
component until `unlock_epoch`. After that, anyone can call `claim()`, and the whole balance always goes to the
beneficiary account fixed at creation. Before that epoch nobody can move them: the component has no owner, no
admin methods and no upgrade path. Anyone can check a lock with `info()` or from the `Lockbox.LockCreated` /
`Lockbox.LockClaimed` events on the indexer.

Works for vault-held resources: public fungible tokens and the LP tokens of Ootle's built-in liquidity pools.
Stealth TARI lives in UTXOs, not vaults, so it can't be locked this way.

## Build and test

```bash
rustup target add wasm32-unknown-unknown
cargo test          # engine tests (in-process Ootle engine)
cargo build-wasm    # target/wasm32-unknown-unknown/release/ootle_lockbox.wasm
```

Built against `tari_template_lib` 0.38 (Ootle v0.50.1). Rebuild and republish after any network upgrade that
bumps the template library.

## Licence

MIT
