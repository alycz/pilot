"use client";

import { createMockHarborClient } from "@pilot/harbor-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePublishHarnessPageSummary } from "@/components/harness-chat/page-context-provider";

import { toWorkspaceSnapshot } from "./analytics-adapter";
import { appendHistoryPoint } from "./analytics-model";
import {
  fetchMarketAnalytics,
  normalizeAnalyticsEnvelope,
  type AnalyticsRequest,
} from "./analytics-source";
import type { AnalyticsPanelState, AnalyticsPricePoint, PairAnalyticsSnapshot } from "./analytics-types";
import {
  AnalyticsWorkspace,
  type AnalyticsTerminalPanel,
} from "./analytics-workspace";

const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const RLUSD_ISSUER = {
  testnet: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  mainnet: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
} as const;
const SAMPLE_BASE_AMOUNTS = ["10", "100", "1000"];
const LIVE_REFRESH_MS = 25_000;
const HISTORY_GAP_MS = 60_000;

type ViewMode = "live" | "demo";
type ViewNetwork = keyof typeof RLUSD_ISSUER;
type HarnessMarketFreshness = "loading" | "live" | "partial" | "stale" | "demo" | "empty" | "error";

export function marketHarnessFreshness(
  mode: ViewMode,
  state: AnalyticsPanelState<PairAnalyticsSnapshot>,
): HarnessMarketFreshness {
  if (mode === "demo") return "demo";
  if (state.status === "loading" || state.status === "empty" || state.status === "error") return state.status;
  if (state.data.meta.freshness.state === "stale") return "stale";
  if (state.status === "partial" || state.data.meta.freshness.state === "unknown") return "partial";
  return "live";
}

function requestFor(network: ViewNetwork): AnalyticsRequest {
  return {
    network,
    pair: {
      base: { currency: "XRP" },
      quote: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER[network] },
    },
    depthLimit: 50,
    sampleBaseAmounts: SAMPLE_BASE_AMOUNTS,
  };
}

function withSessionHistory(
  state: AnalyticsPanelState<PairAnalyticsSnapshot>,
  retained: AnalyticsPricePoint[],
): AnalyticsPanelState<PairAnalyticsSnapshot> {
  if (state.status !== "ready" && state.status !== "partial") return state;
  const rawCurrent = state.data.history[0] ?? (
    state.data.metrics.mid && state.data.meta.observedAt
      ? { observedAt: state.data.meta.observedAt, ledgerIndex: state.data.meta.ledgerIndex, price: state.data.metrics.mid }
      : undefined
  );
  const previous = retained.at(-1);
  const current = rawCurrent
    ? {
        ...rawCurrent,
        ...(previous && Date.parse(rawCurrent.observedAt) - Date.parse(previous.observedAt) > HISTORY_GAP_MS
          ? { gapBefore: true }
          : {}),
      }
    : undefined;
  const history = current ? appendHistoryPoint(retained, current, 250) : retained;
  const coverage = {
    startedAt: history[0]?.observedAt ?? state.data.meta.observedAt ?? state.data.meta.receivedAt,
    endedAt: history.at(-1)?.observedAt ?? state.data.meta.observedAt,
    sampleCount: history.length,
    maxSamples: 250,
    intervalHintMs: null,
    complete: false,
    reason: "Bounded observations retained only for this browser session; no candles or missing intervals are inferred.",
  };
  return {
    ...state,
    data: {
      ...state.data,
      history,
      meta: { ...state.data.meta, mode: history.length > 1 ? "sampled-live" : state.data.meta.mode, coverage },
    },
  };
}

export function AnalyticsView() {
  const [network, setNetwork] = useState<ViewNetwork>("testnet");
  const [mode, setMode] = useState<ViewMode>("live");
  const [query, setQuery] = useState("");
  const [activePanel, setActivePanel] = useState<AnalyticsTerminalPanel>("overview");
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<AnalyticsPanelState<PairAnalyticsSnapshot>>({ status: "loading" });
  const historyRef = useRef(new Map<ViewNetwork, AnalyticsPricePoint[]>());
  const request = useMemo(() => requestFor(network), [network]);

  useEffect(() => {
    if (mode !== "live") return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") setRefreshKey((value) => value + 1);
    };
    const timer = window.setInterval(refreshVisible, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [mode, network]);

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    setState({ status: "loading" });
    const load = async () => {
      if (mode === "demo") {
        const fixture = await createMockHarborClient().op("analytics.marketSnapshot", {
          network: "testnet",
          pair: requestFor("testnet").pair,
          depth_limit: 50,
          sample_base_amounts: SAMPLE_BASE_AMOUNTS,
        });
        return normalizeAnalyticsEnvelope(fixture, requestFor("testnet"), { mode: "demo-fixture" });
      }
      return fetchMarketAnalytics(request, { signal: controller.signal, mode: "live" });
    };
    void load().then((next) => {
      if (controller.signal.aborted) return;
      if (mode === "live") {
        const history = historyRef.current.get(network) ?? [];
        const sampled = withSessionHistory(next, history);
        if (sampled.status === "ready" || sampled.status === "partial") {
          historyRef.current.set(network, sampled.data.history);
        }
        setState(sampled);
      } else {
        setState(next);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setState({ status: "error", message: "Harbor analytics is temporarily unavailable.", retryable: true, receivedAt: new Date().toISOString() });
      }
    }).finally(() => {
      if (!controller.signal.aborted) setRefreshing(false);
    });
    return () => controller.abort();
  }, [mode, network, refreshKey, request]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const workspace = state.status === "ready" || state.status === "partial" ? toWorkspaceSnapshot(state) : null;
  const workspaceState = state.status === "loading" ? "loading" : state.status === "error" ? "error" : state.status === "empty" ? "empty" : "ready";
  usePublishHarnessPageSummary({
    network: mode === "demo" ? "testnet" : network,
    pair: workspace?.label ?? "XRP / RLUSD",
    base_asset: workspace?.base.symbol ?? "XRP",
    quote_asset: workspace?.quote.symbol ?? "RLUSD",
    panel: activePanel,
    freshness: marketHarnessFreshness(mode, state),
  });

  return (
    <div className="min-w-0">
      <div className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Analytics data source">
            {(["testnet", "mainnet"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === "live" && network === option}
                onClick={() => { setMode("live"); setNetwork(option); }}
                className={`h-9 border px-3 text-xs rounded-md ${mode === "live" && network === option ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {option === "testnet" ? "Testnet live" : "Mainnet read-only"}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={mode === "demo"}
              onClick={() => { setMode("demo"); setNetwork("testnet"); }}
              className={`h-9 border px-3 text-xs rounded-md ${mode === "demo" ? "border-approval bg-approval/[0.07] text-approval" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              Illustrative demo
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === "demo" ? "Fixture values · never live" : `${network} · validated read only · no signing authority`}
          </p>
        </div>
      </div>
      <AnalyticsWorkspace
        state={workspaceState}
        snapshots={workspace ? [workspace] : []}
        error={state.status === "error" ? state.message : state.status === "empty" ? state.message : undefined}
        query={query}
        activePanel={activePanel}
        refreshing={refreshing}
        onQueryChange={setQuery}
        onActivePanelChange={setActivePanel}
        onRefresh={refresh}
      />
    </div>
  );
}
