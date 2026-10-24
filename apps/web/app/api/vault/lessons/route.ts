import { createHash } from "node:crypto";

import {
  refineWorkflowLessonProposal,
  reviewWorkflowLessonProposal,
  WorkflowLessonProposalSchema,
  WorkflowLessonTargetSchema,
  type WorkflowLessonProposal,
  type WorkflowLessonScope,
  type WorkflowLessonTarget,
} from "@pilot/agent/workflow-lessons";
import type {
  StructuredPreferenceScope,
  WorkflowLessonCommand,
  WorkflowLessonEvidenceReference,
  WorkflowLessonMutationBinding,
  WorkflowLessonProposalInput,
  WorkflowLessonRecord,
  WorkflowLessonSnapshot,
} from "@pilot/vault";
import { resolveStructuredPreferenceTenant } from "../../../../lib/structured-preferences";
import { deriveWorkflowLessonScope } from "../../../../lib/workflow-lessons";

import {
  assertPreferenceAcceptanceAuthorized,
  errorResponse,
  json,
  objectBody,
  requiredString,
} from "../_lib/http";
import { getVaultService } from "../_lib/service";

export const runtime = "nodejs";

const CLIENT_SCOPE_FIELDS = [
  "tenantId",
  "tenant_id",
  "owner",
  "network",
  "scope",
  "review",
  "reviewArtifact",
  "approved_for_persistence",
  "proposal",
  "evidence",
  "review_id",
  "verifier",
  "source_ref",
  "transactionHash",
  "transaction_hash",
  "path",
] as const;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameWorkflowScope(left: WorkflowLessonScope, right: WorkflowLessonScope): boolean {
  return left.tenant_id === right.tenant_id &&
    left.principal_id === right.principal_id &&
    left.profile_id === right.profile_id;
}

function integer(body: Record<string, unknown>, key: string, minimum: number): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${key} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function boundedString(body: Record<string, unknown>, key: string, maximum: number): string {
  const value = requiredString(body, key).trim();
  if (value.length > maximum) throw new Error(`${key} must not exceed ${maximum} characters`);
  return value;
}

function rejectClientScope(body: Record<string, unknown>): void {
  if (CLIENT_SCOPE_FIELDS.some((field) => Object.hasOwn(body, field))) {
    throw new Error("Workflow lesson scope and review authority are server-derived");
  }
}

function assertExactBody(body: Record<string, unknown>, action: string): void {
  const mutation = [
    "action",
    "recordId",
    "expectedRevision",
    "expectedVersion",
    "idempotencyKey",
  ];
  const allowed = new Set(
    action === "list" ? ["action"] : action === "correct" ? [...mutation, "lesson"] : mutation,
  );
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new Error("Workflow lesson request contains unsupported fields");
  }
}

function publicSnapshot(snapshot: WorkflowLessonSnapshot) {
  return {
    revision: snapshot.revision,
    records: snapshot.records.map(publicRecord),
  };
}

