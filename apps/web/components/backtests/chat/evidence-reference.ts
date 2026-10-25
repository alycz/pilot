import { z } from "zod";

export const BACKTEST_CHAT_QUERY_KEY = "pilot_backtest" as const;
export const BACKTEST_CHAT_REFERENCE_VERSION = "v1" as const;

const OpaqueRunIdSchema = z
  .string()
  .min(12)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/, "run id must be opaque and URL safe");
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "fingerprint must be a lowercase SHA-256 digest");
const StrategyVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "strategy version must be a bounded identifier");
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must use YYYY-MM-DD");
const SignedDecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/, "value must be a canonical decimal");
const NonNegativeDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/, "value must be a nonnegative canonical decimal");
const DisplayTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "display text must not contain control characters");

export const BacktestChatReferenceSchema = z
  .object({
    version: z.literal(BACKTEST_CHAT_REFERENCE_VERSION),
    runId: OpaqueRunIdSchema,
    resultFingerprint: Sha256Schema,
    datasetNormalizedHash: Sha256Schema,
    strategyVersion: StrategyVersionSchema,
  })
  .strict();

export type BacktestChatReference = z.infer<typeof BacktestChatReferenceSchema>;

/**
 * Minimal, non-authoritative evidence projected from an authorized saved-run
 * store. The lookup supplying this record is responsible for session access;
 * this adapter deliberately carries no wallet or permission identity.
 */
export const SavedBacktestChatEvidenceSchema = z
  .object({
    runId: OpaqueRunIdSchema,
    resultFingerprint: Sha256Schema,
    datasetNormalizedHash: Sha256Schema,
    strategyVersion: StrategyVersionSchema,
    datasetLabel: DisplayTextSchema,
    sourceKind: z.enum(["deterministic_fixture", "validated_historical", "saved_historical_report"]),
    sourceDisclosure: DisplayTextSchema,
    period: z
      .object({
        startDate: DateSchema,
        endDate: DateSchema,
      })
      .strict()
      .refine(({ startDate, endDate }) => startDate <= endDate, {
        message: "backtest period must be chronological",
        path: ["endDate"],
      }),
    quoteSymbol: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9._-]+$/),
    metrics: z
      .object({
        strategyReturnBps: SignedDecimalSchema,
        benchmarkReturnBps: SignedDecimalSchema,
        maxDrawdownBps: NonNegativeDecimalSchema,
        endingEquityQuote: NonNegativeDecimalSchema,
        totalCostsQuote: NonNegativeDecimalSchema,
        tradeCount: z.number().int().nonnegative().max(1_000_000),
      })
      .strict(),
  })
  .strict();

export type SavedBacktestChatEvidence = z.infer<typeof SavedBacktestChatEvidenceSchema>;

export const RESEARCH_ONLY_DISCLOSURE =
  "Saved deterministic research evidence only. It is not a live quote, forecast, permission, approval, transaction instruction, or authority to execute." as const;

export const BacktestChatEvidenceContextSchema = z.object({
  kind: z.literal("saved_backtest_research_evidence"),
  authority: z.literal("research_only"),
  reference: BacktestChatReferenceSchema,
  dataset: z.object({
    label: DisplayTextSchema,
    sourceKind: z.enum(["deterministic_fixture", "validated_historical", "saved_historical_report"]),
    sourceDisclosure: DisplayTextSchema,
    startDate: DateSchema,
    endDate: DateSchema,
  }).strict(),
  result: z.object({
    quoteSymbol: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9._-]+$/),
    strategyReturnBps: SignedDecimalSchema,
    benchmarkReturnBps: SignedDecimalSchema,
    maxDrawdownBps: NonNegativeDecimalSchema,
    endingEquityQuote: NonNegativeDecimalSchema,
    totalCostsQuote: NonNegativeDecimalSchema,
    tradeCount: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
  disclosure: z.literal(RESEARCH_ONLY_DISCLOSURE),
}).strict();

export type BacktestChatEvidenceContext = z.infer<typeof BacktestChatEvidenceContextSchema>;

export type BacktestEvidenceErrorCode =
  | "MALFORMED_REFERENCE"
  | "DUPLICATE_REFERENCE"
  | "RUN_NOT_FOUND"
  | "INVALID_SAVED_RECORD"
  | "REFERENCE_MISMATCH";

export class BacktestEvidenceError extends TypeError {
  readonly code: BacktestEvidenceErrorCode;

  constructor(code: BacktestEvidenceErrorCode, message: string) {
    super(message);
    this.name = "BacktestEvidenceError";
    this.code = code;
  }
}

