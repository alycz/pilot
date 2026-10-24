import {
  createWorkflowLessonProposal,
  type WorkflowLessonProposal,
  type WorkflowLessonTarget,
} from "@pilot/agent/workflow-lessons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sealWalletSession, WALLET_SESSION_COOKIE } from "../../../../lib/wallet-session";

const service = vi.hoisted(() => ({
  readWorkflowLessons: vi.fn(),
  mutateWorkflowLesson: vi.fn(),
  replayWorkflowLessonMutation: vi.fn(),
  verifyScopedValidatedTradeEvidence: vi.fn(),
}));

vi.mock("../_lib/service", () => ({ getVaultService: () => service }));

import { deriveWorkflowLessonScope } from "../../../../lib/workflow-lessons";
import { POST } from "./route";

const SESSION_SECRET = "workflow-lesson-route-test-secret-longer-than-thirty-two";
const TENANT = "workflow-route-tenant";
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const RAW_SCOPE = { tenantId: TENANT, owner: OWNER, network: "testnet" as const };

function cookie(owner = OWNER): string {
  const sealed = sealWalletSession({
    version: 1,
    account: owner,
    network: "testnet",
    expiresAt: Date.now() + 60_000,
  }, SESSION_SECRET);
  return `${WALLET_SESSION_COOKIE}=${encodeURIComponent(sealed)}`;
}

