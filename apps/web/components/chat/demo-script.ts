/**
 * Scripted, fully local demo conversation for visitors without a wallet
 * session. Nothing here touches the network: every reply, card and hash is
 * generated deterministically from the prompt. All values are simulated.
 */
import type { CardEvent, CardState, Intent, PolicyResult } from "@pilot/contracts";

import { demoAwsTrust, demoIntent, fixtureEvent } from "../../app/chat/fixtures";

export type DemoScenarioId =
  | "swap"
  | "vault"
  | "blocked"
  | "compare"
  | "limits"
  | "portfolio"
  | "fallback";

export type DemoBlock =
  | {
      kind: "table";
      caption: string;
      columns: string[];
      rows: string[][];
      /** Index of the row to emphasise (e.g. best route). */
      highlight?: number;
      /** Column indexes that are numeric (right aligned). */
      numeric?: number[];
    }
  | { kind: "stats"; items: { label: string; value: string }[] }
  | { kind: "link"; href: string; label: string };

export type DemoPlan = {
  scenario: DemoScenarioId;
  /** First paragraph, streamed before any card appears. */
  reply: string;
  blocks?: DemoBlock[];
  /** Card states for one intent, shown in order with short delays. */
  events: CardEvent[];
  /** Short line appended after the card sequence finishes. */
  followUp?: string;
};

export type DemoSuggestion = { prompt: string; scenario: DemoScenarioId };

export const DEMO_SUGGESTIONS: DemoSuggestion[] = [
  { prompt: "Review the recorded Ledger approval", scenario: "swap" },
  { prompt: "Swap 80 RLUSD for XRP, max 1% slippage", scenario: "swap" },
  { prompt: "Swap 1,000 XRP to RLUSD at the best rate", scenario: "swap" },
  { prompt: "Compare AMM vs order book for 1,000 XRP", scenario: "compare" },
  { prompt: "Deposit 100 XRP into the vault", scenario: "vault" },
  { prompt: "Why would FREEMONEY be blocked?", scenario: "blocked" },
  { prompt: "What are my spending limits?", scenario: "limits" },
  { prompt: "Show my portfolio", scenario: "portfolio" },
];

/** Simulated policy and market values, consistent with the Portfolio and Markets fixtures. */
export const DEMO_POLICY = {
  executeUnderUsd: 250,
  maxPerTxUsd: 2_000,
  dailyCapUsd: 5_000,
  usedTodayUsd: 820.48,
  maxSlippageBps: 100,
};
const XRP_PRICE_RLUSD = 0.5176;

const RLUSD = demoIntent.sell;
const XRP = { currency: "XRP" } as const;
const SIM_LEDGER = 9_843_206;

type SwapAsset = "XRP" | "RLUSD";
export type ParsedSwap = { amount: number; sell: SwapAsset; buy: SwapAsset };

const usd = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (value: number, digits = 2) =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });

/** Parses "swap 50 rlusd for xrp", "sell 1,000 XRP to RLUSD", "convert 20 xrp into rlusd". */
export function parseSwap(prompt: string): ParsedSwap | null {
  const match = /\b(?:swap|sell|convert|trade|exchange)\s+([\d][\d,]*(?:\.\d+)?)\s*(xrp|rlusd)\b.*?\b(?:for|to|into)\s+(xrp|rlusd)\b/i.exec(prompt);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  const sell = match[2].toUpperCase() as SwapAsset;
  const buy = match[3].toUpperCase() as SwapAsset;
  if (!Number.isFinite(amount) || amount <= 0 || sell === buy) return null;
  return { amount, sell, buy };
}

export function classifyDemoPrompt(prompt: string): DemoScenarioId {
  const text = prompt.toLowerCase();
  if (text === "review the recorded ledger approval") return "swap";
  if (/freemoney|\bblocked?\b|blocklist|scam/.test(text)) return "blocked";
  if (/compare|\bvs\.?\b|versus|best route|order ?book|which route/.test(text)) return "compare";
  if (/limit|policy|budget|allowance|spend/.test(text)) return "limits";
  if (/portfolio|balance|holdings|positions?|my account/.test(text)) return "portfolio";
  if (/vault|deposit/.test(text)) return "vault";
  if (parseSwap(prompt) || /\b(swap|sell|buy|convert|trade|exchange)\b/.test(text)) return "swap";
  return "fallback";
}

