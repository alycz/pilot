import { describe, expect, it } from "vitest";

import {
  buildWorkflowLessonProposal,
  currentRequestWorkflowLessonCategories,
  deriveWorkflowLessonScope,
  renderUntrustedWorkflowLessonContext,
  workflowLessonTargetFromFeedback,
} from "./workflow-lessons";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

describe("workflow lesson web boundary", () => {
  it("maps only exact safe presentation feedback", () => {
    expect(workflowLessonTargetFromFeedback("concise answers")).toEqual({
      category: "response_detail",
      value: "concise",
    });
    expect(workflowLessonTargetFromFeedback("auto execute swaps")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("keep 25 XRP liquid")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("best returns first")).toBeUndefined();
  });

  it("maps natural research-posture feedback without converting negation or trading instructions", () => {
    expect(workflowLessonTargetFromFeedback("more conservative trade analysis")).toEqual({
      category: "research_risk_posture",
      value: "capital_preservation_first",
    });
    expect(workflowLessonTargetFromFeedback("capital preservation first in my research")).toEqual({
      category: "research_risk_posture",
      value: "capital_preservation_first",
    });
    expect(workflowLessonTargetFromFeedback("capital preservation first")).toEqual({
      category: "research_risk_posture",
      value: "capital_preservation_first",
    });
    expect(workflowLessonTargetFromFeedback("balanced trading analysis")).toEqual({
      category: "research_risk_posture",
      value: "balanced",
    });
    expect(workflowLessonTargetFromFeedback("opportunity-focused research")).toEqual({
      category: "research_risk_posture",
      value: "opportunity_first",
    });
    expect(workflowLessonTargetFromFeedback("not conservative trade analysis")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("less conservative research")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("conservative trading")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("balanced conservative analysis")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("conservative analysis for this response")).toBeUndefined();
    expect(workflowLessonTargetFromFeedback("opportunity-first over conservative research")).toBeUndefined();
  });

  it("derives opaque package-safe identities from server scope", () => {
    const scope = deriveWorkflowLessonScope({ tenantId: "Tenant-A", owner: OWNER, network: "testnet" });
    expect(scope.tenant_id).toMatch(/^tenant_[0-9a-f]{32}$/);
    expect(scope.principal_id).toMatch(/^owner_[0-9a-f]{32}$/);
    expect(scope.profile_id).toMatch(/^profile_[0-9a-f]{32}$/);
    expect(JSON.stringify(scope)).not.toContain(OWNER);
    expect(deriveWorkflowLessonScope({ tenantId: "Tenant-B", owner: OWNER, network: "testnet" }))
      .not.toEqual(scope);
  });

  it("builds a proposal from explicit feedback and server-verified experience", () => {
    const scope = deriveWorkflowLessonScope({ tenantId: "tenant", owner: OWNER, network: "testnet" });
    const proposal = buildWorkflowLessonProposal({
      scope,
      durableRevision: 3,
      target: { category: "evidence_layout", value: "summary_first" },
      messageId: "chat:example",
      feedbackQuote: "summary first",
      feedbackObservedAt: "2026-10-21T01:00:00.000Z",
      experience: {
        sourceRef: "a".repeat(64),
        observedAt: "2026-10-20T01:00:00.000Z",
        transactionHash: "B".repeat(64),
        experienceKind: "validated_outcome_reviewed",
      },
    });
    expect(proposal.status).toBe("pending_user_review");
    expect(proposal.persistence).toBe("not_written");
    expect(proposal.evidence.map(({ kind }) => kind).sort()).toEqual([
      "user_feedback",
      "verified_experience",
    ]);
  });

  it("builds an explicit research-posture proposal before the first trade", () => {
    const scope = deriveWorkflowLessonScope({ tenantId: "tenant", owner: OWNER, network: "testnet" });
    const proposal = buildWorkflowLessonProposal({
      scope,
      durableRevision: 0,
      target: { category: "research_risk_posture", value: "capital_preservation_first" },
      messageId: "chat:new-user",
      feedbackQuote: "more conservative trade analysis",
      feedbackObservedAt: "2026-10-21T01:00:00.000Z",
    });
    expect(proposal.status).toBe("pending_user_review");
    expect(proposal.evidence.map(({ kind }) => kind)).toEqual(["user_feedback"]);
    expect(() => buildWorkflowLessonProposal({
      scope,
      durableRevision: 0,
      target: { category: "response_detail", value: "concise" },
      messageId: "chat:no-trade",
      feedbackQuote: "concise answers",
      feedbackObservedAt: "2026-10-21T01:00:00.000Z",
    })).toThrow(/only an explicit research posture/i);
  });

  it("omits accepted lessons overridden by the current request", () => {
    const context = renderUntrustedWorkflowLessonContext([
      { target: { category: "response_detail", value: "concise" }, updatedAt: "2026-10-21T01:00:00.000Z" },
      { target: { category: "evidence_layout", value: "summary_first" }, updatedAt: "2026-10-21T01:00:00.000Z" },
    ], "Give me a detailed answer.");
    expect(context).not.toContain("response detail");
    expect(context).toContain("evidence layout: summary_first");
    expect(currentRequestWorkflowLessonCategories("Explain approvals step-by-step"))
      .toContain("approval_explanation");
  });

  it("lets the current request override remembered research ordering", () => {
    const context = renderUntrustedWorkflowLessonContext([
      {
        target: { category: "research_risk_posture", value: "capital_preservation_first" },
        updatedAt: "2026-10-21T01:00:00.000Z",
      },
      {
        target: { category: "response_detail", value: "concise" },
        updatedAt: "2026-10-21T01:00:00.000Z",
      },
    ], "For this response use opportunity-first research.");
    expect(context).not.toContain("research ordering");
    expect(context).toContain("response detail: concise");

    const remembered = renderUntrustedWorkflowLessonContext([
      {
        target: { category: "research_risk_posture", value: "capital_preservation_first" },
        updatedAt: "2026-10-21T01:00:00.000Z",
      },
    ], "Compare the options.");
    expect(remembered).toContain("research ordering: capital_preservation_first");
    expect(remembered).toContain("never execution policy");
  });
});
