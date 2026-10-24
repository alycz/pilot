import { createHash } from "node:crypto";

import { z } from "zod";

export const PROCEDURE_CANDIDATE_SCHEMA_VERSION =
  "pilot.offline-procedure-candidate.v1" as const;
export const OFFLINE_REVIEW_SCHEMA_VERSION =
  "pilot.offline-procedure-review.v1" as const;
export const PROMOTION_MANIFEST_SCHEMA_VERSION =
  "pilot.offline-promotion-manifest.v1" as const;
export const ROLLBACK_MANIFEST_SCHEMA_VERSION =
  "pilot.offline-rollback-manifest.v1" as const;

export const REQUIRED_OFFLINE_INVARIANTS = [
  "no_network",
  "no_execution",
  "no_runtime_rewrite",
  "no_policy_change",
  "no_automatic_promotion",
  "no_cross_scope_access",
] as const;

export const SAFE_OFFLINE_STEP_KINDS = [
  "assert_scope",
  "assert_policy_invariants",
  "normalize_fixture",
  "stratify_fixture_source",
  "compare_fixture_metrics",
  "prepare_review_report",
  "prepare_promotion_manifest",
  "prepare_rollback_manifest",
] as const;

export const OfflineObjectiveSchema = z.enum([
  "improve_answer_quality",
  "improve_evidence_coverage",
  "reduce_evaluation_latency",
]);
export type OfflineObjective = z.infer<typeof OfflineObjectiveSchema>;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const SemanticVersionSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const BoundedReasonSchema = z.string().trim().min(1).max(160);

export const OfflineScopeSchema = z
  .object({
    tenant_id: IdentifierSchema,
    profile_id: IdentifierSchema,
    dataset_id: IdentifierSchema,
  })
  .strict();
export type OfflineScope = z.infer<typeof OfflineScopeSchema>;

export const OfflineProcedureStepSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(SAFE_OFFLINE_STEP_KINDS),
  })
  .strict();
export type OfflineProcedureStep = z.infer<typeof OfflineProcedureStepSchema>;

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}

function exactSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length &&
    new Set(values).size === values.length &&
    expected.every((value) => values.includes(value));
}

function validateProcedureSteps(
  steps: readonly OfflineProcedureStep[],
  context: z.RefinementCtx,
): void {
  if (new Set(steps.map(({ id }) => id)).size !== steps.length) {
    issue(context, ["steps"], "step ids must be unique");
  }

  const kinds = steps.map(({ kind }) => kind);
  if (new Set(kinds).size !== kinds.length) {
    issue(context, ["steps"], "step kinds must not repeat");
  }
  if (kinds[0] !== "assert_scope" || kinds[1] !== "assert_policy_invariants") {
    issue(context, ["steps"], "scope and policy guards must run first");
  }

  const comparison = kinds.indexOf("compare_fixture_metrics");
  if (comparison < 2) {
    issue(context, ["steps"], "fixture comparison is required after both guards");
  }
  const requiredTail = [
    "prepare_review_report",
    "prepare_promotion_manifest",
    "prepare_rollback_manifest",
  ];
  if (kinds.slice(-requiredTail.length).join("\0") !== requiredTail.join("\0")) {
    issue(context, ["steps"], "review and manifest preparation must be the final steps");
  }
  const optionalKinds = new Set(["normalize_fixture", "stratify_fixture_source"]);
  if (kinds.slice(2, comparison).some((kind) => !optionalKinds.has(kind))) {
    issue(context, ["steps"], "only bounded fixture preparation may precede comparison");
  }
}

export const ProcedureCandidateSchema = z
  .object({
    schema_version: z.literal(PROCEDURE_CANDIDATE_SCHEMA_VERSION),
    candidate_id: IdentifierSchema,
    procedure_id: IdentifierSchema,
    version: SemanticVersionSchema,
    based_on_version: SemanticVersionSchema.nullable(),
    scope: OfflineScopeSchema,
    objective: OfflineObjectiveSchema,
    invariants: z.array(z.enum(REQUIRED_OFFLINE_INVARIANTS)).length(
      REQUIRED_OFFLINE_INVARIANTS.length,
    ),
    steps: z.array(OfflineProcedureStepSchema).min(6).max(8),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (!exactSet(candidate.invariants, REQUIRED_OFFLINE_INVARIANTS)) {
      issue(context, ["invariants"], "all offline safety invariants are mandatory");
    }
    validateProcedureSteps(candidate.steps, context);
  });
