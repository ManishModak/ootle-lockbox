/**
 * The Launch Commitments proof: decides, from decoded substates only, whether a token was issued
 * by the pinned Launch Commitments template and what that guarantees. No network calls here, so
 * tests feed real fixtures and forgeries alike.
 *
 * Each fact is reported separately and nothing is called "safe":
 * - fixed supply: nobody can mint or burn;
 * - rules frozen: no owner, every rule and updater locked, no transfer hook;
 * - issued by Launch Commitments: a genuine record and the token name each other;
 * - locked at launch: each lock the record lists is a genuine Lockbox lock this launch made, with
 *   the recorded terms (creator-declared; it says nothing about who holds the rest).
 * What is *still* locked is a separate live number (`stillLocked`): locks open at their epoch and
 * get claimed, which is expected, not a failure.
 *
 * A component's template alone proves nothing (an upgradable component can be switched into any
 * template with fake state), so the record and every lock must also have no owner and be
 * non-upgradable. Every check is three-way: an explicit mismatch fails ("no"), a field that is
 * missing or unreadable is "unknown", and only a full set of passes is "yes".
 */
import { cborHex, lockStatus, toBigInt, toEpoch, type Check, type LockReading, type VaultBalance } from "./verify";

type Json = unknown;
const isObj = (x: Json): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The template's MAX_LOCKS: a genuine record lists 1-8 locks. */
const MAX_RECORD_LOCKS = 8;

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

/** A lock as `loadLock` reads it: checked against the pinned Lockbox template, plus its live vault. */
export interface LockInput {
  reading: LockReading;
  vault: VaultBalance | null;
}

/** Decoded substates for one launch. A lock missing from `locks` couldn't be read. */
export interface LaunchInputs {
  recordId: string;
  record: Json;
  resourceId: string;
  resource: Json;
  locks: Map<string, LockInput>;
}

export type Fact = "yes" | "no" | "unknown";

export interface LaunchProof {
  fixedSupply: Fact;
  rulesFrozen: Fact;
  issued: Fact;
  lockedAtLaunch: Fact;
  /** Live balance of the listed locks that are unclaimed and before their epoch; null if any is unreadable. */
  stillLocked: bigint | null;
  record: LaunchRecord | null;
  checks: Check[];
}

/** A check's outcome: passed, failed, or not decidable from the data. */
type Tri = boolean | null;

/** A three-way check; null (unknown) shows as failed with "could not be read". */
interface TriCheck {
  ok: Tri;
  label: string;
  detail?: string;
}

const toCheck = (c: TriCheck): Check =>
  c.ok === true ? { ok: true, label: c.label } : { ok: false, label: c.label, detail: c.ok === null ? "could not be read" : c.detail };

/** Folds checks: any explicit failure is "no", else any unknown is "unknown", else "yes". */
function fold(checks: TriCheck[]): Fact {
  if (checks.some((c) => c.ok === false)) return "no";
  if (checks.some((c) => c.ok === null)) return "unknown";
  return "yes";
}

/** `cond(x)` when field `x` is present, else unknown. */
function when<T>(x: T | undefined, cond: (x: T) => boolean): Tri {
  return x === undefined ? null : cond(x);
}

/** Addresses in raw component state are tagged byte strings: 128 component, 131 resource. */
function taggedAddress(x: Json, tag: number, prefix: string): string | null {
  if (!isObj(x) || x["@cbor"] !== "tag" || x.tag !== tag) return null;
  const hex = cborHex(x.value);
  return hex && /^[0-9a-f]{64}$/.test(hex) ? `${prefix}${hex}` : null;
}

/** The record's fields, or null if they aren't the shape the template writes (1-8 distinct locks). */
function parseRecord(body: Json): LaunchRecord | null {
  const s = isObj(body) && Array.isArray(body.state) ? body.state : null;
  if (!s || s.length !== 4 || !Array.isArray(s[2])) return null;
  const resource = taggedAddress(s[0], 131, "resource_");
  const supply = toBigInt(s[1]);
  const createdAtEpoch = toEpoch(s[3]);
  if (!resource || supply === null || createdAtEpoch === null) return null;
  if (s[2].length < 1 || s[2].length > MAX_RECORD_LOCKS) return null;
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
  if (new Set(locks.map((l) => l.lock)).size !== locks.length) return null;
  return { resource, supply, locks, createdAtEpoch };
}

function header(value: Json): { comp: Record<string, Json>; header: Record<string, Json> } | null {
  const comp = isObj(value) && isObj(value.Component) ? value.Component : null;
  return comp && isObj(comp.header) ? { comp, header: comp.header } : null;
}

/** Record checks: pinned template, no owner, never upgradable, only `info` callable, readable state. */
function recordChecks(value: Json, template: string): { checks: TriCheck[]; record: LaunchRecord | null } {
  const c = header(value);
  if (!c) return { checks: [{ ok: null, label: "The launch record is readable" }], record: null };
  const hd = c.header;
  const field = (k: string) => (k in hd ? hd[k] : undefined);
  const record = parseRecord(c.comp.body);
  const checks: TriCheck[] = [
    { ok: when(field("template_address"), (t) => String(t).toLowerCase() === template.toLowerCase()), label: "The record runs the Launch Commitments template" },
    { ok: when(field("owner_rule"), (o) => o === "None"), label: "The record has no owner" },
    { ok: when(field("upgrade_rule"), (u) => u === "Locked"), label: "The record can never be upgraded", detail: "an upgradable component can fake being a record" },
    {
      ok: when(field("access_rules"), (r) => isObj(r) && r.default === "DenyAll" && isObj(r.method_access) && Object.keys(r.method_access).join() === "info" && r.method_access.info === "AllowAll"),
      label: "The record is read-only",
    },
    { ok: record !== null ? true : null, label: "The record is readable" },
  ];
  return { checks, record };
}

