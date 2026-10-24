import * as React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LedgerApprovalSection } from "./ledger-approval-section";

function renderSection() {
  return renderToStaticMarkup(
    <LedgerApprovalSection
      trustSetDevicePreview={(
        <div data-transcript="trust-set">Set Trust Line · RLUSD</div>
      )}
    />,
  );
}

describe("LedgerApprovalSection", () => {
  it("renders the three bounded-authority steps in order", () => {
    const markup = renderSection();

    expect(markup.match(/data-ledger-step=""/g)).toHaveLength(3);
    const agent = markup.indexOf("The agent proposes");
    const harbor = markup.indexOf("Harbor&#x27;s bounded delegate executes");
    const ledger = markup.indexOf("The Ledger approves anything beyond it");

    expect(agent).toBeGreaterThan(-1);
    expect(harbor).toBeGreaterThan(agent);
    expect(ledger).toBeGreaterThan(harbor);
  });

  it("states the precise integration boundary without live or hardware claims", () => {
    const markup = renderSection();

    expect(markup).toContain("Ledger Agent Intent does not support XRPL yet");
    expect(markup).toContain("Device Management Kit (DMK), not legacy LedgerJS");
    expect(markup).toContain("Simulated evidence only");
    expect(markup).toContain("Physical-Ledger and live-Testnet checks are");
    expect(markup).toContain("still pending and are not claimed here");
  });

  it("injects the LG-5 TrustSet preview instead of owning a transcript copy", () => {
    const markup = renderSection();

    expect(markup).toContain('data-transcript="trust-set"');
    expect(markup).toContain("Set Trust Line · RLUSD");
    expect(markup).toContain("deterministic local simulated-device replay");
  });

  it("shows the complete fixed DelegateSet blind-signing legend", () => {
    const markup = renderSection();

    for (const [index, value, name, meaning] of [
      [1, "8", "OfferCreate", "Place DEX offers (swaps) within policy"],
      [2, "9", "OfferCancel", "Cancel its own offers"],
      [3, "21", "TrustSet", "Add or adjust trust lines"],
      [4, "37", "AMMDeposit", "Add liquidity to AMM pools"],
      [5, "38", "AMMWithdraw", "Remove liquidity"],
      [6, "3", "EscrowFinish", "Finish escrows"],
      [7, "18", "CheckCash", "Cash checks"],
    ] as const) {
      expect(markup).toContain(`Unknown [${index}] | ${value}`);
      expect(markup).toContain(name);
      expect(markup).toContain(meaning);
    }
    expect(markup).toContain("DelegateSet is blind-signed");
    expect(markup).toContain("disable");
    expect(markup).toContain("blind signing after the delegation validates");
    expect(markup).toContain("full delegate address shown");
  });

  it("keeps the section light, sharp-cornered, and accessible", () => {
    const markup = renderSection();

    expect(markup).toContain('aria-labelledby="ledger-approval-heading"');
    expect(markup).toContain('aria-label="Ledger approval path"');
    expect(markup).toContain('aria-label="Simulated Ledger clear-signing a TrustSet"');
    expect(markup).toContain("bg-slate-50");
    // The app intentionally remaps Tailwind's `white` token to ink for alpha
    // overlays. This section owns several solid `bg-white` paper surfaces, so
    // it restores the real white token locally before rendering them.
    expect(markup).toContain("[--color-white:#fff]");
    expect(markup.match(/bg-white/g)).toHaveLength(12);
    expect(markup).not.toContain("rounded");
  });

  it("lands after the existing AWS section with LG-5's exact TrustSet replay", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../app/page.tsx", import.meta.url)),
      "utf8",
    );
    const landing = source.indexOf("<LandingPage />");
    const aws = source.indexOf("<AwsTrustSection />");
    const ledger = source.indexOf("<LedgerApprovalSection");

    expect(landing).toBeGreaterThan(-1);
    expect(aws).toBeGreaterThan(landing);
    expect(ledger).toBeGreaterThan(aws);
    expect(source).toContain(
      'import trustSetTranscript from "@/components/ledger/transcripts/trust-set.json"',
    );
    expect(source).toContain(
      "trustSetDevicePreview={<SimulatedDevice transcript={trustSetTranscript} />}",
    );
  });
});
