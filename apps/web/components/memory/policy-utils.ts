import type { Network, Policy } from "@pilot/contracts";

import type { PolicyDraft, PolicyValidation } from "./types";

const WHOLE_DROPS = /^\d+$/;

const POLICY_DRAFT_FIELDS: Array<keyof PolicyDraft> = [
  "max_per_tx_usd",
  "daily_cap_usd",
  "execute_under_usd",
  "max_slippage_bps",
  "allowed_tx_types",
  "issuer_allowlist",
  "block_requireauth_issuers",
  "networks",
  "x402_max_per_call_drops",
  "x402_daily_cap_drops",
];

export type PolicyRefreshReconciliation =
  | { kind: "unchanged" }
  | { kind: "replace"; baseline: PolicyDraft; draft: PolicyDraft }
  | { kind: "merge"; baseline: PolicyDraft; draft: PolicyDraft }
  | { kind: "conflict"; incoming: PolicyDraft; fields: Array<keyof PolicyDraft> };

export const POLICY_NETWORKS: Network[] = [
  "testnet",
  "devnet",
  "lending-devnet",
];

export function createPolicyDraft(policy: Policy): PolicyDraft {
  return {
    max_per_tx_usd: String(policy.max_per_tx_usd),
    daily_cap_usd: String(policy.daily_cap_usd),
    execute_under_usd: String(policy.execute_under_usd),
    max_slippage_bps: String(policy.max_slippage_bps),
    allowed_tx_types: [...policy.allowed_tx_types],
    issuer_allowlist: policy.issuer_allowlist.join(", "),
    block_requireauth_issuers: policy.block_requireauth_issuers,
    networks: [...policy.networks],
    x402_max_per_call_drops: policy.x402_max_per_call_drops,
    x402_daily_cap_drops: policy.x402_daily_cap_drops,
  };
}

function uniqueList(value: string) {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function finiteNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validatePolicyDraft(draft: PolicyDraft): PolicyValidation {
  const errors: Partial<Record<keyof PolicyDraft, string>> = {};
  const maxPerTx = finiteNumber(draft.max_per_tx_usd);
  const dailyCap = finiteNumber(draft.daily_cap_usd);
  const executeUnder = finiteNumber(draft.execute_under_usd);
  const slippage = finiteNumber(draft.max_slippage_bps);
  const issuers = uniqueList(draft.issuer_allowlist);

  if (maxPerTx === undefined || maxPerTx <= 0) {
    errors.max_per_tx_usd = "Enter an amount greater than zero.";
  }
  if (dailyCap === undefined || dailyCap <= 0) {
    errors.daily_cap_usd = "Enter an amount greater than zero.";
  }
  if (executeUnder === undefined || executeUnder < 0) {
    errors.execute_under_usd = "Enter zero or a positive amount.";
  } else if (maxPerTx !== undefined && executeUnder > maxPerTx) {
    errors.execute_under_usd = "Auto-execute must not exceed the per-transaction cap.";
  }
  if (maxPerTx !== undefined && dailyCap !== undefined && maxPerTx > dailyCap) {
    errors.max_per_tx_usd = "The per-transaction cap must not exceed the daily cap.";
  }
  if (slippage === undefined || !Number.isInteger(slippage) || slippage < 0 || slippage > 10_000) {
    errors.max_slippage_bps = "Use a whole number from 0 to 10,000 bps.";
  }
  if (draft.allowed_tx_types.length === 0) {
    errors.allowed_tx_types = "Allow at least one transaction type.";
  }
  if (issuers.length === 0) {
    errors.issuer_allowlist = "Add at least one allowed issuer or currency code.";
  }
  if (draft.networks.length === 0) {
    errors.networks = "Choose at least one network.";
  }
  if (!WHOLE_DROPS.test(draft.x402_max_per_call_drops)) {
    errors.x402_max_per_call_drops = "Use a whole number of drops.";
  }
  if (!WHOLE_DROPS.test(draft.x402_daily_cap_drops)) {
    errors.x402_daily_cap_drops = "Use a whole number of drops.";
  } else if (
    WHOLE_DROPS.test(draft.x402_max_per_call_drops) &&
    compareWholeNumbers(draft.x402_max_per_call_drops, draft.x402_daily_cap_drops) > 0
  ) {
    errors.x402_max_per_call_drops = "The per-call cap must not exceed the daily x402 cap.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    policy: {
      max_per_tx_usd: maxPerTx!,
      daily_cap_usd: dailyCap!,
      execute_under_usd: executeUnder!,
      max_slippage_bps: slippage!,
      allowed_tx_types: [...new Set(draft.allowed_tx_types)],
      issuer_allowlist: issuers,
      block_requireauth_issuers: draft.block_requireauth_issuers,
      networks: [...new Set(draft.networks)],
      x402_max_per_call_drops: draft.x402_max_per_call_drops,
      x402_daily_cap_drops: draft.x402_daily_cap_drops,
      ap4m_enabled: false,
    },
  };
}

