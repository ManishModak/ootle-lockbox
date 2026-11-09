/**
 * Per-network settings. Each page URL names its network (`#/esmeralda/...`), so a proof link
 * always checks against the network it was made for. Mainnet's Lockbox address is filled in
 * after the 11 Nov publish; until then mainnet pages say so instead of reading.
 */
import { Network } from "@tari-project/ootle";

export type NetworkName = "esmeralda" | "mainnet";

export interface NetConfig {
  name: NetworkName;
  label: string;
  network: Network;
  indexer: string;
  /** Lockbox template address (64 hex), or null before it is published on this network. */
  lockboxTemplate: string | null;
  /** The value Sapient's `tari_getNetwork` reports for this network. */
  walletNetwork: string;
  /**
   * Epoch length in minutes. `min` is an assumed floor, not a guarantee (blocks can come faster):
   * new locks convert a chosen time at this rate, so they open on time unless epochs run shorter.
   * `typical` only drives the dates shown.
   */
  epochMinutes: { min: number; typical: number };
}

export const NETWORKS: Record<NetworkName, NetConfig> = {
  esmeralda: {
    name: "esmeralda",
    label: "Esmeralda testnet",
    network: Network.Esmeralda,
    indexer: "https://esme-indexer-a.ootle.tari.com",
    lockboxTemplate: "d7f5ee289465580308d3074a0892d90eefb4bf157200171692bdf47cc9473832",
    walletNetwork: "esmeralda",
    epochMinutes: { min: 32, typical: 60 }, // measured 32-48 minutes on 7 Nov 2026, ~83 on average 7-9 Nov
  },
  mainnet: {
    name: "mainnet",
    label: "Mainnet",
    network: Network.MainNet,
    indexer: "https://indexer-a.ootle.tari.com",
    lockboxTemplate: null,
    walletNetwork: "mainnet",
    // An epoch is 10 L1 blocks on mainnet since height 126,000 (Minotari v6 consensus_constants.rs),
    // at a 2-minute block target: ~20 minutes. `min` leaves 10% for blocks running fast.
    // Re-measure after launch.
    epochMinutes: { min: 18, typical: 20 },
  },
};

export const DEFAULT_NETWORK: NetworkName = "esmeralda";

/** Matches the template's MAX_MEMO_BYTES. */
export const MAX_MEMO_BYTES = 280;

export const REPO_URL = "https://github.com/ManishModak/ootle-lockbox";
