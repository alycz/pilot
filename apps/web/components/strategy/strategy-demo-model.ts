export type DemoOutcome = "hold" | "rebalance" | "blocked";
export type DemoSide = "buy_xrp" | "sell_xrp";

export type DemoLifecyclePhase = "draft" | "review" | "running" | "paused" | "stopped";
export type DemoLifecycleAction = "review" | "edit" | "approve" | "pause" | "resume" | "stop" | "complete" | "reset";

export type DemoLifecycleEvent = {
  id: string;
  phase: DemoLifecyclePhase;
  label: string;
  detail: string;
};

export type DemoLifecycleState = {
  phase: DemoLifecyclePhase;
  events: DemoLifecycleEvent[];
};

export type DemoPolicy = {
  targetXrpPercent: number;
  driftPercent: number;
  maxOrderValue: number;
  maxDailyValue: number;
  minimumLiquidityValue: number;
  maxQuoteAgeSeconds: number;
  maxFeeDrops: number;
  maxPriceImpactBps: number;
};

export type DemoPortfolio = {
  xrp: number;
  testRlusd: number;
  dailyUsed: number;
};

export type DemoMarketEvent = {
  id: string;
  offsetMinutes: number;
  label: string;
  detail: string;
  xrpPrice: number;
  executableLiquidity: number;
  quoteAgeSeconds: number;
  feeDrops: number;
  priceImpactBps: number;
};

export type DemoDecision = {
  event: DemoMarketEvent;
  outcome: DemoOutcome;
  side?: DemoSide;
  allocationPercent: number;
  lowerBoundPercent: number;
  upperBoundPercent: number;
  requestedValue: number;
  simulatedValue: number;
  reason: string;
  checks: Array<{ label: string; passed: boolean; detail: string }>;
  portfolioBefore: DemoPortfolio;
  portfolioAfter: DemoPortfolio;
};

export type DemoState = {
  cursor: number;
  portfolio: DemoPortfolio;
  history: DemoDecision[];
};

export const DEFAULT_DEMO_POLICY: DemoPolicy = {
  targetXrpPercent: 50,
  driftPercent: 5,
  maxOrderValue: 25,
  maxDailyValue: 60,
  minimumLiquidityValue: 50,
  maxQuoteAgeSeconds: 20,
  maxFeeDrops: 20,
  maxPriceImpactBps: 100,
};

export const INITIAL_DEMO_PORTFOLIO: DemoPortfolio = {
  xrp: 100,
  testRlusd: 50,
  dailyUsed: 0,
};

const lifecycleEvent = (
  id: string,
  phase: DemoLifecyclePhase,
  label: string,
  detail: string,
): DemoLifecycleEvent => ({ id, phase, label, detail });

export function createDemoLifecycleState(): DemoLifecycleState {
  return {
    phase: "draft",
    events: [lifecycleEvent(
      "draft-1",
      "draft",
      "Sample draft ready",
      "Editable fixture limits only. Nothing has been approved or started.",
    )],
  };
}

/**
 * Deterministic, local-only lifecycle for the signed-out walkthrough. Invalid
 * transitions are inert so repeated clicks cannot skip review or revive a
 * stopped sample. No value from this state is accepted by the real controller.
 */
export function transitionDemoLifecycle(
  current: DemoLifecycleState,
  action: DemoLifecycleAction,
): DemoLifecycleState {
  if (action === "reset") return createDemoLifecycleState();

  const next = (() => {
    if (action === "review" && current.phase === "draft") {
      return lifecycleEvent("review-2", "review", "Review opened", "The sample mandate and every risk limit are visible before approval.");
    }
    if (action === "edit" && current.phase === "review") {
      return lifecycleEvent("edit-3", "draft", "Returned to draft", "No approval was recorded. The sample remains editable.");
    }
    if (action === "approve" && current.phase === "review") {
      return lifecycleEvent("approve-3", "running", "Approved and started (simulated)", "A local button click started fixture playback. No wallet proof, scheduler, order, or transaction exists.");
    }
    if (action === "pause" && current.phase === "running") {
      return lifecycleEvent("pause-4", "paused", "Paused by you", "Fixture playback is paused. No background runner continues.");
    }
    if (action === "resume" && current.phase === "paused") {
      return lifecycleEvent("resume-5", "running", "Resumed by you", "Fixture playback may continue from the next deterministic event.");
    }
    if (action === "stop" && (current.phase === "running" || current.phase === "paused")) {
      return lifecycleEvent("stop-6", "stopped", "Stopped by you", "The sample is terminal until reset. Nothing remains scheduled.");
    }
    if (action === "complete" && current.phase === "running") {
      return lifecycleEvent("complete-6", "stopped", "Sample events complete", "The deterministic fixture ended and stopped. Nothing remains scheduled.");
    }
    return undefined;
  })();

  return next ? { phase: next.phase, events: [...current.events, next] } : current;
}

