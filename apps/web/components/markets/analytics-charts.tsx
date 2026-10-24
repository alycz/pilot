import React, { type ReactNode } from "react";

export type AnalyticsCoverage = {
  source: string;
  observedAt?: string | null;
  coverageStart?: string | null;
  coverageEnd?: string | null;
  status?: "ready" | "partial" | "stale" | "insufficient" | "unavailable";
  detail?: string;
};

export type PriceObservation = {
  at: string;
  value: number;
  ledgerIndex?: number;
  /** Starts a new observed segment. No line is drawn across the gap. */
  gapBefore?: boolean;
};

export type DepthObservation = {
  price: number;
  cumulative: number;
};

export type SlippageObservation = {
  input: number;
  slippageBps: number;
  output?: number;
};

export type ScannerObservation = {
  id: string;
  label: string;
  value: number | null;
  detail?: string;
  status?: "observed" | "partial" | "unavailable";
};

const VIEWBOX_WIDTH = 720;
const VIEWBOX_HEIGHT = 248;
const PAD = { top: 18, right: 18, bottom: 36, left: 58 };

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function formatNumber(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatMoment(value?: string | null): string {
  if (!value) return "not supplied";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

function linearScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  const span = domainMax - domainMin;
  if (!(span > 0)) return () => (rangeMin + rangeMax) / 2;
  return (value: number) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

function ticks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  return Array.from({ length: count + 1 }, (_, index) => min + ((max - min) * index) / count);
}

function statusLabel(status: AnalyticsCoverage["status"]): string {
  switch (status) {
    case "partial": return "Partial coverage";
    case "stale": return "Stale observation";
    case "insufficient": return "Insufficient observations";
    case "unavailable": return "Data unavailable";
    default: return "Observed data";
  }
}

function ChartShell({
  title,
  subtitle,
  coverage,
  children,
  summary,
}: {
  title: string;
  subtitle: string;
  coverage: AnalyticsCoverage;
  children: ReactNode;
  summary: string;
}) {
  const status = coverage.status ?? "ready";
  return (
    <figure className="m-0 min-w-0 border border-border bg-card" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <span
          className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${
            status === "ready"
              ? "border-executed/30 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]"
              : status === "stale" || status === "partial"
                ? "border-approval/30 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]"
                : "border-border text-muted-foreground"
          }`}
        >
          {statusLabel(status)}
        </span>
      </div>
      <div className="min-w-0 p-3 sm:p-4">{children}</div>
      <figcaption className="border-t border-border px-4 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
        <span>{coverage.source}</span>
        <span aria-hidden="true"> · </span>
        <span>observed {formatMoment(coverage.observedAt)}</span>
        {coverage.coverageStart || coverage.coverageEnd ? (
          <>
            <span aria-hidden="true"> · </span>
            <span>coverage {formatMoment(coverage.coverageStart)} → {formatMoment(coverage.coverageEnd)}</span>
          </>
        ) : null}
        {coverage.detail ? <><span aria-hidden="true"> · </span><span>{coverage.detail}</span></> : null}
        <span className="sr-only"> {summary}</span>
      </figcaption>
    </figure>
  );
}

function EmptyPlot({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex min-h-52 items-center justify-center border border-dashed border-border bg-background px-6 text-center">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-wide text-foreground">{label}</p>
        <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function AxisGrid({ min, max, y }: { min: number; max: number; y: (value: number) => number }) {
  return ticks(min, max).map((tick) => (
    <g key={tick}>
      <line x1={PAD.left} x2={VIEWBOX_WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth="1" />
      <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">
        {formatNumber(tick)}
      </text>
    </g>
  ));
}

/** A line over timestamped observations. `gapBefore` prevents invented interpolation. */
export function SampledPriceChart({
  observations,
  baseLabel,
  quoteLabel,
  coverage,
}: {
  observations: readonly PriceObservation[];
  baseLabel: string;
  quoteLabel: string;
  coverage: AnalyticsCoverage;
}) {
  const valid = observations
    .map((point) => ({ ...point, time: new Date(point.at).getTime() }))
    .filter((point) => finite(point.value) && point.value >= 0 && finite(point.time))
    .sort((left, right) => left.time - right.time);
  const segments: typeof valid[] = [];
  for (const point of valid) {
    if (point.gapBefore || segments.length === 0) segments.push([]);
    segments.at(-1)!.push(point);
  }
  const drawable = segments.filter((segment) => segment.length >= 2);
  const enough = valid.length >= 2 && drawable.length > 0 && coverage.status !== "unavailable";
  const title = `${baseLabel}/${quoteLabel} sampled price`;
  const subtitle = `Observed ${quoteLabel} per ${baseLabel}; not an inferred candle series.`;

  if (!enough) {
    return (
      <ChartShell title={title} subtitle={subtitle} coverage={{ ...coverage, status: coverage.status === "unavailable" ? "unavailable" : "insufficient" }} summary="No price line is shown because fewer than two connected observations are available.">
        <EmptyPlot label={coverage.status === "unavailable" ? "Data unavailable" : "Insufficient observations"} detail="At least two timestamped observations in one continuous sample window are required. Pilot does not fabricate history between reads." />
      </ChartShell>
    );
  }

  const minTime = valid[0]!.time;
  const maxTime = valid.at(-1)!.time;
  const rawMin = Math.min(...valid.map((point) => point.value));
  const rawMax = Math.max(...valid.map((point) => point.value));
  const valuePad = (rawMax - rawMin || Math.max(rawMax * 0.01, 1e-9)) * 0.08;
  const minValue = Math.max(0, rawMin - valuePad);
  const maxValue = rawMax + valuePad;
  const x = linearScale(minTime, maxTime, PAD.left, VIEWBOX_WIDTH - PAD.right);
  const y = linearScale(minValue, maxValue, VIEWBOX_HEIGHT - PAD.bottom, PAD.top);
  const summary = `${valid.length} real observations from ${formatMoment(valid[0]!.at)} through ${formatMoment(valid.at(-1)!.at)}. ${segments.length - 1} explicit sampling gap${segments.length - 1 === 1 ? "" : "s"}.`;

  return (
    <ChartShell title={title} subtitle={subtitle} coverage={coverage} summary={summary}>
      <svg className="block h-auto w-full" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="img" aria-label={summary}>
        <AxisGrid min={minValue} max={maxValue} y={y} />
        {drawable.map((segment, index) => (
          <path
            key={`${segment[0]!.at}-${index}`}
            data-series="price-observations"
            d={segment.map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"} ${x(point.time)} ${y(point.value)}`).join(" ")}
            fill="none"
            stroke="var(--chart-3)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {valid.map((point) => (
          <circle key={`${point.at}-${point.ledgerIndex ?? "sample"}`} cx={x(point.time)} cy={y(point.value)} r="3" fill="var(--card)" stroke="var(--chart-3)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}
        <text x={PAD.left} y={VIEWBOX_HEIGHT - 10} fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">{formatMoment(valid[0]!.at).slice(0, 16)}</text>
        <text x={VIEWBOX_WIDTH - PAD.right} y={VIEWBOX_HEIGHT - 10} textAnchor="end" fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">{formatMoment(valid.at(-1)!.at).slice(0, 16)}</text>
      </svg>
    </ChartShell>
  );
}

