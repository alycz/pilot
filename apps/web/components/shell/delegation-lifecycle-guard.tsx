"use client";

import type { AccountLink, Envelope } from "@pilot/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  createBrowserHarborClient,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type WalletSessionStatus,
} from "../../lib/harbor-browser";

export const ACTIVE_LINK_STORAGE_KEY = "pilot:onboarding";
export const PENDING_LINK_STORAGE_KEY = "pilot:onboarding-pending";
export const DEV_LIFECYCLE_STORAGE_KEYS = {
  testnet: "pilot.wallet.dev.lifecycle.v1.testnet",
  devnet: "pilot.wallet.dev.lifecycle.v1.devnet",
} as const;

export const REQUIRED_DELEGATION_PERMISSIONS = [
  "OfferCreate",
  "OfferCancel",
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "EscrowFinish",
  "CheckCash",
] as const;

type TestNetwork = "testnet" | "devnet";

export type ActiveLinkRecord = {
  account: string;
  network: TestNetwork;
  status: "active";
  delegate?: string;
  permissions?: string[];
};

export type PendingDelegateRecord = {
  version: 1;
  kind: "delegate";
  hash: string;
  account: string;
  network: TestNetwork;
  expectedDelegate: string;
};

export type ActiveLinkRead =
  | { kind: "none" }
  | { kind: "inactive" }
  | { kind: "unavailable" }
  | { kind: "invalid"; fingerprint: string }
  | { kind: "active"; fingerprint: string; record: ActiveLinkRecord }
  | { kind: "pending-delegate"; fingerprint: string; record: PendingDelegateRecord };

export type DevLifecycleMarker = {
  version: 1;
  account: string;
  context_binding: string;
  network: TestNetwork;
  status: "owner_present" | "revoked";
};

export type DevLifecycleRead =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "invalid"; fingerprint: string }
  | { kind: "revoked"; fingerprint: string; markers: DevLifecycleMarker[] }
  | { kind: "owner-present"; fingerprint: string; markers: DevLifecycleMarker[] };

export type LifecycleVerification = {
  fingerprint?: string;
  kind: "none" | "checking" | "pending" | "active" | "inactive" | "recovery" | "unverified";
  recoveryRequired?: boolean;
  warn: boolean;
};

export type LifecycleDependencies = {
  loadSession(): Promise<WalletSessionStatus>;
  readStatus(
    owner: string,
    network: TestNetwork,
  ): Promise<Envelope<AccountLink>>;
};

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const CONTEXT_BINDING =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactPermissions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length !== REQUIRED_DELEGATION_PERMISSIONS.length) {
    return false;
  }
  const actual = new Set(value);
  return actual.size === REQUIRED_DELEGATION_PERMISSIONS.length &&
    REQUIRED_DELEGATION_PERMISSIONS.every((permission) => actual.has(permission));
}

/** Read only the two durable, public development-wallet lifecycle markers. */
export function readDevLifecycleMarkers(
  storage: Pick<Storage, "getItem">,
): DevLifecycleRead {
  const markers: DevLifecycleMarker[] = [];
  const fingerprints: string[] = [];

  for (const network of ["testnet", "devnet"] as const) {
    const key = DEV_LIFECYCLE_STORAGE_KEYS[network];
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return { kind: "unavailable" };
    }
    if (raw === null) continue;
    fingerprints.push(`${network}:${raw}`);

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: "invalid", fingerprint: `durable:${fingerprints.join("|")}` };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "invalid", fingerprint: `durable:${fingerprints.join("|")}` };
    }
    const marker = value as Record<string, unknown>;
    if (
      Object.keys(marker).sort().join("\0") !==
        "account\0context_binding\0network\0status\0version" ||
      marker.version !== 1 ||
      marker.network !== network ||
      typeof marker.account !== "string" ||
      !CLASSIC_ADDRESS.test(marker.account) ||
      typeof marker.context_binding !== "string" ||
      !CONTEXT_BINDING.test(marker.context_binding) ||
      (marker.status !== "owner_present" && marker.status !== "revoked")
    ) {
      return { kind: "invalid", fingerprint: `durable:${fingerprints.join("|")}` };
    }
    markers.push(marker as DevLifecycleMarker);
  }

  if (markers.length === 0) return { kind: "none" };
  const fingerprint = `durable:${fingerprints.join("|")}`;
  return markers.some((marker) => marker.status === "owner_present")
    ? { kind: "owner-present", fingerprint, markers }
    : { kind: "revoked", fingerprint, markers };
}