function publicRecord(record: WorkflowLessonRecord) {
  return {
    id: record.id,
    proposalId: record.proposalId,
    target: record.target,
    evidenceCount: record.evidence.length,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function publicResult(result: {
  snapshot: WorkflowLessonSnapshot;
  record?: WorkflowLessonRecord;
  idempotent: boolean;
}) {
  return {
    ...publicSnapshot(result.snapshot),
    ...(result.record ? { record: publicRecord(result.record) } : {}),
    idempotent: result.idempotent,
  };
}

function requiredRecord(snapshot: WorkflowLessonSnapshot, recordId: string): WorkflowLessonRecord {
  const record = snapshot.records.find((candidate) => candidate.id === recordId);
  if (!record) throw new Error("Workflow lesson record was not found");
  return record;
}

function proposalFromRecord(
  scope: StructuredPreferenceScope,
  record: WorkflowLessonRecord,
): WorkflowLessonProposal {
  const proposal = WorkflowLessonProposalSchema.parse({
    schema_version: "pilot.workflow-lesson-proposal.v1",
    proposal_id: record.proposalId,
    scope: record.workflowScope,
    base_durable_revision: record.baseDurableRevision,
    lesson: record.target,
    evidence: record.evidence.map((item) => item.kind === "user_feedback"
      ? {
          schema_version: "pilot.workflow-lesson-evidence.v1",
          evidence_id: item.evidenceId,
          scope: record.workflowScope,
          observed_at: item.observedAt,
          source_ref: item.sourceRef,
          kind: item.kind,
          feedback_kind: item.feedbackKind,
          preference: item.preference,
        }
      : {
          schema_version: "pilot.workflow-lesson-evidence.v1",
          evidence_id: item.evidenceId,
          scope: record.workflowScope,
          observed_at: item.observedAt,
          source_ref: item.sourceRef,
          kind: item.kind,
          experience_kind: item.experienceKind,
          verifier: item.verifier,
        }),
    evidence_digest: record.evidenceDigest,
    supersedes_proposal_id: record.supersedesProposalId,
    status: "pending_user_review",
    persistence: "not_written",
  });
  if (!sameWorkflowScope(proposal.scope, deriveWorkflowLessonScope(scope))) {
    throw new Error("Workflow lesson proposal scope does not match the authenticated wallet");
  }
  return proposal;
}

async function revalidateProposal(
  service: ReturnType<typeof getVaultService>,
  scope: StructuredPreferenceScope,
  record: WorkflowLessonRecord,
): Promise<WorkflowLessonProposal> {
  const proposal = proposalFromRecord(scope, record);
  const verified = proposal.evidence.filter((item) => item.kind === "verified_experience");
  if (verified.length === 0 && proposal.lesson.category !== "research_risk_posture") {
    throw new Error("Workflow lesson has no verified experience evidence");
  }
  for (const evidence of verified) {
    await service.verifyScopedValidatedTradeEvidence(scope, evidence.source_ref);
  }
  return proposal;
}

function storedProposalInput(id: string, proposal: WorkflowLessonProposal): WorkflowLessonProposalInput {
  if (!proposal.evidence.some((item) => item.kind === "user_feedback") ||
      (proposal.lesson.category !== "research_risk_posture" &&
       !proposal.evidence.some((item) => item.kind === "verified_experience"))) {
    throw new Error("Workflow lesson correction lacks the required evidence");
  }
  const evidence: WorkflowLessonEvidenceReference[] = proposal.evidence.map((item) => {
    if (item.kind === "user_feedback") {
      return {
        kind: item.kind,
        evidenceId: item.evidence_id,
        sourceRef: item.source_ref,
        observedAt: item.observed_at,
        feedbackKind: item.feedback_kind,
        preference: item.preference,
      };
    }
    if (item.experience_kind !== "validated_outcome_reviewed" ||
        item.verifier !== "pilot_validated_event") {
      throw new Error("Workflow lesson correction contains unsupported experience evidence");
    }
    return {
      kind: item.kind,
      evidenceId: item.evidence_id,
      sourceRef: item.source_ref,
      observedAt: item.observed_at,
      experienceKind: item.experience_kind,
      verifier: item.verifier,
    };
  });
  return {
    id,
    proposalId: proposal.proposal_id,
    workflowScope: proposal.scope,
    baseDurableRevision: proposal.base_durable_revision,
    target: proposal.lesson,
    evidenceDigest: proposal.evidence_digest,
    evidence,
    supersedesProposalId: proposal.supersedes_proposal_id,
  };
}

function correctionProposal(
  prior: WorkflowLessonProposal,
  lesson: WorkflowLessonTarget,
  idempotencyKey: string,
  now: Date,
): WorkflowLessonProposal {
  const identity = hash(`${prior.proposal_id}\0${idempotencyKey}\0${JSON.stringify(lesson)}`);
  return refineWorkflowLessonProposal({
    prior_proposal: prior,
    scope: prior.scope,
    base_durable_revision: prior.base_durable_revision,
    lesson,
    additional_evidence: [
      {
        schema_version: "pilot.workflow-lesson-evidence.v1",
        evidence_id: `feedback_${identity.slice(0, 24)}`,
        scope: prior.scope,
        observed_at: now.toISOString(),
        source_ref: identity,
        kind: "user_feedback",
        feedback_kind: "correction",
        preference: lesson,
      },
    ],
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const walletScope = assertPreferenceAcceptanceAuthorized(request);
    if (!walletScope) throw new Error("Workflow lessons require a wallet-bound browser session");
    const body = await objectBody(request);
    rejectClientScope(body);
    const tenantId = resolveStructuredPreferenceTenant();
    if (!tenantId) {
      return json({
        ok: false,
        error: { code: "WORKFLOW_LESSONS_DISABLED", message: "Workflow lessons are disabled" },
      }, 404);
    }
    const scope: StructuredPreferenceScope = { tenantId, ...walletScope };
    const action = requiredString(body, "action");
    assertExactBody(body, action);
    const service = getVaultService();
    if (action === "list") {
      return json({ ok: true, data: publicSnapshot(await service.readWorkflowLessons(scope)) });
    }
    if (action !== "accept" && action !== "reject" && action !== "correct" && action !== "forget") {
      throw new Error("Unsupported workflow lesson action");
    }

    const recordId = boundedString(body, "recordId", 128);
    const expectedRevision = integer(body, "expectedRevision", 0);
    const expectedVersion = integer(body, "expectedVersion", 1);
    const idempotencyKey = boundedString(body, "idempotencyKey", 128);
    const correctionTarget = action === "correct"
      ? WorkflowLessonTargetSchema.parse(body.lesson)
      : undefined;
    const replayBinding: WorkflowLessonMutationBinding = action === "correct"
      ? {
          action,
          recordId,
          expectedRevision,
          expectedVersion,
          idempotencyKey,
          target: correctionTarget!,
        }
      : { action, recordId, expectedRevision, expectedVersion, idempotencyKey };
    const replay = await service.replayWorkflowLessonMutation(scope, replayBinding);
    if (replay) return json({ ok: true, data: publicResult(replay) });
    const snapshot = await service.readWorkflowLessons(scope);
    if (snapshot.revision !== expectedRevision) throw new Error("Workflow lesson revision conflict");
    const record = requiredRecord(snapshot, recordId);
    if (record.version !== expectedVersion) throw new Error("Workflow lesson version conflict");
    const now = new Date();
    const proposal = action === "forget"
      ? undefined
      : proposalFromRecord(scope, record);

    let command: WorkflowLessonCommand;
    if (action === "correct") {
      if (record.status !== "accepted") throw new Error("Only an accepted workflow lesson can be corrected");
      const lesson = correctionTarget!;
      if (lesson.category !== record.target.category) {
        throw new Error("Workflow lesson correction cannot change category");
      }
      if (lesson.value === record.target.value) {
        throw new Error("Workflow lesson correction must change the lesson value");
      }
      const verifiedProposal = await revalidateProposal(service, scope, record);
      const replacementProposal = correctionProposal(
        verifiedProposal,
        lesson,
        idempotencyKey,
        now,
      );
      // This artifact validates the exact server-held proposal. The authenticated
      // request remains the authority, and the artifact is deliberately not persisted.
      reviewWorkflowLessonProposal({
        proposal: replacementProposal,
        proposal_id: replacementProposal.proposal_id,
        scope: replacementProposal.scope,
        reviewer_kind: "user",
        decision: "approve",
        reviewed_at: now.toISOString(),
      });
      command = {
        action,
        recordId,
        expectedRevision,
        expectedVersion,
        idempotencyKey,
        replacement: storedProposalInput(
          `lesson_record_${hash(`${recordId}\0${idempotencyKey}`).slice(0, 24)}`,
          replacementProposal,
        ),
      };
    } else {
      if (action === "accept") {
        if (record.status !== "proposed") throw new Error("Only a proposed workflow lesson can be accepted");
        const verifiedProposal = await revalidateProposal(service, scope, record);
        reviewWorkflowLessonProposal({
          proposal: verifiedProposal,
          proposal_id: verifiedProposal.proposal_id,
          scope: verifiedProposal.scope,
          reviewer_kind: "user",
          decision: "approve",
          reviewed_at: now.toISOString(),
        });
      }
      if (action === "reject" && record.status !== "proposed") {
        throw new Error("Only a proposed workflow lesson can be rejected");
      }
      if (action === "reject" && proposal) {
        reviewWorkflowLessonProposal({
          proposal,
          proposal_id: proposal.proposal_id,
          scope: proposal.scope,
          reviewer_kind: "user",
          decision: "reject",
          reviewed_at: now.toISOString(),
        });
      }
      command = { action, recordId, expectedRevision, expectedVersion, idempotencyKey };
    }

    const result = await service.mutateWorkflowLesson(scope, command, now);
    return json({ ok: true, data: publicResult(result) });
  } catch (error) {
    return errorResponse(error);
  }
}
