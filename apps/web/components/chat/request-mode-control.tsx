"use client";

import React from "react";

import type { ChatRequestMode, RequestModeResolution } from "./request-mode";
import { REQUEST_MODE_OPTIONS } from "./request-mode";

export function RequestModeControl({
  value,
  resolution,
  disabled,
  onChange,
}: {
  value: ChatRequestMode;
  resolution: RequestModeResolution;
  disabled?: boolean;
  onChange: (value: ChatRequestMode) => void;
}) {
  return <div className="border-b border-border bg-white/[0.015] px-3 py-2">
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <label className="flex min-w-0 items-center gap-2">
        <span className="label-mono shrink-0 text-[10px]">Request mode</span>
        <select
          aria-label="Request mode"
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value as ChatRequestMode)}
          className="h-9 min-w-0 border border-border-strong bg-background px-2 text-xs text-foreground disabled:opacity-55"
        >
          {REQUEST_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <p aria-live="polite" className="min-w-0 text-xs leading-5 text-muted-foreground">
        {value === "auto" ? `Recommendation: ${resolution.label}. ` : `${resolution.label} selected. `}{resolution.review}
      </p>
    </div>
  </div>;
}