/**
 * Read only the public onboarding completion and pending-submission records. In
 * particular, this helper never probes the development signer's separate
 * session-storage namespace.
 */
export function readActiveLinkRecord(
  storage: Pick<Storage, "getItem">,
): ActiveLinkRead {
  let activeRaw: string | null;
  try {
    activeRaw = storage.getItem(ACTIVE_LINK_STORAGE_KEY);
  } catch {
    return { kind: "unavailable" };
  }
  if (activeRaw !== null) {
    let value: unknown;
    try {
      value = JSON.parse(activeRaw);
    } catch {
      return { kind: "invalid", fingerprint: `active:${activeRaw}` };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "invalid", fingerprint: `active:${activeRaw}` };
    }
    const record = value as Record<string, unknown>;
    if (record.status === "active") {
      if (
        typeof record.account !== "string" ||
        !CLASSIC_ADDRESS.test(record.account) ||
        (record.network !== "testnet" && record.network !== "devnet") ||
        (record.delegate !== undefined && (
          typeof record.delegate !== "string" || !CLASSIC_ADDRESS.test(record.delegate)
        )) ||
        (record.permissions !== undefined && !exactPermissions(record.permissions))
      ) {
        return { kind: "invalid", fingerprint: `active:${activeRaw}` };
      }
      return {
        kind: "active",
        fingerprint: `active:${activeRaw}`,
        record: {
          account: record.account,
          network: record.network,
          status: "active",
          ...(typeof record.delegate === "string" ? { delegate: record.delegate } : {}),
          ...(Array.isArray(record.permissions) ? { permissions: [...record.permissions] as string[] } : {}),
        },
      };
    }
    if (record.status !== "revoked") {
      return { kind: "invalid", fingerprint: `active:${activeRaw}` };
    }
  }

  let pendingRaw: string | null;
  try {
    pendingRaw = storage.getItem(PENDING_LINK_STORAGE_KEY);
  } catch {
    return { kind: "unavailable" };
  }
  if (pendingRaw === null) return activeRaw === null ? { kind: "none" } : { kind: "inactive" };

  let pendingValue: unknown;
  try {
    pendingValue = JSON.parse(pendingRaw);
  } catch {
    return { kind: "invalid", fingerprint: `pending:${pendingRaw}` };
  }
  if (!pendingValue || typeof pendingValue !== "object" || Array.isArray(pendingValue)) {
    return { kind: "invalid", fingerprint: `pending:${pendingRaw}` };
  }
  const pending = pendingValue as Record<string, unknown>;
  if (pending.kind === "trust" || pending.kind === "revoke") {
    return activeRaw === null ? { kind: "none" } : { kind: "inactive" };
  }
  const expectedTx = pending.expectedTx;
  if (
    pending.version !== 1 || pending.kind !== "delegate" ||
    typeof pending.hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(pending.hash) ||
    typeof pending.account !== "string" || !CLASSIC_ADDRESS.test(pending.account) ||
    (pending.network !== "testnet" && pending.network !== "devnet") ||
    typeof pending.expectedDelegate !== "string" ||
    !CLASSIC_ADDRESS.test(pending.expectedDelegate) ||
    !Number.isSafeInteger(pending.lastLedgerSequence) || Number(pending.lastLedgerSequence) < 1 ||
    !expectedTx || typeof expectedTx !== "object" || Array.isArray(expectedTx) ||
    (expectedTx as Record<string, unknown>).TransactionType !== "DelegateSet" ||
    (expectedTx as Record<string, unknown>).Account !== pending.account ||
    (expectedTx as Record<string, unknown>).Authorize !== pending.expectedDelegate ||
    (expectedTx as Record<string, unknown>).LastLedgerSequence !== pending.lastLedgerSequence
  ) {
    return { kind: "invalid", fingerprint: `pending:${pendingRaw}` };
  }
  return {
    kind: "pending-delegate",
    fingerprint: `pending:${pendingRaw}`,
    record: {
      version: 1,
      kind: "delegate",
      hash: pending.hash.toUpperCase(),
      account: pending.account,
      network: pending.network,
      expectedDelegate: pending.expectedDelegate,
    },
  };
}

