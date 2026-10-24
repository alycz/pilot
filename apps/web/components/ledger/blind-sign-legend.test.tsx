import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BlindSignLegend } from "./blind-sign-legend";

const DELEGATE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

describe("Ledger blind-sign legend", () => {
  const markup = renderToStaticMarkup(
    <BlindSignLegend delegateAddress={DELEGATE} />,
  );

  it("shows the full Harbor delegate address and honest unknown screens", () => {
    expect(markup).toContain(DELEGATE);
    expect(markup).toContain("Authorize · Harbor delegate");
    expect(markup).toContain("Unknown [1] | 8");
    expect(markup).toContain("Unknown [7] | 18");
    expect(markup).not.toContain("rPT1…");
  });

  it.each([
    ["OfferCreate", "Place DEX offers (swaps) within policy"],
    ["OfferCancel", "Cancel its own offers"],
    ["TrustSet", "Add or adjust trust lines"],
    ["AMMDeposit", "Add liquidity to AMM pools"],
    ["AMMWithdraw", "Remove liquidity"],
    ["EscrowFinish", "Finish escrows"],
    ["CheckCash", "Cash checks"],
  ])("maps %s to its fixed permission meaning", (name, meaning) => {
    expect(markup).toContain(name);
    expect(markup).toContain(meaning);
  });

  it("includes explicit enable and disable instructions", () => {
    expect(markup).toContain("enable Blind signing");
    expect(markup).toContain("disable Blind signing");
    expect(markup).toContain("Approve only when the values match Pilot exactly");
  });
});