function parseReferenceToken(token: string): BacktestChatReference {
  const [version, runId, resultFingerprint, datasetNormalizedHash, strategyVersion, ...extra] = token.split("~");
  if (extra.length > 0) {
    throw new BacktestEvidenceError("MALFORMED_REFERENCE", "backtest evidence reference has unexpected fields");
  }
  const parsed = BacktestChatReferenceSchema.safeParse({
    version,
    runId,
    resultFingerprint,
    datasetNormalizedHash,
    strategyVersion,
  });
  if (!parsed.success) {
    throw new BacktestEvidenceError("MALFORMED_REFERENCE", "backtest evidence reference is invalid");
  }
  return parsed.data;
}

/** Encodes identifiers only. No result, identity, or authority crosses the URL. */
export function encodeBacktestChatReference(input: unknown): string {
  const reference = BacktestChatReferenceSchema.parse(input);
  const token = [
    reference.version,
    reference.runId,
    reference.resultFingerprint,
    reference.datasetNormalizedHash,
    reference.strategyVersion,
  ].join("~");
  return new URLSearchParams({ [BACKTEST_CHAT_QUERY_KEY]: token }).toString();
}

export function decodeBacktestChatReference(query: string | URLSearchParams): BacktestChatReference {
  const params = typeof query === "string"
    ? new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)
    : query;
  const values = params.getAll(BACKTEST_CHAT_QUERY_KEY);
  if (values.length > 1) {
    throw new BacktestEvidenceError("DUPLICATE_REFERENCE", "multiple backtest evidence references are not allowed");
  }
  if (values.length !== 1) {
    throw new BacktestEvidenceError("MALFORMED_REFERENCE", "backtest evidence reference is missing");
  }
  return parseReferenceToken(values[0]!);
}

function referenceMatchesSavedRun(
  reference: BacktestChatReference,
  saved: SavedBacktestChatEvidence,
): boolean {
  return reference.runId === saved.runId &&
    reference.resultFingerprint === saved.resultFingerprint &&
    reference.datasetNormalizedHash === saved.datasetNormalizedHash &&
    reference.strategyVersion === saved.strategyVersion;
}

/**
 * Resolves an untrusted URL reference through a session-authorized saved-run
 * lookup. A parsed reference alone never becomes model context.
 */
export function resolveBacktestChatEvidence(
  referenceInput: unknown,
  lookupAuthorizedRun: (runId: string) => unknown,
): BacktestChatEvidenceContext {
  const parsedReference = BacktestChatReferenceSchema.safeParse(referenceInput);
  if (!parsedReference.success) {
    throw new BacktestEvidenceError("MALFORMED_REFERENCE", "backtest evidence reference is invalid");
  }
  const reference = parsedReference.data;
  const candidate = lookupAuthorizedRun(reference.runId);
  if (candidate === undefined || candidate === null) {
    throw new BacktestEvidenceError("RUN_NOT_FOUND", "saved backtest evidence is unavailable in this session");
  }
  const parsedSaved = SavedBacktestChatEvidenceSchema.safeParse(candidate);
  if (!parsedSaved.success) {
    throw new BacktestEvidenceError("INVALID_SAVED_RECORD", "saved backtest evidence record is invalid");
  }
  const saved = parsedSaved.data;
  if (!referenceMatchesSavedRun(reference, saved)) {
    throw new BacktestEvidenceError("REFERENCE_MISMATCH", "saved backtest evidence does not match its reference");
  }

  return {
    kind: "saved_backtest_research_evidence",
    authority: "research_only",
    reference,
    dataset: {
      label: saved.datasetLabel,
      sourceKind: saved.sourceKind,
      sourceDisclosure: saved.sourceDisclosure,
      startDate: saved.period.startDate,
      endDate: saved.period.endDate,
    },
    result: {
      quoteSymbol: saved.quoteSymbol,
      strategyReturnBps: saved.metrics.strategyReturnBps,
      benchmarkReturnBps: saved.metrics.benchmarkReturnBps,
      maxDrawdownBps: saved.metrics.maxDrawdownBps,
      endingEquityQuote: saved.metrics.endingEquityQuote,
      totalCostsQuote: saved.metrics.totalCostsQuote,
      tradeCount: saved.metrics.tradeCount,
    },
    disclosure: RESEARCH_ONLY_DISCLOSURE,
  };
}

export function resolveBacktestChatEvidenceFromQuery(
  query: string | URLSearchParams,
  lookupAuthorizedRun: (runId: string) => unknown,
): BacktestChatEvidenceContext {
  return resolveBacktestChatEvidence(decodeBacktestChatReference(query), lookupAuthorizedRun);
}