export function policyDraftEquals(left: PolicyDraft, right: PolicyDraft) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function policyRefreshConflictIsObsolete(
  baseline: PolicyDraft,
  incoming: PolicyDraft,
  pendingRefresh: PolicyDraft | undefined,
): boolean {
  return pendingRefresh !== undefined && policyDraftEquals(baseline, incoming);
}

export type PolicySaveGuardSnapshot = {
  sourceRevision: number;
  refreshConflictPending: boolean;
};

export type GuardedPolicySaveResult<T> =
  | { kind: "current"; value: T; guard: PolicySaveGuardSnapshot }
  | { kind: "stale"; guard: PolicySaveGuardSnapshot };

/**
 * Settles an asynchronous save against the latest editor state. The current
 * guard is read only after the promise resolves, so a refresh that arrives
 * during the await cannot be erased by the older completion.
 */
export async function settleGuardedPolicySave<T>(
  save: Promise<T>,
  sourceRevisionAtSaveStart: number,
  readGuard: () => PolicySaveGuardSnapshot,
): Promise<GuardedPolicySaveResult<T>> {
  const value = await save;
  const guard = readGuard();
  return guard.sourceRevision === sourceRevisionAtSaveStart
    ? { kind: "current", value, guard }
    : { kind: "stale", guard };
}

function policyFieldEquals<K extends keyof PolicyDraft>(
  left: PolicyDraft[K],
  right: PolicyDraft[K],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clonePolicyDraft(draft: PolicyDraft): PolicyDraft {
  return {
    ...draft,
    allowed_tx_types: [...draft.allowed_tx_types],
    networks: [...draft.networks],
  };
}

/**
 * Three-way reconciliation for an editable policy receiving a refreshed source.
 * Remote-only changes are adopted, local-only changes are preserved, and a
 * field changed on both sides must be resolved explicitly before saving.
 */
export function reconcilePolicyRefresh(
  baseline: PolicyDraft,
  draft: PolicyDraft,
  incoming: PolicyDraft,
): PolicyRefreshReconciliation {
  if (policyDraftEquals(baseline, incoming)) return { kind: "unchanged" };
  if (policyDraftEquals(baseline, draft)) {
    const replacement = clonePolicyDraft(incoming);
    return { kind: "replace", baseline: replacement, draft: clonePolicyDraft(replacement) };
  }

  const conflicts: Array<keyof PolicyDraft> = [];
  const merged = clonePolicyDraft(incoming);
  for (const field of POLICY_DRAFT_FIELDS) {
    const localChanged = !policyFieldEquals(draft[field], baseline[field]);
    const remoteChanged = !policyFieldEquals(incoming[field], baseline[field]);
    if (localChanged && remoteChanged && !policyFieldEquals(draft[field], incoming[field])) {
      conflicts.push(field);
      continue;
    }
    if (localChanged) {
      // The assignment is safe because both values come from the same keyed field.
      (merged[field] as PolicyDraft[typeof field]) = clonePolicyField(draft[field]);
    }
  }

  if (conflicts.length > 0) {
    return { kind: "conflict", incoming: clonePolicyDraft(incoming), fields: conflicts };
  }
  return {
    kind: "merge",
    baseline: clonePolicyDraft(incoming),
    draft: merged,
  };
}

function clonePolicyField<K extends keyof PolicyDraft>(value: PolicyDraft[K]): PolicyDraft[K] {
  return (Array.isArray(value) ? [...value] : value) as PolicyDraft[K];
}

function compareWholeNumbers(left: string, right: string) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}
