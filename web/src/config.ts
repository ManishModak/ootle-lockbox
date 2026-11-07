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
}

export const NETWORKS: Record<NetworkName, NetConfig> = {
  esmeralda: {
    name: "esmeralda",
    label: "Esmeralda testnet",
    network: Network.Esmeralda,
    indexer: "https://esme-indexer-a.ootle.tari.com",
    lockboxTemplate: "d7f5ee289465580308d3074a0892d90eefb4bf157200171692bdf47cc9473832",
    walletNetwork: "esmeralda",
  },
  mainnet: {
    name: "mainnet",
    label: "Mainnet",
    network: Network.MainNet,
    indexer: "https://indexer-a.ootle.tari.com",
    lockboxTemplate: null,
    walletNetwork: "mainnet",
  },
};

export const DEFAULT_NETWORK: NetworkName = "esmeralda";

/** Epochs last roughly 32-48 minutes; dates shown from epochs are estimates at this rate. */
export const MINUTES_PER_EPOCH = 40;

/** Fastest epochs seen. New locks convert a chosen time at this rate so they never open early. */
export const MIN_MINUTES_PER_EPOCH = 32;

/** Matches the template's MAX_MEMO_BYTES. */
export const MAX_MEMO_BYTES = 280;

export const REPO_URL = "https://github.com/ManishModak/ootle-lockbox";
