import { describe, expect, it } from "vitest";
import { NETWORKS, networkFor } from "./config";

describe("networkFor", () => {
  it("keeps a network the URL names", () => {
    expect(networkFor("esmeralda")).toBe(NETWORKS.esmeralda);
    expect(networkFor("mainnet")).toBe(NETWORKS.mainnet);
  });

  it("opens mainnet for a bare or unknown first segment, inherited object keys included", () => {
    for (const n of ["", "lock", "Mainnet", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(networkFor(n), n).toBe(NETWORKS.mainnet);
    }
  });
});