export type ProcedureCandidate = z.infer<typeof ProcedureCandidateSchema>;

/** Validate a proposed declarative procedure without executing or installing it. */
export function proposeOfflineProcedureCandidate(proposal: unknown): ProcedureCandidate {
  return ProcedureCandidateSchema.parse(proposal);
}

export const OfflineMetricsSchema = z
  .object({
    quality_bps: z.number().int().min(0).max(10_000),
    evidence_coverage_bps: z.number().int().min(0).max(10_000),
    evaluation_latency_ms: z.number().int().min(0).max(600_000),
  })
  .strict();
export type OfflineMetrics = z.infer<typeof OfflineMetricsSchema>;

export const OfflineObservationSchema = z
  .object({
    metrics: OfflineMetricsSchema,
    policy_violations: z.array(BoundedReasonSchema).max(16),
    scope_violations: z.array(BoundedReasonSchema).max(16),
    side_effects: z.array(BoundedReasonSchema).max(16),
    output_hash: Sha256Schema,
    repeat_output_hash: Sha256Schema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.output_hash !== observation.repeat_output_hash) {
      issue(context, ["repeat_output_hash"], "repeated offline run must be deterministic");
    }
  });
export type OfflineObservation = z.infer<typeof OfflineObservationSchema>;

const SyntheticSourceSchema = z.object({ kind: z.literal("synthetic") }).strict();
const RedactedReplaySourceSchema = z
  .object({
    kind: z.literal("redacted_replay"),
    replay_id: IdentifierSchema,
    redacted: z.literal(true),
    contains_user_identifiers: z.literal(false),
    contains_real_order_data: z.literal(false),
  })
  .strict();

export const OfflineEvaluationFixtureSchema = z
  .object({
    schema_version: z.literal("pilot.offline-evaluation-fixture.v1"),
    fixture_id: IdentifierSchema,
    scope: OfflineScopeSchema,
    source: z.discriminatedUnion("kind", [
      SyntheticSourceSchema,
      RedactedReplaySourceSchema,
    ]),
    task_class: z.enum([
      "read_only_research",
      "portfolio_explanation",
      "procedure_proposal",
    ]),
    baseline: OfflineObservationSchema,
    candidate: OfflineObservationSchema,
  })
  .strict();
export type OfflineEvaluationFixture = z.infer<typeof OfflineEvaluationFixtureSchema>;

export const AggregateMetricsSchema = z
  .object({
    quality_bps: z.number().int().min(0).max(10_000),
    evidence_coverage_bps: z.number().int().min(0).max(10_000),
    evaluation_latency_ms: z.number().int().min(0).max(600_000),
    policy_violation_count: z.number().int().min(0),
    scope_violation_count: z.number().int().min(0),
    side_effect_count: z.number().int().min(0),
  })
  .strict();
export type AggregateMetrics = z.infer<typeof AggregateMetricsSchema>;

export const MetricDeltaSchema = z
  .object({
    quality_bps: z.number().int().min(-10_000).max(10_000),
    evidence_coverage_bps: z.number().int().min(-10_000).max(10_000),
    evaluation_latency_ms: z.number().int().min(-600_000).max(600_000),
  })
  .strict();

export const OfflineReviewReportSchema = z
  .object({
    schema_version: z.literal(OFFLINE_REVIEW_SCHEMA_VERSION),
    report_id: z.string().regex(/^review_[0-9a-f]{24}$/),
    evaluated_at: z.string().datetime({ offset: true }),
    scope: OfflineScopeSchema,
    procedure_id: IdentifierSchema,
    baseline_version: SemanticVersionSchema,
    candidate_version: SemanticVersionSchema,
    objective: OfflineObjectiveSchema,
    fixture_ids: z.array(IdentifierSchema).min(1).max(100),
    baseline: AggregateMetricsSchema,
    candidate: AggregateMetricsSchema,
    delta: MetricDeltaSchema,
    verdict: z.enum(["eligible_for_human_review", "rejected"]),
    reason_codes: z.array(z.enum([
      "candidate_has_policy_violations",
      "candidate_has_scope_violations",
      "candidate_has_side_effects",
      "quality_regressed",
      "evidence_coverage_regressed",
      "latency_regressed_beyond_limit",
      "objective_quality_not_improved",
      "objective_evidence_coverage_not_improved",
      "objective_latency_not_improved",
      "no_measurable_gain",
    ])).max(10),
    evidence_hash: Sha256Schema,
  })
  .strict();
