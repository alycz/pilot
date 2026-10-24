import { describe, expect, it } from "vitest";

import type { OpContext, OpDef } from "../../src/catalog/registry";
import { ops as perpsOps } from "../../src/ops/perps";
import { ops as yieldOps } from "../../src/ops/yield";

const context = { principal: "h-content-public-read" } as OpContext;

function operation(ops: OpDef[], name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`Missing operation: ${name}`);
  return op;
}

describe("H-content P1.11 authorized public reads", () => {
  it("returns the read-only Hyperliquid XRP perpetual market", async () => {
    const result = (await operation(perpsOps, "perps.markets").handler(
      context,
      {},
    )) as { executionAvailable: boolean; markets: unknown[]; readOnly: boolean };
    expect(result).toMatchObject({ readOnly: true, executionAvailable: false });
    expect(result.markets).toHaveLength(1);
  });

  it("returns indexer and registry yield options without invented rates", async () => {
    const result = (await operation(yieldOps, "yield.options").handler(context, {
      amm_limit: 3,
    })) as { options: { id: string }[] };
    expect(result.options.some(({ id }) => id === "registry:doppler-finance")).toBe(
      true,
    );
    expect(result.options.some(({ id }) => id === "registry:soil")).toBe(true);
  });
});
