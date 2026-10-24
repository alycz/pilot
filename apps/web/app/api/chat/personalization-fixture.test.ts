import type {
  StructuredPreferenceSnapshot,
  WorkflowLessonSnapshot,
} from "@pilot/vault";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/model-access", () => ({
  getModelAccess: () => {
    throw new Error("Fixture chat must not load model access");
  },
}));

import {
  PERSONALIZATION_FIXTURE_COOKIE,
  PERSONALIZATION_FIXTURE_OWNER,
  sealPersonalizationFixtureSession,
} from "../../../lib/personalization-fixture-session";
import { maybeHandlePersonalizationFixtureChat } from "./personalization-fixture";

const SECRET = "fixture-personalization-session-secret-long-enough";
const environment = {
  NODE_ENV: "test",
  EXEC_NETWORK: "testnet",
  HARBOR_MOCK: "1",
  PILOT_STRUCTURED_PREFERENCES: "1",
  PILOT_PERSONALIZATION_FIXTURE: "1",
  PILOT_PERSONALIZATION_TENANT_ID: "fixture-browser-test",
  PILOT_PERSONALIZATION_STATE_DIR: "/tmp/pilot-fixture-chat-test-state",
  SESSION_SECRET: SECRET,
} as const;

const preferences: StructuredPreferenceSnapshot = {
  schemaVersion: 1,
  revision: 2,
  records: [{
    schemaVersion: 1,
    id: "preference-accepted",
    scope: {
      tenantId: environment.PILOT_PERSONALIZATION_TENANT_ID,
      owner: PERSONALIZATION_FIXTURE_OWNER,
      network: "testnet",
    },
    category: "presentation",
    key: "response_format",
    value: "Prefer concise factual summaries",
    origin: "explicit",
    evidence: {
      messageIds: ["message-fixture-1"],
      observedAt: "2026-10-21T00:00:00.000Z",
    },
    confidence: 1,
    version: 2,
    status: "accepted",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:01:00.000Z",
  }],
  tombstones: [],
  operations: [],
};

const lessons: WorkflowLessonSnapshot = {
  schemaVersion: 1,
  revision: 2,
  records: [{
    schemaVersion: 1,
    id: "lesson-record-fixture",
    proposalId: "lesson_1234567890abcdef12345678",
    workflowScope: {
      tenant_id: "tenant_fixture",
      principal_id: "owner_fixture",
      profile_id: "profile_fixture",
    },
    baseDurableRevision: 0,
    scope: {
      tenantId: environment.PILOT_PERSONALIZATION_TENANT_ID,
      owner: PERSONALIZATION_FIXTURE_OWNER,
      network: "testnet",
    },
    target: {
      category: "research_risk_posture",
      value: "capital_preservation_first",
    },
    evidenceDigest: "a".repeat(64),
    evidence: [{
      kind: "user_feedback",
      evidenceId: "feedback-fixture",
      sourceRef: "b".repeat(64),
      observedAt: "2026-10-21T00:00:00.000Z",
      feedbackKind: "explicit_preference",
      preference: {
        category: "research_risk_posture",
        value: "capital_preservation_first",
      },
    }],
    supersedesProposalId: null,
    version: 2,
    status: "accepted",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:01:00.000Z",
  }],
  tombstones: [],
  operations: [],
};

function request(
  body: Record<string, unknown> = {
    messages: [{ role: "user", content: "How should you tailor the next comparison?" }],
  },
  overrides: Record<string, string> = {},
): Request {
  const sealed = sealPersonalizationFixtureSession(
    { owner: PERSONALIZATION_FIXTURE_OWNER, network: "testnet" },
    { environment },
  );
  return new Request("http://127.0.0.1:3004/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${PERSONALIZATION_FIXTURE_COOKIE}=${encodeURIComponent(sealed.token)}`,
      host: "127.0.0.1:3004",
      origin: "http://127.0.0.1:3004",
      "sec-fetch-site": "same-origin",
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

function vault() {
  return {
    readStructuredPreferences: vi.fn(async () => preferences),
    readWorkflowLessons: vi.fn(async () => lessons),
  };
}

describe("personalization fixture chat", () => {
  it("retrieves reviewed context through a deterministic read-only stream", async () => {
    const fixtureVault = vault();
    const response = await maybeHandlePersonalizationFixtureChat(request(), {
      environment,
      vault: fixtureVault,
    });
    expect(response?.status).toBe(200);
    const body = await response!.text();
    expect(body).toContain("transaction tools are disabled");
    expect(body).toContain("Prefer concise factual summaries");
    expect(body).toContain("capital_preservation_first");
    expect(fixtureVault.readStructuredPreferences).toHaveBeenCalledOnce();
    expect(fixtureVault.readWorkflowLessons).toHaveBeenCalledOnce();
  });

  it("does not treat disabled, missing-cookie, or cross-origin requests as fixture authority", async () => {
    const noCookie = request();
    noCookie.headers.delete("cookie");
    await expect(maybeHandlePersonalizationFixtureChat(noCookie, {
      environment,
      vault: vault(),
    })).resolves.toBeUndefined();
    await expect(maybeHandlePersonalizationFixtureChat(request(undefined, {
      origin: "http://localhost:3004",
    }), { environment, vault: vault() })).resolves.toBeUndefined();
    await expect(maybeHandlePersonalizationFixtureChat(request(), {
      environment: { ...environment, PILOT_PERSONALIZATION_FIXTURE: "0" },
      vault: vault(),
    })).resolves.toBeUndefined();
  });

  it("rejects operation fields before reading private state", async () => {
    const fixtureVault = vault();
    const response = await maybeHandlePersonalizationFixtureChat(request({
      messages: [{ role: "user", content: "Run a swap" }],
      operation: "x402_compare",
      operation_id: "operation-fixture-1",
    }), { environment, vault: fixtureVault });
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "Fixture chat is read-only and accepts messages only.",
    });
    expect(fixtureVault.readStructuredPreferences).not.toHaveBeenCalled();
    expect(fixtureVault.readWorkflowLessons).not.toHaveBeenCalled();
  });

  it("honors an explicit one-response personalization opt-out", async () => {
    const response = await maybeHandlePersonalizationFixtureChat(request({
      messages: [{ role: "user", content: "Do not use personalization for this answer." }],
    }), { environment, vault: vault() });
    const body = await response!.text();
    expect(body).toContain("No accepted structured preferences are active.");
    expect(body).toContain("No accepted workflow lessons are active.");
    expect(body).not.toContain("Prefer concise factual summaries");
    expect(body).not.toContain("capital_preservation_first");
  });
});
