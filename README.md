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
locked, and there is no auth hook. Verifiers should also check that the lock
component runs the Lockbox template address **and** has no owner and a `Locked` upgrade rule: any template can emit
an event with the same name, and a component whose upgrade rule allows it can be switched into the Lockbox template
with fake state. Lockbox components are always created ownerless and non-upgradable, so genuine locks pass.

**Epochs, not dates.** Ootle templates can't read the clock, so a lock opens at an epoch. An epoch is a fixed
number of base-layer blocks (10 on mainnet, about 20 minutes), so dates are estimates. The web app turns a chosen
time into an epoch assuming epochs last at least 18 minutes, so a lock usually opens a little after that time. This
is an assumption, not a guarantee: if blocks come faster for long enough, the lock opens earlier. Ootle derives the epoch as `block height / epoch length`; if Tari ever changes the epoch length, epoch numbers
jump and locks would open at a different time.

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

## Web app

`web/` is a static site (Vite + TypeScript) that reads the public indexer and signs with the
[Sapient](https://github.com/chironbuilds/tari-wallet) wallet extension. Pages: recent locks, a proof page per lock
(`#/<network>/lock/<component>`), a token page with its issuer's powers and locked share
(`#/<network>/token/<resource>`), and lock creation and claiming. The verification rules live in `web/src/verify.ts`
and are tested against real Esmeralda data.

It also hosts **Launch Commitments** (Esmeralda testnet only for now): `#/<network>/launch` launches a fixed-supply
token whose rules nobody can change and locks the chosen allocations in Lockbox in the same transaction, for a flat
fee; `#/<network>/launch/<resource>` proves those facts for any token launched that way. The template lives in its
own repository; the page's checks are in `web/src/launch.ts`.

```bash
cd web
pnpm install
pnpm test           # verifier tests
pnpm dev            # local dev server
pnpm build          # static site in web/dist
```

Every push to `main` deploys the site to GitHub Pages (`.github/workflows/pages.yml`).

## Command line

`cli/` holds `lockbox-cli`, which publishes the template and locks or claims from a local key:
`lockbox-cli <esmeralda|mainnet> <init|address|status|publish|lock|claim> [args] [--submit]`.

## Deployments

| Network | Lockbox template |
|---|---|
| Esmeralda testnet | `template_3f77a82e2eecb1795bc250ce919706519ea8feacc283d25f9e9740edc81b12b3` (9 Nov; replaced `template_d7f5ee28…` from 7 Nov, which lacked the beneficiary-key check) |
| Mainnet | published on 11 Nov 2026 (address added here) |

| Network | Launch Commitments template |
|---|---|
| Esmeralda testnet | `template_ec0b8e8bf1ad8e05e0745e66868929070358da5dd975d72cd1031befa5141a8a` |
| Mainnet | not published yet |

## Licence

MIT
