import { z } from "zod";

import { canonicalJson, sha256Hex } from "../../lib/sha256-sync";

export const STRATEGY_DATASET_SCHEMA_VERSION = "pilot.strategy-dataset.v2" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const PositiveDecimalSchema = z
  .number()
  .finite()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeDecimalSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const ResearchAssetSchema = z
  .object({
    symbol: z.string().trim().min(1).max(24),
    currency: z.string().trim().min(3).max(40),
    issuer: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.currency === "XRP" && asset.issuer !== undefined) {
      context.addIssue({ code: "custom", path: ["issuer"], message: "XRP must not have an issuer" });
    }
    if (asset.currency !== "XRP" && !asset.issuer) {
      context.addIssue({ code: "custom", path: ["issuer"], message: "issued assets require an issuer" });
    }
  });

const ClobSnapshotSchema = z
  .object({
    ledger_index: z.number().int().positive().safe(),
    bid: PositiveDecimalSchema,
    ask: PositiveDecimalSchema,
    bid_liquidity_base: NonNegativeDecimalSchema,
    ask_liquidity_base: NonNegativeDecimalSchema,
  })
  .strict()
  .refine(({ bid, ask }) => ask >= bid, {
    path: ["ask"],
    message: "ask must be greater than or equal to bid",
  });

const AmmSnapshotSchema = z
  .object({
    ledger_index: z.number().int().positive().safe(),
    base_reserve: PositiveDecimalSchema,
    quote_reserve: PositiveDecimalSchema,
    trading_fee_bps: z.number().int().min(0).max(1_000),
  })
  .strict();

export const MarketObservationSchema = z
  .object({
    observation_id: IdentifierSchema,
    observed_at: z.string().datetime({ offset: true }),
    ledger_index: z.number().int().positive().safe(),
    clob: ClobSnapshotSchema.optional(),
    amm: AmmSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (!observation.clob && !observation.amm) {
      context.addIssue({ code: "custom", message: "at least one executable market snapshot is required" });
    }
    if (observation.clob && observation.clob.ledger_index !== observation.ledger_index) {
      context.addIssue({ code: "custom", path: ["clob", "ledger_index"], message: "CLOB quote must use the observation ledger" });
    }
    if (observation.amm && observation.amm.ledger_index !== observation.ledger_index) {
      context.addIssue({ code: "custom", path: ["amm", "ledger_index"], message: "AMM quote must use the observation ledger" });
    }
  });

const MissingIntervalSchema = z
  .object({
    after_observation_id: IdentifierSchema,
    missing_count: z.number().int().positive().max(100_000),
  })
  .strict();

