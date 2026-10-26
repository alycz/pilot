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
  it("labels the owner-funded route as deterministic fixture evidence", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsFixtureDemo));
    expect(markup).toContain("Local fixture · no provider or wallet calls");
    expect(markup).toContain("Arbitrum USDC → wNEAR manual owner-funding review");
    expect(markup).toContain("Fixture transcript only");
    expect(markup).toContain("this page did not request or verify one");
    expect(markup).toContain("Fixture assertion only · not verified on this page");
    expect(markup).not.toContain("Ready to sign");
  });

  it("shows exact manual funding fields without offering wallet or transfer actions", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsFixtureDemo));
    expect(markup).toContain("Arbitrum One · chain 42161");
    expect(markup).toContain("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(markup).toContain("25000000");
    expect(markup).toContain("0x1111111111111111111111111111111111110042");
    expect(markup).toContain("None · unsupported");
    expect(markup).toContain("Owner wallet only");
    expect(markup).toContain("does not build, sign, or send this transfer");
    expect(markup).toContain("cannot stop an owner from transferring outside the app");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("Connect wallet");
    expect(markup).not.toContain("QR code</button>");
  });

  it("fails closed on wNEAR storage, UNKNOWN, refund, and destination evidence", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsFixtureDemo));
    expect(markup).toContain("wNEAR storage registration");
    expect(markup).toContain("NOT VERIFIED · funding blocked");
    expect(markup).toContain("A named account alone does not prove token-storage readiness");
    expect(markup).toContain("UNKNOWN outcome and refund branch");
    expect(markup).toContain("REFUNDED only when returned by provider");
    expect(markup).toContain("Provider SUCCESS is a provider claim");
    expect(markup).toContain("Cannot conclude receipt");
  });

  it("uses responsive Pilot card structure and keeps every rendered action disabled", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsFixtureDemo));
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("sm:grid-cols-4");
    expect(markup).toContain("lg:grid-cols-7");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain('aria-label="Detailed owner-funded walkthrough"');
    expect(markup.match(/<button/g)).toHaveLength(4);
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(markup).toContain("Review-only fixture");
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
