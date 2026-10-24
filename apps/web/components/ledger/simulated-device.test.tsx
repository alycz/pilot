import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SimulatedDevice,
  parseSimulatedLedgerTranscript,
  reduceSimulatedDeviceState,
  simulatedLedgerScreenDataUrl,
} from "./simulated-device";
import delegateSetBlind from "./transcripts/delegate-set-blind.json";
import offerCreate from "./transcripts/offer-create.json";
import reject from "./transcripts/reject.json";
import signIn from "./transcripts/sign-in.json";
import trustSet from "./transcripts/trust-set.json";
import verifyAddress from "./transcripts/verify-address.json";

const transcript = {
  version: 1,
  id: "trust-set",
  title: "Approve the RLUSD trust line",
  simulated: true,
  screens: [
    { lines: ["Set Trust Line", "RLUSD"] },
    { lines: ["Approve"] },
  ],
} as const;

describe("Simulated Ledger transcript", () => {
  it("accepts the exact bounded generated shape", () => {
    expect(parseSimulatedLedgerTranscript(transcript)).toBe(transcript);
  });

  it.each([
    [verifyAddress, "verify-address", 3],
    [signIn, "sign-in", 8],
    [trustSet, "trust-set", 9],
    [delegateSetBlind, "delegate-set-blind", 15],
    [offerCreate, "offer-create", 11],
    [reject, "reject", 10],
  ] as const)("validates the committed %s transcript", (fixture, id, screenCount) => {
    const parsed = parseSimulatedLedgerTranscript(fixture);
    expect(parsed.id).toBe(id);
    expect(parsed.screens).toHaveLength(screenCount);
  });

  it.each([
    { ...transcript, simulated: false },
    { ...transcript, extra: "not allowed" },
    { ...transcript, id: "Trust Set" },
    { ...transcript, screens: [] },
    {
      ...transcript,
      screens: [{ lines: ["Approve"], extra: "not allowed" }],
    },
    { ...transcript, screens: [{ lines: ["bad\u0000line"] }] },
    { ...transcript, screens: [{ lines: ["x".repeat(121)] }] },
  ])("rejects an invalid or broadened transcript", (candidate) => {
    expect(() => parseSimulatedLedgerTranscript(candidate)).toThrow(
      /Invalid simulated Ledger transcript/,
    );
  });
});

describe("Simulated Ledger controls", () => {
  it("moves only within the transcript and clears confirmation on movement", () => {
    expect(
      reduceSimulatedDeviceState({ index: 0, confirmed: false }, "left", 2),
    ).toEqual({ index: 0, confirmed: false });
    expect(
      reduceSimulatedDeviceState({ index: 0, confirmed: false }, "right", 2),
    ).toEqual({ index: 1, confirmed: false });
    expect(
      reduceSimulatedDeviceState({ index: 1, confirmed: true }, "right", 2),
    ).toEqual({ index: 1, confirmed: true });
    expect(
      reduceSimulatedDeviceState({ index: 1, confirmed: true }, "left", 2),
    ).toEqual({ index: 0, confirmed: false });
  });

  it("confirms with both buttons only on the final screen", () => {
    expect(
      reduceSimulatedDeviceState({ index: 0, confirmed: false }, "both", 2),
    ).toEqual({ index: 0, confirmed: false });
    expect(
      reduceSimulatedDeviceState({ index: 1, confirmed: false }, "both", 2),
    ).toEqual({ index: 1, confirmed: true });
  });
});

describe("Simulated Ledger view", () => {
  it("uses the shared device frame and labels the replay as non-signing", () => {
    const markup = renderToStaticMarkup(
      <SimulatedDevice transcript={transcript} />,
    );
    expect(markup).toContain('aria-label="Simulated Ledger"');
    expect(markup).toContain("Simulated Ledger");
    expect(markup).toContain("Approve the RLUSD trust line");
    expect(markup).toContain("Recorded demo · no signing");
    expect(markup).toContain('aria-label="Simulated Ledger controls"');
    expect(markup).toContain('alt="Recorded Simulated Ledger screen"');
    expect(markup).toContain("Screen 1 of 2");
    expect(markup).toContain("Set Trust Line. RLUSD");
    expect(markup).toContain("◀");
    expect(markup).toContain("●");
    expect(markup).toContain("▶");
    expect(markup).toContain("data:image/svg+xml");
  });

  it("escapes screen text before placing it in the SVG image", () => {
    const url = simulatedLedgerScreenDataUrl(["<script>", "A&B"]);
    const svg = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("A&amp;B");
    expect(svg).not.toContain("<script>");
  });
});
