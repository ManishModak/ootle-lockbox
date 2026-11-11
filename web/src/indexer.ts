/**
 * Read-only access to a network's public indexer. Events are used only to discover locks; every
 * page then re-reads the lock component, its vault and the token from current state.
 */
import { decodeEvent } from "@tari-project/ootle";
import { decodeSubstateValue as decodeSubstateJson } from "@tari-project/ootle-wasm-bor";
import type { NetConfig } from "./config";

/**
 * A failed indexer read. `kind` lets pages word it: the indexer couldn't be reached (or answered
 * with an error), the address isn't there, or what came back couldn't be used. `id` is the
 * substate that wasn't found, so a page can tell its own address missing from a dependency missing.
 */
export class IndexerError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "not-found" | "bad-data" = "bad-data",
    readonly id?: string,
  ) {
    super(message);
  }
}

async function getJson(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new IndexerError(`Could not reach the indexer (${(e as Error).message}).`, "unreachable");
  }
  if (res.status === 404) throw new IndexerError("Not found on this network.", "not-found");
  if (!res.ok) throw new IndexerError(`The indexer answered ${res.status}.`, "unreachable");
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
  let s: any;
  try {
    s = await getJson(`${net.indexer}/substates/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof IndexerError && e.kind === "not-found") throw new IndexerError(e.message, "not-found", id);
    throw e;
  }
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

/** One event from a template, with the transaction that emitted it. */
interface TemplateEvent {
  tx: string;
  payload: Record<string, unknown>;
}

/**
 * Events with `topic` emitted by `template`, newest first. Any template can emit any topic, so
 * events from other templates are dropped. `complete` is false when `maxPages` ran out before the
 * oldest event or an event couldn't be decoded.
 */
async function templateEvents(net: NetConfig, template: string, topic: string, maxPages: number): Promise<{ events: TemplateEvent[]; complete: boolean }> {
  const out: TemplateEvent[] = [];
  let decoded = true;
  let before: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ topic, limit: "100" });
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
      if (String(e.template_address).toLowerCase() !== template.toLowerCase() || e.topic !== topic) continue;
      out.push({ tx: String(tx).toLowerCase(), payload: e.payload ?? {} });
    }
    if (typeof r.next_before_id !== "number" || (r.events ?? []).length < 100) return { events: out, complete: decoded };
    before = r.next_before_id;
  }
  return { events: out, complete: false };
}

/** `Lockbox.LockCreated` events from the pinned Lockbox template, newest first, one per lock. */
export async function lockCreatedEvents(net: NetConfig, maxPages = 5): Promise<{ events: LockEvent[]; complete: boolean }> {
  if (!net.lockboxTemplate) return { events: [], complete: true };
  const r = await templateEvents(net, net.lockboxTemplate, "Lockbox.LockCreated", maxPages);
  const seen = new Set<string>();
  const events: LockEvent[] = [];
  for (const { tx, payload: p } of r.events) {
    if (typeof p.lock !== "string" || seen.has(p.lock)) continue;
    seen.add(p.lock);
    events.push({ tx, lock: p.lock, resource: String(p.resource) });
  }
  return { events, complete: r.complete };
}

/**
 * The address named by `field` in the `topic` event that `template` emitted in transaction `tx`,
 * or null if the indexer doesn't show one within about a minute (on Esmeralda it lagged the chain
 * by 20-40 seconds). Only the pinned template can emit its own events, so this can't pick up an
 * object some other transaction made.
 */
export async function addressFromTxEvent(net: NetConfig, template: string, topic: string, tx: string, field: string, prefix: string): Promise<string | null> {
  for (let attempt = 0; attempt < 24; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
    const { events } = await templateEvents(net, template, topic, 1);
    const v = events.find((e) => e.tx === tx.toLowerCase())?.payload[field];
    if (typeof v === "string" && new RegExp(`^${prefix}_[0-9a-f]{64}$`).test(v)) return v;
  }
  return null;
}
