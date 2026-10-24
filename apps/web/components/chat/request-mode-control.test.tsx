import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RequestModeControl } from "./request-mode-control";
import { resolveRequestMode } from "./request-mode";

describe("RequestModeControl", () => {
  it("uses the exact safe default label and exposes all choices accessibly", () => {
    const markup = renderToStaticMarkup(createElement(RequestModeControl, {
      value: "auto",
      resolution: resolveRequestMode("auto", "Trade XRP"),
      onChange: vi.fn(),
    }));
    for (const label of ["Let agent choose", "One-time", "Recurring", "Autonomous"]) expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Request mode"');
    expect(markup).toContain("Recommendation: Needs scope");
    expect(markup).toContain("no risk-bearing tool should run yet");
  });

  it("states that an autonomous selection still needs exact owner approval", () => {
    const markup = renderToStaticMarkup(createElement(RequestModeControl, {
      value: "autonomous",
      resolution: resolveRequestMode("autonomous", "Create an autonomous rebalance strategy"),
      onChange: vi.fn(),
    }));
    expect(markup).toContain("Autonomous selected");
    expect(markup).toContain("immutable plan");
    expect(markup).toContain("digest");
    expect(markup).toContain("This chat choice is not approval");
  });
});
