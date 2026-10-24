import { describe, expect, it } from "vitest";
import type { StrategyPlanObservation, StrategyValidateArgs } from "@pilot/contracts";

import { createHarborRestClient } from "../src/index.js";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;
const proposal: StrategyValidateArgs = {
  semantics_version: "harbor.declarative-strategy/1",
  kind: "declarative_strategy_v1",
  network: "testnet",
  account: ACCOUNT,
  issued_asset: RLUSD,
  plan: {
    plan_version: "1",
    trigger: { kind: "interval", interval_seconds: 3_600 },
    rules: [{
      rule_id: "hourly-dca",
      all: [{ kind: "always" }],
      action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
    }],
    fallback: { kind: "hold" },
  },
  limits: {
    max_order_value: "5", max_daily_value: "10", max_cumulative_value: "50",
    min_order_value: "1", max_fee_drops: "20", max_daily_fee_drops: "100",
    max_cumulative_fee_drops: "500", max_daily_trades: 2, max_total_trades: 10,
    cumulative_scope: "owner_network_asset_lifetime",
    max_slippage_bps: 100, max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000000",
    max_xrp_exposure_drops: "100000000", max_issued_exposure: "100",
    min_liquidity_value: "25", cooldown_seconds: 300,
    max_quote_age_seconds: 30, max_ledger_gap: 2,
  },
  execution_mode: "offer_create_fok",
  not_before: "2026-10-22T00:00:00.000Z",
  expires_at: "2026-10-29T00:00:00.000Z",
};

const observation: StrategyPlanObservation = {
  account: ACCOUNT,
  network: "testnet",
  issued_asset: RLUSD,
  xrp_balance_drops: "50000000",
  issued_balance: "50",
  bid: "0.5",
  ask: "0.51",
  executable_liquidity_value: "500",
  fee_drops: "12",
  reserve_base_drops: "10000000",
  reserve_increment_drops: "2000000",
  owner_count: 1,
  daily_value_used: "0",
  cumulative_value_used: "0",
  daily_fee_drops_used: "0",
  cumulative_fee_drops_used: "0",
  daily_trades_used: 0,
  total_trades_used: 0,
  ledger_index: 100,
  quote_ledger_index: 100,
  observed_at: "2026-10-22T00:00:00.000Z",
  global_kill: false,
  unresolved_execution: false,
  grant_active: true,
  policy_active: true,
};