/** Builds the scripted plan for a prompt. `seq` keeps intent ids unique per turn. */
export function routeDemoPrompt(prompt: string, seq: number): DemoPlan {
  if (prompt.trim().toLowerCase() === "review the recorded ledger approval") {
    return recordedLedgerOfferPlan(seq);
  }
  const scenario = classifyDemoPrompt(prompt);
  switch (scenario) {
    case "swap":
      return swapPlan(parseSwap(prompt) ?? { amount: 80, sell: "RLUSD", buy: "XRP" }, seq);
    case "vault":
      return vaultPlan(prompt, seq);
    case "blocked":
      return blockedPlan(seq);
    case "compare":
      return comparePlan(prompt);
    case "limits":
      return limitsPlan();
    case "portfolio":
      return portfolioPlan();
    default:
      return {
        scenario: "fallback",
        reply:
          "I can plan, simulate and route XRPL actions through Harbor, check them against your spending policy, and hand anything above your auto-execute limit to your wallet for a sign-only approval. In this demo every answer is simulated. Try a swap, a vault deposit, a route comparison, or ask about your limits.",
        events: [],
      };
  }
}

function recordedLedgerOfferPlan(seq: number): DemoPlan {
  const intent: Intent = {
    ...demoIntent,
    id: `intent-demo-ledger-${seq}`,
    amount: "100",
  };
  const txJson = {
    TransactionType: "OfferCreate",
    Account: "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ",
    Flags: 0x0004_0000,
    TakerPays: {
      currency: "RLUSD",
      issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      value: "100",
    },
    TakerGets: "75000000",
    Fee: "12",
  };
  const events = sequence(
    ["drafting", "planned", "simulated", "policy_checked", "awaiting_approval"],
    intent,
    {
      action: "Swap RLUSD for XRP",
      amounts: ["100 RLUSD", "75 XRP"],
      value: 100,
      approvalReason: "Recorded Ledger owner-approval replay",
    },
  ).map((event) => ({
    ...event,
    ...(event.build ? { build: { ...event.build, tx_json: txJson } } : {}),
    ...(event.exec?.status === "needs_approval"
      ? { exec: { ...event.exec, tx_json: txJson } }
      : {}),
  }));
  return {
    scenario: "swap",
    reply: "This local fixture replays the exact bounded OfferCreate fields captured from the authorized public-seed Speculos run. It never signs or submits.",
    events,
    followUp: "Review all eleven recorded screens and use both buttons only on the final confirmation screen.",
  };
}

function swapUsd(swap: ParsedSwap) {
  return swap.sell === "RLUSD" ? swap.amount : swap.amount * XRP_PRICE_RLUSD;
}

function swapPlan(swap: ParsedSwap, seq: number): DemoPlan {
  const value = swapUsd(swap);
  const intent: Intent = {
    ...demoIntent,
    id: `intent-demo-${seq}`,
    sell: swap.sell === "RLUSD" ? RLUSD : XRP,
    buy: swap.buy === "RLUSD" ? RLUSD : XRP,
    amount: String(swap.amount),
  };
  const receive = swap.sell === "XRP" ? swap.amount * XRP_PRICE_RLUSD : swap.amount / XRP_PRICE_RLUSD;
  const amounts = [`${num(swap.amount)} ${swap.sell}`, `≈ ${num(receive)} ${swap.buy}`];
  const action = `Swap ${swap.sell} for ${swap.buy}`;
  const label = `${num(swap.amount)} ${swap.sell}`;

  if (value > DEMO_POLICY.maxPerTxUsd) {
    const policy: PolicyResult = {
      verdict: "block",
      reasons: [
        { rule: "max_per_tx_usd", pass: false, detail: `${usd(value)} exceeds the ${usd(DEMO_POLICY.maxPerTxUsd)} transaction limit` },
        { rule: "issuer_allowlist", pass: true, detail: "RLUSD issuer is allowlisted" },
      ],
    };
    return {
      scenario: "swap",
      reply: `${label} is worth about ${usd(value)}, above your ${usd(DEMO_POLICY.maxPerTxUsd)} per-transaction limit. Harbor checks policy before anything is signed, so this stops here.`,
      events: sequence(["drafting", "planned", "simulated", "blocked"], intent, { action, amounts, value, blockedPolicy: policy }),
      followUp: "Nothing was signed or submitted. Split the trade, or raise the limit in Memory → Execution policy.",
    };
  }

  if (value > DEMO_POLICY.executeUnderUsd) {
    return {
      scenario: "swap",
      reply: `I compared the XRP/RLUSD order book, the AMM pool and payment paths through Harbor. The path route pays the most for ${label}. At about ${usd(value)} this is above your ${usd(DEMO_POLICY.executeUnderUsd)} auto-execute limit, so I'll prepare it for your signature.`,
      events: sequence(["drafting", "planned", "simulated", "policy_checked", "awaiting_approval"], intent, { action, amounts, value }),
      followUp: "Review the exact transaction, then sign it in your wallet.",
    };
  }

  return {
    scenario: "swap",
    reply: `${label} is about ${usd(value)}, under your ${usd(DEMO_POLICY.executeUnderUsd)} auto-execute limit. Harbor can run it through your delegated permission: simulate first, check policy, then execute.`,
    events: sequence(["drafting", "planned", "simulated", "policy_checked", "executing", "submitted", "validated"], intent, {
      action,
      amounts,
      value,
      hashSeed: seq,
    }),
    followUp: "Done. The offer filled within your 1% slippage cap.",
  };
}

