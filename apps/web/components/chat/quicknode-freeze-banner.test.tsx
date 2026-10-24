import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuickNodeFreezeBanner } from "./quicknode-freeze-banner";

const HASH = "A".repeat(64);

describe("QuickNodeFreezeBanner", () => {
  it("renders the bounded freeze notice and safe actions", () => {
    const html = renderToStaticMarkup(
      <QuickNodeFreezeBanner notices={[{
        tx_hash: HASH,
        ledger_index: 9_843_206,
        network: "testnet",
      }]} realLedgerReceipt />,
    );

    expect(html).toContain("QuickNode Streams detected a transaction signed with your agent&#x27;s key outside Harbor (ledger 9,843,206). Harbor froze the agent.");
    expect(html).toContain("Revoke on-ledger");
    expect(html).toContain('href="/onboarding?action=revoke"');
    expect(html).toContain(`/transactions/${HASH}`);
    expect(html).toContain("opens in a new tab");
    expect(html).toContain("pointer-coarse:h-11");
    expect(html).not.toContain("memo");
    expect(html).not.toContain("flags");
  });

  it("suppresses explorer links for demo and mock notices", () => {
    const html = renderToStaticMarkup(<QuickNodeFreezeBanner notices={[{
      tx_hash: HASH,
      ledger_index: 9_843_206,
      network: "testnet",
    }]} />);
    expect(html).toContain("Harbor froze the agent");
    expect(html).not.toContain("testnet.xrpl.org");
  });

  it("renders nothing without a notice", () => {
    expect(renderToStaticMarkup(<QuickNodeFreezeBanner notices={[]} />)).toBe("");
  });
});
