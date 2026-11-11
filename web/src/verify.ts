/**
 * Pure checks behind every Lockbox page: parse a decoded lock component, vault and resource, and
 * decide what a viewer can trust. No network calls here, so tests can feed real fixtures.
 *
 * Trust model: a lock is genuine only if its component runs the pinned Lockbox template AND has no
 * owner AND cannot be upgraded. A component with an upgradable rule can be switched into the
 * Lockbox template with fake state (engine `UpdateComponentTemplate`), so the template alone proves
 * nothing. The token's own rules decide whether its issuer can still undo a lock.
 */
import { isValidPublicKey } from "./newlock";

/**
 * One line on a proof page: passed or not, with a plain-language reason. `unknown` marks a check
 * that didn't pass only because its data couldn't be read; it still never counts as passed.
 */
export interface Check {
  ok: boolean;
  label: string;
  detail?: string;
  unknown?: boolean;
}

/** The fields of a `Lockbox` component, in the template's struct order. */
export interface LockState {
  vault: string;
  beneficiary: string; // public key, 64 hex chars
  unlockEpoch: bigint; // u64 on chain; kept exact, since a valid lock may name any future epoch
  lockedAtEpoch: bigint;
  lockedAmount: bigint;
  memo: string;
  claimed: boolean;
}

/** A three-way verdict: an observed contradiction is "no", missing data is "unknown". */
export type Fact = "yes" | "no" | "unknown";

export interface LockReading {
  checks: Check[];
  genuine: boolean;
  /** Like `genuine`, but "unknown" when every failed check failed only because its header field is missing. */
  provenance: Fact;
  state: LockState | null;
}

/** What a vault holds right now. `amount` is null for NFT vaults (counted in `nftCount`). */
export interface VaultBalance {
  resource: string;
  amount: bigint | null;
  nftCount: number | null;
}

export interface ResourceReading {
  type: string;
  symbol: string | null;
  name: string | null;
  /** The `launched_by` metadata a Launch Commitments token carries; a claim to check, not a fact. */
  launchedBy: string | null;
  divisibility: number;
  totalSupply: bigint | null;
  /** Things the issuer can still do that would undo or block a lock. */
  lockRisks: string[];
  /** Rules that decide whether a lock holds but couldn't be read. Blocks "verified" like a risk. */
  unreadable: string[];
  /** Facts worth knowing that don't affect a lock (e.g. supply can grow). */
  notes: string[];
}

export type LockStatus = "locked" | "claimable" | "claimed";

type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Accepts the numeric shapes the decoder produces: number, bigint, decimal string, or (in raw
 * component state) a CBOR positive bignum, tag 2, used for values of 2^64 and above.
 */
export function toBigInt(x: Json): bigint | null {
  if (typeof x === "bigint") return x;
  if (typeof x === "number" && Number.isSafeInteger(x)) return BigInt(x);
  if (typeof x === "string" && /^\d+$/.test(x)) return BigInt(x);
  if (isObj(x) && x["@cbor"] === "tag" && x.tag === 2 && isObj(x.value) && x.value["@cbor"] === "bytes") {
    const hex = x.value.hex;
    if (typeof hex === "string" && /^([0-9a-f]{2})*$/i.test(hex)) return hex === "" ? 0n : BigInt(`0x${hex}`);
  }
  return null;
}

const U64_MAX = 2n ** 64n - 1n;

export function toEpoch(x: Json): bigint | null {
  const b = toBigInt(x);
  return b !== null && b >= 0n && b <= U64_MAX ? b : null;
}

