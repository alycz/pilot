"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  formatAmount,
  formatBps,
  formatPrice,
  ROUTE_LABELS,
  type DepthLevel,
  type RankedRoute,
} from "./markets-data";

/** Tracks an element's content width so SVG text stays at true pixel size. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, index) => min + step * index);
}

type HoverPoint = { side: "bid" | "ask"; level: DepthLevel; x: number; y: number };

/**
 * Cumulative depth chart: bids step down to the left of the mid, asks step
 * up to the right. Position and direct labels carry side identity, so the
 * green/red pair is never the only encoding.
 */
export function DepthChart({
  bids,
  asks,
  mid,
  baseSymbol,
  quoteSymbol,
  height: requestedHeight = 260,
}: {
  height?: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  mid: number | null;
  baseSymbol: string;
  quoteSymbol: string;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const height = width > 0 && width < 480 ? 220 : requestedHeight;
  const pad = { top: 28, right: 56, bottom: 28, left: 12 };
  const innerWidth = Math.max(0, width - pad.left - pad.right);
  const innerHeight = height - pad.top - pad.bottom;

  const geometry = useMemo(() => {
    const lowest = bids.at(-1)?.price ?? asks[0]?.price ?? 0;
    const highest = asks.at(-1)?.price ?? bids[0]?.price ?? 1;
    const span = highest - lowest || highest * 0.01 || 1;
    const minPrice = lowest - span * 0.02;
    const maxPrice = highest + span * 0.02;
    const maxDepth = Math.max(bids.at(-1)?.cumulative ?? 0, asks.at(-1)?.cumulative ?? 0, 1) * 1.08;
    const x = (price: number) => pad.left + ((price - minPrice) / (maxPrice - minPrice)) * innerWidth;
    const y = (depth: number) => pad.top + innerHeight - (depth / maxDepth) * innerHeight;
    const baseline = y(0);

    // Bids: start at best bid on the baseline, step outward (left).
    let bidPath = "";
    if (bids.length) {
      bidPath = `M ${x(bids[0]!.price)} ${baseline}`;
      bids.forEach((level, index) => {
        bidPath += ` V ${y(level.cumulative)}`;
        const next = bids[index + 1];
        bidPath += ` H ${next ? x(next.price) : x(minPrice)}`;
      });
    }
    let askPath = "";
    if (asks.length) {
      askPath = `M ${x(asks[0]!.price)} ${baseline}`;
      asks.forEach((level, index) => {
        askPath += ` V ${y(level.cumulative)}`;
        const next = asks[index + 1];
        askPath += ` H ${next ? x(next.price) : x(maxPrice)}`;
      });
    }
    const closeBid = bids.length ? `${bidPath} V ${baseline} Z` : "";
    const closeAsk = asks.length ? `${askPath} V ${baseline} Z` : "";
    return {
      x,
      y,
      baseline,
      minPrice,
      maxPrice,
      maxDepth,
      bidPath,
      askPath,
      closeBid,
      closeAsk,
      priceTicks: niceTicks(minPrice, maxPrice, width < 480 ? 3 : 5),
      depthTicks: niceTicks(0, maxDepth, 3),
    };
  }, [asks, bids, innerHeight, innerWidth, pad.left, pad.top, width]);

  const onPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left + pad.left;
    const price = geometry.minPrice + ((px - pad.left) / innerWidth) * (geometry.maxPrice - geometry.minPrice);
    const side: "bid" | "ask" = mid !== null && price < mid ? "bid" : "ask";
    const levels = side === "bid" ? bids : asks;
    // The cumulative depth at a price is the last level at or inside it.
    const level = side === "bid"
      ? [...levels].reverse().find((candidate) => candidate.price >= price) ?? levels[0]
      : [...levels].reverse().find((candidate) => candidate.price <= price) ?? levels[0];
    if (!level) return setHover(null);
    setHover({ side, level, x: geometry.x(level.price), y: geometry.y(level.cumulative) });
  };

  const summary = `Cumulative order-book depth for ${baseSymbol}/${quoteSymbol}. Best bid ${formatPrice(bids[0]?.price ?? null)}, best ask ${formatPrice(asks[0]?.price ?? null)}, ${formatAmount(bids.at(-1)?.cumulative ?? 0, 0)} ${baseSymbol} bid depth and ${formatAmount(asks.at(-1)?.cumulative ?? 0, 0)} ${baseSymbol} ask depth across the levels read.`;

  return (
    <figure className="m-0">
      <div ref={containerRef} className="relative w-full" style={{ height }}>
        {width > 0 ? (
          <svg width={width} height={height} role="img" aria-label={summary} className="block overflow-visible">
            {geometry.depthTicks.map((tick) => (
              <g key={`d-${tick}`}>
                <line x1={pad.left} x2={pad.left + innerWidth} y1={geometry.y(tick)} y2={geometry.y(tick)} stroke="var(--border)" strokeWidth={1} />
                <text x={pad.left + innerWidth + 8} y={geometry.y(tick)} dy="0.32em" fill="var(--muted-foreground)" fontSize={10} fontFamily="var(--font-mono)">
                  {formatAmount(tick, 0)}
                </text>
              </g>
            ))}
            {geometry.priceTicks.map((tick) => (
              <text key={`p-${tick}`} x={geometry.x(tick)} y={height - 8} textAnchor="middle" fill="var(--muted-foreground)" fontSize={10} fontFamily="var(--font-mono)">
                {formatPrice(tick)}
              </text>
            ))}
            <path d={geometry.closeBid} fill="color-mix(in srgb, var(--executed) 14%, transparent)" />
            <path d={geometry.closeAsk} fill="color-mix(in srgb, var(--destructive) 14%, transparent)" />
            <path d={geometry.bidPath} fill="none" stroke="var(--executed)" strokeWidth={1.5} strokeLinejoin="miter" />
            <path d={geometry.askPath} fill="none" stroke="var(--destructive)" strokeWidth={1.5} strokeLinejoin="miter" />
            {mid !== null ? (
              <g>
                <line x1={geometry.x(mid)} x2={geometry.x(mid)} y1={pad.top - 6} y2={geometry.baseline} stroke="var(--muted-foreground)" strokeDasharray="3 3" strokeWidth={1} />
                <text x={geometry.x(mid)} y={pad.top - 12} textAnchor="middle" fill="var(--foreground)" fontSize={10} fontFamily="var(--font-mono)">
                  MID {formatPrice(mid)}
                </text>
              </g>
            ) : null}
            <text x={pad.left + 2} y={pad.top + 12} fill="var(--executed)" fontSize={10} fontFamily="var(--font-mono)" letterSpacing="0.06em">BIDS</text>
            <text x={pad.left + innerWidth - 2} y={pad.top + 12} textAnchor="end" fill="var(--destructive)" fontSize={10} fontFamily="var(--font-mono)" letterSpacing="0.06em">ASKS</text>
            <line x1={pad.left} x2={pad.left + innerWidth} y1={geometry.baseline} y2={geometry.baseline} stroke="var(--border-strong)" strokeWidth={1} />
            {hover ? (
              <g pointerEvents="none">
                <line x1={hover.x} x2={hover.x} y1={pad.top} y2={geometry.baseline} stroke="var(--foreground)" strokeOpacity={0.35} strokeWidth={1} />
                <rect x={hover.x - 4} y={hover.y - 4} width={8} height={8} fill="var(--background)" stroke={hover.side === "bid" ? "var(--executed)" : "var(--destructive)"} strokeWidth={1.5} />
              </g>
            ) : null}
            <rect
              x={pad.left}
              y={pad.top}
              width={innerWidth}
              height={innerHeight}
              fill="transparent"
              onPointerMove={onPointerMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        ) : null}
        {hover ? (
          <div
            className="pointer-events-none absolute z-10 min-w-[11rem] border border-border-strong bg-popover px-3 py-2 font-mono text-[11px] shadow-xl shadow-black/[0.08]"
            style={{
              left: Math.min(Math.max(hover.x + 12, 0), Math.max(0, width - 190)),
              top: Math.max(0, hover.y - 64),
            }}
          >
            <p className={`uppercase tracking-wide ${hover.side === "bid" ? "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" : "text-destructive"}`}>{hover.side === "bid" ? "Bid level" : "Ask level"}</p>
            <p className="mt-1 flex justify-between gap-4 text-muted-foreground">Price <span className="text-foreground">{formatPrice(hover.level.price)}</span></p>
            <p className="flex justify-between gap-4 text-muted-foreground">Size <span className="text-foreground">{formatAmount(hover.level.size, 0)} {baseSymbol}</span></p>
            <p className="flex justify-between gap-4 text-muted-foreground">Cumulative <span className="text-foreground">{formatAmount(hover.level.cumulative, 0)}</span></p>
          </div>
        ) : null}
      </div>
      <figcaption className="sr-only">{summary} The price ladder table lists every level.</figcaption>
    </figure>
  );
}

/**
 * Output per route as bars anchored at zero, so differences are shown
 * honestly; the shortfall column carries the comparison.
 */
export function RouteBars({ routes, quoteSymbol, focusRoute }: { routes: RankedRoute[]; quoteSymbol: string; focusRoute?: RankedRoute["route"] }) {
  const max = Math.max(...routes.map((route) => route.output), 0);
  return (
    <ul className="space-y-px" aria-label="Quoted output by route">
      {routes.map((route) => {
        const share = max > 0 ? (route.output / max) * 100 : 0;
        return (
          <li
            key={`${route.venue_id}-${route.route}`}
            className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_7.5rem] ${(focusRoute ? focusRoute === route.route : route.best) ? "bracket bracket-accent bg-primary/[0.06]" : ""}`}
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                <span className="whitespace-nowrap">{ROUTE_LABELS[route.route]}</span>
                {route.best ? <span className="border border-executed/30 bg-executed/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">Best</span> : null}
                {focusRoute === route.route ? <span className="border border-primary/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]">Selected</span> : null}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{route.venue_id === "xrpl-amm" ? "XRPL AMM pool" : route.venue_id === "xrpl-dex-clob" ? "XRPL DEX order book" : route.venue_id.replaceAll("-", " ")}</p>
            </div>
            <div className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
              <div className="h-2 w-full bg-white/[0.05]" aria-hidden="true">
                <div className={`h-full ${route.best ? "bg-executed" : "bg-muted-foreground/60"}`} style={{ width: `${share}%` }} />
              </div>
              <p className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>Px {formatPrice(route.effectivePrice)}</span>
                {route.price_impact_bps !== undefined ? <span>Impact {formatBps(route.price_impact_bps)}</span> : null}
                {route.fee ? <span className="normal-case">{route.fee}</span> : null}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm tabular-nums">{formatAmount(route.output, 2)}</p>
              <p className={`font-mono text-[10px] tabular-nums ${route.best ? "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" : "text-muted-foreground"}`}>
                {route.best ? quoteSymbol : `−${formatBps(route.deltaBps)}`}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Two-segment composition bar for an AMM pool, valued in quote units. */
export function PoolComposition({
  baseValue,
  quoteValue,
  baseLabel,
  quoteLabel,
}: {
  baseValue: number;
  quoteValue: number;
  baseLabel: string;
  quoteLabel: string;
}) {
  const total = baseValue + quoteValue || 1;
  const baseShare = (baseValue / total) * 100;
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px]" role="img" aria-label={`Pool value split: ${baseLabel} ${baseShare.toFixed(1)}%, ${quoteLabel} ${(100 - baseShare).toFixed(1)}%`}>
        <div className="h-full bg-info" style={{ width: `${baseShare}%` }} />
        <div className="h-full bg-chart-4" style={{ width: `${100 - baseShare}%` }} />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 bg-info" />{baseLabel} {baseShare.toFixed(1)}%</span>
        <span className="inline-flex items-center gap-1.5">{quoteLabel} {(100 - baseShare).toFixed(1)}%<span aria-hidden="true" className="h-1.5 w-1.5 bg-chart-4" /></span>
      </div>
    </div>
  );
}