/**
 * Header-only provenance of a record: whether it can be a genuine record at all. Pages check this
 * before following the locks a record lists, so a forged record can't make them read anything.
 */
export function recordIsGenuine(value: Json, template: string): Fact {
  return fold(recordChecks(value, template).checks);
}

/** The lock addresses a record lists (at most 8, distinct); empty if the record is unreadable. */
export function recordLockIds(value: Json): string[] {
  return parseRecord(header(value)?.comp.body)?.locks.map((l) => l.lock) ?? [];
}

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

const sameRules = (rules: Json) =>
  isObj(rules) && Object.keys(rules).length === Object.keys(LAUNCHED_RULES).length && Object.keys(rules).every((k) => rules[k] === LAUNCHED_RULES[k]);

/** Runs every check and folds them into the facts. `currentEpoch` decides which locks are still locked. */
export function launchProof(input: LaunchInputs, launchTemplate: string, currentEpoch: number): LaunchProof {
  const rec = recordChecks(input.record, launchTemplate);
  const record = rec.record;

  const r = isObj(input.resource) && isObj(input.resource.Resource) ? input.resource.Resource : null;
  const field = (k: string) => (r && k in r ? r[k] : undefined);
  const meta = field("metadata");
  const launchedBy = isObj(meta) ? meta.launched_by : undefined;
  const supply = field("total_supply") === undefined ? undefined : toBigInt(field("total_supply"));

  const ownerless: TriCheck = { ok: when(field("owner_rule"), (o) => o === "None"), label: "The token has no owner" };
  const rulesExact: TriCheck = { ok: when(field("access_rules"), sameRules), label: "Only withdraw and deposit are open, and no rule can ever change" };
  const noHook: TriCheck = { ok: when(field("auth_hook"), (h) => h === null), label: "No transfer hook" };
  const tokenChecks: TriCheck[] = [
    ownerless,
    rulesExact,
    noHook,
    {
      ok: r === null ? null : field("resource_type") === "Fungible" && field("divisibility") === 18,
      label: "A fungible token with 18 decimals",
    },
    {
      ok: record === null || r === null ? null : launchedBy === input.recordId && record.resource === input.resourceId,
      label: "The record and the token name each other",
    },
    { ok: record === null || supply === undefined || supply === null ? null : supply === record.supply, label: "The supply matches the record" },
  ];

  const fixedSupply = fold([ownerless, rulesExact]);
  const rulesFrozen = fold([ownerless, rulesExact, noHook]);
  const issued = fold([...rec.checks, ...tokenChecks]);

  const checks = [...rec.checks, ...tokenChecks].map(toCheck);
  let lockedAtLaunch: Fact = issued;
  let stillLocked: bigint | null = null;
  if (record && issued === "yes") {
    const results = record.locks.map((want) => lockCheck(want, input.locks.get(want.lock), input, currentEpoch));
    checks.push(...results.map((x) => toCheck(x.check)));
    lockedAtLaunch = fold(results.map((x) => x.check));
    stillLocked = results.every((x) => x.stillLocked !== null) ? results.reduce((s, x) => s + (x.stillLocked ?? 0n), 0n) : null;
  }
  return { fixedSupply, rulesFrozen, issued, lockedAtLaunch, stillLocked, record, checks };
}

/**
 * A listed lock must be a genuine Lockbox lock of this token that this launch made with the
 * recorded terms. While it is still locked (unclaimed, before its epoch) its vault must hold
 * exactly the recorded amount; that live amount is what it contributes to `stillLocked`.
 */
function lockCheck(want: LaunchedLock, got: LockInput | undefined, input: LaunchInputs, currentEpoch: number): { check: TriCheck; stillLocked: bigint | null } {
  const label = `Lock ${want.lock.slice(10, 22)} was made by this launch with the recorded terms`;
  if (!got) return { check: { ok: null, label }, stillLocked: null };
  const s = got.reading.state;
  if (!s) return { check: { ok: null, label }, stillLocked: null };
  if (!got.reading.genuine) return { check: { ok: false, label, detail: "not a genuine Lockbox lock" }, stillLocked: null };
  const mismatch = [
    got.vault && got.vault.resource !== input.resourceId && "it holds a different token",
    s.lockedAmount !== want.amount && "the locked amount differs",
    s.unlockEpoch !== want.unlockEpoch && "the unlock epoch differs",
    s.beneficiary !== want.beneficiary && "the beneficiary differs",
    s.memo !== `launch ${input.recordId}` && "it was not made by this launch",
  ].filter((x): x is string => typeof x === "string");
  if (mismatch.length > 0) return { check: { ok: false, label, detail: mismatch.join("; ") }, stillLocked: null };
  if (!got.vault || got.vault.amount === null) return { check: { ok: null, label }, stillLocked: null };
  if (lockStatus(s, currentEpoch) !== "locked") return { check: { ok: true, label }, stillLocked: 0n };
  // Nothing can leave a genuine lock before its epoch, so a different live balance means the data is wrong.
  if (got.vault.amount !== want.amount) return { check: { ok: false, label, detail: "it holds a different amount than it locked" }, stillLocked: null };
  return { check: { ok: true, label }, stillLocked: got.vault.amount };
}
