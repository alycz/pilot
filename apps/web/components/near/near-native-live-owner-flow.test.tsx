import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NearNativeLiveOwnerFlow } from "./near-native-live-owner-flow";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe("live native NEAR owner flow", () => {
  it("is visibly default-off with no input or actionable request control", () => {
    const markup = renderToStaticMarkup(createElement(NearNativeLiveOwnerFlow, {
      gates: {
        browserWallet: false,
        executableReview: false,
        principalBootstrap: false,
        ownerApproval: false,
      },
    }));

    expect(markup).toContain('data-near-native-live-flow="disabled"');
    expect(markup).toContain("Live native-route flow disabled");
    expect(markup).toContain("No principal bootstrap, executable quote, wallet prompt");
    expect(markup).toContain("active Pilot wallet session");
    expect(markup).toContain("Authorize live quote review");
    expect(markup).not.toContain("<input");
    expect(markup).toContain('disabled=""');
  });

  it("uses Pilot's responsive card structure and names every explicit boundary", () => {
    const markup = renderToStaticMarkup(createElement(NearNativeLiveOwnerFlow, {
      gates: {
        browserWallet: true,
        executableReview: true,
        principalBootstrap: true,
        ownerApproval: true,
      },
    }));

    expect(markup).toContain('data-near-native-live-flow="enabled"');
    expect(markup).toContain("Native NEAR → canonical Arbitrum USDC");
    expect(markup).toContain("Injected and parent-frame wallets are not accepted");
    expect(markup).toContain("no access key or transaction permission");
    expect(markup).toContain("Authorize live quote review");
    expect(markup).toContain("does not approve economics or move NEAR");
    expect(markup).toContain("Cancel current run");
    expect(markup).toContain("sm:grid-cols-2");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("pointer-coarse:h-11");
    expect(markup).not.toContain("href=");
  });

  it.each([
    "browserWallet",
    "executableReview",
    "principalBootstrap",
    "ownerApproval",
  ] as const)("remains disabled when the %s gate is off", (disabledGate) => {
    const gates = {
      browserWallet: true,
      executableReview: true,
      principalBootstrap: true,
      ownerApproval: true,
      [disabledGate]: false,
    };
    const markup = renderToStaticMarkup(createElement(NearNativeLiveOwnerFlow, {
      gates,
    }));

    expect(markup).toContain('data-near-native-live-flow="disabled"');
    expect(markup).not.toContain("<input");
  });
});
