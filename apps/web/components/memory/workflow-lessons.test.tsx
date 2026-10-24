import { describe, expect, it, vi } from "vitest";

import {
  requestWorkflowLessons,
  WORKFLOW_LESSON_OPTIONS,
  WorkflowLessonConflictError,
  WorkflowLessonMutationGuard,
  WorkflowLessonRequestCache,
  WorkflowLessonsDisabledError,
  type WorkflowLessonPublicRecord,
} from "./workflow-lessons";

const record: WorkflowLessonPublicRecord = {
  id: "lesson-record-1",
  proposalId: "lesson_0123456789abcdef01234567",
  target: { category: "response_detail", value: "concise" },
  evidenceCount: 2,
  status: "proposed",
  version: 1,
};

describe("workflow lesson client", () => {
  it("uses the dedicated authenticated lesson endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: true,
      data: { revision: 1, records: [record] },
    }));
    await expect(requestWorkflowLessons({ action: "list" }, fetcher)).resolves.toEqual({
      revision: 1,
      records: [record],
    });
    expect(fetcher).toHaveBeenCalledWith("/api/vault/lessons", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
  });

  it("distinguishes disabled, conflict, and malformed confirmations", async () => {
    const disabled = vi.fn(async () => Response.json({
      error: { code: "WORKFLOW_LESSONS_DISABLED", message: "disabled" },
    }, { status: 404 }));
    await expect(requestWorkflowLessons({ action: "list" }, disabled))
      .rejects.toBeInstanceOf(WorkflowLessonsDisabledError);

    const conflict = vi.fn(async () => Response.json({
      error: { message: "Workflow lesson revision conflict" },
    }, { status: 409 }));
    await expect(requestWorkflowLessons({ action: "list" }, conflict))
      .rejects.toBeInstanceOf(WorkflowLessonConflictError);

    const malformed = vi.fn(async () => Response.json({ data: { revision: "1", records: {} } }));
    await expect(requestWorkflowLessons({ action: "list" }, malformed))
      .rejects.toThrow(/invalid workflow lesson confirmation/i);
  });

  it("reuses an idempotency key for a retry and blocks concurrent mutations", () => {
    const cache = new WorkflowLessonRequestCache();
    const first = cache.mutation(record, 1, "accept");
    const replay = cache.mutation(record, 1, "accept");
    expect(replay).toBe(first);

    const guard = new WorkflowLessonMutationGuard();
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    guard.end();
    expect(guard.begin()).toBe(true);
  });

  it("offers only fixed non-authorizing presentation targets", () => {
    expect(WORKFLOW_LESSON_OPTIONS).toEqual({
      response_detail: ["concise", "balanced", "detailed"],
      evidence_layout: ["summary_first", "sources_first", "comparison_table"],
      approval_explanation: ["plain_language", "technical_detail", "step_by_step"],
      comparison_emphasis: ["best_price_first", "risk_caveats_first", "balanced"],
      research_risk_posture: ["capital_preservation_first", "balanced", "opportunity_first"],
    });
    expect(JSON.stringify(WORKFLOW_LESSON_OPTIONS)).not.toMatch(/execute|sign|amount|slippage|profit|route/i);
  });
});
