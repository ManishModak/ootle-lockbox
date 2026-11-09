import { describe, expect, it } from "vitest";
import { NETWORKS } from "./config";
import { launchProblem, type LaunchInput } from "./newlaunch";
import { launchInstructions, locksLiteral } from "./wallet";

const KEY = "f6e42c6b84bf67290a401d55daa49f332ca2acdab86da7b1210b2a1d8eebd017";
const E18 = 10n ** 18n;
const NOW = 12967n;

const valid = (): LaunchInput => ({
  symbol: "LCDEMO",
  name: "Launch Commitments Demo",
  imageUrl: "https://example.org/logo.svg",
  supply: 1_000_000n * E18,
  locks: [
    { amount: 200_000n * E18, unlockEpoch: 12969n, beneficiary: KEY },
    { amount: 50_000n * E18, unlockEpoch: 12973n, beneficiary: KEY },
  ],
});
const withChange = (change: (i: LaunchInput) => void) => {
  const i = valid();
  change(i);
  return launchProblem(i, NOW);
};

describe("launchProblem", () => {
  it("accepts the real testnet launch's inputs, and locks that use the whole supply", () => {
    expect(launchProblem(valid(), NOW)).toBeNull();
    expect(withChange((i) => (i.locks = [{ amount: i.supply, unlockEpoch: NOW + 1n, beneficiary: KEY }]))).toBeNull();
    expect(withChange((i) => (i.imageUrl = ""))).toBeNull();
  });

  it("enforces the template's bounds", () => {
    expect(withChange((i) => (i.symbol = ""))).toMatch(/symbol/);
    expect(withChange((i) => (i.symbol = "ABCDEFGHIJKLM"))).toMatch(/symbol/);
    expect(withChange((i) => (i.symbol = "ÉÉÉÉÉÉÉ"))).toMatch(/symbol/); // 14 bytes in 7 characters
    expect(withChange((i) => (i.name = "x".repeat(65)))).toMatch(/name/);
    expect(withChange((i) => (i.imageUrl = "http://example.org/a.png"))).toMatch(/https/);
    expect(withChange((i) => (i.imageUrl = "https://" + "a".repeat(250)))).toMatch(/longer/);
    expect(withChange((i) => (i.supply = 0n))).toMatch(/supply/);
    expect(withChange((i) => (i.locks = []))).toMatch(/1–8 locks/);
    expect(withChange((i) => (i.locks = Array(9).fill(i.locks[1])))).toMatch(/1–8 locks/);
    expect(withChange((i) => (i.locks[1].amount = 0n))).toMatch(/Lock 2: the amount/);
    expect(withChange((i) => (i.locks[0].unlockEpoch = NOW))).toMatch(/Lock 1: the unlock time must be in the future/);
    expect(withChange((i) => (i.locks[0].unlockEpoch = NOW + 530_001n))).toMatch(/too far/);
    expect(withChange((i) => (i.locks[0].amount = i.supply))).toMatch(/more than the supply/);
  });

  it("refuses beneficiary keys nobody can sign for", () => {
    expect(withChange((i) => (i.locks[0].beneficiary = "00".repeat(32)))).toMatch(/not a valid public key/);
    expect(withChange((i) => (i.locks[0].beneficiary = "ff".repeat(32)))).toMatch(/not a valid public key/);
  });
});

describe("launch transaction", () => {
  // Golden value from the Rust side: tari_bor::encode(&vec![(Amount(2e23), 12969u64, KEY), (Amount(5), 1u64, KEY)]).
  it("encodes locks exactly as the template decodes them", () => {
    const locks = [
      { amount: 200_000n * E18, unlockEpoch: 12969n, beneficiary: KEY },
      { amount: 5n, unlockEpoch: 1n, beneficiary: KEY },
    ];
    expect(locksLiteral(locks)).toEqual({
      Literal: `8283c24a2a5a058fc295ed0000001932a95820${KEY}8305015820${KEY}`,
    });
  });

  it("withdraws the fee, launches and deposits the rest in one transaction", () => {
    const account = "component_2ddf493be0c6794c826b4578e3d8e136a020ec630c6105c463e62a0616b664d6";
    const ix = launchInstructions(NETWORKS.esmeralda, account, valid());
    const text = JSON.stringify(ix);
    expect(text.indexOf('"withdraw"')).toBeLessThan(text.indexOf('"launch"'));
    expect(text.indexOf('"launch"')).toBeLessThan(text.indexOf('"deposit"'));
    expect(text).toContain(NETWORKS.esmeralda.launchTemplate!);
    expect(() => launchInstructions(NETWORKS.mainnet, account, valid())).toThrow(/not published/);
  });
});