export const DEMO_MARKET_EVENTS: DemoMarketEvent[] = [
  {
    id: "opening-balance",
    offsetMinutes: 0,
    label: "Starting point",
    detail: "100 XRP and 50 RLUSD, valued at today's price.",
    xrpPrice: 0.5,
    executableLiquidity: 250,
    quoteAgeSeconds: 4,
    feeDrops: 12,
    priceImpactBps: 18,
  },
  {
    id: "price-pop",
    offsetMinutes: 5,
    label: "XRP price rises",
    detail: "XRP moves from 0.50 to 0.80 RLUSD.",
    xrpPrice: 0.8,
    executableLiquidity: 260,
    quoteAgeSeconds: 5,
    feeDrops: 12,
    priceImpactBps: 22,
  },
  {
    id: "thin-book",
    offsetMinutes: 10,
    label: "Liquidity thins",
    detail: "XRP is still out of band, but there isn't enough liquidity to trade safely.",
    xrpPrice: 0.35,
    executableLiquidity: 28,
    quoteAgeSeconds: 6,
    feeDrops: 13,
    priceImpactBps: 36,
  },
  {
    id: "stale-quote",
    offsetMinutes: 15,
    label: "Quote becomes stale",
    detail: "Liquidity is back, but the latest quote is too old to trust.",
    xrpPrice: 0.35,
    executableLiquidity: 210,
    quoteAgeSeconds: 42,
    feeDrops: 12,
    priceImpactBps: 28,
  },
  {
    id: "fresh-recovery",
    offsetMinutes: 20,
    label: "Fresh quote recovers",
    detail: "A fresh quote arrives and every check passes.",
    xrpPrice: 0.35,
    executableLiquidity: 230,
    quoteAgeSeconds: 4,
    feeDrops: 12,
    priceImpactBps: 24,
  },
  {
    id: "fee-spike",
    offsetMinutes: 25,
    label: "Network fee spikes",
    detail: "XRP drifts again, but the network fee is above your cap.",
    xrpPrice: 0.65,
    executableLiquidity: 240,
    quoteAgeSeconds: 5,
    feeDrops: 35,
    priceImpactBps: 31,
  },
  {
    id: "normal-close",
    offsetMinutes: 30,
    label: "Conditions normalize",
    detail: "Fees settle and every check passes, so Pilot makes one more trade.",
    xrpPrice: 0.55,
    executableLiquidity: 245,
    quoteAgeSeconds: 3,
    feeDrops: 11,
    priceImpactBps: 20,
  },
];

const rounded = (value: number, places = 6) => Number(value.toFixed(places));
const money = (value: number) => value.toFixed(2);

export function allocationAt(portfolio: DemoPortfolio, xrpPrice: number): number {
  const xrpValue = portfolio.xrp * xrpPrice;
  const total = xrpValue + portfolio.testRlusd;
  return total > 0 ? (xrpValue / total) * 100 : 0;
}

