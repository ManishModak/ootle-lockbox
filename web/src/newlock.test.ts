import { generateKeypair, generateOotleAddress } from "@tari-project/ootle-wasm";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "./config";
import { isValidPublicKey, lockableAmount, MAX_FEE, NATIVE_TARI, NETWORK_BYTE, parseBeneficiary, unlockEpochFor } from "./newlock";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// The real beneficiary of the Esmeralda demo lock.
const REAL = "f6e42c6b84bf67290a401d55daa49f332ca2acdab86da7b1210b2a1d8eebd017";

describe("isValidPublicKey", () => {
  it("accepts real keys", () => {
    expect(isValidPublicKey(REAL)).toBe(true);
    expect(isValidPublicKey(hex(generateKeypair().public_key))).toBe(true);
  });

  it("rejects bytes that are not a canonical point, and the identity", () => {
    expect(isValidPublicKey("ff".repeat(32))).toBe(false);
    expect(isValidPublicKey("ed" + "ff".repeat(30) + "7f")).toBe(false);
    expect(isValidPublicKey("00".repeat(32))).toBe(false);
  });
});

describe("parseBeneficiary", () => {
  const kp = generateKeypair();
  const addr = (net: number) => generateOotleAddress(kp.public_key, kp.public_key, net);

  it("reads a key from hex or from an address on the right network", () => {
    expect(parseBeneficiary(REAL.toUpperCase(), NETWORK_BYTE.esmeralda)).toBe(REAL);
    expect(parseBeneficiary(addr(NETWORK_BYTE.esmeralda), NETWORK_BYTE.esmeralda)).toBe(hex(kp.public_key));
  });

  it("rejects an address for another network and an invalid hex key", () => {
    expect(parseBeneficiary(addr(NETWORK_BYTE.mainnet), NETWORK_BYTE.esmeralda)).toBeNull();
    expect(parseBeneficiary("ff".repeat(32), NETWORK_BYTE.esmeralda)).toBeNull();
    expect(parseBeneficiary("otl_nonsense", NETWORK_BYTE.esmeralda)).toBeNull();
  });
});

describe("unlockEpochFor", () => {
  const net = NETWORKS.esmeralda; // shortest epoch 32 minutes
  const now = 1_000_000_000_000;
  const min = 60_000;

  it("adds a whole spare epoch, since the current one may end right away", () => {
    // 64 minutes = 2 shortest epochs, counted from the next boundary.
    expect(unlockEpochFor(net, 100, now + 64 * min, now)).toBe(103);
    expect(unlockEpochFor(net, 100, now + 65 * min, now)).toBe(104);
    expect(unlockEpochFor(net, 100, now + 1 * min, now)).toBe(102);
  });

  it("never opens before the chosen time, even if the current epoch ends now", () => {
    for (const minutes of [1, 31, 32, 33, 500, 525_600]) {
      const e = unlockEpochFor(net, 100, now + minutes * min, now)!;
      // Worst case: epoch 101 starts immediately, and each later epoch is the shortest possible.
      expect((e - 101) * net.epochMinutes.min).toBeGreaterThanOrEqual(minutes);
    }
  });

  it("rejects a time that isn't in the future", () => {
    expect(unlockEpochFor(net, 100, now, now)).toBeNull();
    expect(unlockEpochFor(net, 100, Number.NaN, now)).toBeNull();
  });
});

describe("lockableAmount", () => {
  it("keeps the fee back only for native TARI", () => {
    expect(lockableAmount(NATIVE_TARI, 1_000_000n)).toBe(1_000_000n - MAX_FEE);
    expect(lockableAmount(NATIVE_TARI, MAX_FEE)).toBe(0n);
    expect(lockableAmount("resource_" + "aa".repeat(32), 7n)).toBe(7n);
  });
});
