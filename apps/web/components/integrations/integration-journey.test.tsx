import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { mastercardIntegration } from "./content";
import { IntegrationJourney, nextJourneyIndex } from "./integration-journey";

describe("IntegrationJourney", () => {
  it("renders selectable outcomes, nodes, steps, and visible boundaries", () => {
    const markup = renderToStaticMarkup(
      createElement(IntegrationJourney, { explainer: mastercardIntegration }),
    );

    expect(markup).toContain('data-integration-journey="mastercard"');
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Journey playback controls"');
    expect(markup).toContain('aria-label="Selectable system nodes"');
    expect(markup).toContain('aria-label="Trust boundaries"');
    expect(markup).toContain('aria-label="Animated system route"');
    expect(markup).toContain("Connected route");
    expect(markup).toContain("Boundary");
    expect(markup).toContain("Policy ∩ mandate");
    expect(markup).toContain("Previous step");
    expect(markup).toContain("Replay from first step");
    expect(markup).toContain("Next step");
    expect(markup).toContain("Swipe to explore every step");
    const source = readFileSync(new URL("./integration-journey.tsx", import.meta.url), "utf8");
    expect(source).toContain("border-dashed border-border bg-surface");
    expect(source).not.toContain("cursor-not-allowed opacity-55");
    expect(source).not.toContain("scrollIntoView");
  });

  it("wraps playback deterministically", () => {
    expect(nextJourneyIndex(0, 4, "previous")).toBe(3);
    expect(nextJourneyIndex(3, 4, "next")).toBe(0);
    expect(nextJourneyIndex(1, 4, "next")).toBe(2);
    expect(nextJourneyIndex(2, 4, "previous")).toBe(1);
    expect(nextJourneyIndex(2, 0, "next")).toBe(0);
  });
});
