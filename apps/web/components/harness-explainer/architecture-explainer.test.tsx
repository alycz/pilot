import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArchitectureExplainer, flowPlaybackAllowed } from "./architecture-explainer";

describe("ArchitectureExplainer", () => {
  const markup = renderToStaticMarkup(<ArchitectureExplainer />);

  it("renders the full interactive flow with keyboard and playback affordances", () => {
    expect(markup).toContain("Interactive system map");
    expect(markup).toContain("Play flow");
    expect(markup).toContain("Replay");
    expect(markup).toContain("Stage 01 of 12");
    expect(markup.match(/aria-label="Stage [0-9]+:/g)).toHaveLength(12);
    expect(markup).toContain("Use arrow keys to move between stages");
    expect(markup).not.toContain("Space toggles playback");
  });

  it("never starts automatic playback for reduced-motion users", () => {
    expect(flowPlaybackAllowed(false)).toBe(true);
    expect(flowPlaybackAllowed(true)).toBe(false);
  });

  it("renders the source-truth status labels and synthetic model switch", () => {
    expect(markup).toContain("Implemented");
    expect(markup).toContain("Inspired");
    expect(markup).toContain("Optional · not enabled");
    expect(markup).toContain("Switch the model. Keep the confirmed context.");
    expect(markup).toContain("Reviewed memory · not training");
    expect(markup).toContain("Offline · synthetic data");
  });

  it("surfaces privacy and execution boundaries in the rendered experience", () => {
    expect(markup).toContain("Relevant authorized context only");
    expect(markup).toContain("ledger history remains immutable");
    expect(markup).toContain("not guaranteed performance or profitability");
    expect(markup).toContain("no real conversations, wallet addresses, balances, or transactions");
  });
});