function vaultPlan(prompt: string, seq: number): DemoPlan {
  const amount = Number(/([\d][\d,]*(?:\.\d+)?)\s*xrp/i.exec(prompt)?.[1]?.replace(/,/g, "") ?? "100") || 100;
  const intent: Intent = {
    id: `intent-demo-${seq}`,
    network: "devnet",
    kind: "vault_deposit",
    vault_id: "A4E7D8C9B2F10635A4E7D8C9B2F10635A4E7D8C9B2F10635A4E7D8C9B2F10635",
    asset: XRP,
    amount: String(amount),
  };
  const value = amount * XRP_PRICE_RLUSD;
  return {
    scenario: "vault",
    reply: `The XRP Single Asset Vault on Devnet currently yields 4.20% APY. Vault deposits are always owner-signed: Pilot's delegate permissions can't move funds into a vault, so I'll prepare ${num(amount)} XRP (≈ ${usd(value)}) for your approval.`,
    events: sequence(["drafting", "planned", "simulated", "policy_checked", "awaiting_approval"], intent, {
      action: "Deposit XRP into the vault",
      amounts: [`${num(amount)} XRP`],
      value,
      approvalReason: "Vault deposits always require the owner's signature",
    }),
    followUp: "Review it and sign in your wallet.",
  };
}

function blockedPlan(seq: number): DemoPlan {
  const intent: Intent = {
    ...demoIntent,
    id: `intent-demo-${seq}`,
    sell: { currency: "FREEMONEY", issuer: "rUnknownFixtureIssuer" },
    amount: "5000",
  };
  return {
    scenario: "blocked",
    reply:
      "FREEMONEY's issuer isn't on your allowlist, and 5,000 units is worth more than your $2,000 per-transaction limit. Here's what happens when an agent tries it anyway:",
    events: sequence(["drafting", "planned", "simulated", "policy_checked", "blocked"], intent, {}),
    followUp: "Blocked before signing. Policy runs in Harbor, so a bot or agent can't skip it by retrying.",
  };
}

function comparePlan(prompt: string): DemoPlan {
  const size = Number(/([\d][\d,]*)\s*xrp/i.exec(prompt)?.[1]?.replace(/,/g, "") ?? "1000") || 1000;
  const scale = size / 1000;
  const rows: [string, number, string, string, string][] = [
    ["Path payment", 517.61, "0.5176", "7.6 bps", "12 drops"],
    ["Order book · XRPL DEX", 517.4, "0.5174", "12 bps", "12 drops"],
    ["AMM pool · XRPL AMM", 515.65, "0.5156", "45 bps", "0.300% pool fee"],
  ];
  const best = rows[0][1] * scale;
  const worst = rows[2][1] * scale;
  return {
    scenario: "compare",
    reply: `Harbor quoted three routes for selling ${num(size, 0)} XRP for RLUSD (venues.compare):`,
    blocks: [
      {
        kind: "table",
        caption: `Route comparison · sell ${num(size, 0)} XRP · simulated quotes`,
        columns: ["Route", "You receive", "Price", "Impact", "Fee"],
        rows: rows.map(([route, out, price, impact, fee]) => [route, `${num(out * scale)} RLUSD`, price, impact, fee]),
        highlight: 0,
        numeric: [1, 2, 3],
      },
      { kind: "link", href: "/markets", label: "Open the full order book and AMM pool in Markets" },
    ],
    events: [],
    followUp: `The path route returns ${num(best - worst)} RLUSD more than the AMM alone (≈ 38 bps). Say "swap ${num(size, 0)} XRP to RLUSD" and I'll route it that way.`,
  };
}

