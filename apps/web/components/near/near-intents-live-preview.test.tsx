import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NearIntentsLivePreview } from "./near-intents-live-preview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe("NEAR Intents live executable-review UI", () => {
  it("fails closed when the public UI capability is omitted", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsLivePreview));

    expect(markup).toContain('data-near-live-executable-review="disabled"');
    expect(markup).toContain("Executable review disabled");
    expect(markup).toContain("No executable quote or status request can be made");
    expect(markup).toContain("Request executable review");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("UI preview enabled");
  });

  it("renders only the fixed route and keeps funding blocked when enabled", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsLivePreview, {
      executableReviewEnabled: true,
    }));

    expect(markup).toContain('data-near-live-executable-review="enabled"');
    expect(markup).toContain("Arbitrum USDC → wNEAR on NEAR");
    expect(markup).toContain("Arbitrum One · chain 42161");
    expect(markup).toContain("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(markup).toContain("nep141:wrap.near");
    expect(markup).toContain("wNEAR token-storage registration");
    expect(markup).toContain("NOT VERIFIED · funding blocked");
    expect(markup).toContain("A named NEAR account does not prove it can receive this token");
    expect(markup).toContain("Harbor still enforces its independent local provider and executable-review flags");
    expect(markup).not.toContain("Connect wallet");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("QR code</button>");
  });

  it("keeps the request user-triggered and invalid blank routing fields disabled", () => {
    const markup = renderToStaticMarkup(createElement(NearIntentsLivePreview, {
      executableReviewEnabled: true,
    }));
    const requestButton = markup.match(/<button[^>]*>Request executable review<\/button>/)?.[0];

    expect(requestButton).toBeDefined();
    expect(requestButton).toContain("disabled");
    expect(markup).not.toContain("Live provider response · signature verified");
    expect(markup).not.toContain("Bound settlement status");
    expect(markup).toContain("sm:grid-cols-2");
    expect(markup).toContain("min-w-0");
  });

  it("keeps the demo shell truthful when provider-connected paths are mounted", () => {
    const pageSource = readFileSync(
      new URL("../../app/demo/near-intents/page.tsx", import.meta.url),
      "utf8",
    );

    expect(pageSource).toContain("user-triggered live provider calls");
    expect(pageSource).toContain(
      "Pilot transaction signing and broadcast remain disabled",
    );
    expect(pageSource).toContain(
      "Pilot signing/broadcast disabled · owner manual funding only after reservation",
    );
    expect(pageSource).not.toContain("It makes no 1Click request");
    expect(pageSource).not.toContain("Fixture only · execution disabled");
  });
});
