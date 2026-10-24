"use client";

import * as React from "react";

import { DeviceFrame } from "./device-frame";
import type { LedgerButton } from "./use-ledger-device";

const MAX_SCREENS = 80;
const MAX_LINES_PER_SCREEN = 12;
const MAX_LINE_LENGTH = 120;
const MAX_TITLE_LENGTH = 80;
const TRANSCRIPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type SimulatedLedgerTranscript = Readonly<{
  version: 1;
  id: string;
  title: string;
  simulated: true;
  screens: readonly Readonly<{ lines: readonly string[] }>[];
}>;

export type SimulatedDeviceState = Readonly<{
  index: number;
  confirmed: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertBoundedText(
  value: unknown,
  field: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`Invalid simulated Ledger transcript ${field}`);
  }
}

/**
 * Validates committed Speculos screen transcripts before they enter the demo UI.
 * The strict shape prevents a fixture from silently becoming a general data or
 * HTML channel.
 */
export function parseSimulatedLedgerTranscript(
  input: unknown,
): SimulatedLedgerTranscript {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["version", "id", "title", "simulated", "screens"]) ||
    input.version !== 1 ||
    input.simulated !== true
  ) {
    throw new Error("Invalid simulated Ledger transcript envelope");
  }

  assertBoundedText(input.id, "id", 64);
  if (!TRANSCRIPT_ID.test(input.id)) {
    throw new Error("Invalid simulated Ledger transcript id");
  }
  assertBoundedText(input.title, "title", MAX_TITLE_LENGTH);

  if (
    !Array.isArray(input.screens) ||
    input.screens.length === 0 ||
    input.screens.length > MAX_SCREENS
  ) {
    throw new Error("Invalid simulated Ledger transcript screens");
  }

  for (const [screenIndex, screen] of input.screens.entries()) {
    if (
      !isRecord(screen) ||
      !hasExactKeys(screen, ["lines"]) ||
      !Array.isArray(screen.lines) ||
      screen.lines.length === 0 ||
      screen.lines.length > MAX_LINES_PER_SCREEN
    ) {
      throw new Error(
        `Invalid simulated Ledger transcript screen ${screenIndex + 1}`,
      );
    }
    for (const [lineIndex, line] of screen.lines.entries()) {
      assertBoundedText(
        line,
        `screen ${screenIndex + 1} line ${lineIndex + 1}`,
        MAX_LINE_LENGTH,
      );
    }
  }

  return input as SimulatedLedgerTranscript;
}

export function reduceSimulatedDeviceState(
  state: SimulatedDeviceState,
  button: LedgerButton,
  screenCount: number,
): SimulatedDeviceState {
  if (!Number.isSafeInteger(screenCount) || screenCount < 1) {
    throw new Error("A simulated Ledger transcript needs at least one screen");
  }

  const index = Math.min(Math.max(state.index, 0), screenCount - 1);
  if (button === "left") {
    const nextIndex = Math.max(0, index - 1);
    return {
      index: nextIndex,
      confirmed: nextIndex === index ? state.confirmed : false,
    };
  }
  if (button === "right") {
    const nextIndex = Math.min(screenCount - 1, index + 1);
    return {
      index: nextIndex,
      confirmed: nextIndex === index ? state.confirmed : false,
    };
  }
  if (index === screenCount - 1) {
    return { index, confirmed: true };
  }
  return { index, confirmed: false };
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function simulatedLedgerScreenDataUrl(lines: readonly string[]) {
  const longestLine = Math.max(...lines.map((line) => line.length));
  const verticalFontSize = Math.floor(56 / lines.length) - 2;
  const horizontalFontSize = Math.floor(116 / (longestLine * 0.62));
  const fontSize = Math.max(
    4,
    Math.min(9, verticalFontSize, horizontalFontSize),
  );
  const lineHeight = fontSize + 2;
  const firstBaseline =
    32 - ((lines.length - 1) * lineHeight) / 2 + fontSize / 3;
  const text = lines
    .map(
      (line, index) =>
        `<text x="64" y="${firstBaseline + index * lineHeight}" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64" viewBox="0 0 128 64">` +
    `<rect width="128" height="64" fill="#000"/>` +
    `<g fill="#fff" font-family="ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace" font-size="${fontSize}" font-weight="600">${text}</g>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SimulatedDevice({
  transcript: transcriptInput,
  onConfirm,
}: {
  transcript: unknown;
  onConfirm?: () => void;
}) {
  const transcript = React.useMemo(
    () => parseSimulatedLedgerTranscript(transcriptInput),
    [transcriptInput],
  );
  const [state, setState] = React.useState<SimulatedDeviceState>({
    index: 0,
    confirmed: false,
  });

  React.useEffect(() => {
    setState({ index: 0, confirmed: false });
  }, [transcript.id]);

  const index = Math.min(state.index, transcript.screens.length - 1);
  const screen = transcript.screens[index];
  const onButton = (button: LedgerButton) => {
    const next = reduceSimulatedDeviceState(
      { index, confirmed: state.confirmed },
      button,
      transcript.screens.length,
    );
    const newlyConfirmed = !state.confirmed && next.confirmed;
    setState(next);
    if (newlyConfirmed) onConfirm?.();
  };

  return (
    <section
      aria-label="Simulated Ledger"
      className="border border-slate-300 bg-[#fafaf7] p-4 text-slate-950 rounded-xl overflow-hidden"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Simulated Ledger</p>
          <p className="mt-1 text-xs text-slate-600">{transcript.title}</p>
        </div>
        <span className="border border-slate-300 bg-[#f8fafc] px-2 py-1 text-xs text-slate-600 rounded">
          Recorded demo · no signing
        </span>
      </div>
      <div className="[--color-white:#fff]">
        <DeviceFrame
          screenSrc={simulatedLedgerScreenDataUrl(screen.lines)}
          onButton={onButton}
          controlsLabel="Simulated Ledger controls"
          screenAlt="Recorded Simulated Ledger screen"
        />
      </div>
      <p
        role="status"
        aria-live="polite"
        className="mt-3 font-mono text-xs text-slate-600"
      >
        Screen {index + 1} of {transcript.screens.length}
        <span className="sr-only">: {screen.lines.join(". ")}</span>
      </p>
      {state.confirmed ? (
        <p className="mt-2 border-l-2 border-emerald-600 pl-2 text-xs font-medium text-emerald-800">
          Demo confirmed · no signature was created
        </p>
      ) : null}
    </section>
  );
}