/** `{"@cbor":"bytes","hex":...}`, optionally wrapped in a CBOR tag, to a hex string. */
export function cborHex(x: Json): string | null {
  if (!isObj(x)) return null;
  if (x["@cbor"] === "tag") return cborHex(x.value);
  if (x["@cbor"] === "bytes" && typeof x.hex === "string") return x.hex.toLowerCase();
  return null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The engine's virtual resource whose NFT ids are public keys: `Require(this badge)` = "signed by this key". */
export const PUBLIC_KEY_BADGE_RESOURCE = "resource_0100000000000000000000000000000000000000000000000000000000000000";

/**
 * Reads the component's header and state. Unknown shapes fail closed (genuine = false);
 * `provenance` also says whether a failure is an observed contradiction or only missing data.
 */
export function readLock(value: Json, lockboxTemplate: string): LockReading {
  const comp = isObj(value) && isObj(value.Component) ? value.Component : null;
  const header = comp && isObj(comp.header) ? comp.header : null;
  if (!comp || !header) {
    return { checks: [{ ok: false, label: "This address is not a component" }], genuine: false, provenance: "no", state: null };
  }
  // Each check is three-way: null means the data it reads is missing, which isn't a contradiction.
  const results: Tri[] = [];
  const checks: Check[] = [];
  const add = (ok: Tri, label: string, detail?: string) => {
    results.push(ok);
    checks.push(ok === null ? { ok: false, label, detail: "could not be read", unknown: true } : { ok, label, detail: ok ? undefined : detail });
  };
  const when = (k: string, cond: (v: Json) => boolean): Tri => (header[k] === undefined ? null : cond(header[k]));

  const template = String(header.template_address ?? "").toLowerCase();
  add(when("template_address", () => template === lockboxTemplate.toLowerCase()), "Runs the Lockbox template", `template ${template}`);
  add(when("owner_rule", (o) => o === "None"), "Has no owner", "an owner could bypass its rules");
  add(when("upgrade_rule", (u) => u === "Locked"), "Can never be upgraded", "an upgradable component can fake being a Lockbox");

  const state = parseState(comp.body);
  add(comp.body === undefined ? null : state !== null, "Lock data is readable");
  if (state) {
    add(isValidPublicKey(state.beneficiary), "The beneficiary key is a real public key", "nobody can ever sign for it, so the tokens can't be claimed");
    add(claimRuleBindsTo(header.access_rules, state.beneficiary), "Only the beneficiary can claim", "the claim rule does not match the stored beneficiary");
  }
  const genuine = results.every((r) => r === true);
  return { checks, genuine, provenance: genuine ? "yes" : results.includes(false) ? "no" : "unknown", state };
}

function parseState(body: Json): LockState | null {
  const s = isObj(body) && Array.isArray(body.state) ? body.state : null;
  if (!s || s.length !== 7) return null;
  const vaultHex = cborHex(s[0]);
  const beneficiary = cborHex(s[1]);
  const unlockEpoch = toEpoch(s[2]);
  const lockedAtEpoch = toEpoch(s[3]);
  const lockedAmount = toBigInt(s[4]);
  if (!vaultHex || !beneficiary || !HEX64.test(beneficiary) || unlockEpoch === null || lockedAtEpoch === null) return null;
  if (lockedAmount === null || typeof s[5] !== "string" || typeof s[6] !== "boolean") return null;
  return {
    vault: `vault_${vaultHex}`,
    beneficiary,
    unlockEpoch,
    lockedAtEpoch,
    lockedAmount,
    memo: s[5],
    claimed: s[6],
  };
}

/** A check's outcome: passed, failed, or null when the data it reads is missing. */
type Tri = boolean | null;

const CONTRADICTION = Symbol("contradiction");

/**
 * Follows `path` into `x`. Returns the value, undefined when a field on the way is absent (missing
 * data), or CONTRADICTION when a step isn't an object. A step written `=Name` is an enum variant:
 * an object holding a different variant is a contradiction, not missing data.
 */
function dig(x: Json, path: string[]): Json | typeof CONTRADICTION {
  for (const step of path) {
    if (x === undefined) return undefined;
    if (!isObj(x)) return CONTRADICTION;
    const key = step.replace(/^=/, "");
    if (step.startsWith("=") && !(key in x) && Object.keys(x).length > 0) return CONTRADICTION;
    x = x[key];
  }
  return x;
}

/** `cond(dig(x, path))`, three-way. */
function at(x: Json, path: string[], cond: (v: Json) => boolean): Tri {
  const v = dig(x, path);
  return v === undefined ? null : v === CONTRADICTION ? false : cond(v);
}

/**
 * `claim` must require exactly the beneficiary's public-key badge, `default` must deny, and no
 * other method may be open. Any explicit difference is false; a missing field is null.
 */
function claimRuleBindsTo(rules: Json, beneficiary: string): Tri {
  const nf = ["method_access", "claim", "=Restricted", "=Require", "=Require", "=NonFungibleAddress"];
  const parts = [
    at(rules, ["default"], (d) => d === "DenyAll"),
    at(rules, ["method_access"], (m) => isObj(m) && Object.keys(m).every((k) => k === "claim" || k === "info")),
    at(rules, [...nf, "resource_address"], (a) => a === PUBLIC_KEY_BADGE_RESOURCE),
    at(rules, [...nf, "id", "=U256"], (u) => typeof u === "string" && u.toLowerCase() === beneficiary),
  ];
  return parts.includes(false) ? false : parts.includes(null) ? null : true;
}

/**
 * Live balance of a vault substate (Fungible, Stealth or Confidential revealed part, or NFT).
 * Any other container shape returns null, which pages show as "unable to verify".
 */
export function readVault(value: Json): VaultBalance | null {
  const v = isObj(value) && isObj(value.Vault) ? value.Vault : null;
  const rc = v && isObj(v.resource_container) ? v.resource_container : null;
  if (!rc || Object.keys(rc).length !== 1) return null;
  const [kind, inner] = Object.entries(rc)[0];
  if (!["Fungible", "Stealth", "Confidential", "NonFungible"].includes(kind)) return null;
  if (!isObj(inner) || typeof inner.address !== "string") return null;
  if (kind === "NonFungible") {
    const ids = inner.token_ids;
    const n = Array.isArray(ids) ? ids.length : isObj(ids) ? Object.keys(ids).length : null;
    return { resource: inner.address, amount: null, nftCount: n };
  }
  const amount = toBigInt(kind === "Fungible" ? inner.amount : inner.revealed_amount);
  return amount === null ? null : { resource: inner.address, amount, nftCount: null };
}

/**
 * What the token's issuer can still do (`lockRisks`) and which of its rules couldn't be read
 * (`unreadable`). Each rule is three-way: a permissive value is a power, a missing value is
 * unreadable, never a power. An updater of "Owner" is unreachable when the resource has no owner,
 * so it counts as locked; with the owner rule unreadable, it is unreadable too.
 */
export function readResource(value: Json): ResourceReading | null {
  const r = isObj(value) && isObj(value.Resource) ? value.Resource : null;
  const rules = r && isObj(r.access_rules) ? r.access_rules : null;
  if (!r || !rules) return null;
  const ownerless: Tri = r.owner_rule === undefined ? null : r.owner_rule === "None";
  const locked = (updater: Json): Tri => (updater === undefined ? null : updater === "Locked" ? true : updater === "Owner" ? ownerless : false);
  const lockRisks: string[] = [];
  const unreadable: string[] = [];
  const both = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
  // A rule is fixed when it holds `want` and can never change; `name` words what couldn't be read.
  const fixed = (rule: string, want: string, name: string, power: string) => {
    const value: Tri = rules[rule] === undefined ? null : rules[rule] === want;
    const ok = both(value, locked(rules[`${rule}_updater`]));
    if (ok === false) lockRisks.push(power);
    else if (ok === null) unreadable.push(value === null ? `The token's ${name} rule could not be read.` : `Whether the token's ${name} rule can change could not be read.`);
  };

  if (ownerless === false) lockRisks.push("The token has an owner, who can bypass its rules (for example mint or freeze).");
  else if (ownerless === null) unreadable.push("The token's owner rule could not be read.");
  fixed("recall", "DenyAll", "recall", "The issuer can recall tokens, including out of a lock.");
  fixed("freeze", "DenyAll", "freeze", "The issuer can freeze vaults, including a lock's vault.");
  fixed("withdraw", "AllowAll", "withdraw", "Withdrawals are restricted, so a claim could be blocked.");
  fixed("deposit", "AllowAll", "deposit", "Deposits are restricted, so claimed tokens could be refused.");
  if (!("auth_hook" in r)) unreadable.push("The token's transfer-hook setting could not be read.");
  else if (r.auth_hook !== null) lockRisks.push("A hook contract can veto transfers.");
  else {
    const hookLocked = locked(rules.auth_hook_updater);
    if (hookLocked === false) lockRisks.push("A transfer hook can still be added later.");
    else if (hookLocked === null) unreadable.push("Whether a transfer hook can be added later could not be read.");
  }

  // Notes never affect a lock; a missing rule is still worded as unread, not as a power.
  const notes: string[] = [];
  const mint = both(rules.mint === undefined ? null : rules.mint === "DenyAll", locked(rules.mint_updater));
  if (mint === false) notes.push("More tokens can be minted, so supply can grow.");
  else if (mint === null) notes.push("Whether more tokens can be minted could not be read.");
  const meta = both(rules.update_metadata === undefined ? null : rules.update_metadata === "DenyAll", locked(rules.metadata_updater));
  if (meta === false) notes.push("Name and metadata can change.");
  else if (meta === null) notes.push("Whether the name and metadata can change could not be read.");

  const md = isObj(r.metadata) ? r.metadata : {};
  const str = (x: Json) => (typeof x === "string" ? x : null);
  return {
    type: String(r.resource_type ?? "unknown"),
    symbol: str(md.SYMBOL) ?? str(md.symbol),
    name: str(md.name) ?? str(md.NAME),
    launchedBy: str(md.launched_by),
    divisibility: typeof r.divisibility === "number" ? r.divisibility : 0,
    totalSupply: r.total_supply === null ? null : toBigInt(r.total_supply),
    lockRisks,
    unreadable,
    notes,
  };
}

/** True only when nothing can undo a lock: no issuer power and no unread rule. */
export function tokenLockSafe(r: Pick<ResourceReading, "lockRisks" | "unreadable">): boolean {
  return r.lockRisks.length === 0 && r.unreadable.length === 0;
}

/** Locked until the epoch; then claimable until claimed. A claimed lock's vault is empty. */
export function lockStatus(state: LockState, currentEpoch: number): LockStatus {
  if (state.claimed) return "claimed";
  return BigInt(currentEpoch) < state.unlockEpoch ? "locked" : "claimable";
}

/** Amount in atomic units -> decimal text, exact (no floating point). */
export function formatAmount(amount: bigint, divisibility: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  if (divisibility === 0) return `${neg ? "-" : ""}${groupThousands(abs.toString())}`;
  const s = abs.toString().padStart(divisibility + 1, "0");
  const whole = s.slice(0, -divisibility);
  const frac = s.slice(-divisibility).replace(/0+$/, "");
  return `${neg ? "-" : ""}${groupThousands(whole)}${frac ? `.${frac}` : ""}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Decimal text -> atomic units. Rejects more decimals than the token allows. */
export function parseAmount(text: string, divisibility: number): bigint | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > divisibility) return null;
  return BigInt(m[1] + frac.padEnd(divisibility, "0"));
}

/** Locked share of supply: live balances of still-locked locks over tracked supply. */
export function lockedShare(locked: bigint, totalSupply: bigint | null): string | null {
  if (totalSupply === null || totalSupply <= 0n) return null;
  const bp = (locked * 10000n) / totalSupply; // basis points, rounded down
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}%`;
}
