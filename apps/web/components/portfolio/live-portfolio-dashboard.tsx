"use client";

import {
  createBrowserHarborClient,
  loadPublicPilotConfig,
  loadWalletSessionStatus,
  WALLET_SESSION_CHANGED_EVENT,
  type PublicPilotConfig,
  type WalletSessionStatus,
} from "@/lib/harbor-browser";
import { Client } from "xrpl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PortfolioDashboard } from "./portfolio-dashboard";
import {
  demoQuickNodeStatus,
  fetchLivePortfolioSnapshot,
  fetchQuickNodeStatus,
  loadPortfolioSnapshot,
  type BrowserHarborClient,
  type PortfolioSnapshot,
  type QuickNodeStatus,
} from "./portfolio-data";
import {
  createValidatedRefreshCoordinator,
  hasDistinctMainAndBudget,
  portfolioPresentation,
  portfolioRefreshFailure,
  PORTFOLIO_IDENTITY_REVALIDATION_MS,
  PORTFOLIO_REFRESH_DEADLINE_MS,
  resolvePortfolioAccess,
  subscribeToPortfolioTransactions,
  subscriptionAccounts,
  walletSessionExpiryDelay,
  websocketUrlForNetwork,
  type PortfolioConnectionStatus,
  type PortfolioWebSocketClient,
} from "./live-state";

function connectedStatus(hasTwoAccounts: boolean): PortfolioConnectionStatus {
  return hasTwoAccounts
    ? {
        kind: "live",
        detail: "Subscribed to distinct main and budget accounts. Validated transactions refresh Harbor reads.",
        accountCount: 2,
      }
    : {
        kind: "degraded",
        detail: "The authenticated owner account is live. No distinct main account is available in the verified session.",
        accountCount: 1,
      };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Live portfolio refresh failed";
}

