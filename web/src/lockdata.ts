/**
 * Loads one lock with everything its proof needs: the component, its live vault, the token's rules
 * and the current epoch. Shared by the lock page, the token page and the recent-locks list.
 */
import type { NetConfig } from "./config";
import { getSubstate, type Substate } from "./indexer";
import { launchProof, recordIsGenuine, recordLockIds, type LaunchProof } from "./launch";
import {
  lockStatus,
  readLock,
  readResource,
  readVault,
  tokenLockSafe,
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

/**
 * A lock is "verified" only when the lock is genuine, readable, and the token can't undo it. An
 * issuer power makes it "unverified"; token rules that couldn't be read make it "unknown".
 */
export function verdict(l: LoadedLock): "verified" | "unverified" | "unknown" {
  if (!l.reading.genuine) return "unverified";
  if (!l.vault || !l.resource) return "unknown";
  if (l.resource.lockRisks.length > 0) return "unverified";
  return tokenLockSafe(l.resource) ? "verified" : "unknown";
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

/** A Launch Commitments token with everything its proof page needs. */
export interface LoadedLaunch {
  token: ResourceReading | null;
  /** The record the token's `launched_by` names; null when it names none. */
  recordId: string | null;
  proof: LaunchProof | null;
  /** The record's locks as read, for their live status and balances (unreadable ones left out). */
  locks: LoadedLock[];
  indexerVerified: boolean;
}

const COMPONENT_ID = /^component_[0-9a-f]{64}$/;

/**
 * Reads a token, the record its `launched_by` names, and (only if that record's header is genuine)
 * the at most 8 locks it lists, then runs the proof. The token's pointer is only where to look:
 * the proof decides whether it holds.
 */
export async function loadLaunch(net: NetConfig, resourceId: string, epoch: number): Promise<LoadedLaunch> {
  const res = await getSubstate(net, resourceId);
  const token = readResource(res.value);
  const recordId = token?.launchedBy?.toLowerCase() ?? null;
  if (!recordId || !COMPONENT_ID.test(recordId) || !net.launchTemplate) {
    return { token, recordId: null, proof: null, locks: [], indexerVerified: res.indexerVerified };
  }
  const rec = await getSubstate(net, recordId);
  const ids = recordIsGenuine(rec.value, net.launchTemplate) === "yes" ? recordLockIds(rec.value) : [];
  const loaded = await mapLimit(ids, 4, (id) => loadLock(net, id, epoch).catch(() => null));
  const locks = loaded.filter((l): l is LoadedLock => l !== null);
  const proof = launchProof(
    {
      recordId,
      record: rec.value,
      resourceId,
      resource: res.value,
      locks: new Map(locks.map((l) => [l.id, { reading: l.reading, vault: l.vault }])),
    },
    net.launchTemplate,
    epoch,
  );
  return { token, recordId, proof, locks, indexerVerified: res.indexerVerified && rec.indexerVerified && locks.every((l) => l.indexerVerified) };
}
