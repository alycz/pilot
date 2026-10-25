import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SignedOutStrategyDemo } from "./strategy-demo";
import {
  createDemoState,
  createDemoLifecycleState,
  DEFAULT_DEMO_POLICY,
  DEMO_MARKET_EVENTS,
  evaluateDemoEvent,
  INITIAL_DEMO_PORTFOLIO,
  isDemoComplete,
  stepDemoState,
  transitionDemoLifecycle,
} from "./strategy-demo-model";

describe("signed-out strategy demo model", () => {
  it("produces the same deterministic sequence of holds, rebalances, and policy blocks", () => {
    let state = createDemoState();
    while (!isDemoComplete(state)) state = stepDemoState(state, DEFAULT_DEMO_POLICY);

    expect(state.history.map((decision) => decision.outcome)).toEqual([
      "hold",
      "rebalance",
      "blocked",
      "blocked",
      "rebalance",
      "blocked",
      "rebalance",
    ]);
    expect(state.history[1]).toMatchObject({ side: "sell_xrp", simulatedValue: 15 });
    expect(state.history[2].reason).toMatch(/Executable liquidity/);
    expect(state.history[3].reason).toMatch(/Quote freshness/);
    expect(state.history[5].reason).toMatch(/Network fee/);
    expect(state.portfolio.dailyUsed).toBeCloseTo(46.64, 1);
  });

  it("caps a simulated adjustment by the per-order and remaining daily values", () => {
    const highPrice = { ...DEMO_MARKET_EVENTS[1], xrpPrice: 2 };
    const perOrder = evaluateDemoEvent(INITIAL_DEMO_PORTFOLIO, highPrice, DEFAULT_DEMO_POLICY);
    expect(perOrder.outcome).toBe("rebalance");
    expect(perOrder.simulatedValue).toBe(DEFAULT_DEMO_POLICY.maxOrderValue);

    const dailyLimited = evaluateDemoEvent(
      { ...INITIAL_DEMO_PORTFOLIO, dailyUsed: 57 },
      highPrice,
      DEFAULT_DEMO_POLICY,
    );
    expect(dailyLimited.outcome).toBe("rebalance");
    expect(dailyLimited.simulatedValue).toBe(3);

    const dailyExhausted = evaluateDemoEvent(
      { ...INITIAL_DEMO_PORTFOLIO, dailyUsed: DEFAULT_DEMO_POLICY.maxDailyValue },
      highPrice,
      DEFAULT_DEMO_POLICY,
    );
    expect(dailyExhausted.outcome).toBe("blocked");
    expect(dailyExhausted.reason).toMatch(/less than 1.00/);
  });

  it("resets exactly and makes repeated steps at the end inert", () => {
    const resetA = createDemoState(DEFAULT_DEMO_POLICY);
    const resetB = createDemoState(DEFAULT_DEMO_POLICY);
    expect(resetA).toEqual(resetB);

    let complete = resetA;
    for (let index = 0; index < DEMO_MARKET_EVENTS.length + 4; index += 1) {
      complete = stepDemoState(complete, DEFAULT_DEMO_POLICY);
    }
    expect(complete.cursor).toBe(DEMO_MARKET_EVENTS.length - 1);
    expect(complete.history).toHaveLength(DEMO_MARKET_EVENTS.length);
    expect(stepDemoState(complete, DEFAULT_DEMO_POLICY)).toBe(complete);
  });

  it("changes the hold band without reading or mutating external state", () => {
    const narrow = { ...DEFAULT_DEMO_POLICY, targetXrpPercent: 60, driftPercent: 2 };
    const state = createDemoState(narrow);
    expect(state.history[0].outcome).toBe("rebalance");
    expect(state.history[0].side).toBe("buy_xrp");
    expect(state.history[0].lowerBoundPercent).toBe(58);
    expect(state.history[0].upperBoundPercent).toBe(62);
  });

  it("requires review before simulated approval and keeps pause, resume, stop, and reset deterministic", () => {
    const draft = createDemoLifecycleState();
    expect(transitionDemoLifecycle(draft, "approve")).toBe(draft);

    const review = transitionDemoLifecycle(draft, "review");
    const running = transitionDemoLifecycle(review, "approve");
    const paused = transitionDemoLifecycle(running, "pause");
    const resumed = transitionDemoLifecycle(paused, "resume");
    const stopped = transitionDemoLifecycle(resumed, "stop");

    expect([review.phase, running.phase, paused.phase, resumed.phase, stopped.phase]).toEqual([
      "review", "running", "paused", "running", "stopped",
    ]);
    expect(stopped.events.map((event) => event.label)).toEqual([
      "Sample draft ready",
      "Review opened",
      "Approved and started (simulated)",
      "Paused by you",
      "Resumed by you",
      "Stopped by you",
    ]);
    expect(transitionDemoLifecycle(stopped, "resume")).toBe(stopped);
    expect(transitionDemoLifecycle(stopped, "reset")).toEqual(createDemoLifecycleState());
    expect(createDemoLifecycleState()).toEqual(createDemoLifecycleState());
  });
});

describe("signed-out strategy demo surface", () => {
  it("labels the simulation and real authority boundary explicitly", () => {
    const markup = renderToStaticMarkup(createElement(SignedOutStrategyDemo));
    for (const text of [
      "Illustrative simulation · client only",
      "Set the rules once. Pilot trades inside them.",
      "Three kinds of strategy",
      "Recurring buy",
      "Price trigger",
      "Rebalance",
      "Checked before every trade",
      "User-approved sample lifecycle",
      "Review simulated mandate",
      "Maximum per simulated trade",
      "Maximum simulated daily value",
      "Simulated event timeline",
      "this simulation never grants trading authority",
      "Connect account for Testnet setup",
    ]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/guaranteed|profit|live performance/i);
  });

  it("renders native, named controls and a responsive timeline without hidden network affordances", () => {
    const markup = renderToStaticMarkup(createElement(SignedOutStrategyDemo));
    for (const control of [
      ">Review simulated mandate<",
      ">Reset demo<",
      'aria-label="Target XRP share"',
      'aria-label="Allowed drift either way"',
      'aria-label="Maximum per simulated trade"',
      'aria-label="Maximum simulated daily value"',
      'aria-valuetext="50%"',
      'aria-labelledby="event-timeline-title"',
      "Event timeline",
    ]) expect(markup).toContain(control);
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain('data-upcoming="true"');
    expect(markup).not.toMatch(/fetch\(|localStorage|sessionStorage|WebSocket/);
  });

  it("does not call fetch, wallet, signing, provider, or scheduler APIs while rendering signed out", () => {
    const fetcher = vi.fn();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetcher as typeof fetch;
    try {
      const markup = renderToStaticMarkup(createElement(SignedOutStrategyDemo));
      expect(markup).toContain("Demo only");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
