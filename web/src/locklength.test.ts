import { describe, expect, it } from "vitest";
import { lockLengthTarget, toLocalInput } from "./locklength";

// Local wall-clock times, so the tests hold in any timezone.
const at = (y: number, m: number, d: number, hh = 10, mm = 30) => new Date(y, m - 1, d, hh, mm).getTime();

describe("lockLengthTarget", () => {
  it("adds a week as seven calendar days at the same time", () => {
    expect(lockLengthTarget("1w", at(2026, 11, 11))).toBe(at(2026, 11, 18));
    expect(lockLengthTarget("1w", at(2026, 12, 28))).toBe(at(2027, 1, 4));
  });

  it("adds calendar months and years", () => {
    expect(lockLengthTarget("1m", at(2026, 11, 11))).toBe(at(2026, 12, 11));
    expect(lockLengthTarget("3m", at(2026, 11, 11))).toBe(at(2027, 2, 11));
    expect(lockLengthTarget("6m", at(2026, 11, 11))).toBe(at(2027, 5, 11));
    expect(lockLengthTarget("1y", at(2026, 11, 11))).toBe(at(2027, 11, 11));
    expect(lockLengthTarget("2y", at(2026, 11, 11))).toBe(at(2028, 11, 11));
  });

  it("lands on the last day when the target month is shorter", () => {
    expect(lockLengthTarget("1m", at(2027, 1, 31))).toBe(at(2027, 2, 28));
    expect(lockLengthTarget("1m", at(2028, 1, 31))).toBe(at(2028, 2, 29));
    expect(lockLengthTarget("3m", at(2026, 11, 30))).toBe(at(2027, 2, 28));
    expect(lockLengthTarget("1y", at(2028, 2, 29))).toBe(at(2029, 2, 28));
  });

  it("is always later than now", () => {
    const now = at(2026, 11, 11);
    for (const l of ["1w", "1m", "3m", "6m", "1y", "2y"] as const) expect(lockLengthTarget(l, now)).toBeGreaterThan(now);
  });
});

describe("toLocalInput", () => {
  it("formats a local time for a datetime-local input, round-tripping through Date.parse", () => {
    const t = at(2027, 3, 5, 9, 7);
    expect(toLocalInput(t)).toBe("2027-03-05T09:07");
    expect(Date.parse(toLocalInput(t))).toBe(t);
  });
});
