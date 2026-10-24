import {
  ArrowRight,
  BarChart3,
  Bot,
  CandlestickChart,
  Check,
  CircleDollarSign,
  CopyX,
  FileCheck2,
  Gauge,
  KeyRound,
  Map as MapIcon,
  MessageCircle,
  MessageSquare,
  Navigation2,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
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
/* Content follows the October 2026 pitch deck. Counts it states:       */
/*  - 64 operations: 27 read · 16 build · 21 execute                     */
/*  - 23 venues: packages/harbor-client/fixtures/reads.json venues.list */
/*  - 7 delegate permissions: contracts allowed_tx_types / portfolio    */
/* ------------------------------------------------------------------ */

const builderSteps = [
  { n: "1", title: "Fetch prices and balances", risk: "Stale or outdated prices", fix: "Prices read live from the ledger" },
  { n: "2", title: "Write the transaction", risk: "Wrong amount or token", fix: "Exact trade built and simulated" },
  { n: "3", title: "Check the user's limits", risk: "Limit gets skipped", fix: "Your limits enforced every time" },
  { n: "4", title: "Approve and sign", risk: "Wrong trade gets signed", fix: "Approval tied to the exact trade" },
  { n: "5", title: "Send and confirm", risk: "Sent twice, or result lost", fix: "Sent once, confirmed and recovered" },
] as const;

const traderSteps = [
  { n: "1", today: "Check prices", where: "on a charts website", icon: BarChart3, wrong: "Prices copied by hand", fix: "Agent reads the live market" },
  { n: "2", today: "Ask what to trade", where: "in an AI chatbot", icon: MessageSquare, wrong: "Can't see your limits", fix: "Proposes a trade within your limits" },
  { n: "3", today: "Retype the trade", where: "into your wallet app", icon: KeyRound, wrong: "Easy to mistype the trade", fix: "You approve the exact details" },
  { n: "4", today: "Check if it went through", where: "on a ledger lookup site", icon: Search, wrong: "No record of what or why", fix: "Confirmed and recorded on the ledger" },
] as const;

/** The three ways in. All of them reach the same 64 operations. */
const surfaces = [
  { audience: "For traders", name: "Pilot workspace", code: null, detail: "An AI trading harness. The model never holds a signing key.", accent: true },
  { audience: "For agents", name: "MCP server", code: "search · execute", detail: "Runs in a sandbox with no internet access.", accent: false },
  { audience: "For apps", name: "REST API", code: "POST /api/ops/{op}", detail: "The same 64 operations.", accent: false },
] as const;

const operationColumns = [
  {
    count: 27,
    title: "Read",
    groups: [
      { count: 14, title: "Market reads", detail: "Balances, order books, quotes, AMM pools" },
      { count: 8, title: "Research", detail: "Token risk flags, yield, docs, XRP perps" },
      { count: 5, title: "Venues & skills", detail: "23-venue catalog, safety playbooks" },
    ],
  },
  {
    count: 16,
    title: "Build",
    groups: [{ count: null, title: "Transaction builders", detail: null, chips: ["Swaps", "Offers", "Payments", "Trust lines", "AMM", "Vaults", "Escrow", "Checks", "Simulation"] }],
  },
  {
    count: 21,
    title: "Execute",
    groups: [
      { count: 8, title: "Execution", detail: "Submit, track, permissions and limits" },
      { count: 13, title: "Payments & infra", detail: "Mastercard agent mandates, RPC health" },
    ],
  },
] as const;

const tradeFlow = [
  { n: "01", title: "Connect", owner: "App", points: ["AI agents use the MCP server", "Regular apps use the REST API"] },
  { n: "02", title: "Read the market", owner: "Engine", points: ["Prices, balances, order books", "64 operations over MCP and REST"] },
  { n: "03", title: "Build the trade", owner: "Engine", points: ["Writes the unsigned transaction", "Swaps, orders, payments, pools"] },
  { n: "04", title: "Check limits", owner: "Engine", points: ["Reserves the spending limit", "Guards against duplicate execution"] },
  { n: "05", title: "Approve", owner: "User", points: ["Approval matches the exact trade", "Signed trade is checked again"], accent: true },
  { n: "06", title: "Confirm", owner: "Engine", points: ["Reads the result from the ledger", "Recovers it if the connection drops"] },
] as const;

const dataSources = [
  { name: "XRP Ledger", detail: "Balances, orders, XRP/RLUSD price" },
  { name: "XRPL.to · XRPSCAN · Bithomp", detail: "Tokens, accounts, history" },
  { name: "XRPL docs", detail: "Transaction rules" },
  { name: "Hyperliquid", detail: "XRP perps context" },
] as const;

/** `feature` points at the explanation in pilotFeatures shown under each step. */
const pilotFlow = [
  { title: "Account", detail: "Connect a wallet and set limits", feature: 4 },
  { title: "Research", detail: "Ask about your account and the market", feature: 0 },
  { title: "Propose", detail: "It drafts the exact trade", feature: 1 },
  { title: "Approve", detail: "You sign what you see", feature: 2 },
  { title: "Confirm", detail: "Result read from the ledger", feature: 3 },
] as const;

const pilotFeatures = [
  { title: "An AI trading agent built for XRPL", body: "Ask from any page about your account and the market. The agent reads quotes, order books, AMM pools and the venue catalog live from the ledger." },
  { title: "Proposals with the exact details", body: "Choose one-time, recurring or autonomous. Every proposal arrives as a card with the asset, amount, route, fee and policy result." },
  { title: "Trades follow your limits", body: "Approvals show the exact details, and you sign that transaction, not a summary of it. Per-trade caps, a daily budget and an issuer allowlist are checked every time." },
  { title: "Confirms and remembers", body: "Pilot reads the result back from the ledger, then remembers your choices for the next trade." },
  { title: "Permissions you can revoke", body: "Pilot never holds your owner key. Owner actions are signed in your own wallet, and any permission you grant can be revoked at any time." },
] as const;

const appLinks = [
  { href: "/chat", label: "Chat", detail: "Plan, approve and follow each action", icon: MessageCircle },
  { href: "/markets", label: "Markets", detail: "Order books, AMM pools and liquidity analytics", icon: CandlestickChart },
  { href: "/map", label: "Map", detail: "The XRPL venue catalog", icon: MapIcon },
  { href: "/portfolio", label: "Portfolio", detail: "Balances, positions and budget", icon: CircleDollarSign },
  { href: "/memory", label: "Memory", detail: "Notes, policy and knowledge graph", icon: Sparkles },
  { href: "/chat?strategy=manage", label: "Strategies", detail: "Describe a strategy in chat and review its limits", icon: Bot },
] as const;

const memoryLoop = [
  { n: "1", title: "Trade", detail: "Validated on the ledger" },
  { n: "2", title: "Reflect", detail: "Expected vs actual fill, slippage and result" },
  { n: "3", title: "Remember", detail: "Saved to your journal, trades and token notes" },
  { n: "4", title: "Propose", detail: "The agent suggests a better preference" },
  { n: "5", title: "Approve", detail: "Saved only if you accept. The next trade reads it", accent: true },
] as const;

const memoryPromises = [
  { title: "An Obsidian vault you own", detail: "Linked Markdown notes, versioned in Git" },
  { title: "Any model, same memory", detail: "Switch models through OpenRouter anytime" },
  { title: "New chats keep context", detail: "The agent searches your vault on every run" },
  { title: "Nothing saved without you", detail: "Preferences apply only after you approve" },
] as const;

const memoryInfluences = [
  { name: "Google Harness²", detail: "Improves its own prompts, skills and memory" },
  { name: "Hermes Agent · Nous Research", detail: "Learns skills, remembers across sessions" },
  { name: "Obsidian vault", detail: "Memory as linked Markdown notes" },
] as const;

const useCases = [
  {
    title: "Compare swap prices",
    built: true,
    points: ["The agent compares order book and AMM pool prices", "The trader approves the exact swap", "Pilot confirms the result on the ledger"],
  },
  {
    title: "Autonomous strategies",
    built: true,
    points: ["Recurring buys, price triggers or rebalancing", "You approve one signed mandate with hard limits", "Pause, stop or kill it account-wide at any time"],
  },
  {
    title: "Payments app",
    built: false,
    points: ["Sends RLUSD and XRP within the user's limits", "The user approves each payment", "If the connection drops, the result is recovered from the ledger"],
  },
  {
    title: "Liquidity app",
    built: false,
    points: ["Reads the pool's size and fees", "Prepares the deposit", "Nothing moves until the user approves"],
  },
] as const;

const delegatePermissions = ["Create offers", "Cancel offers", "Manage trust lines", "Deposit liquidity", "Withdraw liquidity", "Finish escrows", "Cash checks"] as const;

/** Large screens use a 4-column grid (1+2+1, then 1+1+2); tablets use an even 2-column grid. */
const safety = [
  { title: "No owner keys", icon: KeyRound, body: "The model never holds a signing key. Owner-signed actions go to your wallet as sign-only requests." },
  { title: "Revocable permissions", icon: UserCheck, span: "lg:col-span-2", body: "Autonomous actions run only through delegate permissions you grant on-ledger, seven by default, and you can revoke them at any time. An account-wide kill switch stops them all.", chips: delegatePermissions },
  { title: "Limits enforced every time", icon: Gauge, body: "Spending limits are checked and reserved before anything is signed or sent to the ledger." },
  { title: "Approval tied to the exact trade", icon: FileCheck2, body: "An approval is bound to one transaction. The signed trade is checked against it again before submission." },
  { title: "Sent once", icon: CopyX, body: "Durable idempotency means a retried request cannot send the same trade twice." },
  { title: "Confirmed and recovered", icon: RotateCcw, span: "lg:col-span-2", body: "Results are read back from the ledger, and recovered if the connection drops mid-flight." },
] as const;

const roadmap: readonly { phase: string; title: string; active: boolean; items: readonly string[] }[] = [
  {
    phase: "Today · Testnet",
    title: "Built and open source",
    active: true,
    items: ["Live end-to-end trades in the Pilot app", "64 XRPL operations over MCP and REST", "Ledger, QuickNode, AWS and Mastercard integrations", "Self-improving memory in an Obsidian vault"],
  },
  {
    phase: "Next",
    title: "Launch on Mainnet",
    active: false,
    items: ["Security audit, then launch on XRPL Mainnet", "Closed beta with traders already using AI", "Public trade journal, verifiable on the ledger", "First developer partners on the MCP and API"],
  },
  {
    phase: "Later",
    title: "Full platform launch",
    active: false,
    items: ["Open to every AI model and DEX trader", "Hosted MCP and API for any XRPL app", "Strategy templates: DCA, rebalancing, ladders", "Integrate lending and staking as they launch on XRPL"],
  },
];

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
  scrollMargin = "scroll-mt-20",
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Room left above the section when jumped to; smaller lands lower on the page. */
  scrollMargin?: string;
}) {
  const headingId = `${id ?? eyebrow.toLowerCase().replace(/[^a-z]+/g, "-")}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className={`${scrollMargin} border-b border-border ${className}`}>
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div data-reveal>
          <p className="label-mono">{eyebrow}</p>
          <h2 id={headingId} className="mt-3 max-w-3xl text-balance text-[1.5rem] font-semibold leading-tight tracking-[-0.02em] text-foreground outline-none sm:text-[1.75rem] font-display">
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
      className={`border px-1.5 py-0.5 text-xs rounded ${
        accent ? "border-primary-soft-border bg-primary-soft text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : owner === "Engine" ? "border-info/30 bg-info/10 text-info" : "border-border text-muted-foreground"
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
      <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24 lg:px-8">
        <div className="mx-auto max-w-5xl text-center">
          <p className="inline-flex items-center gap-2 border border-border-strong bg-card px-2 py-1 text-[13px] text-foreground/80 rounded-xl">
            <span aria-hidden="true" className="h-1.5 w-1.5 bg-primary" />
            Pilot · Security-first · Self-improving
          </p>
          <h1 id="hero-title" className="mx-auto mt-7 max-w-5xl text-balance text-[2.125rem] font-semibold leading-[1.08] tracking-[-0.03em] text-foreground sm:text-[2.75rem] lg:text-[3.25rem] font-display">
            The security-first, self-improving AI harness for trading agents on XRPL.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-[15px] leading-7 text-muted-foreground sm:text-base">
            Pilot runs your AI agent inside limits you set and permissions you can revoke at any time. It learns from every result, and its memory follows you across all chats and models.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/chat"
              className="bracket bracket-light inline-flex h-10 items-center gap-2 bg-primary px-4 pointer-coarse:h-11 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 rounded-md"
            >
              Launch workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link
              href="/markets"
              className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border-strong bg-card px-4 pointer-coarse:h-11 text-[13px] text-foreground transition hover:bg-secondary rounded-md"
            >
              <CandlestickChart className="h-3.5 w-3.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" /> Explore markets
            </Link>
          </div>
        </div>

        <ProductPreview />

        <dl className="mx-auto mt-10 grid max-w-5xl grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4 rounded-xl overflow-hidden">
          {[
            ["XRPL operations", "64"],
            ["Interfaces", "MCP + REST"],
            ["Delegate permissions", "7"],
            ["Venues catalogued", "23"],
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
    <figure className="border border-border bg-background/40 rounded-xl" aria-labelledby="preview-routes-title">
      <figcaption id="preview-routes-title" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3.5 py-2">
        <span className="label-mono">Sell 500 RLUSD · receive XRP</span>
        <span className="text-xs text-muted-foreground">venues.compare</span>
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
                    <span className="border border-executed/35 bg-executed/10 px-1 py-px text-xs leading-none text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded">Best</span>
                  ) : null}
                </span>
                <span className="block text-xs text-muted-foreground">{r.venue}</span>
              </span>
              <span className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
                <span aria-hidden="true" className="block h-1.5 bg-border">
                  <span className={`block h-full ${r.best ? "bg-executed" : "bg-foreground/35"}`} style={{ width: `${width}%` }} />
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">Impact {r.impact} · {r.fee}</span>
              </span>
              <span className="order-2 whitespace-nowrap text-right font-mono text-xs tabular-nums text-foreground sm:order-none">{r.out.toFixed(2)} XRP</span>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
        Best vs worst <span className="text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">+{savings} XRP</span> · simulated quotes
      </p>
    </figure>
  );
}

