"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock3,
  Database,
  Droplets,
  Gauge,
  Layers3,
} from "lucide-react";
import React, { type ReactNode } from "react";

export type AnalyticsNetwork = "mainnet" | "testnet" | "devnet" | "lending-devnet";
export type AnalyticsMode = "live" | "demo";
export type AnalyticsDataStatus = "ready" | "partial" | "empty" | "error";

export type AnalyticsAsset = {
  symbol: string;
  currency: string;
  issuer?: string;
};

export type AnalyticsProvenance = {
  network: AnalyticsNetwork;
  source: string;
  observedAt: string;
  ledgerIndex?: number;
  freshnessMs?: number;
  stale?: boolean;
  mode: AnalyticsMode;
};

export type AnalyticsHistoryPoint = {
  at: string;
  price: number;
  ledgerIndex?: number;
  /** Starts a new observed segment; no line is inferred across the gap. */
  gapBefore?: boolean;
};

export type AnalyticsDepthLevel = {
  side: "bid" | "ask";
  price: number;
  size: number;
  cumulative: number;
  offers: number;
};

export type AnalyticsLiquidityQuote = {
  id: string;
  inputAmount: number;
  estimatedOutput: number | null;
  averagePrice: number | null;
  priceImpactBps: number | null;
  route: string;
  available: boolean;
  reason?: string;
};

export type AnalyticsComparison = {
  id: string;
  label: string;
  venue: string;
  price: number | null;
  spreadBps: number | null;
  depth: number | null;
  depthUnit: string;
  observedAt: string;
  status: "available" | "partial" | "unavailable";
  note?: string;
};

export type AnalyticsAmmState = {
  account?: string;
  baseReserve: number;
  quoteReserve: number;
  feeBps: number | null;
  lpSupply?: number | null;
  reserveUnit: string;
};

export type AnalyticsSnapshot = {
  id: string;
  label: string;
  base: AnalyticsAsset;
  quote: AnalyticsAsset;
  status: AnalyticsDataStatus;
  unavailableReason?: string;
  provenance: AnalyticsProvenance;
  price: number | null;
  priceUnit: string;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  depthUnit: string;
  history: {
    points: AnalyticsHistoryPoint[];
    startedAt?: string;
    endedAt?: string;
    coverage: "sampled-live" | "source-history" | "illustrative-fixture";
    incomplete?: boolean;
  };
  depth: AnalyticsDepthLevel[];
  liquidity: AnalyticsLiquidityQuote[];
  comparisons: AnalyticsComparison[];
  amm?: AnalyticsAmmState | null;
};

