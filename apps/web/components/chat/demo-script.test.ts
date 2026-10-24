import { CardEventSchema } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import {
  DEMO_REDUCED_MOTION_MAX_MS,
  DEMO_SUGGESTIONS,
  DEMO_THINKING,
  buildDemoTimeline,
  classifyDemoPrompt,
  demoTimelineDuration,
  playDemoTimeline,
  type DemoStep,
  parseSwap,
  routeDemoPrompt,
  simulatedHash,
  simulatedOwnerSignature,
} from "./demo-script";

describe("demo prompt router", () => {
  it("routes every suggestion to its intended scenario", () => {
    for (const suggestion of DEMO_SUGGESTIONS) {
      expect(classifyDemoPrompt(suggestion.prompt)).toBe(suggestion.scenario);
    }
  });

  it("parses typed swaps with amounts and direction", () => {
    expect(parseSwap("swap 50 rlusd for xrp")).toEqual({ amount: 50, sell: "RLUSD", buy: "XRP" });
    expect(parseSwap("Sell 1,000 XRP to RLUSD please")).toEqual({ amount: 1000, sell: "XRP", buy: "RLUSD" });
    expect(parseSwap("convert 12.5 xrp into rlusd")).toEqual({ amount: 12.5, sell: "XRP", buy: "RLUSD" });
    expect(parseSwap("swap 10 xrp for xrp")).toBeNull();
    expect(parseSwap("hello")).toBeNull();
  });

  it("falls back to a capabilities answer for unknown prompts", () => {
    const plan = routeDemoPrompt("what's the weather like?", 1);
    expect(plan.scenario).toBe("fallback");
    expect(plan.events).toHaveLength(0);
    expect(plan.reply).toMatch(/simulated/i);
  });
});

describe("demo swap scenarios follow the spending policy", () => {
  it("auto-executes small swaps through the delegate", () => {
    const plan = routeDemoPrompt("Swap 80 RLUSD for XRP, max 1% slippage", 1);
    const last = plan.events.at(-1)!;
    expect(last.state).toBe("validated");
    expect(last.hash).toMatch(/^SIM/);
    expect(plan.events.some((event) => event.state === "awaiting_approval")).toBe(false);
  });

  it("asks for owner approval between the auto-execute limit and the per-transaction cap", () => {
    const plan = routeDemoPrompt("Swap 1,000 XRP to RLUSD at the best rate", 2);
    const last = plan.events.at(-1)!;
    expect(last.state).toBe("awaiting_approval");
    expect(last.intent.kind === "swap" ? last.intent.amount : undefined).toBe("1000");
    expect(last.build?.summary.amounts[0]).toBe("1,000 XRP");
  });

  it("blocks swaps above the per-transaction cap before signing", () => {
    const plan = routeDemoPrompt("swap 5000 rlusd for xrp", 3);
    expect(plan.events.at(-1)?.state).toBe("blocked");
    expect(plan.events.some((event) => ["executing", "submitted", "validated"].includes(event.state))).toBe(false);
  });

  it("blocks FREEMONEY on the issuer allowlist", () => {
    const plan = routeDemoPrompt("Why would FREEMONEY be blocked?", 4);
    const last = plan.events.at(-1)!;
    expect(last.state).toBe("blocked");
    expect(last.policy?.reasons.some((reason) => reason.rule === "issuer_allowlist" && !reason.pass)).toBe(true);
  });

  it("always routes vault deposits to the owner", () => {
    const plan = routeDemoPrompt("Deposit 100 XRP into the vault", 5);
    const last = plan.events.at(-1)!;
    expect(last.state).toBe("awaiting_approval");
    expect(last.intent.kind).toBe("vault_deposit");
    expect(last.intent.network).toBe("devnet");
  });

  it("produces contract-valid card events with unique intent ids per turn", () => {
    const first = routeDemoPrompt("Swap 80 RLUSD for XRP", 7);
    const second = routeDemoPrompt("Swap 80 RLUSD for XRP", 8);
    expect(first.events[0].intent_id).not.toBe(second.events[0].intent_id);
    for (const suggestion of DEMO_SUGGESTIONS) {
      for (const event of routeDemoPrompt(suggestion.prompt, 9).events) {
        expect(CardEventSchema.safeParse(event).success).toBe(true);
      }
    }
  });
});

describe("simulated signatures", () => {
  it("are deterministic, clearly marked and contract-valid", () => {
    expect(simulatedHash(3)).toBe(simulatedHash(3));
    expect(simulatedHash(3)).not.toBe(simulatedHash(4));
    expect(simulatedHash(3)).toMatch(/^SIM[0-9A-F]{61}$/);
    const approval = routeDemoPrompt("Deposit 100 XRP into the vault", 10).events.at(-1)!;
    const { submitted, validated } = simulatedOwnerSignature(approval, 10);
    expect(submitted.state).toBe("submitted");
    expect(validated.state).toBe("validated");
    expect(validated.exec).toBeUndefined();
    expect(CardEventSchema.safeParse(validated).success).toBe(true);
  });
});

