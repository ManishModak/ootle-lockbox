/**
 * The Launch Commitments proof: decides, from decoded substates only, whether a token was issued
 * by the pinned Launch Commitments template and what that guarantees. No network calls here, so
 * tests feed real fixtures and forgeries alike.
 *
 * Each fact is reported separately and nothing is called "safe":
 * - fixed supply: nobody can mint or burn;
 * - rules frozen: no owner, every rule and updater locked, no transfer hook;
 * - issued by Launch Commitments: a genuine record and the token name each other;
 * - allocations locked: each lock the record lists is a genuine Lockbox lock of this token
 *   holding exactly what the record says (creator-declared; it says nothing about who holds the rest).
 *
 * A component's template alone proves nothing (an upgradable component can be switched into any
 * template with fake state), so the record and every lock must also have no owner and be
 * non-upgradable. Missing or unreadable data gives "unknown", never a pass.
 */
import { cborHex, readLock, readVault, toBigInt, toEpoch, type Check } from "./verify";

type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);

/** One allocation the record says was locked at launch. */
export interface LaunchedLock {
  lock: string; // component address
  amount: bigint;
  unlockEpoch: bigint;
  beneficiary: string; // public key, 64 hex
}

/** The fields of a `LaunchRecord` component, in the template's struct order. */
export interface LaunchRecord {
  resource: string;
  supply: bigint;
  locks: LaunchedLock[];
  createdAtEpoch: bigint;
}

/** Decoded substates for one launch; a lock or vault that couldn't be read is `null`. */
export interface LaunchInputs {
  recordId: string;
  record: Json;
  resourceId: string;
  resource: Json;
  /** By lock component address: the lock and its vault. */
  locks: Map<string, { lock: Json | null; vault: Json | null }>;
}

export interface Pins {
  launchTemplate: string;
  lockboxTemplate: string;
}

export type Fact = "yes" | "no" | "unknown";

export interface LaunchProof {
  fixedSupply: Fact;
  rulesFrozen: Fact;
  issued: Fact;
  allocationsLocked: Fact;
  record: LaunchRecord | null;
  checks: Check[];
}

/** Addresses in raw component state are tagged byte strings: 128 component, 131 resource. */
function taggedAddress(x: Json, tag: number, prefix: string): string | null {
  if (!isObj(x) || x["@cbor"] !== "tag" || x.tag !== tag) return null;
  const hex = cborHex(x.value);
  return hex && /^[0-9a-f]{64}$/.test(hex) ? `${prefix}${hex}` : null;
}

function parseRecord(body: Json): LaunchRecord | null {
  const s = isObj(body) && Array.isArray(body.state) ? body.state : null;
  if (!s || s.length !== 4 || !Array.isArray(s[2])) return null;
  const resource = taggedAddress(s[0], 131, "resource_");
  const supply = toBigInt(s[1]);
  const createdAtEpoch = toEpoch(s[3]);
  if (!resource || supply === null || createdAtEpoch === null) return null;
  const locks: LaunchedLock[] = [];
  for (const l of s[2]) {
    if (!Array.isArray(l) || l.length !== 4) return null;
    const lock = taggedAddress(l[0], 128, "component_");
    const amount = toBigInt(l[1]);
    const unlockEpoch = toEpoch(l[2]);
    const beneficiary = cborHex(l[3]);
    if (!lock || amount === null || unlockEpoch === null || !beneficiary || !/^[0-9a-f]{64}$/.test(beneficiary)) return null;
    locks.push({ lock, amount, unlockEpoch, beneficiary });
  }
  return { resource, supply, locks, createdAtEpoch };
}

/** Header checks for a record: pinned template, no owner, never upgradable, only `info` callable. */
function recordChecks(value: Json, template: string): { checks: Check[]; record: LaunchRecord | null } {
  const comp = isObj(value) && isObj(value.Component) ? value.Component : null;
  const header = comp && isObj(comp.header) ? comp.header : null;
  if (!comp || !header) return { checks: [{ ok: false, label: "The launch record is not a component" }], record: null };
  const rules = header.access_rules;
  const onlyInfo =
    isObj(rules) &&
    rules.default === "DenyAll" &&
    isObj(rules.method_access) &&
    Object.keys(rules.method_access).join() === "info" &&
    rules.method_access.info === "AllowAll";
  const record = parseRecord(comp.body);
  const checks: Check[] = [
    { ok: String(header.template_address ?? "").toLowerCase() === template.toLowerCase(), label: "The record runs the Launch Commitments template" },
    { ok: header.owner_rule === "None", label: "The record has no owner" },
    { ok: header.upgrade_rule === "Locked", label: "The record can never be upgraded", detail: "an upgradable component can fake being a record" },
    { ok: onlyInfo, label: "The record is read-only" },
    { ok: record !== null, label: "The record is readable" },
  ];
  return { checks: checks.map(dropDetailIfOk), record };
}

