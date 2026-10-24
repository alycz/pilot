import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  DeclarativeStrategyProposalSchema,
  StrategyPlanCapabilitiesSchema,
  StrategyPlanValidationResultSchema,
  type DeclarativeStrategyCondition,
  type DeclarativeStrategyProposal,
  type StrategyPlanDiagnostic,
  type StrategyPlanValidationResult,
} from "../../contracts";

const MAX_ATOMIC_MICROUNITS = 9_000_000_000_000_000n;
const MICRO_SCALE = 1_000_000n;
const DECIMAL_SCALE = 1_000_000_000_000_000n;

export const DECLARATIVE_STRATEGY_CAPABILITIES =
  StrategyPlanCapabilitiesSchema.parse({
    network: "testnet",
    assets: [
      { currency: "XRP" },
      {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
    ],
    trigger_kinds: ["interval"],
    condition_kinds: [
      "always",
      "price_threshold",
      "xrp_allocation_outside",
    ],
    action_kinds: ["fixed_swap", "target_allocation"],
    execution_mode: "offer_create_fok",
    max_rules: 8,
    max_conditions_per_rule: 8,
    max_actions_per_evaluation: 1,
  });

function parseDecimal(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * DECIMAL_SCALE +
    BigInt(fraction.padEnd(15, "0"));
}

function atomicMicrounitsCeil(value: string): bigint {
  const scaled = parseDecimal(value);
  const divisor = DECIMAL_SCALE / MICRO_SCALE;
  return (scaled + divisor - 1n) / divisor;
}

function compareDecimals(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function diagnostic(
  code: StrategyPlanDiagnostic["code"],
  path: string,
  message: string,
): StrategyPlanDiagnostic {
  return { code, path, message };
}

/** RFC-8785-like canonical JSON for this JSON-only, integer/string schema. */
export function canonicalStrategyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("strategy numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStrategyJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalStrategyJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("strategy value is not canonical JSON");
}

export async function strategyProposalDigest(
  proposal: DeclarativeStrategyProposal,
): Promise<string> {
  const authority = {
    digest_domain: "harbor.strategy.authority",
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    proposal,
  };
  const bytes = new TextEncoder().encode(canonicalStrategyJson(authority));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function conditionKey(condition: DeclarativeStrategyCondition): string {
  return canonicalStrategyJson(condition);
}

function staticDiagnostics(
  proposal: DeclarativeStrategyProposal,
): StrategyPlanDiagnostic[] {
  const errors: StrategyPlanDiagnostic[] = [];
  const limits = proposal.limits;
  for (const [field, value] of [
    ["max_order_value", limits.max_order_value],
    ["max_daily_value", limits.max_daily_value],
    ["max_cumulative_value", limits.max_cumulative_value],
    ["max_issued_exposure", limits.max_issued_exposure],
    ["min_liquidity_value", limits.min_liquidity_value],
  ] as const) {
    if (atomicMicrounitsCeil(value) > MAX_ATOMIC_MICROUNITS) {
      errors.push(
        diagnostic(
          "numeric_overflow",
          `limits.${field}`,
          `${field} exceeds the atomic accounting range`,
        ),
      );
    }
  }
  for (const [field, value] of [
    ["max_fee_drops", limits.max_fee_drops],
    ["max_daily_fee_drops", limits.max_daily_fee_drops],
    ["max_cumulative_fee_drops", limits.max_cumulative_fee_drops],
  ] as const) {
    if (BigInt(value) > MAX_ATOMIC_MICROUNITS) {
      errors.push(
        diagnostic(
          "numeric_overflow",
          `limits.${field}`,
          `${field} exceeds the atomic accounting range`,
        ),
      );
    }
  }

  const priorRuleConditions = new Map<string, number>();
  let terminalAlwaysRule: number | undefined;
  proposal.plan.rules.forEach((rule, ruleIndex) => {
    const rulePath = `plan.rules[${ruleIndex}]`;
    const conditionSetKey = [...rule.all]
      .map(conditionKey)
      .sort()
      .join("\u0000");
    const duplicateIndex = priorRuleConditions.get(conditionSetKey);
    if (duplicateIndex !== undefined) {
      errors.push(
        diagnostic(
          "unreachable_rule",
          rulePath,
          `conditions duplicate earlier rule ${proposal.plan.rules[duplicateIndex]!.rule_id}`,
        ),
      );
    } else {
      priorRuleConditions.set(conditionSetKey, ruleIndex);
    }
    if (terminalAlwaysRule !== undefined) {
      errors.push(
        diagnostic(
          "unreachable_rule",
          rulePath,
          `rule is unreachable after unconditional rule ${proposal.plan.rules[terminalAlwaysRule]!.rule_id}`,
        ),
      );
    }
    if (rule.all[0]?.kind === "always") terminalAlwaysRule = ruleIndex;

    const priceConditions = rule.all.filter(
      (condition) => condition.kind === "price_threshold",
    );
    const allocationConditions = rule.all.filter(
      (condition) => condition.kind === "xrp_allocation_outside",
    );
    if (allocationConditions.length > 1) {
      errors.push(
        diagnostic(
          "ambiguous_conditions",
          `${rulePath}.all`,
          "a rule may contain at most one allocation-band condition",
        ),
      );
    }

    for (const side of ["bid", "ask"] as const) {
      const sideConditions = priceConditions.filter(
        (condition) => condition.side === side,
      );
      for (const comparator of ["lte", "gte"] as const) {
        if (
          sideConditions.filter(
            (condition) => condition.comparator === comparator,
          ).length > 1
        ) {
          errors.push(
            diagnostic(
              "ambiguous_conditions",
              `${rulePath}.all`,
              `duplicate ${side} ${comparator} thresholds are not supported`,
            ),
          );
        }
      }
      const lower = sideConditions.find(
        (condition) => condition.comparator === "gte",
      );
      const upper = sideConditions.find(
        (condition) => condition.comparator === "lte",
      );
      if (
        lower &&
        upper &&
        compareDecimals(lower.price, upper.price) > 0
      ) {
        errors.push(
          diagnostic(
            "contradictory_conditions",
            `${rulePath}.all`,
            `${side} lower price threshold exceeds its upper threshold`,
          ),
        );
      }
    }

    if (rule.action.kind === "fixed_swap") {
      const requiredSide =
        rule.action.direction === "buy_xrp" ? "ask" : "bid";
      if (
        priceConditions.some((condition) => condition.side !== requiredSide)
      ) {
        errors.push(
          diagnostic(
            "ambiguous_conditions",
            `${rulePath}.all`,
            `${rule.action.direction} price rules must use executable ${requiredSide} thresholds`,
          ),
        );
      }
      if (
        compareDecimals(rule.action.order_value, limits.max_order_value) > 0 ||
        compareDecimals(rule.action.order_value, limits.min_order_value) < 0
      ) {
        errors.push(
          diagnostic(
            "order_exceeds_limit",
            `${rulePath}.action.order_value`,
            "fixed order value must be inside the approved per-order range",
          ),
        );
      }
    } else if (priceConditions.length > 0) {
      errors.push(
        diagnostic(
          "ambiguous_conditions",
          `${rulePath}.all`,
          "target-allocation rules cannot bind one price side before their trade direction is known",
        ),
      );
    }
  });
  return errors;
}

function schemaDiagnostics(raw: unknown): {
  proposal?: DeclarativeStrategyProposal;
  errors: StrategyPlanDiagnostic[];
} {
  const unsupported: StrategyPlanDiagnostic[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const root = raw as Record<string, unknown>;
    const asset = root.issued_asset;
    if (asset && typeof asset === "object" && !Array.isArray(asset)) {
      const candidate = asset as Record<string, unknown>;
      if (
        candidate.currency !==
          "524C555344000000000000000000000000000000" ||
        candidate.issuer !== "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"
      ) {
        unsupported.push(
          diagnostic(
            "unsupported_asset",
            "issued_asset",
            "declarative_strategy_v1 supports only XRP/test-RLUSD on Testnet",
          ),
        );
      }
    }
    const plan = root.plan;
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      const rules = (plan as Record<string, unknown>).rules;
      if (Array.isArray(rules)) {
        rules.forEach((rawRule, ruleIndex) => {
          if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
            return;
          }
          const rule = rawRule as Record<string, unknown>;
          const action = rule.action;
          if (action && typeof action === "object" && !Array.isArray(action)) {
            const kind = (action as Record<string, unknown>).kind;
            if (kind !== "fixed_swap" && kind !== "target_allocation") {
              unsupported.push(
                diagnostic(
                  "unsupported_action",
                  `plan.rules[${ruleIndex}].action.kind`,
                  `unsupported action ${JSON.stringify(kind)}; use fixed_swap or target_allocation`,
                ),
              );
            }
          }
          const conditions = rule.all;
          if (Array.isArray(conditions)) {
            conditions.forEach((rawCondition, conditionIndex) => {
              if (
                !rawCondition ||
                typeof rawCondition !== "object" ||
                Array.isArray(rawCondition)
              ) {
                return;
              }
              const kind = (rawCondition as Record<string, unknown>).kind;
              if (
                kind !== "always" &&
                kind !== "price_threshold" &&
                kind !== "xrp_allocation_outside"
              ) {
                unsupported.push(
                  diagnostic(
                    "unsupported_condition",
                    `plan.rules[${ruleIndex}].all[${conditionIndex}].kind`,
                    `unsupported condition ${JSON.stringify(kind)}; nested or dynamic conditions are not executable`,
                  ),
                );
              }
            });
          }
        });
      }
    }
  }
  const parsed = DeclarativeStrategyProposalSchema.safeParse(raw);
  if (parsed.success) return { proposal: parsed.data, errors: [] };
  return {
    errors: [
      ...unsupported,
      ...parsed.error.issues.map((issue) =>
        diagnostic(
          "invalid_shape",
          issue.path.length === 0 ? "$" : issue.path.join("."),
          issue.message,
        ),
      ),
    ].slice(0, 64),
  };
}

export async function validateDeclarativeStrategyProposal(
  raw: unknown,
): Promise<StrategyPlanValidationResult> {
  const parsed = schemaDiagnostics(raw);
  if (!parsed.proposal) {
    return StrategyPlanValidationResultSchema.parse({
      valid: false,
      semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
      capabilities: DECLARATIVE_STRATEGY_CAPABILITIES,
      errors: parsed.errors,
    });
  }
  const errors = staticDiagnostics(parsed.proposal);
  if (errors.length > 0) {
    return StrategyPlanValidationResultSchema.parse({
      valid: false,
      semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
      capabilities: DECLARATIVE_STRATEGY_CAPABILITIES,
      errors,
    });
  }
  return StrategyPlanValidationResultSchema.parse({
    valid: true,
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    capabilities: DECLARATIVE_STRATEGY_CAPABILITIES,
    errors: [],
    plan_digest: await strategyProposalDigest(parsed.proposal),
    normalized_proposal: parsed.proposal,
  });
}

export async function compileDeclarativeStrategyProposal(
  raw: unknown,
): Promise<{
  proposal: DeclarativeStrategyProposal;
  planDigest: string;
}> {
  const result = await validateDeclarativeStrategyProposal(raw);
  if (!result.valid || !result.normalized_proposal || !result.plan_digest) {
    throw new StrategyPlanCompileError(result.errors);
  }
  return {
    proposal: result.normalized_proposal,
    planDigest: result.plan_digest,
  };
}

export class StrategyPlanCompileError extends Error {
  readonly diagnostics: readonly StrategyPlanDiagnostic[];

  constructor(diagnostics: readonly StrategyPlanDiagnostic[]) {
    super(diagnostics.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "StrategyPlanCompileError";
    this.diagnostics = diagnostics;
  }
}
