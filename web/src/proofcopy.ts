/**
 * What the proof pages say about each result, kept apart from the DOM so tests can pin it: a
 * fact's explanation always follows that fact's result, and a token's notes (it can mint more, its
 * name can change) are shown apart from the checks and never counted as passed.
 */
import type { LaunchProof } from "./launch";
import type { LoadedLock } from "./lockdata";
import { formatAmount, type Check, type Fact } from "./verify";

/** A lock's checks (counted in "N of M passed") and its token's notes (listed apart, never counted). */
export function lockChecks(l: LoadedLock): { checks: Check[]; notes: string[] } {
  const r = l.resource;
  const token: Check = r
    ? { ok: r.lockRisks.length === 0, label: "The token's issuer cannot undo the lock", detail: r.lockRisks.join(" ") || undefined }
    : { ok: false, label: "Token rules are readable" };
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

/** The launch verdict: seal kind, title and one-line summary. Never says "safe". */
export function launchVerdict(p: LaunchProof): { kind: "ok" | "warn" | "bad"; title: string; text: string } {
  if (p.issued === "no") return { kind: "bad", title: "Not a genuine Launch Commitments token", text: "See the failed checks below." };
  if (p.issued === "unknown") return { kind: "warn", title: "Unable to verify", text: "Some data could not be read; treat this token as unverified." };
  return {
    kind: "ok",
    title: "Genuine Launch Commitments token",
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
 * Null when the live amount couldn't be read.
 */
export function stillLockedText(p: LaunchProof, div: number, sym: string, epoch: number): { amount: string; note: string } | null {
  if (p.stillLocked === null || !p.record) return null;
  const launched = p.record.locks.reduce((s, l) => s + l.amount, 0n);
  const allReached = p.record.locks.every((l) => BigInt(epoch) >= l.unlockEpoch);
  return {
    amount: `${formatAmount(p.stillLocked, div)} of ${formatAmount(launched, div)} ${sym}`,
    note: allReached ? "every launch lock has reached its unlock epoch" : "each lock opens at its unlock epoch; then only its beneficiary can claim",
  };
}
