import {
  DeclarativeStrategyProposalSchema,
  StrategyPlanPreviewSchema,
  StrategyPlanValidationResultSchema,
  type DeclarativeStrategyProposal,
} from "@pilot/contracts";

/**
 * Read-only projection of a `propose_strategy` tool result for the chat card.
 * The proposal stays untrusted: setting it up sends the normalized proposal to
 * the existing owner-scoped create route, where Harbor validates it again.
 */
export type StrategyFact = { label: string; value: string };

export type StrategyPlanSummary = {
  title: string;
  rules: string[];
  facts: StrategyFact[];
};

export type StrategyProposalView =
  | {
      state: "validated";
      planDigest: string;
      proposal: DeclarativeStrategyProposal;
      summary: StrategyPlanSummary;
      preview?: string;
    }
  | { state: "rejected"; issues: string[] };

type Rule = DeclarativeStrategyProposal["plan"]["rules"][number];
type Condition = Rule["all"][number];

export function parseStrategyProposalOutput(output: unknown): StrategyProposalView | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as { state?: unknown; validation?: unknown; preview?: unknown };
  const validation = StrategyPlanValidationResultSchema.safeParse(record.validation);
  if (!validation.success) return undefined;
  if (record.state === "rejected" || !validation.data.valid) {
    const issues = validation.data.errors.map((error) => error.message);
    return { state: "rejected", issues: issues.length ? issues : ["Harbor could not validate this plan."] };
  }
  if (record.state !== "validated" || !validation.data.plan_digest) return undefined;
  const proposal = DeclarativeStrategyProposalSchema.safeParse(validation.data.normalized_proposal);
  if (!proposal.success) return undefined;
  return {
    state: "validated",
    planDigest: validation.data.plan_digest,
    proposal: proposal.data,
    summary: summarizeProposal(proposal.data),
    preview: describePreview(record.preview),
  };
}

export function summarizeProposal(proposal: DeclarativeStrategyProposal): StrategyPlanSummary {
  const rules = proposal.plan.rules.map(describeRule);
  const limits = proposal.limits;
  return {
    title: titleFor(proposal.plan.rules),
    rules,
    facts: [
      { label: "Checks", value: `Every ${duration(proposal.plan.trigger.interval_seconds)}` },
      { label: "Per trade", value: `Up to ${limits.max_order_value} RLUSD` },
      { label: "Per day", value: `${limits.max_daily_value} RLUSD · ${limits.max_daily_trades} trades` },
      { label: "Ends", value: shortDate(proposal.expires_at) },
    ],
  };
}

/** The create input is the normalized proposal itself; the route rebinds account and network. */
export function strategyCreateInputFromProposal(proposal: DeclarativeStrategyProposal): Record<string, unknown> & { expires_at: string } {
  const { account: _account, network: _network, ...input } = proposal;
  return structuredClone(input);
}

/** A short name for a plan, from what its rules do. */
export function titleFor(rules: readonly Rule[]): string {
  const kinds = new Set(rules.map((rule) => rule.action.kind === "target_allocation" ? "rebalance" : rule.all.some((condition) => condition.kind === "price_threshold") ? "price" : "recurring"));
  if (kinds.size > 1) return "Multi-rule strategy";
  if (kinds.has("rebalance")) return "Rebalance XRP and RLUSD";
  if (kinds.has("price")) return "Price trigger";
  return "Recurring buy";
}

export function describeRule(rule: Rule): string {
  const action = rule.action;
  const when = rule.all.filter((condition) => condition.kind !== "always").map(describeCondition);
  if (action.kind === "target_allocation") {
    return `Keep XRP between ${percent(action.lower_xrp_bps)} and ${percent(action.upper_xrp_bps)} of the portfolio, trading back to ${percent(action.target_xrp_bps)}${when.length ? ` when ${when.join(" and ")}` : ""}.`;
  }
  const verb = action.direction === "buy_xrp" ? "Buy" : "Sell";
  const base = `${verb} ${action.order_value} RLUSD of XRP`;
  return when.length ? `${base} when ${when.join(" and ")}.` : `${base} on every check.`;
}

function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case "price_threshold":
      return `the ${condition.side === "bid" ? "bid" : "ask"} is ${condition.comparator === "lte" ? "at or below" : "at or above"} ${condition.price} RLUSD`;
    case "xrp_allocation_outside":
      return `XRP is outside ${percent(condition.lower_xrp_bps)}–${percent(condition.upper_xrp_bps)}`;
    default:
      return "always";
  }
}

function describePreview(value: unknown): string | undefined {
  const parsed = StrategyPlanPreviewSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const preview = parsed.data;
  if (preview.outcome === "hold") return `If it ran now, it would hold. ${preview.explanation}`;
  const verb = preview.action === "buy_xrp" ? "buy" : "sell";
  return `If it ran now, it would ${verb} ${preview.proposed_value} RLUSD of XRP at ${preview.price_value}.`;
}

function percent(bps: number): string {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "day" : `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "hour" : `${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