function limitsPlan(): DemoPlan {
  const remaining = DEMO_POLICY.dailyCapUsd - DEMO_POLICY.usedTodayUsd;
  return {
    scenario: "limits",
    reply: "Your execution policy lives in your vault (Pilot/Policy.md) and Harbor enforces it on every transaction:",
    blocks: [
      {
        kind: "stats",
        items: [
          { label: "Auto-execute under", value: usd(DEMO_POLICY.executeUnderUsd) },
          { label: "Per transaction", value: usd(DEMO_POLICY.maxPerTxUsd) },
          { label: "Daily cap", value: usd(DEMO_POLICY.dailyCapUsd) },
          { label: "Used today", value: `${usd(DEMO_POLICY.usedTodayUsd)} · 16%` },
          { label: "Remaining today", value: usd(remaining) },
          { label: "Max slippage", value: `${DEMO_POLICY.maxSlippageBps} bps` },
        ],
      },
      { kind: "link", href: "/memory", label: "Edit the policy in Memory" },
    ],
    events: [],
    followUp: "Issuer allowlist: RLUSD. Networks: Testnet and Devnet. Tokens whose issuer requires authorization are blocked.",
  };
}

function portfolioPlan(): DemoPlan {
  return {
    scenario: "portfolio",
    reply: "Here's your budget account (demo data):",
    blocks: [
      {
        kind: "stats",
        items: [
          { label: "Portfolio value", value: "$1,577.40" },
          { label: "24h change", value: "+1.64% · +$18.42" },
          { label: "XRP", value: "250 · $128.00" },
          { label: "RLUSD", value: "1,000 · $1,000.00" },
          { label: "XRP/RLUSD LP", value: "1,359.53 LP · $398.20" },
          { label: "Vault (Devnet)", value: "100 XRP · $51.20" },
        ],
      },
      { kind: "link", href: "/portfolio", label: "Open Portfolio" },
    ],
    events: [],
    followUp: "One resting offer: sell 10 XRP at 0.512 RLUSD. Delegation is active with 7 narrow permissions.",
  };
}

type SequenceOptions = {
  action?: string;
  amounts?: string[];
  value?: number;
  blockedPolicy?: PolicyResult;
  approvalReason?: string;
  hashSeed?: number;
};

