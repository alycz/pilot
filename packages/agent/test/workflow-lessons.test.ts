import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowLessonProposal,
  refineWorkflowLessonProposal,
  reviewWorkflowLessonProposal,
  type UserFeedbackEvidence,
  type VerifiedExperienceEvidence,
  type WorkflowLessonScope,
  type WorkflowLessonTarget,
} from "../src/workflow-lessons.js";

const scope: WorkflowLessonScope = {
  tenant_id: "tenant-a",
  principal_id: "principal-a",
  profile_id: "profile-a",
} as const;

const conciseLesson = {
  category: "response_detail",
  value: "concise",
} as const satisfies WorkflowLessonTarget;

const detailedLesson = {
  category: "response_detail",
  value: "detailed",
} as const satisfies WorkflowLessonTarget;

const conservativeResearchLesson = {
  category: "research_risk_posture",
  value: "capital_preservation_first",
} as const satisfies WorkflowLessonTarget;

function feedback(
  evidenceId = "feedback-1",
  lesson: WorkflowLessonTarget = conciseLesson,
  evidenceScope: WorkflowLessonScope = scope,
): UserFeedbackEvidence {
  return {
    schema_version: "pilot.workflow-lesson-evidence.v1",
    evidence_id: evidenceId,
    kind: "user_feedback",
    scope: evidenceScope,
    observed_at: "2026-10-21T01:00:00.000Z",
    feedback_kind: "explicit_preference",
    preference: lesson,
    source_ref: "a".repeat(64),
  };
}

function experience(
  evidenceId = "experience-1",
  evidenceScope: WorkflowLessonScope = scope,
): VerifiedExperienceEvidence {
  return {
    schema_version: "pilot.workflow-lesson-evidence.v1",
    evidence_id: evidenceId,
    kind: "verified_experience",
    scope: evidenceScope,
    observed_at: "2026-10-21T01:01:00.000Z",
    experience_kind: "answer_accepted",
    verifier: "user_confirmed_session",
    source_ref: "b".repeat(64),
  };
}

function createInput(evidence = [feedback(), experience()]) {
  return {
    scope,
    base_durable_revision: 7,
    lesson: conciseLesson,
    evidence,
  };
}

