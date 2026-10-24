import { DEFAULT_POLICY } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import { marketParam, policyStrip } from "./policy-strip";

describe("policyStrip", () => {
  it("summarises the demo policy in order", () => {
    const strip = policyStrip(DEFAULT_POLICY, "testnet");
    expect(strip.cells.map((cell) => cell.label)).toEqual([
      "Auto-execute under",
      "Per transaction",
      "Daily cap",
      "Max slippage",
      "Networks",
      "Issuer allowlist",
    ]);
    expect(strip.cells.map((cell) => cell.value)).toEqual(["$250", "$2,000", "$5,000", "100 bps", "Testnet · Devnet", "RLUSD"]);
    expect(strip.networkNote).toBeNull();
  });

  it("flags a Mainnet market as research-only when the policy excludes Mainnet", () => {
    const strip = policyStrip(DEFAULT_POLICY, "mainnet");
    expect(strip.networkNote).toBe("Pilot trades Testnet and Devnet; this Mainnet market is for research.");
  });

  it("handles empty allowlists", () => {
    const strip = policyStrip({ ...DEFAULT_POLICY, issuer_allowlist: [], networks: [] }, "testnet");
    expect(strip.cells.at(-1)?.value).toBe("None");
    expect(strip.cells.at(-2)?.value).toBe("None");
    expect(strip.networkNote).toBe("Pilot trades only on allowed networks; this Testnet market is for research.");
  });
});

describe("marketParam", () => {
  it("accepts well-formed row keys only", () => {
    expect(marketParam("mainnet:xrp-rlusd:order-book")).toBe("mainnet:xrp-rlusd:order-book");
    expect(marketParam("testnet:xrp-rlusd:amm")).toBe("testnet:xrp-rlusd:amm");
    expect(marketParam("mainnet:xrp-rlusd:path")).toBeNull();
    expect(marketParam("<script>")).toBeNull();
    expect(marketParam(null)).toBeNull();
  });
});
