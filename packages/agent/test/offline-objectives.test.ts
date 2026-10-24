import { describe, expect, it } from "vitest";

import {
  REQUIRED_OFFLINE_INVARIANTS,
  proposeOfflineProcedureCandidate,
  runOfflineProposalEvaluation,
  type OfflineMetrics,
  type OfflineObjective,
  type ProcedureCandidate,
} from "../src/offline-improvement.js";

const scope = {
  tenant_id: "tenant-objectives",
  profile_id: "profile-objectives",
  dataset_id: "dataset-objectives-v1",
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

const baselineMetrics: OfflineMetrics = {
  quality_bps: 7_000,
  evidence_coverage_bps: 6_500,
  evaluation_latency_ms: 1_000,
};

function procedure(
  objective: OfflineObjective,
  version: string,
  basedOn: string | null,
): ProcedureCandidate {
  return proposeOfflineProcedureCandidate({
    schema_version: "pilot.offline-procedure-candidate.v1",
    candidate_id: `candidate-${objective}-${version.replaceAll(".", "-")}`,
    procedure_id: `objective-${objective}`,
    version,
    based_on_version: basedOn,
    scope,
    objective,
    invariants: [...REQUIRED_OFFLINE_INVARIANTS],
    steps,
  });
}

function evaluate(
  objective: OfflineObjective,
  metrics: OfflineMetrics,
  candidatePatch: Record<string, unknown> = {},
) {
  return runOfflineProposalEvaluation({
    evaluated_at: "2026-10-21T00:00:00.000Z",
    baseline: procedure(objective, "1.0.0", null),
    candidate: procedure(objective, "1.1.0", "1.0.0"),
    fixtures: [{
      schema_version: "pilot.offline-evaluation-fixture.v1",
      fixture_id: `fixture-${objective}`,
      scope,
      source: { kind: "synthetic" },
      task_class: "procedure_proposal",
      baseline: {
        metrics: baselineMetrics,
        policy_violations: [],
        scope_violations: [],
        side_effects: [],
        output_hash: "a".repeat(64),
        repeat_output_hash: "a".repeat(64),
      },
      candidate: {
        metrics,
        policy_violations: [],
        scope_violations: [],
        side_effects: [],
        output_hash: "b".repeat(64),
        repeat_output_hash: "b".repeat(64),
        ...candidatePatch,
      },
    }],
  });
}

function improvedMetrics(objective: OfflineObjective): OfflineMetrics {
  if (objective === "improve_answer_quality") {
    return { ...baselineMetrics, quality_bps: 7_100 };
  }
  if (objective === "improve_evidence_coverage") {
    return { ...baselineMetrics, evidence_coverage_bps: 6_600 };
  }
  return { ...baselineMetrics, evaluation_latency_ms: 900 };
}

describe("offline objective gates", () => {
  it.each([
    ["improve_answer_quality", {
      quality_bps: 7_001,
      evidence_coverage_bps: 6_500,
      evaluation_latency_ms: 1_200,
    }],
    ["improve_evidence_coverage", {
      quality_bps: 7_000,
      evidence_coverage_bps: 6_501,
      evaluation_latency_ms: 1_200,
    }],
    ["reduce_evaluation_latency", {
      quality_bps: 7_000,
      evidence_coverage_bps: 6_500,
      evaluation_latency_ms: 999,
    }],
  ] as const)("accepts measurable target improvement for %s", (objective, metrics) => {
    const artifacts = evaluate(objective, metrics);

    expect(artifacts.report).toMatchObject({
      objective,
      verdict: "eligible_for_human_review",
      reason_codes: [],
    });
    expect(artifacts.promotion.candidate_eligible).toBe(true);
  });

  it.each([
    ["improve_answer_quality", {
      quality_bps: 7_000,
      evidence_coverage_bps: 6_600,
      evaluation_latency_ms: 990,
    }, "objective_quality_not_improved"],
    ["improve_evidence_coverage", {
      quality_bps: 7_100,
      evidence_coverage_bps: 6_500,
      evaluation_latency_ms: 990,
    }, "objective_evidence_coverage_not_improved"],
    ["reduce_evaluation_latency", {
      quality_bps: 7_001,
      evidence_coverage_bps: 6_500,
      evaluation_latency_ms: 1_500,
    }, "objective_latency_not_improved"],
  ] as const)("rejects non-target gains for %s", (objective, metrics, reason) => {
    const artifacts = evaluate(objective, metrics);

    expect(artifacts.report.verdict).toBe("rejected");
    expect(artifacts.report.reason_codes).toContain(reason);
    expect(artifacts.promotion.candidate_eligible).toBe(false);
  });

  it.each([
    ["improve_answer_quality", "policy_violations", "candidate_has_policy_violations"],
    ["improve_answer_quality", "scope_violations", "candidate_has_scope_violations"],
    ["improve_answer_quality", "side_effects", "candidate_has_side_effects"],
    ["improve_evidence_coverage", "policy_violations", "candidate_has_policy_violations"],
    ["improve_evidence_coverage", "scope_violations", "candidate_has_scope_violations"],
    ["improve_evidence_coverage", "side_effects", "candidate_has_side_effects"],
    ["reduce_evaluation_latency", "policy_violations", "candidate_has_policy_violations"],
    ["reduce_evaluation_latency", "scope_violations", "candidate_has_scope_violations"],
    ["reduce_evaluation_latency", "side_effects", "candidate_has_side_effects"],
  ] as const)("keeps %s safety invariant %s mandatory", (objective, field, reason) => {
    const artifacts = evaluate(objective, improvedMetrics(objective), {
      [field]: ["attempted unsafe behavior"],
    });

    expect(artifacts.report.verdict).toBe("rejected");
    expect(artifacts.report.reason_codes).toContain(reason);
    expect(artifacts.promotion.candidate_eligible).toBe(false);
  });

  it.each([
    ["improve_answer_quality", {
      quality_bps: 7_100,
      evidence_coverage_bps: 6_499,
      evaluation_latency_ms: 1_000,
    }, "evidence_coverage_regressed"],
    ["improve_evidence_coverage", {
      quality_bps: 6_999,
      evidence_coverage_bps: 6_600,
      evaluation_latency_ms: 1_000,
    }, "quality_regressed"],
    ["reduce_evaluation_latency", {
      quality_bps: 6_999,
      evidence_coverage_bps: 6_500,
      evaluation_latency_ms: 900,
    }, "quality_regressed"],
  ] as const)("rejects safety metric regression for %s", (objective, metrics, reason) => {
    const artifacts = evaluate(objective, metrics);

    expect(artifacts.report.verdict).toBe("rejected");
    expect(artifacts.report.reason_codes).toContain(reason);
  });

  it.each([
    "improve_answer_quality",
    "improve_evidence_coverage",
  ] as const)("enforces the safe latency cap for %s", (objective) => {
    const artifacts = evaluate(objective, {
      ...improvedMetrics(objective),
      evaluation_latency_ms: baselineMetrics.evaluation_latency_ms + 1_001,
    });

    expect(artifacts.report.verdict).toBe("rejected");
    expect(artifacts.report.reason_codes).toContain("latency_regressed_beyond_limit");
  });
});
