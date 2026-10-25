import { describe, expect, it } from "vitest";

import { encodeCopilotActionContext } from "./action-context";
import { initialCopilotHandoff } from "./action-handoff";

const context = {
  version: 1 as const,
  action: "swap" as const,
  network: "testnet" as const,
  base: { currency: "XRP" },
  quote: { currency: "USD", issuer: "rIssuer" },
  amount: "10",
  route: "order-book" as const,
  quoteEvidence: {
    status: "live" as const,
    source: "xrpl-public-node" as const,
    observedAt: "2026-10-24T12:00:00.000Z",
    ledgerIndex: 12,
    inputAmount: "10",
    outputAmount: "5",
    liquidity: { available: true },
  },
};

describe("initialCopilotHandoff", () => {
  it("turns validated market context into a reviewable draft without submitting it", () => {
    const result = initialCopilotHandoff(`?${encodeCopilotActionContext(context)}`, Date.parse("2026-10-24T12:00:10.000Z"));
    expect(result.context).toEqual(context);
    expect(result.draft).toContain("prepare a swap action");
  });

  it("rejects stale evidence with a specific reason", () => {
    const result = initialCopilotHandoff(`?${encodeCopilotActionContext(context)}`, Date.parse("2026-10-24T12:01:00.000Z"));
    expect(result.context).toBeUndefined();
    expect(result.error).toContain("older than the 30 second limit");
  });

  it("turns wallet-first shortcuts into drafts", () => {
    expect(initialCopilotHandoff("?action=limit").draft).toContain("native XRPL limit order");
  });
});
