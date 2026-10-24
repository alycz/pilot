import { createHash } from "node:crypto";

import { z } from "zod";

export const WORKFLOW_LESSON_EVIDENCE_SCHEMA_VERSION =
  "pilot.workflow-lesson-evidence.v1" as const;
export const WORKFLOW_LESSON_PROPOSAL_SCHEMA_VERSION =
  "pilot.workflow-lesson-proposal.v1" as const;
export const WORKFLOW_LESSON_REVIEW_SCHEMA_VERSION =
  "pilot.workflow-lesson-review.v1" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ProposalIdSchema = z.string().regex(/^lesson_[0-9a-f]{24}$/);
const ReviewIdSchema = z.string().regex(/^lesson_review_[0-9a-f]{24}$/);

export const WorkflowLessonScopeSchema = z
  .object({
    tenant_id: IdentifierSchema,
    principal_id: IdentifierSchema,
    profile_id: IdentifierSchema,
  })
  .strict();
export type WorkflowLessonScope = z.infer<typeof WorkflowLessonScopeSchema>;

const ResponseDetailLessonSchema = z
  .object({
    category: z.literal("response_detail"),
    value: z.enum(["concise", "balanced", "detailed"]),
  })
  .strict();
const EvidenceLayoutLessonSchema = z
  .object({
    category: z.literal("evidence_layout"),
    value: z.enum(["summary_first", "sources_first", "comparison_table"]),
  })
  .strict();
const ApprovalExplanationLessonSchema = z
  .object({
    category: z.literal("approval_explanation"),
    value: z.enum(["plain_language", "technical_detail", "step_by_step"]),
  })
  .strict();
const ComparisonEmphasisLessonSchema = z
  .object({
    category: z.literal("comparison_emphasis"),
    value: z.enum(["best_price_first", "risk_caveats_first", "balanced"]),
  })
  .strict();
const ResearchRiskPostureLessonSchema = z
  .object({
    category: z.literal("research_risk_posture"),
    value: z.enum([
      "capital_preservation_first",
      "balanced",
      "opportunity_first",
    ]),
  })
  .strict();

/** A research/presentation preference only; it cannot encode trading or execution behavior. */
export const WorkflowLessonTargetSchema = z.discriminatedUnion("category", [
  ResponseDetailLessonSchema,
  EvidenceLayoutLessonSchema,
  ApprovalExplanationLessonSchema,
  ComparisonEmphasisLessonSchema,
  ResearchRiskPostureLessonSchema,
]);
export type WorkflowLessonTarget = z.infer<typeof WorkflowLessonTargetSchema>;

const EvidenceReferenceFields = {
  schema_version: z.literal(WORKFLOW_LESSON_EVIDENCE_SCHEMA_VERSION),
  evidence_id: IdentifierSchema,
  scope: WorkflowLessonScopeSchema,
  observed_at: z.string().datetime({ offset: true }),
  source_ref: Sha256Schema,
} as const;

export const UserFeedbackEvidenceSchema = z
  .object({
    ...EvidenceReferenceFields,
    kind: z.literal("user_feedback"),
    feedback_kind: z.enum(["explicit_preference", "correction"]),
    preference: WorkflowLessonTargetSchema,
  })
  .strict();
export type UserFeedbackEvidence = z.infer<typeof UserFeedbackEvidenceSchema>;

export const VerifiedExperienceEvidenceSchema = z
  .object({
    ...EvidenceReferenceFields,
    kind: z.literal("verified_experience"),
    experience_kind: z.enum([
      "answer_accepted",
      "proposal_rejected",
      "approval_completed",
      "validated_outcome_reviewed",
      "comparison_used",
    ]),
    verifier: z.enum(["pilot_validated_event", "user_confirmed_session"]),
  })
  .strict();
export type VerifiedExperienceEvidence = z.infer<
  typeof VerifiedExperienceEvidenceSchema
>;

