import { describe, expect, it } from "vitest";

import { searchDocs } from "../../src/adapters/docs-mcp";
import { ops } from "../../src/ops/venues";

describe("live XRPL documentation integrations", () => {
  it("finds DelegateSet through the XRPL Docs MCP", async () => {
    const hits = await searchDocs("DelegateSet");

    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.some((hit) =>
        `${hit.title} ${hit.snippet}`.toLocaleLowerCase().includes("delegateset"),
      ),
    ).toBe(true);
  });

  it("reads a safety-adapted pinned XRPL trading reference", async () => {
    const read = ops.find(({ name }) => name === "skill.read");
    if (!read) throw new Error("Missing skill.read operation");

    const result = (await read.handler(
      { principal: "p1.10-live-check" },
      { id: "xrpl-trading" },
    )) as { content?: string; contentMode?: string; sourceUrl?: string };

    expect(result.sourceUrl).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/XRPLF\/xrpl-dev-portal\/[0-9a-f]{40}\//,
    );
    expect(result.contentMode).toBe("harbor-safety-summary");
    expect(result.content).toContain(result.sourceUrl);
  });
});
