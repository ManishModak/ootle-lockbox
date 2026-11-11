import { describe, expect, it } from "vitest";
import lock1 from "./fixtures/esmeralda-launch-lock.json";
import lock2 from "./fixtures/esmeralda-launch-lock2.json";
import recordFixture from "./fixtures/esmeralda-launch-record.json";
import tokenFixture from "./fixtures/esmeralda-launch-token.json";
import vault1 from "./fixtures/esmeralda-launch-vault1.json";
import vault2 from "./fixtures/esmeralda-launch-vault2.json";
import tariFixture from "./fixtures/esmeralda-tari-resource.json";
import { launchProof, recordIsGenuine, recordLockIds } from "./launch";
import { readLock, readVault } from "./verify";

// The real Esmeralda launch of 9 Nov: LCDEMO, 1,000,000 supply, locks of 200,000 @12969 and 50,000 @12973.
const LAUNCH_TEMPLATE = "ec0b8e8bf1ad8e05e0745e66868929070358da5dd975d72cd1031befa5141a8a";
const LOCKBOX_TEMPLATE = "3f77a82e2eecb1795bc250ce919706519ea8feacc283d25f9e9740edc81b12b3";
const RECORD = "component_c6c56ae085f622a8b083419c48bfa82e3c3746cb18e941a0548000bbf6eab880";
const TOKEN = "resource_c69eb717bbda751f9268c493d50c4bc17a0d34a50dd37673215597f79a513cee";
const LOCK1 = "component_fd916fadc33bfa0b19c205ed60ca70287ac1cdcc3a1bef4313e12a66a05ede63";
const LOCK2 = "component_5395c3841c6af089b61e25c07b1d97228c806ba67b8ce1cbc0908f7e9ece1e08";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** The epoch the fixtures were read at: both locks still locked. */
const NOW = 12967;

/** Raw substates of one launch; tests tamper with these, then `prove` reads them like the page does. */
interface Raw {
  record: any;
  resource: any;
  resourceId: string;
  locks: Map<string, { lock: any; vault: any }>;
}

function raw(): Raw {
  return {
    record: clone(recordFixture),
    resource: clone(tokenFixture),
    resourceId: TOKEN,
    locks: new Map([
      [LOCK1, { lock: clone(lock1), vault: clone(vault1) }],
      [LOCK2, { lock: clone(lock2), vault: clone(vault2) }],
    ]),
  };
}

function prove(r: Raw, template = LAUNCH_TEMPLATE, epoch = NOW) {
  const locks = new Map([...r.locks].map(([id, l]) => [id, { reading: readLock(l.lock, LOCKBOX_TEMPLATE), vault: l.vault ? readVault(l.vault) : null }]));
  return launchProof({ recordId: RECORD, record: r.record, resourceId: r.resourceId, resource: r.resource, locks }, template, epoch);
}

const facts = (r: Raw) => {
  const p = prove(r);
  return { fixedSupply: p.fixedSupply, rulesFrozen: p.rulesFrozen, issued: p.issued, lockedAtLaunch: p.lockedAtLaunch };
};

/** A copy of the launch with `change` applied to its raw substates. */
const tampered = (change: (r: Raw) => void): Raw => {
  const r = raw();
  change(r);
  return r;
};

