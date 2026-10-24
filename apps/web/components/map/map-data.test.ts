import type { Venue } from "@pilot/contracts";
import { createMockHarborClient } from "@pilot/harbor-client";
import { describe, expect, it, vi } from "vitest";

import type { PublicPilotConfig } from "@/lib/harbor-browser";

import {
  createLatestRequestGuard,
  fetchVenueCatalog,
  fetchVenueDetail,
  resolveMapRuntimeContext,
  safeVenueReferenceLinks,
  selectMapHarborClient,
} from "./map-data";

const liveConfig: PublicPilotConfig = {
  network: "testnet",
  stableAsset: {
    currency: "RLUSD",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  },
  devSignerEnabled: true,
  walletActionProofRequired: true,
  walletActionProofConfigured: true,
  mockMode: false,
};

const mockConfig: PublicPilotConfig = {
  ...liveConfig,
  mockMode: true,
};

const venue: Venue = {
  id: "xrpl-amm",
  name: "XRPL AMM",
  kind: "execution-primitive",
  layer: "xrpl-l1",
  category: ["liquidity"],
  status: { testnet: "live" },
  reads: ["amm.info"],
  risks: ["Pool prices move."],
  links: {},
};

describe("map runtime context", () => {
  it("fails closed while configuration is loading or unavailable", () => {
    expect(resolveMapRuntimeContext(undefined, undefined)).toMatchObject({
      canLoadCatalog: false,
      kind: "checking",
      modeLabel: "Checking configuration",
    });
    expect(resolveMapRuntimeContext(null, { authenticated: false })).toMatchObject({
      canLoadCatalog: false,
      kind: "configuration-error",
      modeLabel: "Configuration unavailable",
    });
  });

  it("loads the public catalog without inventing an owner when no session exists", () => {
    expect(resolveMapRuntimeContext(liveConfig, { authenticated: false })).toMatchObject({
      canLoadCatalog: true,
      kind: "public",
      modeLabel: "Live Harbor catalog",
      network: "testnet",
      owner: null,
    });
    expect(resolveMapRuntimeContext(liveConfig, null)).toMatchObject({
      canLoadCatalog: true,
      kind: "session-error",
      owner: null,
    });
  });

  it("changes identity when the authenticated owner or network changes", () => {
    const first = resolveMapRuntimeContext(liveConfig, {
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
    });
    const second = resolveMapRuntimeContext(liveConfig, {
      authenticated: true,
      account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
      network: "testnet",
    });
    const devnet = resolveMapRuntimeContext(
      { ...liveConfig, network: "devnet" },
      {
        authenticated: true,
        account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        network: "devnet",
      },
    );

    expect(first.owner).not.toBe(second.owner);
    expect(first.key).not.toBe(second.key);
    expect(second.key).not.toBe(devnet.key);
    expect(devnet.network).toBe("devnet");
  });

  it("ignores a stale wallet session from another network", () => {
    expect(resolveMapRuntimeContext(liveConfig, {
      authenticated: true,
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "devnet",
    })).toMatchObject({
      canLoadCatalog: true,
      kind: "session-mismatch",
      network: "testnet",
      owner: null,
    });
  });

  it("labels mock data only when public config explicitly enables mock mode", () => {
    expect(resolveMapRuntimeContext(
      { ...liveConfig, mockMode: true },
      { authenticated: false },
    ).modeLabel).toBe("Demo catalog · simulated Harbor");
  });
});

describe("live venue reads", () => {
  it("returns Harbor venues.list metadata without a fixture fallback", async () => {
    const op = vi.fn().mockResolvedValue({
      ok: true,
      data: [venue],
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "Harbor catalog",
      caveat: ["unverified-match"],
    });
    await expect(fetchVenueCatalog({ op } as never)).resolves.toEqual({
      data: [venue],
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "Harbor catalog",
      caveats: ["unverified-match"],
    });
    expect(op).toHaveBeenCalledWith("venues.list", {});
  });

  it("surfaces Harbor list errors instead of returning demo venues", async () => {
    const op = vi.fn().mockResolvedValue({
      ok: false,
      error: { service: "venues", kind: "error", message: "catalog unavailable" },
    });
    await expect(fetchVenueCatalog({ op } as never)).rejects.toThrow("catalog unavailable");
  });

  it("loads the selected venue through venues.get and rejects mismatched stale data", async () => {
    const good = vi.fn().mockResolvedValue({
      ok: true,
      data: venue,
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "Harbor catalog",
    });
    await expect(fetchVenueDetail({ op: good } as never, "xrpl-amm")).resolves.toMatchObject({
      data: venue,
    });
    expect(good).toHaveBeenCalledWith("venues.get", { id: "xrpl-amm" });

    const stale = vi.fn().mockResolvedValue({
      ok: true,
      data: { ...venue, id: "xrpl-dex-clob" },
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "Harbor catalog",
    });
    await expect(fetchVenueDetail({ op: stale } as never, "xrpl-amm")).rejects.toThrow(
      "different venue",
    );
  });

  it("invalidates superseded responses", () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });
});

