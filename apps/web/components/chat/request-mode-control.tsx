"use client";

import React from "react";

import { SelectMenu } from "../ui/select-menu";

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
  return <div className="flex min-w-0 items-center gap-2">
      <SelectMenu
        size="sm"
        placement="above"
        className="shrink-0"
        label="Request mode"
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={REQUEST_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
      />
      <p aria-live="polite" className="sr-only">
        {value === "auto" ? `Recommendation: ${resolution.label}. ` : `${resolution.label} selected. `}{resolution.review}
      </p>
  </div>;
}
