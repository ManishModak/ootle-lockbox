import { describe, expect, it } from "vitest";
import type { LaunchProof } from "./launch";
import type { LoadedLock } from "./lockdata";
import { factText, launchVerdict, lockChecks, notesLine, stillLockedText, type LaunchFactName } from "./proofcopy";
import type { Fact } from "./verify";

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
