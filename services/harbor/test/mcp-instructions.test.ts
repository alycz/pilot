import { describe, expect, it } from "vitest";

import catalogManifest from "../catalog/manifest.json";
import { OpRegistry } from "../src/catalog/registry";
import { SERVER_INSTRUCTIONS } from "../src/mcp/tools";
import generatedOps from "../src/ops/index.gen";

describe("MCP server instructions", () => {
  it("stays within the 2,000-character contract and preserves the safe flow", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2_000);
    expect(SERVER_INSTRUCTIONS).toContain("Use search");
    expect(SERVER_INSTRUCTIONS).toContain("build and simulate first");
    expect(SERVER_INSTRUCTIONS).toContain("then call tx.execute");
    expect(SERVER_INSTRUCTIONS).toContain("return the approval to the user and stop");
    expect(SERVER_INSTRUCTIONS).toContain("do not retry it");
  });

  it("keeps the generated operation catalog aligned with the runtime registry", () => {
    const registry = new OpRegistry(generatedOps);
    const runtimeOps = registry.list();
    const manifestOps = [...catalogManifest.ops].sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    expect(manifestOps).toHaveLength(runtimeOps.length);
    expect(manifestOps.map(({ name }) => name)).toEqual(
      runtimeOps.map(({ name }) => name),
    );

    for (const operation of runtimeOps) {
      const manifest = manifestOps.find(({ name }) => name === operation.name);
      expect(manifest, operation.name).toMatchObject({
        name: operation.name,
        family: operation.family,
        summary: operation.summary,
        tags: operation.tags ?? [],
        returns: operation.returns,
        caveats: operation.caveats,
        example: operation.example,
      });
      expect(manifest?.signature, operation.name).toMatch(
        new RegExp(`^${operation.name.replaceAll(".", "\\.")}\\(`),
      );
      expect(manifest?.signature, operation.name).toContain(
        `→ ${operation.returns}`,
      );
    }
  });
});