const dropDetailIfOk = (c: Check): Check => (c.ok ? { ok: true, label: c.label } : c);

/** Every rule a launched token has: only withdraw and deposit open, everything locked. */
const LAUNCHED_RULES: Record<string, string> = {
  mint: "DenyAll",
  mint_updater: "Locked",
  burn: "DenyAll",
  burn_updater: "Locked",
  recall: "DenyAll",
  recall_updater: "Locked",
  withdraw: "AllowAll",
  withdraw_updater: "Locked",
  deposit: "AllowAll",
  deposit_updater: "Locked",
  update_nft_data: "DenyAll",
  nft_data_updater: "Locked",
  freeze: "DenyAll",
  freeze_updater: "Locked",
  update_metadata: "DenyAll",
  metadata_updater: "Locked",
  auth_hook_updater: "Locked",
};

function sameRules(rules: Json): boolean {
  if (!isObj(rules)) return false;
  const keys = Object.keys(rules);
  return keys.length === Object.keys(LAUNCHED_RULES).length && keys.every((k) => rules[k] === LAUNCHED_RULES[k]);
}

/** Runs every check and folds them into the four facts. */
export function launchProof(input: LaunchInputs, pins: Pins): LaunchProof {
  const { checks, record } = recordChecks(input.record, pins.launchTemplate);
  const recordOk = checks.every((c) => c.ok);

  const r = isObj(input.resource) && isObj(input.resource.Resource) ? input.resource.Resource : null;
  const meta = r && isObj(r.metadata) ? r.metadata : {};
  const supply = r ? toBigInt(r.total_supply) : null;
  const ownerless = r?.owner_rule === "None";
  const rulesExact = r ? sameRules(r.access_rules) : false;
  const noHook = r !== null && "auth_hook" in r && r.auth_hook === null;
  const fungible18 = r?.resource_type === "Fungible" && r?.divisibility === 18;

  const tokenChecks: Check[] = [
    { ok: r !== null, label: "The token is readable" },
    { ok: ownerless, label: "The token has no owner" },
    { ok: rulesExact, label: "Only withdraw and deposit are open, and no rule can ever change" },
    { ok: noHook, label: "No transfer hook" },
    { ok: fungible18, label: "A fungible token with 18 decimals" },
    { ok: record !== null && meta.launched_by === input.recordId && record.resource === input.resourceId, label: "The record and the token name each other" },
    { ok: record !== null && supply !== null && supply === record.supply, label: "The supply matches the record" },
  ];
  checks.push(...tokenChecks);

  const fixedSupply: Fact = r === null ? "unknown" : ownerless && rulesExact ? "yes" : "no";
  const rulesFrozen: Fact = r === null ? "unknown" : ownerless && rulesExact && noHook ? "yes" : "no";
  const issued: Fact = recordOk && tokenChecks.every((c) => c.ok) ? "yes" : record === null || r === null ? "unknown" : "no";

  let allocationsLocked: Fact = issued === "yes" ? "yes" : issued;
  if (record && issued === "yes") {
    for (const want of record.locks) {
      const got = input.locks.get(want.lock);
      const result = lockMatches(want, got, input, pins);
      checks.push(result.check);
      if (result.fact !== "yes" && allocationsLocked !== "no") allocationsLocked = result.fact;
    }
  }
  return { fixedSupply, rulesFrozen, issued, allocationsLocked, record, checks };
}

/** A listed lock must be a genuine Lockbox lock of this token holding exactly what the record says. */
function lockMatches(
  want: LaunchedLock,
  got: { lock: Json | null; vault: Json | null } | undefined,
  input: LaunchInputs,
  pins: Pins,
): { fact: Fact; check: Check } {
  const label = `Lock ${want.lock.slice(10, 22)} holds what the record says`;
  if (!got?.lock) return { fact: "unknown", check: { ok: false, label, detail: "the lock could not be read" } };
  const reading = readLock(got.lock, pins.lockboxTemplate);
  const s = reading.state;
  if (!reading.genuine || !s) return { fact: "no", check: { ok: false, label, detail: "not a genuine Lockbox lock" } };
  const vault = got.vault ? readVault(got.vault) : null;
  if (!vault) return { fact: "unknown", check: { ok: false, label, detail: "the lock's vault could not be read" } };
  const mismatch = [
    vault.resource !== input.resourceId && "it holds a different token",
    s.lockedAmount !== want.amount && "the locked amount differs",
    s.unlockEpoch !== want.unlockEpoch && "the unlock epoch differs",
    s.beneficiary !== want.beneficiary && "the beneficiary differs",
    s.memo !== `launch ${input.recordId}` && "it was not made by this launch",
  ].filter((x): x is string => typeof x === "string");
  return mismatch.length === 0
    ? { fact: "yes", check: { ok: true, label } }
    : { fact: "no", check: { ok: false, label, detail: mismatch.join("; ") } };
}
