import { z } from "zod";

import { SavedBacktestChatEvidenceSchema } from "../../chat/evidence-reference";
import type { BacktestsViewModel } from "../../ui/view-model";

export const BACKTEST_SESSION_STORAGE_KEY = "pilot.research.backtests.saved.v1" as const;
export const MAX_SAVED_BACKTEST_RUNS = 8 as const;
export const MAX_SAVED_BACKTEST_BYTES = 512_000 as const;

const CanonicalDecimalSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/);
const SignedDecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const NonNegativeDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const BacktestRunRequestSchema = z.object({
  startDay: DateSchema,
  endDay: DateSchema,
  outOfSampleStartDay: DateSchema,
  initialBase: CanonicalDecimalSchema,
  initialQuote: CanonicalDecimalSchema,
  targetBaseBps: z.number().int().min(1).max(9_999),
  bandBps: z.number().int().min(0).max(4_999),
  maxTradeQuote: CanonicalDecimalSchema.refine((value) => value !== "0", "maximum trade must be positive"),
  spreadBps: z.number().int().min(0).max(5_000),
  venueFeeBps: z.number().int().min(0).max(5_000),
  slippageBps: z.number().int().min(0).max(5_000),
  networkCostQuote: CanonicalDecimalSchema,
  embargoBars: z.number().int().min(1).max(30),
  hypothesis: z.string().trim().min(12).max(500),
}).strict().superRefine((value, context) => {
  const start = Date.parse(`${value.startDay}T00:00:00.000Z`);
  const end = Date.parse(`${value.endDay}T00:00:00.000Z`);
  const oos = Date.parse(`${value.outOfSampleStartDay}T00:00:00.000Z`);
  const realDate = (day: string, parsed: number) => Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
  if (!realDate(value.startDay, start)) context.addIssue({ code: "custom", path: ["startDay"], message: "start day is invalid" });
  if (!realDate(value.endDay, end)) context.addIssue({ code: "custom", path: ["endDay"], message: "end day is invalid" });
  if (!realDate(value.outOfSampleStartDay, oos)) context.addIssue({ code: "custom", path: ["outOfSampleStartDay"], message: "OOS day is invalid" });
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    context.addIssue({ code: "custom", path: ["endDay"], message: "date window must be chronological" });
  } else {
    const buckets = Math.floor((end - start) / 86_400_000) + 1;
    if (buckets > 720) context.addIssue({ code: "custom", path: ["endDay"], message: "date window exceeds 720 daily buckets" });
    if (buckets < 8) context.addIssue({ code: "custom", path: ["endDay"], message: "date window needs at least eight daily buckets" });
  }
  if (Number.isFinite(oos) && (oos <= start || oos >= end)) {
    context.addIssue({ code: "custom", path: ["outOfSampleStartDay"], message: "OOS start must be inside the date window" });
  }
  if (value.targetBaseBps - value.bandBps < 0 || value.targetBaseBps + value.bandBps > 10_000) {
    context.addIssue({ code: "custom", path: ["bandBps"], message: "allocation band must remain inside portfolio bounds" });
  }
  if (value.spreadBps + value.venueFeeBps + value.slippageBps >= 10_000) {
    context.addIssue({ code: "custom", path: ["slippageBps"], message: "combined proportional costs must remain below 10,000 bps" });
  }
});

export type BacktestRunRequest = z.infer<typeof BacktestRunRequestSchema>;

const SetupFieldSchema = z.object({ id: z.string(), label: z.string(), value: z.string(), help: z.string() }).strict();
const MetricSchema = z.object({ label: z.string(), value: z.string(), detail: z.string(), tone: z.enum(["neutral", "positive", "warning"]).optional() }).strict();
const EquitySchema = z.object({
  date: DateSchema,
  strategyEquity: z.number().finite().nonnegative(),
  strategyEquityDisplay: z.string(),
  benchmarkEquity: z.number().finite().nonnegative(),
  benchmarkEquityDisplay: z.string(),
  drawdownBps: z.number().finite().nonnegative(),
  drawdownDisplay: z.string(),
}).strict();
const TradeSchema = z.object({ signalAt: z.string(), fillAt: z.string(), side: z.enum(["Buy base", "Sell base", "Rejected"]), grossNotional: z.string(), costs: z.string(), endingCash: z.string(), status: z.string() }).strict();
const SavedRunComparisonSchema = z.object({ label: z.string(), runId: z.string(), datasetFingerprint: z.string(), strategyReturn: z.string(), benchmarkReturn: z.string(), maxDrawdown: z.string(), totalCosts: z.string(), compatible: z.boolean() }).strict();

export const BacktestsViewModelSchema: z.ZodType<BacktestsViewModel> = z.object({
  availability: z.enum(["validated-historical", "deterministic-fixture", "unavailable"]),
  availabilityLabel: z.string(), availabilityTitle: z.string(), availabilityDetail: z.string(),
  provider: z.object({ name: z.string(), pair: z.string(), capability: z.string(), cost: z.string(), requestedWindow: z.string(), actualCoverage: z.string(), incompleteCandlePolicy: z.string() }).strict(),
  setup: z.array(SetupFieldSchema).max(24), splitDisclosure: z.string(), metrics: z.array(MetricSchema).max(24),
  equity: z.array(EquitySchema).max(720), trades: z.array(TradeSchema).max(2_000),
  reproducibility: z.object({ runId: z.string(), strategyVersion: z.string(), parameterFingerprint: Sha256Schema, rawHash: Sha256Schema, normalizedHash: Sha256Schema, coverage: z.string(), missingData: z.string() }).strict(),
  experiment: z.object({ hypothesis: z.string(), experiment: z.string(), outcome: z.string() }).strict(),
  savedRuns: z.array(SavedRunComparisonSchema).max(MAX_SAVED_BACKTEST_RUNS),
}).strict();

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(4_000), z.array(JsonValueSchema).max(4_000),
  z.record(z.string().min(1).max(100), JsonValueSchema),
]));

