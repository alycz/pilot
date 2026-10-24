import {
  OFFICIAL_TESTNET_RLUSD_CURRENCY,
  OFFICIAL_TESTNET_RLUSD_ISSUER,
} from "../../lib/rlusd-acquisition";
import type { Strategy, StrategyAuditEvent } from "@pilot/contracts";

export type StrategyLifecycle = "draft" | "paused" | "active" | "stopped" | "error";

export type StrategyDraft = {
  network: "testnet";
  account: string;
  issuedAsset: { label: "test-RLUSD"; currency: string; issuer: string };
  targetXrpBps: string;
  lowerXrpBps: string;
  upperXrpBps: string;
  maxOrderValue: string;
  maxDailyValue: string;
  minOrderValue: string;
  maxFeeDrops: string;
  maxSlippageBps: string;
  maxPriceImpactBps: string;
  minimumXrpReserveDrops: string;
  feeBufferDrops: string;
  maxXrpExposureDrops: string;
  maxIssuedExposure: string;
  minimumLiquidityValue: string;
  cooldownSeconds: string;
  maxQuoteAgeSeconds: string;
  mandateExpiresAt: string;
  intervalSeconds: "300";
};

export type StrategyDecisionView = {
  id: string;
  triggerId: string;
  at: string;
  outcome: "hold" | "planned" | "needs_approval" | "submitted" | "validated" | "failed" | "unknown";
  explanation: string;
  allocation?: string;
  amount?: string;
  txHash?: string;
  approvalId?: string;
};

export type StrategyAuditView = {
  id: string;
  at: string;
  event: string;
  detail: string;
  identity?: string;
};

export type StrategyView = {
  id: string;
  lifecycle: StrategyLifecycle;
  mandateVersion: number;
  mandateDigest: string;
  account: string;
  issuedCurrency: string;
  issuedIssuer: string;
  targetXrpBps: number;
  lowerXrpBps: number;
  upperXrpBps: number;
  maxOrderValue: string;
  maxDailyValue: string;
  maxFeeDrops: string;
  maxSlippageBps: number;
  minimumXrpReserveDrops: string;
  feeBufferDrops: string;
  cooldownSeconds: number;
  expiresAt: string;
  lastEvaluationAt?: string;
  nextEvaluationAt?: string;
  budgetReserved?: string;
  budgetCommitted?: string;
  schedulerEnabled: boolean;
  unresolvedTransaction?: { hash?: string; approvalId?: string; state: "submitting" | "unknown" | "submitted" | "needs_approval" };
  decisions: StrategyDecisionView[];
  audit: StrategyAuditView[];
};

export type DraftErrors = Partial<Record<keyof StrategyDraft, string>>;

export type StrategyMutationAction = "create" | "activate" | "pause" | "resume" | "stop" | "kill";
export type PendingStrategyMutation = {
  requestId: string;
  action: StrategyMutationAction;
  account: string;
  strategyId?: string;
  expectedLifecycle: StrategyLifecycle;
  baselineGeneration?: number;
  mandateVersion?: number;
  mandateDigest?: string;
  expectedExpiresAt?: string;
  startedAt: string;
};

const EXPECTED_LIFECYCLE: Record<StrategyMutationAction, StrategyLifecycle> = {
  create: "draft", activate: "active", pause: "paused", resume: "active", stop: "stopped", kill: "stopped",
};
const MUTATION_AUDIT_KIND: Record<StrategyMutationAction, StrategyAuditEvent["kind"]> = {
  create: "created", activate: "activated", pause: "paused", resume: "resumed", stop: "stopped", kill: "kill_enabled",
};

export function pendingMutationStorageKey(account: string): string {
  return `pilot:strategy:pending:${account}`;
}
export function parsePendingMutation(raw: string | null, account: string): PendingStrategyMutation | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PendingStrategyMutation>;
    if (!value || typeof value !== "object" || typeof value.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value.requestId) ||
      typeof value.action !== "string" || !(value.action in EXPECTED_LIFECYCLE) || value.account !== account ||
      value.expectedLifecycle !== EXPECTED_LIFECYCLE[value.action as StrategyMutationAction] ||
      typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return undefined;
    if (value.action !== "create" && (typeof value.strategyId !== "string" || typeof value.baselineGeneration !== "number" || !Number.isInteger(value.baselineGeneration) || value.baselineGeneration < 0)) return undefined;
    return value as PendingStrategyMutation;
  } catch { return undefined; }
}