function stepPath(levels: readonly DepthObservation[], x: (value: number) => number, y: (value: number) => number, baseline: number): string {
  if (levels.length === 0) return "";
  let path = `M ${x(levels[0]!.price)} ${baseline}`;
  levels.forEach((level, index) => {
    path += ` V ${y(level.cumulative)}`;
    const next = levels[index + 1];
    if (next) path += ` H ${x(next.price)}`;
  });
  return path;
}

/** Cumulative observed book liquidity; missing sides remain visibly partial. */
export function OrderBookDepthChart({
  bids,
  asks,
  baseLabel,
  quoteLabel,
  coverage,
}: {
  bids: readonly DepthObservation[];
  asks: readonly DepthObservation[];
  baseLabel: string;
  quoteLabel: string;
  coverage: AnalyticsCoverage;
}) {
  const clean = (levels: readonly DepthObservation[]) => levels.filter((level) => finite(level.price) && level.price > 0 && finite(level.cumulative) && level.cumulative >= 0);
  const validBids = clean(bids).sort((left, right) => right.price - left.price);
  const validAsks = clean(asks).sort((left, right) => left.price - right.price);
  const all = [...validBids, ...validAsks];
  const partial = validBids.length === 0 || validAsks.length === 0;
  const title = `${baseLabel}/${quoteLabel} order-book depth`;
  const subtitle = `Cumulative observed ${baseLabel}; price in ${quoteLabel} per ${baseLabel}.`;
  if (all.length === 0 || coverage.status === "unavailable") {
    return (
      <ChartShell title={title} subtitle={subtitle} coverage={{ ...coverage, status: coverage.status === "unavailable" ? "unavailable" : "insufficient" }} summary="No depth curve is shown because no funded levels were observed.">
        <EmptyPlot label={coverage.status === "unavailable" ? "Data unavailable" : "No funded liquidity"} detail="The current read returned no valid funded order-book levels. A flat or synthetic depth curve would be misleading." />
      </ChartShell>
    );
  }
  const minPrice = Math.min(...all.map((level) => level.price));
  const maxPrice = Math.max(...all.map((level) => level.price));
  const pricePad = (maxPrice - minPrice || Math.max(maxPrice * 0.01, 1e-9)) * 0.05;
  const x = linearScale(minPrice - pricePad, maxPrice + pricePad, PAD.left, VIEWBOX_WIDTH - PAD.right);
  const maxDepth = Math.max(...all.map((level) => level.cumulative), 1);
  const y = linearScale(0, maxDepth * 1.05, VIEWBOX_HEIGHT - PAD.bottom, PAD.top);
  const baseline = y(0);
  const bidPath = stepPath(validBids, x, y, baseline);
  const askPath = stepPath(validAsks, x, y, baseline);
  const summary = `${validBids.length} bid levels and ${validAsks.length} ask levels. ${partial ? "Only one side was observed; spread and mid should not be inferred." : "Both sides were observed."}`;
  return (
    <ChartShell title={title} subtitle={subtitle} coverage={{ ...coverage, status: partial && coverage.status === "ready" ? "partial" : coverage.status }} summary={summary}>
      <div className="mb-2 flex gap-4 font-mono text-[10px] uppercase tracking-wide text-muted-foreground" aria-hidden="true">
        <span className="text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">— Bids</span>
        <span className="text-destructive">— Asks</span>
      </div>
      <svg className="block h-auto w-full" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="img" aria-label={summary}>
        <AxisGrid min={0} max={maxDepth * 1.05} y={y} />
        {bidPath ? <path data-series="bid-depth" d={bidPath} fill="none" stroke="var(--executed)" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null}
        {askPath ? <path data-series="ask-depth" d={askPath} fill="none" stroke="var(--destructive)" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null}
        <text x={PAD.left} y={VIEWBOX_HEIGHT - 10} fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">{formatNumber(minPrice)} {quoteLabel}</text>
        <text x={VIEWBOX_WIDTH - PAD.right} y={VIEWBOX_HEIGHT - 10} textAnchor="end" fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">{formatNumber(maxPrice)} {quoteLabel}</text>
      </svg>
    </ChartShell>
  );
}

