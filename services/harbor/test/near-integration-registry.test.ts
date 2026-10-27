import { describe, expect, it } from "vitest";

import generatedOps from "../src/ops/index.gen";

describe("NEAR generated operation registry", () => {
  it("publishes the exact bounded 1Click discovery and owner-funded backend surface", () => {
    const names = generatedOps
      .map((operation) => operation.name)
      .filter((name) => name.startsWith("near.intents."));
    expect(names).toEqual([
      "near.intents.tokens",
      "near.intents.quote",
      "near.intents.status",
      "near.intents.executable-quote.review",
      "near.intents.owner-funded.reserve",
      "near.intents.owner-funded.reconcile",
    ]);
    expect(names).not.toContain("near.intents.execute");
    expect(names).not.toContain("near.intents.submit");
    expect(names).not.toContain("near.intents.broadcast");
  });

  it("keeps dry discovery distinct from owner-reviewed reservation and reconciliation", () => {
    const quote = generatedOps.find((operation) => operation.name === "near.intents.quote");
    const status = generatedOps.find((operation) => operation.name === "near.intents.status");
    const review = generatedOps.find((operation) => operation.name === "near.intents.executable-quote.review");
    const reserve = generatedOps.find((operation) => operation.name === "near.intents.owner-funded.reserve");
    const reconcile = generatedOps.find((operation) => operation.name === "near.intents.owner-funded.reconcile");
    expect(quote?.summary.toLowerCase()).toContain("dry");
    expect(quote?.caveats).toContain("off-ledger");
    expect(status?.summary.toLowerCase()).toContain("status");
    expect(status?.caveats).toContain("off-ledger");
    expect(review?.returns.toLowerCase()).toContain("never builds, signs, broadcasts, or funds");
    expect(reserve?.summary.toLowerCase()).toContain("native near");
    expect(reserve?.returns.toLowerCase()).toContain("no transaction is built, signed, broadcast, or funded");
    expect(reconcile?.summary.toLowerCase()).toContain("native near");
    expect(reconcile?.returns.toLowerCase()).toContain("safe_to_resubmit always false");
  });
});
