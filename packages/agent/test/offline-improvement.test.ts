import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  OfflineEvaluationArtifactsSchema,
  OfflineEvaluationFixtureSchema,
  PromotionManifestSchema,
  REQUIRED_OFFLINE_INVARIANTS,
  proposeOfflineProcedureCandidate,
  runOfflineProposalEvaluation,
  type OfflineEvaluationFixture,
  type ProcedureCandidate,
} from "../src/offline-improvement.js";

const scope = {
  tenant_id: "tenant-fixture",
  profile_id: "profile-fixture",
  dataset_id: "dataset-offline-v1",
} as const;

const steps = [
  { id: "scope", kind: "assert_scope" },
  { id: "policy", kind: "assert_policy_invariants" },
  { id: "normalize", kind: "normalize_fixture" },
  { id: "compare", kind: "compare_fixture_metrics" },
  { id: "report", kind: "prepare_review_report" },
  { id: "promotion", kind: "prepare_promotion_manifest" },
  { id: "rollback", kind: "prepare_rollback_manifest" },
] as const;

function procedure(
  version: string,
  basedOn: string | null,
  overrides: Record<string, unknown> = {},
): ProcedureCandidate {
  return proposeOfflineProcedureCandidate({
    schema_version: "pilot.offline-procedure-candidate.v1",
    candidate_id: `candidate-${version.replaceAll(".", "-")}`,
    procedure_id: "offline-procedure",
    version,
    based_on_version: basedOn,
    scope,
    objective: "improve_answer_quality",
    invariants: [...REQUIRED_OFFLINE_INVARIANTS],
    steps,
    ...overrides,
  });
}

function fixture(name: "synthetic" | "replay-redacted"): OfflineEvaluationFixture {
  const url = new URL(
    `../../../eval/offline-improvement/fixtures/${name}.json`,
    import.meta.url,
  );
  return OfflineEvaluationFixtureSchema.parse(
    JSON.parse(readFileSync(url, "utf8")),
  );
}

const evaluatedAt = "2026-10-21T00:00:00.000Z";

function validArtifacts() {
  return runOfflineProposalEvaluation({
    evaluated_at: evaluatedAt,
    baseline: procedure("1.0.0", null),
    candidate: procedure("1.1.0", "1.0.0"),
    fixtures: [fixture("synthetic")],
  });
}

