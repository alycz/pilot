import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import WorkAgreementFixturePage, { metadata } from "../../app/agreements/page";
import {
  WorkAgreementDemoController,
  WorkAgreementFixtureViewComponent,
} from "./work-agreement-fixture-view";

describe("work-agreement fixture UI", () => {
  it("keeps the explicit recorded-demo query as a direct demo entry", async () => {
    const page = await WorkAgreementFixturePage({
      searchParams: Promise.resolve({ demo: "recorded" }),
    });
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("Sample escrow-backed work agreement");
    expect(markup).toContain("Simulated agreement only");
    expect(markup).toContain("no valid signature exists");
    expect(markup).toContain("no provider or XRPL request is made");
    expect(markup).toContain("not chain-validated receipts");
    expect(markup).toContain("Simulate owner approval · create");
    expect(markup.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(metadata.title).toBe("Ledger work agreements");
  });

  it("mounts the local demo immediately while the wallet session is unverified", async () => {
    const page = await WorkAgreementFixturePage({});
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("Sample escrow-backed work agreement");
    expect(markup).toContain("Simulated agreement only");
    expect(markup).not.toContain("Prepare escrow agreement");
    expect(markup.match(/<main(?:\s|>)/g)).toHaveLength(1);
  });

  it("renders useful sample terms immediately without live claims", () => {
    const markup = renderToStaticMarkup(<WorkAgreementFixtureViewComponent />);
    expect(markup).toContain("Website accessibility review");
    expect(markup).toContain("Accessibility findings memo + CSV appendix");
    expect(markup).toContain("Network/provider calls");
    expect(markup).toMatch(/>0<\/dd>/);
    expect(markup).not.toContain("Validated on XRPL");
    expect(markup).not.toContain("Connect Ledger");
  });

  it.each(["release", "cancel"] as const)(
    "runs the complete local %s lifecycle without fetch, wallet, or provider calls",
    (resolution) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      try {
        const demo = new WorkAgreementDemoController();
        expect(demo.snapshot()).toMatchObject({ deliveryReviewed: false, view: { status: "awaiting_create", networkRequestsMade: 0 } });
        expect(demo.approvePending().view.status).toBe("active");
        if (resolution === "release") {
          expect(demo.reviewDelivery()).toMatchObject({ deliveryReviewed: true });
        }
        expect(demo.prepareResolution(resolution).view.status).toBe(resolution === "release" ? "awaiting_release" : "awaiting_cancel");
        expect(demo.approvePending().view.status).toBe(resolution === "release" ? "released" : "cancelled");
        expect(demo.snapshot().view.networkRequestsMade).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("fails closed on premature release and resets or reloads to a fresh demo", () => {
    const demo = new WorkAgreementDemoController();
    expect(() => demo.prepareResolution("release")).toThrow(/create the sample escrow/i);
    demo.approvePending();
    expect(() => demo.prepareResolution("release")).toThrow(/review the sample delivery/i);
    demo.reviewDelivery();
    demo.prepareResolution("release");
    demo.approvePending();
    expect(demo.reset()).toMatchObject({ deliveryReviewed: false, view: { status: "awaiting_create" } });
    expect(new WorkAgreementDemoController().snapshot()).toEqual(demo.snapshot());
  });
});
