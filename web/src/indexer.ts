/**
 * Read-only access to a network's public indexer. Events are used only to discover locks; every
 * page then re-reads the lock component, its vault and the token from current state.
 */
import { decodeEvent, decodeSubstateValue } from "@tari-project/ootle";
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
  return { value: decodeSubstateValue(enc), version: Number(s.version), indexerVerified: s.verified === true };
}

export interface LockEvent {
  tx: string;
  lock: string;
  resource: string;
  amount: string;
  beneficiary: string;
  unlockEpoch: number;
}

/**
 * `Lockbox.LockCreated` events emitted by the pinned template, newest first. Any template can emit
 * an event with this topic, so events from other templates are dropped here. `complete` is false
 * when `maxPages` ran out before the oldest event.
 */
export async function lockCreatedEvents(net: NetConfig, maxPages = 5): Promise<{ events: LockEvent[]; complete: boolean }> {
  const template = net.lockboxTemplate;
  if (!template) return { events: [], complete: true };
  const out: LockEvent[] = [];
  const seen = new Set<string>();
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
        amount: String(p.amount),
        beneficiary: String(p.beneficiary),
        unlockEpoch: Number(p.unlock_epoch),
      });
    }
    if (typeof r.next_before_id !== "number" || (r.events ?? []).length < 100) return { events: out, complete: true };
    before = r.next_before_id;
  }
  return { events: out, complete: false };
}