export function evaluateDemoEvent(
  portfolio: DemoPortfolio,
  event: DemoMarketEvent,
  policy: DemoPolicy,
): DemoDecision {
  const lowerBoundPercent = policy.targetXrpPercent - policy.driftPercent;
  const upperBoundPercent = policy.targetXrpPercent + policy.driftPercent;
  const allocationPercent = allocationAt(portfolio, event.xrpPrice);
  const xrpValue = portfolio.xrp * event.xrpPrice;
  const totalValue = xrpValue + portfolio.testRlusd;
  const targetXrpValue = totalValue * (policy.targetXrpPercent / 100);
  const side: DemoSide = xrpValue > targetXrpValue ? "sell_xrp" : "buy_xrp";
  const requestedValue = Math.abs(xrpValue - targetXrpValue);
  const outsideBand = allocationPercent < lowerBoundPercent || allocationPercent > upperBoundPercent;
  const remainingDailyValue = Math.max(0, policy.maxDailyValue - portfolio.dailyUsed);
  const availableValue = side === "sell_xrp" ? xrpValue : portfolio.testRlusd;

  const checks = [
    {
      label: "Allocation band",
      passed: outsideBand,
      detail: `${allocationPercent.toFixed(1)}% XRP vs ${lowerBoundPercent.toFixed(0)}–${upperBoundPercent.toFixed(0)}% band`,
    },
    {
      label: "Quote freshness",
      passed: event.quoteAgeSeconds <= policy.maxQuoteAgeSeconds,
      detail: `${event.quoteAgeSeconds}s old · ${policy.maxQuoteAgeSeconds}s maximum`,
    },
    {
      label: "Executable liquidity",
      passed: event.executableLiquidity >= policy.minimumLiquidityValue,
      detail: `${money(event.executableLiquidity)} · ${money(policy.minimumLiquidityValue)} minimum RLUSD`,
    },
    {
      label: "Network fee",
      passed: event.feeDrops <= policy.maxFeeDrops,
      detail: `${event.feeDrops} drops · ${policy.maxFeeDrops} maximum`,
    },
    {
      label: "Price impact",
      passed: event.priceImpactBps <= policy.maxPriceImpactBps,
      detail: `${event.priceImpactBps} bps · ${policy.maxPriceImpactBps} maximum`,
    },
  ];

  if (!outsideBand) {
    return {
      event,
      outcome: "hold",
      allocationPercent,
      lowerBoundPercent,
      upperBoundPercent,
      requestedValue,
      simulatedValue: 0,
      reason: `HOLD — ${allocationPercent.toFixed(1)}% XRP remains inside the ${lowerBoundPercent.toFixed(0)}–${upperBoundPercent.toFixed(0)}% band.`,
      checks,
      portfolioBefore: { ...portfolio },
      portfolioAfter: { ...portfolio },
    };
  }

  const failedCheck = checks.slice(1).find((check) => !check.passed);
  if (failedCheck) {
    return {
      event,
      outcome: "blocked",
      side,
      allocationPercent,
      lowerBoundPercent,
      upperBoundPercent,
      requestedValue,
      simulatedValue: 0,
      reason: `BLOCKED — ${failedCheck.label} is outside your limits, so nothing is traded.`,
      checks,
      portfolioBefore: { ...portfolio },
      portfolioAfter: { ...portfolio },
    };
  }

  const simulatedValue = Math.min(
    requestedValue,
    policy.maxOrderValue,
    remainingDailyValue,
    availableValue,
  );
  if (simulatedValue < 1) {
    return {
      event,
      outcome: "blocked",
      side,
      allocationPercent,
      lowerBoundPercent,
      upperBoundPercent,
      requestedValue,
      simulatedValue: 0,
      reason: "BLOCKED — less than 1.00 RLUSD remains within your balance and daily limits.",
      checks: [
        ...checks,
        {
          label: "Order and daily caps",
          passed: false,
          detail: `${money(remainingDailyValue)} left today`,
        },
      ],
      portfolioBefore: { ...portfolio },
      portfolioAfter: { ...portfolio },
    };
  }

  const portfolioAfter = { ...portfolio, dailyUsed: rounded(portfolio.dailyUsed + simulatedValue) };
  if (side === "sell_xrp") {
    portfolioAfter.xrp = rounded(portfolio.xrp - simulatedValue / event.xrpPrice);
    portfolioAfter.testRlusd = rounded(portfolio.testRlusd + simulatedValue);
  } else {
    portfolioAfter.xrp = rounded(portfolio.xrp + simulatedValue / event.xrpPrice);
    portfolioAfter.testRlusd = rounded(portfolio.testRlusd - simulatedValue);
  }

  return {
    event,
    outcome: "rebalance",
    side,
    allocationPercent,
    lowerBoundPercent,
    upperBoundPercent,
    requestedValue,
    simulatedValue,
    reason: `REBALANCE — ${side === "sell_xrp" ? "sell" : "buy"} ${money(simulatedValue)} RLUSD of XRP to move back into the band, within your per-trade and daily limits.`,
    checks: [
      ...checks,
      {
        label: "Order and daily caps",
        passed: true,
        detail: `${money(simulatedValue)} now · ${money(policy.maxOrderValue)} per trade · ${money(remainingDailyValue)} left today`,
      },
    ],
    portfolioBefore: { ...portfolio },
    portfolioAfter,
  };
}

export function createDemoState(policy: DemoPolicy = DEFAULT_DEMO_POLICY): DemoState {
  const openingDecision = evaluateDemoEvent(INITIAL_DEMO_PORTFOLIO, DEMO_MARKET_EVENTS[0], policy);
  return {
    cursor: 0,
    portfolio: openingDecision.portfolioAfter,
    history: [openingDecision],
  };
}

export function stepDemoState(state: DemoState, policy: DemoPolicy): DemoState {
  const nextCursor = state.cursor + 1;
  const event = DEMO_MARKET_EVENTS[nextCursor];
  if (!event) return state;
  const decision = evaluateDemoEvent(state.portfolio, event, policy);
  return {
    cursor: nextCursor,
    portfolio: decision.portfolioAfter,
    history: [...state.history, decision],
  };
}

export function isDemoComplete(state: DemoState): boolean {
  return state.cursor >= DEMO_MARKET_EVENTS.length - 1;
}