export type OfflineReviewReport = z.infer<typeof OfflineReviewReportSchema>;

const ProhibitedPromotionActionSchema = z.enum([
  "execute_runtime_action",
  "rewrite_runtime_code",
  "change_policy",
  "send_network_request",
  "auto_promote",
]);

export const PromotionManifestSchema = z
  .object({
    schema_version: z.literal(PROMOTION_MANIFEST_SCHEMA_VERSION),
    manifest_id: z.string().regex(/^promotion_[0-9a-f]{24}$/),
    report_id: z.string().regex(/^review_[0-9a-f]{24}$/),
    scope: OfflineScopeSchema,
    procedure_id: IdentifierSchema,
    from_version: SemanticVersionSchema,
    to_version: SemanticVersionSchema,
    candidate_eligible: z.boolean(),
    status: z.literal("pending_human_review"),
    requires_human_approval: z.literal(true),
    automatic_promotion: z.literal(false),
    prohibited_actions: z.array(ProhibitedPromotionActionSchema).length(5),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (!exactSet(manifest.prohibited_actions, PROHIBITED_ACTIONS)) {
      issue(
        context,
        ["prohibited_actions"],
        "all promotion prohibitions are mandatory and must not repeat",
      );
    }
  });
export type PromotionManifest = z.infer<typeof PromotionManifestSchema>;

export const RollbackManifestSchema = z
  .object({
    schema_version: z.literal(ROLLBACK_MANIFEST_SCHEMA_VERSION),
    manifest_id: z.string().regex(/^rollback_[0-9a-f]{24}$/),
    report_id: z.string().regex(/^review_[0-9a-f]{24}$/),
    scope: OfflineScopeSchema,
    procedure_id: IdentifierSchema,
    restore_version: SemanticVersionSchema,
    candidate_version: SemanticVersionSchema,
    status: z.literal("prepared_not_applied"),
    activation: z.literal("human_only"),
    automatic_rollback: z.literal(false),
    trigger_codes: z.tuple([
      z.literal("policy_invariant_failure"),
      z.literal("scope_isolation_failure"),
      z.literal("metric_regression"),
      z.literal("unexpected_side_effect"),
    ]),
  })
  .strict();
export type RollbackManifest = z.infer<typeof RollbackManifestSchema>;

export const OfflineEvaluationArtifactsSchema = z
  .object({
    report: OfflineReviewReportSchema,
    promotion: PromotionManifestSchema,
    rollback: RollbackManifestSchema,
  })
  .strict()
  .superRefine((artifacts, context) => {
    const { report, promotion, rollback } = artifacts;
    if (
      promotion.report_id !== report.report_id ||
      rollback.report_id !== report.report_id
    ) {
      issue(context, ["report_id"], "all artifacts must reference the same report");
    }
    if (
      !sameScope(promotion.scope, report.scope) ||
      !sameScope(rollback.scope, report.scope)
    ) {
      issue(context, ["scope"], "all artifacts must have the same scope");
    }
    if (
      promotion.procedure_id !== report.procedure_id ||
      rollback.procedure_id !== report.procedure_id
    ) {
      issue(context, ["procedure_id"], "all artifacts must name the same procedure");
    }
    if (
      promotion.from_version !== report.baseline_version ||
      rollback.restore_version !== report.baseline_version
    ) {
      issue(context, ["baseline_version"], "manifest restore versions must match the report baseline");
    }
    if (
      promotion.to_version !== report.candidate_version ||
      rollback.candidate_version !== report.candidate_version
    ) {
      issue(context, ["candidate_version"], "manifest target versions must match the report candidate");
    }
    if (
      promotion.candidate_eligible !==
        (report.verdict === "eligible_for_human_review")
    ) {
      issue(context, ["candidate_eligible"], "promotion eligibility must match the review verdict");
    }
  });
export type OfflineEvaluationArtifacts = z.infer<typeof OfflineEvaluationArtifactsSchema>;

export const OfflineEvaluationInputSchema = z
  .object({
    evaluated_at: z.string().datetime({ offset: true }),
    baseline: ProcedureCandidateSchema,
    candidate: ProcedureCandidateSchema,
    fixtures: z.array(OfflineEvaluationFixtureSchema).min(1).max(100),
  })
  .strict();
