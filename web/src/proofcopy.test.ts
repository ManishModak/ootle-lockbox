import { describe, expect, it } from "vitest";
import type { LaunchProof } from "./launch";
import type { LoadedLock } from "./lockdata";
import { IndexerError } from "./indexer";
import { factText, launchVerdict, loadFailure, lockChecks, lockedTotalLine, notesLine, stillLockedText, tokenVerdict, type LaunchFactName } from "./proofcopy";
import { HOOK_UNREADABLE, type Fact } from "./verify";

const lock = (lockRisks: string[], notes: string[]): LoadedLock =>
  ({
    id: "component_x",
    reading: { checks: [{ ok: true, label: "Runs the Lockbox template" }], genuine: true, state: null },
    vault: null,
    resource: { lockRisks, notes },
    status: "locked",
    indexerVerified: true,
  }) as unknown as LoadedLock;

describe("lockChecks", () => {
  it("keeps token notes out of the checks, so they never count as passed", () => {
    const { checks, notes } = lockChecks(lock([], ["More tokens can be minted, so supply can grow."]));
    expect(checks.map((c) => c.label)).toEqual(["Runs the Lockbox template", "The token's issuer cannot undo the lock"]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(notes).toEqual(["More tokens can be minted, so supply can grow."]);
  });

  it("fails the issuer check with the risks as its detail", () => {
    const { checks } = lockChecks(lock(["The issuer can recall tokens, including out of a lock."], []));
    expect(checks[1]).toEqual({ ok: false, label: "The token's issuer cannot undo the lock", detail: "The issuer can recall tokens, including out of a lock." });
  });
});

describe("notesLine", () => {
  it("is absent without notes and says the notes don't affect the lock", () => {
    expect(notesLine([], "the lock")).toBeNull();
    expect(notesLine(["Name and metadata can change."], "the lock")).toBe("Note: Name and metadata can change. This doesn't affect the lock.");
    expect(notesLine(["A.", "B."], "locks")).toBe("Note: A. B. These don't affect locks.");
  });
});

describe("factText", () => {
  const names: LaunchFactName[] = ["fixedSupply", "rulesFrozen", "issued", "lockedAtLaunch"];
  it("never shows a fact's affirmative sentence for a failed or unknown result", () => {
    for (const name of names) {
      const yes = factText(name, "yes", "yes");
      for (const f of ["no", "unknown"] as Fact[]) expect(factText(name, f, "yes")).not.toBe(yes);
    }
  });

  it("says the locks weren't checked when the launch itself isn't genuine", () => {
    expect(factText("lockedAtLaunch", "no", "no")).toBe("The launch isn't genuine, so its locks weren't checked.");
    expect(factText("lockedAtLaunch", "unknown", "unknown")).toBe("The launch couldn't be confirmed, so its locks weren't checked.");
  });
});

const proof = (over: Partial<LaunchProof>): LaunchProof => ({
  fixedSupply: "yes",
  rulesFrozen: "yes",
  issued: "yes",
  lockedAtLaunch: "yes",
  stillLocked: 0n,
  record: {
    resource: "resource_x",
    supply: 1_000_000n,
    locks: [
      { lock: "component_a", amount: 200_000n, unlockEpoch: 100n, beneficiary: "aa" },
      { lock: "component_b", amount: 50_000n, unlockEpoch: 110n, beneficiary: "bb" },
    ],
    createdAtEpoch: 90n,
  },
  checks: [],
  ...over,
});

describe("launchVerdict", () => {
  it("is genuine only for an issued launch, and its summary follows the lock fact", () => {
    expect(launchVerdict(proof({})).title).toBe("Genuine Launch Commitments token");
    expect(launchVerdict(proof({ lockedAtLaunch: "no" })).text).toMatch(/failed its check/);
    expect(launchVerdict(proof({ lockedAtLaunch: "unknown" })).text).toMatch(/could not be read/);
    expect(launchVerdict(proof({ issued: "no" })).kind).toBe("bad");
    expect(launchVerdict(proof({})).kind).toBe("ok");
    expect(launchVerdict(proof({ lockedAtLaunch: "unknown" })).kind).toBe("warn");
    expect(launchVerdict(proof({ lockedAtLaunch: "no" })).kind).toBe("warn");
    expect(launchVerdict(proof({ issued: "unknown" })).kind).toBe("warn");
  });
});

describe("stillLockedText", () => {
  it("shows the live amount out of what was locked at launch", () => {
    expect(stillLockedText(proof({}), 0, "LCDEMO", 120)).toEqual({ amount: "0 of 250,000 LCDEMO", note: "every launch lock has reached its unlock epoch" });
    expect(stillLockedText(proof({ stillLocked: 50_000n }), 0, "LCDEMO", 105)?.note).toBe("each lock opens at its unlock epoch; then only its beneficiary can claim");
  });

  it("is null when the live amount couldn't be read", () => {
    expect(stillLockedText(proof({ stillLocked: null }), 0, "LCDEMO", 120)).toBeNull();
  });
});

describe("loadFailure", () => {
  const page = "component_" + "a".repeat(64);
  it("says the address is absent only when the page's own address wasn't found", () => {
    expect(loadFailure(new IndexerError("Not found on this network.", "not-found", page), page)).toBe("absent");
    expect(loadFailure(new IndexerError("Not found on this network.", "not-found", page.toUpperCase()), page)).toBe("absent");
  });

  it("calls a missing dependency (vault, launch record, epoch) an incomplete proof", () => {
    expect(loadFailure(new IndexerError("Not found on this network.", "not-found", "vault_" + "b".repeat(64)), page)).toBe("incomplete");
    expect(loadFailure(new IndexerError("Not found on this network.", "not-found"), page)).toBe("incomplete");
  });

  it("keeps the other failure kinds", () => {
    expect(loadFailure(new IndexerError("down", "unreachable"), page)).toBe("unreachable");
    expect(loadFailure(new IndexerError("garbled"), page)).toBe("bad-data");
    expect(loadFailure(new Error("boom"), page)).toBe("bad-data");
  });
});

describe("tokenVerdict", () => {
  it("says the issuer can undo a lock only for a real risk", () => {
    expect(tokenVerdict({ lockRisks: [] }).kind).toBe("ok");
    expect(tokenVerdict({ lockRisks: ["The issuer can recall tokens, including out of a lock."] }).title).toBe("The issuer can undo a lock");
    expect(tokenVerdict({ lockRisks: [HOOK_UNREADABLE, "The issuer can freeze vaults, including a lock's vault."] }).kind).toBe("bad");
  });

  it("calls unreadable rules 'Not verified for Lockbox', not a risk", () => {
    const v = tokenVerdict({ lockRisks: [HOOK_UNREADABLE] });
    expect(v).toMatchObject({ kind: "warn", title: "Not verified for Lockbox", listTitle: "What couldn't be read" });
  });
});

describe("lockedTotalLine", () => {
  const base = { lockedNow: 0n, amount: "0 LCDEMO", share: "0.00%", supplyTracked: true, found: 2, open: 2, complete: true };
  it("explains a zero total instead of showing 0.00%", () => {
    expect(lockedTotalLine(base).join("")).toBe("Nothing is locked in Lockbox now: 2 locks found, all unlocked or claimed.");
    expect(lockedTotalLine({ ...base, found: 0, open: 0 }).join("")).toBe("Nothing is locked in Lockbox now: no locks of this token found.");
    expect(lockedTotalLine({ ...base, open: 1 }).join("")).toMatch(/none is a genuine lock before its unlock epoch/);
    expect(lockedTotalLine({ ...base, complete: false })[1]).toBe("Locked total unavailable");
  });

  it("shows a positive total with its share, as a lower bound when incomplete", () => {
    const some = { ...base, lockedNow: 5n, amount: "5 LCDEMO", share: "0.50%" };
    expect(lockedTotalLine(some).join("")).toBe("5 LCDEMO still locked in Lockbox (0.50% of supply). Counts only genuine locks before their unlock epoch.");
    expect(lockedTotalLine({ ...some, complete: false }).join("")).toMatch(/^At least 5 LCDEMO .*\(at least 0.50% of supply\)/);
  });
});