describe("workflow lesson proposals", () => {
  it("creates a frozen pending proposal without mutating its inputs", () => {
    const input = createInput();
    const before = structuredClone(input);

    const proposal = createWorkflowLessonProposal(input);

    expect(input).toEqual(before);
    expect(proposal).toMatchObject({
      proposal_id: expect.stringMatching(/^lesson_[0-9a-f]{24}$/),
      scope,
      base_durable_revision: 7,
      lesson: conciseLesson,
      supersedes_proposal_id: null,
      status: "pending_user_review",
    });
    expect(proposal.evidence.map(({ evidence_id }) => evidence_id)).toEqual([
      "experience-1",
      "feedback-1",
    ]);
    expect(proposal.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.scope)).toBe(true);
    expect(Object.isFrozen(proposal.lesson)).toBe(true);
    expect(Object.isFrozen(proposal.evidence)).toBe(true);
    expect(Object.isFrozen(proposal.evidence[0])).toBe(true);
  });

  it("canonicalizes evidence ordering for deterministic ids and digests", () => {
    const forward = createWorkflowLessonProposal(createInput([
      feedback(),
      experience(),
    ]));
    const reverse = createWorkflowLessonProposal(createInput([
      experience(),
      feedback(),
    ]));

    expect(reverse).toEqual(forward);
  });

  it("uses locale-independent ordinal ordering for punctuation in evidence ids", () => {
    const proposal = createWorkflowLessonProposal(createInput([
      feedback("evidence.a"),
      experience("evidence-1"),
    ]));

    expect(proposal.evidence.map(({ evidence_id }) => evidence_id)).toEqual([
      "evidence-1",
      "evidence.a",
    ]);
  });

  it("requires both explicit user feedback and verified experience", () => {
    expect(() => createWorkflowLessonProposal(createInput([feedback()]))).toThrow();
    expect(() => createWorkflowLessonProposal(createInput([experience()]))).toThrow();
  });

  it("allows a new user to review an explicit research posture without prior trade evidence", () => {
    const proposal = createWorkflowLessonProposal({
      scope,
      base_durable_revision: 0,
      lesson: conservativeResearchLesson,
      evidence: [feedback("feedback-research", conservativeResearchLesson)],
    });

    expect(proposal).toMatchObject({
      lesson: conservativeResearchLesson,
      evidence: [{ kind: "user_feedback", preference: conservativeResearchLesson }],
      status: "pending_user_review",
      persistence: "not_written",
    });
    expect(reviewWorkflowLessonProposal({
      proposal,
      scope,
      proposal_id: proposal.proposal_id,
      reviewer_kind: "user",
      decision: "approve",
      reviewed_at: "2026-10-21T02:00:00.000Z",
    })).toMatchObject({
      lesson: conservativeResearchLesson,
      status: "approved_for_persistence",
      persistence: "not_written",
    });
  });

  it("rejects correction-only research posture evidence without a prior proposal", () => {
    expect(() => createWorkflowLessonProposal({
      scope,
      base_durable_revision: 0,
      lesson: conservativeResearchLesson,
      evidence: [{
        ...feedback("feedback-research", conservativeResearchLesson),
        feedback_kind: "correction",
      }],
    })).toThrow(/explicit preference/i);
  });

  it("still rejects experience-derived presentation lessons without verified experience", () => {
    expect(() => createWorkflowLessonProposal({
      scope,
      base_durable_revision: 0,
      lesson: conciseLesson,
      evidence: [feedback("feedback-presentation", conciseLesson)],
    })).toThrow(/verified experience/i);
  });

  it("rejects duplicate evidence ids and cross-scope evidence", () => {
    expect(() => createWorkflowLessonProposal(createInput([
      feedback("same-id"),
      experience("same-id"),
    ]))).toThrow();

    const otherScope = { ...scope, principal_id: "principal-b" };
    expect(() => createWorkflowLessonProposal(createInput([
      feedback(),
      experience("experience-2", otherScope),
    ]))).toThrow();
  });

  it.each([
    ["policy", { policy: { daily_limit: "1000" } }],
    ["slippage", { max_slippage_bps: 250 }],
    ["action", { action: "execute_trade" }],
  ])("strictly rejects an unsafe %s field on the lesson target", (_name, unsafe) => {
    expect(() => createWorkflowLessonProposal({
      ...createInput(),
      lesson: { ...conciseLesson, ...unsafe },
    })).toThrow();
  });

  it("keeps research posture non-authorizing and rejects embedded execution policy", () => {
    expect(() => createWorkflowLessonProposal({
      scope,
      base_durable_revision: 0,
      lesson: {
        ...conservativeResearchLesson,
        max_amount: "10",
        route: "amm",
      },
      evidence: [feedback("feedback-research", conservativeResearchLesson)],
    })).toThrow();
  });

  it.each([
    ["transaction", { transaction: { hash: "secret" } }],
    ["order", { order: { amount: "100" } }],
    ["credential", { credential: "not-allowed" }],
  ])("strictly rejects a raw %s payload on evidence", (_name, unsafe) => {
    expect(() => createWorkflowLessonProposal(createInput([
      { ...feedback(), ...unsafe } as UserFeedbackEvidence,
      experience(),
    ]))).toThrow();
  });

  it("refines a proposal with same-scope evidence and a safe corrected preference", () => {
    const prior = createWorkflowLessonProposal(createInput());
    const input = {
      prior_proposal: prior,
      scope,
      base_durable_revision: 7,
      lesson: detailedLesson,
      additional_evidence: [
        feedback("feedback-2", detailedLesson),
        experience("experience-2"),
      ],
    };
    const before = structuredClone(input);

    const refined = refineWorkflowLessonProposal(input);

    expect(input).toEqual(before);
    expect(refined).toMatchObject({
      proposal_id: expect.stringMatching(/^lesson_[0-9a-f]{24}$/),
      scope,
      base_durable_revision: 7,
      lesson: detailedLesson,
      supersedes_proposal_id: prior.proposal_id,
      status: "pending_user_review",
    });
    expect(refined.proposal_id).not.toBe(prior.proposal_id);
    expect(refined.evidence).toHaveLength(4);
    expect(Object.isFrozen(refined)).toBe(true);
  });

  it("accepts a matching authenticated correction to an explicit research posture", () => {
    const prior = createWorkflowLessonProposal({
      scope,
      base_durable_revision: 0,
      lesson: conservativeResearchLesson,
      evidence: [feedback("feedback-research", conservativeResearchLesson)],
    });
    const corrected = {
      category: "research_risk_posture",
      value: "balanced",
    } as const satisfies WorkflowLessonTarget;

    const refined = refineWorkflowLessonProposal({
      prior_proposal: prior,
      scope,
      base_durable_revision: 0,
      lesson: corrected,
      additional_evidence: [{
        ...feedback("feedback-research-correction", corrected),
        feedback_kind: "correction",
      }],
    });

    expect(refined).toMatchObject({
      lesson: corrected,
      supersedes_proposal_id: prior.proposal_id,
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: "user_feedback",
          feedback_kind: "correction",
          preference: corrected,
        }),
      ]),
    });
  });

  it("rejects no-op, duplicate, cross-scope, stale-revision, and authority-changing refinements", () => {
    const prior = createWorkflowLessonProposal(createInput());
    const base = {
      prior_proposal: prior,
      scope,
      base_durable_revision: 7,
      lesson: conciseLesson,
      additional_evidence: [],
    };

    expect(() => refineWorkflowLessonProposal(base)).toThrow();
    expect(() => refineWorkflowLessonProposal({
      ...base,
      additional_evidence: [experience("experience-1")],
    })).toThrow();
    expect(() => refineWorkflowLessonProposal({
      ...base,
      additional_evidence: [experience(
        "experience-3",
        { ...scope, profile_id: "profile-b" },
      )],
    })).toThrow();
    expect(() => refineWorkflowLessonProposal({
      ...base,
      base_durable_revision: 8,
      additional_evidence: [experience("experience-3")],
    })).toThrow();
    expect(() => refineWorkflowLessonProposal({
      ...base,
      scope: { ...scope, tenant_id: "tenant-b" },
      additional_evidence: [experience("experience-3")],
    })).toThrow();
    expect(() => refineWorkflowLessonProposal({
      ...base,
      lesson: detailedLesson,
      additional_evidence: [experience("experience-3")],
    })).toThrow();
  });

  it("creates approve and reject review artifacts without persistence", () => {
    const proposal = createWorkflowLessonProposal(createInput());
    const reviewedAt = "2026-10-21T02:00:00.000Z";

    const approved = reviewWorkflowLessonProposal({
      proposal,
      scope,
      proposal_id: proposal.proposal_id,
      reviewer_kind: "user",
      decision: "approve",
      reviewed_at: reviewedAt,
    });
    const rejected = reviewWorkflowLessonProposal({
      proposal,
      scope,
      proposal_id: proposal.proposal_id,
      reviewer_kind: "user",
      decision: "reject",
      reviewed_at: reviewedAt,
    });

    expect(approved).toMatchObject({
      review_id: expect.stringMatching(/^lesson_review_[0-9a-f]{24}$/),
      proposal_id: proposal.proposal_id,
      scope,
      reviewer_kind: "user",
      decision: "approve",
      status: "approved_for_persistence",
      lesson: conciseLesson,
      evidence_digest: proposal.evidence_digest,
    });
    expect(rejected).toMatchObject({
      decision: "reject",
      status: "rejected",
    });
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.lesson)).toBe(true);
  });

  it("rejects model review and stale proposal identities or scopes", () => {
    const proposal = createWorkflowLessonProposal(createInput());
    const base = {
      proposal,
      scope,
      proposal_id: proposal.proposal_id,
      reviewer_kind: "user" as const,
      decision: "approve" as const,
      reviewed_at: "2026-10-21T02:00:00.000Z",
    };

    expect(() => reviewWorkflowLessonProposal({
      ...base,
      reviewer_kind: "model",
    })).toThrow();
    expect(() => reviewWorkflowLessonProposal({
      ...base,
      proposal_id: `lesson_${"f".repeat(24)}`,
    })).toThrow();
    expect(() => reviewWorkflowLessonProposal({
      ...base,
      scope: { ...scope, profile_id: "profile-b" },
    })).toThrow();
  });

  it("does not invoke injected persistence or network callbacks", () => {
    const persist = vi.fn();
    const fetch = vi.fn();

    expect(() => createWorkflowLessonProposal({
      ...createInput(),
      persist,
      fetch,
    })).toThrow();
    expect(persist).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not make network requests during successful proposal and review flows", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const proposal = createWorkflowLessonProposal(createInput());
    const refined = refineWorkflowLessonProposal({
      prior_proposal: proposal,
      scope,
      base_durable_revision: 7,
      lesson: conciseLesson,
      additional_evidence: [experience("experience-3")],
    });

    reviewWorkflowLessonProposal({
      proposal: refined,
      scope,
      proposal_id: refined.proposal_id,
      reviewer_kind: "user",
      decision: "approve",
      reviewed_at: "2026-10-21T02:00:00.000Z",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
