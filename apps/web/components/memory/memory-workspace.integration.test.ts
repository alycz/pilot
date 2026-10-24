import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { personalizationPanelScope, resolveMemoryReadiness } from "./live-memory";

const source = readFileSync(
  fileURLToPath(new URL("./memory-workspace.tsx", import.meta.url)),
  "utf8",
);

describe("MemoryWorkspace personalization integration", () => {
  it("mounts both review panels only behind the configured identity-bound scope", () => {
    expect(source).toContain("loadPersonalizationFixtureSession(");
    expect(source).toContain("config?.structuredPreferencesEnabled === true");
    expect(source).toContain("personalizationPanelScope(readiness, snapshot)");
    expect(source).toContain("<StructuredPreferencesPanel");
    expect(source).toContain("<WorkflowLessonsPanel");
  });

  it("derives a panel scope only for the server-confirmed fixture identity", () => {
    const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
    const readiness = resolveMemoryReadiness(
      {
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: true,
        structuredPreferencesEnabled: true,
      },
      { authenticated: true, account: owner, network: "testnet" },
      Date.now(),
      true,
    );
    expect(personalizationPanelScope(readiness)).toEqual({
      owner,
      network: "testnet",
    });
    expect(personalizationPanelScope(resolveMemoryReadiness(
      {
        network: "testnet",
        stableAsset: {
          currency: "RLUSD",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: true,
      },
      { authenticated: false },
    ))).toBeUndefined();
  });
});
