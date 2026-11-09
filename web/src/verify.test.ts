import { describe, expect, it } from "vitest";
import lockFixture from "./fixtures/esmeralda-lock.json";
import vaultFixture from "./fixtures/esmeralda-lock-vault.json";
import tariFixture from "./fixtures/esmeralda-tari-resource.json";
import bigLockFixture from "./fixtures/esmeralda-launch-lock.json";
import {
  formatAmount,
  lockedShare,
  lockStatus,
  parseAmount,
  readLock,
  readResource,
  readVault,
} from "./verify";

// Real Esmeralda data: the demo lock (1 tTARI, unlock epoch 12932, claimed at 12934).
const TEMPLATE = "d7f5ee289465580308d3074a0892d90eefb4bf157200171692bdf47cc9473832";
const BENEFICIARY = "f6e42c6b84bf67290a401d55daa49f332ca2acdab86da7b1210b2a1d8eebd017";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("readLock", () => {
  it("accepts the real testnet lock and reads its state", () => {
    const r = readLock(lockFixture, TEMPLATE);
    expect(r.genuine).toBe(true);
    expect(r.state).toMatchObject({
      vault: "vault_c5f672cbfd572ba9cbaa1350984dd764a8045fcb098ac07efefa295a79453786",
      beneficiary: BENEFICIARY,
      unlockEpoch: 12932n,
      lockedAtEpoch: 12931n,
      lockedAmount: 1000000n,
      claimed: true,
    });
  });

  // Amounts above 2^64 arrive as CBOR bignums (tag 2): an 18-decimal token passes that at ~18.4 tokens.
  it("reads a lock of an 18-decimal token holding more than 2^64 atomic units", () => {
    const r = readLock(bigLockFixture, "3f77a82e2eecb1795bc250ce919706519ea8feacc283d25f9e9740edc81b12b3");
    expect(r.genuine).toBe(true);
    expect(r.state?.lockedAmount).toBe(200_000n * 10n ** 18n);
    expect(r.state?.unlockEpoch).toBe(12969n);
  });

  it("rejects a component from another template", () => {
    expect(readLock(lockFixture, "00".repeat(32)).genuine).toBe(false);
  });

  // The impersonation attack: fake state switched into the Lockbox template keeps its upgrade rule.
  it("rejects an upgradable component even when it runs the Lockbox template", () => {
    const fake = clone(lockFixture);
    fake.Component.header.upgrade_rule = "Owner" as never;
    const r = readLock(fake, TEMPLATE);
    expect(r.genuine).toBe(false);
    expect(r.checks.find((c) => c.label === "Can never be upgraded")?.ok).toBe(false);
  });

  it("rejects a component with an owner", () => {
    const fake = clone(lockFixture);
    (fake.Component.header as { owner_rule: unknown }).owner_rule = { ByPublicKey: BENEFICIARY };
    expect(readLock(fake, TEMPLATE).genuine).toBe(false);
  });

  it("rejects a claim rule that doesn't match the stored beneficiary", () => {
    const fake = clone(lockFixture);
    fake.Component.body.state[1] = { "@cbor": "bytes", hex: "11".repeat(32) } as never;
    expect(readLock(fake, TEMPLATE).genuine).toBe(false);
  });

  it("rejects an extra callable method", () => {
    const fake = clone(lockFixture);
    (fake.Component.header.access_rules.method_access as Record<string, unknown>).drain = "AllowAll";
    expect(readLock(fake, TEMPLATE).genuine).toBe(false);
  });

  // A key-shaped badge from some other resource is not a signature requirement.
  it("rejects a claim badge from a resource other than the public-key badge", () => {
    const fake = clone(lockFixture);
    const nf = (fake.Component.header.access_rules.method_access as any).claim.Restricted.Require.Require.NonFungibleAddress;
    nf.resource_address = "resource_" + "02".repeat(32);
    expect(readLock(fake, TEMPLATE).genuine).toBe(false);
  });

  it("rejects a beneficiary that is not a valid public key", () => {
    const fake = clone(lockFixture);
    const bad = "ff".repeat(32);
    fake.Component.body.state[1] = { "@cbor": "bytes", hex: bad } as never;
    const nf = (fake.Component.header.access_rules.method_access as any).claim.Restricted.Require.Require.NonFungibleAddress;
    nf.id.U256 = bad;
    const r = readLock(fake, TEMPLATE);
    expect(r.checks.find((c) => c.label === "Only the beneficiary can claim")?.ok).toBe(true);
    expect(r.genuine).toBe(false);
  });

  it("fails closed on unreadable state", () => {
    const fake = clone(lockFixture);
    fake.Component.body.state = fake.Component.body.state.slice(0, 5);
    const r = readLock(fake, TEMPLATE);
    expect(r.genuine).toBe(false);
    expect(r.state).toBeNull();
    expect(readLock({ Vault: {} }, TEMPLATE).genuine).toBe(false);
  });
});

describe("readVault", () => {
  it("reads the claimed (empty) stealth vault", () => {
    expect(readVault(vaultFixture)).toEqual({
      resource: "resource_0101010101010101010101010101010101010101010101010101010101010101",
      amount: 0n,
      nftCount: null,
    });
  });

  it("reads a fungible vault", () => {
    const v = { Vault: { resource_container: { Fungible: { address: "resource_aa", amount: 42, locked_amount: 0 } } } };
    expect(readVault(v)?.amount).toBe(42n);
  });

  it("returns null for an unknown container kind or several kinds", () => {
    expect(readVault({ Vault: { resource_container: { Wrapped: { address: "resource_aa", revealed_amount: 5 } } } })).toBeNull();
    const two = { Fungible: { address: "resource_aa", amount: 1 }, Stealth: { address: "resource_aa", revealed_amount: 1 } };
    expect(readVault({ Vault: { resource_container: two } })).toBeNull();
  });
});

