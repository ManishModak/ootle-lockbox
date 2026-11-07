# Ootle Lockbox

Time-locked vaults for tokens and LP shares on [Tari Ootle](https://ootle.tari.com).

A token team calls `Lockbox::lock(tokens, unlock_epoch, beneficiary_key, memo)`. The tokens sit in a new lock
component until `unlock_epoch`. From then on only the beneficiary key can call `claim()`, which returns the whole
balance; the beneficiary deposits it into any account in the same transaction. Before that epoch Lockbox never
releases anything: the component has no owner, no admin methods and no upgrade path. Anyone can read a lock with
`info()`, and the `Lockbox.LockCreated` / `Lockbox.LockClaimed` events carry the lock's address.

**What a lock does not cover: the token's own rules.** Ootle lets a resource's issuer keep authority to recall,
freeze or block withdrawals, and a resource owner can bypass those rules. Lockbox cannot read a resource's rules
from inside the engine, so it can't refuse such tokens. Recall is off and locked by default when a token is
created, but always check: the Lockbox web app reads each resource's rules from the indexer and marks a lock
verified only when the resource has no owner, recall is denied and locked, withdraw and deposit are open and
locked, and there is no auth hook. Verifiers should also check that the lock component was created from the
Lockbox template address, since any template can emit an event with the same name.

Accepts public fungible tokens, NFTs and the LP tokens of Ootle's built-in liquidity pools. Buckets holding blinded
confidential commitments are refused, since a claim could not move them.

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
