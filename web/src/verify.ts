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

/** One line on a proof page: passed or not, with a plain-language reason. */
export interface Check {
  ok: boolean;
  label: string;
  detail?: string;
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

export interface LockReading {
  checks: Check[];
  genuine: boolean;
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
  /** Things the issuer can still do that would undo or block a lock. Empty = safe to lock. */
  lockRisks: string[];
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

/** Reads the component's header and state. Unknown shapes fail closed (genuine = false). */
export function readLock(value: Json, lockboxTemplate: string): LockReading {
  const checks: Check[] = [];
  const comp = isObj(value) && isObj(value.Component) ? value.Component : null;
  const header = comp && isObj(comp.header) ? comp.header : null;
  if (!comp || !header) {
    return { checks: [{ ok: false, label: "This address is not a component" }], genuine: false, state: null };
  }

  const template = String(header.template_address ?? "").toLowerCase();
  checks.push({
    ok: template === lockboxTemplate.toLowerCase(),
    label: "Runs the Lockbox template",
    detail: template === lockboxTemplate.toLowerCase() ? undefined : `template ${template || "unknown"}`,
  });
  checks.push({
    ok: header.owner_rule === "None",
    label: "Has no owner",
    detail: header.owner_rule === "None" ? undefined : "an owner could bypass its rules",
  });
  checks.push({
    ok: header.upgrade_rule === "Locked",
    label: "Can never be upgraded",
    detail: header.upgrade_rule === "Locked" ? undefined : "an upgradable component can fake being a Lockbox",
  });

  const state = parseState(comp.body);
  checks.push({ ok: state !== null, label: "Lock data is readable" });
  if (state) {
    const validKey = isValidPublicKey(state.beneficiary);
    checks.push({
      ok: validKey,
      label: "The beneficiary key is a real public key",
      detail: validKey ? undefined : "nobody can ever sign for it, so the tokens can't be claimed",
    });
    const ok = claimRuleBindsTo(header.access_rules, state.beneficiary);
    checks.push({
      ok,
      label: "Only the beneficiary can claim",
      detail: ok ? undefined : "the claim rule does not match the stored beneficiary",
    });
  }
  return { checks, genuine: checks.every((c) => c.ok), state };
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

/** `claim` must require exactly the beneficiary's public-key badge; `default` must deny. Anything else fails. */
function claimRuleBindsTo(rules: Json, beneficiary: string): boolean {
  if (!isObj(rules) || rules.default !== "DenyAll" || !isObj(rules.method_access)) return false;
  const methods = rules.method_access;
  const extra = Object.keys(methods).filter((m) => m !== "claim" && m !== "info");
  if (extra.length > 0) return false;
  const r = methods.claim;
  const nf =
    isObj(r) && isObj(r.Restricted) && isObj(r.Restricted.Require) && isObj(r.Restricted.Require.Require)
      ? r.Restricted.Require.Require.NonFungibleAddress
      : null;
  if (!isObj(nf) || nf.resource_address !== PUBLIC_KEY_BADGE_RESOURCE || !isObj(nf.id)) return false;
  return typeof nf.id.U256 === "string" && nf.id.U256.toLowerCase() === beneficiary;
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
 * What the token's issuer can still do. An updater of "Owner" is unreachable when the resource
 * has no owner, so it counts as locked.
 */
export function readResource(value: Json): ResourceReading | null {
  const r = isObj(value) && isObj(value.Resource) ? value.Resource : null;
  const rules = r && isObj(r.access_rules) ? r.access_rules : null;
  if (!r || !rules) return null;
  const ownerless = r.owner_rule === "None";
  const locked = (updater: Json) => updater === "Locked" || (updater === "Owner" && ownerless);
  const fixed = (rule: string, want: string) => rules[rule] === want && locked(rules[`${rule}_updater`]);

  const lockRisks: string[] = [];
  if (!ownerless) lockRisks.push("The token has an owner, who can bypass its rules (for example mint or freeze).");
  if (!fixed("recall", "DenyAll")) lockRisks.push("The issuer can recall tokens, including out of a lock.");
  if (!fixed("freeze", "DenyAll")) lockRisks.push("The issuer can freeze vaults, including a lock's vault.");
  if (!fixed("withdraw", "AllowAll")) lockRisks.push("Withdrawals are restricted, so a claim could be blocked.");
  if (!fixed("deposit", "AllowAll")) lockRisks.push("Deposits are restricted, so claimed tokens could be refused.");
  if (!("auth_hook" in r)) lockRisks.push("The token's transfer-hook setting could not be read.");
  else if (r.auth_hook !== null) lockRisks.push("A hook contract can veto transfers.");
  else if (!locked(rules.auth_hook_updater)) lockRisks.push("A transfer hook can still be added later.");

  const notes: string[] = [];
  if (!fixed("mint", "DenyAll")) notes.push("More tokens can be minted, so supply can grow.");
  if (!locked(rules.metadata_updater) || rules.update_metadata !== "DenyAll") notes.push("Name and metadata can change.");

  const meta = isObj(r.metadata) ? r.metadata : {};
  const str = (x: Json) => (typeof x === "string" ? x : null);
  return {
    type: String(r.resource_type ?? "unknown"),
    symbol: str(meta.SYMBOL) ?? str(meta.symbol),
    name: str(meta.name) ?? str(meta.NAME),
    launchedBy: str(meta.launched_by),
    divisibility: typeof r.divisibility === "number" ? r.divisibility : 0,
    totalSupply: r.total_supply === null ? null : toBigInt(r.total_supply),
    lockRisks,
    notes,
  };
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
