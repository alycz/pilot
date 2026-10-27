import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createNearNativeOwnerApprovalFixture } from "../../lib/near-native-owner-approval";
import { resolveNearConnectAdapterStatus } from "../../lib/near-connect-adapter";
import { NearNativeOwnerApprovalWorkspace } from "./near-native-owner-approval";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe("native NEAR owner approval workspace", () => {
  it("shows the default-off adapter, exact bindings, and disabled owner actions", async () => {
    const review = await createNearNativeOwnerApprovalFixture();
    const markup = renderToStaticMarkup(createElement(NearNativeOwnerApprovalWorkspace, {
      review,
      adapterStatus: resolveNearConnectAdapterStatus(false),
    }));

    expect(markup).toContain("Native NEAR → canonical Arbitrum USDC");
    expect(markup).toContain("Browser wallet adapter: disabled");
    expect(markup).toContain("Fresh NEP-413 proof");
    expect(markup).toContain("source-account control only");
    expect(markup).toContain("Confirm the exact quote-bound digest");
    expect(markup).toContain("owner-demo.near");
    expect(markup).toContain("near:mainnet");
    expect(markup).toContain("1000000000000000000000000");
    expect(markup).toContain("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(markup).toContain("Native NEAR · not a wNEAR token transfer");
    expect(markup).toContain("signed NEP-413 message does not transfer funds");
    expect(markup).toContain("Pilot budgets cannot stop an owner from sending outside the app");
    expect(markup).toContain("Cancel local review");
    expect(markup).not.toContain("href=");
    expect(markup.match(/<button/g)).toHaveLength(4);
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
  });

  it("shows the reviewed Near Connect adapter as ready without enabling fixture actions", async () => {
    const review = await createNearNativeOwnerApprovalFixture();
    const markup = renderToStaticMarkup(createElement(NearNativeOwnerApprovalWorkspace, {
      review,
      adapterStatus: resolveNearConnectAdapterStatus(true),
    }));

    expect(markup).toContain("Browser wallet adapter: ready");
    expect(markup).toContain("explicit owner click");
    expect(markup).toContain("No provider signature, NEP-413 wallet proof, owner confirmation, reservation, or transfer occurred");
  });

  it("uses the same responsive card and grid structure as Pilot", async () => {
    const review = await createNearNativeOwnerApprovalFixture();
    const markup = renderToStaticMarkup(createElement(NearNativeOwnerApprovalWorkspace, {
      review,
      adapterStatus: resolveNearConnectAdapterStatus(false),
    }));

    expect(markup).toContain("min-w-0");
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("pointer-coarse:h-11");
  });
});

