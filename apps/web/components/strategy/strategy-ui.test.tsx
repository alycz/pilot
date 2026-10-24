import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Strategy, StrategyAuditEvent } from "@pilot/contracts";

import { StrategyDraftForm } from "./strategy-draft-form";
import { AuditTrail, GlobalKillControl, InflightWarning, MandateReview, StrategyControls, StrategyStatus } from "./strategy-panels";
import { defaultStrategyDraft, mutationOutcomeProven, parsePendingMutation, strategyAuditView, strategyCreateInput, unresolvedSubmission, validateStrategyDraft, type PendingStrategyMutation, type StrategyView } from "./types";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const draft = { ...defaultStrategyDraft(account), mandateExpiresAt: "2026-12-01T12:00" };
const strategy: StrategyView = {
  id: "strategy:1", lifecycle: "active", mandateVersion: 3, mandateDigest: "AB".repeat(32), account,
  issuedCurrency: draft.issuedAsset.currency, issuedIssuer: draft.issuedAsset.issuer,
  targetXrpBps: 5000, lowerXrpBps: 4500, upperXrpBps: 5500, maxOrderValue: "25", maxDailyValue: "100",
  maxFeeDrops: "20", maxSlippageBps: 100, minimumXrpReserveDrops: "12000000", feeBufferDrops: "1000000",
  cooldownSeconds: 300, expiresAt: "2026-12-01T12:00:00.000Z", budgetReserved: "25", budgetCommitted: "10",
  schedulerEnabled: true, decisions: [], audit: [],
};

