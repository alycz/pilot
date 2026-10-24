import type { AccountLink, Envelope } from "@pilot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_LINK_STORAGE_KEY,
  DEV_LIFECYCLE_STORAGE_KEYS,
  PENDING_LINK_STORAGE_KEY,
  REQUIRED_DELEGATION_PERMISSIONS,
  isLifecycleStorageKey,
  readActiveLinkRecord,
  readDevLifecycleMarkers,
  shouldWarnBeforeUnload,
  verifyActiveLinkLifecycle,
  type LifecycleDependencies,
} from "./delegation-lifecycle-guard";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DELEGATE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const CONTEXT_BINDING = "00000000-0000-4000-8000-000000000000";

function activeRecord(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    account: OWNER,
    main_account: OWNER,
    budget_account: OWNER,
    network: "testnet",
    status: "active",
    delegate: DELEGATE,
    permissions: [...REQUIRED_DELEGATION_PERMISSIONS],
    txHash: "A".repeat(64),
    ...overrides,
  });
}

function activeLink(overrides: Partial<AccountLink> = {}): AccountLink {
  return {
    owner: OWNER,
    network: "testnet",
    delegate: DELEGATE,
    permissions: [...REQUIRED_DELEGATION_PERMISSIONS],
    status: "active",
    ...overrides,
  };
}

function pendingDelegateRecord(overrides: Record<string, unknown> = {}) {
  const lastLedgerSequence = 1_020;
  return JSON.stringify({
    version: 1,
    kind: "delegate",
    hash: "B".repeat(64),
    account: OWNER,
    network: "testnet",
    expectedDelegate: DELEGATE,
    lastLedgerSequence,
    expectedTx: {
      TransactionType: "DelegateSet",
      Account: OWNER,
      Authorize: DELEGATE,
      Permissions: REQUIRED_DELEGATION_PERMISSIONS.map((PermissionValue) => ({
        Permission: { PermissionValue },
      })),
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: lastLedgerSequence,
    },
    ...overrides,
  });
}

function lifecycleMarker(
  network: "testnet" | "devnet" = "testnet",
  status: "owner_present" | "revoked" = "owner_present",
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    version: 1,
    account: OWNER,
    context_binding: CONTEXT_BINDING,
    network,
    status,
    ...overrides,
  });
}

function storageWith(entries: Record<string, string | null>) {
  return {
    getItem: vi.fn((key: string) => entries[key] ?? null),
  };
}

function ok(link: AccountLink): Envelope<AccountLink> {
  return {
    ok: true,
    data: link,
    asOf: "2026-10-19T00:00:00.000Z",
    asOfBasis: "ledger",
  };
}

function dependencies(link = activeLink()): LifecycleDependencies {
  return {
    loadSession: vi.fn(async () => ({
      authenticated: true,
      account: OWNER,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    } as const)),
    readStatus: vi.fn(async () => ok(link)),
  };
}