export const WorkflowLessonEvidenceSchema = z.discriminatedUnion("kind", [
  UserFeedbackEvidenceSchema,
  VerifiedExperienceEvidenceSchema,
]);
export type WorkflowLessonEvidence = z.infer<typeof WorkflowLessonEvidenceSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareOrdinal(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function sameScope(left: WorkflowLessonScope, right: WorkflowLessonScope): boolean {
  return (
    left.tenant_id === right.tenant_id &&
    left.principal_id === right.principal_id &&
    left.profile_id === right.profile_id
  );
}

function sameTarget(left: WorkflowLessonTarget, right: WorkflowLessonTarget): boolean {
  return left.category === right.category && left.value === right.value;
}

function sortEvidence(
  evidence: readonly WorkflowLessonEvidence[],
): WorkflowLessonEvidence[] {
  return [...evidence].sort((left, right) =>
    compareOrdinal(left.evidence_id, right.evidence_id),
  );
}

function evidenceDigest(evidence: readonly WorkflowLessonEvidence[]): string {
  return digest(sortEvidence(evidence));
}

type ProposalIdentity = {
  schema_version: typeof WORKFLOW_LESSON_PROPOSAL_SCHEMA_VERSION;
  scope: WorkflowLessonScope;
  base_durable_revision: number;
  lesson: WorkflowLessonTarget;
  evidence: readonly WorkflowLessonEvidence[];
  supersedes_proposal_id: string | null;
};

function proposalId(proposal: ProposalIdentity): string {
  return `lesson_${digest({
    schema_version: proposal.schema_version,
    scope: proposal.scope,
    base_durable_revision: proposal.base_durable_revision,
    lesson: proposal.lesson,
    evidence: sortEvidence(proposal.evidence),
    supersedes_proposal_id: proposal.supersedes_proposal_id,
  }).slice(0, 24)}`;
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateEvidenceSet(
  scope: WorkflowLessonScope,
  lesson: WorkflowLessonTarget,
  evidence: readonly WorkflowLessonEvidence[],
  context: z.RefinementCtx,
): void {
  if (
    new Set(evidence.map(({ evidence_id }) => evidence_id)).size !==
    evidence.length
  ) {
    addIssue(context, ["evidence"], "evidence ids must be unique");
  }
  if (evidence.some((item) => !sameScope(item.scope, scope))) {
    addIssue(context, ["evidence"], "all evidence must match the server-derived scope");
  }
  const feedback = evidence.filter(
    (item): item is UserFeedbackEvidence => item.kind === "user_feedback",
  );
  if (feedback.length === 0) {
    addIssue(context, ["evidence"], "explicit user feedback evidence is required");
  }
  const hasVerifiedExperience = evidence.some(
    ({ kind }) => kind === "verified_experience",
  );
  if (lesson.category !== "research_risk_posture" && !hasVerifiedExperience) {
    addIssue(context, ["evidence"], "verified experience evidence is required");
  }
  if (
    lesson.category === "research_risk_posture" &&
    !hasVerifiedExperience &&
    !(
      feedback.some(({ feedback_kind, preference }) =>
        feedback_kind === "explicit_preference" && sameTarget(preference, lesson)) ||
      (
        feedback.some(({ feedback_kind }) => feedback_kind === "explicit_preference") &&
        feedback.some(({ feedback_kind, preference }) =>
          feedback_kind === "correction" && sameTarget(preference, lesson))
      )
    )
  ) {
    addIssue(
      context,
      ["evidence"],
      "research posture without verified experience requires an explicit preference",
    );
  }
  if (!feedback.some(({ preference }) => sameTarget(preference, lesson))) {
    addIssue(
      context,
      ["lesson"],
      "the lesson must be supported by explicit user feedback",
    );
  }
}

export const WorkflowLessonProposalSchema = z
  .object({
    schema_version: z.literal(WORKFLOW_LESSON_PROPOSAL_SCHEMA_VERSION),
    proposal_id: ProposalIdSchema,
    scope: WorkflowLessonScopeSchema,
    base_durable_revision: z.number().int().min(0),
    lesson: WorkflowLessonTargetSchema,
    evidence: z.array(WorkflowLessonEvidenceSchema).min(1).max(32),
    evidence_digest: Sha256Schema,
    supersedes_proposal_id: ProposalIdSchema.nullable(),
    status: z.literal("pending_user_review"),
    persistence: z.literal("not_written"),
  })
  .strict()
  .superRefine((proposal, context) => {
    validateEvidenceSet(proposal.scope, proposal.lesson, proposal.evidence, context);
    if (proposal.evidence_digest !== evidenceDigest(proposal.evidence)) {
      addIssue(context, ["evidence_digest"], "evidence digest does not match evidence");
    }
    if (proposal.proposal_id !== proposalId(proposal)) {
      addIssue(context, ["proposal_id"], "proposal id does not match proposal content");
    }
  });
export type WorkflowLessonProposal = z.infer<typeof WorkflowLessonProposalSchema>;

export const CreateWorkflowLessonProposalInputSchema = z
  .object({
    scope: WorkflowLessonScopeSchema,
    base_durable_revision: z.number().int().min(0),
    lesson: WorkflowLessonTargetSchema,
    evidence: z.array(WorkflowLessonEvidenceSchema).min(1).max(32),
  })
  .strict();
export type CreateWorkflowLessonProposalInput = z.infer<
  typeof CreateWorkflowLessonProposalInputSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function buildProposal(identity: ProposalIdentity): WorkflowLessonProposal {
  const evidence = sortEvidence(identity.evidence);
  const candidate = {
    ...identity,
    evidence,
    proposal_id: proposalId({ ...identity, evidence }),
    evidence_digest: evidenceDigest(evidence),
    status: "pending_user_review" as const,
    persistence: "not_written" as const,
  };
  return deepFreeze(WorkflowLessonProposalSchema.parse(candidate));
}

/** Create a reviewable in-memory proposal. This function performs no persistence. */
export function createWorkflowLessonProposal(
  input: unknown,
): WorkflowLessonProposal {
  const parsed = CreateWorkflowLessonProposalInputSchema.parse(input);
  validateEvidenceSetOrThrow(parsed.scope, parsed.lesson, parsed.evidence);
  return buildProposal({
    schema_version: WORKFLOW_LESSON_PROPOSAL_SCHEMA_VERSION,
    ...parsed,
    supersedes_proposal_id: null,
  });
}

function validateEvidenceSetOrThrow(
  scope: WorkflowLessonScope,
  lesson: WorkflowLessonTarget,
  evidence: readonly WorkflowLessonEvidence[],
): void {
  const result = z
    .object({
      scope: WorkflowLessonScopeSchema,
      lesson: WorkflowLessonTargetSchema,
      evidence: z.array(WorkflowLessonEvidenceSchema).min(1).max(32),
    })
    .strict()
    .superRefine((candidate, context) =>
      validateEvidenceSet(
        candidate.scope,
        candidate.lesson,
        candidate.evidence,
        context,
      ),
    )
    .safeParse({ scope, lesson, evidence });
  if (!result.success) {
    throw result.error;
  }
}

export const RefineWorkflowLessonProposalInputSchema = z
  .object({
    prior_proposal: WorkflowLessonProposalSchema,
    scope: WorkflowLessonScopeSchema,
    base_durable_revision: z.number().int().min(0),
    lesson: WorkflowLessonTargetSchema,
    additional_evidence: z.array(WorkflowLessonEvidenceSchema).max(30),
  })
  .strict();
export type RefineWorkflowLessonProposalInput = z.infer<
  typeof RefineWorkflowLessonProposalInputSchema
>;

/** Refine a proposal without changing its authority or durable base revision. */
export function refineWorkflowLessonProposal(input: unknown): WorkflowLessonProposal {
  const parsed = RefineWorkflowLessonProposalInputSchema.parse(input);
  if (!sameScope(parsed.scope, parsed.prior_proposal.scope)) {
    throw new Error("refinement scope must match the prior proposal");
  }
  if (parsed.base_durable_revision !== parsed.prior_proposal.base_durable_revision) {
    throw new Error("refinement cannot change the base durable revision");
  }
  if (
    parsed.additional_evidence.length === 0 &&
    sameTarget(parsed.lesson, parsed.prior_proposal.lesson)
  ) {
    throw new Error("refinement must add evidence or change the safe lesson target");
  }
  if (
    parsed.additional_evidence.some(
      (evidence) => !sameScope(evidence.scope, parsed.scope),
    )
  ) {
    throw new Error("additional evidence must match the proposal scope");
  }

  const combinedEvidence = [
    ...parsed.prior_proposal.evidence,
    ...parsed.additional_evidence,
  ];
  if (combinedEvidence.length > 32) {
    throw new Error("refined proposals may contain at most 32 evidence references");
  }
  if (
    new Set(combinedEvidence.map(({ evidence_id }) => evidence_id)).size !==
    combinedEvidence.length
  ) {
    throw new Error("refinement evidence ids must be unique");
  }
  if (
    !sameTarget(parsed.lesson, parsed.prior_proposal.lesson) &&
    !parsed.additional_evidence.some(
      (evidence) =>
        evidence.kind === "user_feedback" &&
        sameTarget(evidence.preference, parsed.lesson),
    )
  ) {
    throw new Error("a changed lesson requires new explicit supporting user feedback");
  }

  validateEvidenceSetOrThrow(parsed.scope, parsed.lesson, combinedEvidence);
  return buildProposal({
    schema_version: WORKFLOW_LESSON_PROPOSAL_SCHEMA_VERSION,
    scope: parsed.scope,
    base_durable_revision: parsed.base_durable_revision,
    lesson: parsed.lesson,
    evidence: combinedEvidence,
    supersedes_proposal_id: parsed.prior_proposal.proposal_id,
  });
}

export const WorkflowLessonReviewArtifactSchema = z
  .object({
    schema_version: z.literal(WORKFLOW_LESSON_REVIEW_SCHEMA_VERSION),
    review_id: ReviewIdSchema,
    proposal_id: ProposalIdSchema,
    scope: WorkflowLessonScopeSchema,
    reviewer_kind: z.literal("user"),
    decision: z.enum(["approve", "reject"]),
    status: z.enum(["approved_for_persistence", "rejected"]),
    reviewed_at: z.string().datetime({ offset: true }),
    base_durable_revision: z.number().int().min(0),
    lesson: WorkflowLessonTargetSchema,
    evidence_digest: Sha256Schema,
    persistence: z.literal("not_written"),
  })
  .strict()
  .superRefine((review, context) => {
    const expected =
      review.decision === "approve" ? "approved_for_persistence" : "rejected";
    if (review.status !== expected) {
      addIssue(context, ["status"], "review status must match the explicit decision");
    }
    const expectedId = `lesson_review_${digest({
      proposal_id: review.proposal_id,
      scope: review.scope,
      reviewer_kind: review.reviewer_kind,
      decision: review.decision,
      reviewed_at: review.reviewed_at,
      base_durable_revision: review.base_durable_revision,
      lesson: review.lesson,
      evidence_digest: review.evidence_digest,
    }).slice(0, 24)}`;
    if (review.review_id !== expectedId) {
      addIssue(context, ["review_id"], "review id does not match review content");
    }
  });
export type WorkflowLessonReviewArtifact = z.infer<
  typeof WorkflowLessonReviewArtifactSchema
>;

export const ReviewWorkflowLessonProposalInputSchema = z
  .object({
    proposal: WorkflowLessonProposalSchema,
    proposal_id: ProposalIdSchema,
    scope: WorkflowLessonScopeSchema,
    reviewer_kind: z.literal("user"),
    decision: z.enum(["approve", "reject"]),
    reviewed_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ReviewWorkflowLessonProposalInput = z.infer<
  typeof ReviewWorkflowLessonProposalInputSchema
>;

/** Return a user review artifact only. Approval still does not persist a lesson. */
export function reviewWorkflowLessonProposal(
  input: unknown,
): WorkflowLessonReviewArtifact {
  const parsed = ReviewWorkflowLessonProposalInputSchema.parse(input);
  if (parsed.proposal_id !== parsed.proposal.proposal_id) {
    throw new Error("review proposal id must match the exact proposal");
  }
  if (!sameScope(parsed.scope, parsed.proposal.scope)) {
    throw new Error("review scope must match the exact proposal scope");
  }

  const identity = {
    proposal_id: parsed.proposal_id,
    scope: parsed.scope,
    reviewer_kind: parsed.reviewer_kind,
    decision: parsed.decision,
    reviewed_at: parsed.reviewed_at,
    base_durable_revision: parsed.proposal.base_durable_revision,
    lesson: parsed.proposal.lesson,
    evidence_digest: parsed.proposal.evidence_digest,
  };
  const artifact = {
    schema_version: WORKFLOW_LESSON_REVIEW_SCHEMA_VERSION,
    review_id: `lesson_review_${digest(identity).slice(0, 24)}`,
    ...identity,
    status:
      parsed.decision === "approve"
        ? ("approved_for_persistence" as const)
        : ("rejected" as const),
    persistence: "not_written" as const,
  };
  return deepFreeze(WorkflowLessonReviewArtifactSchema.parse(artifact));
}
