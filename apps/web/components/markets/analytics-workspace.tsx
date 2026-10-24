"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CircleDot,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import React from "react";

import {
  AmmStatePanel,
  ComparisonScannerPanel,
  DataStateNotice,
  DepthAndLiquidityPanel,
  MetricStrip,
  PriceCoveragePanel,
  PriceDirection,
  ProvenanceBar,
  formatMetric,
  type AnalyticsSnapshot,
} from "./analytics-panels";
import { TerminalTradePreview } from "./terminal-trade-preview";

export type AnalyticsWorkspaceState = "loading" | "ready" | "empty" | "error";
export type AnalyticsTerminalPanel = "overview" | "book" | "liquidity" | "compare";

export type AnalyticsWorkspaceProps = {
  state: AnalyticsWorkspaceState;
  snapshots: AnalyticsSnapshot[];
  selectedId?: string;
  error?: string;
  query?: string;
  refreshing?: boolean;
  selectedComparisonId?: string;
  activePanel?: AnalyticsTerminalPanel;
  onQueryChange?: (query: string) => void;
  onSelect?: (id: string) => void;
  onSelectComparison?: (id: string) => void;
  onActivePanelChange?: (panel: AnalyticsTerminalPanel) => void;
  onRefresh?: () => void;
};

const pageInner = "mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-8";
const label = "font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";

/**
 * Presentational XRPL analytics workspace.
 *
 * All observations arrive as props from the read-only analytics boundary. The
 * component owns no Harbor credentials, wallet/account state, chat transport,
 * or execution action. This keeps analytics context safe to expose to the
 * global harness through a separate, sanitized page-context adapter.
 */
