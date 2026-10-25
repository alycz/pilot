import { describe, expect, it } from "vitest";

import {
  chatSessionUi,
  chatUsesIllustrativeDemo,
  chatWalletActionProofRequired,
} from "./session-state";

const account = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const liveConfig = {
  network: "testnet" as const,
  stableAsset: { currency: "RLUSD", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" },
  devSignerEnabled: true,
  walletActionProofRequired: true,
  walletActionProofConfigured: true,
  mockMode: false,
};
const mockConfig = { ...liveConfig, mockMode: true };
const hostedLiveConfig = {
  ...liveConfig,
  devSignerEnabled: false,
  walletActionProofRequired: false,
  walletActionProofConfigured: false,
};

describe("chat wallet session UI", () => {
  it("keeps every signed-out session in the provider-independent illustrative demo", () => {
    const signedOut = { authenticated: false } as const;
    const mockUi = chatSessionUi({ ...hostedLiveConfig, mockMode: true }, signedOut);
    expect(mockUi.ready).toBe(true);
    expect(chatUsesIllustrativeDemo(signedOut, mockUi)).toBe(true);
    expect(chatUsesIllustrativeDemo(undefined, chatSessionUi(undefined, undefined))).toBe(true);
    expect(chatUsesIllustrativeDemo(
      { authenticated: true, account, network: "testnet" },
      chatSessionUi(hostedLiveConfig, { authenticated: true, account, network: "testnet" }),
    )).toBe(false);
  });

  it("requires proofs for local external wallets independently of the dev signer flag", () => {
    expect(chatWalletActionProofRequired({
      ...liveConfig,
      devSignerEnabled: false,
      walletActionProofRequired: true,
    })).toBe(true);
    expect(chatWalletActionProofRequired({
      ...liveConfig,
      devSignerEnabled: true,
      walletActionProofRequired: false,
    })).toBe(false);
  });

  it("keeps hosted explicit mock chat available without a local-wallet proof", () => {
    expect(chatSessionUi({ ...hostedLiveConfig, mockMode: true }, { authenticated: false })).toEqual({
      ready: true,
      label: "Mock session",
      modeLabel: "Explicit mock",
      placeholder: "Ask Pilot to plan an XRPL action…",
      notice: null,
    });
  });

  it.each([
    ["mock", mockConfig],
    ["live", liveConfig],
  ])("blocks local-wallet %s chat when proof prerequisites are not configured", (_mode, config) => {
    expect(chatSessionUi(
      { ...config, walletActionProofConfigured: false },
      { authenticated: true, account, network: "testnet" },
    )).toEqual({
      ready: false,
      label: "Proof unavailable",
      modeLabel: config.mockMode ? "Explicit mock" : "Live Harbor",
      placeholder: "Local wallet proof is not configured.",
      notice: "proof",
    });
  });

  it("fails closed while public configuration is loading even with an authenticated session", () => {
    expect(chatSessionUi(undefined, { authenticated: true, account, network: "testnet" })).toEqual({
      ready: false,
      label: "Waiting for configuration",
      modeLabel: "Checking configuration",
      placeholder: "Checking Pilot configuration…",
      notice: null,
    });
  });

  it("fails closed when public configuration is unavailable even with an authenticated session", () => {
    expect(chatSessionUi(null, { authenticated: true, account, network: "testnet" })).toEqual({
      ready: false,
      label: "Unavailable",
      modeLabel: "Configuration unavailable",
      placeholder: "Pilot configuration unavailable—reload to retry.",
      notice: "configuration",
    });
  });

  it.each([
    ["mock", mockConfig],
    ["live", liveConfig],
  ])("requires an authenticated wallet session for configured local-wallet %s chat", (_mode, config) => {
    const modeLabel = config.mockMode ? "Explicit mock" : "Live Harbor";
    expect(chatSessionUi(config, undefined)).toMatchObject({
      ready: false,
      label: "Checking…",
      modeLabel,
      notice: null,
    });
    expect(chatSessionUi(config, null)).toMatchObject({
      ready: false,
      label: "Unavailable",
      modeLabel,
      notice: "unavailable",
    });
    expect(chatSessionUi(config, { authenticated: false })).toMatchObject({
      ready: false,
      label: "Not connected",
      modeLabel,
      notice: "onboarding",
    });
    expect(chatSessionUi(config, { authenticated: true, account, network: "testnet" }))
      .toMatchObject({ ready: true, label: "r9cZA1…nfk59", modeLabel });
  });

  it("enables live chat only for an authenticated test-network account", () => {
    expect(chatSessionUi(liveConfig, { authenticated: true, account, network: "testnet" })).toEqual({
      ready: true,
      label: "r9cZA1…nfk59",
      modeLabel: "Live Harbor",
      placeholder: "Ask Pilot to plan an XRPL action…",
      notice: null,
    });
  });

  it("retains the hosted live wallet-session gate without requiring local proof storage", () => {
    expect(chatSessionUi(hostedLiveConfig, { authenticated: false })).toMatchObject({
      ready: false,
      notice: "onboarding",
    });
    expect(chatSessionUi(
      hostedLiveConfig,
      { authenticated: true, account, network: "testnet" },
    )).toMatchObject({ ready: true, label: "r9cZA1…nfk59" });
  });
});