describe("declarative strategy offline mock lifecycle", () => {
  it("validates, previews, owner-approves, then executes one separately bounded mock swap", async () => {
    const client = createHarborRestClient({ mock: true });
    const validation = await client.op("strategy.validate", proposal);
    expect(validation).toMatchObject({
      ok: true,
      data: {
        valid: true,
        semantics_version: "harbor.declarative-strategy/1",
        errors: [],
        plan_digest: expect.stringMatching(/^[A-F0-9]{64}$/),
      },
    });
    if (!validation.ok || !validation.data.plan_digest) throw new Error("validation fixture failed");

    const preview = await client.op("strategy.simulate", {
      proposal,
      observation,
      at: observation.observed_at,
    });
    expect(preview).toMatchObject({
      ok: true,
      data: {
        boundary: "paper_only",
        ledger_acceptance: "not_tested",
        plan_digest: validation.data.plan_digest,
        outcome: "order",
        action: "buy_xrp",
        price_basis: "ask",
        price_value: "0.51",
        proposed_value: "5",
      },
    });

    const created = await client.op("strategy.create", {
      ...proposal,
      request_id: "request-create-declarative-001",
    });
    expect(created).toMatchObject({
      ok: true,
      data: {
        lifecycle: "draft",
        mandate: { kind: "declarative_strategy_v1", digest: validation.data.plan_digest },
      },
    });
    if (!created.ok) throw new Error("create fixture failed");

    const active = await client.op("strategy.authorize", {
      strategy_id: created.data.strategy_id,
      owner: ACCOUNT,
      network: "testnet",
      mandate_version: created.data.mandate.version,
      mandate_digest: created.data.mandate.digest,
      authorization: {
        authorization_id: "authorization-declarative-001",
        method: "wallet_action_proof_v1",
        owner: ACCOUNT,
        mandate_digest: created.data.mandate.digest,
        mandate_version: created.data.mandate.version,
        approved_at: "2026-10-22T00:01:00.000Z",
        expires_at: proposal.expires_at,
      },
      request_id: "request-authorize-declarative-001",
    });
    expect(active).toMatchObject({
      ok: true,
      data: { lifecycle: "active", mandate: { status: "approved" } },
    });

    // The offline fixture executes the already-supported trade primitive. It
    // is not a scheduler, signature, submission, or ledger-acceptance claim.
    const build = await client.op("tx.swap", {
      account: ACCOUNT,
      network: "testnet",
      sell: RLUSD,
      buy: { currency: "XRP" },
      amount: { ...RLUSD, value: "5" },
      side: "sell",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
      intent_id: "decision:mock-hourly-dca-001",
    });
    if (!build.ok) throw new Error("build fixture failed");
    const execution = await client.op("tx.execute", {
      build_id: build.data.build_id,
      idempotency_key: "decision:mock-hourly-dca-001",
    });
    expect(execution).toMatchObject({ ok: true, data: { status: "executed", signed_by: "delegate" } });
  });

  it("rejects unreachable ordered rules without producing a digest or preview", async () => {
    const client = createHarborRestClient({ mock: true });
    const invalid: StrategyValidateArgs = {
      ...proposal,
      plan: {
        ...proposal.plan,
        rules: [
          proposal.plan.rules[0],
          {
            rule_id: "unreachable",
            all: [{ kind: "price_threshold", side: "ask", comparator: "lte", price: "1" }],
            action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
          },
        ],
      },
    };
    const validation = await client.op("strategy.validate", invalid);
    expect(validation).toMatchObject({
      ok: true,
      data: { valid: false, errors: [{ code: "unreachable_rule" }] },
    });
    if (!validation.ok) throw new Error("validation fixture failed");
    expect(validation.data).not.toHaveProperty("plan_digest");

    const preview = await client.op("strategy.simulate", {
      proposal: invalid,
      observation,
      at: observation.observed_at,
    });
    expect(preview).toMatchObject({ ok: false, error: { code: "INVALID_STRATEGY_PLAN" } });
  });

  it("fails closed for cross-account observations, kill state, and exhausted lifetime budgets", async () => {
    const client = createHarborRestClient({ mock: true });
    const mismatched = await client.op("strategy.simulate", {
      proposal,
      observation: { ...observation, account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" },
      at: observation.observed_at,
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: { code: "STRATEGY_SCOPE_MISMATCH" },
    });

    const killed = await client.op("strategy.simulate", {
      proposal,
      observation: { ...observation, global_kill: true, unresolved_execution: true },
      at: observation.observed_at,
    });
    expect(killed).toMatchObject({
      ok: true,
      data: {
        outcome: "hold",
        action: "hold",
        hold_codes: ["global_kill", "pending_reconciliation"],
      },
    });

    const exhausted = await client.op("strategy.simulate", {
      proposal,
      observation: {
        ...observation,
        cumulative_value_used: proposal.limits.max_cumulative_value,
        total_trades_used: proposal.limits.max_total_trades,
      },
      at: observation.observed_at,
    });
    expect(exhausted).toMatchObject({
      ok: true,
      data: {
        outcome: "hold",
        hold_codes: ["cumulative_limit", "trade_count_limit"],
      },
    });
  });

  it("rejects model-injected code, URLs, and authorization fields as invalid arguments", async () => {
    const client = createHarborRestClient({ mock: true });
    const untypedOp = client.op.bind(client) as unknown as
      (name: string, args: Record<string, unknown>) => Promise<unknown>;
    const hostile = {
      ...proposal,
      authorization: { approved: true },
      plan: {
        ...proposal.plan,
        rules: [{
          ...proposal.plan.rules[0],
          action: {
            ...proposal.plan.rules[0]!.action,
            code: "return signAndSubmit()",
            url: "https://attacker.invalid/strategy.js",
          },
        }],
      },
    };
    await expect(untypedOp("strategy.validate", hostile)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });
});