export function AnalyticsWorkspace({
  state,
  snapshots,
  selectedId,
  error,
  query = "",
  refreshing = false,
  selectedComparisonId,
  activePanel,
  onQueryChange,
  onSelect,
  onSelectComparison,
  onActivePanelChange,
  onRefresh,
}: AnalyticsWorkspaceProps) {
  const [uncontrolledPanel, setUncontrolledPanel] = React.useState<AnalyticsTerminalPanel>("overview");
  const terminalPanel = activePanel ?? uncontrolledPanel;
  const selectTerminalPanel = (panel: AnalyticsTerminalPanel) => {
    setUncontrolledPanel(panel);
    onActivePanelChange?.(panel);
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSnapshots = normalizedQuery
    ? snapshots.filter((snapshot) => {
      const identity = [
        snapshot.label,
        snapshot.base.symbol,
        snapshot.base.currency,
        snapshot.base.issuer,
        snapshot.quote.symbol,
        snapshot.quote.currency,
        snapshot.quote.issuer,
        snapshot.provenance.network,
        snapshot.provenance.source,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return identity.includes(normalizedQuery);
    })
    : snapshots;
  const selected = visibleSnapshots.find((snapshot) => snapshot.id === selectedId) ?? visibleSnapshots[0];

  return (
    <main className="min-h-full bg-background text-foreground" aria-label="XRPL market analytics workspace">
      <WorkspaceHeader
        query={query}
        refreshing={refreshing}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
        selected={selected}
      />

      {selected?.provenance.mode === "demo" ? (
        <div className="border-b border-approval/30 bg-approval/[0.07]">
          <div className={`${pageInner} flex items-start gap-3 py-3`} role="status">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-approval" aria-hidden="true" />
            <p className="text-sm leading-6 text-foreground">
              <span className="font-medium text-approval">Illustrative demo fixture.</span>{" "}
              These values exercise the interface and are not represented as current ledger observations.
            </p>
          </div>
        </div>
      ) : null}

      <div className={`${pageInner} py-5 sm:py-7`}>
        {state === "loading" ? <WorkspaceLoading /> : null}
        {state === "error" ? <WorkspaceError message={error ?? "Market analytics are unavailable."} onRefresh={onRefresh} /> : null}
        {state === "empty" || (state === "ready" && snapshots.length === 0) ? <WorkspaceEmpty /> : null}
        {state === "ready" && snapshots.length > 0 ? (
          <div className="grid min-w-0 gap-5 xl:grid-cols-[13rem_minmax(0,1fr)_18rem] xl:items-start">
            <MarketRail
              snapshots={visibleSnapshots}
              selectedId={selected?.id}
              query={query}
              onSelect={onSelect}
            />
            {selected ? (
              <>
                <div className="min-w-0 space-y-5">
                  <MarketIdentity snapshot={selected} />
                  <DataStateNotice snapshot={selected} />
                  <div className="overflow-hidden border border-border bg-card">
                    <ProvenanceBar provenance={selected.provenance} base={selected.base} quote={selected.quote} />
                    <MetricStrip snapshot={selected} />
                  </div>
                  <MobileTerminalTabs activePanel={terminalPanel} onChange={selectTerminalPanel} />
                  <div
                    id="markets-terminal-panel-overview"
                    role="tabpanel"
                    aria-label="Overview"
                    className={terminalPanel === "overview" ? "space-y-5" : "hidden xl:block xl:space-y-5"}
                  >
                    <PriceCoveragePanel snapshot={selected} />
                    <AmmStatePanel snapshot={selected} />
                  </div>
                  <div
                    id="markets-terminal-panel-compare"
                    role="tabpanel"
                    aria-label="Compare"
                    className={terminalPanel === "compare" ? "block" : "hidden xl:block"}
                  >
                    <ComparisonScannerPanel snapshot={selected} selectedId={selectedComparisonId} onSelect={onSelectComparison} />
                  </div>
                </div>
                <aside
                  aria-label="Market book and trade preview"
                  className={`${terminalPanel === "book" || terminalPanel === "liquidity" ? "block" : "hidden"} min-w-0 space-y-5 xl:sticky xl:top-4 xl:block xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto`}
                >
                  <div
                    id="markets-terminal-panel-book"
                    role="tabpanel"
                    aria-label="Book"
                    className={terminalPanel === "book" ? "block" : "hidden xl:block"}
                  >
                    <DepthAndLiquidityPanel snapshot={selected} compact />
                  </div>
                  <div
                    id="markets-terminal-panel-liquidity"
                    role="tabpanel"
                    aria-label="Liquidity"
                    className={terminalPanel === "liquidity" ? "block" : "hidden xl:block"}
                  >
                    <TerminalTradePreview snapshot={selected} />
                  </div>
                </aside>
                <div className="xl:col-start-2 xl:col-span-2">
                  <ReadOnlyFootnote />
                </div>
              </>
            ) : <div className="xl:col-span-2"><FilteredEmpty query={query} /></div>}
          </div>
        ) : null}
      </div>
    </main>
  );
}

const terminalPanels: { id: AnalyticsTerminalPanel; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "book", label: "Book" },
  { id: "liquidity", label: "Liquidity" },
  { id: "compare", label: "Compare" },
];

function MobileTerminalTabs({ activePanel, onChange }: { activePanel: AnalyticsTerminalPanel; onChange: (panel: AnalyticsTerminalPanel) => void }) {
  const focusTab = (panel: AnalyticsTerminalPanel) => {
    document.getElementById(`markets-terminal-tab-${panel}`)?.focus();
  };
  const move = (current: AnalyticsTerminalPanel, direction: -1 | 1) => {
    const index = terminalPanels.findIndex((panel) => panel.id === current);
    const next = terminalPanels[(index + direction + terminalPanels.length) % terminalPanels.length]!.id;
    onChange(next);
    focusTab(next);
  };
  return (
    <div className="grid grid-cols-4 border border-border bg-card xl:hidden" role="tablist" aria-label="Markets terminal panels">
      {terminalPanels.map((panel) => (
        <button
          key={panel.id}
          id={`markets-terminal-tab-${panel.id}`}
          type="button"
          role="tab"
          aria-selected={activePanel === panel.id}
          aria-controls={`markets-terminal-panel-${panel.id}`}
          tabIndex={activePanel === panel.id ? 0 : -1}
          onClick={() => onChange(panel.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") { event.preventDefault(); move(panel.id, 1); }
            if (event.key === "ArrowLeft") { event.preventDefault(); move(panel.id, -1); }
            if (event.key === "Home") { event.preventDefault(); onChange("overview"); focusTab("overview"); }
            if (event.key === "End") { event.preventDefault(); onChange("compare"); focusTab("compare"); }
          }}
          className={`min-w-0 border-r border-border px-2 py-3 font-mono text-[10px] uppercase tracking-[0.06em] last:border-r-0 ${activePanel === panel.id ? "bg-primary/[0.08] text-primary" : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"}`}
        >
          <span className="block truncate">{panel.label}</span>
        </button>
      ))}
    </div>
  );
}

function WorkspaceHeader({
  query,
  refreshing,
  onQueryChange,
  onRefresh,
  selected,
}: Pick<AnalyticsWorkspaceProps, "query" | "refreshing" | "onQueryChange" | "onRefresh"> & { selected?: AnalyticsSnapshot }) {
  return (
    <header className="border-b border-border bg-sidebar/45">
      <div className={`${pageInner} grid gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 border border-primary/35 bg-primary/[0.06] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-primary">
              <Activity className="h-3 w-3" aria-hidden="true" /> Analytics
            </span>
            {selected ? (
              <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {selected.provenance.network} · {selected.provenance.mode}
              </span>
            ) : null}
          </div>
          <h1 className="mt-3 text-balance text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">XRPL market workspace</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Inspect real DEX and AMM observations, executable-liquidity estimates, and bounded peer comparisons. Every panel keeps its network, issuer identity, source, units, and observation time attached.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative min-w-0 sm:w-72">
            <span className="sr-only">Search markets</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange?.(event.currentTarget.value)}
              placeholder="Search pair, issuer, network"
              className="h-10 w-full border border-input bg-background pl-9 pr-3 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary disabled:opacity-50"
              disabled={!onQueryChange}
            />
          </label>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!onRefresh || refreshing}
            className="bracket bracket-light inline-flex h-10 items-center justify-center gap-2 border border-border bg-card px-4 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            {refreshing ? "Refreshing" : "Refresh reads"}
          </button>
        </div>
      </div>
    </header>
  );
}

function MarketRail({ snapshots, selectedId, query, onSelect }: { snapshots: AnalyticsSnapshot[]; selectedId?: string; query: string; onSelect?: (id: string) => void }) {
  return (
    <aside className="min-w-0 self-start border border-border bg-card xl:sticky xl:top-4" aria-label="Market pairs">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-sidebar/40 px-4 py-3">
        <div>
          <p className={label}>Observed universe</p>
          <h2 className="text-sm font-semibold">Market pairs</h2>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{snapshots.length}</span>
      </div>
      {snapshots.length ? (
        <div className="flex snap-x gap-px overflow-x-auto bg-border p-px xl:block xl:max-h-[calc(100dvh-13rem)] xl:overflow-y-auto xl:overflow-x-hidden" role="listbox" aria-label="Select market pair">
          {snapshots.map((snapshot) => {
            const selected = snapshot.id === selectedId;
            return (
              <button
                key={snapshot.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect?.(snapshot.id)}
                disabled={!onSelect}
                className={`min-w-[14rem] snap-start bg-card px-4 py-3 text-left transition xl:block xl:w-full xl:min-w-0 ${selected ? "bracket bracket-accent bg-primary/[0.05]" : "hover:bg-white/[0.04]"} disabled:cursor-default`}
              >
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground">{snapshot.label}</span>
                  <StateDot status={snapshot.status} />
                </div>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`${label} truncate`}>{snapshot.provenance.network} · {snapshot.provenance.source}</p>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{snapshot.base.symbol}/{snapshot.quote.symbol}</p>
                  </div>
                  <p className="shrink-0 font-mono text-sm tabular-nums text-foreground">{formatMetric(snapshot.price, 5)}</p>
                </div>
              </button>
            );
          })}
        </div>
      ) : <FilteredEmpty query={query} compact />}
    </aside>
  );
}

function MarketIdentity({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const last = snapshot.history.points.at(-2)?.price ?? null;
  return (
    <section className="bracket bracket-light border border-border bg-card px-4 py-4 sm:px-5" aria-labelledby="selected-market-title">
      <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className={label}>Selected market</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="selected-market-title" className="truncate text-xl font-semibold tracking-[-0.025em] sm:text-2xl">{snapshot.label}</h2>
            <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{snapshot.base.symbol} / {snapshot.quote.symbol}</span>
          </div>
          <div className="mt-2"><PriceDirection current={snapshot.price} previous={last} /></div>
        </div>
        <div className="shrink-0 md:text-right">
          <p className={label}>Observed midpoint</p>
          <p className="mt-1 font-mono text-2xl tabular-nums text-foreground">{formatMetric(snapshot.price, 6)}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{snapshot.priceUnit}</p>
        </div>
      </div>
    </section>
  );
}

function StateDot({ status }: { status: AnalyticsSnapshot["status"] }) {
  const className = status === "ready" ? "bg-executed" : status === "partial" ? "bg-approval" : status === "error" ? "bg-destructive" : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} aria-label={status} title={status} />;
}

function WorkspaceLoading() {
  return (
    <div aria-live="polite" aria-busy="true" aria-label="Loading market analytics" className="grid gap-5 xl:grid-cols-[13rem_minmax(0,1fr)_18rem]">
      <div className="h-72 animate-pulse border border-border bg-card motion-reduce:animate-none" />
      <div className="space-y-5">
        <div className="h-28 animate-pulse border border-border bg-card motion-reduce:animate-none" />
        <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-20 animate-pulse bg-card motion-reduce:animate-none" />)}
        </div>
        <div className="h-80 animate-pulse border border-border bg-card motion-reduce:animate-none" />
      </div>
      <div className="hidden h-[34rem] animate-pulse border border-border bg-card motion-reduce:animate-none xl:block" />
    </div>
  );
}

function WorkspaceError({ message, onRefresh }: { message: string; onRefresh?: () => void }) {
  return (
    <div className="flex min-h-[26rem] items-center justify-center border border-destructive/35 bg-card px-6 py-12 text-center" role="alert">
      <div className="max-w-lg">
        <AlertTriangle className="mx-auto h-6 w-6 text-destructive" aria-hidden="true" />
        <p className="mt-4 text-lg font-semibold">Market reads unavailable</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
        {onRefresh ? (
          <button type="button" onClick={onRefresh} className="bracket bracket-light mt-5 inline-flex h-10 items-center gap-2 border border-border bg-background px-4 font-mono text-[10px] uppercase tracking-wide">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry reads
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceEmpty() {
  return (
    <div className="flex min-h-[26rem] items-center justify-center border border-border bg-card px-6 py-12 text-center">
      <div className="max-w-lg">
        <CircleDot className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="mt-4 text-lg font-semibold">No market observations</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">No configured pair returned a usable read. Pilot does not fill empty panels with generated market data.</p>
      </div>
    </div>
  );
}

function FilteredEmpty({ query, compact = false }: { query: string; compact?: boolean }) {
  return (
    <div className={`${compact ? "px-4 py-8" : "border border-border bg-card px-6 py-16"} text-center`}>
      <Search className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium">No matching markets</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">No observed pair matches “{query}”.</p>
    </div>
  );
}

function ReadOnlyFootnote() {
  return (
    <footer className="flex flex-col gap-3 border border-border bg-sidebar/35 px-4 py-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-executed" aria-hidden="true" />
        <p className="leading-6"><span className="font-medium text-foreground">Read-only analytics.</span> Access to these observations does not grant signing or execution authority.</p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wide">
        Harbor reads <ArrowRight className="h-3 w-3" aria-hidden="true" /> typed UI
      </span>
    </footer>
  );
}