function sequence(states: CardState[], intent: Intent, options: SequenceOptions): CardEvent[] {
  const value = options.value ?? 0;
  const remaining = DEMO_POLICY.dailyCapUsd - DEMO_POLICY.usedTodayUsd;
  const isSwapOnRlusd = intent.kind === "swap" && [intent.sell.currency, intent.buy.currency].includes("RLUSD");
  const clearPolicy: PolicyResult = {
    verdict: "execute",
    reasons: [
      { rule: "max_per_tx_usd", pass: true, detail: `${usd(value)} is within the ${usd(DEMO_POLICY.maxPerTxUsd)} limit` },
      { rule: "daily_cap_usd", pass: true, detail: `${usd(remaining)} remains today` },
      ...(isSwapOnRlusd ? [{ rule: "issuer_allowlist", pass: true, detail: "RLUSD issuer is allowlisted" }] : []),
    ],
  };
  const approvalPolicy: PolicyResult = {
    verdict: "needs_approval",
    reasons: [
      {
        rule: intent.kind === "vault_deposit" ? "owner_signed_tx_type" : "execute_under_usd",
        pass: false,
        detail: options.approvalReason ?? `Owner approval required above ${usd(DEMO_POLICY.executeUnderUsd)}`,
      },
    ],
  };
  const hash = options.hashSeed !== undefined ? simulatedHash(options.hashSeed) : undefined;

  return states.map((state) => {
    const event = fixtureEvent(state, intent);
    if (event.build && (options.action || options.amounts)) {
      event.build = {
        ...event.build,
        summary: {
          ...event.build.summary,
          ...(options.action ? { action: options.action } : {}),
          ...(options.amounts ? { amounts: options.amounts } : {}),
          usd_value: value.toFixed(2),
        },
      };
    }
    if (options.value !== undefined && (state === "policy_checked" || state === "executing")) {
      event.policy = clearPolicy;
    }
    if (state === "awaiting_approval" && event.exec?.status === "needs_approval") {
      event.policy = approvalPolicy;
      event.exec = { ...event.exec, approval_id: `approval_demo_${intent.id}`, policy: approvalPolicy };
    }
    if (state === "blocked" && options.blockedPolicy) {
      event.policy = options.blockedPolicy;
      event.exec = { status: "blocked", policy: options.blockedPolicy };
    }
    if ((state === "submitted" || state === "validated") && hash) {
      event.hash = hash;
      if (event.exec?.status === "executed") event.exec = { ...event.exec, hash, ledger_index: SIM_LEDGER };
    }
    if (state === "validated") event.trust = demoAwsTrust;
    return event;
  });
}

/* ------------------------------------------------------------------------ */
/* Pacing: a scripted turn plays out like a real agent run, not instantly.   */
/* ------------------------------------------------------------------------ */

/** Returns a float in [0, 1). Injected so tests are deterministic. */
export type DemoRng = () => number;

export type DemoStep =
  | { kind: "thinking"; delay: number; status: string }
  | { kind: "text"; delay: number; text: string }
  | { kind: "blocks"; delay: number }
  | { kind: "event"; delay: number; index: number }
  | { kind: "followUp"; delay: number }
  | { kind: "done"; delay: number };

/** What the agent is "doing" while it thinks, per scenario. */
export const DEMO_THINKING: Record<DemoScenarioId, string[]> = {
  swap: ["Reading XRP/RLUSD order book…", "Comparing AMM pool…", "Checking policy…"],
  compare: ["Reading order book depth…", "Pricing the AMM pool…", "Comparing routes…"],
  vault: ["Reading the Devnet vault…", "Checking vault permissions…"],
  blocked: ["Looking up the FREEMONEY issuer…", "Checking issuer allowlist…"],
  limits: ["Reading Pilot/Policy.md…", "Summing today's spend…"],
  portfolio: ["Reading balances…", "Reading positions…"],
  fallback: ["Reading your question…", "Planning a response…"],
};

/** Time a card spends in each state before the next one appears (ms range). */
const STATE_DWELL: Partial<Record<CardState, [number, number]>> = {
  drafting: [800, 1200],
  planned: [900, 1400],
  simulated: [1200, 1800],
  policy_checked: [800, 1200],
  // executing → submitted → validated spans ~2–3 s, like a ledger close.
  executing: [900, 1300],
  submitted: [1100, 1700],
};

/** Simulated owner-signing steps in the demo approval dialog (cumulative ≈ 2.5 s). */
export const DEMO_SIGNING_MS = { signing: 1_200, submitting: 1_300 } as const;
export const DEMO_REDUCED_MOTION_MAX_MS = 300;

const THINK_MS: [number, number] = [1_200, 2_200];
const STREAM_CPS: [number, number] = [35, 55];
/** Long replies stream faster so a turn never stalls on text alone. */
const MAX_STREAM_MS = 3_200;

const between = (rng: DemoRng, [min, max]: [number, number]) => Math.round(min + (max - min) * rng());

/** Splits text into word-sized chunks (1–3 words) for natural streaming. */
function wordChunks(text: string, rng: DemoRng): string[] {
  const words = text.match(/\S+\s*/g) ?? [text];
  const chunks: string[] = [];
  for (let index = 0; index < words.length;) {
    const size = 1 + Math.floor(rng() * 3);
    chunks.push(words.slice(index, index + size).join(""));
    index += size;
  }
  return chunks;
}

/**
 * Builds the paced timeline for a plan. Each step's `delay` is the wait
 * before that step is applied. Pure: pass a seeded rng in tests.
 */
