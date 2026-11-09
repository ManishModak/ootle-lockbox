import { describe, expect, it } from "vitest";
import lock1 from "./fixtures/esmeralda-launch-lock.json";
import lock2 from "./fixtures/esmeralda-launch-lock2.json";
import recordFixture from "./fixtures/esmeralda-launch-record.json";
import tokenFixture from "./fixtures/esmeralda-launch-token.json";
import vault1 from "./fixtures/esmeralda-launch-vault1.json";
import vault2 from "./fixtures/esmeralda-launch-vault2.json";
import tariFixture from "./fixtures/esmeralda-tari-resource.json";
import { launchProof, type LaunchInputs } from "./launch";

// The real Esmeralda launch of 9 Nov: LCDEMO, 1,000,000 supply, locks of 200,000 @12969 and 50,000 @12973.
const PINS = {
  launchTemplate: "ec0b8e8bf1ad8e05e0745e66868929070358da5dd975d72cd1031befa5141a8a",
  lockboxTemplate: "3f77a82e2eecb1795bc250ce919706519ea8feacc283d25f9e9740edc81b12b3",
};
const RECORD = "component_c6c56ae085f622a8b083419c48bfa82e3c3746cb18e941a0548000bbf6eab880";
const TOKEN = "resource_c69eb717bbda751f9268c493d50c4bc17a0d34a50dd37673215597f79a513cee";
const LOCK1 = "component_fd916fadc33bfa0b19c205ed60ca70287ac1cdcc3a1bef4313e12a66a05ede63";
const LOCK2 = "component_5395c3841c6af089b61e25c07b1d97228c806ba67b8ce1cbc0908f7e9ece1e08";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function inputs(): LaunchInputs {
  return {
    recordId: RECORD,
    record: clone(recordFixture),
    resourceId: TOKEN,
    resource: clone(tokenFixture),
    locks: new Map([
      [LOCK1, { lock: clone(lock1), vault: clone(vault1) }],
      [LOCK2, { lock: clone(lock2), vault: clone(vault2) }],
    ]),
  };
}

const facts = (i: LaunchInputs) => {
  const p = launchProof(i, PINS);
  return { fixedSupply: p.fixedSupply, rulesFrozen: p.rulesFrozen, issued: p.issued, allocationsLocked: p.allocationsLocked };
};
const any = (x: unknown) => x as any;

