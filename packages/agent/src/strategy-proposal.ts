import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  StrategyPlanPreviewSchema,
  StrategyPlanValidationResultSchema,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  type StrategyPlanValidationResult,
} from "@pilot/contracts";
import { jsonSchema, tool, type Tool } from "ai";

import type { AgentHarborRest } from "./tools";

const TEST_RLUSD = {
  currency: TESTNET_RLUSD_CURRENCY,
  issuer: TESTNET_RLUSD_ISSUER,
} as const;

const STRATEGY_SEMANTICS = DECLARATIVE_STRATEGY_SEMANTICS_VERSION;

type StrategyProposalInput = {
  plan: Record<string, unknown>;
  limits: Record<string, unknown>;
  not_before: string;
  expires_at: string;
};

export type StrategyProposalToolOptions = {
  account: string;
  harbor: AgentHarborRest;
  /**
   * An observation supplied by trusted server code. The model never supplies
   * market data. When absent, the tool stops after validation instead of
   * fabricating a preview.
   */
  paperObservation?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  now?: () => Date;
};

const StrategyProposalJsonSchema = jsonSchema<StrategyProposalInput>({
  type: "object",
  description:
    "A bounded Testnet XRP/test-RLUSD strategy proposal. Account, network, asset, execution semantics, and approval authority are server-bound.",
  properties: {
    plan: {
      type: "object",
      properties: {
        plan_version: { const: "1" },
        trigger: {
          type: "object",
          properties: {
            kind: { const: "interval" },
            interval_seconds: { type: "integer", minimum: 300, maximum: 86400 },
          },
          required: ["kind", "interval_seconds"],
          additionalProperties: false,
        },
        rules: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            description:
              "One ordered first-match rule with at most eight flat AND conditions and exactly one allowlisted action.",
            properties: {
              rule_id: { type: "string", minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
              all: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: {
                  oneOf: [
                    {
                      type: "object",
                      properties: { kind: { const: "always" } },
                      required: ["kind"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        kind: { const: "price_threshold" },
                        side: { enum: ["bid", "ask"] },
                        comparator: { enum: ["lte", "gte"] },
                        price: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,15})?$" },
                      },
                      required: ["kind", "side", "comparator", "price"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        kind: { const: "xrp_allocation_outside" },
                        lower_xrp_bps: { type: "integer", minimum: 0, maximum: 9998 },
                        upper_xrp_bps: { type: "integer", minimum: 2, maximum: 10000 },
                      },
                      required: ["kind", "lower_xrp_bps", "upper_xrp_bps"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              action: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      kind: { const: "fixed_swap" },
                      direction: { enum: ["buy_xrp", "sell_xrp"] },
                      order_value: { type: "string" },
                    },
                    required: ["kind", "direction", "order_value"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "target_allocation" },
                      target_xrp_bps: { type: "integer", minimum: 1, maximum: 9999 },
                      lower_xrp_bps: { type: "integer", minimum: 0, maximum: 9998 },
                      upper_xrp_bps: { type: "integer", minimum: 2, maximum: 10000 },
                    },
                    required: ["kind", "target_xrp_bps", "lower_xrp_bps", "upper_xrp_bps"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ["rule_id", "all", "action"],
            additionalProperties: false,
          },
        },
        fallback: {
          type: "object",
          properties: { kind: { const: "hold" } },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["plan_version", "trigger", "rules", "fallback"],
      additionalProperties: false,
    },
    limits: {
      type: "object",
      description:
        "Exact approval-bound per-order, daily, cumulative, fee, exposure, trade-count, immutable-mandate action-count, cooldown, slippage, reserve, liquidity, and freshness limits. The mandate action count is distinct from owner/network/asset lifetime total trades.",
      properties: {
        max_order_value: { type: "string" },
        max_daily_value: { type: "string" },
        max_cumulative_value: { type: "string" },
        min_order_value: { type: "string" },
        max_fee_drops: { type: "string" },
        max_daily_fee_drops: { type: "string" },
        max_cumulative_fee_drops: { type: "string" },
        max_daily_trades: { type: "integer", minimum: 1, maximum: 1000 },
        max_total_trades: { type: "integer", minimum: 1, maximum: 100000 },
        max_mandate_occurrences: { type: "integer", minimum: 1, maximum: 100000 },
        cumulative_scope: { const: "owner_network_asset_lifetime" },
        max_slippage_bps: { type: "integer", minimum: 1, maximum: 1000 },
        max_price_impact_bps: { type: "integer", minimum: 1, maximum: 1000 },
        min_xrp_reserve_drops: { type: "string" },
        fee_buffer_drops: { type: "string" },
        max_xrp_exposure_drops: { type: "string" },
        max_issued_exposure: { type: "string" },
        min_liquidity_value: { type: "string" },
        cooldown_seconds: { type: "integer", minimum: 60, maximum: 86400 },
        max_quote_age_seconds: { type: "integer", minimum: 1, maximum: 300 },
        max_ledger_gap: { type: "integer", minimum: 0, maximum: 4 },
      },
      required: [
        "max_order_value", "max_daily_value", "max_cumulative_value", "min_order_value",
        "max_fee_drops", "max_daily_fee_drops", "max_cumulative_fee_drops", "max_daily_trades",
        "max_total_trades", "max_mandate_occurrences", "cumulative_scope", "max_slippage_bps", "max_price_impact_bps",
        "min_xrp_reserve_drops", "fee_buffer_drops", "max_xrp_exposure_drops",
        "max_issued_exposure", "min_liquidity_value", "cooldown_seconds",
        "max_quote_age_seconds", "max_ledger_gap",
      ],
      additionalProperties: false,
    },
    not_before: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
  },
  required: ["plan", "limits", "not_before", "expires_at"],
  additionalProperties: false,
});

function projectValidation(value: unknown): StrategyPlanValidationResult {
  return StrategyPlanValidationResultSchema.parse(value);
}
function assertPaperPreview(value: unknown, planDigest: string): Record<string, unknown> {
  const preview = StrategyPlanPreviewSchema.parse(value);
  if (preview.plan_digest !== planDigest) {
    throw new Error("Harbor returned a paper preview without explicit provenance boundaries.");
  }
  return structuredClone(preview) as Record<string, unknown>;
}

function unwrap(envelope: Awaited<ReturnType<AgentHarborRest["op"]>>): unknown {
  if (!envelope.ok) {
    const code = envelope.error.code ? ` (${envelope.error.code})` : "";
    throw new Error(`${envelope.error.service}${code}: ${envelope.error.message}`);
  }
  return envelope.data;
}

export async function validateStrategyProposal(
  input: StrategyProposalInput,
  options: StrategyProposalToolOptions,
): Promise<Record<string, unknown>> {
  const proposal = {
    kind: "declarative_strategy_v1",
    semantics_version: STRATEGY_SEMANTICS,
    network: "testnet",
    account: options.account,
    issued_asset: TEST_RLUSD,
    plan: input.plan,
    limits: input.limits,
    execution_mode: "offer_create_fok",
    not_before: input.not_before,
    expires_at: input.expires_at,
  };
  const validation = projectValidation(unwrap(await options.harbor.op("strategy.validate", proposal)));
  if (!validation.valid || !validation.plan_digest) {
    return { state: "rejected", validation };
  }
  if (!options.paperObservation) {
    return {
      state: "validated",
      validation,
      preview: {
        boundary: "paper_only",
        outcome: "not_run",
        explanation: "No trusted observation was supplied; Pilot did not fabricate market data.",
        ledger_acceptance: "not_tested",
      },
    };
  }
  const observation = await options.paperObservation();
  const at = (options.now?.() ?? new Date()).toISOString();
  const preview = assertPaperPreview(unwrap(await options.harbor.op("strategy.simulate", {
    proposal: validation.normalized_proposal ?? proposal,
    observation,
    at,
  })), validation.plan_digest);
  return { state: "validated", validation, preview };
}

/** Non-authorizing model tool. Owner approval and execution are deliberately absent. */
export function createStrategyProposalTool(options: StrategyProposalToolOptions): Tool<any, any> {
  return tool({
    description:
      "Validate one bounded declarative Testnet XRP/test-RLUSD strategy proposal and, only when the server supplies trusted observations, request a deterministic paper-only preview. This tool cannot create, approve, sign, activate, or execute a strategy.",
    inputSchema: StrategyProposalJsonSchema,
    execute: (input) => validateStrategyProposal(input, options),
  });
}