describe("launchProof", () => {
  it("proves the real testnet launch", () => {
    const p = prove(raw());
    expect(p.checks.filter((c) => !c.ok)).toEqual([]);
    expect(facts(raw())).toEqual({ fixedSupply: "yes", rulesFrozen: "yes", issued: "yes", lockedAtLaunch: "yes" });
    expect(p.record).toMatchObject({ resource: TOKEN, supply: 10n ** 24n, createdAtEpoch: 12967n });
    expect(p.record?.locks.map((l) => [l.lock, l.amount, l.unlockEpoch])).toEqual([
      [LOCK1, 200_000n * 10n ** 18n, 12969n],
      [LOCK2, 50_000n * 10n ** 18n, 12973n],
    ]);
    expect(recordLockIds(recordFixture)).toEqual([LOCK1, LOCK2]);
  });

  // Impersonation: fake state switched into the pinned template keeps its own upgrade rule.
  it("rejects an upgradable record even when it runs the pinned template", () => {
    expect(facts(tampered((r) => (r.record.Component.header.upgrade_rule = "Owner"))).issued).toBe("no");
  });

  it("rejects a record from another template", () => {
    expect(prove(raw(), "00".repeat(32)).issued).toBe("no");
  });

  it("rejects a record with an owner or another callable method", () => {
    expect(facts(tampered((r) => (r.record.Component.header.owner_rule = "OwnedBySigner"))).issued).toBe("no");
    expect(facts(tampered((r) => (r.record.Component.header.access_rules.method_access.withdraw = "AllowAll"))).issued).toBe("no");
  });

  // Provenance: a genuine record for one token can't vouch for another, and a token can't claim a record.
  it("rejects a token whose launched_by names another record", () => {
    expect(facts(tampered((r) => (r.resource.Resource.metadata.launched_by = "component_" + "11".repeat(32)))).issued).toBe("no");
  });

  it("rejects a genuine record checked against a different token that copies the pointer", () => {
    expect(facts(tampered((r) => (r.resourceId = "resource_" + "22".repeat(32)))).issued).toBe("no");
  });

  it("does not call an ownerless token from elsewhere issued", () => {
    const f = facts(tampered((r) => (r.resource = clone(tariFixture))));
    expect(f).toMatchObject({ issued: "no", lockedAtLaunch: "no" });
  });

  it("says a token with an owner has neither a fixed supply nor frozen rules", () => {
    const f = facts(tampered((r) => (r.resource.Resource.owner_rule = "OwnedBySigner")));
    expect(f).toMatchObject({ fixedSupply: "no", rulesFrozen: "no", issued: "no" });
  });

  it("rejects mintable, hooked or extra-rule tokens", () => {
    expect(facts(tampered((r) => (r.resource.Resource.access_rules.mint = "AllowAll")))).toMatchObject({ fixedSupply: "no", issued: "no" });
    const hook = { component: "component_" + "33".repeat(32), method: "check" };
    expect(facts(tampered((r) => (r.resource.Resource.auth_hook = hook)))).toMatchObject({ fixedSupply: "yes", rulesFrozen: "no", issued: "no" });
    expect(facts(tampered((r) => (r.resource.Resource.access_rules.something_new = "AllowAll"))).issued).toBe("no");
  });

  it("rejects a supply that differs from the record", () => {
    expect(facts(tampered((r) => (r.resource.Resource.total_supply = "999"))).issued).toBe("no");
  });

  it("rejects a lock that isn't a genuine Lockbox lock", () => {
    const f = facts(tampered((r) => (r.locks.get(LOCK1)!.lock.Component.header.upgrade_rule = "Owner")));
    expect(f).toMatchObject({ issued: "yes", lockedAtLaunch: "no" });
  });

  it("rejects a genuine lock of another token, another allocation or another launch", () => {
    const otherToken = tampered((r) => (r.locks.get(LOCK1)!.vault.Vault.resource_container.Fungible.address = "resource_" + "44".repeat(32)));
    expect(facts(otherToken).lockedAtLaunch).toBe("no");
    const swapped = tampered((r) => r.locks.set(LOCK1, { lock: clone(lock2), vault: clone(vault2) }));
    expect(facts(swapped).lockedAtLaunch).toBe("no");
    const otherLaunch = tampered((r) => (r.locks.get(LOCK2)!.lock.Component.body.state[5] = "launch component_" + "55".repeat(32)));
    expect(facts(otherLaunch).lockedAtLaunch).toBe("no");
    // The table names which lock failed, even though it is still a genuine Lockbox lock.
    expect(Object.fromEntries(prove(otherLaunch).lockFacts)).toEqual({ [LOCK1]: "yes", [LOCK2]: "no" });
  });

  it("is unknown, never a pass, when a lock or the record can't be read", () => {
    expect(facts(tampered((r) => r.locks.delete(LOCK2)))).toMatchObject({ issued: "yes", lockedAtLaunch: "unknown" });
    expect(facts(tampered((r) => (r.locks.get(LOCK1)!.vault = null))).lockedAtLaunch).toBe("unknown");
    const garbled = tampered((r) => (r.record.Component.body.state = [1, 2]));
    expect(facts(garbled)).toMatchObject({ issued: "unknown", lockedAtLaunch: "unknown" });
  });

  it("lets a failed lock outweigh an unreadable one", () => {
    const r = tampered((r) => {
      r.locks.get(LOCK1)!.vault = null;
      r.locks.get(LOCK2)!.lock.Component.body.state[5] = "launch elsewhere";
    });
    expect(facts(r).lockedAtLaunch).toBe("no");
  });
});