export const StrategyDatasetSchema = z
  .object({
    schema_version: z.literal(STRATEGY_DATASET_SCHEMA_VERSION),
    dataset_id: IdentifierSchema,
    label: z.string().trim().min(1).max(120),
    source_kind: z.enum(["deterministic_fixture", "validated_historical"]),
    network: z.enum(["mainnet", "testnet", "devnet"]),
    base: ResearchAssetSchema,
    quote: ResearchAssetSchema,
    provenance: z
      .object({
        source_label: z.string().trim().min(1).max(160),
        collected_at: z.string().datetime({ offset: true }),
        content_digest: z.string().regex(/^[a-f0-9]{64}$/),
        methodology: z.string().trim().min(1).max(500),
      })
      .strict(),
    coverage: z
      .object({
        start_at: z.string().datetime({ offset: true }),
        end_at: z.string().datetime({ offset: true }),
        expected_interval_seconds: z.number().int().positive().max(86_400),
        alignment_tolerance_seconds: z.number().int().nonnegative().max(300),
        missing_intervals: z.array(MissingIntervalSchema).max(1_000),
      })
      .strict(),
    split: z
      .object({
        train_end_at: z.string().datetime({ offset: true }),
        out_of_sample_start_at: z.string().datetime({ offset: true }),
      })
      .strict(),
    observations: z.array(MarketObservationSchema).min(4).max(10_000),
  })
  .strict()
  .superRefine((dataset, context) => {
    if (
      dataset.base.currency === dataset.quote.currency &&
      dataset.base.issuer === dataset.quote.issuer
    ) {
      context.addIssue({ code: "custom", path: ["quote"], message: "base and quote assets must differ" });
    }

    const first = dataset.observations[0]!;
    const last = dataset.observations.at(-1)!;
    if (dataset.coverage.alignment_tolerance_seconds > dataset.coverage.expected_interval_seconds / 4) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "alignment_tolerance_seconds"],
        message: "alignment tolerance must not exceed one quarter of the expected interval",
      });
    }
    if (dataset.coverage.start_at !== first.observed_at) {
      context.addIssue({ code: "custom", path: ["coverage", "start_at"], message: "coverage must start at the first observation" });
    }
    if (dataset.coverage.end_at !== last.observed_at) {
      context.addIssue({ code: "custom", path: ["coverage", "end_at"], message: "coverage must end at the last observation" });
    }

    const ids = new Set<string>();
    const actualMissing: Array<{ after_observation_id: string; missing_count: number }> = [];
    for (let index = 0; index < dataset.observations.length; index += 1) {
      const current = dataset.observations[index]!;
      if (ids.has(current.observation_id)) {
        context.addIssue({ code: "custom", path: ["observations", index, "observation_id"], message: "observation ids must be unique" });
      }
      ids.add(current.observation_id);
      if (index === 0) continue;
      const previous = dataset.observations[index - 1]!;
      const previousTime = Date.parse(previous.observed_at);
      const currentTime = Date.parse(current.observed_at);
      if (currentTime <= previousTime) {
        context.addIssue({ code: "custom", path: ["observations", index, "observed_at"], message: "observation times must increase strictly" });
      }
      if (current.ledger_index <= previous.ledger_index) {
        context.addIssue({ code: "custom", path: ["observations", index, "ledger_index"], message: "ledger indexes must increase strictly" });
      }
      const elapsedSeconds = (currentTime - previousTime) / 1_000;
      const elapsedIntervals = Math.round(elapsedSeconds / dataset.coverage.expected_interval_seconds);
      const alignmentError = Math.abs(
        elapsedSeconds - elapsedIntervals * dataset.coverage.expected_interval_seconds,
      );
      if (elapsedIntervals < 1 || alignmentError > dataset.coverage.alignment_tolerance_seconds) {
        context.addIssue({
          code: "custom",
          path: ["observations", index, "observed_at"],
          message: "observation timestamp is outside the declared interval alignment tolerance",
        });
      }
      const missingCount = Math.max(0, elapsedIntervals - 1);
      if (missingCount > 0) actualMissing.push({ after_observation_id: previous.observation_id, missing_count: missingCount });
    }
    if (JSON.stringify(actualMissing) !== JSON.stringify(dataset.coverage.missing_intervals)) {
      context.addIssue({ code: "custom", path: ["coverage", "missing_intervals"], message: "declared missing intervals must match the observation timeline" });
    }

    const trainEnd = Date.parse(dataset.split.train_end_at);
    const outOfSampleStart = Date.parse(dataset.split.out_of_sample_start_at);
    const observationTimes = dataset.observations.map(({ observed_at }) => Date.parse(observed_at));
    if (trainEnd >= outOfSampleStart) {
      context.addIssue({ code: "custom", path: ["split"], message: "training and out-of-sample windows must not overlap" });
    }
    if (!observationTimes.includes(trainEnd)) {
      context.addIssue({ code: "custom", path: ["split", "train_end_at"], message: "training boundary must identify an observation" });
    }
    if (!observationTimes.includes(outOfSampleStart)) {
      context.addIssue({ code: "custom", path: ["split", "out_of_sample_start_at"], message: "out-of-sample boundary must identify an observation" });
    }
    if (observationTimes.filter((time) => time <= trainEnd).length < 2) {
      context.addIssue({ code: "custom", path: ["split", "train_end_at"], message: "training window requires at least two observations" });
    }
    if (observationTimes.filter((time) => time >= outOfSampleStart).length < 2) {
      context.addIssue({ code: "custom", path: ["split", "out_of_sample_start_at"], message: "out-of-sample window requires at least two observations" });
    }
  });

export type ResearchAsset = z.infer<typeof ResearchAssetSchema>;
export type MarketObservation = z.infer<typeof MarketObservationSchema>;
export type StrategyDataset = z.infer<typeof StrategyDatasetSchema>;

export type HistoricalDatasetTrust = Readonly<{
  trustedSources: readonly Readonly<{
    sourceLabel: string;
    contentDigest: string;
  }>[];
}>;

function digestPayload(dataset: StrategyDataset): unknown {
  const provenance: Omit<StrategyDataset["provenance"], "content_digest"> = {
    source_label: dataset.provenance.source_label,
    collected_at: dataset.provenance.collected_at,
    methodology: dataset.provenance.methodology,
  };
  return {
    ...dataset,
    provenance,
  };
}

/** SHA-256 over the canonical complete dataset, excluding only the digest field itself. */
export function strategyDatasetContentDigest(input: unknown): string {
  const dataset = StrategyDatasetSchema.parse(input);
  return sha256Hex(canonicalJson(digestPayload(dataset)));
}

export function parseStrategyDataset(
  input: unknown,
  historicalTrust?: HistoricalDatasetTrust,
): StrategyDataset {
  const dataset = StrategyDatasetSchema.parse(input);
  const computedDigest = sha256Hex(canonicalJson(digestPayload(dataset)));
  if (computedDigest !== dataset.provenance.content_digest) {
    throw new TypeError("dataset content digest does not match its canonical payload");
  }
  if (dataset.source_kind === "validated_historical") {
    const trusted = historicalTrust?.trustedSources.some((source) =>
      source.sourceLabel === dataset.provenance.source_label &&
      source.contentDigest === computedDigest,
    ) ?? false;
    if (!trusted) {
      throw new TypeError("validated historical data requires an externally trusted source and digest");
    }
  }
  return dataset;
}

export type DatasetCoverage = {
  observed: number;
  expected: number;
  missing: number;
  coveragePercent: number;
};

export function datasetCoverage(
  datasetInput: unknown,
  historicalTrust?: HistoricalDatasetTrust,
): DatasetCoverage {
  const dataset = parseStrategyDataset(datasetInput, historicalTrust);
  const missing = dataset.coverage.missing_intervals.reduce((sum, gap) => sum + gap.missing_count, 0);
  const expected = dataset.observations.length + missing;
  return {
    observed: dataset.observations.length,
    expected,
    missing,
    coveragePercent: expected === 0 ? 0 : Number(((dataset.observations.length / expected) * 100).toFixed(2)),
  };
}
