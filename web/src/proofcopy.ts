/**
 * What the proof pages say about each result, kept apart from the DOM so tests can pin it: a
 * fact's explanation always follows that fact's result, and a token's notes (it can mint more, its
 * name can change) are shown apart from the checks and never counted as passed.
 */
import { IndexerError } from "./indexer";
import type { LaunchProof } from "./launch";
import type { LoadedLock } from "./lockdata";
import { tokenAmount, tokenLockSafe, type Check, type Fact, type ResourceReading } from "./verify";

/**
 * How a page that failed to load words it: "absent" only when the address the page asked for is
 * missing; a missing dependency (the lock's vault, the launch record, the epoch) is "incomplete".
 */
export function loadFailure(e: unknown, id: string): "absent" | "incomplete" | "unreachable" | "bad-data" {
  if (!(e instanceof IndexerError)) return "bad-data";
  if (e.kind !== "not-found") return e.kind;
  return e.id !== undefined && e.id.toLowerCase() === id.toLowerCase() ? "absent" : "incomplete";
}

/**
 * The token page's verdict. "Can undo" only for a real issuer power, listed under `listTitle`;
 * rules that couldn't be read never join that list: alone they give "Not verified for Lockbox",
 * and beside a power they get their own "Couldn't be read" list.
 */
export function tokenVerdict(r: Pick<ResourceReading, "lockRisks" | "unreadable">): {
  kind: "ok" | "warn" | "bad";
  title: string;
  text: string;
  listTitle: string;
} {
  if (r.lockRisks.length > 0) {
    return {
      kind: "bad",
      title: "The issuer can undo a lock",
      text: "This token's own rules let its issuer undo or block a lock, so its locks can't be verified.",
      listTitle: "What the issuer can still do",
    };
  }
  if (r.unreadable.length > 0) {
    return {
      kind: "warn",
      title: "Not verified for Lockbox",
      text: "Part of this token's rules couldn't be read, so its locks can't be verified until they can.",
      listTitle: "Couldn't be read",
    };
  }
  return {
    kind: "ok",
    title: "The issuer can't undo a lock",
    text: "This token has no owner and its recall, freeze, withdraw and deposit rules are fixed, so locks of it can be verified.",
    listTitle: "",
  };
}

/**
 * How many of a token's listed locks the token page couldn't use, and whether it read them all.
 * A lock counts as unread when it failed to load, its state couldn't be read, its provenance is
 * unknown (a header field is missing, so it might be genuine), or it is a genuine lock before its
 * epoch whose balance couldn't be read. `allListed` = every lock of the token was listed.
 */
export function lockReadGaps(loaded: (LoadedLock | null)[], allListed: boolean): { failed: number; complete: boolean } {
  const unread = (l: LoadedLock | null) =>
    l === null || l.reading.state === null || l.reading.provenance === "unknown" || (l.reading.genuine && l.status === "locked" && l.vault?.amount == null);
  const failed = loaded.filter(unread).length;
  return { failed, complete: allListed && failed === 0 };
}

/**
 * The token page's still-locked line as [lead, bold, rest]. `found` locks were read, `open` of
 * them unlocked or claimed; `complete` = every lock of the token was read. A zero total says why
 * instead of showing "0.00%". `amount` is null when the token's precision couldn't be read.
 */
export function lockedTotalLine(a: {
  lockedNow: bigint;
  amount: string | null;
  share: string | null;
  supplyTracked: boolean;
  found: number;
  open: number;
  complete: boolean;
}): [string, string, string] {
  if (a.lockedNow > 0n) {
    if (a.amount === null) return ["", "Locked total unavailable", ": the token's precision couldn't be read, so no amount can be shown."];
    const share = a.share ? ` (${a.complete ? "" : "at least "}${a.share} of supply)` : a.supplyTracked ? "" : " (supply not tracked, so no share)";
    return [a.complete ? "" : "At least ", a.amount, ` still locked in Lockbox${share}. Counts only genuine locks before their unlock epoch.`];
  }
  if (!a.complete) return ["", "Locked total unavailable", ": some locks of this token couldn't be read, and none of the others is still locked."];
  const nothing = "Nothing is locked in Lockbox now";
  if (a.found === 0) return ["", nothing, ": no locks of this token found."];
  if (a.open === a.found) return ["", nothing, a.found === 1 ? ": 1 lock found, already unlocked or claimed." : `: ${a.found} locks found, all unlocked or claimed.`];
  return ["", nothing, `: ${a.found} lock${a.found === 1 ? "" : "s"} found; none is a genuine lock before its unlock epoch.`];
}

/**
 * A lock's checks (counted in "N of M passed") and its token's notes (listed apart, never counted).
 * The token check fails on an issuer power or an unread rule; an unread rule is worded "could not be
 * read", the way the lock's own unknown checks are.
 */