function ProductPreview() {
  return (
    <figure aria-labelledby="product-preview-title" className="bracket mx-auto mt-14 max-w-5xl border border-border-strong bg-card text-left sm:mt-16 rounded-xl">
      <h2 id="product-preview-title" className="sr-only">Product preview: a simulated Pilot conversation on Testnet</h2>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-[13px] text-foreground">
          <Navigation2 className="h-3.5 w-3.5 rotate-45" strokeWidth={1.75} aria-hidden="true" /> Pilot
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 border border-executed/30 bg-executed/10 px-1.5 py-0.5 text-xs text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded">
            <span aria-hidden="true" className="h-1.5 w-1.5 bg-executed" /> Testnet
          </span>
        </span>
      </div>
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-6 lg:border-r lg:border-border">
          <div className="ml-auto flex max-w-[90%] items-start justify-end gap-2">
            <p className="border border-border bg-white/[0.05] px-4 py-3 text-[15px] leading-6 text-foreground rounded-xl">Swap 500 RLUSD for XRP, max 1% slippage.</p>
            <span className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-card text-muted-foreground rounded-md" role="img" aria-label="You">
              <UserRound className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
          </div>
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-card text-foreground rounded-md" role="img" aria-label="Pilot">
              <Navigation2 className="h-[18px] w-[18px] rotate-45" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 space-y-3 text-[15px] leading-6 text-foreground">
              <p className="w-fit max-w-full border border-border bg-white/[0.05] px-4 py-3 rounded-xl">I compared the XRP/RLUSD order book with the AMM pool, built the exact swap and simulated it within your limits.</p>
              <PreviewRoutes />
            </div>
          </div>
          <ol className="mt-auto flex flex-wrap justify-center gap-2 border-t border-border pt-4" aria-label="Pilot flow">
            {pilotFlow.map((step, index) => (
              <li
                key={step.title}
                className={`border px-2.5 py-1 text-xs rounded-xl ${
                  step.title === "Approve" ? "border-primary-soft-border bg-primary-soft text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : index < 3 ? "border-executed/30 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" : "border-border text-muted-foreground"
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
    <section aria-label="Policy checks" className="flex flex-1 flex-col border border-border bg-card rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
          Policy checks
        </span>
        <span className="text-xs text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]">4 of 4 passed</span>
      </div>
      <dl className="grid flex-1 grid-cols-2 gap-px bg-border">
        {previewChecks.map((check) => (
          <div key={check.label} className="flex flex-col justify-center bg-card px-4 py-2.5">
            <dt className="label-mono">{check.label}</dt>
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
      title="Builders rebuild the same risky steps. Traders juggle four tools."
      lede="Moving money on the XRP Ledger takes the same sequence every time. Developers write it from scratch, and traders stitch it together by hand."
    >
      <p className="label-mono">The builder problem</p>
      <h3 className="mt-2 font-display text-[1.375rem] leading-snug text-foreground">Developers rebuild the same risky infrastructure from scratch.</h3>
      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-stretch">
        <div className="flex flex-col border border-border bg-card rounded-xl">
          <div className="hidden grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 border-b border-border px-5 py-2.5 sm:grid">
            <span />
            <span className="label-mono">Steps every app rebuilds</span>
            <span className="label-mono">Risk</span>
          </div>
          <ol data-reveal-stagger className="flex flex-1 flex-col" aria-label="Steps every app rebuilds">
            {builderSteps.map((step) => (
              <li key={step.n} className="grid min-h-14 flex-1 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-b border-border px-5 py-3 last:border-b-0 sm:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)]">
                <span className="font-mono text-sm text-muted-foreground">{step.n}</span>
                <span className="text-[15px] font-medium leading-snug text-foreground">{step.title}</span>
                <span className="col-start-2 flex items-center gap-2.5 text-sm leading-5 text-muted-foreground sm:col-start-auto">
                  <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"><X className="h-3 w-3" strokeWidth={2.25} /></span>
                  {step.risk}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <SolutionCard
          title="Pilot handles all five steps through one MCP server or REST API."
          label="Pilot MCP server · REST API"
          steps={builderSteps.map((step) => step.fix)}
        />
      </div>

      <p className="label-mono mt-16">The trader problem</p>
      <h3 className="mt-2 font-display text-[1.375rem] leading-snug text-foreground">Traders juggle four disconnected tools for every trade.</h3>
      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-stretch">
        <div className="flex flex-col border border-border bg-card rounded-xl">
          <div className="hidden grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 border-b border-border px-5 py-2.5 sm:grid">
            <span />
            <span className="label-mono">What you do today</span>
            <span className="label-mono">What goes wrong</span>
          </div>
          <ol data-reveal-stagger className="flex flex-1 flex-col" aria-label="What traders do today">
            {traderSteps.map((step) => {
              const Icon = step.icon;
              return (
                <li key={step.n} className="grid min-h-16 flex-1 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-b border-border px-5 py-3 last:border-b-0 sm:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)]">
                  <span className="font-mono text-sm text-muted-foreground">{step.n}</span>
                  <span className="flex min-w-0 items-center gap-3">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium leading-snug text-foreground">{step.today}</span>
                      <span className="block text-xs leading-5 text-muted-foreground">{step.where}</span>
                    </span>
                  </span>
                  <span className="col-start-2 flex items-center gap-2.5 text-sm leading-5 text-muted-foreground sm:col-start-auto">
                    <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"><X className="h-3 w-3" strokeWidth={2.25} /></span>
                    {step.wrong}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
        <SolutionCard
          title="Pilot runs all four steps in one workspace, and remembers why."
          steps={traderSteps.map((step) => step.fix)}
        />
      </div>
    </Section>
  );
}

function SolutionCard({ title, label, steps }: { title: string; label?: string; steps: readonly string[] }) {
  return (
    <div className="bracket bracket-accent flex flex-col border border-primary-soft-border bg-primary-soft p-6 sm:p-7 rounded-xl">
      <span className="flex items-center gap-2 text-xs font-medium text-primary">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary" />
        The solution
      </span>
      <p className="mt-3 font-display text-[1.25rem] leading-snug text-foreground">{title}</p>
      {label ? <p className="mt-5 border border-primary-soft-border bg-card px-3 py-2 text-center text-[13px] font-medium text-foreground rounded-lg">{label}</p> : null}
      <ol className={`${label ? "mt-2" : "mt-5"} space-y-2`}>
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-3 border border-border bg-card px-3.5 py-2.5 text-sm text-foreground rounded-lg">
            <span className="font-mono text-sm text-muted-foreground">{index + 1}</span>
            <Check className="h-3.5 w-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" aria-hidden="true" />
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

function WhatWeBuilt() {
  return (
    <Section
      id="api"
      eyebrow="What we built"
      title="AI can already read the XRP Ledger. Pilot enables it to act safely."
      lede="Traders use the Pilot workspace. Agents connect over MCP. Apps connect over REST. All three reach the same 64 operations and the same checks."
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
        <ul className="grid gap-3" aria-label="Ways in">
          {surfaces.map((surface) => (
            <li key={surface.name} className={`flex flex-col justify-center p-5 ${surface.accent ? "bracket bracket-accent border border-primary-soft-border bg-primary-soft rounded-xl" : "border border-border-strong bg-card rounded-xl"}`}>
              <p className="label-mono">{surface.audience}</p>
              <p className="mt-1.5 text-lg font-normal tracking-[-0.01em] text-foreground">{surface.name}</p>
              {surface.code ? <p className="mt-1 font-mono text-xs text-foreground/85">{surface.code}</p> : null}
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{surface.detail}</p>
            </li>
          ))}
        </ul>
        <div className="grid min-w-0 gap-px border border-border bg-border md:grid-cols-3 rounded-xl overflow-hidden" aria-label="64 operations">
          {operationColumns.map((column) => (
            <div key={column.title} className="flex min-w-0 flex-col bg-card p-5">
              <p className="flex items-baseline gap-2 border-b-2 border-foreground/80 pb-2">
                <span className="text-2xl font-normal tabular-nums tracking-[-0.02em] text-foreground">{column.count}</span>
                <span className="text-lg text-foreground">{column.title}</span>
              </p>
              <ul className="mt-4 flex flex-1 flex-col gap-3">
                {column.groups.map((group) => (
                  <li key={group.title} className="flex flex-1 flex-col justify-center border border-border bg-background/60 p-4 rounded-xl">
                    <p className="text-sm font-medium text-foreground">
                      {group.count !== null ? <span className="mr-1.5 font-mono tabular-nums text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]">{group.count}</span> : null}
                      {group.title}
                    </p>
                    {group.detail ? <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">{group.detail}</p> : null}
                    {"chips" in group ? (
                      <ul className="mt-3 flex flex-wrap gap-1.5">
                        {group.chips.map((chip) => (
                          <li key={chip} className="border border-info/30 bg-info/10 px-1.5 py-0.5 font-mono text-[11px] text-[color-mix(in_oklab,var(--info)_80%,var(--foreground))] rounded">{chip}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-16 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start lg:gap-12">
        <div className="min-w-0">
          <h3 className="text-lg font-normal tracking-[-0.01em] text-foreground">Same operation, either door.</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            An agent asks the MCP server to run a typed call from its sandbox. A backend posts the same arguments to the REST endpoint. Both
            return the same envelope: data, the ledger it came from, and any caveats.
          </p>
        </div>
        <CodeSample />
      </div>
    </Section>
  );
}

function InsideOneTrade() {
  return (
    <Section
      id="inside-one-trade"
      eyebrow="Inside one trade"
      title="From market research to a confirmed transaction."
      lede="The engine runs every step the same way, whether the request comes from the Pilot workspace, an agent or an app. You only step in to approve."
    >
      <ol className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3 rounded-xl overflow-hidden">
        {tradeFlow.map((step) => {
          const accent = "accent" in step && step.accent;
          return (
            <li key={step.n} className={`flex flex-col p-5 sm:p-6 ${accent ? "bracket bracket-accent bg-primary-soft" : "bg-card"}`}>
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
      <dl className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-[auto_repeat(4,minmax(0,1fr))] rounded-xl overflow-hidden">
        <div className="flex items-center bg-surface px-5 py-4">
          <dt className="label-mono">Where the data comes from</dt>
        </div>
        {dataSources.map((source) => (
          <div key={source.name} className="bg-card px-5 py-4">
            <dt className="text-sm font-medium text-foreground">{source.name}</dt>
            <dd className="mt-1 text-[13px] text-muted-foreground">{source.detail}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Pilot() {
  return (
    <Section
      id="pilot"
      eyebrow="The workspace"
      title="Pilot connects AI research and guardrailed trading into one workspace."
      lede="An AI trading agent built for XRPL. Ask about your account and the market; it proposes a trade with the exact details, follows your limits, confirms the result and remembers your choices."
    >
      {/* Each step sits above what it means for you. The cards share three subgrid rows (step, title, text), so every part lines up across all five. */}
      <ol data-reveal-stagger className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-5 rounded-xl overflow-hidden" aria-label="Pilot flow">
        {pilotFlow.map((step, index) => {
          const accent = step.title === "Approve";
          const feature = pilotFeatures[step.feature];
          return (
            <li key={step.title} className={`relative row-span-3 grid grid-rows-subgrid gap-y-0 ${index === pilotFlow.length - 1 ? "sm:col-span-2 lg:col-span-1" : ""} ${accent ? "bracket bracket-accent bg-primary-soft" : "bg-card"}`}>
              <div className="flex flex-col gap-1.5 px-5 pb-4 pt-5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-2.5 whitespace-nowrap">
                    <span className={`font-mono text-[15px] leading-none tabular-nums ${accent ? "text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "text-muted-foreground"}`}>0{index + 1}</span>
                    <span className="text-[15px] font-medium leading-none text-foreground">{step.title}</span>
                  </span>
                  {index < pilotFlow.length - 1 ? <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 self-center text-muted-foreground lg:block" aria-hidden="true" /> : null}
                </span>
                <span className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</span>
              </div>
              <h3 className="border-t border-border px-5 pt-4 text-[15px] font-medium leading-snug text-foreground">{feature.title}</h3>
              <p className="px-5 pb-6 pt-2 text-sm leading-6 text-muted-foreground">{feature.body}</p>
            </li>
          );
        })}
      </ol>

      <div className="mt-12">
        <p className="label-mono">Inside the app</p>
        <ul data-reveal-stagger className="mt-3 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3 rounded-xl overflow-hidden">
          {appLinks.map((link, index) => {
            const Icon = link.icon;
            return (
              <li key={link.href}>
                <Link href={link.href} className="bracket bracket-hover group flex h-full flex-col gap-3 bg-card px-4 py-4 transition hover:bg-[color-mix(in_srgb,var(--foreground)_3%,var(--card))]">
                  <span className="flex items-center justify-between">
                    <Icon className="h-4 w-4 text-muted-foreground group-hover:text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" strokeWidth={1.75} aria-hidden="true" />
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:group-hover:translate-x-0" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-foreground">{link.label}</span>
                    <span className="mt-1 block text-xs leading-4 text-muted-foreground">{link.detail}</span>
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

const integrationCards = [
  { href: "/integrations/mastercard", name: "Mastercard AP4M", line: "Pilot buys data on its own, only inside a spending permission you sign once." },
  { href: "/integrations/aws", name: "AWS", line: "Ledger text is screened before the AI reads it, and signing keys stay locked in AWS." },
  { href: "/integrations/quicknode", name: "QuickNode", line: "A faster line to the ledger, with a watchdog that freezes misused keys." },
  { href: "/integrations/ledger", name: "Ledger", line: "Routine trades run on their own; anything bigger waits for your Ledger." },
] as const;

function IntegrationsOverview() {
  return (
    <Section
      id="integrations"
      eyebrow="Integrations"
      title="Built with the infrastructure you already trust."
      lede="Each integration adds one thing Pilot couldn't do safely on its own. Open one to watch a request run through it."
    >
      <ul data-reveal-stagger className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4 rounded-xl overflow-hidden">
        {integrationCards.map((card) => (
          <li key={card.href}>
            <Link
              href={card.href}
              className="bracket bracket-hover bracket-accent group flex h-full flex-col gap-3 bg-card p-5 transition-colors hover:bg-primary-soft"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium text-foreground">{card.name}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:group-hover:translate-x-0" aria-hidden="true" />
              </span>
              <span className="text-sm leading-6 text-muted-foreground">{card.line}</span>
              <span className="link-dashed mt-auto w-fit text-xs text-muted-foreground group-hover:text-foreground">See how it works</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Learning() {
  return (
    <Section
      id="learning"
      scrollMargin="scroll-mt-0"
      eyebrow="Self-improving memory"
      title="Pilot learns from every trade, and saves nothing without you."
      lede="After each trade, Pilot compares what it expected with what happened and suggests a better preference. It only keeps what you approve, and the next trade reads it."
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="border border-border bg-card p-5 sm:p-6 rounded-xl">
          <p className="label-mono text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]">Learns from every trade</p>
          <ol data-reveal-stagger className="mt-4 space-y-2" aria-label="How Pilot learns">
            {memoryLoop.map((step) => {
              const accent = "accent" in step && step.accent;
              return (
                <li key={step.n} className={`grid grid-cols-[1.5rem_6rem_minmax(0,1fr)] items-center gap-3 border px-4 py-3 rounded-xl ${accent ? "bracket bracket-accent border-primary-soft-border bg-primary-soft" : "border-border bg-background/60"}`}>
                  <span className="font-mono text-sm text-muted-foreground">{step.n}</span>
                  <span className="text-[15px] font-medium text-foreground">{step.title}</span>
                  <span className="text-sm leading-5 text-muted-foreground">{step.detail}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <ul className="grid gap-px border border-border bg-border rounded-xl overflow-hidden" aria-label="What your memory guarantees">
          {memoryPromises.map((promise) => (
            <li key={promise.title} className="flex flex-col justify-center bg-card px-5 py-4">
              <p className="text-[15px] font-medium text-foreground">{promise.title}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{promise.detail}</p>
            </li>
          ))}
        </ul>
      </div>
      <dl className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-3 lg:grid-cols-[auto_repeat(3,minmax(0,1fr))] rounded-xl overflow-hidden">
        <div className="flex items-center bg-surface px-5 py-4 sm:col-span-3 lg:col-span-1">
          <dt className="label-mono">Built on ideas from</dt>
        </div>
        {memoryInfluences.map((item) => (
          <div key={item.name} className="bg-card px-5 py-4">
            <dt className="text-sm font-medium text-foreground">{item.name}</dt>
            <dd className="mt-1 text-[13px] leading-5 text-muted-foreground">{item.detail}</dd>
          </div>
        ))}
      </dl>

      <h3 className="mt-16 text-lg font-normal tracking-[-0.01em] text-foreground">Follow one message through the loop.</h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        From your question to the XRP Ledger and back: where Pilot checks your limits, where it asks you to sign, and how it learns what you prefer.
      </p>
      <div className="mt-8">
        <LearningLoop />
      </div>
    </Section>
  );
}

function Architecture() {
  return (
    <Section
      id="architecture"
      eyebrow="Other apps · One engine, many apps"
      title="Developers can build any XRPL app on Pilot's MCP and API."
      lede="DEX, AMM and ledger data, live and one call away. It's open source, so no one starts from scratch, and the same limits and approvals Pilot uses are built in. Dashed boxes are examples; no outside apps use it yet."
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
            className={`flex flex-col p-6 ${useCase.built ? "bracket bracket-accent border border-primary-soft-border bg-primary-soft rounded-xl" : "border border-dashed border-border-strong rounded-xl"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-normal tracking-[-0.01em] text-foreground">{useCase.title}</h3>
              <span
                className={`shrink-0 border px-1.5 py-0.5 text-xs rounded ${
                  useCase.built ? "border-primary-soft-border bg-primary-soft text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "border-border text-muted-foreground"
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
      lede="Agents make mistakes and networks drop. Pilot is built so that neither turns into a wrong, repeated or unsigned-for trade."
    >
      <ol data-reveal-stagger className="grid gap-px border border-border bg-border md:grid-cols-2 lg:grid-cols-4 rounded-xl overflow-hidden">
        {safety.map((item, index) => {
          const Icon = item.icon;
          return (
          <li key={item.title} className={`flex flex-col bg-card p-6 ${"span" in item ? item.span : ""}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="flex items-baseline gap-2.5 text-[15px] font-medium leading-none text-foreground">
                <span className="font-mono font-normal tabular-nums text-muted-foreground">0{index + 1}</span>
                {item.title}
              </h3>
              <Icon className="h-4 w-4 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{item.body}</p>
            {"chips" in item ? (
              <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Delegate permissions">
                {item.chips.map((chip) => (
                  <li key={chip} className="border border-executed/30 bg-executed/10 px-1.5 py-0.5 text-xs text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))] rounded">
                    {chip}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
          );
        })}
      </ol>
      <p className="mt-6 flex items-center gap-2.5 text-[13px] text-[color-mix(in_oklab,var(--approval)_80%,var(--foreground))]">
        <span aria-hidden="true" className="h-1.5 w-1.5 bg-approval" />
        Live on Testnet today. Mainnet launches after a security audit.
      </p>
    </Section>
  );
}

function Roadmap() {
  return (
    <Section id="roadmap" eyebrow="Roadmap and traction" title="Pilot is live on Testnet. Mainnet with real users is next.">
      <ol data-reveal-stagger className="grid gap-6 lg:grid-cols-3">
        {roadmap.map((column) => (
          <li key={column.phase} className="flex flex-col">
            <p className={`border-b-2 pb-3 text-center text-[13px] ${column.active ? "border-primary text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" : "border-border text-muted-foreground"}`}>
              {column.phase}
            </p>
            <div className={`mt-4 flex-1 p-6 ${column.active ? "bracket bracket-accent border border-border-strong bg-card rounded-xl" : "border border-border bg-card rounded-xl"}`}>
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
      <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28">
        <p className="label-mono">Start on Testnet</p>
        <h2 id="cta-title" className="mt-4 text-balance text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[2rem] font-display">
          Research, approve and confirm your next XRPL trade, inside limits you set.
        </h2>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/chat"
            className="bracket bracket-light inline-flex h-10 items-center gap-2 bg-primary px-4 pointer-coarse:h-11 text-[13px] font-medium text-primary-foreground transition hover:bg-primary/90 rounded-md"
          >
            Launch workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <Link
            href="/onboarding"
            className="bracket bracket-light inline-flex h-10 items-center gap-2 border border-border-strong bg-white/[0.03] px-4 pointer-coarse:h-11 text-[13px] text-foreground transition hover:bg-white/[0.06] rounded-md"
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
    <footer className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <LandingBrand />
        <p className="label-mono">Pilot developer APIs · Live on XRPL Testnet</p>
      </div>
      <nav aria-label="Footer">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 pointer-coarse:gap-y-0">
          {appLinks.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="inline-flex items-center text-[13px] text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}

/**
 * `integrations` is rendered inside the page, after the learning loop and
 * before the footer, so sections added from app/page.tsx never end up below it.
 */
export function LandingPage({ integrations }: { integrations?: ReactNode } = {}) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#landing-main"
        className="fixed left-3 top-3 z-50 -translate-y-24 bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition focus:translate-y-0"
      >
        Skip to content
      </a>
      <LandingNav />
      <LandingMotion />
      <main id="landing-main">
        <Hero />
        <Problem />
        <WhatWeBuilt />
        <InsideOneTrade />
        <Pilot />
        <Architecture />
        <Learning />
        <IntegrationsOverview />
        {integrations}
        <UseCases />
        <Safety />
        <Roadmap />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
