import { describe, expect, it, vi } from "vitest";

import { createStrategyProposalTool, validateStrategyProposal } from "../src/strategy-proposal.js";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const DIGEST = "A".repeat(64);
const capabilities = {
  network: "testnet",
  assets: [{ currency: "XRP" }, {
    currency: "524C555344000000000000000000000000000000",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  }],
  trigger_kinds: ["interval"],
  condition_kinds: ["always", "price_threshold", "xrp_allocation_outside"],
  action_kinds: ["fixed_swap", "target_allocation"],
  execution_mode: "offer_create_fok",
  max_rules: 8,
  max_conditions_per_rule: 8,
  max_actions_per_evaluation: 1,
};
const proposal = {
  plan: {
    plan_version: "1",
    trigger: { kind: "interval", interval_seconds: 3_600 },
    rules: [{
      rule_id: "dca",
      all: [{ kind: "always" }],
      action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
    }],
    fallback: { kind: "hold" },
  },
  limits: {
    max_order_value: "5",
    max_daily_value: "10",
    max_cumulative_value: "50",
    min_order_value: "1",
    max_fee_drops: "20",
    max_daily_fee_drops: "100",
    max_cumulative_fee_drops: "500",
    max_daily_trades: 2,
    max_total_trades: 10,
    max_mandate_occurrences: 6,
    cumulative_scope: "owner_network_asset_lifetime",
    max_slippage_bps: 100,
    max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000",
    fee_buffer_drops: "1000000",
    max_xrp_exposure_drops: "100000000",
    max_issued_exposure: "100",
    min_liquidity_value: "25",
    cooldown_seconds: 300,
    max_quote_age_seconds: 30,
    max_ledger_gap: 2,
  },
  not_before: "2026-10-23T00:00:00.000Z",
  expires_at: "2026-10-30T00:00:00.000Z",
};

const ok = (data: unknown) => ({
  ok: true as const,
  data,
  asOf: "2026-10-23T00:00:00.000Z",
  asOfBasis: "offline fixture",
});
describe("declarative strategy proposal tool", () => {
  it("server-binds authority, validates, and declines to fabricate observations", async () => {
    const op = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("strategy.validate");
      expect(args).toMatchObject({
        kind: "declarative_strategy_v1",
        semantics_version: "harbor.declarative-strategy/1",
        account: ACCOUNT,
        network: "testnet",
        issued_asset: {
          currency: "524C555344000000000000000000000000000000",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        },
        execution_mode: "offer_create_fok",
      });
      expect(args).not.toHaveProperty("authorization");
      return ok({
        valid: true,
        semantics_version: "harbor.declarative-strategy/1",
        capabilities,
        errors: [],
        plan_digest: DIGEST,
        normalized_proposal: args,
      });
    });

    const result = await validateStrategyProposal(proposal, {
      account: ACCOUNT,
      harbor: { op: op as never },
    });

    expect(result).toMatchObject({
      state: "validated",
      validation: { valid: true, plan_digest: DIGEST },
      preview: {
        boundary: "paper_only",
        outcome: "not_run",
        ledger_acceptance: "not_tested",
        explanation: expect.stringContaining("did not fabricate"),
      },
    });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("requests a deterministic paper preview only with trusted server observations", async () => {
    const observedAt = "2026-10-23T00:00:00.000Z";
    const observation = {
      observed_at: observedAt,
      ledger_index: 100,
      quote_ledger_index: 100,
      bid: "0.5",
      ask: "0.51",
    };
    const op = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "strategy.validate") {
        return ok({
          valid: true,
          semantics_version: "harbor.declarative-strategy/1",
          capabilities,
          errors: [],
          plan_digest: DIGEST,
          normalized_proposal: args,
        });
      }
      expect(name).toBe("strategy.simulate");
      expect(args).toMatchObject({ observation, at: observedAt });
      return ok({
        boundary: "paper_only",
        ledger_acceptance: "not_tested",
        plan_digest: DIGEST,
        outcome: "order",
        semantics_version: "harbor.declarative-strategy/1",
        matched_rule_id: "dca",
        action: "buy_xrp",
        price_basis: "ask",
        price_value: "0.51",
        proposed_value: "5",
        hold_codes: [],
        explanation: "The first rule matched the explicit fixture observation.",
        evaluated_at: observedAt,
        observed_at: observedAt,
        quote_ledger_index: 100,
      });
    });
    const result = await validateStrategyProposal(proposal, {
      account: ACCOUNT,
      harbor: { op: op as never },
      paperObservation: () => observation,
      now: () => new Date(observedAt),
    });

    expect(result).toMatchObject({
      state: "validated",
      preview: {
        boundary: "paper_only",
        ledger_acceptance: "not_tested",
        outcome: "order",
        action: "buy_xrp",
      },
    });
    expect(op.mock.calls.map(([name]) => name)).toEqual(["strategy.validate", "strategy.simulate"]);
  });

  it("returns all authoritative rejection diagnostics without creating authority", async () => {
    const op = vi.fn(async () => ok({
      valid: false,
      semantics_version: "harbor.declarative-strategy/1",
      capabilities,
      errors: [
        { code: "unsupported_action", path: "plan.rules[0].action.kind", message: "Only fixed_swap and target_allocation are supported." },
        { code: "invalid_shape", path: "plan.rules[0].url", message: "URLs are not part of the declarative grammar." },
      ],
    }));

    const result = await validateStrategyProposal(proposal, {
      account: ACCOUNT,
      harbor: { op: op as never },
      paperObservation: () => { throw new Error("must not load observations"); },
    });

    expect(result).toMatchObject({
      state: "rejected",
      validation: {
        valid: false,
        errors: [
          { code: "unsupported_action" },
          { code: "invalid_shape" },
        ],
      },
    });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("exposes no approval, signing, activation, or execution arguments", () => {
    const strategyTool = createStrategyProposalTool({
      account: ACCOUNT,
      harbor: { op: vi.fn() as never },
    }) as unknown as { inputSchema: { jsonSchema: Record<string, unknown> } };
    const serialized = JSON.stringify(strategyTool.inputSchema);
    for (const forbidden of ["authorization", "signature", "tx_blob", "activate", "execute", "private_key", "url"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    expect(serialized).toContain("max_mandate_occurrences");
    expect(serialized).toContain('"max_total_trades","max_mandate_occurrences","cumulative_scope"');
  });
});
