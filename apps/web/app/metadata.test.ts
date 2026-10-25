import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("site metadata", () => {
  it("uses the approved home-page tab title", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(page).toContain('title: { absolute: "Agentic DeFi Terminal for XRPL" }');
    expect(page).not.toContain("XRPL agent infrastructure and trading workspace");
  });

  it("uses the Pilot mark in blue on a white favicon background", () => {
    const icon = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");

    expect(icon).toContain('fill="#ffffff"');
    expect(icon).toContain('stroke="#1f56c7"');
    expect(icon).toContain('<polygon points="12 2 19 21 12 17 5 21 12 2"/>');
    expect(icon).not.toContain("#161615");
  });
});
