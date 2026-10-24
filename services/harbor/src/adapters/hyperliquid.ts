import { z } from "zod";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_TIMEOUT_MS = 8_000;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const DecimalStringSchema = z.string().regex(DECIMAL_PATTERN);
const NullableDecimalStringSchema = DecimalStringSchema.nullable();

const PerpMetadataSchema = z
  .object({
    name: z.string().trim().min(1),
    szDecimals: z.number().int().nonnegative(),
    maxLeverage: z.number().int().positive(),
    marginTableId: z.number().int().nonnegative().optional(),
    onlyIsolated: z.boolean().optional(),
    isDelisted: z.boolean().optional(),
    marginMode: z.string().trim().min(1).optional(),
  })
  .passthrough();

const PerpAssetContextSchema = z
  .object({
    dayNtlVlm: DecimalStringSchema,
    funding: DecimalStringSchema,
    impactPxs: z
      .tuple([DecimalStringSchema, DecimalStringSchema])
      .nullable(),
    markPx: DecimalStringSchema,
    midPx: NullableDecimalStringSchema,
    openInterest: DecimalStringSchema,
    oraclePx: DecimalStringSchema,
    premium: NullableDecimalStringSchema,
    prevDayPx: DecimalStringSchema,
    dayBaseVlm: DecimalStringSchema.optional(),
  })
  .passthrough();

// Hyperliquid documents metaAndAssetCtxs as a two-item positional response:
// metadata.universe[i] describes assetContexts[i]. Unknown upstream fields are
// accepted for forwards compatibility, then discarded by normalizeMarket.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals#retrieve-perpetuals-asset-contexts-includes-mark-price-current-funding-open-interest-etc
const MetaAndAssetContextsSchema = z
  .tuple([
    z
      .object({
        universe: z.array(PerpMetadataSchema),
      })
      .passthrough(),
    z.array(PerpAssetContextSchema),
  ])
  .superRefine(([metadata, contexts], refinement) => {
    if (metadata.universe.length !== contexts.length) {
      refinement.addIssue({
        code: "custom",
        message: "universe and asset context lengths do not match",
      });
    }
    const names = new Set<string>();
    for (const [index, market] of metadata.universe.entries()) {
      const normalizedName = market.name.toUpperCase();
      if (names.has(normalizedName)) {
        refinement.addIssue({
          code: "custom",
          path: [0, "universe", index, "name"],
          message: "perpetual market names must be unique",
        });
      }
      names.add(normalizedName);
    }
  });

type FetchLike = typeof globalThis.fetch;
type ValidatedMetadata = z.infer<typeof PerpMetadataSchema>;
type ValidatedContext = z.infer<typeof PerpAssetContextSchema>;

export const HyperliquidPerpMarketSchema = z
  .object({
    coin: z.string().trim().min(1),
    szDecimals: z.number().int().nonnegative(),
    maxLeverage: z.number().int().positive(),
    onlyIsolated: z.boolean(),
    isDelisted: z.boolean(),
    marginTableId: z.number().int().nonnegative().optional(),
    marginMode: z.string().trim().min(1).optional(),
    dayNtlVlm: DecimalStringSchema,
    funding: DecimalStringSchema,
    impactPxs: z
      .tuple([DecimalStringSchema, DecimalStringSchema])
      .nullable(),
    markPx: DecimalStringSchema,
    midPx: NullableDecimalStringSchema,
    openInterest: DecimalStringSchema,
    oraclePx: DecimalStringSchema,
    premium: NullableDecimalStringSchema,
    prevDayPx: DecimalStringSchema,
    dayBaseVlm: DecimalStringSchema.optional(),
  })
  .strict();

export const HyperliquidPerpMarketsSchema = z.array(
  HyperliquidPerpMarketSchema,
);
export type HyperliquidPerpMarket = z.infer<
  typeof HyperliquidPerpMarketSchema
>;

export type HyperliquidErrorCode =
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "TRANSPORT_ERROR";

/** A normalized error that never includes response bodies or fetch errors. */
export class HyperliquidError extends Error {
  readonly service = "hyperliquid";

  constructor(
    readonly code: HyperliquidErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HyperliquidError";
  }
}

export type HyperliquidOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
};

