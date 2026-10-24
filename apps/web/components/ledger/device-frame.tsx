"use client";

import * as React from "react";
import type { KeyboardEvent } from "react";

import {
  ledgerButtonForKey,
  type LedgerButton,
} from "./use-ledger-device";

const BUTTONS: readonly {
  value: LedgerButton;
  glyph: string;
  label: string;
}[] = [
  { value: "left", glyph: "◀", label: "Press the left Ledger button" },
  { value: "both", glyph: "●", label: "Press both Ledger buttons" },
  { value: "right", glyph: "▶", label: "Press the right Ledger button" },
];

export function DeviceFrame({
  screenSrc,
  onButton,
  disabled = false,
  controlsLabel = "Virtual Ledger Nano X controls",
  screenAlt = "Virtual Ledger screen",
}: {
  screenSrc: string;
  onButton: (button: LedgerButton) => void | Promise<void>;
  disabled?: boolean;
  controlsLabel?: string;
  screenAlt?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const button = ledgerButtonForKey(event.key);
    if (button === undefined || disabled) return;
    event.preventDefault();
    void onButton(button);
  };

  return (
    <div
      role="group"
      aria-label={controlsLabel}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
      className="w-fit border border-slate-300 bg-slate-100 p-4 text-slate-950 shadow-[5px_5px_0_rgba(15,23,42,0.14)] outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
    >
      <div className="flex items-center gap-4">
        <div className="border border-slate-800 bg-black p-2">
          <img
            src={screenSrc}
            alt={screenAlt}
            width={384}
            height={192}
            draggable={false}
            className="h-48 w-96 max-w-full bg-black object-contain [image-rendering:pixelated]"
          />
        </div>
        <div aria-hidden="true" className="h-10 w-10 rounded-full border-4 border-slate-400 bg-slate-200" />
      </div>
      <div className="mt-3 flex justify-center gap-2" aria-label="Ledger buttons">
        {BUTTONS.map((button) => (
          <button
            key={button.value}
            type="button"
            disabled={disabled}
            aria-label={button.label}
            onClick={() => void onButton(button.value)}
            className="grid h-10 min-w-12 place-items-center border border-slate-400 bg-white px-3 text-base font-semibold text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {button.glyph}
          </button>
        ))}
      </div>
      <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">
        Keyboard: ← · Enter/↓ · →
      </p>
    </div>
  );
}
