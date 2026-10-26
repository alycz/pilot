import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NearApprovalReview } from "@/lib/near-approval";
import { NearIntentApprovalCard } from "./near-intent-approval-card";
import { NearIntentsFixtureDemo } from "./near-intents-fixture-demo";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const review: NearApprovalReview = {
  readiness: "signing-disabled",
  canSign: false,
  notice: "NEAR execution signing is disabled. This exact quote is review-only.",
  approvalDigest: "A".repeat(64),
  rows: [
    { label: "Principal", value: "fixture-principal", exact: true },
    { label: "Verified quote ID", value: "local_fixture", exact: true },
  ],
};

describe("NEAR Intents fixture UI", () => {
  it("starts at discovery and states that no provider call or execution occurred", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsFixtureDemo, { review }));
    expect(markup).toContain("Local fixture · no provider calls");
    expect(markup).toContain("Supported-asset discovery fixture");
    expect(markup).toContain("Execution");
    expect(markup).toContain("Disabled");
    expect(markup).not.toContain("Ready to sign");
  });

  it("labels approval data as fixture evidence and keeps its action disabled", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentApprovalCard, {
      review,
      provenance: "fixture",
    }));
    expect(markup).toContain("No provider signature, deposit, or wallet action occurred");
    expect(markup).toContain("Fixture quote ID");
    expect(markup).toContain("Principal-bound fixture digest");
    expect(markup).toContain("NEAR execution disabled");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("exact verified NEAR Intents quote");
  });
});
