import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { demoQuickNodeStatus } from "./portfolio-data";
import { QuickNodePanel } from "./quicknode-panel";

describe("QuickNodePanel", () => {
  it("shows all bounded status counters", () => {
    const html = renderToStaticMarkup(<QuickNodePanel status={demoQuickNodeStatus} />);
    expect(html).toContain("XRPL calls via QuickNode");
    expect(html).toContain("84%");
    expect(html).toContain("Webhook confirmations");
    expect(html).toContain("Ledgers watched");
    expect(html).toContain("Ledger 9,843,207");
    expect(html).toContain("1 agent");
    expect(html).toContain("Mock");
  });

  it("fails closed when Harbor status is unavailable", () => {
    const html = renderToStaticMarkup(<QuickNodePanel status={null} />);
    expect(html).toContain("Unavailable");
    expect(html).toContain("not available from Harbor yet");
  });
});