export function lockChecks(l: LoadedLock): { checks: Check[]; notes: string[] } {
  const r = l.resource;
  const label = "The token's issuer cannot undo the lock";
  // Each unread rule's line already says "could not be read", so it never reads as a power.
  const token: Check = !r
    ? { ok: false, label: "Token rules are readable" }
    : tokenLockSafe(r)
      ? { ok: true, label }
      : { ok: false, label, detail: [...r.lockRisks, ...r.unreadable].join(" "), unknown: r.lockRisks.length === 0 || undefined };
  return { checks: [...l.reading.checks, token], notes: r?.notes ?? [] };
}

/** The one neutral line a verdict carries when the token has notes; `what` is "the lock" or "locks". */
export function notesLine(notes: string[], what: string): string | null {
  if (notes.length === 0) return null;
  return `Note: ${notes.join(" ")} ${notes.length === 1 ? "This doesn't" : "These don't"} affect ${what}.`;
}

export type LaunchFactName = "fixedSupply" | "rulesFrozen" | "issued" | "lockedAtLaunch";

const FACT_TEXT: Record<Exclude<LaunchFactName, "lockedAtLaunch">, Record<Fact, string>> = {
  fixedSupply: {
    yes: "Nobody can mint or burn it.",
    no: "It has an owner, or rules that differ from a launched token's, so minting or burning isn't ruled out.",
    unknown: "Its owner or rules could not be read.",
  },
  rulesFrozen: {
    yes: "No owner, every rule and updater locked, no transfer hook.",
    no: "It has an owner, a rule that differs or can change, or a transfer hook.",
    unknown: "Its owner, rules or transfer hook could not be read.",
  },
  issued: {
    yes: "The launch record names this token, and the token names the record.",
    no: "A check of the launch record or the token failed; see Checks below.",
    unknown: "Part of the launch record or the token could not be read; see Checks below.",
  },
};

/** The explanation shown beside a launch fact. Locks are only followed for a genuine launch. */
export function factText(name: LaunchFactName, f: Fact, issued: Fact): string {
  if (name !== "lockedAtLaunch") return FACT_TEXT[name][f];
  if (issued !== "yes") return issued === "no" ? "The launch isn't genuine, so its locks weren't checked." : "The launch couldn't be confirmed, so its locks weren't checked.";
  return f === "yes"
    ? "Each lock below is a genuine Lockbox lock this launch made, with these terms."
    : f === "no"
      ? "At least one lock below isn't a genuine Lockbox lock this launch made with these terms."
      : "At least one lock below could not be read.";
}

/**
 * The launch verdict: seal kind, title and one-line summary. Never says "safe". A genuine launch
 * whose lock checks didn't all pass is amber, not mint.
 */
export function launchVerdict(p: LaunchProof): { kind: "ok" | "warn" | "bad"; title: string; text: string } {
  if (p.issued === "no") return { kind: "bad", title: "Not a genuine Launch Commitments token", text: "See the failed checks below." };
  if (p.issued === "unknown") return { kind: "warn", title: "Unable to verify", text: "Some data could not be read; treat this token as unverified." };
  return {
    kind: p.lockedAtLaunch === "yes" ? "ok" : "warn",
    // An amber seal's title says what is amber, so it never reads as a clean pass.
    title:
      p.lockedAtLaunch === "yes"
        ? "Genuine Launch Commitments token"
        : p.lockedAtLaunch === "no"
          ? "Genuine launch; a launch lock didn't verify"
          : "Genuine launch; a launch lock couldn't be checked",
    text:
      p.lockedAtLaunch === "yes"
        ? "Fixed supply, frozen rules and genuine launch locks, each checked on chain just now."
        : p.lockedAtLaunch === "no"
          ? "Its launch record is genuine, but at least one launch lock failed its check."
          : "Its launch record is genuine, but at least one launch lock could not be read.",
  };
}

/**
 * "Still locked now" as an amount out of what was locked at launch, plus why it is that amount.
 * Null when the live amount or the token's precision couldn't be read.
 */
export function stillLockedText(p: LaunchProof, div: number | null, sym: string, epoch: number): { amount: string; note: string } | null {
  if (p.stillLocked === null || !p.record || div === null) return null;
  const launched = p.record.locks.reduce((s, l) => s + l.amount, 0n);
  const allReached = p.record.locks.every((l) => BigInt(epoch) >= l.unlockEpoch);
  return {
    amount: `${tokenAmount(p.stillLocked, div)} of ${tokenAmount(launched, div, sym)}`,
    note: allReached ? "every launch lock has reached its unlock epoch" : "each lock opens at its unlock epoch; then only its beneficiary can claim",
  };
}
