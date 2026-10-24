import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WalletSessionStatus } from "../../lib/harbor-browser";
import type { CapabilityGrant } from "./ledger-capability-client";
import {
  LedgerCapabilityWorkspace,
  capabilityMatchesSession,
  capabilityRejectionNotice,
  capabilityRemainingUses,
  effectiveCapabilityState,
} from "./ledger-capability-workspace";
import {
  capabilityRecoveryKey,
  parseCapabilityRecovery,
  recoverableInvocation,
  serializeCapabilityRecovery,
} from "./ledger-capability-recovery";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const REF = `cap_v1_${"A".repeat(43)}`;

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    capabilityRef: REF,
    principal: "pilot-browser",
    account: OWNER,
    network: "testnet",
    service: "mock.catalog",
    operation: "read",
    amount: { unit: "request", value: "1" },
    destination: "local-fixture-catalog",
    notBefore: "2026-10-24T12:00:00.000Z",
    expiresAt: "2026-10-24T12:10:00.000Z",
    maxUses: 3,
    uses: 1,
    rateLimit: { windowSeconds: 60, maxCalls: 3 },
    generation: 1,
    state: "active",
    approvalDigest: "a".repeat(64),
    ...overrides,
  };
}

describe("Ledger capability workspace", () => {
  it("mounts a standalone complete lifecycle without shared navigation", () => {
    const html = renderToStaticMarkup(<LedgerCapabilityWorkspace />);
    expect(html).toContain("Ledger capability broker");
    expect(html).toContain("Grant a scope, never an API key");
    expect(html).toContain("Prepare bounded grant");
    expect(html).toContain("not a physical Ledger");
  });

  it("keeps recovery records account-scoped across wallet switches", () => {
    const saved = serializeCapabilityRecovery({
      version: 1,
      owner: OWNER,
      network: "testnet",
      phase: "tracking",
      capability_ref: REF,
    });
    expect(capabilityRecoveryKey(OWNER)).not.toBe(capabilityRecoveryKey(OTHER));
    expect(parseCapabilityRecovery(saved, OWNER)).toMatchObject({ capability_ref: REF });
    expect(parseCapabilityRecovery(saved, OTHER)).toBeUndefined();
    expect(parseCapabilityRecovery('{"owner":"bad"}', OWNER)).toBeUndefined();

    const matching: WalletSessionStatus = { authenticated: true, account: OWNER, network: "testnet" };
    const switched: WalletSessionStatus = { authenticated: true, account: OTHER, network: "testnet" };
    const networkSwitched: WalletSessionStatus = { authenticated: true, account: OWNER, network: "devnet" };
    expect(capabilityMatchesSession(grant(), matching)).toBe(true);
    expect(capabilityMatchesSession(grant(), switched)).toBe(false);
    expect(capabilityMatchesSession(grant(), networkSwitched)).toBe(false);
  });

  it("persists only the exact public invocation tuple for reload recovery", () => {
    const serialized = serializeCapabilityRecovery({
      version: 1,
      owner: OWNER,
      network: "testnet",
      phase: "invoke_unknown",
      capability_ref: REF,
      generation: 1,
      request_id: "capability-invoke-request-1",
      resource: "ledger-docs",
    });
    const restored = parseCapabilityRecovery(serialized, OWNER);
    expect(recoverableInvocation(restored)).toEqual({
      capabilityRef: REF,
      generation: 1,
      requestId: "capability-invoke-request-1",
    });
    expect(serialized).not.toContain("tx_blob");
    expect(serialized).not.toContain("secret");
    expect(() => serializeCapabilityRecovery({
      ...restored!,
      resource: "market-fixture",
    } as never)).toThrow();
  });

  it("retains an ambiguous prepare lock without inventing a replacement reference", () => {
    const serialized = serializeCapabilityRecovery({
      version: 1,
      owner: OWNER,
      network: "testnet",
      phase: "prepare_unknown",
      started_at: "2026-10-24T12:00:00.000Z",
    });
    expect(parseCapabilityRecovery(serialized, OWNER)).toMatchObject({ phase: "prepare_unknown" });
    expect(recoverableInvocation(parseCapabilityRecovery(serialized, OWNER))).toBeUndefined();
    expect(serialized).not.toContain("capability_ref");
  });

  it("computes remaining quota and expires locally before allowing another invocation", () => {
    const active = grant();
    expect(capabilityRemainingUses(active)).toBe(2);
    expect(effectiveCapabilityState(active, Date.parse("2026-10-24T12:09:59.000Z")))
      .toBe("active");
    expect(effectiveCapabilityState(active, Date.parse(active.expiresAt)))
      .toBe("expired");
    expect(capabilityRemainingUses(grant({ uses: 3 }))).toBe(0);
    expect(effectiveCapabilityState(grant({ state: "revoked" }), 0)).toBe("revoked");
  });

  it("keeps owner rejection fail-closed", () => {
    expect(capabilityRejectionNotice("activate")).toContain("remains inactive");
    expect(capabilityRejectionNotice("revoke")).toContain("remains unchanged");
  });
});
