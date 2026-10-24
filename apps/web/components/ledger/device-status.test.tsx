import type { LedgerDeviceState } from "@pilot/wallet";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeviceStatus, ledgerDeviceStatusText } from "./device-status";

describe("Ledger device status", () => {
  it.each([
    ["unlock-device", "Unlock your Ledger"],
    ["confirm-open-app", "Open the XRP app"],
    ["verify-address", "Check the address on your Ledger"],
    ["sign-transaction", "Review and sign on your Ledger"],
    ["none", "Ledger ready"],
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

  it("shows the completed signature state without device details", () => {
    const state: LedgerDeviceState = { interaction: "none", busy: false };
    const markup = renderToStaticMarkup(
      <DeviceStatus state={state} signed />,
    );
    expect(markup).toContain("Signed on Ledger ✓");
    expect(markup).toContain('role="status"');
  });
});