describe("global delegation lifecycle guard", () => {
  it("reads only the two strict public development lifecycle keys", () => {
    const getItem = vi.fn((key: string) => {
      if (key === DEV_LIFECYCLE_STORAGE_KEYS.testnet) return lifecycleMarker();
      if (key === DEV_LIFECYCLE_STORAGE_KEYS.devnet) return null;
      throw new Error("signer secret storage probed");
    });

    expect(readDevLifecycleMarkers({ getItem })).toMatchObject({
      kind: "owner-present",
      markers: [{
        account: OWNER,
        context_binding: CONTEXT_BINDING,
        network: "testnet",
        status: "owner_present",
      }],
    });
    expect(getItem.mock.calls.map(([key]) => key)).toEqual([
      DEV_LIFECYCLE_STORAGE_KEYS.testnet,
      DEV_LIFECYCLE_STORAGE_KEYS.devnet,
    ]);
  });

  it("strictly validates durable marker shape and its network-specific key", () => {
    for (const raw of [
      "{",
      lifecycleMarker("testnet", "owner_present", { extra: true }),
      lifecycleMarker("devnet"),
      lifecycleMarker("testnet", "owner_present", { account: "invalid" }),
      lifecycleMarker("testnet", "owner_present", { context_binding: undefined }),
      lifecycleMarker("testnet", "owner_present", { context_binding: "not-a-uuid" }),
      lifecycleMarker("testnet", "owner_present", {
        context_binding: "00000000-0000-1000-8000-000000000000",
      }),
      lifecycleMarker("testnet", "owner_present", { version: 2 }),
      lifecycleMarker("testnet", "owner_present", { status: "unknown" }),
    ]) {
      expect(readDevLifecycleMarkers(storageWith({
        [DEV_LIFECYCLE_STORAGE_KEYS.testnet]: raw,
        [DEV_LIFECYCLE_STORAGE_KEYS.devnet]: null,
      })).kind).toBe("invalid");
    }
  });

  it("fails closed when durable lifecycle storage is unavailable", async () => {
    const durable = readDevLifecycleMarkers({
      getItem: () => { throw new Error("blocked"); },
    });
    expect(durable).toEqual({ kind: "unavailable" });
    const verification = await verifyActiveLinkLifecycle(
      { kind: "none" },
      dependencies(),
      durable,
    );
    expect(verification).toMatchObject({
      kind: "unverified",
      recoveryRequired: true,
      warn: true,
    });
    expect(shouldWarnBeforeUnload({ kind: "none" }, verification, durable)).toBe(true);
  });

  it("keeps an owner-present durable marker guarded without session records", async () => {
    const durable = readDevLifecycleMarkers(storageWith({
      [DEV_LIFECYCLE_STORAGE_KEYS.testnet]: lifecycleMarker(),
      [DEV_LIFECYCLE_STORAGE_KEYS.devnet]: null,
    }));
    const deps = dependencies();
    const verification = await verifyActiveLinkLifecycle(
      { kind: "none" },
      deps,
      durable,
    );

    expect(verification).toMatchObject({
      kind: "recovery",
      recoveryRequired: true,
      warn: true,
    });
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.readStatus).not.toHaveBeenCalled();
    expect(shouldWarnBeforeUnload({ kind: "none" }, verification, durable)).toBe(true);
  });

  it("allows a revoked durable marker alone to be inactive", async () => {
    const durable = readDevLifecycleMarkers(storageWith({
      [DEV_LIFECYCLE_STORAGE_KEYS.testnet]: lifecycleMarker("testnet", "revoked"),
      [DEV_LIFECYCLE_STORAGE_KEYS.devnet]: null,
    }));
    const verification = await verifyActiveLinkLifecycle(
      { kind: "none" },
      dependencies(),
      durable,
    );
    expect(verification).toEqual({ kind: "none", warn: false });
    expect(shouldWarnBeforeUnload({ kind: "none" }, verification, durable)).toBe(false);
  });

  it("requires an active session record to match a durable owner and network", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const durable = readDevLifecycleMarkers(storageWith({
      [DEV_LIFECYCLE_STORAGE_KEYS.testnet]: lifecycleMarker("testnet", "owner_present", {
        account: DELEGATE,
      }),
      [DEV_LIFECYCLE_STORAGE_KEYS.devnet]: null,
    }));
    const deps = dependencies();
    const verification = await verifyActiveLinkLifecycle(read, deps, durable);

    expect(verification).toMatchObject({ kind: "unverified", warn: true });
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.readStatus).not.toHaveBeenCalled();
  });

  it("keeps a matching owner marker guarded even after exact Harbor revocation", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const durable = readDevLifecycleMarkers(storageWith({
      [DEV_LIFECYCLE_STORAGE_KEYS.testnet]: lifecycleMarker(),
      [DEV_LIFECYCLE_STORAGE_KEYS.devnet]: null,
    }));
    const verification = await verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ status: "revoked", permissions: [] })),
      durable,
    );

    expect(verification).toMatchObject({
      kind: "unverified",
      recoveryRequired: true,
      warn: true,
    });
    expect(shouldWarnBeforeUnload(read, verification, durable)).toBe(true);
  });

  it("subscribes refreshes only to public lifecycle storage keys", () => {
    expect(isLifecycleStorageKey(ACTIVE_LINK_STORAGE_KEY)).toBe(true);
    expect(isLifecycleStorageKey(PENDING_LINK_STORAGE_KEY)).toBe(true);
    expect(isLifecycleStorageKey(DEV_LIFECYCLE_STORAGE_KEYS.testnet)).toBe(true);
    expect(isLifecycleStorageKey(DEV_LIFECYCLE_STORAGE_KEYS.devnet)).toBe(true);
    expect(isLifecycleStorageKey(null)).toBe(true);
    expect(isLifecycleStorageKey("pilot.wallet.dev.v2.testnet")).toBe(false);
  });

  it("reads only the public active-link record", () => {
    const getItem = vi.fn((key: string) => key === ACTIVE_LINK_STORAGE_KEY
      ? activeRecord()
      : (() => { throw new Error("secret storage probed"); })());

    expect(readActiveLinkRecord({ getItem })).toMatchObject({
      kind: "active",
      record: { account: OWNER, network: "testnet", status: "active" },
    });
    expect(getItem).toHaveBeenCalledOnce();
    expect(getItem).toHaveBeenCalledWith(ACTIVE_LINK_STORAGE_KEY);
  });

  it("restores and binds a public pending DelegateSet record", () => {
    const storage = storageWith({
      [ACTIVE_LINK_STORAGE_KEY]: null,
      [PENDING_LINK_STORAGE_KEY]: pendingDelegateRecord(),
    });

    expect(readActiveLinkRecord(storage)).toMatchObject({
      kind: "pending-delegate",
      record: {
        version: 1,
        kind: "delegate",
        hash: "B".repeat(64),
        account: OWNER,
        network: "testnet",
        expectedDelegate: DELEGATE,
      },
    });
    expect(storage.getItem.mock.calls.map(([key]) => key)).toEqual([
      ACTIVE_LINK_STORAGE_KEY,
      PENDING_LINK_STORAGE_KEY,
    ]);
  });

  it.each(["trust", "revoke"] as const)(
    "does not globally warn for a pending %s recovery",
    (kind) => {
      const read = readActiveLinkRecord(storageWith({
        [ACTIVE_LINK_STORAGE_KEY]: null,
        [PENDING_LINK_STORAGE_KEY]: pendingDelegateRecord({ kind }),
      }));
      expect(read).toEqual({ kind: "none" });
      expect(shouldWarnBeforeUnload(read, { kind: "none", warn: false })).toBe(false);
    },
  );

  it("fails closed for malformed pending DelegateSet bindings", () => {
    for (const overrides of [
      { hash: "not-a-hash" },
      { account: DELEGATE },
      { network: "mainnet" },
      { expectedDelegate: "invalid" },
      { expectedTx: { TransactionType: "Payment", Account: OWNER } },
    ]) {
      const read = readActiveLinkRecord(storageWith({
        [ACTIVE_LINK_STORAGE_KEY]: null,
        [PENDING_LINK_STORAGE_KEY]: pendingDelegateRecord(overrides),
      }));
      expect(read.kind).toBe("invalid");
      expect(shouldWarnBeforeUnload(read, { kind: "none", warn: false })).toBe(true);
    }
  });

  it("verifies owner, network, authoritative delegate, and exactly seven permissions", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const deps = dependencies();

    await expect(verifyActiveLinkLifecycle(read, deps)).resolves.toMatchObject({
      kind: "active",
      warn: true,
    });
    expect(deps.readStatus).toHaveBeenCalledWith(OWNER, "testnet");
  });

  it("binds the delegate stored in the public record", async () => {
    const read = readActiveLinkRecord({
      getItem: () => activeRecord({ delegate: DELEGATE }),
    });
    await expect(verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ delegate: OWNER })),
    )).resolves.toMatchObject({ kind: "unverified", warn: true });
  });

  it("keeps a pending DelegateSet guarded while Harbor reports pending", async () => {
    const read = readActiveLinkRecord(storageWith({
      [ACTIVE_LINK_STORAGE_KEY]: null,
      [PENDING_LINK_STORAGE_KEY]: pendingDelegateRecord(),
    }));
    const deps = dependencies(activeLink({ status: "pending" }));

    const verification = await verifyActiveLinkLifecycle(read, deps);
    expect(verification).toMatchObject({ kind: "pending", warn: true });
    expect(deps.readStatus).toHaveBeenCalledWith(OWNER, "testnet");
    expect(shouldWarnBeforeUnload(read, verification)).toBe(true);
  });

  it("converts a pending DelegateSet to the active warning only for the exact delegate", async () => {
    const read = readActiveLinkRecord(storageWith({
      [ACTIVE_LINK_STORAGE_KEY]: null,
      [PENDING_LINK_STORAGE_KEY]: pendingDelegateRecord(),
    }));
    await expect(verifyActiveLinkLifecycle(read, dependencies())).resolves.toMatchObject({
      kind: "active",
      warn: true,
    });
    await expect(verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ delegate: OWNER })),
    )).resolves.toMatchObject({ kind: "unverified", warn: true });
  });

  it("never treats a persisted pending DelegateSet as safe on unavailable or revoked status", async () => {
    const read = readActiveLinkRecord(storageWith({
      [ACTIVE_LINK_STORAGE_KEY]: null,
      [PENDING_LINK_STORAGE_KEY]: pendingDelegateRecord(),
    }));
    const unavailable = dependencies();
    unavailable.readStatus = vi.fn(async (): Promise<Envelope<AccountLink>> => ({
      ok: false as const,
      error: { service: "harbor", kind: "error", message: "unavailable" },
    }));
    await expect(verifyActiveLinkLifecycle(read, unavailable)).resolves.toMatchObject({
      kind: "unverified",
      warn: true,
    });
    const revoked = await verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ status: "revoked", permissions: [] })),
    );
    expect(revoked).toMatchObject({ kind: "unverified", warn: true });
    expect(shouldWarnBeforeUnload(
      read,
      { ...revoked, kind: "inactive", warn: false },
    )).toBe(true);
  });

  it.each([
    ["missing session", dependencies(), { authenticated: false }],
    ["wrong owner", dependencies(), { authenticated: true, account: DELEGATE, network: "testnet" }],
    ["wrong network", dependencies(), { authenticated: true, account: OWNER, network: "devnet" }],
  ] as const)("fails closed for %s", async (_label, deps, session) => {
    deps.loadSession = vi.fn(async () => session as Awaited<ReturnType<LifecycleDependencies["loadSession"]>>);
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    await expect(verifyActiveLinkLifecycle(read, deps)).resolves.toMatchObject({
      kind: "unverified",
      warn: true,
    });
  });

  it("fails closed for status errors, mismatches, and altered permissions", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const failed = dependencies();
    failed.readStatus = vi.fn(async (): Promise<Envelope<AccountLink>> => ({
      ok: false as const,
      error: { service: "harbor", kind: "error", message: "unavailable" },
    }));
    await expect(verifyActiveLinkLifecycle(read, failed)).resolves.toMatchObject({ warn: true });
    await expect(verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ owner: DELEGATE })),
    )).resolves.toMatchObject({ kind: "unverified", warn: true });
    await expect(verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({
        permissions: [...REQUIRED_DELEGATION_PERMISSIONS.slice(0, 6), "Payment"],
      })),
    )).resolves.toMatchObject({ kind: "unverified", warn: true });
  });

  it("stops warning only after the stored delegate is confirmed revoked with no permissions", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const verification = await verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ status: "revoked", permissions: [] })),
    );
    expect(verification).toMatchObject({ kind: "inactive", warn: false });
    expect(shouldWarnBeforeUnload(read, verification)).toBe(false);

    const replacement = readActiveLinkRecord({
      getItem: () => activeRecord({ txHash: "B".repeat(64) }),
    });
    expect(shouldWarnBeforeUnload(replacement, verification)).toBe(true);
  });

  it("keeps warning when a revoked response does not match the stored delegate", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const verification = await verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ delegate: OWNER, status: "revoked", permissions: [] })),
    );
    expect(verification).toMatchObject({ kind: "unverified", warn: true });
    expect(shouldWarnBeforeUnload(read, verification)).toBe(true);
  });

  it("keeps warning when a revoked response still contains permissions", async () => {
    const read = readActiveLinkRecord({ getItem: () => activeRecord() });
    const verification = await verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ status: "revoked" })),
    );
    expect(verification).toMatchObject({ kind: "unverified", warn: true });
    expect(shouldWarnBeforeUnload(read, verification)).toBe(true);
  });

  it("keeps legacy active records without a stored delegate guarded after revocation", async () => {
    const read = readActiveLinkRecord({
      getItem: () => activeRecord({ delegate: undefined, permissions: undefined }),
    });
    const verification = await verifyActiveLinkLifecycle(
      read,
      dependencies(activeLink({ status: "revoked", permissions: [] })),
    );
    expect(verification).toMatchObject({ kind: "unverified", warn: true });
    expect(shouldWarnBeforeUnload(read, verification)).toBe(true);
  });

  it("warns synchronously for malformed or not-yet-verified active records", () => {
    expect(shouldWarnBeforeUnload(
      readActiveLinkRecord({ getItem: () => "{" }),
      { kind: "none", warn: false },
    )).toBe(true);
    expect(shouldWarnBeforeUnload(
      readActiveLinkRecord({ getItem: () => activeRecord() }),
      { kind: "checking", warn: true },
    )).toBe(true);
  });
});
