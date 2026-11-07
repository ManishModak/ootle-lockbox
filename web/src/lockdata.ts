/**
 * Loads one lock with everything its proof needs: the component, its live vault, the token's rules
 * and the current epoch. Shared by the lock page, the token page and the recent-locks list.
 */
import type { NetConfig } from "./config";
import { getSubstate, type Substate } from "./indexer";
import {
  lockStatus,
  readLock,
  readResource,
  readVault,
  type LockReading,
  type LockStatus,
  type ResourceReading,
  type VaultBalance,
} from "./verify";

export interface LoadedLock {
  id: string;
  reading: LockReading;
  vault: VaultBalance | null;
  resource: ResourceReading | null;
  status: LockStatus | null;
  /** All substates read were flagged verified by the indexer. */
  indexerVerified: boolean;
}

export async function loadLock(net: NetConfig, id: string, epoch: number): Promise<LoadedLock> {
  const comp = await getSubstate(net, id);
  const reading = readLock(comp.value, net.lockboxTemplate ?? "");
  const reads: Substate[] = [comp];
  let vault: VaultBalance | null = null;
  let resource: ResourceReading | null = null;
  if (reading.state) {
    const v = await getSubstate(net, reading.state.vault);
    reads.push(v);
    vault = readVault(v.value);
    if (vault) {
      const r = await getSubstate(net, vault.resource);
      reads.push(r);
      resource = readResource(r.value);
    }
  }
  return {
    id,
    reading,
    vault,
    resource,
    status: reading.state ? lockStatus(reading.state, epoch) : null,
    indexerVerified: reads.every((s) => s.indexerVerified),
  };
}

/** A lock is "verified" only when the lock is genuine, readable, and the token can't undo it. */
export function verdict(l: LoadedLock): "verified" | "unverified" | "unknown" {
  if (!l.reading.genuine) return "unverified";
  if (!l.vault || !l.resource) return "unknown";
  return l.resource.lockRisks.length === 0 ? "verified" : "unverified";
}

/** Runs async work over items with a small concurrency limit (the indexer is shared). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
