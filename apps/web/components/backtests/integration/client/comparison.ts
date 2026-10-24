import { z } from "zod";

import type { SavedRunComparison } from "../../ui/view-model";
import type { BacktestRunBundle, StoredBacktestRun } from "./contracts";

export type EvidenceComparison = Readonly<{ compatible: boolean; detail: string }>;

function decimalParts(value: string): { units: bigint; scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  return { units: BigInt(`${whole}${fraction}` || "0") * (negative ? -1n : 1n), scale: fraction.length };
}

function subtract(candidate: string, baseline: string): string {
  const left = decimalParts(candidate);
  const right = decimalParts(baseline);
  const scale = Math.max(left.scale, right.scale);
  const value = left.units * 10n ** BigInt(scale - left.scale) - right.units * 10n ** BigInt(scale - right.scale);
  const negative = value < 0n;
  const absolute = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : "+"}${absolute}`;
  const whole = absolute.slice(0, -scale) || "0";
  const fraction = absolute.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : "+"}${whole}${fraction ? `.${fraction}` : ""}`;
}

const ComparisonIdentitySchema = z.object({
  engineVersion: z.string().min(1),
  split: z.object({
    trainingEndDate: z.string(),
    outOfSampleStartDate: z.string(),
    embargoBars: z.number().int().positive(),
  }).passthrough(),
}).passthrough();

function compatible(left: BacktestRunBundle, right: BacktestRunBundle): boolean {
  const a = left.chatEvidence;
  const b = right.chatEvidence;
  const leftReport = ComparisonIdentitySchema.safeParse(left.savedRun.report);
  const rightReport = ComparisonIdentitySchema.safeParse(right.savedRun.report);
  return leftReport.success && rightReport.success &&
    leftReport.data.engineVersion === rightReport.data.engineVersion &&
    leftReport.data.split.trainingEndDate === rightReport.data.split.trainingEndDate &&
    leftReport.data.split.outOfSampleStartDate === rightReport.data.split.outOfSampleStartDate &&
    leftReport.data.split.embargoBars === rightReport.data.split.embargoBars &&
    a.datasetNormalizedHash === b.datasetNormalizedHash && a.strategyVersion === b.strategyVersion &&
    a.quoteSymbol === b.quoteSymbol && a.period.startDate === b.period.startDate && a.period.endDate === b.period.endDate;
}

export function compareRunEvidence(current: BacktestRunBundle, baseline: BacktestRunBundle): EvidenceComparison {
  if (!compatible(current, baseline)) return { compatible: false, detail: "Blocked: dataset, engine, strategy, quote currency, or evaluation split differs." };
  const candidate = current.chatEvidence.metrics;
  const reference = baseline.chatEvidence.metrics;
  return {
    compatible: true,
    detail: [
      `strategy ${subtract(candidate.strategyReturnBps, reference.strategyReturnBps)} bps`,
      `benchmark ${subtract(candidate.benchmarkReturnBps, reference.benchmarkReturnBps)} bps`,
      `drawdown ${subtract(candidate.maxDrawdownBps, reference.maxDrawdownBps)} bps`,
      `cost ${subtract(candidate.totalCostsQuote, reference.totalCostsQuote)} ${current.chatEvidence.quoteSymbol}`,
    ].join(" · "),
  };
}

function bps(value: string): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric >= 0 ? "+" : ""}${(numeric / 100).toFixed(2)}%` : `${value} bps`;
}

export function savedRunRows(current: BacktestRunBundle | undefined, saved: readonly StoredBacktestRun[]): readonly SavedRunComparison[] {
  return saved.map(({ bundle }) => ({
    label: bundle.savedRun.label,
    runId: bundle.chatEvidence.runId,
    datasetFingerprint: bundle.chatEvidence.datasetNormalizedHash,
    strategyReturn: bps(bundle.chatEvidence.metrics.strategyReturnBps),
    benchmarkReturn: bps(bundle.chatEvidence.metrics.benchmarkReturnBps),
    maxDrawdown: `−${(Number(bundle.chatEvidence.metrics.maxDrawdownBps) / 100).toFixed(2)}%`,
    totalCosts: `${bundle.chatEvidence.metrics.totalCostsQuote} ${bundle.chatEvidence.quoteSymbol}`,
    compatible: current ? compatible(current, bundle) : false,
  }));
}