export function buildDemoTimeline(
  plan: DemoPlan,
  { rng = Math.random, reducedMotion = false }: { rng?: DemoRng; reducedMotion?: boolean } = {},
): DemoStep[] {
  const cap = (milliseconds: number) => (reducedMotion ? Math.min(milliseconds, DEMO_REDUCED_MOTION_MAX_MS) : milliseconds);
  const steps: DemoStep[] = [];
  const statuses = DEMO_THINKING[plan.scenario];

  // 1. Thinking, with a rotating status line.
  const thinkTotal = between(rng, THINK_MS);
  if (reducedMotion) {
    steps.push({ kind: "thinking", delay: 0, status: statuses[0] });
  } else {
    const slice = Math.round(thinkTotal / statuses.length);
    statuses.forEach((status, index) => steps.push({ kind: "thinking", delay: index === 0 ? 0 : slice, status }));
  }
  const thinkTail = reducedMotion ? cap(thinkTotal) : thinkTotal - Math.round(thinkTotal / statuses.length) * (statuses.length - 1);

  // 2. Reply text, streamed word by word (all at once under reduced motion).
  if (reducedMotion) {
    steps.push({ kind: "text", delay: thinkTail, text: plan.reply });
  } else {
    let cps = between(rng, STREAM_CPS);
    if ((plan.reply.length / cps) * 1_000 > MAX_STREAM_MS) cps = plan.reply.length / (MAX_STREAM_MS / 1_000);
    let shown = "";
    wordChunks(plan.reply, rng).forEach((chunk, index) => {
      const jitter = 0.85 + rng() * 0.3;
      const delay = index === 0 ? thinkTail : Math.round(((chunk.length / cps) * 1_000) * jitter);
      shown += chunk;
      steps.push({ kind: "text", delay, text: shown });
    });
  }

  // 3. Structured blocks (tables, stats, links).
  if (plan.blocks?.length) steps.push({ kind: "blocks", delay: cap(between(rng, [800, 1_200])) });

  // 4. Card states, each held as long as the real pipeline would take.
  plan.events.forEach((event, index) => {
    const previous = plan.events[index - 1]?.state;
    const dwell = index === 0 ? [500, 800] as [number, number] : STATE_DWELL[previous!] ?? [800, 1200];
    steps.push({ kind: "event", delay: cap(between(rng, dwell)), index });
  });

  // 5. Closing line, then done.
  if (plan.followUp) steps.push({ kind: "followUp", delay: cap(between(rng, plan.events.length ? [600, 900] : [500, 800])) });
  steps.push({ kind: "done", delay: 0 });
  return steps;
}

/** Total scripted duration of a timeline, in ms. */
export function demoTimelineDuration(steps: DemoStep[]): number {
  return steps.reduce((total, step) => total + step.delay, 0);
}

/**
 * Plays a timeline. `sleep` and `isAlive` are injected so the caller can
 * cancel (Stop, a new prompt, unmount) between any two steps.
 * Resolves `true` when every step ran, `false` when cancelled.
 */
export async function playDemoTimeline(
  steps: DemoStep[],
  { sleep, isAlive, onStep }: { sleep: (milliseconds: number) => Promise<void>; isAlive: () => boolean; onStep: (step: DemoStep) => void },
): Promise<boolean> {
  for (const step of steps) {
    if (step.delay > 0) await sleep(step.delay);
    if (!isAlive()) return false;
    onStep(step);
  }
  return true;
}

/** Deterministic, obviously simulated transaction hash ("SIM" + hex). */
export function simulatedHash(seed: number): string {
  let state = (seed * 2_654_435_761) >>> 0;
  let hex = "";
  while (hex.length < 61) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    hex += state.toString(16).toUpperCase().padStart(8, "0");
  }
  return `SIM${hex.slice(0, 61)}`;
}

/** Card updates after the visitor completes the simulated owner signature. */
export function simulatedOwnerSignature(event: CardEvent, seed: number): { submitted: CardEvent; validated: CardEvent } {
  const hash = simulatedHash(seed);
  const base = { ...event, exec: undefined, hash };
  return {
    submitted: { ...base, state: "submitted", at: new Date().toISOString() },
    validated: { ...base, state: "validated", at: new Date().toISOString() },
  };
}