/** Validate any market reader output at the operation trust boundary. */
export function parseHyperliquidMarkets(
  value: unknown,
): HyperliquidPerpMarket[] {
  const parsed = HyperliquidPerpMarketsSchema.safeParse(value);
  if (!parsed.success) {
    throw new HyperliquidError(
      "INVALID_RESPONSE",
      "Hyperliquid returned invalid normalized market data",
    );
  }
  return parsed.data;
}

function normalizeMarket(
  metadata: ValidatedMetadata,
  context: ValidatedContext,
): HyperliquidPerpMarket {
  return {
    coin: metadata.name,
    szDecimals: metadata.szDecimals,
    maxLeverage: metadata.maxLeverage,
    onlyIsolated: metadata.onlyIsolated ?? false,
    isDelisted: metadata.isDelisted ?? false,
    ...(metadata.marginTableId === undefined
      ? {}
      : { marginTableId: metadata.marginTableId }),
    ...(metadata.marginMode === undefined
      ? {}
      : { marginMode: metadata.marginMode }),
    dayNtlVlm: context.dayNtlVlm,
    funding: context.funding,
    impactPxs: context.impactPxs,
    markPx: context.markPx,
    midPx: context.midPx,
    openInterest: context.openInterest,
    oraclePx: context.oraclePx,
    premium: context.premium,
    prevDayPx: context.prevDayPx,
    ...(context.dayBaseVlm === undefined
      ? {}
      : { dayBaseVlm: context.dayBaseVlm }),
  };
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new HyperliquidError(
        "RESPONSE_TOO_LARGE",
        "Hyperliquid response exceeded the size limit",
      );
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new HyperliquidError(
      "INVALID_RESPONSE",
      "Hyperliquid returned an empty response",
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HyperliquidError(
          "RESPONSE_TOO_LARGE",
          "Hyperliquid response exceeded the size limit",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HyperliquidError) throw error;
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) {
      throw new HyperliquidError("TIMEOUT", "Hyperliquid request timed out");
    }
    throw new HyperliquidError(
      "TRANSPORT_ERROR",
      "Hyperliquid response could not be read",
    );
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new HyperliquidError(
      "INVALID_RESPONSE",
      "Hyperliquid returned malformed JSON",
    );
  }
}

/**
 * Build the sole Hyperliquid integration used by Harbor. The request body is
 * fixed to the read-only Info API method; this adapter intentionally provides
 * no exchange/order method and accepts no user-controlled URL or request body.
 */
export function createHyperliquidMarkets(
  options: HyperliquidOptions = {},
): () => Promise<HyperliquidPerpMarket[]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? HYPERLIQUID_TIMEOUT_MS;

  if (typeof fetcher !== "function") {
    throw new TypeError("fetch must be a function");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }

  return async (): Promise<HyperliquidPerpMarket[]> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new HyperliquidError("TIMEOUT", "Hyperliquid request timed out"),
        );
      }, timeoutMs);
    });

    const requestPromise = (async () => {
      let response: Response;
      try {
        // The official public Info API uses POST with this exact read method.
        // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals#retrieve-perpetuals-asset-contexts-includes-mark-price-current-funding-open-interest-etc
        response = await fetcher(HYPERLIQUID_INFO_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new HyperliquidError(
            "TIMEOUT",
            "Hyperliquid request timed out",
          );
        }
        throw new HyperliquidError(
          "TRANSPORT_ERROR",
          "Hyperliquid request failed",
        );
      }

      if (!response.ok) {
        throw new HyperliquidError(
          "HTTP_ERROR",
          `Hyperliquid returned HTTP ${response.status}`,
        );
      }

      const parsed = MetaAndAssetContextsSchema.safeParse(
        await responseJson(response, controller.signal),
      );
      if (!parsed.success) {
        throw new HyperliquidError(
          "INVALID_RESPONSE",
          "Hyperliquid returned an invalid market response",
        );
      }

      const [metadata, contexts] = parsed.data;
      return parseHyperliquidMarkets(
        metadata.universe.map((market, index) =>
          normalizeMarket(market, contexts[index]!),
        ),
      );
    })();

    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

export const fetchHyperliquidMarkets = createHyperliquidMarkets();
