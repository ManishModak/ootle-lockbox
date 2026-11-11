/**
 * Input rules for a new Launch Commitments token, kept pure so they can be tested. They mirror the
 * template's own checks (`check_inputs` in launch-commitments src/lib.rs), so a mistake is caught
 * before the wallet opens; the template still refuses anything that slips past.
 */
import { isValidPublicKey } from "./newlock";

/** Launched tokens always have 18 decimals. */
export const LAUNCH_DECIMALS = 18;
export const MAX_LAUNCH_LOCKS = 8;
export const MAX_SYMBOL_BYTES = 12;
export const MAX_NAME_BYTES = 64;
export const MAX_IMAGE_URL_BYTES = 256;
/** Locks may open at most this many epochs ahead (the template's MAX_LOCK_EPOCHS). */
export const MAX_LOCK_EPOCHS = 530_000n;
/** Amounts are u128 on chain. */
const MAX_AMOUNT = 2n ** 128n - 1n;

export interface LaunchLockInput {
  amount: bigint;
  unlockEpoch: bigint;
  beneficiary: string; // public key, 64 hex
}

export interface LaunchInput {
  symbol: string;
  name: string;
  imageUrl: string;
  supply: bigint;
  locks: LaunchLockInput[];
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The first problem with `input` at `currentEpoch`, in plain words, or null if the template will accept it. */
export function launchProblem(input: LaunchInput, currentEpoch: bigint): string | null {
  const { symbol, name, imageUrl, supply, locks } = input;
  if (bytes(symbol) < 1 || bytes(symbol) > MAX_SYMBOL_BYTES) return `The symbol must be 1–${MAX_SYMBOL_BYTES} bytes.`;
  if (bytes(name) < 1 || bytes(name) > MAX_NAME_BYTES) return `The name must be 1–${MAX_NAME_BYTES} bytes.`;
  if (bytes(imageUrl) > MAX_IMAGE_URL_BYTES) return `The image URL is longer than ${MAX_IMAGE_URL_BYTES} bytes.`;
  if (imageUrl !== "" && !imageUrl.startsWith("https://")) return "The image URL must start with https://.";
  if (supply <= 0n) return "The supply must be more than zero.";
  if (supply > MAX_AMOUNT) return "The supply is too large.";
  if (locks.length < 1 || locks.length > MAX_LAUNCH_LOCKS) return `Add 1–${MAX_LAUNCH_LOCKS} allocations.`;
  let total = 0n;
  for (const [i, l] of locks.entries()) {
    const n = `Allocation ${i + 1}`;
    if (l.amount <= 0n) return `${n}: the amount must be more than zero.`;
    if (!isValidPublicKey(l.beneficiary)) return `${n}: the beneficiary is not a valid public key.`;
    if (l.unlockEpoch <= currentEpoch) return `${n}: the unlock time must be in the future.`;
    if (l.unlockEpoch - currentEpoch > MAX_LOCK_EPOCHS) return `${n}: the unlock time is too far away (at most ${MAX_LOCK_EPOCHS} epochs).`;
    total += l.amount;
  }
  if (total > supply) return "The allocations add up to more than the supply.";
  return null;
}

/** Whether a genuine record (and its token's symbol and name) is the launch the user reviewed. */
export function isThisLaunch(
  record: { supply: bigint; createdAtEpoch: bigint; locks: LaunchLockInput[] },
  symbol: string | null,
  name: string | null,
  input: LaunchInput,
  reviewedAt: number,
): boolean {
  return (
    record.createdAtEpoch >= BigInt(reviewedAt) &&
    record.supply === input.supply &&
    symbol === input.symbol &&
    name === input.name &&
    record.locks.length === input.locks.length &&
    record.locks.every((l, i) => l.amount === input.locks[i].amount && l.unlockEpoch === input.locks[i].unlockEpoch && l.beneficiary === input.locks[i].beneficiary)
  );
}
