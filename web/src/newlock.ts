/**
 * Input rules for a new lock, kept pure so they can be tested: the beneficiary key, the unlock
 * epoch for a chosen time, and the fee the wallet must keep. Mistakes here are permanent, since a
 * lock can't be changed once created.
 */
import { generateOotleAddress, parseOotleAddress } from "@tari-project/ootle-wasm";
import type { NetConfig } from "./config";

/** Native TARI. Fees are paid in it, so locking it must leave the fee behind. */
export const NATIVE_TARI = "resource_0101010101010101010101010101010101010101010101010101010101010101";

/** The most fee a Lockbox transaction may take, atomic TARI. Used for dry runs and submits alike. */
export const MAX_FEE = 50_000n;

/**
 * The first epoch at which a lock may open no earlier than `targetMs`. The current epoch may end
 * at any moment, so only epochs after the next boundary count, each at the network's shortest
 * length. Null if the target isn't in the future.
 */
export function unlockEpochFor(net: NetConfig, currentEpoch: number, targetMs: number, nowMs: number): number | null {
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) return null;
  return currentEpoch + 1 + Math.ceil((targetMs - nowMs) / 60_000 / net.epochMinutes.min);
}

/** The most of a balance that can be locked, leaving the fee when the token is native TARI. */
export function lockableAmount(resource: string, balance: bigint): bigint {
  if (resource !== NATIVE_TARI) return balance;
  return balance > MAX_FEE ? balance - MAX_FEE : 0n;
}

/*
 * Beneficiary keys. A lock binds its claim to one public key forever, so a key that is not a
 * valid Ristretto point (or is the identity point, which no one can sign for) would strand the
 * tokens. The Ootle WASM decodes keys exactly as the chain does.
 */

/** Ootle address network bytes, as `parseOotleAddress` reports them. */
export const NETWORK_BYTE = { esmeralda: 38, mainnet: 0 } as const;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));

/** True for a canonical, non-identity Ristretto public key given as 64 hex chars. */
export function isValidPublicKey(hex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(hex) || /^0+$/.test(hex)) return false;
  const k = fromHex(hex);
  try {
    generateOotleAddress(k, k, 0); // decodes both keys; throws on a non-canonical point
    return true;
  } catch {
    return false;
  }
}

/**
 * A beneficiary typed by the user: a 64-hex public key, or an `otl_` address on `networkByte`
 * (its owner key). Returns the key as lowercase hex, or null if it isn't a usable key.
 */
export function parseBeneficiary(input: string, networkByte: number): string | null {
  const v = input.trim();
  let key: string | null = null;
  if (/^[0-9a-f]{64}$/i.test(v)) key = v.toLowerCase();
  else if (/^otl_/.test(v)) {
    try {
      const a = parseOotleAddress(v);
      if (a.network === networkByte) key = toHex(a.owner_key as Uint8Array);
    } catch {
      key = null;
    }
  }
  return key !== null && isValidPublicKey(key) ? key : null;
}
