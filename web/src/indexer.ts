/**
 * Read-only access to a network's public indexer. Events are used only to discover locks; every
 * page then re-reads the lock component, its vault and the token from current state.
 */
import { decodeEvent } from "@tari-project/ootle";
import { decodeSubstateValue as decodeSubstateJson } from "@tari-project/ootle-wasm-bor";
import type { NetConfig } from "./config";

export class IndexerError extends Error {}

async function getJson(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new IndexerError(`Could not reach the indexer (${(e as Error).message}).`);
  }
  if (res.status === 404) throw new IndexerError("Not found on this network.");
  if (!res.ok) throw new IndexerError(`The indexer answered ${res.status}.`);
  return res.json();
}

export function indexerHost(net: NetConfig): string {
  return new URL(net.indexer).host;
}

export async function currentEpoch(net: NetConfig): Promise<number> {
  const s = await getJson(`${net.indexer}/epoch-manager/stats`);
  if (typeof s.current_epoch !== "number") throw new IndexerError("The indexer returned no epoch.");
  return s.current_epoch;
}

export interface Substate {
  value: unknown;
  version: number;
  /** The indexer's own flag that it checked this substate; shown, not relied on. */
  indexerVerified: boolean;
}

export async function getSubstate(net: NetConfig, id: string): Promise<Substate> {
  const s = await getJson(`${net.indexer}/substates/${encodeURIComponent(id)}`);
  const enc = s?.state?.up?.substate;
  if (typeof enc !== "string") throw new IndexerError("This substate has been removed or is not readable.");
  let value: unknown;
  try {
    value = decodeSubstate(enc);
  } catch {
    throw new IndexerError("The indexer returned a substate that could not be decoded.");
  }
  return { value, version: Number(s.version), indexerVerified: s.verified === true };
}

/**
 * Decodes a substate with integers beyond 2^53 kept exact as bigint. The SDK's own
 * `decodeSubstateValue` runs plain `JSON.parse` on the same decoder output, which rounds them
 * (one token of an 18-decimal token is already 10^18).
 */
export function decodeSubstate(encoded: string): unknown {
  return parseJsonExact(decodeSubstateJson(encoded));
}

/**
 * `JSON.parse` that turns integers outside the safe range into exact bigints, using the reviver's
 * source text. A browser without that keeps the rounded number, which every reader here rejects
 * as unsafe, so the page fails closed ("unable to verify") instead of showing a wrong value.
 */
export function parseJsonExact(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

export interface LockEvent {
  tx: string;
  lock: string;
  resource: string;
}

/**
 * `Lockbox.LockCreated` events emitted by the pinned template, newest first. Any template can emit
 * an event with this topic, so events from other templates are dropped here. `complete` is false
 * when `maxPages` ran out before the oldest event or an event couldn't be decoded.
 */
export async function lockCreatedEvents(net: NetConfig, maxPages = 5): Promise<{ events: LockEvent[]; complete: boolean }> {
  const template = net.lockboxTemplate;
  if (!template) return { events: [], complete: true };
  const out: LockEvent[] = [];
  const seen = new Set<string>();
  let decoded = true;
  let before: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ topic: "Lockbox.LockCreated", limit: "100" });
    if (before !== undefined) q.set("before_id", String(before));
    const r = await getJson(`${net.indexer}/transactions/events?${q}`);
    for (const [tx, enc] of r.events ?? []) {
      let e: any;
      try {
        e = decodeEvent(enc);
      } catch {
        decoded = false; // could be one of ours
        continue;
      }
      if (String(e.template_address).toLowerCase() !== template || e.topic !== "Lockbox.LockCreated") continue;
      const p = e.payload ?? {};
      if (typeof p.lock !== "string" || seen.has(p.lock)) continue;
      seen.add(p.lock);
      out.push({
        tx,
        lock: p.lock,
        resource: String(p.resource),
      });
    }
    if (typeof r.next_before_id !== "number" || (r.events ?? []).length < 100) return { events: out, complete: decoded };
    before = r.next_before_id;
  }
  return { events: out, complete: false };
}
