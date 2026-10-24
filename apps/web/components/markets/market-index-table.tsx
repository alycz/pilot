"use client";

import { ArrowDown, ArrowUp, ArrowUpRight, ChevronsUpDown, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { labelToken } from "../map/venue-utils";

import {
  catalogStatusLabel,
  MARKET_TYPE_LABELS,
  type MarketFilter,
  type MarketRow,
  type MarketSort,
  type MarketSortKey,
  type MarketType,
  type QuotedMarketRow,
} from "./market-index";
import { formatBps, formatCompact, formatPrice } from "./markets-data";
import { handleRadioKeys } from "./radio-keys";

const chip = "inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide whitespace-nowrap";
const tone = {
  neutral: "border-border text-muted-foreground",
  executed: "border-executed/30 bg-executed/10 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]",
  approval: "border-approval/30 bg-approval/10 text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
};

const FILTERS: Array<{ value: MarketFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "quoted", label: "Quoted" },
  { value: "catalog", label: "Catalogued" },
];

export function MarketIndexTable({
  rows,
  totals,
  filter,
  onFilter,
  type,
  types,
  onType,
  query,
  onQuery,
  sort,
  onSort,
  selectedKey,
  onSelect,
  pairLabel,
  sourceLabel,
  sourceTone,
  networkControl,
  networkLabel,
  offline = false,
  quotedGroupLabel,
  footnote,
  catalogState,
  onRetryCatalog,
}: {
  rows: MarketRow[];
  totals: { quoted: number; catalog: number };
  filter: MarketFilter;
  onFilter: (value: MarketFilter) => void;
  type: MarketType | "all";
  types: MarketType[];
  onType: (value: MarketType | "all") => void;
  query: string;
  onQuery: (value: string) => void;
  sort: MarketSort;
  onSort: (key: MarketSortKey) => void;
  selectedKey: string;
  onSelect: (row: QuotedMarketRow) => void;
  pairLabel: string;
  quoteSymbol?: string;
  sourceLabel: string;
  sourceTone: "executed" | "info" | "neutral";
  networkControl?: ReactNode;
  offline?: boolean;
  networkLabel: string;
  quotedGroupLabel: string;
  footnote: string;
  catalogState: { status: "loading" | "ok" | "error"; message?: string };
  onRetryCatalog: () => void;
}) {
  const quotedRows = rows.filter((row): row is QuotedMarketRow => row.kind === "quoted");
  const catalogRows = rows.filter((row) => row.kind === "catalog");
  const showGroups = sort.key === "default";

  return (
    <section aria-labelledby="market-index-title" className="bracket border border-border bg-card">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="market-index-title" className="text-sm font-medium">All markets</h2>
          <p className="label-mono text-[10px]">
            {totals.quoted} quoted · {catalogState.status === "loading" ? "…" : totals.catalog} catalogued
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {networkControl}
          <div role="radiogroup" aria-label="Market source" className="flex border border-border">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={filter === option.value}
                tabIndex={filter === option.value ? 0 : -1}
                onKeyDown={(event) => handleRadioKeys(event, FILTERS.map((entry) => entry.value), filter, onFilter)}
                onClick={() => onFilter(option.value)}
                className={`h-8 pointer-coarse:h-11 border-r border-border px-3 font-mono text-[10px] uppercase tracking-wide transition last:border-r-0 ${
                  filter === option.value ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="min-w-0">
            <span className="sr-only">Market type</span>
            <select
              value={type}
              onChange={(event) => onType(event.target.value as MarketType | "all")}
              className="h-8 pointer-coarse:h-11 border border-input bg-background/60 px-2 font-mono text-[10px] pointer-coarse:text-base uppercase tracking-wide text-foreground"
            >
              <option value="all">All types</option>
              {types.map((value) => (
                <option key={value} value={value}>{MARKET_TYPE_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className="bracket bracket-focus relative w-full min-w-0 sm:w-52">
            <span className="sr-only">Search markets</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Search venues"
              className="h-8 pointer-coarse:h-11 w-full border border-input bg-background/60 pl-8 pr-2 text-xs pointer-coarse:text-base text-foreground placeholder:text-muted-foreground/70"
            />
          </label>
        </div>
      </header>

      <div className="overflow-x-auto" role="region" aria-label="Markets table" tabIndex={0}>
        <table className="w-full border-collapse text-left xl:min-w-[46rem]">
          <caption className="sr-only">
            Live markets for {pairLabel}, followed by catalogued venues Pilot does not quote yet. Sortable by market, type and status.
          </caption>
          <thead className="bg-white/[0.02]">
            <tr className="border-b border-border">
              <SortHeader label="Market" sortKey="name" sort={sort} onSort={onSort} className="pl-4" />
              <SortHeader label="Type" sortKey="type" sort={sort} onSort={onSort} className="hidden sm:table-cell" />
              <th scope="col" className="label-mono px-3 py-2.5 text-right text-[10px] font-medium">Price</th>
              <th scope="col" className="label-mono hidden px-3 py-2.5 text-right text-[10px] font-medium md:table-cell lg:hidden xl:table-cell">Cost</th>
              <th scope="col" className="label-mono hidden px-3 py-2.5 text-right text-[10px] font-medium md:table-cell">Liquidity</th>
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={onSort} className="hidden sm:table-cell" />
              <th scope="col" className="hidden px-4 py-2.5 xl:table-cell"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {showGroups && quotedRows.length ? <GroupRow label={quotedGroupLabel} /> : null}
            {(showGroups ? quotedRows : rows).map((row) =>
              row.kind === "quoted" ? (
                <QuotedRow key={row.key} row={row} pairLabel={row.pairLabel ?? pairLabel} selected={row.key === selectedKey} sourceLabel={sourceLabel} sourceTone={sourceTone} offline={offline} onSelect={onSelect} />
              ) : (
                <CatalogRow key={row.key} row={row} network={networkLabel} />
              ),
            )}
            {showGroups && (catalogRows.length || catalogState.status !== "ok") && filter !== "quoted" ? (
              <GroupRow label="Catalogued venues · listed by Harbor, not priced here yet" />
            ) : null}
            {showGroups ? catalogRows.map((row) => row.kind === "catalog" ? <CatalogRow key={row.key} row={row} network={networkLabel} /> : null) : null}
            {catalogState.status === "loading" && filter !== "quoted" ? (
              <tr><td colSpan={7} className="px-4 py-3"><span className="inline-block h-3 w-48 animate-pulse bg-white/[0.07] motion-reduce:animate-none" role="img" aria-label="Loading venue catalog" /></td></tr>
            ) : null}
            {catalogState.status === "error" && filter !== "quoted" ? (
              <tr>
                <td colSpan={7} className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                  Venue catalog unavailable: {catalogState.message}{" "}
                  <button type="button" onClick={onRetryCatalog} className="link-dashed uppercase tracking-wide text-foreground">Retry</button>
                </td>
              </tr>
            ) : null}
            {!rows.length && catalogState.status !== "loading" ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-wide text-muted-foreground">No markets match these filters.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <p className="label-mono text-[10px]">{footnote}</p>
        <Link href="/map" className="link-dashed inline-flex items-center gap-1 pointer-coarse:min-h-11 font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
          Full venue map <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </footer>
    </section>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  sortKey: MarketSortKey;
  sort: MarketSort;
  onSort: (key: MarketSortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"} className={`px-3 py-1.5 ${className}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`label-mono inline-flex items-center gap-1 py-1 pointer-coarse:min-h-11 text-[10px] font-medium transition hover:text-foreground ${active ? "text-foreground" : ""}`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}

function GroupRow({ label }: { label: string }) {
  return (
    <tr className="border-b border-border bg-background/40">
      <th scope="colgroup" colSpan={7} className="label-mono px-4 py-2 text-[10px] font-medium">{label}</th>
    </tr>
  );
}

function QuotedRow({
  row,
  pairLabel,
  selected,
  sourceLabel,
  sourceTone,
  offline = false,
  onSelect,
}: {
  offline?: boolean;
  row: QuotedMarketRow;
  pairLabel: string;
  selected: boolean;
  sourceLabel: string;
  sourceTone: "executed" | "info" | "neutral";
  onSelect: (row: QuotedMarketRow) => void;
}) {
  // Offline: say so instead of "No quote", which reads like an empty market.
  const errorLabel = offline ? "Offline" : row.route === "amm" ? "No pool" : "No quote";
  const cost =
    row.cost === null
      ? "—"
      : row.costLabel === "Fee"
        ? `${row.cost.toFixed(3)}%`
        : formatBps(row.cost);
  return (
    <tr onClick={() => onSelect(row)} className={`group cursor-pointer border-b border-border transition ${selected ? "bracket bracket-accent bg-primary/[0.06]" : "hover:bg-white/[0.03]"}`}>
      <td className="py-0 pl-4 pr-3">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={selected}
          onClick={(event) => { event.stopPropagation(); onSelect(row); }}
          className="flex w-full min-w-0 items-center gap-3 py-3 text-left focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11"
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${selected ? "bg-primary" : offline ? "border border-muted-foreground" : "bg-executed"}`} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{pairLabel}</span>
            <span className="block break-words font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:truncate">{row.venueName}<span className="sm:hidden"> · {MARKET_TYPE_LABELS[row.type]} · {row.state === "error" ? errorLabel : sourceLabel}</span></span>
          </span>
        </button>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell"><span className={`${chip} ${tone.neutral}`}>{MARKET_TYPE_LABELS[row.type]}</span></td>
      <td className="px-3 py-3 text-right">
        {row.state === "loading" ? (
          <span className="ml-auto inline-block h-3 w-14 animate-pulse bg-white/[0.07] motion-reduce:animate-none" role="img" aria-label="Loading" />
        ) : (
          <>
            <span className="block font-mono text-sm tabular-nums">{formatPrice(row.price)}</span>
            <span className="block whitespace-nowrap font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{row.state === "error" ? errorLabel : row.priceBasis}</span>
          </>
        )}
      </td>
      <td className="hidden px-3 py-3 text-right md:table-cell lg:hidden xl:table-cell">
        <span className="block font-mono text-xs tabular-nums">{row.state === "loading" ? "…" : cost}</span>
        <span className="block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{row.costLabel}</span>
      </td>
      <td className="hidden px-3 py-3 text-right md:table-cell">
        <span className="block whitespace-nowrap font-mono text-xs tabular-nums">{row.state === "loading" ? "…" : row.liquidity === null ? "—" : `${formatCompact(row.liquidity)} ${row.liquidityUnit}`}</span>
        <span className="block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{row.liquidityLabel}</span>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell">
        {row.state === "error" ? (
          <span className={`${chip} ${offline ? tone.neutral : tone.approval}`}>{errorLabel}</span>
        ) : sourceLabel ? (
          <span className={`${chip} ${tone[sourceTone]}`}>{sourceLabel}</span>
        ) : null}
      </td>
      <td className="hidden px-4 py-3 text-right xl:table-cell">
        <span className={`whitespace-nowrap font-mono text-[10px] uppercase tracking-wide ${selected ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-muted-foreground"}`}>{selected ? "Open" : "View →"}</span>
      </td>
    </tr>
  );
}

function CatalogRow({ row, network }: { row: Extract<MarketRow, { kind: "catalog" }>; network: string }) {
  const availabilityTone =
    row.availability === "live"
      ? tone.executed
      : row.availability === "devnet-only" || row.availability === "voting"
        ? tone.approval
        : tone.neutral;
  const statusText = catalogStatusLabel(row.availability, network, row.discovery);
  return (
    <tr className="border-b border-border transition last:border-b-0 hover:bg-white/[0.02]">
      <td className="py-3 pl-4 pr-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 border border-muted-foreground/60" />
          <span className="min-w-0">
            <Link href="/map" className="block truncate text-sm pointer-coarse:-my-3 pointer-coarse:py-3 text-foreground/90 underline-offset-2 hover:underline">{row.venueName}<span className="sr-only"> (venue map)</span></Link>
            <span className="block break-words font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:truncate">
              {labelToken(row.layer)}<span className="sm:hidden"> · {MARKET_TYPE_LABELS[row.type]} · {statusText}</span>
            </span>
          </span>
        </div>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell"><span className={`${chip} ${tone.neutral}`}>{MARKET_TYPE_LABELS[row.type]}</span></td>
      <td className="px-3 py-3 text-right">
        <span className="block font-mono text-sm text-muted-foreground">—</span>
      </td>
      <td className="hidden px-3 py-3 text-right font-mono text-xs text-muted-foreground md:table-cell lg:hidden xl:table-cell">—</td>
      <td className="hidden px-3 py-3 text-right font-mono text-xs text-muted-foreground md:table-cell">—</td>
      <td className="hidden px-3 py-3 sm:table-cell"><span className={`${chip} ${availabilityTone}`}>{statusText}</span></td>
      <td className="hidden px-4 py-3 text-right xl:table-cell">
        <Link href="/map" className="link-dashed font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
          Map<span className="sr-only"> entry for {row.venueName}</span>
        </Link>
      </td>
    </tr>
  );
}
