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
  /** Launch Commitments template address (64 hex), or null before it is published on this network. */
  launchTemplate: string | null;
  /** The flat launch fee that template was built with, in atomic TARI (its LAUNCH_FEE_MICROTARI). */
  launchFee: bigint | null;
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
    lockboxTemplate: "3f77a82e2eecb1795bc250ce919706519ea8feacc283d25f9e9740edc81b12b3",
    launchTemplate: "ec0b8e8bf1ad8e05e0745e66868929070358da5dd975d72cd1031befa5141a8a",
    launchFee: 10_000_000n, // 10 tTARI: the testnet build, paid to our own test account
    walletNetwork: "esmeralda",
    epochMinutes: { min: 32, typical: 60 }, // measured 32-48 minutes on 7 Nov 2026, ~83 on average 7-9 Nov
  },
  mainnet: {
    name: "mainnet",
    label: "Mainnet",
    network: Network.MainNet,
    indexer: "https://indexer-a.ootle.tari.com",
    lockboxTemplate: "968740ec9a0f3d368af2ba48d18af68bbb5c73a30ec582fbf9b00f90cb20ec72", // published 12 Nov 2026, tx 33f102de…
    launchTemplate: "b18fc1ae9195b569362311b6719896aa84078aedf4cf70a4aba19d516bcc9963", // published 12 Nov 2026, tx 6930fcd4…
    launchFee: 2_500_000_000n, // 2,500 TARI, paid to the Tari Universe account component_ee1a31b3…
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

/** A real mainnet lock (1 TARI, made from this app on 12 Nov 2026), linked from every home page. */
export const EXAMPLE_PROOF = "#/mainnet/lock/component_2a6375b91108f62a5711ee263d7d7bfbd619e6642c58a59bf546f701723e5484";
