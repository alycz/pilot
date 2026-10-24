import { describe, expect, it } from "vitest";

import { ValidatedTransactionSchema } from "../src/schemas";

describe("Ledger provenance boundary", () => {
  it("rejects client-asserted hardware provenance instead of persisting it", () => {
    const forged = {
      intent: {
        id: "intent-owner-signed",
        network: "testnet",
        kind: "cancel",
        offer_sequence: 7,
      },
      hash: "A".repeat(64),
      venue: "xrpl-dex-clob",
      assets: [{ currency: "XRP" }],
      result: "success",
      fillPrice: "unavailable",
      slippageBps: 0,
      signedBy: "owner",
      created: "2026-10-21T20:00:00.000Z",
      ownerSigner: { kind: "ledger", accountIndex: 1 },
    };

    expect(ValidatedTransactionSchema.safeParse(forged).success).toBe(false);
  });
});
