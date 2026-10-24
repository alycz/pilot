import type { AccountLink, Envelope } from "@pilot/contracts";
import { describe, expect, it, vi } from "vitest";
import { WALLET_SESSION_CHANGED_EVENT } from "../../lib/harbor-browser";

import {
  DELEGATION_STATUS_LOADING,
  loadDelegationStatus,
  registerShellIdentityRefresh,
  shellIdentityLabels,
  shellWalletAction,
  shellSessionExpiryDelay,
  type DelegationStatusDependencies,
} from "./delegation-status";

const OWNER_A = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OWNER_B = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function link(
  status: AccountLink["status"] = "active",
  owner = OWNER_A,
  network: AccountLink["network"] = "testnet",
  permissions = ["OfferCreate", "OfferCancel"],
): AccountLink {
  return {
    owner,
    network,
    delegate: OWNER_B,
    permissions,
    status,
  };
}

function dependencies(overrides: Partial<DelegationStatusDependencies> = {}) {
  const readStatus = vi.fn(async (): Promise<Envelope<AccountLink>> => ({
    ok: true,
    data: link(),
    asOf: "2026-10-19T00:00:00.000Z",
    asOfBasis: "validated test ledger",
  }));
  return {
    value: {
      loadConfig: async () => ({
        network: "testnet" as const,
        stableAsset: { currency: "RLUSD", issuer: OWNER_B },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: false,
      }),
      loadSession: async () => ({
        authenticated: true as const,
        account: OWNER_A,
        network: "testnet" as const,
      }),
      readStatus,
      mockLink: link("active", OWNER_B, "testnet", ["OfferCreate"]),
      ...overrides,
    } satisfies DelegationStatusDependencies,
    readStatus,
  };
}

