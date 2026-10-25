import { describe, expect, it } from "vitest";

import { bindValidatedQuote, type CopilotActionContext } from "../copilot/action-context";
import { actionPreparationDetails } from "./action-preparation-card";

const NOW = Date.parse("2026-10-24T12:00:20.000Z");
const context: CopilotActionContext = {
  version: 1,
  action: "limit",
  network: "testnet",
  base: { currency: "XRP" },
  quote: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
  amount: "100",
  route: "order-book",
  quoteEvidence: {
    status: "live",
    source: "xrpl-public-node",
    observedAt: "2026-10-24T12:00:10.000Z",
    ledgerIndex: 123,
    inputAmount: "100",
    outputAmount: "51",
    networkFeeDrops: "12",
    slippageBps: 20,
    priceImpactBps: 9,
    liquidity: { available: true, inputCapacity: "250" },
  },
};

describe("actionPreparationDetails", () => {
  it("shows the same decision fields for a prepare-only limit order", () => {
    const result = actionPreparationDetails(context, "testnet", NOW, bindValidatedQuote(context));
    expect(result.availability.mode).toBe("prepare-only");
    expect(Object.fromEntries(result.items.map((item) => [item.label, item.value]))).toMatchObject({
      "Asset / amount": "100 XRP → RLUSD",
      "Quote age": "10s · xrpl-public-node",
      Fees: "12 drops network",
      "Slippage / impact": "20 bps slippage · 9 bps impact",
      Liquidity: "Up to 250 XRP",
      "Next approval": "Builder available; exact wallet approval binding pending",
    });
  });

  it("surfaces stale evidence as blocked rather than actionable", () => {
    const stale = actionPreparationDetails(
      context,
      "testnet",
      NOW + 60_000,
      bindValidatedQuote(context),
    );
    expect(stale.availability.mode).toBe("blocked");
    expect(stale.items.find((item) => item.label === "Next approval")?.value).toMatch(/older than/i);
  });

  it("does not call URL-provided context executable or preparable without a runtime quote binding", () => {
    const unbound = actionPreparationDetails(context, "testnet", NOW);
    expect(unbound.availability).toMatchObject({
      mode: "blocked",
      reasons: [{ code: "QUOTE_NOT_REVALIDATED" }],
    });
    expect(unbound.items.find((item) => item.label === "Next approval")?.value)
      .toMatch(/not bound to a fresh runtime quote/i);
  });
});