/** Verify an active-link hint against the sealed wallet session and Harbor. */
export async function verifyActiveLinkLifecycle(
  read: ActiveLinkRead,
  dependencies: LifecycleDependencies,
  durable: DevLifecycleRead = { kind: "none" },
): Promise<LifecycleVerification> {
  const recoveryRequired =
    durable.kind === "owner-present" ||
    durable.kind === "invalid" ||
    durable.kind === "unavailable";
  const fingerprint = lifecycleFingerprint(read, durable);
  const guarded = (kind: LifecycleVerification["kind"]): LifecycleVerification => ({
    ...(fingerprint === undefined ? {} : { fingerprint }),
    kind,
    ...(recoveryRequired ? { recoveryRequired: true } : {}),
    warn: true,
  });

  if (durable.kind === "invalid" || durable.kind === "unavailable") {
    return guarded("unverified");
  }
  if (read.kind === "none" || read.kind === "inactive") {
    if (durable.kind === "owner-present") return guarded("recovery");
    return { kind: "none", warn: false };
  }
  if (read.kind === "invalid" || read.kind === "unavailable") {
    return guarded("unverified");
  }

  if (
    read.kind === "active" &&
    (durable.kind === "owner-present" || durable.kind === "revoked") &&
    !durable.markers.some((marker) =>
      marker.account === read.record.account && marker.network === read.record.network)
  ) {
    return guarded("unverified");
  }

  try {
    const session = await dependencies.loadSession();
    if (
      !session.authenticated ||
      session.account !== read.record.account ||
      session.network !== read.record.network
    ) {
      return guarded("unverified");
    }

    const response = await dependencies.readStatus(session.account, session.network);
    if (!response.ok) return guarded("unverified");
    const link = response.data;
    if (
      link.owner !== session.account ||
      link.network !== session.network ||
      !CLASSIC_ADDRESS.test(link.delegate)
    ) {
      return guarded("unverified");
    }
    if (read.kind === "pending-delegate") {
      if (
        link.owner !== read.record.account ||
        link.network !== read.record.network ||
        link.delegate !== read.record.expectedDelegate
      ) {
        return guarded("unverified");
      }
      if (link.status === "active" && exactPermissions(link.permissions)) {
        return guarded("active");
      }
      return guarded(link.status === "pending" ? "pending" : "unverified");
    }
    if (link.status === "revoked") {
      if (
        read.record.delegate === undefined ||
        link.delegate !== read.record.delegate ||
        link.permissions.length !== 0
      ) {
        return guarded("unverified");
      }
      if (durable.kind === "owner-present") return guarded("unverified");
      return {
        ...(fingerprint === undefined ? {} : { fingerprint }),
        kind: "inactive",
        warn: false,
      };
    }
    if (
      link.status !== "active" ||
      !exactPermissions(link.permissions) ||
      (read.record.delegate !== undefined && link.delegate !== read.record.delegate) ||
      (read.record.permissions !== undefined &&
        !exactPermissions(read.record.permissions))
    ) {
      return guarded("unverified");
    }
    return guarded("active");
  } catch {
    return guarded("unverified");
  }
}

export function shouldWarnBeforeUnload(
  read: ActiveLinkRead,
  verification: LifecycleVerification,
  durable: DevLifecycleRead = { kind: "none" },
): boolean {
  if (
    durable.kind === "owner-present" ||
    durable.kind === "invalid" ||
    durable.kind === "unavailable"
  ) return true;
  if (read.kind === "none" || read.kind === "inactive") return false;
  if (read.kind === "unavailable") return verification.warn;
  if (read.kind === "invalid") return true;
  if (read.kind === "pending-delegate") return true;
  return !(
    verification.kind === "inactive" &&
    verification.fingerprint === lifecycleFingerprint(read, durable)
  );
}

function lifecycleFingerprint(
  read: ActiveLinkRead,
  durable: DevLifecycleRead,
): string | undefined {
  const readFingerprint = "fingerprint" in read ? read.fingerprint : undefined;
  const durableFingerprint = "fingerprint" in durable ? durable.fingerprint : undefined;
  if (readFingerprint === undefined) return durableFingerprint;
  if (durableFingerprint === undefined) return readFingerprint;
  return `${readFingerprint}|${durableFingerprint}`;
}

type BrowserLifecycleRead = {
  active: ActiveLinkRead;
  durable: DevLifecycleRead;
};

