import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkAgreementFixturePage, { metadata } from "../../app/agreements/page";
import { WorkAgreementFixtureViewComponent } from "./work-agreement-fixture-view";

describe("work-agreement fixture UI", () => {
  it("mounts only behind the explicit recorded-demo query", async () => {
    const page = await WorkAgreementFixturePage({
      searchParams: Promise.resolve({ demo: "recorded" }),
    });
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("Escrow approval lifecycle");
    expect(markup).toContain("Recorded fixture only");
    expect(markup).toContain("No Ledger or Speculos signed these blobs");
    expect(markup).toContain("signatures are not valid");
    expect(markup).toContain("nothing is submitted to XRPL");
    expect(markup).toContain("Start offline fixture");
    expect(metadata.title).toBe("Ledger work agreements");
  });

  it("mounts the durable owner-reviewed workspace by default", async () => {
    const page = await WorkAgreementFixturePage();
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("Owner-reviewed escrow workspace");
    expect(markup).toContain("Local mock settlement only");
    expect(markup).not.toContain("Start offline fixture");
  });

  it("does not render a live or validated claim before the user starts the fixture", () => {
    const markup = renderToStaticMarkup(<WorkAgreementFixtureViewComponent />);
    expect(markup).not.toContain("public-ledger evidence");
    expect(markup).not.toContain("Validated on XRPL");
    expect(markup).not.toContain("Connect Ledger");
  });
});