const panel = "border border-border bg-card";
const label = "font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
const value = "font-mono tabular-nums text-foreground";

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatMetric(value: number | null | undefined, maximumFractionDigits = 4): string {
  if (!finite(value)) return "Unavailable";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatObservedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function elapsed(value?: number): string {
  if (!finite(value)) return "age unavailable";
  if (value < 1_000) return `${Math.max(0, Math.round(value))} ms old`;
  if (value < 60_000) return `${Math.round(value / 1_000)} s old`;
  return `${Math.round(value / 60_000)} min old`;
}

function assetIdentity(asset: AnalyticsAsset): string {
  if (!asset.issuer) return `${asset.currency} (native)`;
  return `${asset.currency} · ${asset.issuer}`;
}

export function ProvenanceBar({ provenance, base, quote }: { provenance: AnalyticsProvenance; base: AnalyticsAsset; quote: AnalyticsAsset }) {
  const stale = provenance.stale === true;
  return (
    <div className="grid gap-px border-y border-border bg-border sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.1fr_1.2fr]" aria-label="Market data provenance">
      <ProvenanceCell icon={<Database className="h-3.5 w-3.5" aria-hidden="true" />} title="Source" value={provenance.source} />
      <ProvenanceCell
        icon={<Layers3 className="h-3.5 w-3.5" aria-hidden="true" />}
        title="Network / ledger"
        value={`${provenance.network}${provenance.ledgerIndex === undefined ? "" : ` · ${provenance.ledgerIndex.toLocaleString()}`}`}
      />
      <ProvenanceCell
        icon={<Clock3 className="h-3.5 w-3.5" aria-hidden="true" />}
        title="Observed"
        value={`${formatObservedAt(provenance.observedAt)} · ${elapsed(provenance.freshnessMs)}`}
        tone={stale ? "warning" : "default"}
      />
      <div className="min-w-0 bg-card px-4 py-3">
        <p className={label}>Asset identities</p>
        <p className="mt-1 truncate font-mono text-[11px] text-foreground" title={`${assetIdentity(base)} / ${assetIdentity(quote)}`}>
          {assetIdentity(base)} / {assetIdentity(quote)}
        </p>
      </div>
    </div>
  );
}

function ProvenanceCell({ icon, title, value: cellValue, tone = "default" }: { icon: ReactNode; title: string; value: string; tone?: "default" | "warning" }) {
  return (
    <div className="min-w-0 bg-card px-4 py-3">
      <p className={`${label} flex items-center gap-2`}>{icon}{title}</p>
      <p className={`mt-1 truncate font-mono text-[11px] ${tone === "warning" ? "text-approval" : "text-foreground"}`} title={cellValue}>{cellValue}</p>
    </div>
  );
}

export function MetricStrip({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const metrics = [
    { label: "Observed mid", value: formatMetric(snapshot.price), suffix: snapshot.priceUnit },
    { label: "Best bid", value: formatMetric(snapshot.bestBid), suffix: snapshot.priceUnit },
    { label: "Best ask", value: formatMetric(snapshot.bestAsk), suffix: snapshot.priceUnit },
    { label: "Spread", value: formatMetric(snapshot.spreadBps, 1), suffix: finite(snapshot.spreadBps) ? "bps" : "" },
    { label: "Bid depth read", value: formatMetric(snapshot.bidDepth, 2), suffix: snapshot.depthUnit },
    { label: "Ask depth read", value: formatMetric(snapshot.askDepth, 2), suffix: snapshot.depthUnit },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 xl:grid-cols-6" aria-label="Observed market metrics">
      {metrics.map((metric) => (
        <div key={metric.label} className="min-w-0 bg-card px-4 py-4">
          <dt className={label}>{metric.label}</dt>
          <dd className="mt-2 flex min-w-0 items-baseline gap-1.5">
            <span className={`${value} truncate text-base`}>{metric.value}</span>
            {metric.suffix ? <span className="truncate font-mono text-[10px] text-muted-foreground">{metric.suffix}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DataStateNotice({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  if (snapshot.status === "ready") return null;
  const copy = snapshot.status === "partial"
    ? "Some upstream observations are unavailable. Available cells retain their own timestamp and source."
    : snapshot.status === "empty"
      ? snapshot.unavailableReason ?? "No funded liquidity was observed for this pair."
      : snapshot.unavailableReason ?? "The source did not return a usable observation.";
  return (
    <div className={`flex items-start gap-3 border px-4 py-3 ${snapshot.status === "error" ? "border-destructive/35 bg-destructive/[0.06]" : "border-approval/35 bg-approval/[0.06]"}`} role={snapshot.status === "error" ? "alert" : "status"}>
      <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${snapshot.status === "error" ? "text-destructive" : "text-approval"}`} aria-hidden="true" />
      <div>
        <p className={`${label} ${snapshot.status === "error" ? "text-destructive" : "text-approval"}`}>{snapshot.status} data</p>
        <p className="mt-1 text-sm leading-6 text-foreground">{copy}</p>
      </div>
    </div>
  );
}

export function PriceCoveragePanel({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const points = snapshot.history.points.filter((point) => finite(point.price) && point.price > 0);
  const width = 720;
  const height = 240;
  const pad = { top: 22, right: 18, bottom: 32, left: 58 };
  const prices = points.map((point) => point.price);
  const rawMin = prices.length ? Math.min(...prices) : 0;
  const rawMax = prices.length ? Math.max(...prices) : 1;
  const margin = rawMax === rawMin ? Math.max(rawMax * 0.01, 0.01) : (rawMax - rawMin) * 0.08;
  const min = rawMin - margin;
  const max = rawMax + margin;
  const x = (index: number) => pad.left + (index / Math.max(points.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (price: number) => pad.top + ((max - price) / Math.max(max - min, 1e-12)) * (height - pad.top - pad.bottom);
  const segments: Array<Array<{ point: AnalyticsHistoryPoint; index: number }>> = [];
  points.forEach((point, index) => {
    if (segments.length === 0 || point.gapBefore) segments.push([]);
    segments.at(-1)!.push({ point, index });
  });
  const drawableSegments = segments.filter((segment) => segment.length > 1);
  const coverageStart = snapshot.history.startedAt ?? points[0]?.at;
  const coverageEnd = snapshot.history.endedAt ?? points.at(-1)?.at;
  const gapCount = Math.max(0, segments.length - 1);
  const coverageDescription = snapshot.history.coverage === "sampled-live"
    ? "a session sample, not historical candles"
    : snapshot.history.coverage === "illustrative-fixture"
      ? "an illustrative fixture, not a ledger observation"
      : "source-provided history";
  const description = `${snapshot.label} observed-price series with ${points.length} observations${coverageStart ? ` beginning ${formatObservedAt(coverageStart)}` : ""}. ${gapCount} explicit sampling gap${gapCount === 1 ? "" : "s"}. This is ${coverageDescription}.`;

  return (
    <section className={panel} aria-labelledby="market-price-coverage-title">
      <PanelHeader
        icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
        eyebrow="Observed price"
        title="Price coverage"
        aside={<CoverageBadge coverage={snapshot.history.coverage} incomplete={snapshot.history.incomplete} />}
      />
      <div className="px-4 py-4 sm:px-5">
        {points.length > 1 && drawableSegments.length > 0 ? (
          <figure>
            <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" preserveAspectRatio="none" role="img" aria-label={description}>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const tickPrice = max - (max - min) * ratio;
                const tickY = pad.top + ratio * (height - pad.top - pad.bottom);
                return (
                  <g key={ratio}>
                    <line x1={pad.left} x2={width - pad.right} y1={tickY} y2={tickY} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
                    <text x={pad.left - 9} y={tickY} textAnchor="end" dominantBaseline="middle" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">
                      {formatMetric(tickPrice, 4)}
                    </text>
                  </g>
                );
              })}
              {drawableSegments.map((segment, segmentIndex) => (
                <polyline
                  key={`${segment[0]!.point.at}-${segmentIndex}`}
                  points={segment.map(({ point, index }) => `${x(index)},${y(point.price)}`).join(" ")}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {points.map((point, index) => (
                <circle key={`${point.at}-${index}`} cx={x(index)} cy={y(point.price)} r="2.5" fill="var(--card)" stroke="var(--primary)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
              ))}
              <text x={pad.left} y={height - 8} fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{coverageStart ? formatObservedAt(coverageStart) : "start unavailable"}</text>
              <text x={width - pad.right} y={height - 8} textAnchor="end" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{coverageEnd ? formatObservedAt(coverageEnd) : "end unavailable"}</text>
            </svg>
            <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{points.length} observations</span>
              <span>{snapshot.priceUnit}</span>
              <span>{snapshot.history.coverage === "sampled-live" ? "Captured since this live session began" : snapshot.history.coverage === "illustrative-fixture" ? "Illustrative fixture · never live" : "Coverage reported by source"}{gapCount ? ` · ${gapCount} gap${gapCount === 1 ? "" : "s"}` : ""}</span>
            </figcaption>
          </figure>
        ) : (
          <PanelEmpty title="Not enough observations to draw a series" detail="Pilot will not synthesize candles from a single quote. The current observation remains available in the metric strip." />
        )}
      </div>
    </section>
  );
}

function CoverageBadge({ coverage, incomplete }: { coverage: AnalyticsSnapshot["history"]["coverage"]; incomplete?: boolean }) {
  return (
    <span className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${incomplete ? "border-approval/40 bg-approval/[0.07] text-approval" : "border-border text-muted-foreground"}`}>
      {coverage === "sampled-live" ? "sampled live" : coverage === "illustrative-fixture" ? "illustrative fixture" : "source history"}{incomplete ? " · incomplete" : ""}
    </span>
  );
}

export function DepthAndLiquidityPanel({ snapshot, compact = false }: { snapshot: AnalyticsSnapshot; compact?: boolean }) {
  const bids = snapshot.depth.filter((level) => level.side === "bid" && finite(level.price) && finite(level.cumulative));
  const asks = snapshot.depth.filter((level) => level.side === "ask" && finite(level.price) && finite(level.cumulative));
  const maxDepth = Math.max(1, ...snapshot.depth.map((level) => level.cumulative));
  const rows = Math.max(bids.length, asks.length);
  return (
    <section className={panel} aria-labelledby="market-depth-title">
      <PanelHeader icon={<Layers3 className="h-4 w-4" aria-hidden="true" />} eyebrow="Funded offers" title="Order-book depth" aside={<span className={label}>Top {rows} levels read</span>} />
      {rows ? (
        <div className={`grid ${compact ? "grid-cols-1" : "lg:grid-cols-2"}`}>
          <DepthSide side="bid" levels={bids} maxDepth={maxDepth} unit={snapshot.depthUnit} compact={compact} />
          <DepthSide side="ask" levels={asks} maxDepth={maxDepth} unit={snapshot.depthUnit} compact={compact} />
        </div>
      ) : (
        <PanelEmpty title="No funded order-book levels" detail="The source returned no usable funded offers. Zero depth is shown as unavailable, not as a liquid market." />
      )}
    </section>
  );
}

function DepthSide({ side, levels, maxDepth, unit, compact }: { side: "bid" | "ask"; levels: AnalyticsDepthLevel[]; maxDepth: number; unit: string; compact: boolean }) {
  const isBid = side === "bid";
  return (
    <div className={`min-w-0 px-4 py-4 sm:px-5 ${isBid ? compact ? "border-b border-border" : "border-b border-border lg:border-b-0 lg:border-r" : ""}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className={`${label} ${isBid ? "text-executed" : "text-destructive"}`}>{isBid ? "Bids" : "Asks"}</p>
        <p className={label}>Price · size · offers</p>
      </div>
      {levels.length ? (
        <ol className="space-y-px" aria-label={`${isBid ? "Bid" : "Ask"} depth levels`}>
          {levels.slice(0, 8).map((level, index) => (
            <li key={`${side}-${level.price}-${index}`} className="relative grid grid-cols-[1fr_auto_auto] items-center gap-3 overflow-hidden border-b border-border/70 px-2 py-2 font-mono text-[11px] tabular-nums last:border-0">
              <span aria-hidden="true" className={`absolute inset-y-1 ${isBid ? "right-0 bg-executed/[0.08]" : "left-0 bg-destructive/[0.08]"}`} style={{ width: `${Math.min(100, (level.cumulative / maxDepth) * 100)}%` }} />
              <span className={`relative ${isBid ? "text-executed" : "text-destructive"}`}>{formatMetric(level.price, 6)}</span>
              <span className="relative text-right text-foreground">{formatMetric(level.size, 3)} <span className="text-muted-foreground">{unit}</span></span>
              <span className="relative text-right text-muted-foreground">{level.offers}</span>
            </li>
          ))}
        </ol>
      ) : <p className="py-8 text-center text-sm text-muted-foreground">No {side} levels observed.</p>}
    </div>
  );
}

export function SlippagePanel({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  return (
    <section className={panel} aria-labelledby="market-slippage-title">
      <PanelHeader icon={<Gauge className="h-4 w-4" aria-hidden="true" />} eyebrow="Executable estimate" title="Liquidity & slippage" aside={<span className={label}>Read-only estimate</span>} />
      {snapshot.liquidity.length ? (
        <div className="divide-y divide-border">
          {snapshot.liquidity.map((quote) => (
            <div key={quote.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(7rem,1fr)_repeat(3,minmax(0,1fr))] sm:px-5">
              <div>
                <p className={label}>Input</p>
                <p className={`mt-1 ${value}`}>{formatMetric(quote.inputAmount, 4)} {snapshot.base.symbol}</p>
              </div>
              <MetricCell title="Est. output" value={quote.available ? formatMetric(quote.estimatedOutput, 4) : "Unavailable"} suffix={quote.available ? snapshot.quote.symbol : undefined} />
              <MetricCell title="Average price" value={quote.available ? formatMetric(quote.averagePrice, 6) : "Unavailable"} suffix={quote.available ? snapshot.priceUnit : undefined} />
              <div className="flex items-end justify-between gap-3 sm:block">
                <MetricCell title="Price impact" value={quote.available ? formatMetric(quote.priceImpactBps, 1) : "Unavailable"} suffix={quote.available && finite(quote.priceImpactBps) ? "bps" : undefined} />
                <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground" title={quote.reason ?? quote.route}>{quote.available ? quote.route : quote.reason ?? "No executable route"}</p>
              </div>
            </div>
          ))}
        </div>
      ) : <PanelEmpty title="No quote sizes requested" detail="Executable estimates appear only after a bounded Harbor quote succeeds. A midpoint alone is not used as a fill estimate." />}
    </section>
  );
}

function MetricCell({ title, value: metricValue, suffix }: { title: string; value: string; suffix?: string }) {
  return (
    <div className="min-w-0">
      <p className={label}>{title}</p>
      <p className={`mt-1 truncate ${value}`}>{metricValue}{suffix ? <span className="ml-1 text-[10px] text-muted-foreground">{suffix}</span> : null}</p>
    </div>
  );
}

export function AmmStatePanel({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const amm = snapshot.amm;
  return (
    <section className={panel} aria-labelledby="market-amm-title">
      <PanelHeader icon={<Droplets className="h-4 w-4" aria-hidden="true" />} eyebrow="XRPL AMM" title="Pool state" aside={<span className={label}>Ledger observation</span>} />
      {amm ? (
        <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          <PoolMetric label={`${snapshot.base.symbol} reserve`} value={formatMetric(amm.baseReserve, 3)} suffix={amm.reserveUnit} />
          <PoolMetric label={`${snapshot.quote.symbol} reserve`} value={formatMetric(amm.quoteReserve, 3)} suffix={snapshot.quote.symbol} />
          <PoolMetric label="Trading fee" value={formatMetric(amm.feeBps, 1)} suffix={finite(amm.feeBps) ? "bps" : ""} />
          <PoolMetric label="LP token supply" value={formatMetric(amm.lpSupply, 4)} />
        </dl>
      ) : <PanelEmpty title="No matching AMM observed" detail="Pool metrics stay unavailable when amm_info has no matching pool or the reserve assets cannot be identified unambiguously." />}
    </section>
  );
}

function PoolMetric({ label: metricLabel, value: metricValue, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="min-w-0 bg-card px-4 py-4">
      <dt className={label}>{metricLabel}</dt>
      <dd className={`mt-2 truncate ${value}`}>{metricValue}{suffix ? <span className="ml-1 text-[10px] text-muted-foreground">{suffix}</span> : null}</dd>
    </div>
  );
}

export function ComparisonScannerPanel({ snapshot, selectedId, onSelect }: { snapshot: AnalyticsSnapshot; selectedId?: string; onSelect?: (id: string) => void }) {
  return (
    <section className={panel} aria-labelledby="market-comparison-title">
      <PanelHeader icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />} eyebrow="Observed peers" title="Market comparison" aside={<span className={label}>{snapshot.comparisons.length} observations</span>} />
      {snapshot.comparisons.length ? (
        <ul className="divide-y divide-border" aria-label="Observed market comparison scanner">
          {snapshot.comparisons.map((row) => {
            const interactive = typeof onSelect === "function";
            const selected = selectedId === row.id;
            const content = (
              <>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusMark status={row.status} />
                    <p className="truncate text-sm font-medium text-foreground">{row.label}</p>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{row.venue}</p>
                </div>
                <ScannerMetric label="Price" value={formatMetric(row.price, 6)} />
                <ScannerMetric label="Spread" value={formatMetric(row.spreadBps, 1)} suffix={finite(row.spreadBps) ? "bps" : undefined} />
                <ScannerMetric label="Depth read" value={formatMetric(row.depth, 2)} suffix={finite(row.depth) ? row.depthUnit : undefined} />
                <div className="min-w-0 sm:text-right">
                  <p className={label}>Observed</p>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{formatObservedAt(row.observedAt)}</p>
                  {row.note ? <p className="mt-1 truncate text-xs text-muted-foreground" title={row.note}>{row.note}</p> : null}
                </div>
              </>
            );
            const className = `grid w-full gap-3 px-4 py-4 text-left sm:grid-cols-[minmax(9rem,1.3fr)_repeat(3,minmax(5rem,.7fr))_minmax(9rem,1fr)] sm:items-center sm:px-5 ${selected ? "bracket bracket-accent bg-primary/[0.05]" : interactive ? "hover:bg-white/[0.03]" : ""}`;
            return (
              <li key={row.id}>
                {interactive ? <button type="button" className={className} aria-pressed={selected} onClick={() => onSelect(row.id)}>{content}</button> : <div className={className}>{content}</div>}
              </li>
            );
          })}
        </ul>
      ) : <PanelEmpty title="No comparable observations" detail="The scanner compares only pairs returned by the current source set. Missing peers are not estimated." />}
    </section>
  );
}

function ScannerMetric({ label: metricLabel, value: metricValue, suffix }: { label: string; value: string; suffix?: string }) {
  return <div className="min-w-0"><p className={label}>{metricLabel}</p><p className={`mt-1 truncate text-sm ${value}`}>{metricValue}{suffix ? <span className="ml-1 text-[10px] text-muted-foreground">{suffix}</span> : null}</p></div>;
}

function StatusMark({ status }: { status: AnalyticsComparison["status"] }) {
  const tone = status === "available" ? "bg-executed" : status === "partial" ? "bg-approval" : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-label={status} />;
}

export function PanelHeader({ icon, eyebrow, title, aside }: { icon: ReactNode; eyebrow: string; title: string; aside?: ReactNode }) {
  const id = title === "Price coverage" ? "market-price-coverage-title"
    : title === "Order-book depth" ? "market-depth-title"
      : title === "Liquidity & slippage" ? "market-slippage-title"
        : title === "Pool state" ? "market-amm-title"
          : title === "Market comparison" ? "market-comparison-title"
            : undefined;
  return (
    <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border bg-sidebar/40 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center border border-border bg-white/[0.03] text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <p className={label}>{eyebrow}</p>
          <h2 id={id} className="truncate text-sm font-semibold text-foreground">{title}</h2>
        </div>
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}

function PanelEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center px-6 py-10 text-center">
      <div className="max-w-md">
        <AlertTriangle className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function PriceDirection({ current, previous }: { current: number | null; previous: number | null }) {
  if (!finite(current) || !finite(previous) || previous === 0) return <span className={label}>Change unavailable</span>;
  const delta = ((current - previous) / previous) * 100;
  const rising = delta >= 0;
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] tabular-nums ${rising ? "text-executed" : "text-destructive"}`}>
      {rising ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />}
      {rising ? "+" : ""}{formatMetric(delta, 2)}% <span className="text-muted-foreground">within observed coverage</span>
    </span>
  );
}