const SavedReportBindingSchema = z.object({
  runId: z.string(),
  engineVersion: z.string(),
  dataset: z.object({ normalizedHashSha256: Sha256Schema }).passthrough(),
  strategy: z.object({
    strategyVersion: z.string(),
    parameterFingerprintSha256: Sha256Schema,
  }).passthrough(),
  split: z.object({
    trainingEndDate: DateSchema,
    outOfSampleStartDate: DateSchema,
    embargoBars: z.number().int().positive(),
  }).passthrough(),
  result: z.object({
    quoteCurrency: z.string(),
    resultFingerprintSha256: Sha256Schema,
    outOfSample: z.object({
      totalReturnBps: SignedDecimalSchema,
      benchmarkReturnBps: SignedDecimalSchema,
      maxDrawdownBps: NonNegativeDecimalSchema,
      endingEquityQuote: NonNegativeDecimalSchema,
      totalCostsQuote: NonNegativeDecimalSchema,
      tradeCount: z.number().int().nonnegative(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export const BacktestRunBundleSchema = z.object({
  version: z.literal(1),
  viewModel: BacktestsViewModelSchema,
  savedRun: z.object({ scope: z.literal("local_research_only"), label: z.string().trim().min(1).max(80), savedAt: z.string().datetime({ offset: true }), report: JsonValueSchema }).strict(),
  chatEvidence: SavedBacktestChatEvidenceSchema,
}).strict().superRefine((bundle, context) => {
  if (bundle.viewModel.reproducibility.runId !== bundle.chatEvidence.runId) context.addIssue({ code: "custom", path: ["chatEvidence", "runId"], message: "run identifiers do not match" });
  if (bundle.viewModel.reproducibility.normalizedHash !== bundle.chatEvidence.datasetNormalizedHash) context.addIssue({ code: "custom", path: ["chatEvidence", "datasetNormalizedHash"], message: "dataset hashes do not match" });
  if (bundle.viewModel.reproducibility.strategyVersion !== bundle.chatEvidence.strategyVersion) context.addIssue({ code: "custom", path: ["chatEvidence", "strategyVersion"], message: "strategy versions do not match" });
  const reportResult = SavedReportBindingSchema.safeParse(bundle.savedRun.report);
  if (!reportResult.success) {
    context.addIssue({ code: "custom", path: ["savedRun", "report"], message: "saved report does not contain verifiable evidence bindings" });
    return;
  }
  const report = reportResult.data;
  const evidence = bundle.chatEvidence;
  const metrics = report.result.outOfSample;
  const mismatches: ReadonlyArray<readonly [boolean, (string | number)[], string]> = [
    [report.runId !== evidence.runId, ["savedRun", "report", "runId"], "saved report run identifier does not match chat evidence"],
    [report.dataset.normalizedHashSha256 !== evidence.datasetNormalizedHash, ["savedRun", "report", "dataset", "normalizedHashSha256"], "saved report dataset hash does not match chat evidence"],
    [report.strategy.strategyVersion !== evidence.strategyVersion, ["savedRun", "report", "strategy", "strategyVersion"], "saved report strategy version does not match chat evidence"],
    [report.strategy.parameterFingerprintSha256 !== bundle.viewModel.reproducibility.parameterFingerprint, ["savedRun", "report", "strategy", "parameterFingerprintSha256"], "saved report parameter fingerprint does not match the displayed run"],
    [report.result.resultFingerprintSha256 !== evidence.resultFingerprint, ["savedRun", "report", "result", "resultFingerprintSha256"], "saved report result fingerprint does not match chat evidence"],
    [report.result.quoteCurrency !== evidence.quoteSymbol, ["savedRun", "report", "result", "quoteCurrency"], "saved report quote currency does not match chat evidence"],
    [metrics.totalReturnBps !== evidence.metrics.strategyReturnBps, ["chatEvidence", "metrics", "strategyReturnBps"], "strategy return does not match the saved report"],
    [metrics.benchmarkReturnBps !== evidence.metrics.benchmarkReturnBps, ["chatEvidence", "metrics", "benchmarkReturnBps"], "benchmark return does not match the saved report"],
    [metrics.maxDrawdownBps !== evidence.metrics.maxDrawdownBps, ["chatEvidence", "metrics", "maxDrawdownBps"], "maximum drawdown does not match the saved report"],
    [metrics.endingEquityQuote !== evidence.metrics.endingEquityQuote, ["chatEvidence", "metrics", "endingEquityQuote"], "ending equity does not match the saved report"],
    [metrics.totalCostsQuote !== evidence.metrics.totalCostsQuote, ["chatEvidence", "metrics", "totalCostsQuote"], "total costs do not match the saved report"],
    [metrics.tradeCount !== evidence.metrics.tradeCount, ["chatEvidence", "metrics", "tradeCount"], "trade count does not match the saved report"],
  ];
  for (const [mismatch, path, message] of mismatches) {
    if (mismatch) context.addIssue({ code: "custom", path, message });
  }
});

export type BacktestRunBundle = z.infer<typeof BacktestRunBundleSchema>;
export const StoredBacktestRunSchema = z.object({ version: z.literal(1), bundle: BacktestRunBundleSchema }).strict();
export type StoredBacktestRun = z.infer<typeof StoredBacktestRunSchema>;

export function apiErrorMessage(input: unknown): string | undefined {
  const parsed = z.object({ error: z.string().trim().min(1).max(800) }).passthrough().safeParse(input);
  return parsed.success ? parsed.data.error : undefined;
}
