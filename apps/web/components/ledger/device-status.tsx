"use client";

import type { LedgerDeviceState, PilotWallet } from "@pilot/wallet";
import * as React from "react";

import { useLedgerDevice } from "./use-ledger-device";

export function ledgerDeviceStatusText(
  state: LedgerDeviceState,
  signed = false,
): string {
  if (signed) return "Signed on Ledger ✓";
  switch (state.interaction) {
    case "unlock-device":
      return "Unlock your Ledger";
    case "confirm-open-app":
      return "Open the XRP app";
    case "verify-address":
      return "Check the address on your Ledger";
    case "sign-transaction":
      return "Review and sign on your Ledger";
    case "none":
      return state.busy ? "Ledger is working" : "Ledger ready";
  }
}

export function DeviceStatus({
  state,
  signed = false,
}: {
  state: LedgerDeviceState;
  signed?: boolean;
}) {
  const text = ledgerDeviceStatusText(state, signed);
  return (
    <p
      role="status"
      aria-live="polite"
      className="border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
    >
      {text}
    </p>
  );
}

export function LedgerDeviceStatus({
  wallet,
  signed = false,
}: {
  wallet: Pick<PilotWallet, "onDeviceState"> | undefined;
  signed?: boolean;
}) {
  const device = useLedgerDevice(wallet);
  return <DeviceStatus state={device.state} signed={signed || device.signed} />;
}
