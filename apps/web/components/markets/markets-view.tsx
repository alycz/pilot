"use client";

import { DEFAULT_POLICY, type Venue } from "@pilot/contracts";
import { createMockHarborClient } from "@pilot/harbor-client";
import {
  AlertTriangle,
  ArrowDownRight,
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { loadWalletSessionStatus } from "@/lib/harbor-browser";

import { DepthChart, PoolComposition, RouteBars } from "./charts";
import {
  endpointHost,
  LEDGER_ENDPOINTS,
  LedgerClient,
  LedgerRequestError,
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
import { MarketDialog } from "./market-dialog";
import { MarketIndexTable } from "./market-index-table";
import {
  catalogMarketRows,
  filterAndSortMarkets,
  ledgerMarketRows,
  type MarketFilter,
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
import { FIXTURE_AS_OF, FIXTURE_LEDGER_INDEX, fixtureAmm, fixtureDepth } from "./markets-fixtures";
import { marketParam, policyStrip, type PolicyStrip } from "./policy-strip";
import { handleRadioKeys } from "./radio-keys";

type PairState = {
  status: "loading" | "ready" | "error";
  snapshot: PairSnapshot | null;
  error?: string;
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
const SELECTED_MIN_INTERVAL_MS = 4_000;
const OTHERS_EVERY_N_LEDGERS = 5;
const LADDER_ROWS = 6;
const NETWORKS: LedgerNetwork[] = ["mainnet", "testnet"];

const chip = "inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide";
const tone = {
  neutral: "border-border text-muted-foreground",
  executed: "border-executed/30 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
  approval: "border-approval/30 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
};
const bandInner = "mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8";
const dialogInner = "w-full px-4 sm:px-6";
/** One grid for the pop-up's policy and metric strips so all twelve cells line up and match in size. */
const statGrid = "grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3 lg:grid-cols-6";
const statCell = "flex min-h-[4.5rem] min-w-0 flex-col justify-center gap-1.5 bg-background px-4 py-3 sm:px-6";
const statLabel = "label-mono truncate text-[10px]";
const statValue = "flex h-5 min-w-0 items-center gap-2 font-mono text-[13px] tabular-nums text-foreground";
const secondaryButton = "bracket bracket-light inline-flex h-9 pointer-coarse:h-11 items-center gap-2 border border-border bg-white/[0.03] px-3 font-mono text-[11px] uppercase tracking-wide text-foreground transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45";

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

/** Demo snapshot built from the bundled fixtures, used only when no ledger node is reachable. */
function demoSnapshot(): { pair: CatalogPair; snapshot: PairSnapshot } {
  const pair = MARKET_CATALOG.testnet[0]!;
  const legacy = marketPair("testnet", { currency: RLUSD_CURRENCY, issuer: pair.quote.asset.issuer! });
  const bids = depthSide(fixtureDepth(legacy, "bid"), "bid");
  const asks = depthSide(fixtureDepth(legacy, "ask"), "ask");
  return {
    pair,
    snapshot: {
      bids,
      asks,
      book: bookSummary(bids, asks),
      amm: ammSummary(fixtureAmm(legacy), legacy.base, legacy.quote),
      ledgerIndex: FIXTURE_LEDGER_INDEX,
    },
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MarketsView() {
  const [network, setNetwork] = useState<LedgerNetwork>("mainnet");
  const [demo, setDemo] = useState(false);
  const pairs = useMemo<readonly CatalogPair[]>(() => (demo ? [demoSnapshot().pair] : MARKET_CATALOG[network]), [demo, network]);
  const [selectedKey, setSelectedKey] = useState<string>(`${MARKET_CATALOG.mainnet[0]!.id}:order-book`);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [pairStates, setPairStates] = useState<Record<string, PairState>>({});
  const [issuers, setIssuers] = useState<Record<string, IssuerState>>({});
  const [server, setServer] = useState<LedgerServerInfo | null>(null);
  const [connection, setConnection] = useState<{ status: LedgerStatus; endpoint: string | null }>({ status: "idle", endpoint: null });
  const [ledgerIndex, setLedgerIndex] = useState<number | null>(null);
  const [calls, setCalls] = useState<LedgerCall[]>([]);
  const [venues, setVenues] = useState<{ status: "loading" | "ok" | "error"; data?: Venue[]; message?: string }>({ status: "loading" });
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [marketType, setMarketType] = useState<MarketType | "all">("all");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketSort, setMarketSort] = useState<MarketSort>({ key: "default", direction: "asc" });
  const [openKey, setOpenKey] = useState<string | null>(null);
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

  // Deep links: ?market=<pairId:route> opens that market; back/forward keep the pop-up in sync.
  useEffect(() => {
    const syncFromUrl = () => {
      const key = marketParam(new URLSearchParams(window.location.search).get("market"));
      const pairId = key ? key.slice(0, key.lastIndexOf(":")) : null;
      const pairNetwork = pairId ? (NETWORKS.find((option) => MARKET_CATALOG[option].some((pair) => pair.id === pairId)) ?? null) : null;
      if (key && pairNetwork) {
        setNetwork(pairNetwork);
        setSelectedKey(key);
        setOpenKey(key);
      } else {
        setOpenKey(null);
      }
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  // Bundled venue catalog (in-browser, no network): lists venues Pilot doesn't quote.
  useEffect(() => {
    let active = true;
    void createMockHarborClient()
      .op("venues.list", {})
      .then((result) => {
        if (!active) return;
        setVenues(result.ok ? { status: "ok", data: result.data } : { status: "error", message: result.error.message });
      })
      .catch((cause: unknown) => active && setVenues({ status: "error", message: cause instanceof Error ? cause.message : "Catalog unavailable" }));
    return () => {
      active = false;
    };
  }, []);

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
    async (pair: CatalogPair, full: boolean) => {
      if (inFlight.current.has(pair.id)) return;
      inFlight.current.add(pair.id);
      lastFetch.current.set(pair.id, Date.now());
      setPairStates((current) => (current[pair.id] ? current : { ...current, [pair.id]: { status: "loading", snapshot: null } }));
      const limit = full ? FULL_DEPTH : LIGHT_DEPTH;
      const base = ledgerAsset(pair.base.asset);
      const quote = ledgerAsset(pair.quote.asset);
      try {
        const [asks, bids, amm] = await Promise.allSettled([
          read("book_offers", { taker_gets: base, taker_pays: quote, limit, ledger_index: "validated" }),
          read("book_offers", { taker_gets: quote, taker_pays: base, limit, ledger_index: "validated" }),
          read("amm_info", { asset: base, asset2: quote, ledger_index: "validated" }),
        ]);
        if (asks.status === "rejected" && bids.status === "rejected") {
          const reason = asks.reason instanceof Error ? asks.reason.message : "The order book could not be read.";
          setPairStates((current) => ({ ...current, [pair.id]: { ...(current[pair.id] ?? { snapshot: null }), status: current[pair.id]?.snapshot ? "ready" : "error", error: reason } }));
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
        setPairStates((current) => ({ ...current, [pair.id]: { status: "ready", snapshot, updatedAt: Date.now() } }));
      } finally {
        inFlight.current.delete(pair.id);
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
    for (const pair of pairsRef.current) void fetchPair(pair, pair.id === selected.id);
  }, [fetchPair]);

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
    const last = lastFetch.current.get(selected.id) ?? 0;
    if (Date.now() - last >= SELECTED_MIN_INTERVAL_MS) void fetchPair(selected, true);
    const everyN = ledgerCount.current % OTHERS_EVERY_N_LEDGERS === 0;
    for (const pair of pairsRef.current) {
      if (pair.id === selected.id) continue;
      // Pairs that never loaded (e.g. after a failed first connection) refresh right away.
      if (everyN || !pairStatesRef.current[pair.id]?.snapshot) void fetchPair(pair, false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPair.id]);

  const switchNetwork = (next: LedgerNetwork) => {
    if (next === network) return;
    setNetwork(next);
    setSelectedKey(`${MARKET_CATALOG[next][0]!.id}:order-book`);
    setSizeIndex(1);
  };

  const enterDemo = () => {
    const { pair, snapshot } = demoSnapshot();
    setDemo(true);
    setPairStates({ [pair.id]: { status: "ready", snapshot, updatedAt: Date.parse(FIXTURE_AS_OF) } });
    setSelectedKey(`${pair.id}:order-book`);
    setCalls([]);
    setConnection({ status: "idle", endpoint: null });
  };

  // ---------- derived view data ----------
  const selectedState = pairStates[selectedPair.id];
  const snapshot = selectedState?.snapshot ?? null;
  const bids: DepthLevel[] = snapshot?.bids ?? [];
  const asks: DepthLevel[] = snapshot?.asks ?? [];
  const book = snapshot?.book ?? bookSummary([], []);
  const amm = snapshot?.amm ?? null;
  const ammDelta = deviationBps(amm?.price ?? null, book.mid);
  const size = selectedPair.sizes[Math.min(sizeIndex, selectedPair.sizes.length - 1)]!;
  const routes = snapshot ? quoteRoutes({ size, bids, amm, mid: book.mid }) : null;
  const offline = !demo && !snapshot && (connection.status === "failed" || connection.status === "reconnecting");
  const loadingSelected = !snapshot && !offline && (selectedState?.status ?? "loading") === "loading";
  const base = selectedPair.base.symbol;
  const quote = selectedPair.quote.symbol;

  const quotedRows = ledgerMarketRows(
    pairs.map((pair) => {
      const state = pairStates[pair.id];
      return {
        pair,
        snapshot: state?.snapshot ?? null,
        state: state ? (state.snapshot ? "ready" : state.status) : connection.status === "failed" ? "error" : "loading",
      };
    }),
  );
  const catalogNetwork = demo ? "testnet" : network;
  const catalogRows = venues.status === "ok" && venues.data ? catalogMarketRows(venues.data, catalogNetwork) : [];
  const allRows: MarketRow[] = [...quotedRows, ...catalogRows];
  const visibleRows = filterAndSortMarkets(allRows, { filter: marketFilter, type: marketType, query: marketQuery, sort: marketSort });
  const availableTypes = Array.from(new Set(allRows.map((row) => row.type)));
  const sortBy = (key: MarketSortKey) =>
    setMarketSort((current) =>
      current.key !== key ? { key, direction: "asc" } : current.direction === "asc" ? { key, direction: "desc" } : { key: "default", direction: "asc" },
    );
  const selectMarket = (row: QuotedMarketRow) => {
    setSelectedKey(row.key);
    if (row.pairId !== selectedPair.id) setSizeIndex(1);
    setOpenKey(row.key);
    if (!demo && marketParam(row.key)) {
      const url = new URL(window.location.href);
      url.searchParams.set("market", row.key);
      window.history.pushState({ pilotMarket: row.key }, "", url);
    }
  };

  const closeMarket = () => {
    setOpenKey(null);
    const url = new URL(window.location.href);
    if (!url.searchParams.has("market")) return;
    if ((window.history.state as { pilotMarket?: string } | null)?.pilotMarket) {
      window.history.back();
    } else {
      url.searchParams.delete("market");
      window.history.replaceState(window.history.state, "", url);
    }
  };

  const live = !demo && connection.status === "open";
  const liveCount = quotedRows.filter((row) => row.state === "ready").length;
  const failed = !demo && connection.status === "failed";
  const statusChip = demo
    ? { label: "Demo snapshot", tone: tone.info }
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
    ? "Showing the demo snapshot."
    : connection.status === "open"
        ? `Connected to the XRP Ledger ${NETWORK_LABELS[network]}. Prices update every ledger.`
        : connection.status === "failed"
          ? "Could not reach a public XRP Ledger node."
          : connection.status === "reconnecting"
            ? "Reconnecting to the XRP Ledger."
            : "Connecting to the XRP Ledger.";

  const xrpUsd = (() => {
    if (demo) return null;
    const rlusdPair = MARKET_CATALOG[network].find((pair) => pair.base.symbol === "XRP" && pair.quote.symbol === "RLUSD");
    return rlusdPair ? pairStates[rlusdPair.id]?.snapshot?.book.mid ?? null : null;
  })();

  return (
    <div className="min-w-0">
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {/* Page header: same pattern as the ecosystem map */}
      <header className="relative min-w-0 overflow-hidden border-b border-border">
        <div aria-hidden="true" className="bg-rules pointer-events-none absolute inset-0" />
        <div className={`${bandInner} relative grid min-w-0 gap-6 py-8 sm:py-10 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end`}>
          <div className="min-w-0">
            <p className="label-mono flex items-center gap-2">
              <CandlestickChart aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />
              XRPL markets
            </p>
            <h1 id="markets-title" className="mt-3 max-w-3xl text-balance text-[1.75rem] font-normal leading-tight tracking-[-0.02em] text-foreground">
              Read the market before you trade.
            </h1>
            <p className="label-mono mt-3 max-w-2xl leading-6">
              {demo
                ? `Demo snapshot from ${formatUtc(FIXTURE_AS_OF)}. Values are fixed and not read from the ledger.`
                : "Compare order books, AMM pools and the best route for each pair, read live from public XRPL nodes in your browser."}
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
                {demo ? "Demo" : failed ? "Offline" : liveCount === 0 ? "Connecting" : "Live"}
              </dt>
              <dd className={`font-mono text-sm ${demo ? "text-info" : failed ? "text-destructive" : liveCount === 0 ? "text-muted-foreground" : "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]"}`}>
                {failed || (!demo && liveCount === 0) ? "—" : liveCount}
              </dd>
            </div>
            <div className="flex items-baseline gap-2.5 border-l border-border pl-5">
              <dt className="label-mono" title="Trading venues in Harbor's catalog that Markets does not price yet. The full catalog, including payments and bridges, is on Map.">Other venues</dt>
              <dd className="font-mono text-sm text-foreground">{venues.status === "loading" ? "—" : catalogRows.length}</dd>
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
                <button type="button" className="link-dashed inline-flex h-9 pointer-coarse:h-11 items-center font-mono text-[11px] uppercase tracking-wide text-foreground" onClick={enterDemo}>
                  Show demo snapshot
                </button>
              </div>
            }
          />
        </div>
      ) : null}

      <div className={`${bandInner} py-6 sm:py-8`}>
        <MarketIndexTable
          rows={visibleRows}
          totals={{ quoted: quotedRows.length, catalog: catalogRows.length }}
          filter={marketFilter}
          onFilter={setMarketFilter}
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
          sourceLabel={demo ? "" : "Live"}
          offline={failed}
          sourceTone={demo ? "info" : "executed"}
          networkLabel={demo ? "Testnet" : NETWORK_LABELS[network]}
          networkControl={
            demo ? null : (
              <div role="radiogroup" aria-label="Ledger network" className="flex border border-border">
                {NETWORKS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={network === option}
                    tabIndex={network === option ? 0 : -1}
                    onKeyDown={(event) => handleRadioKeys(event, NETWORKS, network, switchNetwork)}
                    onClick={() => switchNetwork(option)}
                    className={`h-8 pointer-coarse:h-11 border-r border-border px-3 font-mono text-[10px] uppercase tracking-wide transition last:border-r-0 ${
                      network === option ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {NETWORK_LABELS[option]}
                  </button>
                ))}
              </div>
            )
          }
          quotedGroupLabel={demo ? "Demo snapshot · XRPL Testnet" : failed ? `XRP Ledger ${NETWORK_LABELS[network]} · offline` : `Live from the XRP Ledger · ${NETWORK_LABELS[network]}`}
          footnote={demo ? "Demo values · not read from the ledger" : "Prices read live from public XRPL nodes in your browser · catalogued venues show “—”"}
          catalogState={venues.status === "error" ? { status: "error", message: venues.message ?? "" } : { status: venues.status }}
          onRetryCatalog={() => window.location.reload()}
        />
      </div>

      {openKey && selectedPair ? (
        <MarketDialog
          labelledBy="market-dialog-title"
          onClose={closeMarket}
          header={
            <div className="min-w-0">
              <h2 id="market-dialog-title" className="min-w-0 text-2xl font-normal tracking-[-0.02em] sm:text-[1.875rem]">
                {selectedPair.label}
              </h2>
              <p className="label-mono mt-1.5">
                {demo
                  ? `Ledger #${FIXTURE_LEDGER_INDEX.toLocaleString("en-US")}`
                  : `Ledger ${ledgerIndex ? `#${ledgerIndex.toLocaleString("en-US")}` : "—"}`}
                {demo ? null : <span className="sm:hidden"> · {statusChip.label} · XRPL {NETWORK_LABELS[network]}</span>}
              </p>
            </div>
          }
          headerAside={
            demo ? null : <div className="hidden flex-wrap items-center justify-end gap-2 sm:flex">
              <span className={`${chip} ${statusChip.tone}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 ${live ? "animate-pulse bg-executed motion-reduce:animate-none" : demo ? "bg-info" : failed ? "bg-destructive" : "bg-muted-foreground"}`} />
                {statusChip.label}
              </span>
              <span className={`${chip} ${tone.neutral}`}>XRPL {demo ? "Testnet" : NETWORK_LABELS[network]}</span>
            </div>
          }
        >
          <PolicyBand
            strip={policyStrip(DEFAULT_POLICY, demo ? "testnet" : network)}
            signedIn={walletSignedIn}
          />

      {/* Metrics strip */}
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

      {offline ? (
        <div className={`${dialogInner} py-6 sm:py-8`}>
          <EmptyBox
            title="Waiting for a ledger connection"
            message="Quotes, depth, the pool and issuer details appear here as soon as a public XRPL node answers."
            action={
              <button
                type="button"
                className="link-dashed inline-flex h-9 pointer-coarse:h-11 items-center font-mono text-[11px] uppercase tracking-wide text-foreground"
                onClick={() => {
                  enterDemo();
                  setOpenKey(`${demoSnapshot().pair.id}:order-book`);
                }}
              >
                Show demo snapshot
              </button>
            }
          />
        </div>
      ) : (
      <div className={`${dialogInner} space-y-6 py-6 sm:py-8`}>
        {/* Best execution + AMM pool */}
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
          <Panel
            id="execution-title"
            title="Best execution"
            className="lg:self-start"
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
                    className={`h-7 pointer-coarse:h-11 border px-2 font-mono text-[10px] uppercase tracking-wide transition ${
                      sizeIndex === index
                        ? "bracket bracket-accent border-border-strong bg-primary/[0.06] text-foreground"
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
              {demo ? "on demo values." : "computed in your browser from live ledger data."} Harbor serves the same comparison to agents as <code className="font-mono">venues.compare</code>.
            </p>
            {loadingSelected ? (
              <SkeletonRows rows={2} />
            ) : routes && routes.routes.length ? (
              <>
                <RouteBars routes={routes.routes} quoteSymbol={quote} focusRoute={selectedRoute} />
                {routes.unavailable.map((route) => (
                  <div key={route.route} className="flex items-center justify-between gap-3 border-t border-dashed border-border px-4 py-3 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
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
              </>
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
                    <span className="label-mono mr-2 text-[10px]">Pool account</span>{amm.account}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="p-4">
                <EmptyBox title="No AMM pool" message={`The ledger has no ${base} / ${quote} AMM pool on ${demo ? "the demo snapshot" : NETWORK_LABELS[network]}.`} />
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
                  action={selectedState?.error && !demo ? <RetryButton onClick={() => void fetchPair(selectedPair, true)} /> : undefined}
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
                <XrpCard key="xrp" usd={xrpUsd} network={demo ? "testnet" : network} />
              ),
            )}
            <LedgerCard server={demo ? null : server} endpoint={connection.endpoint} ledgerIndex={demo ? FIXTURE_LEDGER_INDEX : ledgerIndex} demo={demo} />
          </div>
        </Panel>
      </div>
      )}

      {/* Ledger inspector band */}
      <section aria-labelledby="inspector-title" className="border-t border-border bg-sidebar/40">
        <div className={`${dialogInner} py-6 sm:py-8`}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="inspector-title" className="flex items-center gap-2 text-sm font-medium">
                <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Ledger inspector
              </h2>
              <p className="label-mono mt-1.5 leading-5">
                Your browser → public XRPL node over WebSocket · no Pilot server, no API key
              </p>
              <p className="label-mono mt-1 text-[10px] leading-5">
                Agents get this same data through Harbor: <span className="text-foreground">dex.depth · amm.info · venues.compare</span>
              </p>
            </div>
            <InspectorTotals calls={calls} demo={demo} />
          </div>
          <Inspector calls={calls} demo={demo} />
          <p className="label-mono mt-4 text-[10px]">
            {demo
              ? null
              : `Selected market refreshes every validated ledger (≥${SELECTED_MIN_INTERVAL_MS / 1000}s apart); other markets every ${OTHERS_EVERY_N_LEDGERS} ledgers; reads stop while this tab is hidden`}
          </p>
        </div>
      </section>
        </MarketDialog>
      ) : null}
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
    <section aria-label="Execution policy limits">
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
    <section aria-labelledby={id} className={`min-w-0 border border-border bg-card ${className}`}>
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
      <dt className="label-mono text-[10px]">{label}</dt>
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
    <div className="flex flex-col items-start gap-3 border border-dashed border-border-strong bg-card px-4 py-5">
      <p className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wide text-foreground">{icon}{title}</p>
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
            <th scope="col" className="label-mono px-4 py-2 text-[10px] font-medium">Price · {quoteSymbol}</th>
            <th scope="col" className="label-mono px-4 py-2 text-right text-[10px] font-medium">Size · {baseSymbol}</th>
            <th scope="col" className="label-mono px-4 py-2 text-right text-[10px] font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {topAsks.map((level) => row(level, "ask"))}
          <tr className="border-y border-border bg-white/[0.03]">
            <td colSpan={3} className="px-4 py-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Spread <span className="text-foreground">{formatBps(spreadBps)}</span>
            </td>
          </tr>
          {topBids.map((level) => row(level, "bid"))}
        </tbody>
      </table>
    </div>
  );
}

function IssuerCard({ entry, state, demo, onRetry }: { entry: CatalogAsset; state: IssuerState | undefined; demo: boolean; onRetry: () => void }) {
  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{entry.symbol}</p>
        <p className="truncate text-xs text-muted-foreground">{entry.name}</p>
      </div>
      <span className={`${chip} ${tone.neutral}`}>Issued</span>
    </div>
  );
  if (demo) {
    return (
      <div className="min-w-0 bg-card p-4">
        {header}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">Issuer flags and supply are read live from the ledger; unavailable in the demo snapshot.</p>
      </div>
    );
  }
  if (!state || state.status === "loading") return <div className="bg-card"><SkeletonRows rows={4} /></div>;
  if (state.status === "error" || !state.info) {
    return (
      <div className="min-w-0 bg-card p-4">
        {header}
        <div className="mt-4"><EmptyBox title="Issuer unavailable" message={state.error ?? "The issuer account could not be read."} action={<RetryButton onClick={onRetry} />} /></div>
      </div>
    );
  }
  const info = state.info;
  const flags: Array<[string, boolean, keyof typeof tone]> = [
    ["RequireAuth", info.requireAuth, "approval"],
    ["Global freeze", info.globalFreeze, "destructive"],
    ["Clawback enabled", info.clawback, "approval"],
    ["No freeze", info.noFreeze, "info"],
  ];
  const raised = flags.filter(([, on]) => on);
  return (
    <div className="min-w-0 bg-card p-4">
      {header}
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <dt className="label-mono text-[10px]">On-ledger supply</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums">{info.circulating !== null ? formatCompact(info.circulating) : "—"}</dd>
        </div>
        <div>
          <dt className="label-mono text-[10px]">Transfer fee</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums">{info.transferFeePercent ? `${info.transferFeePercent.toFixed(3)}%` : "None"}</dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Issuer flags">
        {raised.length ? raised.map(([label, , flagTone]) => <span key={label} className={`${chip} ${tone[flagTone]}`}>{label}</span>) : <span className={`${chip} ${tone.executed}`}>No issuer restrictions</span>}
      </div>
      <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] leading-4 text-muted-foreground">
        <span className="label-mono mr-1.5 text-[10px]">Issuer</span>
        <span className="break-all">{info.account}</span>
        {info.domain ? <span> · {info.domain}</span> : null}
        {entry.source ? (
          <>
            {" · "}
            <a href={entry.source} target="_blank" rel="noreferrer" className="link-dashed hover:text-foreground">source</a>
          </>
        ) : null}
      </p>
    </div>
  );
}

function XrpCard({ usd, network }: { usd: number | null; network: LedgerNetwork }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">XRP</p>
          <p className="truncate text-xs text-muted-foreground">Native asset · no issuer</p>
        </div>
        <p className="font-mono text-base tabular-nums">{usd !== null ? <FlashText value={usd}>≈ ${formatPrice(usd, 4)}</FlashText> : "—"}</p>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        {usd !== null
          ? `USD value implied from the live XRP / RLUSD mid on ${NETWORK_LABELS[network]} (RLUSD ≈ $1).`
          : "USD value appears once the XRP / RLUSD book has been read."}
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className={`${chip} ${tone.executed}`}>No issuer restrictions</span>
      </div>
    </div>
  );
}

function LedgerCard({ server, endpoint, ledgerIndex, demo }: { server: LedgerServerInfo | null; endpoint: string | null; ledgerIndex: number | null; demo: boolean }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Ledger</p>
          <p className="truncate text-xs text-muted-foreground">{demo ? "Demo snapshot" : `Connected via ${endpointHost(endpoint)}`}</p>
        </div>
        {demo ? <span className={`${chip} ${tone.info}`}>Demo</span> : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <dt className="label-mono text-[10px]">Validated ledger</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums">{ledgerIndex ? `#${ledgerIndex.toLocaleString("en-US")}` : "—"}</dd>
        </div>
        <div>
          <dt className="label-mono text-[10px]">Base fee</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums">{server?.baseFeeXrp !== null && server?.baseFeeXrp !== undefined ? `${Math.round(server.baseFeeXrp * 1_000_000)} drops` : "—"}</dd>
        </div>
        <div>
          <dt className="label-mono text-[10px]">Account reserve</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums">{server?.reserveBaseXrp !== null && server?.reserveBaseXrp !== undefined ? `${server.reserveBaseXrp} XRP` : "—"}</dd>
        </div>
        <div>
          <dt className="label-mono text-[10px]">Owner reserve</dt>
          <dd className="mt-1 font-mono text-xs tabular-nums">{server?.reserveIncXrp !== null && server?.reserveIncXrp !== undefined ? `${server.reserveIncXrp} XRP / object` : "—"}</dd>
        </div>
      </dl>
      {server?.buildVersion ? <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-muted-foreground">rippled {server.buildVersion}</p> : null}
    </div>
  );
}

function InspectorTotals({ calls, demo }: { calls: LedgerCall[]; demo: boolean }) {
  if (demo) return null;
  const ok = calls.filter((call) => call.status === "ok").length;
  const errors = calls.filter((call) => call.status === "error").length;
  const timed = calls.filter((call) => call.ms !== undefined);
  const average = timed.length ? Math.round(timed.reduce((sum, call) => sum + (call.ms ?? 0), 0) / timed.length) : null;
  return (
    <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
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
    <div className="mt-4 overflow-x-auto border border-border bg-card" role="region" aria-label="Ledger requests table" tabIndex={0}>
      <table className="w-full min-w-[44rem] text-left">
        <caption className="sr-only">Most recent ledger requests made by this page, newest first.</caption>
        <thead className="bg-white/[0.02]">
          <tr className="border-b border-border">
            {["Command", "Request", "Node", "Ledger", "Status", "Latency"].map((heading, index) => (
              <th key={heading} scope="col" className={`label-mono px-4 py-2 text-[10px] font-medium ${index >= 3 && index !== 4 ? "text-right" : ""}`}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {recent.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-4 font-mono text-[11px] text-muted-foreground">{demo ? "The demo snapshot makes no ledger requests." : "No reads yet."}</td></tr>
          ) : (
            recent.map((call) => (
              <tr key={call.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2 font-mono text-xs text-foreground">{call.command}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">{call.request}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">{call.host}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{call.ledger ? `#${call.ledger.toLocaleString("en-US")}` : "—"}</td>
                <td className="px-4 py-2">
                  <span className={`${chip} ${call.status === "ok" ? tone.executed : call.status === "error" ? tone.destructive : tone.neutral}`}>
                    {call.status === "pending" ? "Pending" : call.status === "ok" ? "OK" : call.code ?? "Error"}
                  </span>
                </td>
                <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{call.ms !== undefined ? `${call.ms} ms` : "…"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
