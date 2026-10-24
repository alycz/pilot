import type { LedgerDeviceState } from "@pilot/wallet";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeviceStatus, ledgerDeviceStatusText } from "./device-status";

describe("Ledger device status", () => {
  it.each([
    ["unlock-device", "Unlock configured Ledger flow"],
    ["confirm-open-app", "Open the XRP app in configured Ledger flow"],
    ["verify-address", "Check the address in configured Ledger flow"],
    ["sign-transaction", "Review and sign in configured Ledger flow"],
    ["none", "configured Ledger flow ready"],
  ] as const)("maps %s to its exact prompt", (interaction, expected) => {
    const state: LedgerDeviceState = {
      interaction,
      busy: interaction !== "none",
    };
    expect(ledgerDeviceStatusText(state)).toBe(expected);
    expect(renderToStaticMarkup(<DeviceStatus state={state} />)).toContain(
      expected,
    );
  });

  it.each([
    ["webhid", "Signed via Ledger transport ✓"],
    ["virtual", "Signed via Virtual Ledger (Speculos) ✓"],
    [undefined, "Signed through configured Ledger flow ✓"],
  ] as const)("shows truthful completed %s provenance", (transport, expected) => {
    const state: LedgerDeviceState = { interaction: "none", busy: false };
    const markup = renderToStaticMarkup(
      <DeviceStatus state={state} signed transport={transport} />,
    );
    expect(markup).toContain(expected);
    expect(markup).toContain('role="status"');
  });

  it("distinguishes WebHID, virtual, and unknown ready states", () => {
    const state: LedgerDeviceState = { interaction: "none", busy: false };
    expect(ledgerDeviceStatusText(state, false, "webhid")).toBe("Ledger transport ready");
    expect(ledgerDeviceStatusText(state, false, "virtual")).toBe("Virtual Ledger (Speculos) ready");
    expect(ledgerDeviceStatusText(state)).toBe("configured Ledger flow ready");
  });
});
