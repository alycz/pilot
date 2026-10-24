import { DEFAULT_POLICY } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import {
  createPolicyDraft,
  policyDraftEquals,
  policyRefreshConflictIsObsolete,
  reconcilePolicyRefresh,
  settleGuardedPolicySave,
  validatePolicyDraft,
} from "./policy-utils";

describe("memory policy editor", () => {
  it("round-trips the fixed default policy contract", () => {
    const result = validatePolicyDraft(createPolicyDraft(DEFAULT_POLICY));

    expect(result).toEqual({ ok: true, policy: DEFAULT_POLICY });
  });

  it("normalizes issuer input and removes duplicates", () => {
    const draft = createPolicyDraft(DEFAULT_POLICY);
    draft.issuer_allowlist = "RLUSD, tUSD\nRLUSD";
    draft.networks = ["testnet", "testnet", "devnet"];

    const result = validatePolicyDraft(draft);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.issuer_allowlist).toEqual(["RLUSD", "tUSD"]);
      expect(result.policy.networks).toEqual(["testnet", "devnet"]);
    }
  });

  it("rejects unsafe relationships and incomplete selections", () => {
    const draft = createPolicyDraft(DEFAULT_POLICY);
    draft.execute_under_usd = "7000";
    draft.max_per_tx_usd = "6000";
    draft.daily_cap_usd = "5000";
    draft.allowed_tx_types = [];
    draft.networks = [];
    draft.issuer_allowlist = "";
    draft.x402_max_per_call_drops = "2000000";

    const result = validatePolicyDraft(draft);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.execute_under_usd).toBeDefined();
      expect(result.errors.max_per_tx_usd).toBeDefined();
      expect(result.errors.allowed_tx_types).toBeDefined();
      expect(result.errors.networks).toBeDefined();
      expect(result.errors.issuer_allowlist).toBeDefined();
      expect(result.errors.x402_max_per_call_drops).toBeDefined();
    }
  });

  it("detects whether cancel/save controls should be enabled", () => {
    const baseline = createPolicyDraft(DEFAULT_POLICY);
    const changed = createPolicyDraft(DEFAULT_POLICY);
    changed.daily_cap_usd = "7500";

    expect(policyDraftEquals(baseline, createPolicyDraft(DEFAULT_POLICY))).toBe(true);
    expect(policyDraftEquals(baseline, changed)).toBe(false);
  });

  it("replaces displayed values when the same owner and network return a refreshed policy", () => {
    const baseline = createPolicyDraft(DEFAULT_POLICY);
    const refreshed = createPolicyDraft({ ...DEFAULT_POLICY, execute_under_usd: 225 });

    expect(reconcilePolicyRefresh(baseline, baseline, refreshed)).toEqual({
      kind: "replace",
      baseline: refreshed,
      draft: refreshed,
    });
  });

  it("preserves non-conflicting edits while adopting refreshed fields", () => {
    const baseline = createPolicyDraft(DEFAULT_POLICY);
    const local = createPolicyDraft(DEFAULT_POLICY);
    local.daily_cap_usd = "7500";
    const refreshed = createPolicyDraft({ ...DEFAULT_POLICY, execute_under_usd: 225 });

    const result = reconcilePolicyRefresh(baseline, local, refreshed);

    expect(result.kind).toBe("merge");
    if (result.kind === "merge") {
      expect(result.baseline.execute_under_usd).toBe("225");
      expect(result.draft.execute_under_usd).toBe("225");
      expect(result.draft.daily_cap_usd).toBe("7500");
    }
  });

  it("blocks saving when local and refreshed policies change the same field", () => {
    const baseline = createPolicyDraft(DEFAULT_POLICY);
    const local = createPolicyDraft(DEFAULT_POLICY);
    local.daily_cap_usd = "7500";
    const refreshed = createPolicyDraft({ ...DEFAULT_POLICY, daily_cap_usd: 6250 });

    expect(reconcilePolicyRefresh(baseline, local, refreshed)).toEqual({
      kind: "conflict",
      incoming: refreshed,
      fields: ["daily_cap_usd"],
    });
    expect(local.daily_cap_usd).toBe("7500");
  });

  it("clears an obsolete A to C conflict when the source returns to A", () => {
    const baselineA = createPolicyDraft(DEFAULT_POLICY);
    const local = createPolicyDraft(DEFAULT_POLICY);
    local.daily_cap_usd = "7500";
    const sourceC = createPolicyDraft({ ...DEFAULT_POLICY, daily_cap_usd: 6250 });

    const conflict = reconcilePolicyRefresh(baselineA, local, sourceC);
    expect(conflict.kind).toBe("conflict");
    const obsolete = policyRefreshConflictIsObsolete(
      baselineA,
      baselineA,
      conflict.kind === "conflict" ? conflict.incoming : undefined,
    );
    const pendingAfterRefresh = obsolete
      ? undefined
      : conflict.kind === "conflict" ? conflict.incoming : undefined;
    expect(obsolete).toBe(true);
    expect(pendingAfterRefresh).toBeUndefined();
    expect(!policyDraftEquals(local, baselineA) && pendingAfterRefresh === undefined).toBe(true);
    expect(local.daily_cap_usd).toBe("7500");
    expect(reconcilePolicyRefresh(baselineA, local, baselineA)).toEqual({ kind: "unchanged" });
  });

  it("keeps a refresh conflict save-blocked after an older in-flight save completes", async () => {
    const sourceRevisionAtSaveStart = 4;
    let guard = {
      sourceRevision: sourceRevisionAtSaveStart,
      refreshConflictPending: false,
    };
    let finishSave!: (value: string) => void;
    const save = new Promise<string>((resolve) => {
      finishSave = resolve;
    });

    const settlement = settleGuardedPolicySave(
      save,
      sourceRevisionAtSaveStart,
      () => guard,
    );

    // The server source refreshes and conflicts with the editable draft while
    // the older save request is still awaiting completion.
    guard = {
      sourceRevision: sourceRevisionAtSaveStart + 1,
      refreshConflictPending: true,
    };
    finishSave("older-save-response");

    await expect(settlement).resolves.toEqual({
      kind: "stale",
      guard: {
        sourceRevision: sourceRevisionAtSaveStart + 1,
        refreshConflictPending: true,
      },
    });
  });
});
