import { describe, expect, it } from "vitest";
import raw from "./fixtures/esmeralda-launch-lock-raw.json";
import { decodeSubstate, parseJsonExact } from "./indexer";
import { readLock } from "./verify";

// The real 200,000-token launch lock (18 decimals, unlock epoch 12969), as the indexer serves it.
const LOCKBOX = "3f77a82e2eecb1795bc250ce919706519ea8feacc283d25f9e9740edc81b12b3";
const AMOUNT = "c24a2a5a058fc295ed000000"; // CBOR bignum 2*10^23
const UNLOCK_EPOCH = "1932a9"; // CBOR uint16 12969

/** The real substate with one CBOR item's bytes swapped for another. */
function patched(from: string, to: string): string {
  const hex = [...atob(raw.substate)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  expect(hex.split(from).length).toBe(2);
  const out = hex.replace(from, to);
  return btoa(String.fromCharCode(...(out.match(/../g) ?? []).map((x) => parseInt(x, 16))));
}

const read = (encoded: string) => readLock(decodeSubstate(encoded), LOCKBOX);

describe("decodeSubstate", () => {
  it("reads the real lock exactly", () => {
    expect(read(raw.substate).state).toMatchObject({ lockedAmount: 200_000n * 10n ** 18n, unlockEpoch: 12969n });
  });

  // Plain JSON.parse turns these into rounded numbers, which made genuine locks unreadable.
  it.each([
    ["one 18-decimal token", "1b0de0b6b3a7640000", 10n ** 18n],
    ["2^53 + 1", "1b0020000000000001", 2n ** 53n + 1n],
    ["2^64 - 1", "1bffffffffffffffff", 2n ** 64n - 1n],
    ["2^64 (bignum)", "c249010000000000000000", 2n ** 64n],
  ])("keeps a locked amount of %s exact", (_, cbor, want) => {
    const r = read(patched(AMOUNT, cbor));
    expect(r.genuine).toBe(true);
    expect(r.state?.lockedAmount).toBe(want);
  });

  it("keeps an unlock epoch beyond 2^53 exact", () => {
    const r = read(patched(UNLOCK_EPOCH, "1bffffffffffffffff"));
    expect(r.genuine).toBe(true);
    expect(r.state?.unlockEpoch).toBe(2n ** 64n - 1n);
  });
});

describe("parseJsonExact", () => {
  it("leaves safe numbers alone and makes big integers bigint", () => {
    expect(parseJsonExact('{"a": 12, "b": 1.5, "c": 9007199254740993, "d": -9007199254740993}')).toEqual({
      a: 12,
      b: 1.5,
      c: 9007199254740993n,
      d: -9007199254740993n,
    });
  });
});
