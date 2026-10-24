import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SignedOutStrategyDemo } from "./strategy-demo";
import {
  createDemoState,
  DEFAULT_DEMO_POLICY,
  DEMO_MARKET_EVENTS,
  evaluateDemoEvent,
  INITIAL_DEMO_PORTFOLIO,
  isDemoComplete,
  stepDemoState,
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
});

describe("signed-out strategy demo surface", () => {
  it("labels the simulation and real authority boundary explicitly", () => {
    const markup = renderToStaticMarkup(createElement(SignedOutStrategyDemo));
    for (const text of [
      "Illustrative simulation · client only",
      "Explore a bounded rebalancer",
      "The simulator itself uses no wallet, live prices, model, network-dependent sample data, scheduler, or trading authority",
      "Policy → simulation → approval",
      "Within band · Allocation band",
      "this simulation never grants trading authority",
      "Connect account for Testnet setup",
      "No performance or return is estimated",
    ]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/guaranteed|profit|live performance/i);
  });

  it("renders native, named controls and a responsive timeline without hidden network affordances", () => {
    const markup = renderToStaticMarkup(createElement(SignedOutStrategyDemo));
    for (const control of [
      "Play simulation",
      "Step to next event",
      "Reset simulation",
      'aria-label="Target XRP allocation"',
      'aria-label="Allowed drift on either side"',
      'aria-valuetext="50%"',
      'aria-label="Illustrative event timeline"',
    ]) expect(markup).toContain(control);
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain('data-upcoming="true"');
    expect(markup).not.toContain("opacity-55");
    expect(markup).not.toMatch(/fetch\(|localStorage|sessionStorage|WebSocket/);
  });
});
