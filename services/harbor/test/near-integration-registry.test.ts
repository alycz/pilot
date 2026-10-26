import { describe, expect, it } from "vitest";

import generatedOps from "../src/ops/index.gen";

describe("NEAR generated operation registry", () => {
  it("publishes only the bounded 1Click read and dry-quote surface", () => {
    const names = generatedOps.map((operation) => operation.name);
    expect(names).toEqual(expect.arrayContaining([
      "near.intents.tokens",
      "near.intents.quote",
      "near.intents.status",
    ]));
    expect(names).not.toContain("near.intents.execute");
    expect(names).not.toContain("near.intents.submit");
  });

  it("describes quote as dry and status as observation rather than execution", () => {
    const quote = generatedOps.find((operation) => operation.name === "near.intents.quote");
    const status = generatedOps.find((operation) => operation.name === "near.intents.status");
    expect(quote?.summary.toLowerCase()).toContain("dry");
    expect(quote?.caveats).toContain("off-ledger");
    expect(status?.summary.toLowerCase()).toContain("status");
    expect(status?.caveats).toContain("off-ledger");
  });
});
