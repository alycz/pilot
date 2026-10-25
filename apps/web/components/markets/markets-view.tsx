"use client";

import { DEFAULT_POLICY } from "@pilot/contracts";
import {
  AlertTriangle,
  ArrowDownRight,
  MessageCircle,
  ArrowUpRight,
  Droplets,
  CandlestickChart,
  Landmark,
  Network as NetworkIcon,
  RefreshCw,
  Route,
  Terminal,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { loadWalletSessionStatus } from "@/lib/harbor-browser";
import { usePublishHarnessPageSummary } from "@/components/harness-chat/page-context-provider";

import { DepthChart, PoolComposition, RouteBars } from "./charts";
import {
  endpointHost,
  isRetryableLedgerReadError,
  LEDGER_ENDPOINTS,
  LedgerClient,
  LedgerRequestError,
  ledgerRetryAfterMs,
  type LedgerCommand,
  type LedgerNetwork,
  type LedgerStatus,
} from "./ledger-client";
import {
  describeRequest,
  issuerFromAccountInfo,
  pairSnapshot,
  quoteRoutes,
  serverInfoSummary,
  type IssuerInfo,
  type LedgerServerInfo,
  type PairSnapshot,
} from "./ledger-markets";
import { SelectMenu } from "../ui/select-menu";

import { demoMarketSnapshots, DEMO_MARKET_NETWORK } from "./markets-demo";
import { MarketIndexTable } from "./market-index-table";
import {
  filterAndSortMarkets,
  ledgerMarketRows,
  type MarketRow,
  type MarketSort,
  type MarketSortKey,
  type MarketType,
  type QuotedMarketRow,
} from "./market-index";
import {
  issuedAssets,
  ledgerAsset,
  MARKET_CATALOG,
  NETWORK_LABELS,
  RLUSD_CURRENCY,
  type CatalogAsset,
  type CatalogPair,
} from "./markets-catalog";
import {
  ammSummary,
  bookSummary,
  deviationBps,
  depthSide,
  formatAmount,
  formatBps,
  formatCompact,
  formatPrice,
  marketPair,
  type DepthLevel,
} from "./markets-data";
import { FIXTURE_AS_OF, FIXTURE_LEDGER_INDEX } from "./markets-fixtures";
import { marketParam, policyStrip, type PolicyStrip } from "./policy-strip";
import { handleRadioKeys } from "./radio-keys";

type PairState = {
  status: "loading" | "ready" | "error";
  snapshot: PairSnapshot | null;
  error?: string;
  ammError?: string;
  retryAt?: number;
  updatedAt?: number;
  lastFetch?: number;
};

type IssuerState = { status: "loading" | "ready" | "error"; info?: IssuerInfo; error?: string };

type LedgerCall = {
  id: number;
  command: string;
  request: string;
  host: string;
  status: "pending" | "ok" | "error";
  ms?: number;
  ledger?: number;
  code?: string;
};

const MAX_CALLS = 40;
const FULL_DEPTH = 50;
const LIGHT_DEPTH = 20;
const SELECTED_MIN_INTERVAL_MS = 15_000;
const OTHERS_EVERY_N_LEDGERS = 5;
const LADDER_ROWS = 6;
const NETWORKS: LedgerNetwork[] = ["mainnet", "testnet"];

const chip = "inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-xs font-medium rounded capitalize";
const tone = {
  neutral: "border-border text-muted-foreground",
  executed: "border-executed/30 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
  approval: "border-approval/30 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
};
const bandInner = "mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8";
/** One grid for the market page's policy and metric strips so all twelve cells line up and match in size. */
const statGrid = "grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6";
const statCell = "flex min-h-[4.5rem] min-w-0 flex-col justify-center gap-1.5 bg-card px-4 py-3 sm:px-5";
const statLabel = "label-mono truncate";
const statValue = "flex h-5 min-w-0 items-center gap-2 font-mono text-[13px] tabular-nums text-foreground";
const secondaryButton = "bracket bracket-light inline-flex h-9 pointer-coarse:h-11 items-center gap-2 border border-border bg-white/[0.03] px-3 text-[13px] text-foreground transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45 rounded-md";

function assetLabel(asset: unknown, pairs: readonly CatalogPair[]): string {
  const value = asset as { currency?: string; issuer?: string } | undefined;
  if (!value?.currency || value.currency === "XRP") return "XRP";
  for (const pair of pairs) {
    for (const side of [pair.base, pair.quote]) {
      if (side.asset.currency === value.currency && side.asset.issuer === value.issuer) return side.symbol;
    }
  }
  return value.currency.slice(0, 6);
}

function marketReadKey(pair: CatalogPair): string {
  const assetKey = (entry: CatalogAsset) => `${entry.asset.currency}:${entry.asset.issuer ?? "native"}`;
  return `${pair.network}|${assetKey(pair.base)}>${assetKey(pair.quote)}`;
}

/** Market page address for a row key (`network:pair:route`). */
export function marketHref(key: string): string {
  const [network, pair, route] = key.split(":");
  return `/markets/${pair}?network=${network}${route && route !== "order-book" ? `&route=${route}` : ""}`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function marketReadError(cause: unknown): string {
  if (isRetryableLedgerReadError(cause)) {
    const retryMs = ledgerRetryAfterMs(cause);
    if (retryMs) {
      const minutes = Math.max(1, Math.ceil(retryMs / 60_000));
      return `Public XRP Ledger nodes are temporarily rate-limited. Retry in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    }
    return "Public XRP Ledger nodes are temporarily rate-limited. Pilot will retry automatically.";
  }
  return cause instanceof Error ? cause.message : "The public XRP Ledger nodes could not return this market.";
}

function lastRealDataLabel(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  const age = seconds < 60
    ? `${seconds} second${seconds === 1 ? "" : "s"} ago`
    : `${Math.floor(seconds / 60)} minute${Math.floor(seconds / 60) === 1 ? "" : "s"} ago`;
  const utc = new Date(updatedAt).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `Updated ${age} (${utc} UTC)`;
}

/**
 * Without `marketKey`: the market index. With it (`network:pair:route`): that
 * market's own page — best execution, AMM pool, depth, ladder, assets and the
 * ledger inspector.
 */
export function MarketsView({ marketKey }: { marketKey?: string } = {}) {
  const router = useRouter();
  const initialKey = marketParam(marketKey ?? null);
  const initialNetwork = (initialKey?.split(":")[0] as LedgerNetwork | undefined) ?? "mainnet";
  const [network, setNetwork] = useState<LedgerNetwork>(NETWORKS.includes(initialNetwork) ? initialNetwork : "mainnet");
  const [demo, setDemo] = useState(false);
  const pairs = useMemo<readonly CatalogPair[]>(() => (demo ? MARKET_CATALOG[DEMO_MARKET_NETWORK] : MARKET_CATALOG[network]), [demo, network]);
  const [selectedKey, setSelectedKey] = useState<string>(initialKey ?? `${MARKET_CATALOG.mainnet[0]!.id}:order-book`);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [pairStates, setPairStates] = useState<Record<string, PairState>>({});
  const [issuers, setIssuers] = useState<Record<string, IssuerState>>({});
  const [server, setServer] = useState<LedgerServerInfo | null>(null);
  const [connection, setConnection] = useState<{ status: LedgerStatus; endpoint: string | null }>({ status: "idle", endpoint: null });
  const [ledgerIndex, setLedgerIndex] = useState<number | null>(null);
  const [calls, setCalls] = useState<LedgerCall[]>([]);
  const [marketType, setMarketType] = useState<MarketType | "all">("all");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketSort, setMarketSort] = useState<MarketSort>({ key: "default", direction: "asc" });
  const openKey = initialKey;
  const [walletSignedIn, setWalletSignedIn] = useState<boolean | null>(null);

  const clientRef = useRef<LedgerClient | null>(null);
  const inFlight = useRef(new Set<string>());
  const lastFetch = useRef(new Map<string, number>());
  const ledgerCount = useRef(0);
  const callId = useRef(0);
  const hiddenRef = useRef(false);
  const handleLedgerRef = useRef<(index: number) => void>(() => undefined);
  const serverLoaded = useRef(false);

  const selectedPairId = selectedKey.slice(0, selectedKey.lastIndexOf(":"));
  const selectedRoute = selectedKey.slice(selectedKey.lastIndexOf(":") + 1) as QuotedMarketRow["route"];
  const selectedPair = pairs.find((pair) => pair.id === selectedPairId) ?? pairs[0]!;
  const pairStatesRef = useRef(pairStates);
  pairStatesRef.current = pairStates;
  const selectedPairRef = useRef(selectedPair);
  selectedPairRef.current = selectedPair;
  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;

  // Read-only session check: logged-out visitors see the demo policy in market pop-ups.
  useEffect(() => {
    const controller = new AbortController();
    void loadWalletSessionStatus(undefined, controller.signal)
      .then((status) => setWalletSignedIn(status.authenticated))
      .catch(() => {
        if (!controller.signal.aborted) setWalletSignedIn(false);
      });
    return () => controller.abort();
  }, []);

  // Old `?market=` links open the market's own page.
  useEffect(() => {
    if (initialKey) return;
    const legacy = marketParam(new URLSearchParams(window.location.search).get("market"));
    if (legacy) router.replace(marketHref(legacy));
  }, [initialKey, router]);

  const read = useCallback(async (command: LedgerCommand, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const client = clientRef.current;
    if (!client) throw new LedgerRequestError("Not connected.", "notConnected");
    const id = ++callId.current;
    const request = describeRequest(command, params, (asset) => assetLabel(asset, pairsRef.current));
    setCalls((list) => [...list, { id, command, request, host: endpointHost(client.endpoint), status: "pending" as const }].slice(-MAX_CALLS));
    try {
      const response = await client.request(command, params);
      const ledgerValue = response.result.ledger_index ?? response.result.ledger_current_index;
      setCalls((list) =>
        list.map((call) =>
          call.id === id
            ? { ...call, status: "ok", ms: response.ms, host: endpointHost(response.endpoint), ...(typeof ledgerValue === "number" ? { ledger: ledgerValue } : {}) }
            : call,
        ),
      );
      return response.result;
    } catch (cause) {
      const code = cause instanceof LedgerRequestError ? cause.code : "error";
      setCalls((list) => list.map((call) => (call.id === id ? { ...call, status: "error", code } : call)));
      throw cause;
    }
  }, []);

  const fetchPair = useCallback(
    async (pair: CatalogPair, full: boolean, force = false) => {
      const key = marketReadKey(pair);
      if (inFlight.current.has(key)) return;
      const retryAt = pairStatesRef.current[key]?.retryAt ?? 0;
      if (!force && retryAt > Date.now()) return;
      inFlight.current.add(key);
      lastFetch.current.set(key, Date.now());
      setPairStates((current) => (current[key] ? current : { ...current, [key]: { status: "loading", snapshot: null } }));
      const limit = full ? FULL_DEPTH : LIGHT_DEPTH;
      const base = ledgerAsset(pair.base.asset);
      const quote = ledgerAsset(pair.quote.asset);
      try {
        const [asks, bids, amm] = await Promise.allSettled([
          read("book_offers", { taker_gets: base, taker_pays: quote, limit, ledger_index: "validated" }),
          read("book_offers", { taker_gets: quote, taker_pays: base, limit, ledger_index: "validated" }),
          read("amm_info", { asset: base, asset2: quote, ledger_index: "validated" }),
        ]);
        const bookFailure = asks.status === "rejected" ? asks.reason : bids.status === "rejected" ? bids.reason : null;
        if (bookFailure) {
          const retryMs = ledgerRetryAfterMs(bookFailure);
          setPairStates((current) => ({
            ...current,
            [key]: {
              ...(current[key] ?? {}),
              status: current[key]?.snapshot ? "ready" : "error",
              snapshot: current[key]?.snapshot ?? null,
              error: marketReadError(bookFailure),
              ...(retryMs ? { retryAt: Date.now() + retryMs } : {}),
            },
          }));
          return;
        }
        const resultLedger = (value: PromiseSettledResult<Record<string, unknown>>) =>
          value.status === "fulfilled" && typeof value.value.ledger_index === "number" ? value.value.ledger_index : null;
        const snapshot = pairSnapshot({
          askOffers: asks.status === "fulfilled" ? asks.value.offers : [],
          bidOffers: bids.status === "fulfilled" ? bids.value.offers : [],
          ammResult: amm.status === "fulfilled" ? amm.value : null,
          base: pair.base.asset,
          quote: pair.quote.asset,
          ledgerIndex: resultLedger(asks) ?? resultLedger(bids),
        });
        setPairStates((current) => ({
          ...current,
          [key]: {
            status: "ready",
            snapshot,
            updatedAt: Date.now(),
            ...(amm.status === "rejected" ? { ammError: marketReadError(amm.reason) } : {}),
          },
        }));
      } finally {
        inFlight.current.delete(key);
      }
    },
    [read],
  );

  const loadIssuer = useCallback(
    async (entry: CatalogAsset) => {
      const account = entry.asset.issuer;
      if (!account) return;
      setIssuers((current) => ({ ...current, [account]: { status: "loading" } }));
      try {
        const [info, balances] = await Promise.allSettled([
          read("account_info", { account, ledger_index: "validated" }),
          read("gateway_balances", { account, ledger_index: "validated", strict: true }),
        ]);
        if (info.status === "rejected") throw info.reason;
        const parsed = issuerFromAccountInfo(info.value, balances.status === "fulfilled" ? balances.value : null, entry.asset.currency, entry.symbol);
        setIssuers((current) => ({ ...current, [account]: parsed ? { status: "ready", info: parsed } : { status: "error", error: "Issuer account not found." } }));
      } catch (cause) {
        setIssuers((current) => ({ ...current, [account]: { status: "error", error: cause instanceof Error ? cause.message : "Issuer could not be read." } }));
      }
    },
    [read],
  );

  const refreshAll = useCallback(() => {
    const selected = selectedPairRef.current;
    if (openKey) {
      void fetchPair(selected, true);
      return;
    }
    for (const pair of pairsRef.current) void fetchPair(pair, pair.id === selected.id);
  }, [fetchPair, openKey]);

  handleLedgerRef.current = (index: number) => {
    setLedgerIndex(index);
    if (hiddenRef.current) return;
    ledgerCount.current += 1;
    if (!serverLoaded.current) {
      serverLoaded.current = true;
      void read("server_info", {}).then((result) => setServer(serverInfoSummary(result))).catch(() => {
        serverLoaded.current = false;
      });
    }
    const selected = selectedPairRef.current;
    const last = lastFetch.current.get(marketReadKey(selected)) ?? 0;
    if (Date.now() - last >= SELECTED_MIN_INTERVAL_MS) void fetchPair(selected, true);
    // Detail pages render only the selected market; do not spend public-node
    // quota refreshing catalog rows that are not on screen.
    if (openKey) return;
    const everyN = ledgerCount.current % OTHERS_EVERY_N_LEDGERS === 0;
    for (const pair of pairsRef.current) {
      if (pair.id === selected.id) continue;
      // Pairs that never loaded (e.g. after a failed first connection) refresh right away.
      if (everyN || !pairStatesRef.current[marketReadKey(pair)]?.snapshot) void fetchPair(pair, false);
    }
  };

  /** Connect, subscribe to ledger closes and load every market once. */
  const start = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    // Subscribe on every (re)connection, including recovery after a failed start.
    client.followLedger();
    try {
      await client.connect();
      const [info] = await Promise.allSettled([read("server_info", {})]);
      if (info.status === "fulfilled") {
        serverLoaded.current = true;
        setServer(serverInfoSummary(info.value));
      }
      const index = await client.subscribeLedger().catch(() => null);
      if (index) setLedgerIndex(index);
      refreshAll();
    } catch {
      // Status "failed" is surfaced through onStatus.
    }
  }, [read, refreshAll]);

  // One client per network; torn down on switch, demo or unmount.
  useEffect(() => {
    if (demo) return;
    setPairStates({});
    setIssuers({});
    setServer(null);
    setLedgerIndex(null);
    setCalls([]);
    inFlight.current.clear();
    lastFetch.current.clear();
    ledgerCount.current = 0;
    serverLoaded.current = false;
    const client = new LedgerClient({
      endpoints: LEDGER_ENDPOINTS[network],
      onStatus: (status, endpoint) => setConnection({ status, endpoint }),
      onLedgerClosed: (index) => handleLedgerRef.current(index),
    });
    clientRef.current = client;
    void start();
    return () => {
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [demo, network, start]);

  // Pause reads while the tab is hidden; resume (and refresh) when visible.
  useEffect(() => {
    const onVisibility = () => {
      const client = clientRef.current;
      hiddenRef.current = document.hidden;
      if (!client) return;
      if (document.hidden) client.pause();
      else void start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [start]);

  // Issuer details for the selected pair, once per issuer per connection.
  useEffect(() => {
    if (demo || connection.status !== "open") return;
    for (const entry of issuedAssets(selectedPair)) {
      const account = entry.asset.issuer!;
      if (!issuers[account]) void loadIssuer(entry);
    }
  }, [connection.status, demo, issuers, loadIssuer, selectedPair]);

  // Selecting a market refreshes it at full depth right away.
  useEffect(() => {
    if (demo || connection.status !== "open") return;
    void fetchPair(selectedPair, true);
    // Only on selection change.
  }, [selectedPair.id]);

  const switchNetwork = (next: LedgerNetwork) => {
    if (next === network) return;
    setNetwork(next);
    setSelectedKey(`${MARKET_CATALOG[next][0]!.id}:order-book`);
    setSizeIndex(1);
  };

  const enterDemo = () => {
    const snapshots = demoMarketSnapshots();
    const updatedAt = Date.parse(FIXTURE_AS_OF);
    setDemo(true);
    setPairStates(
      Object.fromEntries(
        MARKET_CATALOG[DEMO_MARKET_NETWORK].map((pair) => [
          marketReadKey(pair),
          { status: "ready" as const, snapshot: snapshots[pair.id] ?? null, updatedAt },
        ]),
      ),
    );
    setSelectedKey((current) => {
      const pairId = current.slice(0, current.lastIndexOf(":"));
      const route = current.slice(current.lastIndexOf(":") + 1);
      const demoPair = MARKET_CATALOG[DEMO_MARKET_NETWORK].find((pair) => pair.id.split(":")[1] === pairId.split(":")[1]) ?? MARKET_CATALOG[DEMO_MARKET_NETWORK][0]!;
      return `${demoPair.id}:${route}`;
    });
    setCalls([]);
    setConnection({ status: "idle", endpoint: null });
  };

  // A demo never shows a dead end: if no public XRPL node answers, switch to
  // the bundled fixture, which remains explicitly labelled as illustrative.
  useEffect(() => {
    if (!demo && connection.status === "failed") enterDemo();
    // enterDemo only sets state, so it is left out of the dependencies.
  }, [connection.status, demo]);

  // ---------- derived view data ----------
  const selectedState = pairStates[marketReadKey(selectedPair)];
  const snapshot = selectedState?.snapshot ?? null;
  const bids: DepthLevel[] = snapshot?.bids ?? [];
  const asks: DepthLevel[] = snapshot?.asks ?? [];
  const book = snapshot?.book ?? bookSummary([], []);
  const amm = snapshot?.amm ?? null;
  const ammDelta = deviationBps(amm?.price ?? null, book.mid);
  const size = selectedPair.sizes[Math.min(sizeIndex, selectedPair.sizes.length - 1)]!;
  const routes = snapshot ? quoteRoutes({ size, bids, amm, mid: book.mid, ammUnavailableReason: selectedState?.ammError }) : null;
  const staleSelected = Boolean(snapshot && selectedState?.error);
  const offline = !demo && !snapshot && (connection.status === "failed" || connection.status === "reconnecting");
  const loadingSelected = !snapshot && !offline && (selectedState?.status ?? "loading") === "loading";
  const base = selectedPair.base.symbol;
  const quote = selectedPair.quote.symbol;

  const quotedRows = ledgerMarketRows(
    pairs.map((pair) => {
      const state = pairStates[marketReadKey(pair)];
      return {
        pair,
        snapshot: state?.snapshot ?? null,
        state: state ? (state.snapshot ? "ready" : state.status) : connection.status === "failed" ? "error" : "loading",
      };
    }),
  );
  // Only markets Pilot actually prices are listed; venues it can't quote yet
  // live on Map instead of showing as empty "—" rows here.
  const allRows: MarketRow[] = quotedRows;
  const visibleRows = filterAndSortMarkets(allRows, { filter: "quoted", type: marketType, query: marketQuery, sort: marketSort });
  const availableTypes = Array.from(new Set(allRows.map((row) => row.type)));
  const sortBy = (key: MarketSortKey) =>
    setMarketSort((current) =>
      current.key !== key ? { key, direction: "asc" } : current.direction === "asc" ? { key, direction: "desc" } : { key: "default", direction: "asc" },
    );
  const selectMarket = (row: QuotedMarketRow) => {
    if (marketParam(row.key)) router.push(marketHref(row.key));
  };

  const live = !demo && connection.status === "open" && !staleSelected;
  const liveCount = quotedRows.filter((row) => row.state === "ready").length;
  const failed = !demo && connection.status === "failed";
  const freshness = demo
    ? "demo"
    : staleSelected
      ? "stale"
    : snapshot && connection.status === "open" && liveCount === quotedRows.length
      ? "live"
      : snapshot && connection.status === "open"
        ? "partial"
        : snapshot
          ? "stale"
          : loadingSelected
            ? "loading"
            : failed || selectedState?.status === "error"
              ? "error"
              : "empty";
  usePublishHarnessPageSummary({
    network: demo ? DEMO_MARKET_NETWORK : network,
    pair: selectedPair.label,
    base_asset: base,
    quote_asset: quote,
    panel: openKey ? selectedRoute : "market_index",
    freshness,
  });
  const statusChip = demo
    ? { label: "Demo snapshot", tone: tone.info }
    : staleSelected
      ? { label: "Last real data", tone: tone.approval }
    : connection.status === "open"
        ? { label: "Live", tone: tone.executed }
        : connection.status === "failed"
          ? { label: "Offline", tone: tone.destructive }
          : connection.status === "paused"
            ? { label: "Paused · tab hidden", tone: tone.neutral }
          : connection.status === "reconnecting"
            ? { label: "Reconnecting", tone: tone.approval }
            : { label: "Connecting", tone: tone.neutral };
  const announcement = demo
    ? "Showing a bundled illustrative demo fixture, not current ledger data."
    : staleSelected
      ? `Live market reads are unavailable. Showing last real data from ${selectedState?.updatedAt ? lastRealDataLabel(selectedState.updatedAt) : "an earlier successful read"}.`
    : connection.status === "open"
        ? `Connected to the XRP Ledger ${NETWORK_LABELS[network]}. Prices update every ledger.`
        : connection.status === "failed"
          ? "Could not reach a public XRP Ledger node."
          : connection.status === "reconnecting"
            ? "Reconnecting to the XRP Ledger."
            : "Connecting to the XRP Ledger.";

  const xrpUsd = (() => {
    const rlusdPair = MARKET_CATALOG[demo ? DEMO_MARKET_NETWORK : network].find((pair) => pair.base.symbol === "XRP" && pair.quote.symbol === "RLUSD");
    return rlusdPair ? pairStates[marketReadKey(rlusdPair)]?.snapshot?.book.mid ?? null : null;
  })();

  if (openKey) {
    return (
      <div className="min-w-0">
        <p className="sr-only" aria-live="polite">{announcement}</p>
      {/* Market page header: same pattern as the other app pages. Not clipped, so the market picker can open over the page. */}
      <header className="relative z-10 min-w-0 border-b border-border">
        <div className={`${bandInner} relative grid min-w-0 gap-6 py-8 sm:py-10 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end`}>
          <div className="min-w-0">
            <p className="label-mono flex items-center gap-2">
              <CandlestickChart aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />
              XRPL market
            </p>
            <h1 id="market-title" className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-balance text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground font-display">
              <SelectMenu
                size="title"
                label="Choose a market"
                value={selectedKey}
                display={selectedPair.label}
                onChange={(key) => router.push(marketHref(key))}
                options={quotedRows.map((row) => ({ value: row.key, label: `${row.pairLabel ?? row.venueName} · ${row.route === "amm" ? "AMM pool" : "Order book"}` }))}
              />
              <span className="font-mono text-xl tabular-nums text-foreground/90">
                {book.mid !== null ? formatPrice(book.mid, priceDigits(book.mid)) : "—"}
                <span className="ml-1.5 text-xs text-muted-foreground">{quote}</span>
              </span>
            </h1>
            <p className="label-mono mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 leading-6">
              <span>{selectedRoute === "amm" ? "AMM pool" : "Order book"}</span>
              <span aria-hidden="true">·</span>
              <span>XRPL {NETWORK_LABELS[demo ? DEMO_MARKET_NETWORK : network]}</span>
              <span aria-hidden="true">·</span>
              <span>Ledger #{(demo ? FIXTURE_LEDGER_INDEX : ledgerIndex)?.toLocaleString("en-US") ?? "—"}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={`size-1.5 rounded-full ${demo ? "bg-info" : live ? "bg-executed motion-safe:animate-pulse" : failed ? "bg-destructive" : "bg-muted-foreground"}`} />
                {statusChip.label}
              </span>
            </p>
          </div>
          <Link href="/chat" className="bracket bracket-light inline-flex h-10 items-center gap-2 self-start bg-primary px-4 text-[13px] text-primary-foreground transition hover:bg-primary/90 xl:self-auto rounded-md">
            <MessageCircle aria-hidden="true" className="size-3.5" />
            Trade in chat
          </Link>
        </div>
      </header>

      {/* Limits and metrics: one card, the same width as the panels below */}
      <div className={`${bandInner} pt-6 sm:pt-8`}>
        <div className="border border-border rounded-xl overflow-hidden">
          <PolicyBand
            strip={policyStrip(DEFAULT_POLICY, demo ? DEMO_MARKET_NETWORK : network)}
            signedIn={walletSignedIn}
          />
      <section aria-label="Market summary">
        <dl className={statGrid}>
          <Metric label="Mid price" value={book.mid} display={formatPrice(book.mid, priceDigits(book.mid))} unit={quote} loading={loadingSelected} />
          <Metric label="Spread" value={book.spreadBps} display={formatBps(book.spreadBps)} loading={loadingSelected} neutralFlash />
          <Metric
            label="AMM price"
            value={amm?.price ?? null}
            display={formatPrice(amm?.price ?? null, priceDigits(amm?.price ?? null))}
            loading={loadingSelected}
            chip={ammDelta !== null ? <DeltaChip bps={ammDelta} label="vs mid" /> : undefined}
          />
          <Metric label="AMM fee" value={amm?.feePercent ?? null} display={amm?.feePercent !== null && amm?.feePercent !== undefined ? `${amm.feePercent.toFixed(3)}%` : "—"} loading={loadingSelected} neutralFlash />
          <Metric label="Pool TVL" value={amm?.tvlQuote ?? null} display={formatCompact(amm?.tvlQuote ?? null)} unit={quote} loading={loadingSelected} />
          <Metric label="Book depth" value={book.bidDepth + book.askDepth} display={`${formatCompact(book.bidDepth)} / ${formatCompact(book.askDepth)}`} unit={base} loading={loadingSelected} neutralFlash />
        </dl>
      </section>
        </div>
      </div>

      {offline ? (
        <div className={`${bandInner} py-6 sm:py-8`}>
          <EmptyBox
            title="Waiting for a ledger connection"
            message="Quotes, depth, the pool and issuer details appear here as soon as a public XRPL node answers."
            action={
              <button
                type="button"
                className="link-dashed inline-flex h-9 pointer-coarse:h-11 items-center text-[13px] text-foreground"
                onClick={enterDemo}
              >
                Show bundled demo fixture
              </button>
            }
          />
        </div>
      ) : (
      <div className={`${bandInner} space-y-6 py-6 sm:py-8`}>
        {staleSelected ? (
          <div role="status" className="flex flex-wrap items-start gap-3 rounded-xl border border-approval/40 bg-approval/10 px-4 py-3 text-xs leading-5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-approval" aria-hidden="true" />
            <div>
              <p className="font-medium text-foreground">Showing the last real {selectedPair.label} ledger data.</p>
              <p className="text-muted-foreground">
                {selectedState?.updatedAt ? lastRealDataLabel(selectedState.updatedAt) : "Earlier successful read"}.
                {" "}{selectedState?.error} Automatic reads are backing off and will recover on their own.
                This snapshot is display-only and must not authorize a trade.
              </p>
            </div>
          </div>
        ) : null}
        {/* Best execution + AMM pool */}
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
          <Panel
            id="execution-title"
            title="Best execution"
            icon={<Route className="h-4 w-4" />}

            action={
              <div role="radiogroup" aria-label="Trade size" className="flex items-center gap-1.5">
                {selectedPair.sizes.map((option, index) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={sizeIndex === index}
                    tabIndex={sizeIndex === index ? 0 : -1}
                    onKeyDown={(event) =>
                      handleRadioKeys(
                        event,
                        selectedPair.sizes.map((_, position) => position),
                        sizeIndex,
                        setSizeIndex,
                      )
                    }
                    onClick={() => setSizeIndex(index)}
                    className={`h-7 pointer-coarse:h-11 border px-2 text-xs transition rounded-md ${
                      sizeIndex === index
                        ? "bracket bracket-accent border-border-strong bg-primary-soft text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {formatAmount(option, 0)} {base}
                  </button>
                ))}
              </div>
            }
          >
            <p className="border-b border-border px-4 py-3 text-xs leading-5 text-muted-foreground">
              Sell <span className="font-mono text-foreground">{formatAmount(size, 0)} {base}</span> for {quote}. Walks the live bid book and prices the AMM pool after its fee —{" "}
              {demo ? "from a bundled illustrative fixture, not current ledger data." : "computed in your browser from live ledger data."} Harbor serves the same comparison to agents as <code className="font-mono">venues.compare</code>.
            </p>
            {loadingSelected ? (
              <SkeletonRows rows={2} />
            ) : selectedState?.error && !snapshot ? (
              <div className="p-4">
                <EmptyBox
                  title="Market data unavailable"
                  message={selectedState.error}
                  action={!demo ? <RetryButton onClick={() => void fetchPair(selectedPair, true, true)} /> : undefined}
                />
              </div>
            ) : routes && routes.routes.length ? (
              <div className="flex flex-1 flex-col">
                <RouteBars routes={routes.routes} quoteSymbol={quote} focusRoute={selectedRoute} />
                {routes.unavailable.map((route) => (
                  <div key={route.route} className="flex items-center justify-between gap-3 border-t border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">
                    <span>{route.route === "amm" ? "AMM pool" : "Order book"}</span>
                    <span className="normal-case">{route.detail ?? "Unavailable"}</span>
                  </div>
                ))}
                {routes.routes.length > 1 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                    <p className="label-mono">Best vs other route</p>
                    <p className="font-mono text-xs tabular-nums">
                      <span className="text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">+{formatAmount(routes.savings, 2)} {quote}</span>
                      <span className="text-muted-foreground"> · {formatBps(routes.savingsBps)}</span>
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="p-4">
                <EmptyBox title="No route for this size" message={routes?.unavailable.map((route) => route.detail).filter(Boolean).join(" ") || "The book and pool read can't fill this size."} />
              </div>
            )}
          </Panel>

          <Panel id="pool-title" title="AMM pool" icon={<Droplets className="h-4 w-4" />}>
            {loadingSelected ? (
              <SkeletonRows rows={4} />
            ) : amm ? (
              <div>
                <div className="space-y-4 border-b border-border p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="label-mono">Implied price</p>
                    <p className="font-mono text-lg tabular-nums">
                      <FlashText value={amm.price}>{formatPrice(amm.price, priceDigits(amm.price))}</FlashText> <span className="text-xs text-muted-foreground">{quote}</span>
                    </p>
                  </div>
                  <PoolComposition baseValue={amm.baseReserve * amm.price} quoteValue={amm.quoteReserve} baseLabel={base} quoteLabel={quote} />
                </div>
                <dl className="grid grid-cols-2 gap-px bg-border">
                  <Stat label={`${base} reserve`} value={formatAmount(amm.baseReserve, 0)} />
                  <Stat label={`${quote} reserve`} value={formatAmount(amm.quoteReserve, 0)} />
                  <Stat label="Trading fee" value={amm.feePercent !== null ? `${amm.feePercent.toFixed(3)}%` : "—"} />
                  <Stat label="LP token supply" value={formatCompact(amm.lpSupply)} />
                </dl>
                {amm.account ? (
                  <p className="truncate border-t border-border px-4 py-3 font-mono text-[10px] text-muted-foreground" title={amm.account}>
                    <span className="label-mono mr-2">Pool account</span>{amm.account}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="p-4">
                <EmptyBox title="No AMM pool" message={`The ledger has no ${base} / ${quote} AMM pool on ${NETWORK_LABELS[demo ? DEMO_MARKET_NETWORK : network]}.`} />
              </div>
            )}
          </Panel>
        </div>

        {/* Depth chart + ladder */}
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
          <Panel id="depth-title" title="Order book depth" icon={<Waves className="h-4 w-4" />}>
            {loadingSelected ? (
              <SkeletonRows rows={5} />
            ) : !bids.length && !asks.length ? (
              <div className="p-4">
                <EmptyBox
                  title={selectedState?.error ? "Book unavailable" : "Empty book"}
                  message={selectedState?.error ?? "No resting offers on either side right now."}
                  action={selectedState?.error && !demo ? <RetryButton onClick={() => void fetchPair(selectedPair, true, true)} /> : undefined}
                />
              </div>
            ) : (
              <div className="px-2 pb-2 pt-3 sm:px-4">
                <DepthChart bids={bids} asks={asks} mid={book.mid} baseSymbol={base} quoteSymbol={quote} height={390} />
              </div>
            )}
          </Panel>

          <Panel id="ladder-title" title="Price ladder" icon={<NetworkIcon className="h-4 w-4" />}>
            {loadingSelected ? (
              <SkeletonRows rows={6} />
            ) : !bids.length && !asks.length ? (
              <div className="p-4"><EmptyBox title="No levels" message={selectedState?.error ?? "No resting offers."} /></div>
            ) : (
              <Ladder bids={bids} asks={asks} spreadBps={book.spreadBps} baseSymbol={base} quoteSymbol={quote} />
            )}
          </Panel>
        </div>

        {/* Issuers + ledger */}
        <Panel id="issuers-title" title="Assets & ledger" icon={<Landmark className="h-4 w-4" />}>
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
            {[selectedPair.base, selectedPair.quote].map((entry) =>
              entry.asset.issuer ? (
                <IssuerCard key={entry.symbol} entry={entry} state={demo ? undefined : issuers[entry.asset.issuer]} demo={demo} onRetry={() => void loadIssuer(entry)} />
              ) : (
                <XrpCard key="xrp" usd={xrpUsd} network={demo ? DEMO_MARKET_NETWORK : network} />
              ),
            )}
            <LedgerCard server={demo ? null : server} endpoint={connection.endpoint} ledgerIndex={demo ? FIXTURE_LEDGER_INDEX : ledgerIndex} demo={demo} />
          </div>
        </Panel>
      </div>
      )}

      {/* Ledger inspector: same panel style as Best execution and AMM pool */}
      <div className={`${bandInner} pb-6 sm:pb-8`}>
        <Panel id="inspector-title" title="Ledger inspector" icon={<Terminal className="h-4 w-4" />} action={<InspectorTotals calls={calls} demo={demo} />}>
          <Inspector calls={calls} demo={demo} />
          {demo ? null : (
            <p className="label-mono border-t border-border px-4 py-3">
              Selected market refreshes every validated ledger (≥{SELECTED_MIN_INTERVAL_MS / 1000}s apart); reads stop while this tab is hidden
            </p>
          )}
        </Panel>
      </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {/* Page header: same pattern as the ecosystem map */}
      <header className="relative min-w-0 overflow-hidden border-b border-border">
        <div className={`${bandInner} relative grid min-w-0 gap-6 py-8 sm:py-10 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end`}>
          <div className="min-w-0">
            <p className="label-mono flex items-center gap-2">
              <CandlestickChart aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />
              XRPL markets
            </p>
            <h1 id="markets-title" className="mt-3 max-w-3xl text-balance text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground font-display">
              Read the market before you trade.
            </h1>
            <p className="label-mono mt-3 max-w-2xl leading-6">
              Compare order books, AMM pools and the best route for each pair on the XRP Ledger.
            </p>
          </div>

          <dl className="flex min-w-0 flex-wrap items-center gap-y-2">
            <div className="flex items-baseline gap-2.5 pr-5">
              <dt className="label-mono">Markets</dt>
              <dd className="font-mono text-sm text-foreground">{quotedRows.length}</dd>
            </div>
            <div className="flex items-baseline gap-2.5 border-l border-border px-5">
              <dt className="label-mono flex items-center gap-1.5">
                <span aria-hidden="true" className={`size-1.5 shrink-0 ${demo ? "bg-info" : failed ? "bg-destructive" : liveCount === 0 ? "bg-muted-foreground" : "bg-executed"}`} />
                {demo ? "Demo fixture" : failed ? "Offline" : liveCount === 0 ? "Connecting" : "Live"}
              </dt>
              <dd className={`font-mono text-sm ${demo ? "text-info" : failed ? "text-destructive" : liveCount === 0 ? "text-muted-foreground" : "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]"}`}>
                {failed || (!demo && liveCount === 0) ? "—" : liveCount}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      {failed ? (
        <div className={`${bandInner} pt-6 sm:pt-8`}>
          <EmptyBox
            icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
            title="Can't reach the XRP Ledger"
            message={`Your browser couldn't open a WebSocket to any public ${NETWORK_LABELS[network]} node (${LEDGER_ENDPOINTS[network].map((url) => endpointHost(url)).join(", ")}). A network filter or firewall may be blocking it. Pilot keeps retrying in the background.`}
            action={
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondaryButton} onClick={() => void start()}>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Retry
                </button>
                <button type="button" className="link-dashed inline-flex h-9 pointer-coarse:h-11 items-center text-[13px] text-foreground" onClick={enterDemo}>
                  Show bundled demo fixture
                </button>
              </div>
            }
          />
        </div>
      ) : null}

      <div className={`${bandInner} py-6 sm:py-8`}>
        <MarketIndexTable
          rows={visibleRows}
          totals={{ quoted: quotedRows.length, catalog: 0 }}
          filter="quoted"
          onFilter={() => undefined}
          showCatalog={false}
          type={marketType}
          types={availableTypes}
          onType={setMarketType}
          query={marketQuery}
          onQuery={setMarketQuery}
          sort={marketSort}
          onSort={sortBy}
          selectedKey={openKey ?? ""}
          onSelect={selectMarket}
          pairLabel={selectedPair.label}
          sourceLabel={demo ? "Demo fixture" : "Live"}
          offline={failed}
          sourceTone={demo ? "info" : "executed"}
          networkLabel={NETWORK_LABELS[demo ? DEMO_MARKET_NETWORK : network]}
          networkControl={
            demo ? null : (
              <div role="radiogroup" aria-label="Ledger network" className="flex border border-border rounded-xl overflow-hidden">
                {NETWORKS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={network === option}
                    tabIndex={network === option ? 0 : -1}
                    onKeyDown={(event) => handleRadioKeys(event, NETWORKS, network, switchNetwork)}
                    onClick={() => switchNetwork(option)}
                    className={`h-8 pointer-coarse:h-11 border-r border-border px-3 text-xs transition last:border-r-0 ${
                      network === option ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {NETWORK_LABELS[option]}
                  </button>
                ))}
              </div>
            )
          }
          quotedGroupLabel={demo ? `XRP Ledger · ${NETWORK_LABELS[DEMO_MARKET_NETWORK]} snapshot` : failed ? `XRP Ledger ${NETWORK_LABELS[network]} · offline` : `Live from the XRP Ledger · ${NETWORK_LABELS[network]}`}
          footnote={demo ? `Snapshot from ${formatUtc(FIXTURE_AS_OF)}` : "Prices read live from public XRPL nodes in your browser"}
          catalogState={{ status: "ok" }}
          onRetryCatalog={() => undefined}
        />
      </div>

    </div>
  );
}

function priceDigits(value: number | null): number {
  if (value === null) return 4;
  if (value >= 100) return 2;
  if (value >= 1) return 4;
  return 5;
}

function formatUtc(iso: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(iso)) + " UTC"
  );
}

/** Briefly tints a number when it moves (up = executed, down = destructive). */
function useFlash(value: number | null, neutral = false): string {
  const previous = useRef<number | null>(value);
  const [flash, setFlash] = useState<"up" | "down" | "same" | null>(null);
  useEffect(() => {
    const last = previous.current;
    previous.current = value;
    if (last === null || value === null || last === value || prefersReducedMotion()) return;
    setFlash(neutral ? "same" : value > last ? "up" : "down");
    const timer = window.setTimeout(() => setFlash(null), 400);
    return () => window.clearTimeout(timer);
  }, [neutral, value]);
  return flash === "up"
    ? "bg-executed/15"
    : flash === "down"
      ? "bg-destructive/15"
      : flash === "same"
        ? "bg-white/[0.08]"
        : "bg-transparent";
}

function FlashText({ value, children, neutral = false }: { value: number | null; children: ReactNode; neutral?: boolean }) {
  const flash = useFlash(value, neutral);
  return <span className={`-mx-0.5 px-0.5 transition-colors duration-300 ${flash}`}>{children}</span>;
}

/** Read-only execution policy (Pilot/Policy.md). The editor lives in Memory. */
function PolicyBand({ strip, signedIn }: { strip: PolicyStrip; signedIn: boolean | null }) {
  // Signed-in users manage their own policy in Memory; the pop-up shows the default limits only to visitors.
  if (signedIn) return null;
  return (
    <section aria-label="Execution policy limits" className="border-b border-border">
      <dl className={statGrid}>
        {strip.cells.map((cell) => (
          <div key={cell.label} className={statCell}>
            <dt className={statLabel}>{cell.label}</dt>
            <dd className={statValue} title={cell.value}><span className="truncate">{cell.value}</span></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Panel({ id, title, icon, action, className = "", children }: { id: string; title: string; icon: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`flex min-w-0 flex-col border border-border bg-card rounded-xl ${className} overflow-hidden`}>
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
          <h2 id={id} className="truncate text-sm font-medium">{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  display,
  unit,
  chip: chipNode,
  loading,
  neutralFlash = false,
}: {
  label: string;
  value: number | null;
  display: string;
  unit?: string;
  chip?: ReactNode;
  loading?: boolean;
  neutralFlash?: boolean;
}) {
  return (
    <div className={statCell}>
      <dt className={statLabel}>{label}</dt>
      <dd className={statValue}>
        {loading ? (
          <span className="inline-block h-3 w-16 animate-pulse bg-white/[0.07] motion-reduce:animate-none" role="img" aria-label="Loading" />
        ) : (
          <>
            <span className="whitespace-nowrap">
              <FlashText value={value} neutral={neutralFlash}>{display}</FlashText>
              {unit && display !== "—" ? <span className="ml-1 text-[11px] text-muted-foreground">{unit}</span> : null}
            </span>
            {chipNode}
          </>
        )}
      </dd>
    </div>
  );
}

function DeltaChip({ bps, label }: { bps: number; label: string }) {
  const up = bps >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`${chip} ${Math.abs(bps) < 0.05 ? tone.neutral : up ? tone.executed : tone.destructive} whitespace-nowrap py-0 normal-case`} title={`AMM price ${label}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {formatBps(bps, true)}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-3 p-4" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className="h-2.5 w-24 animate-pulse bg-white/[0.07] motion-reduce:animate-none" />
          <div className="h-2.5 flex-1 animate-pulse bg-white/[0.05] motion-reduce:animate-none" style={{ maxWidth: `${85 - index * 9}%` }} />
        </div>
      ))}
    </div>
  );
}

function EmptyBox({ icon, title, message, action }: { icon?: ReactNode; title: string; message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 border border-dashed border-border-strong bg-card px-4 py-5 rounded-xl overflow-hidden">
      <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">{icon}{title}</p>
      <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={secondaryButton}>
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Retry
    </button>
  );
}

function Ladder({ bids, asks, spreadBps, baseSymbol, quoteSymbol }: { bids: DepthLevel[]; asks: DepthLevel[]; spreadBps: number | null; baseSymbol: string; quoteSymbol: string }) {
  const topAsks = asks.slice(0, LADDER_ROWS).reverse();
  const topBids = bids.slice(0, LADDER_ROWS);
  const max = Math.max(topAsks[0]?.cumulative ?? 0, topBids.at(-1)?.cumulative ?? 0, 1);
  const digits = priceDigits(bids[0]?.price ?? asks[0]?.price ?? null);
  const row = (level: DepthLevel, side: "ask" | "bid") => {
    const share = (level.cumulative / max) * 100;
    const color = side === "ask" ? "var(--destructive)" : "var(--executed)";
    return (
      <tr
        key={`${side}-${level.price}`}
        className="border-b border-border/60 last:border-b-0"
        style={{ backgroundImage: `linear-gradient(to left, color-mix(in srgb, ${color} 11%, transparent) ${share}%, transparent ${share}%)` }}
      >
        <td className={`px-4 py-1.5 font-mono text-xs tabular-nums ${side === "ask" ? "text-destructive" : "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]"}`}>{formatPrice(level.price, digits)}</td>
        <td className="px-4 py-1.5 text-right font-mono text-xs tabular-nums">{formatAmount(level.size, 0)}</td>
        <td className="px-4 py-1.5 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatAmount(level.cumulative, 0)}</td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto" role="region" aria-label="Price ladder table" tabIndex={0}>
      <table className="w-full min-w-[18rem] text-left">
        <caption className="sr-only">Best {LADDER_ROWS} ask and bid levels, price in {quoteSymbol} per {baseSymbol}, size and cumulative size in {baseSymbol}.</caption>
        <thead className="bg-white/[0.02]">
          <tr className="border-b border-border">
            <th scope="col" className="label-mono px-4 py-2 font-medium">Price · {quoteSymbol}</th>
            <th scope="col" className="label-mono px-4 py-2 text-right font-medium">Size · {baseSymbol}</th>
            <th scope="col" className="label-mono px-4 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {topAsks.map((level) => row(level, "ask"))}
          <tr className="border-y border-border bg-white/[0.03]">
            <td colSpan={3} className="px-4 py-2 text-xs text-muted-foreground">
              Spread <span className="text-foreground">{formatBps(spreadBps)}</span>
            </td>
          </tr>
          {topBids.map((level) => row(level, "bid"))}
        </tbody>
      </table>
    </div>
  );
}

type CardStat = { label: string; value: ReactNode };

/** One layout for every asset and ledger card: header, four stats, flags, footer. */
function InfoCard({ title, subtitle, badge, stats, chips, footer }: { title: string; subtitle: string; badge: ReactNode; stats: CardStat[]; chips: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {badge}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <dt className="label-mono">{stat.label}</dt>
            <dd className="mt-1 truncate font-mono text-xs tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex min-h-[1.375rem] flex-wrap gap-1.5">{chips}</div>
      <div aria-hidden="true" className="min-h-4 flex-1" />
      <p className="border-t border-border pt-3 font-mono text-[10px] leading-4 text-muted-foreground">{footer}</p>
    </div>
  );
}

function IssuerCard({ entry, state, demo, onRetry }: { entry: CatalogAsset; state: IssuerState | undefined; demo: boolean; onRetry: () => void }) {
  const badge = <span className={`${chip} ${tone.neutral}`}>Issued</span>;
  const code = entry.asset.currency.length > 3 ? `${entry.asset.currency.slice(0, 10)}…` : entry.asset.currency;
  const issuerFooter = (domain?: string | null) => (
    <>
      <span className="label-mono mr-1.5">Issuer</span>
      <span className="break-all">{entry.asset.issuer}</span>
      {domain ? <span> · {domain}</span> : null}
      {entry.source ? <>{" · "}<a href={entry.source} target="_blank" rel="noreferrer" className="link-dashed hover:text-foreground">source</a></> : null}
    </>
  );
  if (!demo && (!state || state.status === "loading")) return <div className="bg-card"><SkeletonRows rows={4} /></div>;
  if (!demo && (state?.status === "error" || !state?.info)) {
    return (
      <div className="min-w-0 bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{entry.symbol}</p>
            <p className="truncate text-xs text-muted-foreground">{entry.name}</p>
          </div>
          {badge}
        </div>
        <div className="mt-4"><EmptyBox title="Issuer unavailable" message={state?.error ?? "The issuer account could not be read."} action={<RetryButton onClick={onRetry} />} /></div>
      </div>
    );
  }
  const info = demo ? null : state!.info!;
  const flags: Array<[string, boolean, keyof typeof tone]> = info ? [
    ["RequireAuth", info.requireAuth, "approval"],
    ["Global freeze", info.globalFreeze, "destructive"],
    ["Clawback enabled", info.clawback, "approval"],
    ["No freeze", info.noFreeze, "info"],
  ] : [];
  const raised = flags.filter(([, on]) => on);
  return (
    <InfoCard
      title={entry.symbol}
      subtitle={entry.name}
      badge={badge}
      stats={[
        { label: "On-ledger supply", value: info?.circulating != null ? formatCompact(info.circulating) : "—" },
        { label: "Transfer fee", value: info ? (info.transferFeePercent ? `${info.transferFeePercent.toFixed(3)}%` : "None") : "—" },
        { label: "Currency code", value: code },
        { label: "Domain", value: info?.domain ?? "—" },
      ]}
      chips={raised.length ? raised.map(([label, , flagTone]) => <span key={label} className={`${chip} ${tone[flagTone]}`}>{label}</span>) : info ? <span className={`${chip} ${tone.executed}`}>No issuer restrictions</span> : null}
      footer={issuerFooter(info?.domain)}
    />
  );
}

function XrpCard({ usd, network }: { usd: number | null; network: LedgerNetwork }) {
  return (
    <InfoCard
      title="XRP"
      subtitle="Native asset · no issuer"
      badge={<span className={`${chip} ${tone.neutral}`}>Native</span>}
      stats={[
        { label: "USD value", value: usd !== null ? <FlashText value={usd}>≈ ${formatPrice(usd, 4)}</FlashText> : "—" },
        { label: "Transfer fee", value: "None" },
        { label: "Issuer", value: "None" },
        { label: "Network", value: NETWORK_LABELS[network] },
      ]}
      chips={<span className={`${chip} ${tone.executed}`}>No issuer restrictions</span>}
      footer={usd !== null ? "Priced from the XRP / RLUSD mid" : "Priced once the XRP / RLUSD book is read"}
    />
  );
}

function LedgerCard({ server, endpoint, ledgerIndex, demo }: { server: LedgerServerInfo | null; endpoint: string | null; ledgerIndex: number | null; demo: boolean }) {
  return (
    <InfoCard
      title="Ledger"
      subtitle={demo ? `Bundled fixture dated ${formatUtc(FIXTURE_AS_OF)}` : `Connected via ${endpointHost(endpoint)}`}
      badge={<span className={`${chip} ${demo ? tone.info : tone.executed}`}>{demo ? "Demo fixture" : "Live"}</span>}
      stats={[
        { label: "Validated ledger", value: ledgerIndex ? `#${ledgerIndex.toLocaleString("en-US")}` : "—" },
        { label: "Base fee", value: server?.baseFeeXrp != null ? `${Math.round(server.baseFeeXrp * 1_000_000)} drops` : "—" },
        { label: "Account reserve", value: server?.reserveBaseXrp != null ? `${server.reserveBaseXrp} XRP` : "—" },
        { label: "Owner reserve", value: server?.reserveIncXrp != null ? `${server.reserveIncXrp} XRP / object` : "—" },
      ]}
      chips={<span className={`${chip} ${tone.neutral}`}>XRPL {demo ? "Mainnet" : "validated reads"}</span>}
      footer={server?.buildVersion ? `rippled ${server.buildVersion}` : demo ? "Illustrative fixture; not a live observation" : "Reading server info…"}
    />
  );
}

function InspectorTotals({ calls, demo }: { calls: LedgerCall[]; demo: boolean }) {
  if (demo) return null;
  const ok = calls.filter((call) => call.status === "ok").length;
  const errors = calls.filter((call) => call.status === "error").length;
  const timed = calls.filter((call) => call.ms !== undefined);
  const average = timed.length ? Math.round(timed.reduce((sum, call) => sum + (call.ms ?? 0), 0) / timed.length) : null;
  return (
    <p className="text-[13px] text-muted-foreground">
      Last {calls.length} reads
      {ok ? <> · <span className="text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">{ok} ok</span></> : null}
      {errors ? <> · <span className="text-destructive">{errors} error</span></> : null}
      {average !== null ? <> · avg {average} ms</> : null}
    </p>
  );
}

function Inspector({ calls, demo }: { calls: LedgerCall[]; demo: boolean }) {
  const recent = [...calls].reverse().slice(0, 12);
  return (
    <div className="overflow-x-auto" role="region" aria-label="Ledger requests table" tabIndex={0}>
      <table className="w-full min-w-[48rem] table-fixed text-left">
        <colgroup>{Array.from({ length: 6 }, (_, index) => <col key={index} className="w-1/6" />)}</colgroup>
        <caption className="sr-only">Most recent ledger requests made by this page, newest first.</caption>
        <thead className="bg-white/[0.02]">
          <tr className="border-b border-border">
            {["Command", "Request", "Node", "Ledger", "Status", "Latency"].map((heading) => (
              <th key={heading} scope="col" className="label-mono truncate px-4 py-2 text-left font-medium">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {recent.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-4 font-mono text-[11px] text-muted-foreground">{demo ? "Showing a bundled illustrative fixture. Live reads start when a public node answers." : "No reads yet."}</td></tr>
          ) : (
            recent.map((call) => (
              <tr key={call.id} className="border-b border-border last:border-b-0">
                <td className="truncate px-4 py-2 font-mono text-xs text-foreground">{call.command}</td>
                <td className="truncate px-4 py-2 font-mono text-[11px] text-muted-foreground" title={call.request}>{call.request}</td>
                <td className="truncate px-4 py-2 font-mono text-[11px] text-muted-foreground">{call.host}</td>
                <td className="truncate px-4 py-2 font-mono text-[11px] tabular-nums text-muted-foreground">{call.ledger ? `#${call.ledger.toLocaleString("en-US")}` : "—"}</td>
                <td className="px-4 py-2">
                  <span className={`${chip} ${call.status === "ok" ? tone.executed : call.status === "error" ? tone.destructive : tone.neutral}`}>
                    {call.status === "pending" ? "Pending" : call.status === "ok" ? "OK" : call.code ?? "Error"}
                  </span>
                </td>
                <td className="truncate px-4 py-2 font-mono text-[11px] tabular-nums text-muted-foreground">{call.ms !== undefined ? `${call.ms} ms` : "…"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