export function LivePortfolioDashboard() {
  const harbor = useMemo(
    () => createBrowserHarborClient() as unknown as BrowserHarborClient,
    [],
  );
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot>();
  const [quickNodeStatus, setQuickNodeStatus] = useState<QuickNodeStatus | null>();
  const [config, setConfig] = useState<PublicPilotConfig | null>();
  const [session, setSession] = useState<WalletSessionStatus | null>();
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<PortfolioConnectionStatus>({
    kind: "connecting",
    detail: "Checking Pilot's public configuration.",
    accountCount: 0,
  });

  const invalidateIdentity = useCallback(() => {
    setSnapshot(undefined);
    setQuickNodeStatus(undefined);
    setConfig(undefined);
    setSession(undefined);
    setConnection({
      kind: "connecting",
      detail: "Revalidating the authenticated wallet session.",
      accountCount: 0,
    });
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") invalidateIdentity();
    };
    const refreshWhenWalletMetadataChanges = (event: StorageEvent) => {
      if (event.storageArea === globalThis.sessionStorage && (event.key === "pilot:wallet" || event.key === null)) {
        invalidateIdentity();
      }
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") invalidateIdentity();
    }, PORTFOLIO_IDENTITY_REVALIDATION_MS);
    window.addEventListener("focus", invalidateIdentity);
    window.addEventListener("storage", refreshWhenWalletMetadataChanges);
    window.addEventListener(WALLET_SESSION_CHANGED_EVENT, invalidateIdentity);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", invalidateIdentity);
      window.removeEventListener("storage", refreshWhenWalletMetadataChanges);
      window.removeEventListener(WALLET_SESSION_CHANGED_EVENT, invalidateIdentity);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [invalidateIdentity]);

  useEffect(() => {
    const delay = walletSessionExpiryDelay(session);
    if (delay === undefined) return;
    const timeout = window.setTimeout(invalidateIdentity, delay);
    return () => window.clearTimeout(timeout);
  }, [invalidateIdentity, session]);

  useEffect(() => {
    const controller = new AbortController();
    setConfig(undefined);
    setSession(undefined);
    setSnapshot(undefined);
    setQuickNodeStatus(undefined);
    setConnection({
      kind: "connecting",
      detail: "Checking Pilot's public configuration and authenticated wallet session.",
      accountCount: 0,
    });

    void loadPublicPilotConfig(globalThis.fetch, controller.signal).then(
      setConfig,
      () => {
        if (!controller.signal.aborted) setConfig(null);
      },
    );
    void loadWalletSessionStatus(globalThis.fetch, controller.signal).then(
      setSession,
      () => {
        if (!controller.signal.aborted) setSession(null);
      },
    );
    return () => controller.abort();
  }, [revision]);

  const access = useMemo(
    () => resolvePortfolioAccess(config, session),
    [config, session],
  );

  useEffect(() => {
    let cancelled = false;
    let cleanupSubscription: (() => Promise<void>) | undefined;
    let disposeCoordinator: (() => void) | undefined;

    const presentation = portfolioPresentation(access);
    if (presentation.kind === "loading") {
      setConnection({ kind: "connecting", detail: presentation.detail, accountCount: 0 });
      return () => { cancelled = true; };
    }
    if (presentation.kind === "demo" || access.kind !== "live") {
      const detail = presentation.kind === "demo" ? presentation.detail : "Simulated demo portfolio.";
      setSnapshot(undefined);
      setConnection({ kind: "connecting", detail: "Loading the demo portfolio.", accountCount: 0 });
      void loadPortfolioSnapshot().then(
        (next) => {
          if (cancelled) return;
          setSnapshot(next);
          setQuickNodeStatus(demoQuickNodeStatus);
          setConnection({ kind: "demo", detail, accountCount: 0 });
        },
        (error) => {
          if (cancelled) return;
          setSnapshot(undefined);
          setQuickNodeStatus(null);
          setConnection({
            kind: "error",
            detail: `Demo data is unavailable: ${errorMessage(error)}`,
            accountCount: 0,
          });
        },
      );
      return () => { cancelled = true; };
    }

    const context = access.context;
    const accounts = subscriptionAccounts(context);
    const readyStatus = connectedStatus(hasDistinctMainAndBudget(context));
    let hasSnapshot = false;
    let refreshGeneration = 0;
    setSnapshot(undefined);
    setConnection({
      kind: "connecting",
      detail: `Connecting to XRPL ${context.network.replace("-", " ")} for the authenticated owner.`,
      accountCount: accounts.length,
    });

    const refresh = async () => {
      const generation = ++refreshGeneration;
      const startedAt = Date.now();
      const [next, nextQuickNodeStatus] = await Promise.all([
        fetchLivePortfolioSnapshot(harbor, context),
        fetchQuickNodeStatus(harbor).catch(() => null),
      ]);
      if (cancelled || generation !== refreshGeneration) return;
      if (Date.now() - startedAt >= PORTFOLIO_REFRESH_DEADLINE_MS) {
        throw new Error("Harbor returned after the five-second live-update deadline");
      }
      hasSnapshot = true;
      setSnapshot(next);
      setQuickNodeStatus(nextQuickNodeStatus);
      setConnection(readyStatus);
    };

    const start = async () => {
      const coordinator = createValidatedRefreshCoordinator({
        refresh: async () => refresh(),
        onError: (error) => {
          if (cancelled) return;
          setConnection(portfolioRefreshFailure(
            hasSnapshot,
            errorMessage(error),
            accounts.length,
          ));
        },
      });
      disposeCoordinator = coordinator.dispose;
      const websocket = new Client(
        websocketUrlForNetwork(context.network),
      ) as unknown as PortfolioWebSocketClient;
      cleanupSubscription = await subscribeToPortfolioTransactions({
        client: websocket,
        accounts,
        onTransaction: coordinator.handle,
      });
      if (cancelled) {
        await cleanupSubscription();
        return;
      }
      try {
        await refresh();
      } catch (error) {
        if (cancelled) return;
        setSnapshot(undefined);
        setConnection({
          kind: "error",
          detail: `XRPL subscription is connected, but owner-scoped Harbor data is unavailable: ${errorMessage(error)}`,
          accountCount: accounts.length,
        });
      }
    };

    void start().catch((error) => {
      if (cancelled) return;
      setSnapshot(undefined);
      setConnection({
        kind: "error",
        detail: `Live XRPL subscription failed: ${errorMessage(error)}`,
        accountCount: accounts.length,
      });
    });

    return () => {
      cancelled = true;
      disposeCoordinator?.();
      if (cleanupSubscription) void cleanupSubscription();
    };
  }, [access, harbor]);

  return (
    <PortfolioDashboard
      connection={connection}
      quickNodeStatus={quickNodeStatus}
      snapshot={snapshot}
    />
  );
}