function readBrowserLifecycle(): BrowserLifecycleRead {
  try {
    return {
      active: readActiveLinkRecord(globalThis.sessionStorage),
      durable: readDevLifecycleMarkers(globalThis.localStorage),
    };
  } catch {
    return {
      active: { kind: "unavailable" },
      durable: { kind: "unavailable" },
    };
  }
}

export function isLifecycleStorageKey(key: string | null): boolean {
  return key === null ||
    key === ACTIVE_LINK_STORAGE_KEY ||
    key === PENDING_LINK_STORAGE_KEY ||
    key === DEV_LIFECYCLE_STORAGE_KEYS.testnet ||
    key === DEV_LIFECYCLE_STORAGE_KEYS.devnet;
}

const INITIAL_VERIFICATION: LifecycleVerification = {
  kind: "checking",
  warn: false,
};

export function DelegationLifecycleGuard() {
  const pathname = usePathname();
  const [verification, setVerification] = useState(INITIAL_VERIFICATION);
  const verificationRef = useRef(verification);

  useEffect(() => {
    verificationRef.current = verification;
  }, [verification]);

  useEffect(() => {
    let active = true;
    let generation = 0;
    const harbor = createBrowserHarborClient();
    const dependencies: LifecycleDependencies = {
      loadSession: () => loadWalletSessionStatus(),
      readStatus: (owner, network) => harbor.op("account.status", { owner, network }),
    };

    const refresh = () => {
      const read = readBrowserLifecycle();
      const currentGeneration = ++generation;
      if (
        read.active.kind === "active" ||
        read.active.kind === "pending-delegate" ||
        read.durable.kind === "owner-present" ||
        read.durable.kind === "invalid" ||
        read.durable.kind === "unavailable"
      ) {
        const checking: LifecycleVerification = {
          ...(lifecycleFingerprint(read.active, read.durable) === undefined
            ? {}
            : { fingerprint: lifecycleFingerprint(read.active, read.durable) }),
          kind: "checking",
          ...(read.durable.kind === "owner-present" ||
            read.durable.kind === "invalid" ||
            read.durable.kind === "unavailable"
            ? { recoveryRequired: true }
            : {}),
          warn: true,
        };
        verificationRef.current = checking;
        setVerification(checking);
      }
      void verifyActiveLinkLifecycle(read.active, dependencies, read.durable).then((next) => {
        if (!active || currentGeneration !== generation) return;
        verificationRef.current = next;
        setVerification(next);
      });
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const read = readBrowserLifecycle();
      if (!shouldWarnBeforeUnload(
        read.active,
        verificationRef.current,
        read.durable,
      )) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onStorage = (event: StorageEvent) => {
      if (isLifecycleStorageKey(event.key)) refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", onStorage);
    window.addEventListener(WALLET_SESSION_CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      generation += 1;
      window.clearInterval(interval);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(WALLET_SESSION_CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Onboarding already renders the exact owner-scoped recovery and revoke
  // controls. Keep the unload guard active there, but do not cover those
  // controls with a second fixed-position link back to the same page.
  if (!verification.warn || pathname === "/onboarding") return null;
  const verified = verification.kind === "active";
  const pending = verification.kind === "pending";
  const recovery = verification.recoveryRequired === true;
  return (
    <aside
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-2xl items-start gap-3 rounded-2xl border border-amber-400/30 bg-card/95 p-4 shadow-2xl backdrop-blur"
      role="status"
    >
      {verified
        ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-amber-400" />
        : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {verified
            ? "Active Harbor delegation"
            : recovery
              ? "Browser wallet recovery required"
            : pending
              ? "DelegateSet validation is still pending"
              : "Delegation cleanup not verified"}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {recovery
            ? "The original tab and its original key are required to revoke this delegation. Pilot will not create a replacement wallet."
            : pending
            ? "Keep this browser wallet available until the delegation reaches a proven terminal state."
            : "Use the exact owner wallet to revoke this on-ledger delegation when you no longer want Harbor to submit."}
        </p>
      </div>
      <Link
        className="shrink-0 rounded-xl border border-amber-400/30 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-400/10"
        href="/onboarding"
      >
        {pending ? "Resume safely" : recovery ? "Recover safely" : "Revoke safely"}
      </Link>
    </aside>
  );
}
