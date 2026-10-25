import { describe, expect, it } from "vitest";

import {
  bindValidatedQuote,
  CopilotContextError,
  decodeCopilotActionContext,
  encodeCopilotActionContext,
  evaluateCopilotActionAvailability,
  serializeCopilotActionPrompt,
  type CopilotActionContext,
} from "./action-context";

const NOW = Date.parse("2026-10-24T12:00:20.000Z");
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

function context(overrides: Partial<CopilotActionContext> = {}): CopilotActionContext {
  return {
    version: 1,
    action: "swap",
    network: "testnet",
    base: { currency: "XRP" },
    quote: { currency: "RLUSD", issuer: ISSUER },
    amount: "100",
    route: "amm",
    quoteEvidence: {
      status: "live",
      source: "xrpl-public-node",
      observedAt: "2026-10-24T12:00:10.000Z",
      ledgerIndex: 9_345_210,
      inputAmount: "100",
      outputAmount: "51.25",
      networkFeeDrops: "12",
      tradingFeeBps: 30,
      slippageBps: 18,
      priceImpactBps: 12,
      liquidity: { available: true, inputCapacity: "900", detail: "Validated AMM reserves" },
    },
    ...overrides,
  };
}

describe("copilot action context wire format", () => {
  it("round-trips deterministically and preserves the issued-asset identity", () => {
    const first = encodeCopilotActionContext(context());
    const second = encodeCopilotActionContext(context());
    expect(first).toBe(second);
    const decoded = decodeCopilotActionContext(first, { now: NOW });
    expect(decoded).toEqual(context());
    expect(decoded.quote).toEqual({ currency: "RLUSD", issuer: ISSUER });
  });

  it("rejects unknown fields, query parameters, and authority-shaped fields", () => {
    expect(() => encodeCopilotActionContext({ ...context(), approval_id: "never-authority" })).toThrow(/unrecognized/i);
    expect(() => encodeCopilotActionContext({ ...context(), mandate: { execute: true } })).toThrow(/unrecognized/i);
    const encoded = encodeCopilotActionContext(context());
    expect(() => decodeCopilotActionContext(`${encoded}&permission=submit`)).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_QUERY_PARAMETER" }),
    );
  });

  it("rejects oversized, malformed, invalid, stale, and future quote contexts with specific codes", () => {
    expect(() => decodeCopilotActionContext(`pilot_context=${encodeURIComponent(`${JSON.stringify(context())}${" ".repeat(5_000)}`)}`)).toThrowError(
      expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }),
    );
    expect(() => encodeCopilotActionContext({ ...context(), quoteEvidence: { ...context().quoteEvidence, liquidity: { available: false, detail: "x".repeat(5_000) } } })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONTEXT" }),
    );
    expect(() => decodeCopilotActionContext("pilot_context=%7Bbad")).toThrowError(
      expect.objectContaining({ code: "MALFORMED_CONTEXT" }),
    );
    const stale = encodeCopilotActionContext(context({ quoteEvidence: { ...context().quoteEvidence, observedAt: "2026-10-24T11:59:00.000Z" } }));
    expect(() => decodeCopilotActionContext(stale, { now: NOW, maxQuoteAgeMs: 30_000 })).toThrowError(
      expect.objectContaining({ code: "QUOTE_STALE" }),
    );
    const future = encodeCopilotActionContext(context({ quoteEvidence: { ...context().quoteEvidence, observedAt: "2026-10-24T12:01:00.000Z" } }));
    expect(() => decodeCopilotActionContext(future, { now: NOW })).toThrowError(
      expect.objectContaining({ code: "QUOTE_FROM_FUTURE" }),
    );
  });
});

