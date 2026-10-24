import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LEDGER_ONBOARDING_ACCOUNT_INDEXES,
  LEDGER_PERMISSION_VALUES,
  LEDGER_SESSION_TTL_MS,
  LedgerSigningGuide,
  LedgerWalletStep,
  defaultLedgerAccountIndex,
  defaultLedgerTransport,
  hasExactLedgerPermissionSet,
  isLedgerBlindSigningDisabled,
  ledgerSessionMatches,
  ledgerTransportAvailable,
  ledgerWebHidAvailable,
  validStoredLedgerConfig,
} from "./ledger-wallet-step";

describe("Ledger onboarding boundaries", () => {
  it("uses the configured transport and limits the onboarding picker to indexes 0–2", () => {
    expect(defaultLedgerTransport({
      enabled: true,
      transports: ["virtual"],
      defaultAccountIndex: 2,
    }, false)).toBe("virtual");
    expect(defaultLedgerTransport({
      enabled: true,
      transports: ["webhid", "virtual"],
      defaultAccountIndex: 0,
    }, false)).toBe("virtual");
    expect(defaultLedgerTransport({
      enabled: true,
      transports: ["webhid", "virtual"],
      defaultAccountIndex: 0,
    }, true)).toBe("webhid");
    expect(defaultLedgerAccountIndex(2)).toBe(2);
    expect(defaultLedgerAccountIndex(9)).toBe(0);
    expect(LEDGER_ONBOARDING_ACCOUNT_INDEXES).toEqual([0, 1, 2]);
    expect(ledgerTransportAvailable({
      enabled: true,
      transports: ["webhid"],
      defaultAccountIndex: 0,
    }, "webhid", false)).toBe(false);
    expect(ledgerTransportAvailable({
      enabled: true,
      transports: ["webhid", "virtual"],
      defaultAccountIndex: 0,
    }, "virtual", false)).toBe(true);
  });

  it("detects WebHID without user-agent inference", () => {
    expect(ledgerWebHidAvailable({ hid: {} })).toBe(true);
    expect(ledgerWebHidAvailable({})).toBe(false);
    expect(ledgerWebHidAvailable(undefined)).toBe(false);
  });

  it("accepts only the strict public Ledger storage shape", () => {
    expect(validStoredLedgerConfig({ transport: "virtual", accountIndex: 0 })).toBe(true);
    expect(validStoredLedgerConfig({ transport: "webhid", accountIndex: 2 })).toBe(true);
    expect(validStoredLedgerConfig({ transport: "virtual", accountIndex: 3 })).toBe(false);
    expect(validStoredLedgerConfig({ transport: "virtual", accountIndex: 0, seed: "no" })).toBe(false);
  });

  it("restores only an unexpired session bound to the same account and network", () => {
    const expected = { account: "rOwner", network: "testnet" as const };
    const now = 1_000;
    expect(ledgerSessionMatches({
      authenticated: true,
      account: "rOwner",
      network: "testnet",
      expiresAt: now + LEDGER_SESSION_TTL_MS,
    }, expected, now)).toBe(true);
    expect(ledgerSessionMatches({
      authenticated: true,
      account: "rOwner",
      network: "testnet",
      expiresAt: now,
    }, expected, now)).toBe(false);
    expect(ledgerSessionMatches({
      authenticated: true,
      account: "rOwner",
      network: "testnet",
    }, expected, now)).toBe(false);
    expect(ledgerSessionMatches({
      authenticated: true,
      account: "rOwner",
      network: "testnet",
      expiresAt: now + LEDGER_SESSION_TTL_MS + 1,
    }, expected, now)).toBe(false);
    expect(ledgerSessionMatches({
      authenticated: true,
      account: "rOther",
      network: "testnet",
      expiresAt: now + LEDGER_SESSION_TTL_MS,
    }, expected, now)).toBe(false);
  });

  it("requires the exact seven Ledger permission names and values", () => {
    expect(hasExactLedgerPermissionSet([
      "OfferCreate",
      "OfferCancel",
      "TrustSet",
      "AMMDeposit",
      "AMMWithdraw",
      "EscrowFinish",
      "CheckCash",
    ])).toBe(true);
    expect(hasExactLedgerPermissionSet(["OfferCreate"])).toBe(false);
    expect(LEDGER_PERMISSION_VALUES).toEqual([8, 9, 21, 37, 38, 3, 18]);
  });

  it("recognizes only the sanitized blind-signing error code", () => {
    expect(isLedgerBlindSigningDisabled({ code: "LEDGER_BLIND_SIGNING_DISABLED" })).toBe(true);
    expect(isLedgerBlindSigningDisabled({ code: "SIGN_CANCELLED" })).toBe(false);
    expect(isLedgerBlindSigningDisabled(new Error("6985"))).toBe(false);
  });

  it("shows the real-device compatibility reason and account picker copy", () => {
    const html = renderToStaticMarkup(
      <LedgerWalletStep
        accountIndex={1}
        accounts={{ 0: "rZero", 1: "rOne", 2: "rTwo" }}
        config={{ enabled: true, transports: ["webhid"], defaultAccountIndex: 1 }}
        onAccountIndexChange={() => undefined}
        onTransportChange={() => undefined}
        transport="webhid"
      />,
    );
    expect(html).toContain("Unavailable: use desktop Chrome, Edge, or Brave with WebHID.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Real Ledger/s);
    expect(html).toContain("Account 0");
    expect(html).toContain("Account 1");
    expect(html).toContain("Account 2");
    expect(html).toContain("keep main holdings on another account");
    expect(html).toContain("pilot-wallet-auth-v1");
    expect(html).toContain("It is never submitted");
  });

  it("renders an optional caller-owned simulated replay without changing the default flow", () => {
    const defaultMarkup = renderToStaticMarkup(
      <LedgerWalletStep
        accountIndex={0}
        accounts={{}}
        config={{ enabled: true, transports: ["virtual"], defaultAccountIndex: 0 }}
        onAccountIndexChange={() => undefined}
        onTransportChange={() => undefined}
        transport="virtual"
      />,
    );
    const replayMarkup = renderToStaticMarkup(
      <LedgerWalletStep
        accountIndex={0}
        accounts={{}}
        config={{ enabled: true, transports: ["virtual"], defaultAccountIndex: 0 }}
        onAccountIndexChange={() => undefined}
        onTransportChange={() => undefined}
        simulatedDeviceSlot={<div data-testid="simulated-ledger-replay">Recorded replay</div>}
        transport="virtual"
      />,
    );
    expect(defaultMarkup).not.toContain("simulated-ledger-replay");
    expect(defaultMarkup).toContain("/api/ledger-sim/screenshot");
    expect(replayMarkup).toContain("simulated-ledger-replay");
    expect(replayMarkup).toContain("Recorded replay");
    expect(replayMarkup).not.toContain("/api/ledger-sim/");
  });

  it("never renders the simulated replay after a device account is discovered", () => {
    const markup = renderToStaticMarkup(
      <LedgerWalletStep
        accountIndex={0}
        accounts={{ 0: "rDiscovered" }}
        config={{ enabled: true, transports: ["virtual"], defaultAccountIndex: 0 }}
        onAccountIndexChange={() => undefined}
        onTransportChange={() => undefined}
        simulatedDeviceSlot={<div data-testid="simulated-ledger-replay">Recorded replay</div>}
        transport="virtual"
      />,
    );
    expect(markup).not.toContain("simulated-ledger-replay");
    expect(markup).toContain("rDiscovered");
    expect(markup).toContain("pilot-wallet-auth-v1");
  });

  it("renders the exact blind-signing legend and acknowledgement", () => {
    const html = renderToStaticMarkup(
      <LedgerSigningGuide
        blindSigningConfirmed={false}
        delegateAddress="rDelegate"
        onBlindSigningConfirmed={() => undefined}
        phase="delegate"
        transport="webhid"
      />,
    );
    for (const value of LEDGER_PERMISSION_VALUES) {
      expect(html).toContain(`| ${value}`);
    }
    expect(html).toContain("Blind signing is on");
    expect(html).toContain("rDelegate");
  });
});