describe("still locked", () => {
  const E18 = 10n ** 18n;

  it("counts both locks before their epochs", () => {
    expect(prove(raw()).stillLocked).toBe(250_000n * E18);
  });

  // A claimed, emptied lock was still locked at launch; it just isn't locked now.
  it("keeps 'locked at launch' for a claimed lock but stops counting it", () => {
    const r = tampered((r) => {
      r.locks.get(LOCK1)!.lock.Component.body.state[6] = true;
      r.locks.get(LOCK1)!.vault.Vault.resource_container.Fungible.amount = "0";
    });
    const p = prove(r);
    expect(p.lockedAtLaunch).toBe("yes");
    expect(p.stillLocked).toBe(50_000n * E18);
  });

  it("stops counting a lock once its epoch is reached", () => {
    expect(prove(raw(), LAUNCH_TEMPLATE, 12969).stillLocked).toBe(50_000n * E18);
    expect(prove(raw(), LAUNCH_TEMPLATE, 12973).stillLocked).toBe(0n);
  });

  it("rejects a still-locked lock whose vault holds a different amount", () => {
    const r = tampered((r) => (r.locks.get(LOCK2)!.vault.Vault.resource_container.Fungible.amount = "1"));
    expect(prove(r)).toMatchObject({ lockedAtLaunch: "no", stillLocked: null });
  });
});

describe("missing data", () => {
  it("is unknown, not a rejection, when a required field is absent", () => {
    expect(facts(tampered((r) => delete r.record.Component.header.owner_rule)).issued).toBe("unknown");
    expect(facts(tampered((r) => delete r.resource.Resource.auth_hook))).toMatchObject({ rulesFrozen: "unknown", issued: "unknown" });
    expect(facts(tampered((r) => delete r.resource.Resource.total_supply)).issued).toBe("unknown");
  });

  it("is unknown when a nested or lock header field is absent", () => {
    for (const change of [
      (r: Raw) => delete r.resource.Resource.resource_type,
      (r: Raw) => delete r.resource.Resource.divisibility,
      (r: Raw) => delete r.resource.Resource.metadata.launched_by,
      (r: Raw) => delete r.record.Component.header.access_rules.default,
    ]) {
      expect(facts(tampered(change)).issued).toBe("unknown");
    }
    expect(facts(tampered((r) => delete r.resource.Resource.access_rules.mint))).toMatchObject({ fixedSupply: "unknown", issued: "unknown" });
    for (const k of ["owner_rule", "upgrade_rule", "template_address", "access_rules"]) {
      expect(facts(tampered((r) => delete r.locks.get(LOCK1)!.lock.Component.header[k]))).toMatchObject({ issued: "yes", lockedAtLaunch: "unknown" });
    }
  });

  it("still says no for a nested or lock header contradiction", () => {
    expect(facts(tampered((r) => (r.resource.Resource.divisibility = 6))).issued).toBe("no");
    expect(facts(tampered((r) => (r.resource.Resource.access_rules.mint = "AllowAll"))).fixedSupply).toBe("no");
    expect(facts(tampered((r) => (r.record.Component.header.access_rules.default = "AllowAll"))).issued).toBe("no");
    expect(facts(tampered((r) => (r.locks.get(LOCK1)!.lock.Component.header.owner_rule = { ByPublicKey: "00" }))).lockedAtLaunch).toBe("no");
    const mixed = tampered((r) => {
      delete r.locks.get(LOCK1)!.lock.Component.header.template_address;
      r.locks.get(LOCK1)!.lock.Component.header.upgrade_rule = "Owner";
    });
    expect(facts(mixed).lockedAtLaunch).toBe("no");
  });

  it("still says no when one field is missing and another contradicts", () => {
    const r = tampered((r) => {
      delete r.record.Component.header.owner_rule;
      r.record.Component.header.upgrade_rule = "Owner";
    });
    expect(facts(r).issued).toBe("no");
  });

  // The template lists 1-8 distinct locks; anything else is not a record it wrote, and pages never follow it.
  it("refuses to follow more than 8 or duplicate lock ids", () => {
    const many = clone(recordFixture) as any;
    many.Component.body.state[2] = Array(9).fill(many.Component.body.state[2][0]);
    expect(recordLockIds(many)).toEqual([]);
    const dup = clone(recordFixture) as any;
    dup.Component.body.state[2] = [dup.Component.body.state[2][0], dup.Component.body.state[2][0]];
    expect(recordLockIds(dup)).toEqual([]);
    expect(recordIsGenuine(many, LAUNCH_TEMPLATE)).toBe("unknown");
  });

  it("checks a record's header before its locks are read", () => {
    expect(recordIsGenuine(recordFixture, LAUNCH_TEMPLATE)).toBe("yes");
    expect(recordIsGenuine(recordFixture, "00".repeat(32))).toBe("no");
  });
});
