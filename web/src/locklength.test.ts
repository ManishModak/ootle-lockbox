import { afterEach, describe, expect, it } from "vitest";
import { lockLengthTarget, toLocalInput } from "./locklength";

// Tests run in Node; the app has no Node types, so declare the one bit used here.
declare const process: { env: Record<string, string | undefined> };

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

describe("lockLengthTarget across timezones", () => {
  // Node re-reads TZ when it is assigned, so each test can run on another zone's calendar.
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it("does not drift through a DST gap on the way (Lord Howe, first Sunday of October 2028)", () => {
    process.env.TZ = "Australia/Lord_Howe";
    // 1 Oct 2028 02:00-02:30 doesn't exist there; month arithmetic must not pass through it.
    expect(lockLengthTarget("1m", at(2028, 10, 31, 2, 15))).toBe(Date.parse("2028-11-30T02:15"));
    // A target inside the gap gives the same time as typing it.
    expect(lockLengthTarget("1w", at(2028, 9, 24, 2, 15))).toBe(Date.parse("2028-10-01T02:15"));
  });

  for (const tz of ["Australia/Lord_Howe", "America/New_York", "Asia/Kolkata", "UTC"]) {
    it(`keeps month ends and leap days in ${tz}`, () => {
      process.env.TZ = tz;
      expect(lockLengthTarget("1m", at(2027, 1, 31, 2, 15))).toBe(Date.parse("2027-02-28T02:15"));
      expect(lockLengthTarget("1m", at(2028, 1, 31, 2, 15))).toBe(Date.parse("2028-02-29T02:15"));
      expect(lockLengthTarget("1y", at(2028, 2, 29, 2, 15))).toBe(Date.parse("2029-02-28T02:15"));
      expect(lockLengthTarget("6m", at(2026, 8, 31, 2, 15))).toBe(Date.parse("2027-02-28T02:15"));
    });
  }

  it("drops seconds, so the target matches what the date input shows", () => {
    const now = new Date(2026, 10, 11, 23, 5, 37, 250).getTime();
    const t = lockLengthTarget("1y", now);
    expect(Date.parse(toLocalInput(t))).toBe(t);
    expect(toLocalInput(t)).toBe("2027-11-11T23:05");
  });
});

describe("toLocalInput", () => {
  it("formats a local time for a datetime-local input, round-tripping through Date.parse", () => {
    const t = at(2027, 3, 5, 9, 7);
    expect(toLocalInput(t)).toBe("2027-03-05T09:07");
    expect(Date.parse(toLocalInput(t))).toBe(t);
  });
});
