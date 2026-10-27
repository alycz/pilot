import { describe, expect, it } from "vitest";

import { integrationExplainers } from "./content";
import { integrationLinks } from "./integration-links";

describe("integration explainer content", () => {
  it("preserves the four explainers and adds the bounded NEAR fixture route once", () => {
    expect(integrationLinks.map((item) => item.href)).toEqual([
      "/integrations/mastercard",
      "/integrations/aws",
      "/integrations/quicknode",
      "/integrations/ledger",
      "/demo/near-intents",
    ]);
    expect(new Set(integrationLinks.map((item) => item.slug)).size).toBe(5);
    expect(Object.keys(integrationExplainers).sort()).toEqual(
      integrationLinks.filter((item) => item.slug !== "near-intents").map((item) => item.slug).sort(),
    );
  });

  it("keeps every explainer interactive, bounded, and claim-safe", () => {
    for (const explainer of Object.values(integrationExplainers)) {
      expect(explainer.nodes.length).toBeGreaterThanOrEqual(6);
      expect(explainer.zones.length).toBeGreaterThanOrEqual(4);
      expect(explainer.scenarios.length).toBeGreaterThanOrEqual(3);
      expect(explainer.scenarios.some((scenario) => scenario.tone === "success")).toBe(true);
      expect(explainer.scenarios.some((scenario) => scenario.tone !== "success")).toBe(true);
      expect(explainer.scenarios.every((scenario) => scenario.steps.length >= 3)).toBe(true);
      expect(explainer.boundaries.length).toBeGreaterThanOrEqual(3);
      expect(explainer.demonstrates.length).toBeGreaterThan(0);
      expect(explainer.doesNotDemonstrate.length).toBeGreaterThan(0);
      expect(explainer.sources.length).toBeGreaterThanOrEqual(3);
      expect(`${explainer.status} ${explainer.truthLabel}`.toLowerCase()).toMatch(
        /mock|simulat|stand-in/,
      );

      const nodeIds = new Set(explainer.nodes.map((node) => node.id));
      const zoneIds = new Set(explainer.zones.map((zone) => zone.id));
      expect(explainer.nodes.every((node) => zoneIds.has(node.zone))).toBe(true);
      expect(explainer.scenarios.every((scenario) =>
        scenario.steps.every((step) => nodeIds.has(step.nodeId)),
      )).toBe(true);
    }
  });

  it("states the pitch-critical boundaries explicitly", () => {
    expect(`${integrationExplainers.ledger.status} ${integrationExplainers.ledger.truthLabel}`).toMatch(
      /Physical hardware is not required/i,
    );
    expect(JSON.stringify(integrationExplainers.ledger)).toMatch(/Speculos/i);
    expect(JSON.stringify(integrationExplainers.mastercard)).toMatch(/no Mastercard-network money movement/i);
    expect(JSON.stringify(integrationExplainers.quicknode)).toMatch(/not live QuickNode traffic/i);
    expect(JSON.stringify(integrationExplainers.aws)).toMatch(/No live AWS account/i);
  });
});