describe("map catalog mode selection", () => {
  it("uses Harbor's explicit mock fixtures only when verified config enables mock mode", async () => {
    const liveOp = vi.fn();
    const mock = createMockHarborClient();
    const harbor = selectMapHarborClient(mockConfig, {
      live: { op: liveOp } as never,
      mock,
    });

    expect(harbor).toBe(mock);
    const snapshot = await fetchVenueCatalog(harbor!);
    expect(snapshot.data.length).toBeGreaterThan(0);
    expect(snapshot.data.find(({ id }) => id === "xrpl-escrow")?.execution).toEqual({
      transactions: ["EscrowCreate", "EscrowFinish", "EscrowCancel"],
      builders: ["tx.escrowCreate", "tx.escrowFinish", "tx.escrowCancel"],
    });
    expect(snapshot.data.find(({ id }) => id === "xrpl-checks")?.execution).toEqual({
      transactions: ["CheckCreate", "CheckCash", "CheckCancel"],
      builders: ["tx.checkCreate", "tx.checkCash", "tx.checkCancel"],
    });
    expect(snapshot.data.find(({ id }) => id === "xrpl-single-asset-vault")?.execution).toEqual({
      transactions: ["VaultDeposit", "VaultWithdraw"],
      builders: ["tx.vaultDeposit", "tx.vaultWithdraw"],
    });
    for (const id of ["xrpl-lending", "xrpl-permissioned-dex", "xrpl-x402"]) {
      expect(snapshot.data.find((venue) => venue.id === id)?.execution, id).toBeUndefined();
    }
    expect(liveOp).not.toHaveBeenCalled();
  });

  it("uses the same-origin live client when verified config disables mock mode", async () => {
    const liveOp = vi.fn().mockResolvedValue({
      ok: true,
      data: [venue],
      asOf: "2026-10-19T00:00:00.000Z",
      asOfBasis: "Harbor catalog",
    });
    const mockOp = vi.fn();
    const live = { op: liveOp } as never;
    const harbor = selectMapHarborClient(liveConfig, {
      live,
      mock: { op: mockOp } as never,
    });

    expect(harbor).toBe(live);
    await expect(fetchVenueCatalog(harbor!)).resolves.toMatchObject({ data: [venue] });
    expect(liveOp).toHaveBeenCalledWith("venues.list", {});
    expect(mockOp).not.toHaveBeenCalled();
  });

  it("selects no client while configuration is missing or invalid", () => {
    const liveOp = vi.fn();
    const mockOp = vi.fn();
    const clients = {
      live: { op: liveOp } as never,
      mock: { op: mockOp } as never,
    };

    expect(selectMapHarborClient(undefined, clients)).toBeNull();
    expect(selectMapHarborClient(null, clients)).toBeNull();
    expect(selectMapHarborClient({ ...liveConfig, mockMode: "1" } as never, clients)).toBeNull();
    expect(liveOp).not.toHaveBeenCalled();
    expect(mockOp).not.toHaveBeenCalled();
  });

  it("surfaces a live failure without consulting the mock client", async () => {
    const liveOp = vi.fn().mockResolvedValue({
      ok: false,
      error: { service: "venues", kind: "error", message: "live catalog unavailable" },
    });
    const mockOp = vi.fn();
    const harbor = selectMapHarborClient(liveConfig, {
      live: { op: liveOp } as never,
      mock: { op: mockOp } as never,
    });

    await expect(fetchVenueCatalog(harbor!)).rejects.toThrow("live catalog unavailable");
    expect(liveOp).toHaveBeenCalledTimes(1);
    expect(mockOp).not.toHaveBeenCalled();
  });
});

describe("venue reference links", () => {
  it("keeps only absolute credential-free HTTPS references", () => {
    expect(safeVenueReferenceLinks({
      docs: "https://xrpl.org/docs.html?network=testnet#start",
      credentials: "https://user:password@example.com/private",
      data: "data:text/html,unsafe",
      insecure: "http://example.com",
      javascript: "javascript:alert(1)",
      localhost: "https://localhost/admin",
      dottedLocalhost: "https://localhost./admin",
      privateIpv4: "https://192.168.1.2/admin",
      privateIpv6: "https://[::1]/admin",
      mappedIpv6: "https://[::ffff:127.0.0.1]/admin",
      linkLocal: "https://169.254.169.254/latest/meta-data",
      unspecified: "https://0.0.0.0/admin",
      carrierNat: "https://100.64.0.1/admin",
      decimalLoopback: "https://2130706433/admin",
      hexadecimalLoopback: "https://0x7f000001/admin",
      octalLoopback: "https://0177.0.0.1/admin",
      intranet: "https://internal/dashboard",
      dottedIntranet: "https://internal./dashboard",
      lookalike: "https://xrpl.org.example.com/docs",
      unapprovedPublic: "https://example.com/docs",
      customPort: "https://xrpl.org:8443/docs",
      malformed: "not a URL",
      relative: "/docs",
    })).toEqual([
      ["docs", "https://xrpl.org/docs.html?network=testnet#start"],
    ]);
  });

  it("canonicalizes permitted trailing-dot hosts without broadening the allowlist", () => {
    expect(safeVenueReferenceLinks({
      docs: "https://xrpl.org./docs",
      subdomain: "https://dev.xrpl.org./reference",
      encoded: "https://%78rpl.org/docs",
    })).toEqual([
      ["docs", "https://xrpl.org/docs"],
      ["subdomain", "https://dev.xrpl.org/reference"],
      ["encoded", "https://xrpl.org/docs"],
    ]);
  });

  it("handles an absent reference map", () => {
    expect(safeVenueReferenceLinks(undefined)).toEqual([]);
  });
});
