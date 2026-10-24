import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AP4M_DEMO_ACTIONS,
  LedgerFeed,
  summarizeLedgerEvents,
  type LedgerDemoEvent,
} from "../../../components/demo";

const EVENTS: readonly LedgerDemoEvent[] = [
  {
    id: "claim-1",
    kind: "claim",
    label: "Synthetic claim accepted off-ledger",
    at: "2026-10-21T20:30:01.000Z",
  },
  {
    id: "payment-1",
    kind: "payment",
    label: "Synthetic exact payment",
    objectId: "A".repeat(64),
    at: "2026-10-21T20:30:02.000Z",
  },
  {
    id: "ledger-1",
    kind: "ledger-transaction",
    label: "Synthetic setup transaction",
    objectId: "B".repeat(64),
    at: "2026-10-21T20:30:03.000Z",
  },
] as const;

describe("MP6 component contracts", () => {
  it("uses the exact POST-only local action endpoints with no request fields", () => {
    expect(AP4M_DEMO_ACTIONS).toEqual({
      settle: { label: "Settle now", method: "POST", path: "/demo/ap4m/settle" },
      revoke: { label: "Revoke agent", method: "POST", path: "/demo/ap4m/revoke" },
      rogue: { label: "Run rogue agent", method: "POST", path: "/demo/ap4m/rogue" },
    });

    for (const definition of Object.values(AP4M_DEMO_ACTIONS)) {
      expect(Object.keys(definition).sort()).toEqual(["label", "method", "path"]);
    }
  });

  it("counts claims as payments without claiming a ledger transaction", () => {
    expect(summarizeLedgerEvents(EVENTS)).toEqual({
      payments: 2,
      ledgerTransactions: 2,
    });

    expect(summarizeLedgerEvents(EVENTS.slice(0, 1))).toEqual({
      payments: 1,
      ledgerTransactions: 0,
    });
    expect(summarizeLedgerEvents(EVENTS.slice(0, 2))).toEqual({
      payments: 2,
      ledgerTransactions: 1,
    });
  });

  it("renders the payment-versus-ledger explanation and safe Testnet links", () => {
    const html = renderToStaticMarkup(createElement(LedgerFeed, { events: EVENTS }));

    expect(html).toContain("Claims increment payments only");
    expect(html).toContain("A ledger transaction is counted only when XRPL records one");
    expect(html).toContain("off-ledger");
    expect(html).toContain("https://testnet.xrpl.org/transactions/");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noreferrer\"");
    expect(html).not.toMatch(/mainnet|seed|private[_ -]?key|secret/i);
  });
});