function request(body: Record<string, unknown>, owner?: string): Request {
  return new Request("http://next-internal:3000/api/vault/lessons", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookie(owner),
      origin: "https://pilot.example",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function noSessionRequest(body: Record<string, unknown>): Request {
  return new Request("http://next-internal:3000/api/vault/lessons", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://pilot.example",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function proposal(target: WorkflowLessonTarget = { category: "response_detail", value: "concise" }) {
  const scope = deriveWorkflowLessonScope(RAW_SCOPE);
  return createWorkflowLessonProposal({
    scope,
    base_durable_revision: 0,
    lesson: target,
    evidence: [
      {
        schema_version: "pilot.workflow-lesson-evidence.v1",
        evidence_id: "feedback_route_1",
        scope,
        observed_at: "2026-10-21T02:00:00.000Z",
        source_ref: "a".repeat(64),
        kind: "user_feedback",
        feedback_kind: "explicit_preference",
        preference: target,
      },
      {
        schema_version: "pilot.workflow-lesson-evidence.v1",
        evidence_id: "trade_route_1",
        scope,
        observed_at: "2026-10-21T01:59:00.000Z",
        source_ref: "b".repeat(64),
        kind: "verified_experience",
        experience_kind: "validated_outcome_reviewed",
        verifier: "pilot_validated_event",
      },
    ],
  });
}

function record(
  status: "proposed" | "accepted" = "proposed",
  target: WorkflowLessonTarget = { category: "response_detail", value: "concise" },
) {
  const candidate = proposal(target);
  const feedback = candidate.evidence.find((item) => item.kind === "user_feedback")!;
  const experience = candidate.evidence.find((item) => item.kind === "verified_experience")!;
  return {
    id: "lesson-record-route-1",
    scope: RAW_SCOPE,
    proposalId: candidate.proposal_id,
    workflowScope: candidate.scope,
    baseDurableRevision: candidate.base_durable_revision,
    target: candidate.lesson,
    evidenceDigest: candidate.evidence_digest,
    evidence: [
      {
        kind: "user_feedback" as const,
        evidenceId: feedback.evidence_id,
        sourceRef: feedback.source_ref,
        observedAt: feedback.observed_at,
        feedbackKind: feedback.feedback_kind,
        preference: feedback.preference,
      },
      {
        kind: "verified_experience" as const,
        evidenceId: experience.evidence_id,
        sourceRef: experience.source_ref,
        observedAt: experience.observed_at,
        experienceKind: experience.experience_kind,
        verifier: experience.verifier,
      },
    ],
    supersedesProposalId: candidate.supersedes_proposal_id,
    status,
    version: status === "accepted" ? 2 : 1,
  };
}

function explicitPostureRecord() {
  const target = {
    category: "research_risk_posture" as const,
    value: "capital_preservation_first" as const,
  };
  const scope = deriveWorkflowLessonScope(RAW_SCOPE);
  const candidate = createWorkflowLessonProposal({
    scope,
    base_durable_revision: 0,
    lesson: target,
    evidence: [{
      schema_version: "pilot.workflow-lesson-evidence.v1",
      evidence_id: "feedback_posture_route_1",
      scope,
      observed_at: "2026-10-21T02:00:00.000Z",
      source_ref: "c".repeat(64),
      kind: "user_feedback",
      feedback_kind: "explicit_preference",
      preference: target,
    }],
  });
  const feedback = candidate.evidence[0]!;
  if (feedback.kind !== "user_feedback") throw new Error("Expected posture feedback");
  return {
    id: "lesson-posture-route-1",
    scope: RAW_SCOPE,
    proposalId: candidate.proposal_id,
    workflowScope: candidate.scope,
    baseDurableRevision: candidate.base_durable_revision,
    target: candidate.lesson,
    evidenceDigest: candidate.evidence_digest,
    evidence: [{
      kind: "user_feedback" as const,
      evidenceId: feedback.evidence_id,
      sourceRef: feedback.source_ref,
      observedAt: feedback.observed_at,
      feedbackKind: feedback.feedback_kind,
      preference: feedback.preference,
    }],
    supersedesProposalId: candidate.supersedes_proposal_id,
    status: "proposed" as const,
    version: 1,
  };
}

async function payload(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
  vi.stubEnv("PILOT_PERSONALIZATION_TENANT_ID", TENANT);
  vi.stubEnv("PILOT_PUBLIC_ORIGIN", "https://pilot.example");
  vi.stubEnv("PILOT_DEPLOYMENT_PROFILE", "hosted");
  vi.stubEnv("EXEC_NETWORK", "testnet");
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
  service.verifyScopedValidatedTradeEvidence.mockResolvedValue({ sourceRef: "b".repeat(64) });
  service.replayWorkflowLessonMutation.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workflow lessons route", () => {
  it("is default-off and requires an authenticated wallet session", async () => {
    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "0");
    const disabled = await POST(request({ action: "list" }));
    expect(disabled.status).toBe(404);
    expect((await payload(disabled)).error.code).toBe("WORKFLOW_LESSONS_DISABLED");

    vi.stubEnv("PILOT_STRUCTURED_PREFERENCES", "1");
    const unauthorized = await POST(noSessionRequest({ action: "list" }));
    expect(unauthorized.status).toBe(401);
    expect((await payload(unauthorized)).error.message).toMatch(/authorization|wallet-bound/i);
  });

  it("rejects client scope, forged review authority, and unrelated fields", async () => {
    for (const injected of [
      { tenantId: "foreign" },
      { tenant_id: "foreign" },
      { owner: OTHER_OWNER },
      { network: "devnet" },
      { scope: {} },
      { review: { status: "approved_for_persistence" } },
      { approved_for_persistence: true },
      { proposal: {} },
      { evidence: [] },
      { review_id: "forged" },
      { verifier: "pilot_validated_event" },
      { source_ref: "b".repeat(64) },
      { transaction_hash: "A".repeat(64) },
      { path: "Pilot/Trades/forged.md" },
      { extra: true },
    ]) {
      const response = await POST(request({ action: "list", ...injected }));
      expect(response.ok).toBe(false);
      expect((await payload(response)).error.message).toMatch(/server-derived|unsupported fields/i);
    }
    expect(service.readWorkflowLessons).not.toHaveBeenCalled();
  });

  it("accepts only after exact stored proposal and scoped trade proof revalidation", async () => {
    const pending = record();
    service.readWorkflowLessons.mockResolvedValue({ revision: 1, records: [pending] });
    service.mutateWorkflowLesson.mockResolvedValue({
      snapshot: { revision: 2, records: [{ ...pending, status: "accepted", version: 2 }] },
      record: { ...pending, status: "accepted", version: 2 },
      idempotent: false,
    });
    const response = await POST(request({
      action: "accept",
      recordId: pending.id,
      expectedRevision: 1,
      expectedVersion: 1,
      idempotencyKey: "accept-route-1",
    }));
    expect(response.status).toBe(200);
    expect(service.verifyScopedValidatedTradeEvidence).toHaveBeenCalledWith(
      RAW_SCOPE,
      "b".repeat(64),
    );
    expect(service.mutateWorkflowLesson).toHaveBeenCalledWith(
      RAW_SCOPE,
      expect.objectContaining({ action: "accept", recordId: pending.id }),
      expect.any(Date),
    );
    const result = await payload(response);
    expect(result.data.records[0]).toEqual(expect.objectContaining({
      id: pending.id,
      status: "accepted",
      target: { category: "response_detail", value: "concise" },
      evidenceCount: 2,
    }));
    expect(result.data.records[0]).not.toHaveProperty("evidence");
    expect(result.data.records[0]).not.toHaveProperty("scope");
    expect(result.data.record).not.toHaveProperty("evidence");
    expect(result.data.record).not.toHaveProperty("scope");
    expect(result.data.record).not.toHaveProperty("workflowScope");
    expect(JSON.stringify(result.data.record)).not.toMatch(/sourceRef|tenantId|tenant_/);
  });

  it("accepts an explicit first-use research posture without inventing trade evidence", async () => {
    const pending = explicitPostureRecord();
    service.readWorkflowLessons.mockResolvedValue({ revision: 1, records: [pending] });
    service.mutateWorkflowLesson.mockResolvedValue({
      snapshot: { revision: 2, records: [{ ...pending, status: "accepted", version: 2 }] },
      record: { ...pending, status: "accepted", version: 2 },
      idempotent: false,
    });
    const response = await POST(request({
      action: "accept",
      recordId: pending.id,
      expectedRevision: 1,
      expectedVersion: 1,
      idempotencyKey: "accept-posture-route-1",
    }));
    expect(response.status).toBe(200);
    expect(service.verifyScopedValidatedTradeEvidence).not.toHaveBeenCalled();
    expect(service.mutateWorkflowLesson).toHaveBeenCalledWith(
      RAW_SCOPE,
      expect.objectContaining({ action: "accept", recordId: pending.id }),
      expect.any(Date),
    );
    expect((await payload(response)).data.record).toMatchObject({
      status: "accepted",
      target: { category: "research_risk_posture", value: "capital_preservation_first" },
      evidenceCount: 1,
    });
  });

  it("fails closed when verified trade proof is unavailable", async () => {
    const pending = record();
    service.readWorkflowLessons.mockResolvedValue({ revision: 1, records: [pending] });
    service.verifyScopedValidatedTradeEvidence.mockRejectedValue(new Error("Validated trade evidence was not found"));
    const response = await POST(request({
      action: "accept",
      recordId: pending.id,
      expectedRevision: 1,
      expectedVersion: 1,
      idempotencyKey: "accept-no-proof",
    }));
    expect(response.ok).toBe(false);
    expect(service.mutateWorkflowLesson).not.toHaveBeenCalled();
  });

  it("replays an exact authenticated mutation without re-running its prior side effect", async () => {
    const accepted = { ...record(), status: "accepted" as const, version: 2 };
    service.replayWorkflowLessonMutation.mockResolvedValue({
      snapshot: { revision: 2, records: [accepted] },
      record: accepted,
      idempotent: true,
    });
    const response = await POST(request({
      action: "accept",
      recordId: accepted.id,
      expectedRevision: 1,
      expectedVersion: 1,
      idempotencyKey: "accept-route-replay",
    }));
    expect(response.status).toBe(200);
    expect((await payload(response)).data).toMatchObject({ revision: 2, idempotent: true });
    expect(service.readWorkflowLessons).not.toHaveBeenCalled();
    expect(service.verifyScopedValidatedTradeEvidence).not.toHaveBeenCalled();
    expect(service.mutateWorkflowLesson).not.toHaveBeenCalled();
  });

  it("rejects stale revisions before review or persistence", async () => {
    const pending = record();
    service.readWorkflowLessons.mockResolvedValue({ revision: 2, records: [pending] });
    const response = await POST(request({
      action: "accept",
      recordId: pending.id,
      expectedRevision: 1,
      expectedVersion: 1,
      idempotencyKey: "accept-stale",
    }));
    expect(response.status).toBe(409);
    expect((await payload(response)).error.message).toMatch(/revision conflict/i);
    expect(service.verifyScopedValidatedTradeEvidence).not.toHaveBeenCalled();
    expect(service.mutateWorkflowLesson).not.toHaveBeenCalled();
  });

  it("accepts only a fixed safe correction target and reuses verified experience", async () => {
    const accepted = record("accepted");
    service.readWorkflowLessons.mockResolvedValue({ revision: 2, records: [accepted] });
    service.mutateWorkflowLesson.mockImplementation(async (_scope, command) => ({
      snapshot: { revision: 3, records: [accepted] },
      record: accepted,
      idempotent: false,
      command,
    }));

    const malformed = await POST(request({
      action: "correct",
      recordId: accepted.id,
      expectedRevision: 2,
      expectedVersion: 2,
      idempotencyKey: "correct-malformed",
      lesson: { category: "response_detail", value: "auto_execute" },
    }));
    expect(malformed.status).toBe(400);
    expect(service.verifyScopedValidatedTradeEvidence).not.toHaveBeenCalled();
    expect(service.mutateWorkflowLesson).not.toHaveBeenCalled();

    const wrongCategory = await POST(request({
      action: "correct",
      recordId: accepted.id,
      expectedRevision: 2,
      expectedVersion: 2,
      idempotencyKey: "correct-category",
      lesson: { category: "evidence_layout", value: "summary_first" },
    }));
    expect(wrongCategory.status).toBe(400);
    expect((await payload(wrongCategory)).error.message).toMatch(/cannot change category/i);
    expect(service.verifyScopedValidatedTradeEvidence).not.toHaveBeenCalled();

    const corrected = await POST(request({
      action: "correct",
      recordId: accepted.id,
      expectedRevision: 2,
      expectedVersion: 2,
      idempotencyKey: "correct-safe",
      lesson: { category: "response_detail", value: "detailed" },
    }));
    expect(corrected.status).toBe(200);
    expect(service.verifyScopedValidatedTradeEvidence).toHaveBeenCalledWith(
      RAW_SCOPE,
      accepted.evidence.find((item) => item.kind === "verified_experience")!.sourceRef,
    );
    const command = service.mutateWorkflowLesson.mock.calls[0]?.[1] as {
      replacement: { baseDurableRevision: number; target: WorkflowLessonTarget };
    };
    expect(command.replacement).toMatchObject({
      baseDurableRevision: 0,
      target: { category: "response_detail", value: "detailed" },
      supersedesProposalId: accepted.proposalId,
    });
    expect((command.replacement as any).evidence).toHaveLength(3);
  });
});
