import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkAgreementFixturePage, { metadata } from "../../app/agreements/page";
import { WorkAgreementFixtureViewComponent } from "./work-agreement-fixture-view";

describe("work-agreement fixture UI", () => {
  it("mounts at the agreements page with explicit offline simulation boundaries", () => {
    const markup = renderToStaticMarkup(<WorkAgreementFixturePage />);
    expect(markup).toContain("Escrow approval lifecycle");
    expect(markup).toContain("Recorded fixture only");
    expect(markup).toContain("No Ledger or Speculos signed these blobs");
    expect(markup).toContain("signatures are not valid");
    expect(markup).toContain("nothing is submitted to XRPL");
    expect(markup).toContain("Start offline fixture");
    expect(metadata.title).toBe("Offline escrow work agreement");
  });

  it("does not render a live or validated claim before the user starts the fixture", () => {
    const markup = renderToStaticMarkup(<WorkAgreementFixtureViewComponent />);
    expect(markup).not.toContain("public-ledger evidence");
    expect(markup).not.toContain("Validated on XRPL");
    expect(markup).not.toContain("Connect Ledger");
  });
});