describe("informational scenarios", () => {
  it("returns comparison tables and links without cards", () => {
    const compare = routeDemoPrompt("Compare AMM vs order book for 1,000 XRP", 1);
    expect(compare.events).toHaveLength(0);
    expect(compare.blocks?.[0]).toMatchObject({ kind: "table", highlight: 0 });
    const limits = routeDemoPrompt("What are my spending limits?", 1);
    expect(limits.blocks?.some((block) => block.kind === "link" && block.href === "/memory")).toBe(true);
    const portfolio = routeDemoPrompt("Show my portfolio", 1);
    expect(portfolio.blocks?.some((block) => block.kind === "link" && block.href === "/portfolio")).toBe(true);
  });
});


/** Seeded LCG so pacing tests are deterministic. */
function seeded(seed = 7): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("demo pacing", () => {
  const autoSwap = routeDemoPrompt("Swap 80 RLUSD for XRP, max 1% slippage", 1);

  it("thinks first, then streams text, then advances card states in order", () => {
    const steps = buildDemoTimeline(autoSwap, { rng: seeded() });
    const kinds = steps.map((step) => step.kind);
    const firstText = kinds.indexOf("text");
    const firstEvent = kinds.indexOf("event");
    expect(kinds.slice(0, firstText).every((kind) => kind === "thinking")).toBe(true);
    expect(firstText).toBeGreaterThan(0);
    expect(firstEvent).toBeGreaterThan(firstText);
    expect(kinds.at(-1)).toBe("done");
    const eventIndexes = steps.filter((step): step is Extract<DemoStep, { kind: "event" }> => step.kind === "event").map((step) => step.index);
    expect(eventIndexes).toEqual(autoSwap.events.map((_, index) => index));
    expect(steps.filter((step) => step.kind === "thinking").map((step) => (step as { status: string }).status)).toEqual(DEMO_THINKING.swap);
  });

  it("holds each phase for a realistic time", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const steps = buildDemoTimeline(autoSwap, { rng: seeded(seed) });
      const firstText = steps.findIndex((step) => step.kind === "text");
      const thinking = steps.slice(0, firstText + 1).reduce((total, step) => total + step.delay, 0);
      expect(thinking).toBeGreaterThanOrEqual(1_200);
      expect(thinking).toBeLessThanOrEqual(2_200);
      const events = steps.filter((step) => step.kind === "event");
      const byState = Object.fromEntries(events.map((step, index) => [autoSwap.events[index].state, step.delay]));
      expect(byState.planned).toBeGreaterThanOrEqual(800); // drafting dwell
      expect(byState.planned).toBeLessThanOrEqual(1_200);
      expect(byState.simulated).toBeGreaterThanOrEqual(900); // planned dwell
      expect(byState.policy_checked).toBeGreaterThanOrEqual(1_200); // simulated dwell
      expect(byState.submitted + byState.validated).toBeGreaterThanOrEqual(2_000); // executing → validated
      expect(byState.submitted + byState.validated).toBeLessThanOrEqual(3_000);
    }
  });

  it("streams text word by word at a natural rate and ends with the full reply", () => {
    const steps = buildDemoTimeline(autoSwap, { rng: seeded(3) });
    const texts = steps.filter((step): step is Extract<DemoStep, { kind: "text" }> => step.kind === "text");
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.at(-1)!.text).toBe(autoSwap.reply);
    const streamMs = texts.slice(1).reduce((total, step) => total + step.delay, 0);
    expect(streamMs).toBeGreaterThan(1_500);
    expect(streamMs).toBeLessThanOrEqual(3_200 * 1.2);
  });

  it("keeps every phase short and shows full text at once under reduced motion", () => {
    const steps = buildDemoTimeline(autoSwap, { rng: seeded(), reducedMotion: true });
    expect(steps.every((step) => step.delay <= DEMO_REDUCED_MOTION_MAX_MS)).toBe(true);
    const texts = steps.filter((step) => step.kind === "text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toBe(autoSwap.reply);
  });

  it("plays steps in order and stops as soon as the run is cancelled", async () => {
    const steps = buildDemoTimeline(autoSwap, { rng: seeded() });
    const applied: string[] = [];
    let alive = true;
    const finished = await playDemoTimeline(steps, {
      sleep: async () => undefined,
      isAlive: () => alive,
      onStep: (step) => {
        applied.push(step.kind);
        if (step.kind === "event" && step.index === 1) alive = false; // user pressed Stop
      },
    });
    expect(finished).toBe(false);
    expect(applied.filter((kind) => kind === "event")).toHaveLength(2);
    expect(applied).not.toContain("done");

    const all: string[] = [];
    expect(await playDemoTimeline(steps, { sleep: async () => undefined, isAlive: () => true, onStep: (step) => all.push(step.kind) })).toBe(true);
    expect(all).toEqual(steps.map((step) => step.kind));
  });

  it("lands each scenario in a believable overall duration", () => {
    for (const { prompt } of DEMO_SUGGESTIONS) {
      const total = demoTimelineDuration(buildDemoTimeline(routeDemoPrompt(prompt, 1), { rng: seeded(11) }));
      expect(total).toBeGreaterThan(3_000);
      expect(total).toBeLessThan(14_000);
    }
  });
});