describe("offline proposal improvement", () => {
  it("produces deterministic review-only promotion and rollback artifacts", () => {
    const baseline = procedure("1.0.0", null);
    const candidate = procedure("1.1.0", "1.0.0");
    const fixtures = [fixture("replay-redacted"), fixture("synthetic")];

    const first = runOfflineProposalEvaluation({
      evaluated_at: evaluatedAt,
      baseline,
      candidate,
      fixtures,
    });
    const second = runOfflineProposalEvaluation({
      evaluated_at: evaluatedAt,
      baseline: { ...baseline, invariants: [...baseline.invariants].reverse() },
      candidate: { ...candidate, invariants: [...candidate.invariants].reverse() },
      fixtures: [...fixtures].reverse(),
    });

    expect(first.report).toMatchObject({
      verdict: "eligible_for_human_review",
      reason_codes: [],
      fixture_ids: ["redacted-replay-001", "synthetic-read-001"],
      delta: {
        quality_bps: 600,
        evidence_coverage_bps: 650,
        evaluation_latency_ms: 8,
      },
    });
    expect(first.promotion).toMatchObject({
      candidate_eligible: true,
      status: "pending_human_review",
      requires_human_approval: true,
      automatic_promotion: false,
    });
    expect(first.rollback).toMatchObject({
      restore_version: "1.0.0",
      candidate_version: "1.1.0",
      status: "prepared_not_applied",
      activation: "human_only",
      automatic_rollback: false,
    });
    expect(second).toEqual(first);
  });

  it.each([
    ["unknown executable step", {
      steps: steps.map((step) => step.id === "compare"
        ? { ...step, kind: "shell.exec" }
        : step),
    }],
    ["missing invariant", {
      invariants: REQUIRED_OFFLINE_INVARIANTS.slice(0, -1),
    }],
    ["extra execution field", {
      command: "curl https://example.invalid",
    }],
    ["guards after comparison", {
      steps: [steps[2], steps[0], steps[1], ...steps.slice(3)],
    }],
  ])("rejects malicious or unsafe procedure shape: %s", (_label, patch) => {
    expect(() => procedure("1.1.0", "1.0.0", patch)).toThrow();
  });

  it("rejects cross-scope candidates and fixtures", () => {
    const baseline = procedure("1.0.0", null);
    const crossScopeCandidate = procedure("1.1.0", "1.0.0", {
      scope: { ...scope, tenant_id: "another-tenant" },
    });
    expect(() => runOfflineProposalEvaluation({
      evaluated_at: evaluatedAt,
      baseline,
      candidate: crossScopeCandidate,
      fixtures: [fixture("synthetic")],
    })).toThrow("candidate scope");

    const candidate = procedure("1.1.0", "1.0.0");
    const crossScopeFixture = {
      ...fixture("synthetic"),
      scope: { ...scope, profile_id: "another-profile" },
    };
    expect(() => runOfflineProposalEvaluation({
      evaluated_at: evaluatedAt,
      baseline,
      candidate,
      fixtures: [crossScopeFixture],
    })).toThrow("fixture scope");
  });

  it("rejects non-redacted, identifying, or order-bearing replay fixtures", () => {
    const replay = fixture("replay-redacted");
    for (const patch of [
      { redacted: false },
      { contains_user_identifiers: true },
      { contains_real_order_data: true },
    ]) {
      expect(OfflineEvaluationFixtureSchema.safeParse({
        ...replay,
        source: { ...replay.source, ...patch },
      }).success).toBe(false);
    }
  });

  it("rejects nondeterministic observations and invalid metrics", () => {
    const valid = fixture("synthetic");
    expect(OfflineEvaluationFixtureSchema.safeParse({
      ...valid,
      candidate: {
        ...valid.candidate,
        repeat_output_hash: "e".repeat(64),
      },
    }).success).toBe(false);
    expect(OfflineEvaluationFixtureSchema.safeParse({
      ...valid,
      candidate: {
        ...valid.candidate,
        metrics: { ...valid.candidate.metrics, quality_bps: 10_001 },
      },
    }).success).toBe(false);
  });

  it.each([
    ["policy violation", "policy_violations", "candidate_has_policy_violations"],
    ["scope violation", "scope_violations", "candidate_has_scope_violations"],
    ["side effect", "side_effects", "candidate_has_side_effects"],
  ] as const)("rejects a candidate with a measured %s", (_label, field, reason) => {
    const baseline = procedure("1.0.0", null);
    const candidate = procedure("1.1.0", "1.0.0");
    const valid = fixture("synthetic");
    const unsafe = {
      ...valid,
      candidate: { ...valid.candidate, [field]: ["fixture violation"] },
    };
    const artifacts = runOfflineProposalEvaluation({
      evaluated_at: evaluatedAt,
      baseline,
      candidate,
      fixtures: [unsafe],
    });

    expect(artifacts.report.verdict).toBe("rejected");
    expect(artifacts.report.reason_codes).toContain(reason);
    expect(artifacts.promotion).toMatchObject({
      candidate_eligible: false,
      status: "pending_human_review",
      automatic_promotion: false,
    });
  });

  it("rejects metric regression and candidates without measurable gain", () => {
    const baseline = procedure("1.0.0", null);
    const candidate = procedure("1.1.0", "1.0.0");
    const valid = fixture("synthetic");
    const regressed = {
      ...valid,
      candidate: {
        ...valid.candidate,
        metrics: {
          quality_bps: valid.baseline.metrics.quality_bps - 1,
          evidence_coverage_bps: valid.baseline.metrics.evidence_coverage_bps,
          evaluation_latency_ms: valid.baseline.metrics.evaluation_latency_ms + 2_000,
        },
      },
    };
    const artifacts = runOfflineProposalEvaluation({
      evaluated_at: evaluatedAt,
      baseline,
      candidate,
      fixtures: [regressed],
    });
    expect(artifacts.report).toMatchObject({
      verdict: "rejected",
      reason_codes: expect.arrayContaining([
        "quality_regressed",
        "latency_regressed_beyond_limit",
        "no_measurable_gain",
      ]),
    });
  });

  it("is pure: no transport callback and no input mutation", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const input = {
      evaluated_at: evaluatedAt,
      baseline: procedure("1.0.0", null),
      candidate: procedure("1.1.0", "1.0.0"),
      fixtures: [fixture("synthetic")],
    };
    const before = structuredClone(input);

    runOfflineProposalEvaluation(input);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(input).toEqual(before);
  });

  it("rejects incomplete promotion prohibitions even when array length is valid", () => {
    const { promotion } = validArtifacts();
    expect(PromotionManifestSchema.safeParse({
      ...promotion,
      prohibited_actions: [
        "execute_runtime_action",
        "execute_runtime_action",
        "rewrite_runtime_code",
        "change_policy",
        "send_network_request",
      ],
    }).success).toBe(false);
  });

  it.each([
    ["report id", (artifacts: any) => {
      artifacts.promotion.report_id = `review_${"f".repeat(24)}`;
    }],
    ["scope", (artifacts: any) => {
      artifacts.rollback.scope.dataset_id = "another-dataset";
    }],
    ["procedure", (artifacts: any) => {
      artifacts.promotion.procedure_id = "another-procedure";
    }],
    ["baseline version", (artifacts: any) => {
      artifacts.rollback.restore_version = "0.9.0";
    }],
    ["candidate version", (artifacts: any) => {
      artifacts.promotion.to_version = "1.2.0";
    }],
    ["eligibility", (artifacts: any) => {
      artifacts.promotion.candidate_eligible = false;
    }],
  ])("rejects persisted artifacts with incoherent %s", (_label, tamper) => {
    const artifacts = structuredClone(validArtifacts());
    tamper(artifacts);
    expect(OfflineEvaluationArtifactsSchema.safeParse(artifacts).success).toBe(false);
  });
});