describe("action availability", () => {
  it("allows a fresh supported swap without carrying approval authority", () => {
    const value = context();
    expect(evaluateCopilotActionAvailability(value, {
      runtimeNetwork: "testnet",
      now: NOW,
      validatedQuoteBinding: bindValidatedQuote(value),
    })).toEqual({
      mode: "executable",
      builder: "tx.swap",
      reasons: [],
    });
  });

  it("keeps limit and LP actions prepare-only until exact UI approval binding exists", () => {
    const limit = context({ action: "limit", route: "order-book" });
    const liquidity = context({ action: "liquidity", route: "amm" });
    expect(evaluateCopilotActionAvailability(limit, {
      runtimeNetwork: "testnet",
      now: NOW,
      validatedQuoteBinding: bindValidatedQuote(limit),
    })).toMatchObject({
      mode: "prepare-only",
      builder: "tx.offer",
      reasons: [{ code: "OWNER_APPROVAL_UNAVAILABLE" }],
    });
    expect(evaluateCopilotActionAvailability(liquidity, {
      runtimeNetwork: "testnet",
      now: NOW,
      validatedQuoteBinding: bindValidatedQuote(liquidity),
    })).toMatchObject({
      mode: "prepare-only",
      builder: "tx.ammDeposit/tx.ammWithdraw",
      reasons: [{ code: "OWNER_APPROVAL_UNAVAILABLE" }],
    });
  });

  it("blocks transaction preparation until runtime evidence is freshly bound", () => {
    const value = context();
    expect(evaluateCopilotActionAvailability(value, {
      runtimeNetwork: "testnet",
      now: NOW,
    })).toMatchObject({
      mode: "blocked",
      reasons: [{ code: "QUOTE_NOT_REVALIDATED" }],
    });

    const changed = context({
      quoteEvidence: { ...value.quoteEvidence, outputAmount: "50.90" },
    });
    expect(evaluateCopilotActionAvailability(value, {
      runtimeNetwork: "testnet",
      now: NOW,
      validatedQuoteBinding: bindValidatedQuote(changed),
    }).reasons).toContainEqual(expect.objectContaining({ code: "QUOTE_CHANGED" }));
  });

  it("makes demo and mainnet inputs research-only", () => {
    const demo = context({
      quoteEvidence: {
        ...context().quoteEvidence,
        status: "demo",
        source: "deterministic-fixture",
      },
    });
    expect(evaluateCopilotActionAvailability(demo, { runtimeNetwork: "testnet", now: NOW })).toMatchObject({
      mode: "research-only",
      reasons: [{ code: "DEMO_DATA_RESEARCH_ONLY" }],
    });
    expect(evaluateCopilotActionAvailability(context({ network: "mainnet" }), { runtimeNetwork: "mainnet", now: NOW })).toMatchObject({
      mode: "research-only",
      reasons: [{ code: "MAINNET_EXECUTION_DISABLED" }],
    });
  });

  it("blocks missing, stale, unavailable, changed, wrong-network, and unsupported data", () => {
    const missingLedger = context({ quoteEvidence: { ...context().quoteEvidence, ledgerIndex: undefined } });
    expect(evaluateCopilotActionAvailability(missingLedger, { runtimeNetwork: "testnet", now: NOW }).reasons).toContainEqual(
      expect.objectContaining({ code: "QUOTE_MISSING_LEDGER" }),
    );
    const stale = context({ quoteEvidence: { ...context().quoteEvidence, observedAt: "2026-10-24T11:00:00.000Z" } });
    expect(evaluateCopilotActionAvailability(stale, { runtimeNetwork: "testnet", now: NOW }).reasons).toContainEqual(
      expect.objectContaining({ code: "QUOTE_STALE" }),
    );
    const unavailable = context({ quoteEvidence: { ...context().quoteEvidence, liquidity: { available: false, detail: "No depth for this size" } } });
    expect(evaluateCopilotActionAvailability(unavailable, { runtimeNetwork: "testnet", now: NOW }).reasons).toContainEqual(
      expect.objectContaining({ code: "ROUTE_UNAVAILABLE", detail: "No depth for this size" }),
    );
    const changedContext = context({ quoteEvidence: { ...context().quoteEvidence, outputAmount: "50.90" } });
    expect(evaluateCopilotActionAvailability(context(), {
      runtimeNetwork: "testnet",
      now: NOW,
      validatedQuoteBinding: bindValidatedQuote(changedContext),
    }).reasons).toContainEqual(
      expect.objectContaining({ code: "QUOTE_CHANGED" }),
    );
    expect(evaluateCopilotActionAvailability(context(), { runtimeNetwork: "devnet", now: NOW }).reasons).toContainEqual(
      expect.objectContaining({ code: "RUNTIME_NETWORK_MISMATCH" }),
    );
    expect(evaluateCopilotActionAvailability(context(), { runtimeNetwork: "testnet", now: NOW, builderSupport: { swap: false } }).reasons).toContainEqual(
      expect.objectContaining({ code: "BUILDER_UNSUPPORTED" }),
    );
  });
});

describe("human prompt serialization", () => {
  it("labels fixture evidence and includes bounded quote assumptions", () => {
    const prompt = serializeCopilotActionPrompt(context({
      action: "research",
      quoteEvidence: { ...context().quoteEvidence, status: "demo", source: "deterministic-fixture" },
    }));
    expect(prompt).toContain("DEMO FIXTURE — research only");
    expect(prompt).toContain(ISSUER);
    expect(prompt).toContain("slippage 18 bps");
    expect(prompt).toContain("untrusted research input only");
    expect(prompt).not.toMatch(/permission|mandate|approval_id/i);
  });
});
