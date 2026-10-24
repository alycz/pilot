import { createHash } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";

import { createWorkflowLessonProposal } from "../../packages/agent/src/workflow-lessons";
import {
  createVaultFromEnv,
  type StructuredPreferenceScope,
  type WorkflowLessonProposalInput,
} from "../../packages/vault/src";

export const PERSONALIZATION_FIXTURE_OWNER =
  "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59" as const;
export const PERSONALIZATION_FIXTURE_TENANT = "playwright-personalization" as const;
export const PERSONALIZATION_FIXTURE_VAULT_PATH = path.join(
  "/tmp",
  "pilot-playwright-fixture-vault",
);
export const PERSONALIZATION_FIXTURE_STATE_PATH = path.join(
  "/tmp",
  "pilot-playwright-personalization-state",
);

export const INITIAL_PREFERENCE = "Prefer concise factual summaries" as const;
export const CORRECTED_PREFERENCE = "Prefer factual comparison tables" as const;

const scope: StructuredPreferenceScope = {
  tenantId: PERSONALIZATION_FIXTURE_TENANT,
  owner: PERSONALIZATION_FIXTURE_OWNER,
  network: "testnet",
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function workflowScope() {
  return {
    tenant_id: `tenant_${digest(`tenant\0${PERSONALIZATION_FIXTURE_TENANT}`).slice(0, 32)}`,
    principal_id: `owner_${digest(`owner\0${PERSONALIZATION_FIXTURE_OWNER}`).slice(0, 32)}`,
    profile_id: `profile_${digest(`profile\0testnet\0${PERSONALIZATION_FIXTURE_OWNER}`).slice(0, 32)}`,
  };
}

export async function establishPersonalizationFixtureSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const response = await fetch("/api/dev/personalization-session", {
      method: "POST",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(payload.error?.message || `Fixture session failed with ${response.status}`);
    }
  });
}

/**
 * Establishes the fixture identity and clears active personalization through
 * the same authenticated CAS routes used by the UI. Deleting the backing
 * directory from the Playwright process can unlink the server's live lock and
 * let an aborted retry write into the next attempt.
 */
export async function resetPersonalizationFixtureStorage(page: Page): Promise<void> {
  await establishPersonalizationFixtureSession(page);
  await page.evaluate(async () => {
    type RecordView = {
      id: string;
      status: "proposed" | "accepted" | "rejected" | "superseded" | "forgotten";
      version: number;
    };
    type Snapshot = { revision: number; records: RecordView[] };
    type Payload = { data?: Snapshot; error?: { message?: string } };

    const post = async (endpoint: string, body?: object): Promise<{ status: number; payload: Payload }> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await response.json().catch(() => ({})) as Payload;
      if (!response.ok && response.status !== 409) {
        throw new Error(payload.error?.message || `Fixture request failed with ${response.status}`);
      }
      return { status: response.status, payload };
    };

    const clear = async (endpoint: string, resource: "preference" | "lesson") => {
      // Conflicts mean an aborted prior attempt completed between list and
      // mutation. Re-listing makes that completion part of this cleanup.
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const listed = await post(endpoint, { action: "list" });
        const snapshot = listed.payload.data;
        if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.records)) {
          throw new Error(`Fixture ${resource} list response was invalid`);
        }
        const active = snapshot.records.find((record) =>
          record.status === "proposed" || record.status === "accepted"
        );
        if (!active) return;

        // Preferences can be forgotten directly. A workflow proposal must be
        // accepted before its category can be forgotten without leaving a
        // rejected fixed fixture id that the next seed cannot reuse.
        const action = resource === "lesson" && active.status === "proposed"
          ? "accept"
          : "forget";
        const mutation = await post(endpoint, {
          action,
          recordId: active.id,
          expectedRevision: snapshot.revision,
          expectedVersion: active.version,
          idempotencyKey: `fixture-reset-${resource}-${action}-${crypto.randomUUID()}`,
        });
        if (mutation.status === 409) continue;
      }
      throw new Error(`Fixture ${resource} cleanup did not quiesce`);
    };

    await clear("/api/vault/preferences/structured", "preference");
    await clear("/api/vault/lessons", "lesson");
  });
}

export async function seedPersonalizationFixtureProposals(): Promise<void> {
  const vault = createVaultFromEnv({
    VAULT_BACKEND: "fs",
    VAULT_PATH: PERSONALIZATION_FIXTURE_VAULT_PATH,
    PILOT_STRUCTURED_PREFERENCES: "1",
    PILOT_PERSONALIZATION_STATE_DIR: PERSONALIZATION_FIXTURE_STATE_PATH,
  });
  const observedAt = "2026-10-21T01:00:00.000Z";
  const preference = await vault.readStructuredPreferences(scope);
  await vault.proposeStructuredPreference(scope, {
    id: "fixture-preference-concise",
    category: "presentation",
    key: "response_format",
    value: INITIAL_PREFERENCE,
    origin: "explicit",
    evidence: { messageIds: ["fixture-message-preference"], observedAt },
    confidence: 1,
  }, preference.revision, "fixture-propose-preference", new Date(observedAt));

  const lessonSnapshot = await vault.readWorkflowLessons(scope);
  const proposal = createWorkflowLessonProposal({
    scope: workflowScope(),
    base_durable_revision: lessonSnapshot.revision,
    lesson: {
      category: "research_risk_posture",
      value: "capital_preservation_first",
    },
    evidence: [{
      schema_version: "pilot.workflow-lesson-evidence.v1",
      evidence_id: "feedback_fixture_research",
      scope: workflowScope(),
      observed_at: observedAt,
      source_ref: digest("fixture-research-feedback"),
      kind: "user_feedback",
      feedback_kind: "explicit_preference",
      preference: {
        category: "research_risk_posture",
        value: "capital_preservation_first",
      },
    }],
  });
  const feedback = proposal.evidence.find((item) => item.kind === "user_feedback");
  if (!feedback || feedback.kind !== "user_feedback") {
    throw new Error("Fixture workflow lesson feedback was not created");
  }
  const stored: WorkflowLessonProposalInput = {
    id: "fixture-lesson-research",
    proposalId: proposal.proposal_id,
    workflowScope: proposal.scope,
    baseDurableRevision: proposal.base_durable_revision,
    target: proposal.lesson,
    evidenceDigest: proposal.evidence_digest,
    evidence: [{
      kind: "user_feedback" as const,
      evidenceId: feedback.evidence_id,
      sourceRef: feedback.source_ref,
      observedAt: feedback.observed_at,
      feedbackKind: "explicit_preference" as const,
      preference: feedback.preference,
    }],
    supersedesProposalId: proposal.supersedes_proposal_id,
  };
  await vault.proposeWorkflowLesson(
    scope,
    stored,
    lessonSnapshot.revision,
    "fixture-propose-lesson",
    new Date(observedAt),
  );
}
