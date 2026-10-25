import { verifyReproducibilityReport, type ReproducibilityReport } from "./report";

export type ComparisonIncompatibilityCode =
  | "dataset_mismatch"
  | "strategy_mismatch"
  | "engine_mismatch"
  | "currency_mismatch"
  | "split_mismatch";

export type RunComparison = Readonly<{
  compatible: true;
  baselineRunId: string;
  candidateRunId: string;
  outOfSampleDelta: Readonly<{
    totalReturnBps: string;
    benchmarkReturnBps: string;
    excessReturnBps: string;
    maxDrawdownBps: string;
    totalCostsQuote: string;
    tradeCount: number;
  }>;
}> | Readonly<{
  compatible: false;
  reasons: readonly Readonly<{
    code: ComparisonIncompatibilityCode;
    message: string;
  }>[];
}>;

function decimalParts(value: string): { units: bigint; scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const units = BigInt(`${whole}${fraction}` || "0") * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

function decimalDifference(candidate: string, baseline: string): string {
  const left = decimalParts(candidate);
  const right = decimalParts(baseline);
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = left.units * 10n ** BigInt(scale - left.scale);
  const rightUnits = right.units * 10n ** BigInt(scale - right.scale);
  const difference = leftUnits - rightUnits;
  const negative = difference < 0;
  const absolute = (negative ? -difference : difference).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${absolute}`;
  const whole = absolute.slice(0, -scale) || "0";
  const fraction = absolute.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function compareSavedRuns(baselineInput: unknown, candidateInput: unknown): RunComparison {
  const baseline = verifyReproducibilityReport(baselineInput);
  const candidate = verifyReproducibilityReport(candidateInput);
  const reasons: Array<{ code: ComparisonIncompatibilityCode; message: string }> = [];
  if (baseline.dataset.normalizedHashSha256 !== candidate.dataset.normalizedHashSha256) {
    reasons.push({ code: "dataset_mismatch", message: "Runs use different normalized datasets and cannot be compared as one experiment." });
  }
  if (
    baseline.strategy.strategyId !== candidate.strategy.strategyId ||
    baseline.strategy.strategyVersion !== candidate.strategy.strategyVersion
  ) {
    reasons.push({ code: "strategy_mismatch", message: "Runs use different strategy identities or versions." });
  }
  if (baseline.engineVersion !== candidate.engineVersion) {
    reasons.push({ code: "engine_mismatch", message: "Runs use different deterministic engine versions." });
  }
  if (
    baseline.costs.quoteCurrency !== candidate.costs.quoteCurrency ||
    baseline.result.quoteCurrency !== candidate.result.quoteCurrency
  ) {
    reasons.push({ code: "currency_mismatch", message: "Runs report results in different quote currencies." });
  }
  if (
    baseline.split.trainingEndDate !== candidate.split.trainingEndDate ||
    baseline.split.outOfSampleStartDate !== candidate.split.outOfSampleStartDate ||
    baseline.split.embargoBars !== candidate.split.embargoBars
  ) {
    reasons.push({ code: "split_mismatch", message: "Runs use different chronological split or embargo boundaries." });
  }
  if (reasons.length > 0) return { compatible: false, reasons };

  const left = baseline.result.outOfSample;
  const right = candidate.result.outOfSample;
  return {
    compatible: true,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    outOfSampleDelta: {
      totalReturnBps: decimalDifference(right.totalReturnBps, left.totalReturnBps),
      benchmarkReturnBps: decimalDifference(right.benchmarkReturnBps, left.benchmarkReturnBps),
      excessReturnBps: decimalDifference(right.excessReturnBps, left.excessReturnBps),
      maxDrawdownBps: decimalDifference(right.maxDrawdownBps, left.maxDrawdownBps),
      totalCostsQuote: decimalDifference(right.totalCostsQuote, left.totalCostsQuote),
      tradeCount: right.tradeCount - left.tradeCount,
    },
  };
}
