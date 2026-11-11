/**
 * Quick lock lengths for the create and launch forms ("1 year" and so on), kept pure so they can
 * be tested. A length only sets the target time; the unlock epoch is still worked out from that
 * time by `unlockEpochFor`, exactly as for a typed date.
 */

export type LockLength = "1w" | "1m" | "3m" | "6m" | "1y" | "2y";

export const LOCK_LENGTHS: { id: LockLength; label: string }[] = [
  { id: "1w", label: "1 week" },
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "6m", label: "6 months" },
  { id: "1y", label: "1 year" },
  { id: "2y", label: "2 years" },
];

const MONTHS: Record<Exclude<LockLength, "1w">, number> = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24 };

/**
 * The time `length` after `nowMs` on the viewer's calendar, at the same wall-clock time. Months
 * are calendar months; a day the target month lacks becomes its last day (31 Jan + 1 month is
 * 28 or 29 Feb, never 2 or 3 Mar).
 */
export function lockLengthTarget(length: LockLength, nowMs: number): number {
  const d = new Date(nowMs);
  if (length === "1w") {
    d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + MONTHS[length]);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}

/** A time as a `datetime-local` input value ("2027-11-11T23:05"), in the viewer's timezone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