export function mutationOutcomeProven(pending: PendingStrategyMutation, strategy: Strategy | undefined, events: StrategyAuditEvent[]): boolean {
  if (!strategy || strategy.mandate.account !== pending.account) return false;
  if (pending.action === "create") {
    return strategy.lifecycle === "draft" && (!pending.expectedExpiresAt || strategy.mandate.expires_at === pending.expectedExpiresAt) && Date.parse(strategy.created_at) >= Date.parse(pending.startedAt);
  }
  if (strategy.strategy_id !== pending.strategyId || strategy.lifecycle !== pending.expectedLifecycle || strategy.generation <= (pending.baselineGeneration ?? Number.MAX_SAFE_INTEGER)) return false;
  if (pending.mandateVersion !== undefined && strategy.mandate.version !== pending.mandateVersion) return false;
  if (pending.mandateDigest !== undefined && strategy.mandate.digest !== pending.mandateDigest) return false;
  return events.some((event) => event.strategy_id === strategy.strategy_id && event.kind === MUTATION_AUDIT_KIND[pending.action] && Date.parse(event.at) >= Date.parse(pending.startedAt));
}

export function strategyAuditView(event: StrategyAuditEvent): StrategyAuditView {
  const details = [
    typeof event.detail.reason === "string" ? event.detail.reason : typeof event.detail.explanation === "string" ? event.detail.explanation : undefined,
    typeof event.detail.approval_id === "string" ? `Approval ID: ${event.detail.approval_id}` : undefined,
    typeof event.detail.tx_hash === "string" ? `Transaction hash: ${event.detail.tx_hash}` : typeof event.detail.hash === "string" ? `Transaction hash: ${event.detail.hash}` : undefined,
    Array.isArray(event.detail.hold_codes) && event.detail.hold_codes.every((value) => typeof value === "string") ? `Hold codes: ${event.detail.hold_codes.join(", ")}` : undefined,
    typeof event.detail.next_action === "string" ? event.detail.next_action : undefined,
  ].filter(Boolean);
  return { id: event.event_id, at: event.at, event: event.kind.replaceAll("_", " "), detail: details.join(" · ") || "Durable strategy event", identity: event.execution_id ?? event.decision_id ?? event.trigger_id };
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function decimalParts(value: string): [bigint, number] {
  const [whole, fractional = ""] = value.split(".");
  return [BigInt(`${whole}${fractional}`), fractional.length];
}

export function compareDecimal(left: string, right: string): number {
  const [leftValue, leftScale] = decimalParts(left);
  const [rightValue, rightScale] = decimalParts(right);
  const scale = Math.max(leftScale, rightScale);
  const a = leftValue * 10n ** BigInt(scale - leftScale);
  const b = rightValue * 10n ** BigInt(scale - rightScale);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function defaultStrategyDraft(account = ""): StrategyDraft {
  return {
    network: "testnet",
    account,
    issuedAsset: {
      label: "test-RLUSD",
      currency: OFFICIAL_TESTNET_RLUSD_CURRENCY,
      issuer: OFFICIAL_TESTNET_RLUSD_ISSUER,
    },
    targetXrpBps: "5000",
    lowerXrpBps: "4500",
    upperXrpBps: "5500",
    maxOrderValue: "25",
    maxDailyValue: "100",
    minOrderValue: "1",
    maxFeeDrops: "20",
    maxSlippageBps: "100",
    maxPriceImpactBps: "100",
    minimumXrpReserveDrops: "12000000",
    feeBufferDrops: "1000000",
    maxXrpExposureDrops: "1000000000",
    maxIssuedExposure: "1000",
    minimumLiquidityValue: "50",
    cooldownSeconds: "300",
    maxQuoteAgeSeconds: "20",
    mandateExpiresAt: "",
    intervalSeconds: "300",
  };
}

export function strategyCreateInput(draft: StrategyDraft) {
  return {
    kind: "xrp_issued_rebalancer_v1" as const,
    issued_asset: { currency: draft.issuedAsset.currency, issuer: draft.issuedAsset.issuer },
    allocation: { target_xrp_bps: Number(draft.targetXrpBps), lower_xrp_bps: Number(draft.lowerXrpBps), upper_xrp_bps: Number(draft.upperXrpBps) },
    limits: { max_order_value: draft.maxOrderValue, max_daily_value: draft.maxDailyValue, min_order_value: draft.minOrderValue, max_fee_drops: draft.maxFeeDrops, max_slippage_bps: Number(draft.maxSlippageBps), max_price_impact_bps: Number(draft.maxPriceImpactBps), min_xrp_reserve_drops: draft.minimumXrpReserveDrops, fee_buffer_drops: draft.feeBufferDrops, max_xrp_exposure_drops: draft.maxXrpExposureDrops, max_issued_exposure: draft.maxIssuedExposure, min_liquidity_value: draft.minimumLiquidityValue, cooldown_seconds: Number(draft.cooldownSeconds), max_quote_age_seconds: Number(draft.maxQuoteAgeSeconds), max_ledger_gap: 1 },
    execution_mode: "offer_create_fok" as const,
    not_before: new Date().toISOString(),
    expires_at: new Date(draft.mandateExpiresAt).toISOString(),
    interval_seconds: 300,
  };
}

export function unresolvedSubmission(events: StrategyAuditEvent[]): StrategyAuditEvent | undefined {
  const pending = new Map<string, StrategyAuditEvent>();
  for (const event of [...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))) {
    if ((event.kind === "submitted" || event.kind === "submission_unknown" || event.kind === "needs_approval") && event.execution_id) pending.set(event.execution_id, event);
    if ((event.kind === "reconciled" || event.kind === "executed" || event.kind === "failed") && event.execution_id) pending.delete(event.execution_id);
  }
  return [...pending.values()].at(-1);
}

export function validateStrategyDraft(draft: StrategyDraft, now = new Date()): DraftErrors {
  const errors: DraftErrors = {};
  if (!CLASSIC_ADDRESS.test(draft.account)) errors.account = "Connect the exact Testnet budget account.";
  if (draft.network !== "testnet") errors.network = "The first strategy is Testnet-only.";
  if (
    draft.issuedAsset.currency !== OFFICIAL_TESTNET_RLUSD_CURRENCY ||
    draft.issuedAsset.issuer !== OFFICIAL_TESTNET_RLUSD_ISSUER
  ) {
    errors.issuedAsset = "Use the exact configured test-RLUSD currency and issuer.";
  }
  for (const key of ["maxOrderValue", "maxDailyValue", "minOrderValue", "maxIssuedExposure", "minimumLiquidityValue"] as const) {
    if (draft[key].length > 64 || !DECIMAL.test(draft[key]) || compareDecimal(draft[key], "0") <= 0) errors[key] = "Enter a positive canonical decimal up to 64 characters.";
  }
  for (const key of ["targetXrpBps", "lowerXrpBps", "upperXrpBps", "maxFeeDrops", "maxSlippageBps", "maxPriceImpactBps", "minimumXrpReserveDrops", "feeBufferDrops", "maxXrpExposureDrops", "cooldownSeconds", "maxQuoteAgeSeconds"] as const) {
    if (draft[key].length > 32 || !INTEGER.test(draft[key]) || BigInt(draft[key] || "0") <= 0n) errors[key] = "Enter a positive whole number up to 32 digits.";
  }
  if (!errors.lowerXrpBps && !errors.targetXrpBps && !errors.upperXrpBps) {
    const lower = BigInt(draft.lowerXrpBps);
    const target = BigInt(draft.targetXrpBps);
    const upper = BigInt(draft.upperXrpBps);
    if (!(lower < target && target < upper && upper <= 10_000n)) {
      errors.targetXrpBps = "Target must sit strictly inside a band no higher than 100%.";
    }
  }
  if (!errors.minOrderValue && !errors.maxOrderValue && compareDecimal(draft.minOrderValue, draft.maxOrderValue) > 0) {
    errors.minOrderValue = "Minimum order cannot exceed maximum order.";
  }
  if (!errors.maxOrderValue && !errors.maxDailyValue && compareDecimal(draft.maxOrderValue, draft.maxDailyValue) > 0) {
    errors.maxOrderValue = "Maximum order cannot exceed the daily cap.";
  }
  if (!errors.maxSlippageBps && BigInt(draft.maxSlippageBps) > 1_000n) errors.maxSlippageBps = "Slippage must be no more than 1,000 bps.";
  if (!errors.maxPriceImpactBps && BigInt(draft.maxPriceImpactBps) > 1_000n) errors.maxPriceImpactBps = "Price impact must be no more than 1,000 bps.";
  if (!errors.cooldownSeconds && (BigInt(draft.cooldownSeconds) < 60n || BigInt(draft.cooldownSeconds) > 86_400n)) errors.cooldownSeconds = "Cooldown must be from 60 to 86,400 seconds.";
  if (!errors.maxQuoteAgeSeconds && BigInt(draft.maxQuoteAgeSeconds) > 300n) errors.maxQuoteAgeSeconds = "Quote age must be no more than 300 seconds.";
  if (!draft.mandateExpiresAt || !Number.isFinite(Date.parse(draft.mandateExpiresAt)) || Date.parse(draft.mandateExpiresAt) <= now.getTime()) {
    errors.mandateExpiresAt = "Choose a future mandate expiry.";
  }
  return errors;
}