describe("autonomous strategy UI", () => {
  it("shows every explicit limit, the exact configured currency and issuer, and non-authorizing draft copy", () => {
    expect(draft.issuedAsset.currency).toBe("524C555344000000000000000000000000000000");
    expect(draft.issuedAsset.issuer).toBe("rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV");
    const markup = renderToStaticMarkup(createElement(StrategyDraftForm, { draft, onChange: vi.fn(), onReview: vi.fn() }));
    for (const label of ["XRPL Testnet · test funds", "Saving this draft cannot trade", "Maximum order value", "Daily value cap", "Maximum fee", "Maximum slippage", "Minimum XRP reserve", "Fee buffer", "Maximum XRP exposure", "Maximum issued exposure", "Cooldown", "Mandate expiry", draft.issuedAsset.currency, draft.issuedAsset.issuer]) expect(markup).toContain(label);
    expect(markup).not.toMatch(/expected return|guaranteed|profit/i);
  });

  it("validates band, decimal hierarchy, exact issuer and future expiry", () => {
    expect(validateStrategyDraft(draft, new Date("2026-10-22T00:00:00Z"))).toEqual({});
    expect(validateStrategyDraft({ ...draft, targetXrpBps: "4400" }).targetXrpBps).toMatch(/strictly inside/);
    expect(validateStrategyDraft({ ...draft, maxOrderValue: "101" }).maxOrderValue).toMatch(/daily cap/);
    expect(validateStrategyDraft({ ...draft, issuedAsset: { ...draft.issuedAsset, issuer: account } }).issuedAsset).toMatch(/exact configured/);
    expect(validateStrategyDraft({ ...draft, maxSlippageBps: "1001" }).maxSlippageBps).toMatch(/no more than 1,000/);
    expect(validateStrategyDraft({ ...draft, maxQuoteAgeSeconds: "301" }).maxQuoteAgeSeconds).toMatch(/no more than 300/);
    expect(validateStrategyDraft({ ...draft, maxOrderValue: `1${"0".repeat(64)}` }).maxOrderValue).toMatch(/up to 64/);
    expect(validateStrategyDraft({ ...draft, mandateExpiresAt: "2026-01-01T00:00" }, new Date("2026-10-22T00:00:00Z")).mandateExpiresAt).toMatch(/future/);
  });

  it("binds the create payload to the exact Testnet issue and every approved limit", () => {
    const payload = strategyCreateInput(draft);
    expect(payload.issued_asset).toEqual({ currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" });
    expect((payload as { interval_seconds: number }).interval_seconds).toBe(300);
    expect(payload.execution_mode).toBe("offer_create_fok");
    expect(payload.limits).toMatchObject({ max_order_value: "25", max_daily_value: "100", max_fee_drops: "20", max_slippage_bps: 100, max_price_impact_bps: 100, min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000000", cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1 });
  });

  it("renders the bounded declarative grammar, explicit paper boundary, and immutable counters", () => {
    const declarative = { ...draft, strategyMode: "declarative" as const, declarative: { ...draft.declarative, intervalSeconds: "900" } };
    const markup = renderToStaticMarkup(createElement(StrategyDraftForm, { draft: declarative, onChange: vi.fn(), onReview: vi.fn() }));
    for (const copy of ["Scheduled fixed-value XRP buys", "executable ask", "executable bid", "first match", "one fill-or-kill order per evaluation", "Cumulative value cap", "Maximum total trades", "Maximum actions for this mandate", "reserved, committed, and outcome-unknown", "same decision does not count twice", "Explicit inputs only", "not a live signal"]) expect(markup).toContain(copy);
    expect(markup).toContain("Unsupported assets");
    expect(markup).toContain("does not reset after a restart");
    expect(markup).toContain("Every 900 seconds");
    expect(markup).not.toContain("Every 5 minutes");
    const payload = strategyCreateInput(declarative) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: "declarative_strategy_v1", semantics_version: "harbor.declarative-strategy/1", execution_mode: "offer_create_fok", limits: { max_mandate_occurrences: 12, cumulative_scope: "owner_network_asset_lifetime" } });
    expect(payload).not.toHaveProperty("paperInputs");
  });

  it("renders immutable mandate identity and says model, memory, and chat cannot expand it", () => {
    const declarative = { ...draft, strategyMode: "declarative" as const };
    const markup = renderToStaticMarkup(createElement(MandateReview, { draft: declarative, digest: strategy.mandateDigest, version: 3, onBack: vi.fn(), onApprove: vi.fn() }));
    expect(markup).toContain(strategy.mandateDigest);
    expect(markup).toContain(draft.issuedAsset.issuer);
    expect(markup).toContain("Model preferences, memory, and chat cannot change");
    expect(markup).toContain("Immutable mandate action cap");
    expect(markup).toContain("retrying the same decision does not count twice");
    expect(markup).toContain("lifetime total-trades cap");
    expect(markup).toContain("Approve and activate this mandate");
  });

  it("fails activation closed while account-wide global kill is enabled or unreadable", () => {
    const enabled = renderToStaticMarkup(createElement(MandateReview, {
      draft, digest: strategy.mandateDigest, version: 3,
      authorizationBlocked: "Account-wide global kill is enabled.", onBack: vi.fn(), onApprove: vi.fn(),
    }));
    expect(enabled).toContain("Global kill must be cleared first");
    expect(enabled).toContain("disabled");

    const unavailable = renderToStaticMarkup(createElement(GlobalKillControl, {
      account, unavailableReason: "Status unavailable.", hasMandate: true,
      onEnable: vi.fn(), onClear: vi.fn(),
    }));
    expect(unavailable).toContain("unavailable · fail closed");
    expect(unavailable).toContain("Status unavailable.");
    expect(unavailable).not.toContain("Authorize autonomous submissions…");
  });

  it("describes global kill as account-scoped and honest about in-flight transactions", () => {
    const enabled = renderToStaticMarkup(createElement(GlobalKillControl, {
      account, killSwitch: { enabled: true, reason: "owner safety", updated_at: "2026-10-23T00:00:00.000Z" },
      hasMandate: true, onEnable: vi.fn(), onClear: vi.fn(),
    }));
    expect(enabled).toContain("Authorize autonomous submissions…");
    expect(enabled).toContain(account);
    expect(enabled).toContain("every strategy owned by this exact account on Testnet");
    expect(enabled).toContain("cannot cancel an already submitted or ambiguous transaction");

    const cleared = renderToStaticMarkup(createElement(GlobalKillControl, {
      account, killSwitch: { enabled: false, updated_at: "2026-10-23T00:01:00.000Z" },
      hasMandate: true, onEnable: vi.fn(), onClear: vi.fn(),
    }));
    expect(cleared).toContain("Enable global kill…");
    expect(cleared).toContain("Only separately approved, unexpired mandate limits");
  });

  it("renders every lifecycle and honest not-live-accepted labeling", () => {
    for (const lifecycle of ["draft", "paused", "active", "stopped", "error"] as const) {
      const markup = renderToStaticMarkup(createElement(StrategyStatus, { strategy: { ...strategy, lifecycle, strategyKind: "declarative_strategy_v1", maxMandateOccurrences: 12 } }));
      expect(markup).toContain("XRPL TESTNET · TEST FUNDS ONLY");
      expect(markup).toContain(lifecycle);
      expect(markup).toContain("Mandate action cap");
      expect(markup).toContain("12 actions");
      expect(markup).toContain("live bounded acceptance has not been performed");
    }
    const unavailable = renderToStaticMarkup(createElement(StrategyStatus, { strategy: { ...strategy, budgetReserved: undefined, budgetCommitted: undefined } }));
    expect(unavailable.match(/Unavailable from status API/g)).toHaveLength(2);
    expect(unavailable).not.toContain("undefined test-RLUSD");
  });

  it("explains that unknown outcomes block follow-up without retrying", () => {
    const markup = renderToStaticMarkup(createElement(InflightWarning, { transaction: { state: "unknown", hash: "A".repeat(64) } }));
    expect(markup).toContain("Follow-up orders are blocked");
    expect(markup).toContain("will not retry this trade as a new order");
    expect(markup).toContain("Refresh reconciliation");
  });

  it("keeps needs-approval paused with the exact Harbor approval ID and no auto-sign promise", () => {
    const markup = renderToStaticMarkup(createElement(InflightWarning, { transaction: { state: "needs_approval", approvalId: "approval-harbor-42" } }));
    expect(markup).toContain("Owner approval required");
    expect(markup).toContain("approval-harbor-42");
    expect(markup).toContain("existing Harbor owner-approval workflow");
    expect(markup).toContain("will not sign for the owner");
  });

  it("keeps an unknown submission visible only until its exact execution is reconciled", () => {
    const base = { strategy_id: "strategy:1", actor: "runner" as const, detail: {}, trigger_id: "trigger:1", decision_id: "decision:1" };
    const unknown = { ...base, event_id: "event:1", execution_id: "execution:1", kind: "submission_unknown" as const, at: "2026-10-22T00:00:00.000Z" };
    const other = { ...base, event_id: "event:2", execution_id: "execution:2", kind: "submitted" as const, at: "2026-10-22T00:00:01.000Z" };
    const reconciled = { ...base, event_id: "event:3", execution_id: "execution:1", kind: "reconciled" as const, actor: "reconciler" as const, at: "2026-10-22T00:00:02.000Z" };
    expect(unresolvedSubmission([other, reconciled, unknown])?.execution_id).toBe("execution:2");
  });

  it("formats audit explanations, hold codes, approval IDs, and transaction hashes", () => {
    const event = { strategy_id: "strategy:1", event_id: "event:4", execution_id: "execution:4", actor: "runner" as const, kind: "needs_approval" as const, at: "2026-10-22T00:00:00.000Z", detail: { explanation: "Policy requires owner approval", hold_codes: ["policy_paused"], approval_id: "approval-4", tx_hash: "A".repeat(64), next_action: "Use the existing approval workflow." } } satisfies StrategyAuditEvent;
    const formatted = strategyAuditView(event);
    expect(formatted.detail).toContain("Policy requires owner approval");
    expect(formatted.detail).toContain("Hold codes: policy_paused");
    expect(formatted.detail).toContain("Approval ID: approval-4");
    expect(formatted.detail).toContain(`Transaction hash: ${"A".repeat(64)}`);
    expect(formatted.detail).toContain("existing approval workflow");
  });

  it("retains tenant-scoped unknown mutations until generation plus exact audit evidence proves the result", () => {
    const pending: PendingStrategyMutation = { requestId: "request-pause-1", action: "pause", account, strategyId: "strategy:1", expectedLifecycle: "paused", baselineGeneration: 1, mandateVersion: 3, mandateDigest: strategy.mandateDigest, startedAt: "2026-10-22T00:00:00.000Z" };
    expect(parsePendingMutation(JSON.stringify(pending), account)).toEqual(pending);
    expect(parsePendingMutation(JSON.stringify(pending), "rWrongTenant111111111111111111111")).toBeUndefined();
    const durable = { strategy_id: "strategy:1", lifecycle: "paused", generation: 2, created_at: "2026-10-21T00:00:00.000Z", mandate: { account, version: 3, digest: strategy.mandateDigest } } as Strategy;
    expect(mutationOutcomeProven(pending, durable, [])).toBe(false);
    const evidence = { strategy_id: "strategy:1", event_id: "event:pause", actor: "owner", kind: "paused", detail: {}, at: "2026-10-22T00:00:01.000Z" } as StrategyAuditEvent;
    expect(mutationOutcomeProven(pending, durable, [evidence])).toBe(true);
    expect(mutationOutcomeProven(pending, { ...durable, generation: 1 }, [evidence])).toBe(false);
  });

  it("scopes emergency kill to one strategy and preserves unresolved submissions", () => {
    const markup = renderToStaticMarkup(createElement(StrategyControls, {
      strategy, onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onKill: vi.fn(),
    }));
    expect(markup).toContain("Emergency kill this strategy");
    expect(markup).toContain("cannot be cancelled here and remains visible until reconciled");
    expect(markup).not.toMatch(/global kill/i);
  });

  it("blocks resume on global kill without blocking risk-reducing owner controls", () => {
    const markup = renderToStaticMarkup(createElement(StrategyControls, {
      strategy: { ...strategy, lifecycle: "paused" },
      resumeBlockedReason: "Clear account-wide global kill with a fresh wallet proof before resuming.",
      onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onKill: vi.fn(),
    }));
    expect(markup).toContain("Revalidate and resume");
    expect(markup).toContain("Clear account-wide global kill");
    const buttons = markup.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons.find((button) => button.includes("Revalidate and resume"))).toContain('disabled=""');
    expect(buttons.find((button) => button.includes("Stop this mandate version"))).not.toContain('disabled=""');
    expect(buttons.find((button) => button.includes("Emergency kill this strategy"))).not.toContain('disabled=""');
    expect(markup).toContain("Stop this mandate version");
    expect(markup).toContain("Emergency kill this strategy");
  });

  it("renders a mobile and desktop audit identity without hiding the transaction", () => {
    const markup = renderToStaticMarkup(createElement(AuditTrail, { events: [{ id: "event:1", at: "2026-10-22T00:00:00Z", event: "submission unknown", detail: "Awaiting exact-hash reconciliation", identity: "B".repeat(64) }] }));
    expect(markup.match(new RegExp("B".repeat(64), "g"))).toHaveLength(2);
    expect(markup).toContain("Strategy audit table");
  });
});
