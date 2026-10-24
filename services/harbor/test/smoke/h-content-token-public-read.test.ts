import { describe, expect, it } from "vitest";
import type { OpContext } from "../../src/catalog/registry";
import { ops } from "../../src/ops/tokens";

describe("authorized public token read", () => {
  it("merges mainnet RLUSD metadata with validated issuer flags", async () => {
    const lookup = ops.find(({ name }) => name === "tokens.lookup");
    if (!lookup) throw new Error("missing tokens.lookup");
    const result = (await lookup.handler(
      { principal: "h-content-public-read" } as OpContext,
      {
        network: "mainnet",
        currency: "524C555344000000000000000000000000000000",
        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      },
    )) as {
      issuer: string;
      metadataSource: string;
      ledgerFlags: Record<string, boolean>;
    };
    expect(result.issuer).toBe("rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De");
    expect(result.metadataSource).toMatch(/^(xrpl\.to|xrpscan|bithomp)$/);
    expect(result.ledgerFlags).toEqual({
      requireAuth: expect.any(Boolean),
      freeze: expect.any(Boolean),
      clawback: expect.any(Boolean),
      blackholed: expect.any(Boolean),
    });
  });
});
