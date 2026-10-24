import { describe, expect, it } from "vitest";

import { encodeCurrencyCode, normalizeIssuedCurrencyCodes } from "./normalize-transaction";

describe("normalizeIssuedCurrencyCodes", () => {
  it("encodes readable non-standard issued currencies throughout a transaction", () => {
    const tx = normalizeIssuedCurrencyCodes({
      TakerGets: { currency: "RLUSD", issuer: "rIssuer", value: "80" },
      Paths: [[{ currency: "USDC", issuer: "rIssuer" }]],
    });

    expect(tx.TakerGets.currency).toBe("524C555344000000000000000000000000000000");
    expect(tx.Paths[0][0].currency).toBe("5553444300000000000000000000000000000000");
    expect(tx.TakerGets.issuer).toBe("rIssuer");
  });

  it("preserves XRP, three-character codes, and existing 160-bit codes", () => {
    const encoded = encodeCurrencyCode("RLUSD");
    expect(encodeCurrencyCode("XRP")).toBe("XRP");
    expect(encodeCurrencyCode(encoded)).toBe(encoded);
  });

  it("rejects issued currency labels longer than twenty bytes", () => {
    expect(() => encodeCurrencyCode("A".repeat(21))).toThrow(/20 bytes/);
  });
});
