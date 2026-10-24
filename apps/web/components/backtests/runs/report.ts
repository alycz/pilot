import { createHash } from "node:crypto";

import { z } from "zod";

export const BACKTEST_REPORT_SCHEMA_VERSION = "pilot.backtest-report.v1" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const NonNegativeDecimalSchema = z.string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const IdentifierSchema = z.string().trim().min(1).max(96)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

const CanonicalValueSchema: z.ZodType<CanonicalValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(2_000),
  z.array(CanonicalValueSchema).max(200),
  z.record(z.string().min(1).max(80), CanonicalValueSchema),
]));

const DatasetEvidenceSchema = z.object({
  datasetId: IdentifierSchema,
  rawHashSha256: Sha256Schema,
  normalizedHashSha256: Sha256Schema,
  sourceRegistryId: IdentifierSchema,
  sourceLabel: z.string().trim().min(1).max(160),
  pairLabel: z.string().trim().min(3).max(64),
  capabilityLabel: z.string().trim().min(1).max(200),
  costLabel: z.string().trim().min(1).max(200),
  coverageLabel: z.string().trim().min(1).max(240),
  redistributionLabel: z.string().trim().min(1).max(240),
  coverage: z.object({
    startDate: DateSchema,
    endDate: DateSchema,
    expectedBuckets: z.number().int().positive().max(100_000),
    observedBuckets: z.number().int().positive().max(100_000),
    missingBuckets: z.number().int().nonnegative().max(100_000),
    discardedIncompleteBuckets: z.number().int().nonnegative().max(10),
  }).strict(),
}).strict().superRefine(({ coverage }, context) => {
  if (coverage.observedBuckets + coverage.missingBuckets !== coverage.expectedBuckets) {
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "observed plus missing buckets must equal expected buckets",
    });
  }
  if (coverage.startDate > coverage.endDate) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "coverage dates are reversed" });
  }
});

const StrategyEvidenceSchema = z.object({
  strategyId: IdentifierSchema,
  strategyVersion: IdentifierSchema,
  parameters: z.record(z.string().min(1).max(80), CanonicalValueSchema),
  parameterFingerprintSha256: Sha256Schema,
}).strict();

const SplitEvidenceSchema = z.object({
  trainingEndDate: DateSchema,
  outOfSampleStartDate: DateSchema,
  embargoBars: z.number().int().positive().max(30),
  parametersFrozenBeforeOutOfSample: z.literal(true),
}).strict().refine((split) => split.trainingEndDate < split.outOfSampleStartDate, {
  path: ["outOfSampleStartDate"],
  message: "out-of-sample must start after training",
});

const CostAssumptionsSchema = z.object({
  quoteCurrency: z.string().trim().min(1).max(32),
  spreadBps: z.number().int().nonnegative().max(5_000),
  venueFeeBps: z.number().int().nonnegative().max(5_000),
  slippageBps: z.number().int().nonnegative().max(5_000),
  networkCostPerFillQuote: NonNegativeDecimalSchema,
  liquidityModel: z.enum(["not_modeled", "validated_market_volume_cap"]),
}).strict();

const StudyRecordSchema = z.object({
  hypothesis: z.object({
    statement: z.string().trim().min(1).max(500),
    declaredBeforeOutOfSample: z.literal(true),
  }).strict(),
  experiment: z.object({
    setupSummary: z.string().trim().min(1).max(800),
    primaryMetric: z.enum(["excess_return_bps", "max_drawdown_bps", "total_return_bps"]),
    outOfSampleHiddenUntilParametersFrozen: z.literal(true),
  }).strict(),
  outcome: z.object({
    status: z.enum(["supported", "not_supported", "inconclusive"]),
    summary: z.string().trim().min(1).max(800),
    observedPrimaryMetric: DecimalSchema,
  }).strict(),
}).strict();

const MetricSetSchema = z.object({
  startingEquityQuote: NonNegativeDecimalSchema,
  endingEquityQuote: NonNegativeDecimalSchema,
  totalReturnBps: DecimalSchema,
  benchmarkReturnBps: DecimalSchema,
  excessReturnBps: DecimalSchema,
  maxDrawdownBps: NonNegativeDecimalSchema,
  totalCostsQuote: NonNegativeDecimalSchema,
  turnoverQuote: NonNegativeDecimalSchema,
  tradeCount: z.number().int().nonnegative().max(1_000_000),
  rejectedFillCount: z.number().int().nonnegative().max(1_000_000),
}).strict();

const ResultPayloadSchema = z.object({
  /** SHA-256 supplied by the deterministic engine over its complete JSON-safe output. */
  engineOutputHashSha256: Sha256Schema,
  quoteCurrency: z.string().trim().min(1).max(32),
  full: MetricSetSchema,
  outOfSample: MetricSetSchema,
}).strict();

const ResultEvidenceSchema = ResultPayloadSchema.extend({
  resultFingerprintSha256: Sha256Schema,
}).strict();

function normalizedDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  const magnitude = `${BigInt(whole)}${normalizedFraction ? `.${normalizedFraction}` : ""}`;
  return magnitude === "0" ? "0" : `${negative ? "-" : ""}${magnitude}`;
}

export const ReproducibilityReportSchema = z.object({
  schemaVersion: z.literal(BACKTEST_REPORT_SCHEMA_VERSION),
  runId: z.string().regex(/^bt_[a-f0-9]{24}$/),
  engineVersion: IdentifierSchema,
  dataset: DatasetEvidenceSchema,
  strategy: StrategyEvidenceSchema,
  split: SplitEvidenceSchema,
  costs: CostAssumptionsSchema,
  study: StudyRecordSchema,
  result: ResultEvidenceSchema,
}).strict().superRefine((report, context) => {
  if (report.costs.quoteCurrency !== report.result.quoteCurrency) {
    context.addIssue({
      code: "custom",
      path: ["result", "quoteCurrency"],
      message: "result currency must match cost assumptions",
    });
  }
  const primaryMetric = report.study.experiment.primaryMetric === "excess_return_bps"
    ? report.result.outOfSample.excessReturnBps
    : report.study.experiment.primaryMetric === "max_drawdown_bps"
      ? report.result.outOfSample.maxDrawdownBps
      : report.result.outOfSample.totalReturnBps;
  if (normalizedDecimal(primaryMetric) !== normalizedDecimal(report.study.outcome.observedPrimaryMetric)) {
    context.addIssue({
      code: "custom",
      path: ["study", "outcome", "observedPrimaryMetric"],
      message: "observed primary metric must be owned by the deterministic OOS result",
    });
  }
});

export type DatasetEvidence = z.infer<typeof DatasetEvidenceSchema>;
export type StrategyEvidence = z.infer<typeof StrategyEvidenceSchema>;
export type SplitEvidence = z.infer<typeof SplitEvidenceSchema>;
export type CostAssumptions = z.infer<typeof CostAssumptionsSchema>;
export type StudyRecord = z.infer<typeof StudyRecordSchema>;
export type BacktestMetricSet = z.infer<typeof MetricSetSchema>;
export type BacktestResultPayload = z.infer<typeof ResultPayloadSchema>;
export type ReproducibilityReport = z.infer<typeof ReproducibilityReportSchema>;

export type ReproducibilityReportInput = Readonly<{
  engineVersion: string;
  dataset: DatasetEvidence;
  strategy: Omit<StrategyEvidence, "parameterFingerprintSha256">;
  split: SplitEvidence;
  costs: CostAssumptions;
  study: StudyRecord;
  result: BacktestResultPayload;
}>;

const PRIVATE_FIELD = /wallet|account|address|user.?id|session|credential|secret|private.?key|seed/i;
const XRPL_CLASSIC_ADDRESS = /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/;

function assertPrivacySafe(value: unknown, path = "report"): void {
  if (typeof value === "string") {
    if (XRPL_CLASSIC_ADDRESS.test(value)) {
      throw new TypeError(`${path} must not contain a wallet address`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPrivacySafe(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_FIELD.test(key)) throw new TypeError(`${path}.${key} is not permitted in a local research report`);
    assertPrivacySafe(entry, `${path}.${key}`);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function withoutRunId(report: ReproducibilityReport): Omit<ReproducibilityReport, "runId"> {
  const { runId: _runId, ...payload } = report;
  return payload;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

export function createReproducibilityReport(input: ReproducibilityReportInput): ReproducibilityReport {
  assertPrivacySafe(input);
  const parameterFingerprintSha256 = sha256Fingerprint(input.strategy.parameters);
  const resultFingerprintSha256 = sha256Fingerprint(input.result);
  const payload = {
    schemaVersion: BACKTEST_REPORT_SCHEMA_VERSION,
    engineVersion: input.engineVersion,
    dataset: input.dataset,
    strategy: { ...input.strategy, parameterFingerprintSha256 },
    split: input.split,
    costs: input.costs,
    study: input.study,
    result: { ...input.result, resultFingerprintSha256 },
  };
  const runId = `bt_${sha256Fingerprint(payload).slice(0, 24)}`;
  return deepFreeze(ReproducibilityReportSchema.parse({ ...payload, runId }));
}

export function verifyReproducibilityReport(input: unknown): ReproducibilityReport {
  assertPrivacySafe(input);
  const report = ReproducibilityReportSchema.parse(input);
  if (sha256Fingerprint(report.strategy.parameters) !== report.strategy.parameterFingerprintSha256) {
    throw new TypeError("strategy parameter fingerprint does not match the report");
  }
  const { resultFingerprintSha256: _fingerprint, ...resultPayload } = report.result;
  if (sha256Fingerprint(resultPayload) !== report.result.resultFingerprintSha256) {
    throw new TypeError("result fingerprint does not match the report");
  }
  const expectedRunId = `bt_${sha256Fingerprint(withoutRunId(report)).slice(0, 24)}`;
  if (expectedRunId !== report.runId) throw new TypeError("run identifier does not match the report");
  return deepFreeze(report);
}
