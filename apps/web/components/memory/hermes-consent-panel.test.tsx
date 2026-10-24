import { describe, expect, it, vi } from "vitest";

import {
  HERMES_PROVIDER_RETENTION_NOTICE,
  HermesConsentUnavailableError,
  parseHermesConsentView,
  requestHermesConsent,
} from "./hermes-consent-panel";

const state = {
  configured: true as const,
  activationReady: false,
  activationBlock: "bounded-egress-bridge-not-attested",
  authenticated: true as const,
  disclosure: {
    provider: "openrouter",
    model: "example/read-only",
    dataPolicy: "bounded-redacted-proposals" as const,
    retentionDays: 7,
    termsVersion: "2026-10-21",
  },
  consented: false,
};

describe("Hermes consent panel contract", () => {
  it("discloses that provider retention is independent from the Hermes deadline", () => {
    expect(HERMES_PROVIDER_RETENTION_NOTICE).toContain("external model provider");
    expect(HERMES_PROVIDER_RETENTION_NOTICE).toContain("own policy");
    expect(HERMES_PROVIDER_RETENTION_NOTICE).toContain("not governed by the Hermes session deletion deadline");
  });

  it("accepts the exact visible disclosure and preserves the activation block", () => {
    expect(parseHermesConsentView(state)).toEqual(state);
    expect(() => parseHermesConsentView({ ...state, activationBlock: undefined }))
      .toThrow("invalid Hermes consent state");
    expect(() => parseHermesConsentView({
      ...state,
      disclosure: { ...state.disclosure, apiKey: "must-not-enter-the-browser" },
    })).toThrow("invalid Hermes disclosure");
  });

  it("uses fixed same-origin requests for read, accept, and revoke", async () => {
    const fetcher = vi.fn(async () => Response.json(state));
    await requestHermesConsent("read", fetcher);
    await requestHermesConsent("accept", fetcher);
    await requestHermesConsent("revoke", fetcher);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/hermes/consent", { method: "GET", signal: undefined });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/hermes/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
      signal: undefined,
    });
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/hermes/consent", { method: "DELETE", signal: undefined });
  });

  it("surfaces disabled state without treating it as consent", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "Hermes workflow advisory is unavailable." },
      { status: 404 },
    ));
    await expect(requestHermesConsent("read", fetcher))
      .rejects.toBeInstanceOf(HermesConsentUnavailableError);
  });

  it("validates honest DB-absence-only retention status", () => {
    expect(parseHermesConsentView({
      ...state,
      retention: {
        state: "database-absence-verified",
        attempted: 1,
        databaseAbsent: 1,
        remaining: 0,
      },
    }).retention).toMatchObject({ state: "database-absence-verified" });
    expect(() => parseHermesConsentView({
      ...state,
      retention: {
        state: "fully-erased",
        attempted: 1,
        databaseAbsent: 1,
        remaining: 0,
      },
    })).toThrow("invalid Hermes retention status");
    expect(parseHermesConsentView({
      ...state,
      retention: {
        state: "unverified",
        attempted: 0,
        databaseAbsent: 0,
        remaining: null,
      },
    }).retention).toMatchObject({ state: "unverified", remaining: null });
  });
});