describe("launchProof", () => {
  it("proves the real testnet launch", () => {
    const p = launchProof(inputs(), PINS);
    expect(p.checks.filter((c) => !c.ok)).toEqual([]);
    expect(facts(inputs())).toEqual({ fixedSupply: "yes", rulesFrozen: "yes", issued: "yes", allocationsLocked: "yes" });
    expect(p.record).toMatchObject({ resource: TOKEN, supply: 10n ** 24n, createdAtEpoch: 12967n });
    expect(p.record?.locks.map((l) => [l.lock, l.amount, l.unlockEpoch])).toEqual([
      [LOCK1, 200_000n * 10n ** 18n, 12969n],
      [LOCK2, 50_000n * 10n ** 18n, 12973n],
    ]);
  });

  // Impersonation: fake state switched into the pinned template keeps its own upgrade rule.
  it("rejects an upgradable record even when it runs the pinned template", () => {
    const i = inputs();
    any(i.record).Component.header.upgrade_rule = "Owner";
    expect(facts(i).issued).toBe("no");
  });

  it("rejects a record from another template", () => {
    expect(launchProof(inputs(), { ...PINS, launchTemplate: "00".repeat(32) }).issued).toBe("no");
  });

  it("rejects a record with an owner or another callable method", () => {
    const owned = inputs();
    any(owned.record).Component.header.owner_rule = "OwnedBySigner";
    expect(facts(owned).issued).toBe("no");
    const extra = inputs();
    any(extra.record).Component.header.access_rules.method_access.withdraw = "AllowAll";
    expect(facts(extra).issued).toBe("no");
  });

  // Provenance: a genuine record for one token can't vouch for another, and a token can't claim a record.
  it("rejects a token whose launched_by names another record", () => {
    const i = inputs();
    any(i.resource).Resource.metadata.launched_by = "component_" + "11".repeat(32);
    expect(facts(i).issued).toBe("no");
  });

  it("rejects a genuine record checked against a different token", () => {
    const i = inputs();
    i.resourceId = "resource_" + "22".repeat(32);
    any(i.resource).Resource.metadata.launched_by = RECORD; // the forger copies the pointer
    expect(facts(i).issued).toBe("no");
  });

  it("separates the facts for an ownerless token from elsewhere", () => {
    const i = inputs();
    i.resource = clone(tariFixture); // ownerless and frozen, but stealth, 6 decimals, not launched here
    const f = facts(i);
    expect(f.issued).toBe("no");
    expect(f.allocationsLocked).toBe("no");
  });

  it("says a token with an owner has neither a fixed supply nor frozen rules", () => {
    const i = inputs();
    any(i.resource).Resource.owner_rule = "OwnedBySigner";
    expect(facts(i)).toMatchObject({ fixedSupply: "no", rulesFrozen: "no", issued: "no" });
  });

  it("rejects mintable, hooked or extra-rule tokens", () => {
    const mint = inputs();
    any(mint.resource).Resource.access_rules.mint = "AllowAll";
    expect(facts(mint)).toMatchObject({ fixedSupply: "no", issued: "no" });
    const hook = inputs();
    any(hook.resource).Resource.auth_hook = { component: "component_" + "33".repeat(32), method: "check" };
    expect(facts(hook)).toMatchObject({ fixedSupply: "yes", rulesFrozen: "no", issued: "no" });
    const extra = inputs();
    any(extra.resource).Resource.access_rules.something_new = "AllowAll";
    expect(facts(extra).issued).toBe("no");
  });

  it("rejects a supply that differs from the record", () => {
    const i = inputs();
    any(i.resource).Resource.total_supply = "999";
    expect(facts(i).issued).toBe("no");
  });

  it("rejects a lock that isn't a genuine Lockbox lock", () => {
    const i = inputs();
    any(i.locks.get(LOCK1)!.lock).Component.header.upgrade_rule = "Owner";
    expect(facts(i)).toMatchObject({ issued: "yes", allocationsLocked: "no" });
  });

  it("rejects a genuine lock of another token, amount or launch", () => {
    const token = inputs();
    any(token.locks.get(LOCK1)!.vault).Vault.resource_container.Fungible.address = "resource_" + "44".repeat(32);
    expect(facts(token).allocationsLocked).toBe("no");
    // A different lock component in the record's place: swap the two locks' state.
    const swapped = inputs();
    swapped.locks.set(LOCK1, { lock: clone(lock2), vault: clone(vault2) });
    expect(facts(swapped).allocationsLocked).toBe("no");
    const memo = inputs();
    any(memo.locks.get(LOCK2)!.lock).Component.body.state[5] = "launch component_" + "55".repeat(32);
    expect(facts(memo).allocationsLocked).toBe("no");
  });

  it("is unknown, never a pass, when a lock or the record can't be read", () => {
    const missing = inputs();
    missing.locks.delete(LOCK2);
    expect(facts(missing)).toMatchObject({ issued: "yes", allocationsLocked: "unknown" });
    const noVault = inputs();
    noVault.locks.get(LOCK1)!.vault = null;
    expect(facts(noVault).allocationsLocked).toBe("unknown");
    const garbled = inputs();
    any(garbled.record).Component.body.state = [1, 2];
    expect(facts(garbled)).toMatchObject({ issued: "unknown", allocationsLocked: "unknown" });
  });

  it("lets a failed lock outweigh an unreadable one", () => {
    const i = inputs();
    i.locks.get(LOCK1)!.vault = null;
    any(i.locks.get(LOCK2)!.lock).Component.body.state[5] = "launch elsewhere";
    expect(facts(i).allocationsLocked).toBe("no");
  });
});
