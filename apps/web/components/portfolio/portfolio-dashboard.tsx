import Link from "next/link";
import {
  ArrowRight,
  TrendingUp,
  BadgeCheck,
  Bot,
  CircleDollarSign,
  Clock3,
  Droplets,
  FileKey2,
  Gauge,
  Layers3,
  LockKeyhole,
  Radio,
  ShieldCheck,
  Sparkles,
  Vault,
  WalletCards,
} from "lucide-react";

import type {
  FeedItem,
  PortfolioBalance,
  PortfolioPosition,
  PortfolioSnapshot,
  QuickNodeStatus,
} from "./portfolio-data";
import { withoutIssuer } from "./offer-format";
import { OpenOffersSection } from "./open-offers";
import type { PortfolioConnectionStatus } from "./live-state";
import { QuickNodePanel } from "./quicknode-panel";

const permissionLabels: Record<string, string> = {
  OfferCreate: "Create offers",
  OfferCancel: "Cancel offers",
  TrustSet: "Manage trust lines",
  AMMDeposit: "Deposit liquidity",
  AMMWithdraw: "Withdraw liquidity",
  EscrowFinish: "Finish escrows",
  CheckCash: "Cash checks",
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function compactAddress(address: string): string {
  return `${address.slice(0, 7)}…${address.slice(-6)}`;
}
function formatFreshness(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function PortfolioDashboard({
  snapshot,
  quickNodeStatus,
  connection = {
    kind: "demo",
    detail: "Demo portfolio.",
    accountCount: 0,
  },
}: {
  snapshot?: PortfolioSnapshot;
  quickNodeStatus?: QuickNodeStatus | null;
  connection?: PortfolioConnectionStatus;
}) {
  // While the session check runs, show a quiet blank page rather than a "checking access" screen.
  if (!snapshot && connection.kind === "connecting") return <div className="min-h-[60vh]" role="status" aria-busy="true"><span className="sr-only">Loading portfolio</span></div>;
  if (!snapshot) return <PortfolioUnavailable connection={connection} />;

  const demo = isDemoView(connection, snapshot);
  const modeLabel = demo
    ? "Demo data"
    : connection.kind === "error"
    ? "Live · error"
    : connection.kind === "connecting"
      ? "Connecting live"
      : connection.kind === "stale"
        ? "Live · stale"
      : snapshot.mode === "live"
        ? connection.kind === "degraded" ? "Live · degraded" : "Live Harbor"
        : "Demo data";
  const modeTone = demo
    ? chipTone.primary
    : connection.kind === "error"
    ? chipTone.destructive
    : connection.kind === "connecting" || connection.kind === "stale" || connection.kind === "degraded"
      ? chipTone.approval
      : snapshot.mode === "live"
        ? chipTone.executed
        : chipTone.info;
  return (
    <div className="min-w-0">
      {demo ? <DemoBand /> : null}
      <section aria-label="Portfolio summary" className="relative min-w-0 overflow-hidden border-b border-border">
        <div className={`grid min-w-0 ${demo ? "" : "xl:grid-cols-[minmax(0,1fr)_23rem]"}`}>
          <div className="relative min-w-0 overflow-hidden px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
            <div className="relative grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="min-w-0">
                <p className="label-mono flex items-center gap-2">
                  <WalletCards aria-hidden="true" className="size-3.5 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" />
                  Portfolio value
                  {!demo ? <span className={`ml-1 ${chipBase} ${modeTone}`}><Radio className="h-3 w-3" aria-hidden="true" /> {modeLabel}</span> : null}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <p className="text-[2rem] font-normal leading-none tracking-[-0.02em] tabular-nums text-foreground">
                    {snapshot.totalUsd === null ? "Valuation unavailable" : money.format(snapshot.totalUsd)}
                  </p>
                  {snapshot.changePercent !== null && snapshot.changeUsd !== null ? (
                    <span className="inline-flex items-center gap-1.5 border border-executed/30 bg-executed/10 px-2 py-1 font-mono text-xs font-medium tabular-nums text-executed rounded">
                      <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> {snapshot.changePercent.toFixed(2)}% · +{money.format(snapshot.changeUsd)}
                    </span>
                  ) : null}
                </div>
                <p className="label-mono mt-3 max-w-2xl leading-6">
                  {demo
                    ? "Balances, positions, budget and activity on XRPL Testnet."
                    : `Owner-scoped balances, positions, budget and activity on XRPL ${snapshot.network.replace("-", " ")}.`}
                </p>
              </div>
              <dl className="flex min-w-0 flex-wrap items-center gap-y-2">
                <div className="flex min-w-0 items-baseline gap-2.5 pr-5">
                  <dt className="label-mono">Account</dt>
                  <dd className="truncate font-mono text-sm text-foreground">{compactAddress(snapshot.account)}</dd>
                </div>
                <div className="flex items-baseline gap-2.5 border-l border-border pl-5">
                  <dt className="label-mono">Ledger</dt>
                  <dd className="font-mono text-sm tabular-nums text-foreground">{snapshot.ledgerIndex.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Demo visitors already see the demo band above; the freshness card only matters for live data. */}
          {demo ? null : <FreshnessCard connection={connection} snapshot={snapshot} demo={demo} />}
        </div>
      </section>

      {/* Rows align across columns: balances ↔ budget, positions + offers ↔ delegation, then activity full width. */}
      <div className="grid min-w-0 gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,0.72fr)]">
          <section aria-labelledby="balances-title" className="flex min-w-0 flex-col border border-border bg-card rounded-xl overflow-hidden">
            <SectionHeader
              id="balances-title"
              icon={<CircleDollarSign className="h-4 w-4" />}
              title="Balances"
              detail={snapshot.coverage.balances === "partial" ? "Partial read" : undefined}
            />
            <div className="grid flex-1 gap-px bg-border sm:grid-cols-2">
              {snapshot.balances.map((balance) => <BalanceCard key={balance.id} balance={balance} demo={demo} totalUsd={snapshot.totalUsd} inOffers={amountInOffers(snapshot.offers, balance.symbol)} openOffers={snapshot.offers.filter((offer) => withoutIssuer(offer.quantity).endsWith(` ${balance.symbol}`)).length} />)}
            </div>
          </section>

          <BudgetCard snapshot={snapshot} demo={demo} />

        <div className="flex min-w-0 flex-col gap-5">
          <section aria-labelledby="positions-title" className="border border-border bg-card rounded-xl overflow-hidden">
            <SectionHeader
              id="positions-title"
              icon={<Droplets className="h-4 w-4" />}
              title="Positions"
              detail="Liquidity and vaults"
            />
            <div className="grid gap-px bg-border sm:grid-cols-2">
              {snapshot.lpPositions.map((position) => (
                <PositionCard key={position.id} position={position} demo={demo} icon={<Droplets className="h-4 w-4" />} />
              ))}
              {snapshot.vaultPositions.map((position) => (
                <PositionCard key={position.id} position={position} demo={demo} icon={<Vault className="h-4 w-4" />} />
              ))}
            </div>
          </section>

          <OpenOffersSection offers={snapshot.offers} coverage={snapshot.coverage} demo={demo} />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <DelegationCard snapshot={snapshot} demo={demo} />
          <QuickNodePanel status={quickNodeStatus} />
        </div>

        <div className="min-w-0 xl:col-span-2">
          <LiveFeed items={snapshot.feed} mode={snapshot.mode} provenance={snapshot.feedProvenance} demo={demo} />
        </div>
      </div>
    </div>
  );
}

function isDemoView(connection: PortfolioConnectionStatus, snapshot: PortfolioSnapshot): boolean {
  return connection.kind === "demo" || connection.kind === "fixture" || snapshot.mode === "mock";
}

function DemoBand() {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:hidden" role="note" aria-label="Demo portfolio">
      <p className="flex min-w-0 items-start gap-2.5 text-[13px] leading-5 text-muted-foreground">
        <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-primary" />
        <span><span className="font-medium text-foreground">You&apos;re viewing a demo portfolio.</span> Connect a wallet to see your own.</span>
      </p>
      <Link
        href="/onboarding"
        className="link-dashed inline-flex shrink-0 items-center gap-1.5 self-start text-[13px] font-medium text-foreground sm:self-auto pointer-coarse:py-3.5"
      >
        Get started <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

const chipBase = "inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[13px] font-medium rounded";
const chipTone = {
  neutral: "border-border-strong text-muted-foreground",
  executed: "border-executed/30 bg-executed/10 text-executed",
  approval: "border-approval/30 bg-approval/10 text-approval",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
  violet: "border-chart-4/30 bg-chart-4/10 text-chart-4",
  primary: "border-primary-soft-border bg-primary-soft text-[color-mix(in_srgb,var(--primary)_72%,var(--foreground))]",
} as const;

function PortfolioUnavailable({ connection }: { connection: PortfolioConnectionStatus }) {
  const label = connection.kind === "connecting"
    ? "Checking access"
    : connection.kind === "unavailable"
      ? "Wallet session required"
      : "Portfolio unavailable";
  const tone = connection.kind === "error"
    ? chipTone.destructive
    : connection.kind === "unavailable"
      ? chipTone.approval
      : chipTone.neutral;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="border border-border bg-card p-6 sm:p-8 rounded-xl overflow-hidden" aria-live="polite">
        <span className={`${chipBase} ${tone}`}>
          <Radio className={`h-3 w-3 ${connection.kind === "connecting" ? "animate-pulse" : ""}`} aria-hidden="true" /> {label}
        </span>
        <h1 className="mt-6 text-[1.5rem] font-semibold tracking-[-0.02em] font-display">No owner-scoped portfolio data is displayed</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{connection.detail}</p>
        <p className="mt-6 border-t border-border pt-4 text-[13px] leading-5 text-muted-foreground">
          Signed-in portfolios only ever show owner-scoped Harbor reads. Demo data is shown only to visitors without a verified wallet session.
        </p>
      </section>
    </div>
  );
}

function FreshnessCard({
  snapshot,
  connection,
  demo,
}: {
  snapshot: PortfolioSnapshot;
  connection: PortfolioConnectionStatus;
  demo: boolean;
}) {
  const statusTone = demo
    ? "bg-primary"
    : connection.kind === "error"
    ? "bg-destructive"
    : connection.kind === "degraded" || connection.kind === "stale"
      ? "bg-approval"
      : connection.kind === "live"
        ? "bg-executed"
        : "bg-info";
  return (
    <div className="relative flex min-w-0 flex-col justify-between gap-4 border-t border-border bg-background/60 px-4 py-6 sm:px-6 lg:px-8 xl:border-l xl:border-t-0 xl:py-10">
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="label-mono inline-flex items-center gap-2"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />Snapshot freshness</span>
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${statusTone}`} />
        </div>
        <p className="mt-3 text-sm tabular-nums text-foreground">{formatFreshness(snapshot.asOf)}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{connection.detail}</p>
      </div>
      <p className="border-t border-border pt-3 text-[13px] leading-relaxed text-muted-foreground">
        {demo
          ? "Simulated snapshot · no wallet connected"
          : `${snapshot.asOfBasis} · ${connection.accountCount} subscribed account${connection.accountCount === 1 ? "" : "s"}`}
      </p>
    </div>
  );
}

function SectionHeader({ id, icon, title, detail }: { id: string; icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex h-12 min-w-0 items-center gap-2.5 border-b border-border px-4 sm:px-5">
      <span className="shrink-0 text-muted-foreground" aria-hidden="true">{icon}</span>
      <h2 id={id} className="text-sm font-medium tracking-tight">{title}</h2>
      {detail ? <span className="label-mono ml-auto truncate">{detail}</span> : null}
    </div>
  );
}

/** XRP mark, from the CC0 cryptocurrency-icons set (credited in the README). */
function XrpMark({ className }: { className?: string }) {
  return (
    <svg viewBox="5 6 22 20.5" className={className} fill="currentColor" aria-hidden="true">
      <path d="M23.07 8l-4.574 4.523a3.556 3.556 0 01-4.996 0L8.93 8H6.035l6.02 5.957a5.621 5.621 0 007.89 0L25.961 8h-2.89zM8.895 24.563L13.504 20a3.556 3.556 0 014.996 0l4.605 4.563H26l-6.055-5.993a5.621 5.621 0 00-7.89 0L6 24.562h2.895z" />
    </svg>
  );
}

/** RLUSD mark (Ripple USD logo glyph, drawn white on its brand blue tile). */
function RlusdMark({ className }: { className?: string }) {
  return (
    <svg viewBox="40 48 268 288" className={className} fill="currentColor" aria-hidden="true">
      <path d="M269 220.672c-9.367-5.422-19.93-6.984-30.395-7.328-8.777-.293-21.855-5.91-21.855-21.985a22.17 22.17 0 0 1 6.45-15.437 22.21 22.21 0 0 1 15.405-6.543c10.465-.367 21.028-1.93 30.395-7.328a55.3 55.3 0 0 0 20.234-20.266 55.24 55.24 0 0 0 7.391-27.652 55.27 55.27 0 0 0-7.43-27.645 55.33 55.33 0 0 0-20.27-20.234 55.4 55.4 0 0 0-27.675-7.406 55.45 55.45 0 0 0-27.676 7.402 55.33 55.33 0 0 0-27.707 47.875c0 10.723 3.817 20.594 8.707 29.754 4.082 7.691 6.16 21.98-7.898 30.066A22.24 22.24 0 0 1 170 175.957a22.2 22.2 0 0 1-13.324-10.219c-5.5-8.793-12.227-17.097-21.442-22.398a55.46 55.46 0 0 0-27.687-7.403 55.44 55.44 0 0 0-27.684 7.418 55.37 55.37 0 0 0-20.265 20.25 55.3 55.3 0 0 0-7.414 27.657c0 9.71 2.558 19.25 7.414 27.66a55.37 55.37 0 0 0 20.265 20.25 55.44 55.44 0 0 0 27.684 7.418c9.719 0 19.266-2.55 27.687-7.403 9.29-5.375 15.942-13.605 21.442-22.398 4.523-7.328 15.793-16.414 30-8.207a22.2 22.2 0 0 1 10.082 13.43 22.2 22.2 0 0 1-2.211 16.636c-4.89 9.16-8.68 19.028-8.68 29.75a55.33 55.33 0 0 0 27.7 47.93 55.46 55.46 0 0 0 55.398.008 55.326 55.326 0 0 0 27.71-47.918 55.3 55.3 0 0 0-7.41-27.676A55.4 55.4 0 0 0 269 220.477Z" />
    </svg>
  );
}

/** Token logo tile: XRP and RLUSD marks, a lettered tile for other assets. */
function TokenMark({ symbol, size = "md" }: { symbol: string; size?: "md" | "sm" }) {
  const box = size === "md" ? "h-9 w-9" : "h-7 w-7";
  if (symbol === "XRP") {
    return (
      <span className={`grid ${box} shrink-0 place-items-center border border-foreground bg-foreground text-background rounded-md`} role="img" aria-label="XRP">
        <XrpMark className={size === "md" ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} />
      </span>
    );
  }
  if (symbol === "RLUSD") {
    return (
      <span className={`grid ${box} shrink-0 place-items-center border border-[#0058d6] bg-[#0069fe] text-[#ffffff] rounded-md`} role="img" aria-label="RLUSD">
        <RlusdMark className={size === "md" ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} />
      </span>
    );
  }
  return (
    <span className={`grid ${box} shrink-0 place-items-center border border-info/30 bg-[color-mix(in_srgb,var(--info)_10%,var(--card))] font-mono rounded-md ${size === "md" ? "text-xs" : "text-[10px]"} font-semibold text-info`} role="img" aria-label={symbol}>
      {symbol === "RLUSD" ? "R$" : symbol.slice(0, 2)}
    </span>
  );
}

/** Logos for a position title such as "XRP / RLUSD" or "XRP Single Asset Vault"; null when none apply. */
function positionMarks(title: string): React.ReactNode {
  const pair = title.match(/^([A-Z]{2,6}) \/ ([A-Z]{2,6})$/);
  if (pair) {
    return (
      <span className="flex shrink-0 items-center gap-1" aria-label={`${pair[1]} and ${pair[2]}`} role="img">
        <TokenMark symbol={pair[1]!} />
        <TokenMark symbol={pair[2]!} />
      </span>
    );
  }
  const single = title.match(/^(XRP|RLUSD)\b/);
  return single ? <TokenMark symbol={single[1]!} /> : null;
}

// In the demo, the sidebar card already says the data is sample data; per-card "demo" tags are dropped.
function BalanceCard({ balance, demo = false, totalUsd, inOffers, openOffers }: { balance: PortfolioBalance; demo?: boolean; totalUsd: number | null; inOffers: number; openOffers: number }) {
  const share = balance.usdValue !== null && totalUsd ? (balance.usdValue / totalUsd) * 100 : null;
  const available = Math.max(0, balance.amount - inOffers);
  const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return (
    <article className="flex min-w-0 flex-col bg-card p-4 sm:p-5">
      <div className="flex min-w-0 items-center gap-3">
        <TokenMark symbol={balance.symbol} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{balance.symbol}</p>
          <p className="truncate text-xs text-muted-foreground">{balance.name}</p>
        </div>
      </div>
      <div className="mt-5 min-w-0">
        <p className="label-mono">Balance</p>
        <p className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-2xl font-normal tracking-[-0.02em] tabular-nums">{amount(balance.amount)} <span className="text-base text-muted-foreground">{balance.symbol}</span></span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{balance.usdValue === null ? "" : `≈ ${money.format(balance.usdValue)}`}</span>
        </p>
      </div>
      {share !== null ? (
        <div className="mt-4">
          <p className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
            <span>Share of portfolio</span>
            <span className="tabular-nums text-foreground">{share.toFixed(1)}%</span>
          </p>
          <div className="mt-1.5 h-1.5 bg-border" role="img" aria-label={`${share.toFixed(1)} percent of portfolio value`}>
            <div className={`h-full ${balance.accent === "violet" ? "bg-[color-mix(in_oklab,var(--info)_70%,var(--primary))]" : "bg-foreground/70"}`} style={{ width: `${Math.min(100, share)}%` }} />
          </div>
        </div>
      ) : null}
      <dl className="mt-4 grid grid-cols-2 gap-px border border-border bg-border rounded-xl overflow-hidden">
        <div className="min-w-0 bg-card px-3 py-2.5">
          <dt className="label-mono">Free to use</dt>
          <dd className="mt-1 truncate font-mono text-xs tabular-nums">{amount(available)} {balance.symbol}</dd>
        </div>
        <div className="min-w-0 bg-card px-3 py-2.5">
          <dt className="label-mono">Held in offers</dt>
          <dd className="mt-1 truncate font-mono text-xs tabular-nums">{amount(inOffers)} {balance.symbol}{openOffers ? <span className="text-muted-foreground"> · {openOffers} {openOffers === 1 ? "offer" : "offers"}</span> : null}</dd>
        </div>
      </dl>
      {demo ? null : <p className="label-mono mt-3">{balance.availabilityNote}</p>}
    </article>
  );
}

/** "5.12 RLUSD (rQhWct2…x9iLKV)" → "5.12 RLUSD"; the full text stays in the tooltip. */
/** Total of one asset committed to open offers, from each offer's quantity. */
function amountInOffers(offers: PortfolioSnapshot["offers"], symbol: string): number {
  return offers.reduce((sum, offer) => {
    const match = /^([\d,.]+)\s+(\S+)$/.exec(withoutIssuer(offer.quantity).trim());
    return match && match[2] === symbol ? sum + Number(match[1]!.replace(/,/g, "")) : sum;
  }, 0);
}

function PositionCard({ position, icon, demo = false }: { position: PortfolioPosition; icon: React.ReactNode; demo?: boolean }) {
  return (
    <article className="flex min-w-0 flex-col bg-card p-4 sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        {positionMarks(position.title) ?? <span className="grid h-9 w-9 shrink-0 place-items-center border border-border-strong text-muted-foreground rounded-md" aria-hidden="true">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{position.title}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{position.subtitle}</p>
        </div>
        <span className={`${chipBase} shrink-0 text-[10px] ${position.network === "testnet" ? chipTone.info : chipTone.violet}`}>{position.network}</span>
      </div>
      <div className="mt-6 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
            <span className="truncate text-xl font-normal tracking-[-0.02em] tabular-nums">{position.amount}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{position.usdValue === null ? "Value unavailable" : money.format(position.usdValue)}</span>
          </p>
        </div>
        <span className={`${chipBase} shrink-0 ${chipTone.executed}`}>{position.yield}</span>
      </div>
      {demo ? null : <p className="label-mono mt-auto flex items-center gap-1.5 border-t border-border pt-3 [margin-top:1.25rem]"><FileKey2 className="h-3 w-3" aria-hidden="true" />{position.fixtureLabel}</p>}
    </article>
  );
}

function BudgetCard({ snapshot, demo }: { snapshot: PortfolioSnapshot; demo: boolean }) {
  const spendAvailable = snapshot.dailySpendUsd !== null;
  const used = spendAvailable
    ? Math.min(100, (snapshot.dailySpendUsd! / snapshot.policy.daily_cap_usd) * 100)
    : 0;
  const remaining = spendAvailable
    ? snapshot.policy.daily_cap_usd - snapshot.dailySpendUsd!
    : null;
  return (
    <section aria-labelledby="budget-title" className="flex min-w-0 flex-col border border-border bg-card rounded-xl overflow-hidden">
      <SectionHeader id="budget-title" icon={<Gauge className="h-4 w-4" />} title="Daily budget" detail={spendAvailable ? demo ? undefined : "Harbor policy" : "Spend unavailable"} />
      <div className="p-4 sm:p-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-2xl font-normal tracking-[-0.02em] tabular-nums">{spendAvailable ? money.format(snapshot.dailySpendUsd!) : "Unavailable"}</p>
            <p className="mt-1 text-xs text-muted-foreground">of <span className="font-mono tabular-nums">{money.format(snapshot.policy.daily_cap_usd)}</span> delegated cap</p>
          </div>
          <p className="label-mono text-right text-foreground">{spendAvailable ? `${Math.round(used)}% used` : "No live spend op"}</p>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden bg-secondary" role="progressbar" aria-label="Daily delegated budget used" aria-valuemin={0} aria-valuemax={snapshot.policy.daily_cap_usd} aria-valuenow={snapshot.dailySpendUsd ?? undefined}>
          <div className="h-full bg-foreground" style={{ width: `${used}%` }} />
        </div>
      </div>
      <dl className="mt-auto grid grid-cols-2 divide-x divide-border border-t border-border">
        <div className="px-4 py-3 sm:px-5"><dt className="label-mono">Remaining</dt><dd className="mt-1 font-mono text-sm tabular-nums">{remaining === null ? "Unavailable" : money.format(remaining)}</dd></div>
        <div className="px-4 py-3 sm:px-5"><dt className="label-mono">Auto-execute under</dt><dd className="mt-1 font-mono text-sm tabular-nums">{money.format(snapshot.policy.execute_under_usd)}</dd></div>
      </dl>
    </section>
  );
}

function DelegationCard({ snapshot, demo }: { snapshot: PortfolioSnapshot; demo: boolean }) {
  const active = snapshot.delegation.status === "active";
  const revoked = snapshot.delegation.status === "revoked";
  const tone = active
    ? chipTone.executed
    : revoked
      ? chipTone.destructive
      : chipTone.approval;
  const permissionSummary = active
    ? `${snapshot.delegation.permissions.length} permissions granted`
    : revoked
      ? "Revoked · no permissions active"
      : `${snapshot.delegation.status} · permissions are not active`;
  return (
    <section aria-labelledby="delegation-title" className="flex min-w-0 flex-col border border-border bg-card rounded-xl overflow-hidden">
      {/* Same header row as Balances and Positions; the delegate address sits on the right. */}
      <div className="flex h-12 min-w-0 items-center gap-2.5 border-b border-border px-4 sm:px-5">
        <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 id="delegation-title" className="shrink-0 text-sm font-medium tracking-tight">Delegation {snapshot.delegation.status}</h2>
        {demo ? null : <span className={`${chipBase} shrink-0 text-[10px] ${tone}`}><BadgeCheck className="h-3 w-3" aria-hidden="true" />Harbor read</span>}
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title={snapshot.delegation.delegate}>
          <span className="sr-only">Delegate </span>
          {compactAddress(snapshot.delegation.delegate)}
        </span>
      </div>
      <div className="p-4 sm:px-5">
        <p className="label-mono flex items-center gap-2 text-foreground"><LockKeyhole className={`h-3.5 w-3.5 ${active ? "text-executed" : revoked ? "text-destructive" : "text-approval"}`} aria-hidden="true" />{permissionSummary}</p>
        {active ? (
          <ul className="mt-3 grid border border-border sm:grid-cols-2 xl:grid-cols-1 rounded-xl" aria-label="Granted delegate permissions">
            {snapshot.delegation.permissions.map((permission) => (
              <li key={permission} className="flex items-center gap-2.5 border-b border-border px-3 py-2 text-xs text-foreground/85 last:border-b-0">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-executed" />
                <span className="truncate">{permissionLabels[permission] ?? permission}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!active ? (
          <p className="mt-3 text-xs text-muted-foreground">No delegate permissions are currently active.</p>
        ) : null}
      </div>
      <p className="mt-auto border-t border-border bg-surface px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">Payments and vault actions remain owner-signed. Pilot never holds the owner key.</p>
    </section>
  );
}

function LiveFeed({
  items,
  mode,
  provenance,
  demo,
}: {
  items: FeedItem[];
  mode: PortfolioSnapshot["mode"];
  provenance: string;
  demo: boolean;
}) {
  return (
    <section aria-labelledby="feed-title" className="border border-border bg-card rounded-xl overflow-hidden">
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4 sm:px-5">
        {mode === "live" && !demo ? (
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping bg-executed/60" /><span className="relative inline-flex h-1.5 w-1.5 bg-executed" /></span>
        ) : (
          <span className="h-1.5 w-1.5 bg-muted-foreground" aria-hidden="true" />
        )}
        <h2 id="feed-title" className="text-sm font-medium tracking-tight">{demo ? "Activity" : "Live feed"}</h2>
        {demo ? null : <span className={`${chipBase} ml-auto text-[10px] ${chipTone.neutral}`}>{mode === "live" ? "Validated tx" : "Demo feed"}</span>}
      </div>
      {/* Vertical list on small screens, horizontal timeline from md up. */}
      <ol className="p-4 sm:px-5 md:hidden" aria-live="polite">
        {items.map((item, index) => <FeedRow key={item.id} item={item} last={index === items.length - 1} />)}
      </ol>
      <div className="hidden overflow-x-auto md:block" role="region" aria-label="Activity timeline" tabIndex={0}>
        <ol className="grid min-w-[44rem] auto-cols-fr grid-flow-col px-5 pb-6 pt-5">
          {items.map((item, index) => <TimelineNode key={item.id} item={item} last={index === items.length - 1} />)}
        </ol>
      </div>
      {demo ? null : <p className="label-mono border-t border-border px-4 py-3 normal-case tracking-normal sm:px-5">{provenance}</p>}
    </section>
  );
}

function FeedRow({ item, last }: { item: FeedItem; last: boolean }) {
  const tone = item.state === "executed" ? chipTone.executed : item.state === "approval" ? chipTone.approval : chipTone.info;
  const Icon = item.state === "executed" ? Sparkles : item.state === "approval" ? Clock3 : Bot;
  return (
    <li className="relative flex min-w-0 gap-3 pb-5 last:pb-0">
      {!last ? <span className="absolute bottom-0 left-[13px] top-7 w-px bg-border" aria-hidden="true" /> : null}
      <span className={`relative z-10 grid h-7 w-7 shrink-0 place-items-center border bg-card rounded-md ${tone}`} aria-hidden="true"><Icon className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.title}</p>
          <time className="shrink-0 text-[13px] text-muted-foreground">{item.time}</time>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
      </div>
    </li>
  );
}

function TimelineNode({ item, last }: { item: FeedItem; last: boolean }) {
  const tone = item.state === "executed" ? chipTone.executed : item.state === "approval" ? chipTone.approval : chipTone.info;
  const Icon = item.state === "executed" ? Sparkles : item.state === "approval" ? Clock3 : Bot;
  return (
    <li className="min-w-0">
      {/* Connector sits in the row's free space, so it never runs under an icon or a label. */}
      <div className="flex items-center gap-2.5">
        <span className={`grid h-7 w-7 shrink-0 place-items-center border rounded-md ${tone}`} aria-hidden="true"><Icon className="h-3.5 w-3.5" /></span>
        <time className="shrink-0 text-[13px] text-muted-foreground">{item.time}</time>
        {!last ? <span aria-hidden="true" className="mx-1 h-px min-w-6 flex-1 bg-border-strong" /> : null}
      </div>
      <p className="mt-3 pr-6 text-[13px] font-medium leading-snug">{item.title}</p>
      <p className="mt-1 pr-6 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
    </li>
  );
}