/** Price impact measured from actual bounded quote observations. */
export function ExecutableSlippageChart({
  points,
  inputUnit,
  coverage,
}: {
  points: readonly SlippageObservation[];
  inputUnit: string;
  coverage: AnalyticsCoverage;
}) {
  const valid = points.filter((point) => finite(point.input) && point.input >= 0 && finite(point.slippageBps) && point.slippageBps >= 0).sort((left, right) => left.input - right.input);
  const title = "Executable slippage estimate";
  const subtitle = `Observed quote impact in basis points by ${inputUnit} input size.`;
  if (valid.length < 2 || coverage.status === "unavailable") {
    return (
      <ChartShell title={title} subtitle={subtitle} coverage={{ ...coverage, status: coverage.status === "unavailable" ? "unavailable" : "insufficient" }} summary="No slippage curve is shown because fewer than two valid quote sizes were observed.">
        <EmptyPlot label={coverage.status === "unavailable" ? "Quotes unavailable" : "Insufficient quote sizes"} detail="At least two bounded executable quote observations are required. Pilot does not extrapolate a slippage curve from one quote." />
      </ChartShell>
    );
  }
  const maxInput = Math.max(...valid.map((point) => point.input), 1);
  const maxBps = Math.max(...valid.map((point) => point.slippageBps), 1);
  const x = linearScale(0, maxInput, PAD.left, VIEWBOX_WIDTH - PAD.right);
  const y = linearScale(0, maxBps * 1.08, VIEWBOX_HEIGHT - PAD.bottom, PAD.top);
  const path = valid.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.input)} ${y(point.slippageBps)}`).join(" ");
  const summary = `${valid.length} executable quote observations, from ${formatNumber(valid[0]!.input)} to ${formatNumber(valid.at(-1)!.input)} ${inputUnit}. Maximum observed impact ${formatNumber(maxBps, 2)} basis points.`;
  return (
    <ChartShell title={title} subtitle={subtitle} coverage={coverage} summary={summary}>
      <svg className="block h-auto w-full" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="img" aria-label={summary}>
        <AxisGrid min={0} max={maxBps * 1.08} y={y} />
        <path data-series="slippage-observations" d={path} fill="none" stroke="var(--chart-2)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {valid.map((point) => <circle key={`${point.input}-${point.slippageBps}`} cx={x(point.input)} cy={y(point.slippageBps)} r="3" fill="var(--card)" stroke="var(--chart-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
        <text x={PAD.left} y={VIEWBOX_HEIGHT - 10} fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">0 {inputUnit}</text>
        <text x={VIEWBOX_WIDTH - PAD.right} y={VIEWBOX_HEIGHT - 10} textAnchor="end" fill="var(--muted-foreground)" fontFamily="var(--font-mono)" fontSize="10">{formatNumber(maxInput)} {inputUnit}</text>
      </svg>
    </ChartShell>
  );
}

/** Ranked bars for one directly comparable observed metric. */
export function ComparisonScannerBars({
  items,
  metricLabel,
  unit,
  coverage,
}: {
  items: readonly ScannerObservation[];
  metricLabel: string;
  unit: string;
  coverage: AnalyticsCoverage;
}) {
  const observed = items.filter((item): item is ScannerObservation & { value: number } => item.value !== null && finite(item.value) && item.status !== "unavailable");
  const max = Math.max(...observed.map((item) => Math.abs(item.value)), 0);
  const title = `${metricLabel} scanner`;
  const subtitle = `Like-for-like observed values in ${unit}; unavailable rows are not ranked.`;
  const summary = `${observed.length} of ${items.length} rows have comparable observed values.`;
  return (
    <ChartShell title={title} subtitle={subtitle} coverage={{ ...coverage, status: observed.length === 0 ? "insufficient" : coverage.status }} summary={summary}>
      {items.length === 0 ? (
        <EmptyPlot label="No comparison rows" detail="No observed markets were supplied for this metric." />
      ) : (
        <ol className="space-y-px" aria-label={`${metricLabel} comparison`}>
          {items.map((item) => {
            const available = item.value !== null && finite(item.value) && item.status !== "unavailable";
            const width = available && max > 0 ? Math.max(1.5, (Math.abs(item.value!) / max) * 100) : 0;
            return (
              <li key={item.id} className="grid grid-cols-[minmax(7rem,0.8fr)_minmax(8rem,2fr)_auto] items-center gap-3 border-b border-border/70 px-1 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{item.label}</p>
                  {item.detail ? <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{item.detail}</p> : null}
                </div>
                <div className="h-2 bg-muted" aria-hidden="true">
                  {available ? <div data-series="scanner-bar" className={`h-full ${item.status === "partial" ? "bg-approval" : "bg-info"}`} style={{ width: `${width}%` }} /> : null}
                </div>
                <span className={`min-w-20 text-right font-mono text-[11px] tabular-nums ${available ? "text-foreground" : "text-muted-foreground"}`}>
                  {available ? `${formatNumber(item.value!)} ${unit}` : "Unavailable"}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </ChartShell>
  );
}
