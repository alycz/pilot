import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewableHandoffPrompt } from "./copilot-chat-context";

describe("singleton copilot chat context", () => {
  it("renders a review-only draft with no submit or authority affordance", () => {
    const markup = renderToStaticMarkup(
      <ReviewableHandoffPrompt prompt="Explain bounded evidence." onUseDraft={vi.fn()} />,
    );

    expect(markup).toContain("Reviewable Ask Pilot draft");
    expect(markup).toContain("Review in composer");
    expect(markup).toContain("never submitted, signed, or approved automatically");
    expect(markup).not.toMatch(/<form|type="submit"|Approve transaction|Execute/);
  });

  it("contains no competing chat transport or provider", () => {
    const source = readFileSync(new URL("./copilot-chat-context.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("ChatView");
    expect(source).not.toContain("StrategyHubProvider");
    expect(source).not.toContain("/api/chat");
  });
});
