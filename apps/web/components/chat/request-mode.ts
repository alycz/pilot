export type ChatRequestMode = "auto" | "one_time" | "recurring" | "autonomous";

export type RecommendedRequestMode =
  | "read_only"
  | "one_time"
  | "recurring"
  | "autonomous"
  | "clarify";

export type RequestModeResolution = {
  selection: ChatRequestMode;
  recommendation: RecommendedRequestMode;
  effective: Exclude<RecommendedRequestMode, "clarify"> | "clarify";
  explicit: boolean;
  label: string;
  review: string;
};

/** Synchronous guard for rapid clicks before React can publish `running`. */
export class ChatRequestGate {
  private active = false;

  enter(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  leave(): void {
    this.active = false;
  }
}

const ACTION = /\b(?:buy|sell|swap|trade|convert|exchange|send|pay|transfer|deposit|withdraw|rebalance|purchase)\b/i;
const READ_ONLY = /^(?:please\s+)?(?:what|why|how|when|where|who|explain|show|list|compare|review|summari[sz]e|analy[sz]e|check|describe|tell me)\b/i;
const AUTONOMOUS = /\b(?:autonomous(?:ly)?|strategy|without (?:asking|prompting)|no per[- ]trade|within (?:the|my) mandate|price[- ]threshold|allocation band|dca)\b/i;
const RECURRING = /\b(?:recurring|repeat(?:ing)?|schedule(?:d)?|every\s+(?:\d+\s+)?(?:minute|hour|day|week|month)s?|hourly|daily|weekly|monthly|each\s+(?:minute|hour|day|week|month))\b/i;
const ONE_TIME = /\b(?:one[- ]time|once|just this (?:once|time)|single (?:transaction|trade|swap|payment|order))\b/i;
const BOUNDED_AMOUNT = /\b\d+(?:[.,]\d+)?\s*(?:xrp|rlusd|drops?)\b/i;

export const REQUEST_MODE_OPTIONS: ReadonlyArray<{
  value: ChatRequestMode;
  label: string;
  detail: string;
}> = [
  {
    value: "auto",
    label: "Let agent choose",
    detail: "Recommend a scope from this request only; never consent to ongoing execution.",
  },
  {
    value: "one_time",
    label: "One-time",
    detail: "At most one transaction for this request. It never repeats.",
  },
  {
    value: "recurring",
    label: "Recurring",
    detail: "Draft a bounded schedule for separate review and approval.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    detail: "Draft a bounded strategy mandate for separate review and approval.",
  },
] as const;

export function parseChatRequestMode(value: unknown): ChatRequestMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "one_time" || value === "recurring" || value === "autonomous") return value;
  throw new Error("The requested chat mode is invalid.");
}

export function inferRequestMode(prompt: string): RecommendedRequestMode {
  const text = prompt.trim();
  if (!text) return "clarify";
  // Questions remain read-only unless they explicitly request an ongoing plan.
  // This keeps phrases such as "What is my daily budget?" from becoming a schedule.
  if (READ_ONLY.test(text)) return "read_only";
  if (AUTONOMOUS.test(text)) return "autonomous";
  if (RECURRING.test(text)) return "recurring";
  if (ONE_TIME.test(text)) return "one_time";
  if (ACTION.test(text) && BOUNDED_AMOUNT.test(text)) return "one_time";
  if (ACTION.test(text)) return "clarify";
  return "read_only";
}

function approvalReview(mode: RequestModeResolution["effective"]): string {
  if (mode === "read_only") return "Read-only answer · no transaction, schedule, mandate, or wallet approval.";
  if (mode === "one_time") return "Review the exact account, network, assets, amount, limits, policy result, and transaction. It can run once only and never becomes a schedule or mandate.";
  if (mode === "recurring") return "Review the exact schedule, action, account, Testnet assets, finite immutable-mandate action cap, lifetime cumulative limits, cooldown, and expiry before separately approving it. This chat choice is not approval.";
  if (mode === "autonomous") return "Review the exact immutable plan, ordered actions, account, Testnet assets, finite immutable-mandate action cap, lifetime limits, expiry, semantics version, and digest before owner approval. This chat choice is not approval.";
  return "The request is ambiguous. Choose One-time, Recurring, or Autonomous, or clarify the scope; no risk-bearing tool should run yet.";
}

export function resolveRequestMode(selection: ChatRequestMode, prompt: string): RequestModeResolution {
  const recommendation = inferRequestMode(prompt);
  const effective = selection === "auto" ? recommendation : selection;
  const labels: Record<RequestModeResolution["effective"], string> = {
    read_only: "Read-only",
    one_time: "One-time",
    recurring: "Recurring",
    autonomous: "Autonomous",
    clarify: "Needs scope",
  };
  return {
    selection,
    recommendation,
    effective,
    explicit: selection !== "auto",
    label: labels[effective],
    review: approvalReview(effective),
  };
}

/** Server-side model constraint. A mode is interpretation metadata, never authority. */
export function chatRequestModePolicy(selection: ChatRequestMode, prompt: string): string {
  const resolved = resolveRequestMode(selection, prompt);
  const lines = [
    "Current request mode boundary:",
    `- User selection: ${selection === "auto" ? "Let agent choose" : resolved.label}.`,
    `- Deterministic request recommendation: ${resolved.recommendation.replace("_", " ")}.`,
    "- This metadata scopes interpretation only. It is never consent, a wallet proof, a schedule, a mandate, signing authority, or execution authority.",
    "- Never invent a transaction, schedule, or strategy when the request itself is informational or lacks the required exact fields.",
  ];
  if (resolved.effective === "clarify") {
    lines.push("- Ask the user to choose or clarify One-time, Recurring, or Autonomous. Do not call any risk-bearing transaction or strategy tool.");
  } else if (resolved.effective === "read_only") {
    lines.push("- Answer read-only. Do not call transaction, signing, scheduling, or strategy-proposal tools.");
  } else if (resolved.effective === "one_time") {
    lines.push("- Handle at most one transaction for this request. Never turn it into a recurring schedule or autonomous mandate. Preserve all existing policy and owner-approval checks.");
  } else if (resolved.effective === "recurring") {
    lines.push("- Produce only a bounded recurring-plan proposal for separate exact review. It must include an explicit finite max_mandate_occurrences count for reserved, committed, or outcome-unknown trade actions on that immutable mandate; retrying the same decision does not count twice. This is separate from the owner/account/asset lifetime max_total_trades counter. Do not invent reset behavior.");
    lines.push("- Do not create, activate, sign, submit, or imply that selecting this mode approved anything.");
  } else {
    lines.push("- Produce only a supported bounded declarative-strategy proposal for separate immutable mandate review, with an explicit finite max_mandate_occurrences cap distinct from the owner/account/asset lifetime max_total_trades counter. Do not invent reset behavior.");
    lines.push("- Do not create, activate, sign, submit, or imply that selecting this mode approved anything.");
  }
  return lines.join("\n");
}
