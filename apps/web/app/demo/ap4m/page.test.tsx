import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveMerchantEventsUrl } from "./merchant-events";
import Ap4mDemoPage, { metadata } from "./page";

function markup(): string {
  return renderToStaticMarkup(createElement(Ap4mDemoPage));
}

describe("MP6 AP4M demo page", () => {
  it("renders the three exact environment labels and honest mock boundary", () => {
    const html = markup();

    expect(metadata).toMatchObject({ title: "AP4M demo" });
    expect(html).toContain("Mastercard Open Finance · mock");
    expect(html).toContain("Verifiable Intent v0.1 · Mastercard reference");
    expect(html).toContain("Testnet");
    expect(html).toMatch(/mock|Mock/);
    expect(html).not.toMatch(/Mastercard certified|Mastercard compliant|paid with Mastercard/i);
  });

  it("exposes the projector split screen and all operator controls accessibly", () => {
    const html = markup();

    expect(html).toContain("Workspace");
    expect(html).toContain("Merchant console");
    expect(html).toContain("Ledger feed");
    expect(html).toContain("Payments");
    expect(html).toContain("Ledger transactions");
    expect(html).toContain("Settle now");
    expect(html).toContain("Revoke agent");
    expect(html).toContain("Run rogue agent");
    expect(html).toContain("aria-live");
    expect(html).toContain("role=\"status\"");
    expect(html).toMatch(/min-h-\[?800px\]?|min-h-dvh/);
  });

  it("shows the complete Mastercard Level 3 validation order and bound receipt context", () => {
    const html = markup();

    for (const stage of ["Agent identity", "Intent", "Credential", "Payment"]) {
      expect(html).toContain(stage);
    }
    expect(html).toContain("intentId");
    expect(html).toContain("xrpl-paychan");
    expect(html).toContain("claim_accepted");
    expect(html).toContain("Mandate");
    expect(html).toContain("Receipt");
  });

  it("does not render secret-shaped or mainnet claims in the static surface", () => {
    const html = markup();

    expect(html).not.toMatch(/seed|private[_ -]?key|HARBOR_API_KEYS|MASTERCARD_CLIENT_SECRET/i);
    expect(html).not.toMatch(/Mainnet/);
  });

  it("allows only a server-selected same-origin or loopback merchant SSE endpoint", () => {
    expect(resolveMerchantEventsUrl(undefined)).toBeUndefined();
    expect(resolveMerchantEventsUrl("/m/venue/events")).toBe("/m/venue/events");
    expect(resolveMerchantEventsUrl("http://127.0.0.1:8000/events")).toBe(
      "http://127.0.0.1:8000/events",
    );
    expect(resolveMerchantEventsUrl("https://merchant.example/events")).toBeUndefined();
    expect(resolveMerchantEventsUrl("http://user:pass@localhost:8000/events")).toBeUndefined();
    expect(resolveMerchantEventsUrl("//merchant.example/events")).toBeUndefined();
    expect(resolveMerchantEventsUrl("/events?live=1")).toBeUndefined();
  });
});
