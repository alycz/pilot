import { describe, expect, it } from "vitest";

import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  type DeclarativeStrategyProposal,
} from "../src/contracts";
import {
  compileDeclarativeStrategyProposal,
  validateDeclarativeStrategyProposal,
} from "../src/strategy/plan/compiler";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function proposal(
  overrides: Partial<DeclarativeStrategyProposal> = {},
): DeclarativeStrategyProposal {
  return {
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    kind: "declarative_strategy_v1",
    network: "testnet",
    account,
    issued_asset: {
      currency: TESTNET_RLUSD_CURRENCY,
      issuer: TESTNET_RLUSD_ISSUER,
    },
    plan: {
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 3_600 },
      rules: [
        {
          rule_id: "dca-hourly",
          all: [{ kind: "always" }],
          action: {
            kind: "fixed_swap",
            direction: "buy_xrp",
            order_value: "5",
          },
        },
      ],
      fallback: { kind: "hold" },
    },
    limits: {
      max_order_value: "10",
      max_daily_value: "50",
      max_cumulative_value: "500",
      min_order_value: "1",
      max_fee_drops: "20",
      max_daily_fee_drops: "100",
      max_cumulative_fee_drops: "1000",
      max_daily_trades: 10,
      max_total_trades: 100,
      cumulative_scope: "owner_network_asset_lifetime",
      max_slippage_bps: 100,
      max_price_impact_bps: 100,
      min_xrp_reserve_drops: "12000000",
      fee_buffer_drops: "1000",
      max_xrp_exposure_drops: "1000000000",
      max_issued_exposure: "1000",
      min_liquidity_value: "10",
      cooldown_seconds: 300,
      max_quote_age_seconds: 20,
      max_ledger_gap: 1,
    },
    execution_mode: "offer_create_fok",
    not_before: "2026-10-22T00:00:00.000Z",
    expires_at: "2026-11-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("declarative strategy compiler", () => {
  it("compiles one bounded DCA rule and binds every authority field", async () => {
    const first = await compileDeclarativeStrategyProposal(proposal());
    const second = await compileDeclarativeStrategyProposal(
      structuredClone(proposal()),
    );
    expect(first.planDigest).toMatch(/^[A-F0-9]{64}$/);
    expect(second.planDigest).toBe(first.planDigest);

    for (const changed of [
      proposal({ account: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH" }),
      proposal({ expires_at: "2026-11-23T00:00:00.000Z" }),
      proposal({
        limits: { ...proposal().limits, max_cumulative_value: "501" },
      }),
      proposal({
        plan: {
          ...proposal().plan,
          trigger: { kind: "interval", interval_seconds: 7_200 },
        },
      }),
    ]) {
      expect((await compileDeclarativeStrategyProposal(changed)).planDigest).not.toBe(
        first.planDigest,
      );
    }
  });

  it("rejects code, URLs, unknown actions, nested conditions, and oversized plans", async () => {
    for (const [hostile, expectedCode] of [
      [{ ...proposal(), script: "return stealSecrets()" }, "invalid_shape"],
      [{
        ...proposal(),
        plan: {
          ...proposal().plan,
          rules: [
            {
              ...proposal().plan.rules[0],
              action: { kind: "http", url: "https://evil.invalid" },
            },
          ],
        },
      }, "unsupported_action"],
      [{
        ...proposal(),
        plan: {
          ...proposal().plan,
          rules: [
            {
              ...proposal().plan.rules[0],
              all: [{ kind: "all", conditions: [{ kind: "always" }] }],
            },
          ],
        },
      }, "unsupported_condition"],
      [{
        ...proposal(),
        plan: {
          ...proposal().plan,
          rules: Array.from({ length: 9 }, (_, index) => ({
            rule_id: `rule-${index}`,
            all: [{ kind: "always" }],
            action: {
              kind: "fixed_swap",
              direction: "buy_xrp",
              order_value: "5",
            },
          })),
        },
      }, "invalid_shape"],
    ] as const) {
      const result = await validateDeclarativeStrategyProposal(hostile);
      expect(result.valid).toBe(false);
      expect(result.errors.map((item) => item.code)).toContain(expectedCode);
    }
  });

  it("rejects unsupported assets, overflow, unreachable and contradictory rules", async () => {
    const unsupported = await validateDeclarativeStrategyProposal({
      ...proposal(),
      issued_asset: { ...proposal().issued_asset, issuer: account },
    });
    expect(unsupported.valid).toBe(false);

    const overflow = await validateDeclarativeStrategyProposal(
      proposal({
        limits: {
          ...proposal().limits,
          max_cumulative_value: "999999999999999999999999999999",
        },
      }),
    );
    expect(overflow.errors.map((item) => item.code)).toContain("numeric_overflow");

    const unreachable = await validateDeclarativeStrategyProposal(
      proposal({
        plan: {
          ...proposal().plan,
          rules: [
            proposal().plan.rules[0]!,
            {
              rule_id: "later",
              all: [
                {
                  kind: "price_threshold",
                  side: "ask",
                  comparator: "lte",
                  price: "1",
                },
              ],
              action: {
                kind: "fixed_swap",
                direction: "buy_xrp",
                order_value: "5",
              },
            },
          ],
        },
      }),
    );
    expect(unreachable.errors.map((item) => item.code)).toContain("unreachable_rule");

    const contradictory = await validateDeclarativeStrategyProposal(
      proposal({
        plan: {
          ...proposal().plan,
          rules: [
            {
              rule_id: "bad-range",
              all: [
                {
                  kind: "price_threshold",
                  side: "ask",
                  comparator: "gte",
                  price: "2",
                },
                {
                  kind: "price_threshold",
                  side: "ask",
                  comparator: "lte",
                  price: "1",
                },
              ],
              action: {
                kind: "fixed_swap",
                direction: "buy_xrp",
                order_value: "5",
              },
            },
          ],
        },
      }),
    );
    expect(contradictory.errors.map((item) => item.code)).toContain(
      "contradictory_conditions",
    );
  });

  it("requires price thresholds to use the eventual executable side", async () => {
    const wrongSide = await validateDeclarativeStrategyProposal(
      proposal({
        plan: {
          ...proposal().plan,
          rules: [
            {
              rule_id: "wrong-side",
              all: [
                {
                  kind: "price_threshold",
                  side: "bid",
                  comparator: "lte",
                  price: "1",
                },
              ],
              action: {
                kind: "fixed_swap",
                direction: "buy_xrp",
                order_value: "5",
              },
            },
          ],
        },
      }),
    );
    expect(wrongSide.errors.map((item) => item.code)).toContain(
      "ambiguous_conditions",
    );
  });
});