export type OfflineEvaluationInput = z.infer<typeof OfflineEvaluationInputSchema>;

const MAX_LATENCY_REGRESSION_MS = 1_000;
const PROHIBITED_ACTIONS = [
  "execute_runtime_action",
  "rewrite_runtime_code",
  "change_policy",
  "send_network_request",
  "auto_promote",
] as const;
const ROLLBACK_TRIGGERS = [
  "policy_invariant_failure",
  "scope_isolation_failure",
  "metric_regression",
  "unexpected_side_effect",
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function canonicalProcedure(candidate: ProcedureCandidate): ProcedureCandidate {
  return {
    ...candidate,
    invariants: [...candidate.invariants].sort(),
  };
}

function canonicalObservation(observation: OfflineObservation): OfflineObservation {
  return {
    ...observation,
    policy_violations: [...observation.policy_violations].sort(),
    scope_violations: [...observation.scope_violations].sort(),
    side_effects: [...observation.side_effects].sort(),
  };
}

function canonicalFixture(fixture: OfflineEvaluationFixture): OfflineEvaluationFixture {
  return {
    ...fixture,
    baseline: canonicalObservation(fixture.baseline),
    candidate: canonicalObservation(fixture.candidate),
  };
}

function compareSemanticVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function sameScope(left: OfflineScope, right: OfflineScope): boolean {
  return left.tenant_id === right.tenant_id &&
    left.profile_id === right.profile_id &&
    left.dataset_id === right.dataset_id;
}

function aggregate(
  fixtures: readonly OfflineEvaluationFixture[],
  key: "baseline" | "candidate",
): AggregateMetrics {
  const sum = fixtures.reduce(
    (totals, fixture) => {
      const observation = fixture[key];
      totals.quality_bps += observation.metrics.quality_bps;
      totals.evidence_coverage_bps += observation.metrics.evidence_coverage_bps;
      totals.evaluation_latency_ms += observation.metrics.evaluation_latency_ms;
      totals.policy_violation_count += observation.policy_violations.length;
      totals.scope_violation_count += observation.scope_violations.length;
      totals.side_effect_count += observation.side_effects.length;
      return totals;
    },
    {
      quality_bps: 0,
      evidence_coverage_bps: 0,
      evaluation_latency_ms: 0,
      policy_violation_count: 0,
      scope_violation_count: 0,
      side_effect_count: 0,
    },
  );
  return {
    ...sum,
    quality_bps: Math.round(sum.quality_bps / fixtures.length),
    evidence_coverage_bps: Math.round(sum.evidence_coverage_bps / fixtures.length),
    evaluation_latency_ms: Math.round(sum.evaluation_latency_ms / fixtures.length),
  };
}

/**
 * Compile deterministic review artifacts from bounded offline evidence.
 *
 * This is inspired by Harness²'s evidence-driven proposal comparison, but it is
 * intentionally not a Harness² integration: there is no model, executor,
 * callback, filesystem, network, promotion, rollback, policy, or runtime write.
 * See https://github.com/google-research/harness2.
 */
export function runOfflineProposalEvaluation(
  input: OfflineEvaluationInput,
): OfflineEvaluationArtifacts {
  const parsed = OfflineEvaluationInputSchema.parse(input);
  const { baseline, candidate } = parsed;
  if (!sameScope(baseline.scope, candidate.scope)) {
    throw new Error("offline candidate scope must match the baseline scope");
  }
  if (
    baseline.procedure_id !== candidate.procedure_id ||
    candidate.based_on_version !== baseline.version ||
    compareSemanticVersions(candidate.version, baseline.version) <= 0
  ) {
    throw new Error("offline candidate must be a newer version of its exact baseline");
  }

  const fixtures = [...parsed.fixtures].sort((left, right) =>
    left.fixture_id.localeCompare(right.fixture_id)
  );
  if (new Set(fixtures.map(({ fixture_id }) => fixture_id)).size !== fixtures.length) {
    throw new Error("offline fixture ids must be unique");
  }
  if (fixtures.some((fixture) => !sameScope(fixture.scope, candidate.scope))) {
    throw new Error("offline fixture scope must match the procedure scope");
  }

  const baselineMetrics = aggregate(fixtures, "baseline");
  const candidateMetrics = aggregate(fixtures, "candidate");
  const delta = {
    quality_bps: candidateMetrics.quality_bps - baselineMetrics.quality_bps,
    evidence_coverage_bps:
      candidateMetrics.evidence_coverage_bps - baselineMetrics.evidence_coverage_bps,
    evaluation_latency_ms:
      candidateMetrics.evaluation_latency_ms - baselineMetrics.evaluation_latency_ms,
  };

  const reasonCodes: OfflineReviewReport["reason_codes"] = [];
  if (candidateMetrics.policy_violation_count > 0) {
    reasonCodes.push("candidate_has_policy_violations");
  }
  if (candidateMetrics.scope_violation_count > 0) {
    reasonCodes.push("candidate_has_scope_violations");
  }
  if (candidateMetrics.side_effect_count > 0) {
    reasonCodes.push("candidate_has_side_effects");
  }
  if (delta.quality_bps < 0) reasonCodes.push("quality_regressed");
  if (delta.evidence_coverage_bps < 0) {
    reasonCodes.push("evidence_coverage_regressed");
  }
  if (delta.evaluation_latency_ms > MAX_LATENCY_REGRESSION_MS) {
    reasonCodes.push("latency_regressed_beyond_limit");
  }
  switch (candidate.objective) {
    case "improve_answer_quality":
      if (delta.quality_bps <= 0) {
        reasonCodes.push("objective_quality_not_improved");
      }
      break;
    case "improve_evidence_coverage":
      if (delta.evidence_coverage_bps <= 0) {
        reasonCodes.push("objective_evidence_coverage_not_improved");
      }
      break;
    case "reduce_evaluation_latency":
      if (delta.evaluation_latency_ms >= 0) {
        reasonCodes.push("objective_latency_not_improved");
      }
      break;
  }
  if (
    delta.quality_bps <= 0 &&
    delta.evidence_coverage_bps <= 0 &&
    delta.evaluation_latency_ms >= 0
  ) {
    reasonCodes.push("no_measurable_gain");
  }
  reasonCodes.sort();

  const evidenceHash = hash({
    baseline: canonicalProcedure(baseline),
    candidate: canonicalProcedure(candidate),
    fixtures: fixtures.map(canonicalFixture),
  });
  const reportCore = {
    schema_version: OFFLINE_REVIEW_SCHEMA_VERSION,
    evaluated_at: parsed.evaluated_at,
    scope: candidate.scope,
    procedure_id: candidate.procedure_id,
    baseline_version: baseline.version,
    candidate_version: candidate.version,
    objective: candidate.objective,
    fixture_ids: fixtures.map(({ fixture_id }) => fixture_id),
    baseline: baselineMetrics,
    candidate: candidateMetrics,
    delta,
    verdict: reasonCodes.length === 0
      ? "eligible_for_human_review" as const
      : "rejected" as const,
    reason_codes: reasonCodes,
    evidence_hash: evidenceHash,
  };
  const report = OfflineReviewReportSchema.parse({
    ...reportCore,
    report_id: `review_${hash(reportCore).slice(0, 24)}`,
  });

  const promotionCore = {
    schema_version: PROMOTION_MANIFEST_SCHEMA_VERSION,
    report_id: report.report_id,
    scope: candidate.scope,
    procedure_id: candidate.procedure_id,
    from_version: baseline.version,
    to_version: candidate.version,
    candidate_eligible: report.verdict === "eligible_for_human_review",
    status: "pending_human_review" as const,
    requires_human_approval: true as const,
    automatic_promotion: false as const,
    prohibited_actions: PROHIBITED_ACTIONS,
  };
  const promotion = PromotionManifestSchema.parse({
    ...promotionCore,
    manifest_id: `promotion_${hash(promotionCore).slice(0, 24)}`,
  });

  const rollbackCore = {
    schema_version: ROLLBACK_MANIFEST_SCHEMA_VERSION,
    report_id: report.report_id,
    scope: candidate.scope,
    procedure_id: candidate.procedure_id,
    restore_version: baseline.version,
    candidate_version: candidate.version,
    status: "prepared_not_applied" as const,
    activation: "human_only" as const,
    automatic_rollback: false as const,
    trigger_codes: ROLLBACK_TRIGGERS,
  };
  const rollback = RollbackManifestSchema.parse({
    ...rollbackCore,
    manifest_id: `rollback_${hash(rollbackCore).slice(0, 24)}`,
  });

  return OfflineEvaluationArtifactsSchema.parse({ report, promotion, rollback });
}
