import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { integrationExplainers } from "./content";
import { integrationStories } from "./content/stories";
import { IntegrationFlow, stepDuration, storyLinks } from "./integration-flow";

describe("integration stories", () => {
  it.each(Object.entries(integrationStories))("%s only travels between actors it draws", (_slug, story) => {
    const ids = new Set(story.actors.map((actor) => actor.id));
    expect(ids.size).toBe(story.actors.length);
    for (const flow of story.flows) {
      expect(flow.steps.length).toBeGreaterThanOrEqual(3);
      for (const step of flow.steps) {
        expect(step.route.length).toBeGreaterThan(0);
        for (const id of step.route) expect(ids.has(id)).toBe(true);
      }
    }
    const used = new Set(story.flows.flatMap((flow) => flow.steps.flatMap((step) => step.route)));
    expect([...ids].filter((id) => !used.has(id))).toEqual([]);
    for (const actor of story.actors) {
      expect(actor.x).toBeGreaterThanOrEqual(5);
      expect(actor.x).toBeLessThanOrEqual(95);
      expect(actor.y).toBeGreaterThanOrEqual(10);
      expect(actor.y).toBeLessThanOrEqual(85);
    }
  });

  it.each(Object.entries(integrationStories))("%s offers a passing outcome and one that doesn't", (_slug, story) => {
    expect(story.flows.length).toBe(3);
    expect(story.flows.some((flow) => flow.tone === "success")).toBe(true);
    expect(story.flows.some((flow) => flow.tone !== "success")).toBe(true);
  });

  it.each(Object.entries(integrationStories))("%s keeps its honest status visible in plain words", (slug, story) => {
    expect(story.glance.status.toLowerCase()).toMatch(/mock|stand-in|emulator|simulat/);
    for (const flow of story.flows) expect(flow.takeaway.length).toBeGreaterThan(10);
    expect(Object.keys(integrationExplainers)).toContain(slug);
  });

  it("derives one line per pair of connected actors", () => {
    const links = storyLinks(integrationStories.mastercard);
    const keys = links.map(([a, b]) => [a, b].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(["harbor", "shop"].sort().join("|"));
  });

  it("gives longer captions more reading time, within bounds", () => {
    const short = stepDuration({ label: "a", title: "a", caption: "Short.", route: ["you"] });
    const long = stepDuration({ label: "a", title: "a", caption: "x".repeat(400), route: ["you"] });
    expect(short).toBeGreaterThanOrEqual(1600);
    expect(long).toBeLessThanOrEqual(4200);
    expect(long).toBeGreaterThan(short);
  });
});

describe("IntegrationFlow", () => {
  it("renders the outcome switch, diagram, explanation and step bar", () => {
    const markup = renderToStaticMarkup(createElement(IntegrationFlow, { story: integrationStories.quicknode, name: "QuickNode" }));
    expect(markup).toContain('data-integration-flow="QuickNode"');
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="QuickNode outcome"');
    expect(markup).toContain('aria-label="Steps"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain(integrationStories.quicknode.flows[0]!.steps[0]!.title);
    expect(markup).toContain(integrationStories.quicknode.flows[0]!.takeaway);
    expect(markup).toContain("Back");
    expect(markup).toContain("Next");
  });
});
