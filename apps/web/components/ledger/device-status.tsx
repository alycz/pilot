"use client";

import type { LedgerDeviceState, PilotWallet } from "@pilot/wallet";
import * as React from "react";

import { ledgerFlowName, ledgerSignedCopy, type LedgerTransportProvenance } from "./provenance";
import { useLedgerDevice } from "./use-ledger-device";

export function ledgerDeviceStatusText(
  state: LedgerDeviceState,
  signed = false,
  transport?: LedgerTransportProvenance,
): string {
  if (signed) return `${ledgerSignedCopy(transport)} ✓`;
  const flow = ledgerFlowName(transport);
  switch (state.interaction) {
    case "unlock-device":
      return transport === "webhid" ? "Unlock your Ledger device" : `Unlock ${flow}`;
    case "confirm-open-app":
      return `Open the XRP app in ${flow}`;
    case "verify-address":
      return `Check the address in ${flow}`;
    case "sign-transaction":
      return `Review and sign in ${flow}`;
    case "none":
      return state.busy ? `${flow} is working` : `${flow} ready`;
  }
}

export function DeviceStatus({
  state,
  signed = false,
  transport,
}: {
  state: LedgerDeviceState;
  signed?: boolean;
  transport?: LedgerTransportProvenance;
}) {
  const text = ledgerDeviceStatusText(state, signed, transport);
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
  transport,
}: {
  wallet: Pick<PilotWallet, "onDeviceState"> | undefined;
  signed?: boolean;
  transport?: LedgerTransportProvenance;
}) {
  const device = useLedgerDevice(wallet);
  return <DeviceStatus state={device.state} signed={signed || device.signed} transport={transport} />;
}