describe("readResource", () => {
  it("finds no lock risks on native TARI (ownerless, everything locked)", () => {
    const r = readResource(tariFixture);
    expect(r?.lockRisks).toEqual([]);
    expect(r?.symbol).toBe("tTARI");
    expect(r?.divisibility).toBe(6);
    expect(r?.totalSupply).toBeNull();
  });

  // Owner bypass: an owned token's issuer skips DenyAll rules, so the lock isn't safe.
  it("flags an owned token", () => {
    const owned = clone(tariFixture);
    (owned.Resource as { owner_rule: unknown }).owner_rule = { ByPublicKey: BENEFICIARY };
    const r = readResource(owned);
    expect(r?.lockRisks.some((x) => x.includes("has an owner"))).toBe(true);
    // Owner updaters become reachable once there is an owner.
    expect(r?.notes).toContain("Name and metadata can change.");
  });

  it("flags recall, freeze, withdraw restrictions and hooks", () => {
    const bad = clone(tariFixture);
    const rules = bad.Resource.access_rules as Record<string, unknown>;
    rules.recall = "AllowAll";
    rules.freeze_updater = "Owner";
    (bad.Resource as { owner_rule: unknown }).owner_rule = "None";
    rules.withdraw = "DenyAll";
    (bad.Resource as { auth_hook: unknown }).auth_hook = { component_address: "component_x", method: "check" };
    const risks = readResource(bad)?.lockRisks ?? [];
    expect(risks.some((x) => x.includes("recall"))).toBe(true);
    expect(risks.some((x) => x.includes("Withdrawals"))).toBe(true);
    expect(risks.some((x) => x.includes("veto"))).toBe(true);
    // freeze_updater Owner with no owner is unreachable, so not a risk.
    expect(risks.some((x) => x.includes("freeze"))).toBe(false);
  });

  it("treats a missing hook field as a risk, not as no hook", () => {
    const noField = clone(tariFixture) as { Resource: Record<string, unknown> };
    delete noField.Resource.auth_hook;
    expect(readResource(noField)?.lockRisks.some((x) => x.includes("hook"))).toBe(true);
  });

  it("notes mintable supply without calling it a lock risk", () => {
    const mintable = clone(tariFixture);
    (mintable.Resource.access_rules as Record<string, unknown>).mint = "AllowAll";
    const r = readResource(mintable);
    expect(r?.lockRisks).toEqual([]);
    expect(r?.notes[0]).toContain("minted");
  });
});

describe("lockStatus", () => {
  const state = readLock(lockFixture, TEMPLATE).state!;
  it("is claimed once claimed", () => expect(lockStatus(state, 12000)).toBe("claimed"));
  it("is locked before the unlock epoch, claimable from it", () => {
    const open = { ...state, claimed: false };
    expect(lockStatus(open, 12931)).toBe("locked");
    expect(lockStatus(open, 12932)).toBe("claimable");
  });
});

describe("amounts", () => {
  it("formats exactly, including values above 2^53", () => {
    expect(formatAmount(1000000n, 6)).toBe("1");
    expect(formatAmount(1234567n, 6)).toBe("1.234567");
    expect(formatAmount(123456789012345678901234567n, 18)).toBe("123,456,789.012345678901234567");
    expect(formatAmount(5n, 0)).toBe("5");
  });
  it("parses exactly and rejects too many decimals", () => {
    expect(parseAmount("1.5", 6)).toBe(1500000n);
    expect(parseAmount("1,000", 0)).toBe(1000n);
    expect(parseAmount("0.0000001", 6)).toBeNull();
    expect(parseAmount("-1", 6)).toBeNull();
    expect(parseAmount("9007199254740993", 0)).toBe(9007199254740993n);
  });
  it("computes a locked share only with a known supply", () => {
    expect(lockedShare(250n, 1000n)).toBe("25.00%");
    expect(lockedShare(1n, 3n)).toBe("33.33%");
    expect(lockedShare(5n, null)).toBeNull();
  });
});

describe("readLock provenance", () => {
  const rules = (l: any) => l.Component.header.access_rules;
  const claimNf = (l: any) => rules(l).method_access.claim.Restricted.Require.Require.NonFungibleAddress;
  const changed = (change: (l: any) => void) => {
    const l = clone(lockFixture);
    change(l);
    return readLock(l, TEMPLATE);
  };

  it("is unknown, never genuine, when a claim-rule field is missing", () => {
    for (const change of [
      (l: any) => delete rules(l).default,
      (l: any) => delete rules(l).method_access,
      (l: any) => delete claimNf(l).resource_address,
      (l: any) => delete claimNf(l).id,
      (l: any) => delete l.Component.header.owner_rule,
    ]) {
      const r = changed(change);
      expect(r.genuine).toBe(false);
      expect(r.provenance).toBe("unknown");
    }
  });

  it("is a contradiction when a claim-rule field differs or holds another variant", () => {
    for (const change of [
      (l: any) => (rules(l).default = "AllowAll"),
      (l: any) => (rules(l).method_access.withdraw = "AllowAll"),
      (l: any) => (rules(l).method_access.claim = "AllowAll"),
      (l: any) => (rules(l).method_access.claim.Restricted.Require.Require = { ResourceAddress: "resource_00" }),
      (l: any) => (claimNf(l).id = { String: "x" }),
      (l: any) => (claimNf(l).resource_address = "resource_" + "02".repeat(32)),
    ]) {
      expect(changed(change).provenance).toBe("no");
    }
    expect(readLock(lockFixture, TEMPLATE).provenance).toBe("yes");
  });
});