describe("loadDelegationStatus", () => {
  it("starts in an explicit non-active loading state", () => {
    expect(DELEGATION_STATUS_LOADING).toEqual({
      kind: "loading",
      label: "Checking delegation",
      detail: "Loading the wallet-bound delegation status.",
      identity: { kind: "loading" },
    });
  });

  it("presents loading, unavailable, and disconnected identities without invented values", () => {
    expect(shellIdentityLabels({ kind: "loading" })).toEqual({
      networkLabel: "Checking…",
      walletStatus: "loading",
      walletLabel: "Checking wallet",
      walletDetail: "Verifying the configured network and wallet session.",
    });
    expect(shellIdentityLabels({ kind: "unavailable" })).toEqual({
      networkLabel: "Unavailable",
      walletStatus: "unavailable",
      walletLabel: "Wallet unavailable",
      walletDetail: "Pilot could not verify the configured network and wallet session.",
    });
    expect(shellIdentityLabels({ kind: "disconnected", network: "devnet" })).toEqual({
      networkLabel: "Devnet",
      walletStatus: "disconnected",
      walletLabel: "Disconnected",
      walletDetail: "Connect an owner wallet on Devnet.",
    });
  });

  it("presents verified Devnet and different-owner sessions without a hardcoded account", () => {
    expect(shellIdentityLabels({
      kind: "connected",
      network: "devnet",
      account: OWNER_B,
    })).toEqual({
      networkLabel: "Devnet",
      walletStatus: "connected",
      walletLabel: "Connected",
      walletDetail: "Owner wallet verified on Devnet.",
      walletAccount: "rHb9CJ…tyTh",
    });
  });

  it("routes actionable wallet states to onboarding and disables the loading state", () => {
    expect(shellWalletAction("loading")).toEqual({ label: "Checking wallet…" });
    expect(shellWalletAction("disconnected")).toEqual({
      label: "Connect wallet",
      href: "/onboarding",
    });
    expect(shellWalletAction("unavailable")).toEqual({
      label: "Reconnect wallet",
      href: "/onboarding",
    });
    expect(shellWalletAction("network-mismatch")).toEqual({
      label: "Reconnect wallet",
      href: "/onboarding",
    });
    expect(shellWalletAction("connected")).toEqual({
      label: "Manage wallet",
      href: "/onboarding",
    });
  });

  it("computes an immediate expiry refresh without retaining an expired owner", () => {
    expect(shellSessionExpiryDelay({
      kind: "connected",
      network: "testnet",
      account: OWNER_A,
      expiresAt: 12_000,
    }, 10_000)).toBe(2_000);
    expect(shellSessionExpiryDelay({
      kind: "network-mismatch",
      network: "testnet",
      account: OWNER_A,
      sessionNetwork: "devnet",
      expiresAt: 9_000,
    }, 10_000)).toBe(0);
    expect(shellSessionExpiryDelay({ kind: "loading" }, 10_000)).toBeUndefined();
  });

  it("invalidates immediately on same-tab wallet replacement and removes the listener on cleanup", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };
    Object.defineProperty(documentTarget, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const onInvalidate = vi.fn();
    const intervalCallback = vi.fn();
    const clearIntervalImpl = vi.fn();
    const cleanup = registerShellIdentityRefresh({
      onInvalidate,
      windowTarget,
      documentTarget,
      setIntervalImpl: (callback) => {
        intervalCallback.mockImplementation(callback);
        return 17;
      },
      clearIntervalImpl,
    });

    windowTarget.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(onInvalidate).toHaveBeenCalledOnce();
    cleanup();
    windowTarget.dispatchEvent(new Event(WALLET_SESSION_CHANGED_EVENT));
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(clearIntervalImpl).toHaveBeenCalledWith(17);
  });

  it("reads live status using the authenticated owner and network", async () => {
    const { value, readStatus } = dependencies();

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "active",
      label: "Active · 2 permissions",
      owner: OWNER_A,
      network: "testnet",
      permissions: ["OfferCreate", "OfferCancel"],
      mock: false,
    });
    expect(readStatus).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledWith(OWNER_A, "testnet");
  });

  it("binds a matching Devnet config and session to the verified owner", async () => {
    const readStatus = vi.fn(async (): Promise<Envelope<AccountLink>> => ({
      ok: true,
      data: link("active", OWNER_B, "devnet"),
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "validated dev ledger",
    }));
    const { value } = dependencies({
      loadConfig: async () => ({
        network: "devnet",
        stableAsset: { currency: "RLUSD", issuer: OWNER_A },
        devSignerEnabled: false,
        walletActionProofRequired: false,
        walletActionProofConfigured: false,
        mockMode: false,
      }),
      loadSession: async () => ({ authenticated: true, account: OWNER_B, network: "devnet" }),
      readStatus,
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "active",
      owner: OWNER_B,
      network: "devnet",
      identity: { kind: "connected", account: OWNER_B, network: "devnet" },
    });
    expect(readStatus).toHaveBeenCalledWith(OWNER_B, "devnet");
  });

  it("does not call Harbor without an authenticated wallet session", async () => {
    const { value, readStatus } = dependencies({
      loadSession: async () => ({ authenticated: false }),
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "missing-session",
      label: "No wallet session",
      identity: { kind: "disconnected", network: "testnet" },
    });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("fails closed before Harbor reads when the returned wallet session is expired", async () => {
    const { value, readStatus } = dependencies({
      loadSession: async () => ({
        authenticated: true,
        account: OWNER_A,
        network: "testnet",
        expiresAt: Date.now() - 1,
      }),
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "missing-session",
      label: "Wallet session expired",
      identity: { kind: "disconnected", network: "testnet" },
    });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("drops an owner that expires while Harbor status is being read", async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const readStatus = vi.fn(async (): Promise<Envelope<AccountLink>> => {
      now = 12_000;
      return {
        ok: true,
        data: link(),
        asOf: "2026-10-19T00:00:00.000Z",
        asOfBasis: "validated test ledger",
      };
    });
    const { value } = dependencies({
      loadSession: async () => ({
        authenticated: true,
        account: OWNER_A,
        network: "testnet",
        expiresAt: 11_000,
      }),
      readStatus,
    });

    try {
      await expect(loadDelegationStatus(value)).resolves.toMatchObject({
        kind: "missing-session",
        label: "Wallet session expired",
        identity: { kind: "disconnected", network: "testnet" },
      });
      expect(readStatus).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("resets to unknown instead of reading on a session/config network mismatch", async () => {
    const { value, readStatus } = dependencies({
      loadSession: async () => ({
        authenticated: true,
        account: OWNER_A,
        network: "devnet",
      }),
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "unknown",
      label: "Delegation unknown",
      identity: {
        kind: "network-mismatch",
        network: "testnet",
        account: OWNER_A,
        sessionNetwork: "devnet",
      },
    });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("labels a mismatched wallet with both verified networks and its verified account", () => {
    expect(shellIdentityLabels({
      kind: "network-mismatch",
      network: "testnet",
      account: OWNER_A,
      sessionNetwork: "devnet",
    })).toEqual({
      networkLabel: "Testnet",
      walletStatus: "network-mismatch",
      walletLabel: "Network mismatch",
      walletDetail: "Wallet is on Devnet; Pilot is configured for Testnet.",
      walletAccount: "r9cZA1…fk59",
    });
  });

  it("re-scopes a refreshed read when the authenticated owner changes", async () => {
    let owner = OWNER_A;
    const readStatus = vi.fn(async (requestedOwner: string): Promise<Envelope<AccountLink>> => ({
      ok: true,
      data: link("active", requestedOwner),
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "validated test ledger",
    }));
    const { value } = dependencies({
      loadSession: async () => ({ authenticated: true, account: owner, network: "testnet" }),
      readStatus,
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({ owner: OWNER_A });
    owner = OWNER_B;
    await expect(loadDelegationStatus(value)).resolves.toMatchObject({ owner: OWNER_B });
    expect(readStatus).toHaveBeenNthCalledWith(1, OWNER_A, "testnet");
    expect(readStatus).toHaveBeenNthCalledWith(2, OWNER_B, "testnet");
  });

  it("rejects stale live data for a different owner or network", async () => {
    const wrongOwner = dependencies({
      readStatus: async () => ({
        ok: true,
        data: link("active", OWNER_B),
        asOf: "2026-10-19T00:00:00.000Z",
        asOfBasis: "validated test ledger",
      }),
    }).value;
    const wrongNetwork = dependencies({
      readStatus: async () => ({
        ok: true,
        data: link("active", OWNER_A, "devnet"),
        asOf: "2026-10-19T00:00:00.000Z",
        asOfBasis: "validated test ledger",
      }),
    }).value;

    await expect(loadDelegationStatus(wrongOwner)).resolves.toMatchObject({ kind: "error" });
    await expect(loadDelegationStatus(wrongNetwork)).resolves.toMatchObject({ kind: "error" });
  });

  it.each([
    ["pending", 2, "Pending · 2 permissions"],
    ["suspended", 1, "Suspended · 1 permission"],
    ["revoked", 0, "Revoked · 0 permissions"],
  ] as const)("shows %s and its actual permission count", async (status, count, label) => {
    const { value } = dependencies({
      readStatus: async () => ({
        ok: true,
        data: link(status, OWNER_A, "testnet", ["OfferCreate", "OfferCancel"].slice(0, count)),
        asOf: "2026-10-19T00:00:00.000Z",
        asOfBasis: "validated test ledger",
      }),
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: status,
      label,
      permissions: ["OfferCreate", "OfferCancel"].slice(0, count),
    });
  });

  it("uses the fixture only in explicit mock mode and labels it as mock", async () => {
    const { value, readStatus } = dependencies({
      loadConfig: async () => ({
        network: "testnet",
        stableAsset: { currency: "RLUSD", issuer: OWNER_B },
        devSignerEnabled: true,
        walletActionProofRequired: true,
        walletActionProofConfigured: true,
        mockMode: true,
      }),
      mockLink: link("active", OWNER_B, "devnet", ["OfferCreate"]),
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "active",
      label: "Mock Active · 1 permission",
      owner: OWNER_A,
      network: "testnet",
      permissions: ["OfferCreate"],
      mock: true,
    });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("keeps missing links and service failures visibly non-active", async () => {
    const missing = dependencies({
      readStatus: async () => ({
        ok: false,
        error: {
          service: "harbor",
          kind: "soft-empty",
          code: "LINK_NOT_FOUND",
          message: "not found",
        },
      }),
    }).value;
    const failed = dependencies({
      readStatus: async () => {
        throw new Error("offline");
      },
    }).value;

    await expect(loadDelegationStatus(missing)).resolves.toMatchObject({
      kind: "unknown",
      label: "No delegation found",
    });
    await expect(loadDelegationStatus(failed)).resolves.toMatchObject({
      kind: "error",
      label: "Delegation unavailable",
      identity: { kind: "connected", account: OWNER_A, network: "testnet" },
    });
  });

  it("fails closed when public configuration cannot be verified", async () => {
    const { value, readStatus } = dependencies({
      loadConfig: async () => {
        throw new Error("invalid config");
      },
    });

    await expect(loadDelegationStatus(value)).resolves.toMatchObject({
      kind: "error",
      label: "Delegation unavailable",
      identity: { kind: "unavailable" },
    });
    expect(readStatus).not.toHaveBeenCalled();
  });
});
