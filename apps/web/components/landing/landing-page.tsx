import {
  ArrowDown,
  ArrowRight,
  BarChart3,
  Bot,
  CandlestickChart,
  Check,
  CircleDollarSign,
  KeyRound,
  Map as MapIcon,
  MessageCircle,
  MessageSquare,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { demoIntent, fixtureEvent } from "@/app/chat/fixtures";
import { IntentCard } from "@/components/cards";

import { ArchitectureDiagram } from "./architecture-diagram";
import { CodeSample } from "./code-sample";
import { LandingMotion } from "./landing-motion";
import { LearningLoop } from "./learning-loop";
import { LandingBrand, LandingNav } from "./landing-nav";

/* ------------------------------------------------------------------ */
/* Content. Every number below is checked against the codebase:        */
/*  - 23 venues: packages/harbor-client/fixtures/reads.json venues.list */
/*  - 7 delegate permissions: contracts allowed_tx_types / portfolio    */
/*  - op names: packages/harbor-client/src/types.ts HarborArgsSchemas   */
/* ------------------------------------------------------------------ */

const builderSteps = [
  { n: "01", title: "Fetch prices and balances", risk: null },
  { n: "02", title: "Write the transaction", risk: "Wrong amount or token" },
  { n: "03", title: "Check the user's limits", risk: "Spending limit is skipped" },
  { n: "04", title: "Ask the user to approve", risk: "User can't see the details" },
  { n: "05", title: "Sign with the user's key", risk: "Wrong trade gets signed" },
  { n: "06", title: "Send to the ledger", risk: "A retry sends it twice" },
  { n: "07", title: "Confirm what happened", risk: "Unstable connection" },
] as const;

const traderToday = [
  { stage: "Research", tool: "Analytics site", icon: BarChart3, gap: "Does not pass the data along" },
  { stage: "Decide", tool: "Chatbot", icon: MessageSquare, gap: "Does not send the exact trade" },
  { stage: "Approve", tool: "Wallet", icon: KeyRound, gap: "Does not track the result" },
  { stage: "Result", tool: "Block explorer", icon: Search, gap: null },
] as const;

const traderPilot = [
  { stage: "Research", detail: "Agent reads the market", link: "Passes the data along" },
  { stage: "Decide", detail: "Agent proposes a trade", link: "Sends the exact trade" },
  { stage: "Approve", detail: "You see the exact details", link: "Tracks the result", accent: true },
  { stage: "Result", detail: "Confirmed on the ledger", link: null },
] as const;

const harborFlow = [
  { n: "01", title: "Connect", owner: "App", points: ["AI agents use the MCP server", "Regular apps use the REST API"] },
  { n: "02", title: "Read the market", owner: "Harbor", points: ["Prices, balances and order books", "Venue catalogue and route quotes"] },
  { n: "03", title: "Build the trade", owner: "Harbor", points: ["Writes the unsigned transaction", "Swaps, orders, payments, pools"] },
  { n: "04", title: "Check limits", owner: "Harbor", points: ["Reserves the spending limit", "Guards against duplicate execution"] },
  { n: "05", title: "Approve", owner: "User", points: ["Approval matches the exact trade", "The signed trade is checked again"], accent: true },
  { n: "06", title: "Confirm", owner: "Harbor", points: ["Reads the result from the ledger", "Recovers it if the connection drops"] },
] as const;

const operationGroups = [
  { title: "Market data", ops: ["venues.list", "venues.get", "venues.compare", "dex.book", "dex.depth", "amm.info", "tokens.lookup", "yield.options", "vault.info"] },
  { title: "Ledger reads", ops: ["ledger.account.info", "ledger.account.lines", "ledger.account.objects", "ledger.account.tx"] },
  { title: "Build", ops: ["tx.swap", "tx.offer", "tx.offerCancel", "tx.payment", "tx.trustSet", "tx.ammDeposit", "tx.ammWithdraw", "tx.vaultDeposit", "tx.vaultWithdraw"] },
  { title: "Execute & control", ops: ["tx.simulate", "tx.execute", "tx.submit", "tx.status", "policy.get", "policy.set", "account.link", "account.status", "account.revoke"] },
] as const;

const pilotFlow = [
  { title: "Account", detail: "Connect a wallet and set limits" },
  { title: "Research", detail: "The agent reads the market" },
  { title: "Propose", detail: "It drafts the exact trade" },
  { title: "Approve", detail: "You sign what you see" },
  { title: "Confirm", detail: "Result read from the ledger" },
] as const;

const pilotFeatures = [
  { title: "Research where you trade", body: "Ask about your account and the market. The agent reads quotes, order books, pools and the venue catalogue through Harbor." },
  { title: "Approvals show the exact trade", body: "Every proposal arrives as a card with the asset, amount, route, fee and policy result. You sign that transaction, not a summary of it." },
  { title: "Your limits, enforced", body: "Per-trade caps, a daily budget, an auto-execute threshold, an issuer allowlist and network rules, checked on every trade." },
  { title: "Memory you can read", body: "Preferences, journals and trade reflections live as linked Markdown notes in an Obsidian-format vault." },
  { title: "Keyless by design", body: "Pilot never holds your owner key. Owner actions are signed in your own wallet, sign-only." },
] as const;

const appLinks = [
  { href: "/chat", label: "Chat", detail: "Plan, approve and follow each action", icon: MessageCircle },
  { href: "/markets", label: "Markets", detail: "Live order books and AMM pools from public XRPL nodes", icon: CandlestickChart },
  { href: "/map", label: "Map", detail: "The XRPL venue catalogue", icon: MapIcon },
  { href: "/portfolio", label: "Portfolio", detail: "Balances, positions and budget", icon: CircleDollarSign },
  { href: "/memory", label: "Memory", detail: "Notes, policy and knowledge graph", icon: Sparkles },
] as const;

const useCases = [
  {
    title: "Compare swap prices",
    built: true,
    points: ["The agent compares order book and pool prices", "The trader approves the exact swap", "Harbor confirms the result on the ledger"],
  },
  {
    title: "Trading bot",
    built: false,
    points: ["The developer sets a daily spending limit", "The bot places and cancels orders all day", "Harbor blocks repeats when the bot retries"],
  },
  {
    title: "Payments app",
    built: false,
    points: ["The app sets up the token's trust line", "The user approves the payment", "If the connection drops, Harbor checks the ledger"],
  },
  {
    title: "Liquidity app",
    built: false,
    points: ["The app reads the pool's size and fees", "Harbor prepares the deposit", "Nothing moves until the user approves"],
  },
] as const;

const delegatePermissions = ["Create offers", "Cancel offers", "Manage trust lines", "Deposit liquidity", "Withdraw liquidity", "Finish escrows", "Cash checks"] as const;

const safety = [
  { title: "No owner keys", body: "Pilot never holds an owner key. Owner-signed actions go to your wallet as sign-only requests." },
  { title: "Narrow delegation", body: "Autonomous actions run only through seven delegate permissions you grant on-ledger.", chips: delegatePermissions },
  { title: "Limits before signing", body: "Spending limits are checked and reserved before anything is signed or sent to the ledger." },
  { title: "Exact-trade approval", body: "An approval is bound to one transaction. The signed blob is checked against it again before submission." },
  { title: "No double execution", body: "Durable idempotency means a retried request cannot send the same trade twice." },
  { title: "Confirm and recover", body: "Results are read back from the ledger, and recovered if the connection drops mid-flight." },
] as const;

const roadmap = [
  {
    phase: "Today · Testnet",
    title: "Working now",
    active: true,
    items: ["Exchange trades and orders", "Payments and trust lines", "Pool deposits and withdrawals", "Spending rules and approvals", "Vaults on Devnet", "Catalogues 23 venues; trades on the XRPL DEX and AMM"],
  },
  {
    phase: "Next",
    title: "Open and tested",
    active: false,
    items: ["Open-source release with a license", "Published review of key handling and transaction controls", "Expanded end-to-end trading and payment coverage", "Developer guides and three example applications"],
  },
  {
    phase: "Later",
    title: "Venues and Mainnet",
    active: false,
    items: ["Additional venue integrations", "Outside teams building on Harbor", "Mainnet trading after review"],
  },
] as const;

// $500 is over the $250 auto-execute limit, so this swap needs the owner's signature
// (the same rule the chat demo follows).
const approvalEvent = fixtureEvent("awaiting_approval", { ...demoIntent, id: "intent-landing-preview", amount: "500" });

/* ------------------------------------------------------------------ */

function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  className = "",
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `${id ?? eyebrow.toLowerCase().replace(/[^a-z]+/g, "-")}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className={`scroll-mt-20 border-b border-border ${className}`}>
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div data-reveal>
          <p className="label-mono">{eyebrow}</p>
          <h2 id={headingId} className="mt-3 max-w-3xl text-balance text-[1.5rem] font-normal leading-tight tracking-[-0.02em] text-foreground outline-none sm:text-[1.75rem]">
            {title}
          </h2>
          {lede ? <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-[15px] sm:leading-7">{lede}</p> : null}
        </div>
        <div data-reveal className="mt-10 sm:mt-14">{children}</div>
      </div>
    </section>
  );
}
function OwnerChip({ owner, accent }: { owner: string; accent?: boolean }) {
  return (
    <span
      className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
        accent ? "border-primary/40 bg-primary/10 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : owner === "Harbor" ? "border-info/30 bg-info/10 text-info" : "border-border text-muted-foreground"
      }`}
    >
      {owner}
    </span>
  );
}
/* ------------------------------------------------------------------ */

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden border-b border-border">
      <div aria-hidden="true" className="bg-rules pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <p className="inline-flex items-center gap-2 border border-border bg-background/70 px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            <span aria-hidden="true" className="h-1.5 w-1.5 bg-primary" />
            Harbor MCP &amp; API · Pilot trading harness
          </p>
          <h1 id="hero-title" className="mt-7 text-balance text-[2.125rem] font-normal leading-[1.08] tracking-[-0.03em] text-foreground sm:text-[2.875rem] lg:text-[3.5rem]">
            Agent infrastructure and a trading<br className="hidden sm:block" /> harness for the XRP Ledger.
          </h1>
          <p className="label-mono mx-auto mt-6 max-w-xl leading-6">
            Builders get one place to make XRPL transactions with checks built in. Traders get an AI workspace to research and trade on top of it.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/chat"
              className="bracket bracket-light inline-flex h-10 items-center gap-2 bg-foreground px-4 pointer-coarse:h-11 font-mono text-[11px] font-medium uppercase tracking-wide text-background transition hover:bg-foreground/90"
            >
              Launch workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link
              href="/markets"
              className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border-strong bg-white/[0.03] px-4 pointer-coarse:h-11 font-mono text-[11px] uppercase tracking-wide text-foreground transition hover:bg-white/[0.06]"
            >
              <CandlestickChart className="h-3.5 w-3.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" /> Explore markets
            </Link>
            <a href="#harbor" className="link-dashed inline-flex h-10 items-center pointer-coarse:h-11 gap-1.5 px-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
              Read the API <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>

        <ProductPreview />

        <dl className="mx-auto mt-10 grid max-w-5xl grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
          {[
            ["Interfaces", "MCP + REST"],
            ["Venues catalogued", "23"],
            ["Delegate permissions", "7"],
            ["Network", "XRPL Testnet"],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-2 bg-card px-5 py-5 sm:px-6">
              <dt className="label-mono">{label}</dt>
              <dd className="text-xl font-normal tabular-nums tracking-[-0.01em] text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Simulated route comparison for the preview: 500 RLUSD sold for XRP. */
const previewRoutes = [
  { route: "Order book", venue: "XRPL DEX", out: 963.84, impact: "18 bps", fee: "12 drops", best: true },
  { route: "Path payment", venue: "XRPL paths", out: 962.95, impact: "24 bps", fee: "12 drops", best: false },
  { route: "AMM pool", venue: "XRPL AMM", out: 956.2, impact: "95 bps", fee: "0.30% pool", best: false },
] as const;

function PreviewRoutes() {
  const outs = previewRoutes.map((r) => r.out);
  const min = Math.min(...outs);
  const max = Math.max(...outs);
  const savings = (max - min).toFixed(2);
  return (
    <figure className="border border-border bg-background/40" aria-labelledby="preview-routes-title">
      <figcaption id="preview-routes-title" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3.5 py-2">
        <span className="label-mono text-[10px]">Sell 500 RLUSD · receive XRP</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">venues.compare</span>
      </figcaption>
      <ul className="divide-y divide-border">
        {previewRoutes.map((r) => {
          const width = 62 + (38 * (r.out - min)) / (max - min || 1);
          return (
            <li key={r.route} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3.5 py-2.5 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  {r.route}
                  {r.best ? (
                    <span className="border border-executed/35 bg-executed/10 px-1 py-px font-mono text-[10px] leading-none uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">Best</span>
                  ) : null}
                </span>
                <span className="block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{r.venue}</span>
              </span>
              <span className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
                <span aria-hidden="true" className="block h-1.5 bg-border">
                  <span className={`block h-full ${r.best ? "bg-executed" : "bg-foreground/35"}`} style={{ width: `${width}%` }} />
                </span>
                <span className="mt-1 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Impact {r.impact} · {r.fee}</span>
              </span>
              <span className="order-2 whitespace-nowrap text-right font-mono text-xs tabular-nums text-foreground sm:order-none">{r.out.toFixed(2)} XRP</span>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-3.5 py-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        Best vs worst <span className="text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">+{savings} XRP</span> · simulated quotes
      </p>
    </figure>
  );
}

function ProductPreview() {
  return (
    <figure aria-labelledby="product-preview-title" className="bracket mx-auto mt-14 max-w-5xl border border-border-strong bg-card text-left sm:mt-16">
      <h2 id="product-preview-title" className="sr-only">Product preview: a simulated Pilot conversation on Testnet</h2>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-foreground">
          <Bot className="h-3.5 w-3.5" aria-hidden="true" /> Pilot
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 border border-executed/30 bg-executed/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">
            <span aria-hidden="true" className="h-1.5 w-1.5 bg-executed" /> Testnet
          </span>
        </span>
      </div>
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-6 lg:border-r lg:border-border">
          <div className="ml-auto flex max-w-[90%] items-start justify-end gap-2">
            <p className="border border-border bg-white/[0.05] px-4 py-3 text-[15px] leading-6 text-foreground">Swap 500 RLUSD for XRP, max 1% slippage.</p>
            <span className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-card text-muted-foreground" role="img" aria-label="You">
              <UserRound className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
          </div>
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-card text-foreground" role="img" aria-label="Pilot">
              <Bot className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 space-y-3 text-[15px] leading-6 text-foreground">
              <p className="w-fit max-w-full border border-border bg-white/[0.05] px-4 py-3">I compared the XRP/RLUSD order book with the AMM pool through Harbor, built the swap and simulated it on Testnet.</p>
              <PreviewRoutes />
            </div>
          </div>
          <ol className="mt-auto flex flex-wrap justify-center gap-2 border-t border-border pt-4" aria-label="Pilot flow">
            {pilotFlow.map((step, index) => (
              <li
                key={step.title}
                className={`border px-2.5 py-1 font-mono text-xs uppercase tracking-wide ${
                  step.title === "Approve" ? "border-primary/40 bg-primary/10 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : index < 3 ? "border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" : "border-border text-muted-foreground"
                }`}
              >
                {index < 3 ? "✓ " : ""}
                {step.title}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex min-w-0 flex-col gap-4 border-t border-border p-4 sm:p-6 lg:border-t-0">
          {approvalEvent ? <IntentCard event={approvalEvent} hideSigningNote /> : null}
          <PreviewPolicyChecks />
        </div>
      </div>
    </figure>
  );
}

const previewChecks = [
  { label: "Network", value: "Testnet · allowed" },
  { label: "Issuer", value: "RLUSD · allowlisted" },
  { label: "Slippage", value: "1% · max 1%" },
  { label: "Size", value: "$500 · owner signs" },
] as const;

/** Policy result for the hero swap: every rule passes, so the owner only has to sign. */
function PreviewPolicyChecks() {
  return (
    <section aria-label="Policy checks" className="flex flex-1 flex-col border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
          Policy checks
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">4 of 4 passed</span>
      </div>
      <dl className="grid flex-1 grid-cols-2 gap-px bg-border">
        {previewChecks.map((check) => (
          <div key={check.label} className="flex flex-col justify-center bg-card px-4 py-2.5">
            <dt className="label-mono text-[10px]">{check.label}</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 text-[13px] text-foreground">
              <Check className="h-3.5 w-3.5 shrink-0 text-executed" aria-hidden="true" />
              {check.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Problem() {
  return (
    <Section
      id="problem"
      eyebrow="The problem"
      title="Every XRPL trading app rebuilds the same seven steps."
      lede="Moving money on the ledger takes the same sequence every time. Each step is custom code, and each one carries a way to lose funds."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:items-stretch">
        <ol data-reveal-stagger className="grid border border-border bg-card" aria-label="The seven steps every app rebuilds">
          {builderSteps.map((step) => (
            <li
              key={step.n}
              className="grid min-h-14 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-b border-border px-5 py-3 last:border-b-0 sm:grid-cols-[2rem_minmax(0,1fr)_minmax(0,15rem)]"
            >
              <span className="font-mono text-[11px] text-muted-foreground">{step.n}</span>
              <span className="text-[15px] font-medium leading-snug text-foreground">{step.title}</span>
              {step.risk ? (
                <span className="col-start-2 font-mono text-[11px] uppercase leading-5 tracking-wide text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))] sm:col-start-auto sm:text-right">
                  Risk · {step.risk}
                </span>
              ) : (
                <span className="col-start-2 font-mono text-[11px] uppercase leading-5 tracking-wide text-muted-foreground sm:col-start-auto sm:text-right">Where every trade starts</span>
              )}
            </li>
          ))}
        </ol>
        <div className="bracket bracket-accent flex flex-col border border-primary/40 bg-[color-mix(in_srgb,var(--primary)_6%,var(--background))] p-7 sm:p-8">
          <span className="flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]">
            <span aria-hidden="true" className="h-1.5 w-1.5 bg-primary" />
            The fix
          </span>
          <span className="mt-4 text-[2.5rem] font-normal leading-none tracking-[-0.03em] text-foreground">Harbor</span>
          <span className="mt-4 text-base font-medium leading-snug text-foreground">One MCP server or REST API for all seven.</span>
          <ul className="mt-6 space-y-3">
            {["Same checks on every transaction", "Less code to write, test and maintain", "Durable retries and ledger confirmation"].map((point) => (
              <li key={point} className="flex gap-2.5 text-sm leading-6 text-foreground/85">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
          <a href="#harbor" className="link-dashed mt-auto inline-flex items-center gap-1.5 self-start pt-8 font-mono text-[11px] uppercase tracking-wide text-foreground">
            See how Harbor works <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>

      <div className="mt-16 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch">
        <div className="border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h3 className="text-[15px] font-medium text-foreground">A trader today</h3>
            <span className="label-mono text-[10px]">Four tools</span>
          </div>
          <ol className="p-5">
            {traderToday.map((row) => {
              const Icon = row.icon;
              return (
                <li key={row.stage}>
                  <div className="flex items-center gap-3 border border-border bg-white/[0.02] px-3.5 py-3">
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="w-20 text-sm font-medium text-foreground">{row.stage}</span>
                    <span className="text-sm text-muted-foreground">{row.tool}</span>
                  </div>
                  {row.gap ? (
                    <p className="flex items-center gap-2.5 py-2 pl-4">
                      <span aria-hidden="true" className="h-5 border-l border-dashed border-border-strong" />
                      <X className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{row.gap}</span>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <p className="border-t border-border px-5 py-3.5 text-xs leading-5 text-muted-foreground">Nothing records what you did, or why.</p>
        </div>

        <div className="hidden items-center lg:flex" aria-hidden="true">
          <ArrowRight className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="bracket border border-border-strong bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h3 className="text-[15px] font-medium text-foreground">With Pilot on Harbor</h3>
            <span className="label-mono text-[10px] text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]">One workspace</span>
          </div>
          <ol className="p-5">
            {traderPilot.map((row) => (
              <li key={row.stage}>
                <div
                  className={`flex items-center gap-3 border px-3.5 py-3 ${
                    "accent" in row && row.accent ? "bracket bracket-accent border-primary/50 bg-primary/[0.06]" : "border-border bg-white/[0.02]"
                  }`}
                >
                  <Check className={`h-4 w-4 ${"accent" in row && row.accent ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]"}`} aria-hidden="true" />
                  <span className="w-20 text-sm font-medium text-foreground">{row.stage}</span>
                  <span className="text-sm text-muted-foreground">{row.detail}</span>
                </div>
                {row.link ? (
                  <p className="flex items-center gap-2.5 py-2 pl-4">
                    <span aria-hidden="true" className="h-5 border-l border-executed/50" />
                    <ArrowDown className="h-3.5 w-3.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
                    <span className="font-mono text-[11px] uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">{row.link}</span>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="border-t border-border px-5 py-3.5 text-xs leading-5 text-muted-foreground">
            One workspace that remembers your preferences, permissions and past decisions.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Harbor() {
  return (
    <Section
      id="harbor"
      eyebrow="Harbor · For builders"
      title="One MCP server and REST API for market data and controlled XRPL transactions."
      lede="Agents connect over MCP. Apps connect over REST. Both get the same typed operations and the same checks, from market research to a confirmed transaction."
    >
      <ol data-reveal-stagger className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {harborFlow.map((step) => {
          const accent = "accent" in step && step.accent;
          return (
            <li key={step.n} className={`flex flex-col p-5 sm:p-6 ${accent ? "bracket bracket-accent bg-[color-mix(in_srgb,var(--primary)_6%,var(--background))]" : "bg-background"}`}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="flex items-baseline gap-3 text-[15px] font-medium text-foreground">
                  <span className={`font-mono text-[11px] ${accent ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-muted-foreground"}`}>{step.n}</span>
                  {step.title}
                </h3>
                <OwnerChip owner={step.owner} accent={accent} />
              </div>
              <ul className="mt-4 space-y-2">
                {step.points.map((point) => (
                  <li key={point} className="flex gap-2.5 text-sm leading-6 text-muted-foreground">
                    <span aria-hidden="true" className={`mt-[9px] h-1 w-1 shrink-0 ${accent ? "bg-primary" : "bg-muted-foreground"}`} />
                    {point}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      <div className="mt-16 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start lg:gap-12">
        <div className="min-w-0">
          <h3 className="text-lg font-normal tracking-[-0.01em] text-foreground">Same operation, either door.</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            An agent asks Harbor&apos;s MCP server to run a typed call. A backend posts the same arguments to the REST endpoint. Both return the
            same envelope: data, the ledger it came from, and any caveats.
          </p>
          <div className="mt-8 space-y-5">
            {operationGroups.map((group) => (
              <div key={group.title}>
                <p className="label-mono text-[10px]">{group.title}</p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {group.ops.map((op) => (
                    <li key={op} className="border border-border bg-white/[0.02] px-1.5 py-0.5 font-mono text-[11px] text-foreground/85">
                      {op}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <CodeSample />
      </div>
    </Section>
  );
}

function Pilot() {
  return (
    <Section
      id="pilot"
      eyebrow="Pilot · For traders"
      title="AI research and safe trading in one workspace."
      lede="Pilot is our trading harness, built on Harbor. Ask about your account and the market; it proposes a trade with the exact details, follows your limits, confirms the result and remembers your choices."
    >
      <ol data-reveal-stagger className="grid grid-cols-1 gap-px border border-border bg-border lg:grid-cols-5" aria-label="Pilot flow">
        {pilotFlow.map((step, index) => {
          const accent = step.title === "Approve";
          return (
            <li key={step.title} className={`relative flex flex-col gap-1.5 px-4 py-4 ${accent ? "bracket bracket-accent bg-[color-mix(in_srgb,var(--primary)_6%,var(--background))]" : "bg-card"}`}>
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-baseline gap-2.5">
                  <span className={`font-mono text-[11px] ${accent ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-muted-foreground"}`}>0{index + 1}</span>
                  <span className={`text-[15px] ${accent ? "font-medium text-foreground" : "text-foreground"}`}>{step.title}</span>
                </span>
                {index < pilotFlow.length - 1 ? <ArrowRight className="hidden h-3.5 w-3.5 text-muted-foreground lg:block" aria-hidden="true" /> : null}
              </span>
              <span className="text-xs leading-5 text-muted-foreground">{step.detail}</span>
            </li>
          );
        })}
      </ol>

      <dl data-reveal-stagger className="mt-6 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-6 xl:grid-cols-5">
        {pilotFeatures.map((feature, index) => (
          <div key={feature.title} className={`flex flex-col bg-background p-5 xl:col-span-1 ${index < 3 ? "lg:col-span-2" : "lg:col-span-3"} ${index === 4 ? "sm:col-span-2" : ""}`}>
            <dt className="text-[15px] font-medium leading-snug text-foreground">{feature.title}</dt>
            <dd className="mt-2 text-sm leading-6 text-muted-foreground">{feature.body}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12">
        <p className="label-mono">Inside the app</p>
        <ul data-reveal-stagger className="mt-3 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
          {appLinks.map((link, index) => {
            const Icon = link.icon;
            return (
              <li key={link.href} className={index === 4 ? "sm:col-span-2 lg:col-span-1" : ""}>
                <Link href={link.href} className="bracket bracket-hover group flex h-full flex-col gap-3 bg-card px-4 py-4 transition hover:bg-[color-mix(in_srgb,var(--foreground)_3%,var(--card))]">
                  <span className="flex items-center justify-between">
                    <Icon className="h-4 w-4 text-muted-foreground group-hover:text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" strokeWidth={1.75} aria-hidden="true" />
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:group-hover:translate-x-0" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-foreground">{link.label}</span>
                    <span className="mt-1 block font-mono text-[10px] uppercase leading-4 tracking-wide text-muted-foreground">{link.detail}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

function Learning() {
  return (
    <Section
      id="learning"
      eyebrow="The learning loop"
      title="Pilot gets better at helping you, only with your review."
      lede="Follow one message from your question to the XRP Ledger and back. Watch where Pilot checks your limits, where it asks you to sign, and how it learns what you prefer, only after you say yes."
    >
      <LearningLoop />
    </Section>
  );
}

function Architecture() {
  return (
    <Section
      id="architecture"
      eyebrow="Architecture · One engine, many apps"
      title="Harbor powers the infrastructure. Pilot brings it to traders."
      lede="Pilot is the first app on Harbor, not a gate in front of it. Other developers connect their own bots, sites and agents directly, and get the same actions and checks Pilot uses. Dashed boxes are examples; no outside apps use Harbor yet."
    >
      <ArchitectureDiagram />
      <p className="mt-4 border-l-2 border-primary/40 pl-3 text-sm font-medium text-muted-foreground">
        RPC, confirmations and agent-key monitoring on QuickNode
      </p>
    </Section>
  );
}

function UseCases() {
  return (
    <Section id="use-cases" eyebrow="Use cases" title="One infrastructure layer for trading, payments and liquidity apps.">
      <ul data-reveal-stagger className="grid gap-4 md:grid-cols-2">
        {useCases.map((useCase) => (
          <li
            key={useCase.title}
            className={`flex flex-col p-6 ${useCase.built ? "bracket bracket-accent border border-primary/50 bg-primary/[0.05]" : "border border-dashed border-border-strong"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-normal tracking-[-0.01em] text-foreground">{useCase.title}</h3>
              <span
                className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                  useCase.built ? "border-primary/40 bg-primary/10 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "border-border text-muted-foreground"
                }`}
              >
                {useCase.built ? "Built · Pilot" : "Example"}
              </span>
            </div>
            <ul className="mt-5 space-y-2.5">
              {useCase.points.map((point) => (
                <li key={point} className="flex gap-2.5 text-sm leading-6 text-muted-foreground">
                  <span aria-hidden="true" className={`mt-[9px] h-1 w-1 shrink-0 ${useCase.built ? "bg-primary" : "bg-muted-foreground"}`} />
                  {point}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Safety() {
  return (
    <Section
      id="safety"
      eyebrow="Safety"
      title="Controls that hold even when an agent or a connection doesn't."
      lede="Agents make mistakes and networks drop. Harbor and Pilot are built so that neither turns into a wrong, repeated or unsigned-for trade."
    >
      <ol data-reveal-stagger className="grid gap-px border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
        {safety.map((item, index) => (
          <li key={item.title} className="flex flex-col bg-card p-6">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-muted-foreground">0{index + 1}</span>
              <ShieldCheck className="h-4 w-4 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
            </div>
            <h3 className="mt-4 text-[15px] font-medium text-foreground">{item.title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
            {"chips" in item ? (
              <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Delegate permissions">
                {item.chips.map((chip) => (
                  <li key={chip} className="border border-executed/30 bg-executed/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">
                    {chip}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-6 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-wide text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]">
        <span aria-hidden="true" className="h-1.5 w-1.5 bg-approval" />
        Testnet only today. Mainnet comes after a published review.
      </p>
    </Section>
  );
}

function Roadmap() {
  return (
    <Section id="roadmap" eyebrow="Roadmap" title="Built for Testnet today. Designed for broader XRPL adoption.">
      <ol data-reveal-stagger className="grid gap-6 lg:grid-cols-3">
        {roadmap.map((column) => (
          <li key={column.phase} className="flex flex-col">
            <p className={`border-b-2 pb-3 text-center font-mono text-[11px] uppercase tracking-[0.06em] ${column.active ? "border-primary text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "border-border text-muted-foreground"}`}>
              {column.phase}
            </p>
            <div className={`mt-4 flex-1 p-6 ${column.active ? "bracket bracket-accent border border-border-strong bg-card" : "border border-border bg-card"}`}>
              <h3 className="text-lg font-normal tracking-[-0.01em] text-foreground">{column.title}</h3>
              <ul className="mt-5 space-y-2.5">
                {column.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm leading-6 text-muted-foreground">
                    {column.active ? (
                      <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 bg-muted-foreground" />
                    )}
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden border-b border-border">
      <div aria-hidden="true" className="bg-rules pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28">
        <p className="label-mono">Start on Testnet</p>
        <h2 id="cta-title" className="mt-4 text-balance text-[1.75rem] font-normal leading-tight tracking-[-0.02em] text-foreground sm:text-[2rem]">
          Research, approve and confirm your next XRPL trade in one place.
        </h2>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/chat"
            className="bracket bracket-light inline-flex h-10 items-center gap-2 bg-foreground px-4 pointer-coarse:h-11 font-mono text-[11px] font-medium uppercase tracking-wide text-background transition hover:bg-foreground/90"
          >
            Launch workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <Link
            href="/onboarding"
            className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border-strong bg-white/[0.03] px-4 pointer-coarse:h-11 font-mono text-[11px] uppercase tracking-wide text-foreground transition hover:bg-white/[0.06]"
          >
            Guided setup
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <LandingBrand />
        <p className="label-mono text-[10px]">Harbor MCP &amp; API · Pilot trading harness · Built for XRPL Testnet</p>
      </div>
      <nav aria-label="Footer">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 pointer-coarse:gap-y-0">
          {appLinks.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="inline-flex items-center font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#landing-main"
        className="fixed left-3 top-3 z-50 -translate-y-24 bg-primary px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-primary-foreground transition focus:translate-y-0"
      >
        Skip to content
      </a>
      <LandingNav />
      <LandingMotion />
      <main id="landing-main">
        <Hero />
        <Problem />
        <Harbor />
        <Pilot />
        <Architecture />
        <Learning />
        <UseCases />
        <Safety />
        <Roadmap />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
