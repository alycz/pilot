"use client";

import * as React from "react";

import { DeviceFrame } from "./device-frame";
import { useVirtualLedgerScreen } from "./use-ledger-device";

export const VIRTUAL_LEDGER_LABEL =
  "Virtual Ledger · Ledger's XRP app 2.8.2 running in an emulator";

export function VirtualDevicePanel({ enabled = true }: { enabled?: boolean }) {
  const device = useVirtualLedgerScreen(enabled);
  return (
    <section
      aria-label="Virtual Ledger"
      className="border border-slate-300 bg-white p-4 text-slate-950 rounded-xl overflow-hidden"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{VIRTUAL_LEDGER_LABEL}</p>
          <p className="mt-1 text-xs text-slate-600">
            Use the on-screen controls or the keyboard while this panel is focused.
          </p>
        </div>
        <span className="border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-600 rounded">
          {device.connected ? "Live events" : "300 ms refresh"}
        </span>
      </div>
      <DeviceFrame
        screenSrc={device.screenSrc}
        onButton={device.press}
        disabled={!enabled}
      />
    </section>
  );
}
