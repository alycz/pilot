import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { NetworkSchema, type Network } from "../contracts";

export const INDEXER_TIMEOUT_MS = 8_000;
export const INDEXER_MAX_RESPONSE_BYTES = 2_000_000;

export type IndexerSource = "xrpl.to" | "xrpscan" | "bithomp";

export type TokenMetadata = {
  currency: string;
  issuer: string;
  code?: string;
  name?: string;
  description?: string;
  icon?: string;
  verified?: boolean;
  kyc?: boolean;
  holders?: number;
  trustlines?: number;
  supply?: string;
  marketCapXrp?: string;
  priceXrp?: string;
  volume24hXrp?: string;
  trendingScore?: number;
  assessmentScore?: number;
};

export type FlaggedToken = {
  issuer: string;
  reason: "verified-blocklist";
};

export type IndexerAsset = {
  currency: string;
  issuer?: string;
};

export type AmmPool = {
  id: string;
  account?: string;
  asset1: IndexerAsset;
  asset2: IndexerAsset;
  tradingFee?: number;
  liquidityXrp?: number;
  volume24hXrp?: number;
  volume7dXrp?: number;
  fees24hXrp?: number;
  apy7d?: number;
};

export type IndexerResult<T> = {
  source: IndexerSource;
  data: T;
};

export interface Indexer {
  lookupToken(args: {
    currency: string;
    issuer: string;
    network?: Network;
  }): Promise<IndexerResult<TokenMetadata>>;
  trendingTokens(args: {
    limit: number;
  }): Promise<IndexerResult<TokenMetadata[]>>;
  flaggedTokens(args: {
    limit: number;
  }): Promise<IndexerResult<FlaggedToken[]>>;
  ammPools(args: { limit: number }): Promise<IndexerResult<AmmPool[]>>;
}

export type IndexerEnv = Partial<
  Record<"XRPLTO_API_KEY" | "BITHOMP_API_KEY", string>
>;

export type IndexerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CreateIndexerOptions = {
  fetcher?: IndexerFetch;
  env?: IndexerEnv;
  timeoutMs?: number;
  maxResponseBytes?: number;
  baseUrls?: Partial<Record<IndexerSource, string>>;
};

type IndexerAttempt = {
  source: IndexerSource;
  code: string;
};

/** A secret-safe summary of a failed fallback chain. */
export class IndexerError extends Error {
  readonly service = "indexer";
  readonly code = "INDEXER_UNAVAILABLE";

  constructor(readonly attempts: readonly IndexerAttempt[]) {
    super("Every compatible indexer rejected or failed the request");
    this.name = "IndexerError";
  }
}

class ProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderError";
  }
}

const NumericStringSchema = z
  .string()
  .trim()
  .max(128)
  .regex(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/);
const NumberLikeSchema = z.union([z.number().finite(), NumericStringSchema]);
const OptionalNumberLikeSchema = NumberLikeSchema.nullish();
const LimitSchema = z.number().int().min(1).max(100);
const ClassicAddressSchema = z
  .string()
  .min(25)
  .max(35)
  .refine(isValidClassicAddress);
const CurrencySchema = z
  .string()
  .trim()
  .refine(
    (currency) =>
      /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3,20}$/.test(currency) ||
      /^[A-Fa-f0-9]{40}$/.test(currency),
  );
const ShortTextSchema = z.string().max(256);
const DescriptionSchema = z.string().max(10_000);
const IconSchema = z.string().max(2_048);
const CountSchema = z.number().int().nonnegative().safe();
const LookupSchema = z
  .object({
    currency: CurrencySchema,
    issuer: ClassicAddressSchema,
    network: NetworkSchema.optional().default("mainnet"),
  })
  .strict();

const XrplToTokenSchema = z
  .object({
    issuer: ClassicAddressSchema,
    currency: CurrencySchema,
    name: ShortTextSchema.nullish(),
    description: DescriptionSchema.nullish(),
    icon: IconSchema.nullish(),
    verified: z.union([z.boolean(), z.number()]).nullish(),
    kyc: z.boolean().nullish(),
    holders: CountSchema.nullish(),
    trustlines: CountSchema.nullish(),
    supply: OptionalNumberLikeSchema,
    marketcap: OptionalNumberLikeSchema,
    exch: OptionalNumberLikeSchema,
    vol24hxrp: OptionalNumberLikeSchema,
    vol24h: OptionalNumberLikeSchema,
    trendingScore: z.number().finite().nullish(),
    assessmentScore: z.number().finite().nullish(),
  })
  .passthrough();

const XrplToTokenResponseSchema = z
  .object({ success: z.literal(true), token: XrplToTokenSchema })
  .passthrough();
const XrplToTokensResponseSchema = z
  .object({
    success: z.literal(true),
    tokens: z.array(XrplToTokenSchema).max(100),
  })
  .passthrough();

const XrpScanMetaTokenSchema = z
  .object({
    name: ShortTextSchema.nullish(),
    description: DescriptionSchema.nullish(),
    icon: IconSchema.nullish(),
  })
  .passthrough();
const XrpScanMetaIssuerSchema = z
  .object({ kyc: z.boolean().nullish() })
  .passthrough();
const XrpScanTokenSchema = z
  .object({
    code: ShortTextSchema.min(1),
    currency: CurrencySchema,
    issuer: ClassicAddressSchema,
    holders: CountSchema.nullish(),
    supply: OptionalNumberLikeSchema,
    marketcap: OptionalNumberLikeSchema,
    price: OptionalNumberLikeSchema,
    meta: z
      .object({
        token: XrpScanMetaTokenSchema.nullish(),
        issuer: XrpScanMetaIssuerSchema.nullish(),
      })
      .passthrough()
      .nullish(),
    metrics: z
      .object({
        trustlines: CountSchema.nullish(),
        holders: CountSchema.nullish(),
        supply: OptionalNumberLikeSchema,
        marketcap: OptionalNumberLikeSchema,
        price: OptionalNumberLikeSchema,
        volume_24h: OptionalNumberLikeSchema,
      })
      .passthrough()
      .nullish(),
    score: z.number().finite().nullish(),
    IssuingAccount: z
      .object({ verified: z.boolean().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const BithompTokenSchema = z
  .object({
    issuer: ClassicAddressSchema,
    currency: CurrencySchema,
    name: ShortTextSchema.nullish(),
    description: DescriptionSchema.nullish(),
    icon: IconSchema.nullish(),
    kyc: z.boolean().nullish(),
    holders: CountSchema.nullish(),
    trustlines: CountSchema.nullish(),
    supply: OptionalNumberLikeSchema,
    rating: z.number().finite().nullish(),
    priceNativeCurrencySpot: OptionalNumberLikeSchema,
    statistics: z
      .object({
        priceNativeCurrency: OptionalNumberLikeSchema,
        sellVolume: OptionalNumberLikeSchema,
        buyVolume: OptionalNumberLikeSchema,
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
const BithompTokensResponseSchema = z
  .object({ tokens: z.array(BithompTokenSchema).max(100) })
  .passthrough();

const AssetSchema = z
  .object({
    currency: CurrencySchema.or(z.literal("XRP")),
    issuer: ClassicAddressSchema.or(z.literal("XRPL")).nullish(),
  })
  .passthrough();
const AmountSchema = z.union([
  z.string().max(128).regex(/^\d+$/),
  z
    .object({
      currency: CurrencySchema,
      issuer: ClassicAddressSchema,
      value: NumericStringSchema,
    })
    .passthrough(),
]);

const XrplToYieldSchema = z
  .object({
    apy: z.number().finite().nullish(),
    volume: z.number().finite().nonnegative().nullish(),
    fees: z.number().finite().nonnegative().nullish(),
    liquidity: z.number().finite().nonnegative().nullish(),
  })
  .passthrough();
const XrplToPoolSchema = z
  .object({
    _id: z.string().min(1).max(128),
    ammAccount: ClassicAddressSchema.nullish(),
    asset1: AssetSchema,
    asset2: AssetSchema,
    tradingFee: z.number().int().nonnegative().nullish(),
    apy24h: XrplToYieldSchema.nullish(),
    apy7d: XrplToYieldSchema.nullish(),
  })
  .passthrough();
const XrplToPoolsResponseSchema = z
  .object({
    success: z.literal(true),
    pools: z.array(XrplToPoolSchema).max(100),
  })
  .passthrough();

const XrpScanPoolSchema = z
  .object({
    index: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    Account: ClassicAddressSchema,
    Asset: AssetSchema,
    Asset2: AssetSchema,
    TradingFee: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const BithompPoolSchema = z
  .object({
    ammID: z.string().min(1).max(128),
    account: ClassicAddressSchema.nullish(),
    amount: AmountSchema,
    amount2: AmountSchema,
    tradingFee: z.number().int().nonnegative().nullish(),
  })
  .passthrough();
const BithompPoolsResponseSchema = z
  .object({ amms: z.array(BithompPoolSchema).max(100) })
  .passthrough();

const XrplToFlaggedResponseSchema = z
  .object({
    success: z.literal(true),
    addresses: z.array(ClassicAddressSchema).max(50_000),
  })
  .passthrough();

const DEFAULT_BASE_URLS: Readonly<Record<IndexerSource, string>> = Object.freeze({
  "xrpl.to": "https://api.xrpl.to/v1/",
  xrpscan: "https://api.xrpscan.com/api/v1/",
  bithomp: "https://bithomp.com/api/v2/",
});

function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function numericString(value: string | number | null | undefined): string | undefined {
  return present(value) ? String(value) : undefined;
}

function sumNumericStrings(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): string | undefined {
  if (!present(left) || !present(right)) return undefined;
  const sum = Number(left) + Number(right);
  return Number.isFinite(sum) ? String(sum) : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function normalizeAsset(asset: z.infer<typeof AssetSchema>): IndexerAsset {
  return compact({
    currency: asset.currency,
    issuer:
      asset.currency === "XRP" || asset.issuer === "XRPL"
        ? undefined
        : (asset.issuer ?? undefined),
  });
}

function amountAsset(amount: z.infer<typeof AmountSchema>): IndexerAsset {
  return typeof amount === "string"
    ? { currency: "XRP" }
    : { currency: amount.currency, issuer: amount.issuer };
}

function xrplToToken(token: z.infer<typeof XrplToTokenSchema>): TokenMetadata {
  return compact({
    currency: token.currency,
    issuer: token.issuer,
    code: token.name ?? undefined,
    name: token.name ?? undefined,
    description: token.description ?? undefined,
    icon: token.icon ?? undefined,
    verified: present(token.verified)
      ? token.verified === true ||
        (typeof token.verified === "number" && token.verified > 0)
      : undefined,
    kyc: token.kyc ?? undefined,
    holders: token.holders ?? undefined,
    trustlines: token.trustlines ?? undefined,
    supply: numericString(token.supply),
    marketCapXrp: numericString(token.marketcap),
    priceXrp: numericString(token.exch),
    volume24hXrp: numericString(token.vol24hxrp ?? token.vol24h),
    trendingScore: token.trendingScore ?? undefined,
    assessmentScore: token.assessmentScore ?? undefined,
  });
}

function xrpScanToken(token: z.infer<typeof XrpScanTokenSchema>): TokenMetadata {
  return compact({
    currency: token.currency,
    issuer: token.issuer,
    code: token.code,
    name: token.meta?.token?.name ?? token.code,
    description: token.meta?.token?.description ?? undefined,
    icon: token.meta?.token?.icon ?? undefined,
    verified: token.IssuingAccount?.verified ?? undefined,
    kyc: token.meta?.issuer?.kyc ?? undefined,
    holders: token.metrics?.holders ?? token.holders ?? undefined,
    trustlines: token.metrics?.trustlines ?? undefined,
    supply: numericString(token.metrics?.supply ?? token.supply),
    marketCapXrp: numericString(token.metrics?.marketcap ?? token.marketcap),
    priceXrp: numericString(token.metrics?.price ?? token.price),
    volume24hXrp: numericString(token.metrics?.volume_24h),
    assessmentScore: token.score ?? undefined,
  });
}

function bithompToken(token: z.infer<typeof BithompTokenSchema>): TokenMetadata {
  return compact({
    currency: token.currency,
    issuer: token.issuer,
    name: token.name ?? undefined,
    description: token.description ?? undefined,
    icon: token.icon ?? undefined,
    kyc: token.kyc ?? undefined,
    holders: token.holders ?? undefined,
    trustlines: token.trustlines ?? undefined,
    supply: numericString(token.supply),
    priceXrp: numericString(
      token.priceNativeCurrencySpot ?? token.statistics?.priceNativeCurrency,
    ),
    volume24hXrp: sumNumericStrings(
      token.statistics?.sellVolume,
      token.statistics?.buyVolume,
    ),
    assessmentScore: token.rating ?? undefined,
  });
}

/** Convert a user-facing nonstandard code to the XRPL 160-bit currency form. */
export function ledgerCurrency(currency: string): string {
  if (/^[A-Fa-f0-9]{40}$/.test(currency) || currency.length === 3) {
    return currency;
  }
  const bytes = new TextEncoder().encode(currency);
  if (bytes.length === 0 || bytes.length > 20) {
    throw new ProviderError("INVALID_CURRENCY");
  }
  return [...bytes, ...new Array(20 - bytes.length).fill(0)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// XRPL.to defines Testnet token ids as MD5(issuer_currency). MD5 is used here
// only as the provider's non-security identifier, not for authentication.
export function xrplToTokenId(issuer: string, currency: string): string {
  const bytes = new TextEncoder().encode(`${issuer}_${currency}`);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true);

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from(
    { length: 64 },
    (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0,
  );
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let word: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        word = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        word = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        word = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        word = (7 * index) % 16;
      }
      const sum = (a + f + constants[index]! + view.getUint32(offset + word * 4, true)) | 0;
      const rotated = (sum << shifts[index]!) | (sum >>> (32 - shifts[index]!));
      [a, b, c, d] = [d, (b + rotated) | 0, b, c];
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0]
    .map((word) =>
      [0, 8, 16, 24]
        .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0"))
        .join(""),
    )
    .join("");
}

function codeFromCurrency(currency: string): string {
  if (!/^[A-Fa-f0-9]{40}$/.test(currency)) return currency;
  const bytes = currency.match(/.{2}/g)?.map((hex) => Number.parseInt(hex, 16)) ?? [];
  const end = bytes.indexOf(0);
  const decoded = new TextDecoder().decode(
    new Uint8Array(end === -1 ? bytes : bytes.slice(0, end)),
  );
  return /^[\x20-\x7E]{3,20}$/.test(decoded) ? decoded : currency.toUpperCase();
}

function matchingToken(
  token: TokenMetadata,
  issuer: string,
  onLedgerCurrency: string,
): TokenMetadata {
  let tokenCurrency: string;
  try {
    tokenCurrency = ledgerCurrency(token.currency);
  } catch {
    throw new ProviderError("TOKEN_IDENTITY_MISMATCH");
  }
  if (
    token.issuer !== issuer ||
    tokenCurrency.toUpperCase() !== onLedgerCurrency.toUpperCase()
  ) {
    throw new ProviderError("TOKEN_IDENTITY_MISMATCH");
  }
  return token;
}

function providerCode(error: unknown): string {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof z.ZodError) return "INVALID_RESPONSE";
  return "REQUEST_FAILED";
}

async function withFallback<T>(
  attempts: readonly [IndexerSource, () => Promise<T>][],
): Promise<IndexerResult<T>> {
  const failures: IndexerAttempt[] = [];
  for (const [source, request] of attempts) {
    try {
      return { source, data: await request() };
    } catch (error) {
      failures.push({ source, code: providerCode(error) });
    }
  }
  throw new IndexerError(failures);
}

export function createIndexer(options: CreateIndexerOptions = {}): Indexer {
  const fetcher = options.fetcher ?? fetch;
  const env = options.env ?? {};
  const timeoutMs = options.timeoutMs ?? INDEXER_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? INDEXER_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new RangeError("maxResponseBytes must be a positive safe integer");
  }

  const bases = { ...DEFAULT_BASE_URLS, ...options.baseUrls };

  async function get(
    source: IndexerSource,
    path: string,
    baseOverride?: string,
  ): Promise<unknown> {
    const base = baseOverride ?? bases[source];
    const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
    const headers = new Headers({ accept: "application/json" });
    const key =
      source === "xrpl.to"
        ? env.XRPLTO_API_KEY?.trim()
        : source === "bithomp"
          ? env.BITHOMP_API_KEY?.trim()
          : undefined;
    if (key) {
      headers.set(source === "xrpl.to" ? "x-api-key" : "x-bithomp-token", key);
    }

    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => undefined);
        reject(new ProviderError("TIMEOUT"));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetcher(url, {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        }).catch(() => {
          throw new ProviderError("TRANSPORT_ERROR");
        }),
        timeout,
      ]);
      if (!response.ok) throw new ProviderError(`HTTP_${response.status}`);

      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength)) {
          throw new ProviderError("INVALID_CONTENT_LENGTH");
        }
        if (Number(declaredLength) > maxResponseBytes) {
          throw new ProviderError("RESPONSE_TOO_LARGE");
        }
      }
      if (!response.body) throw new ProviderError("MALFORMED_JSON");

      reader = response.body.getReader();
      const readBody = async (): Promise<Uint8Array> => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader!.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxResponseBytes) {
            throw new ProviderError("RESPONSE_TOO_LARGE");
          }
          chunks.push(value);
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return body;
      };
      const body = await Promise.race([readBody(), timeout]);
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
        );
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("MALFORMED_JSON");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return Object.freeze({
    lookupToken({
      currency,
      issuer,
      network,
    }: {
      currency: string;
      issuer: string;
      network?: Network;
    }) {
      ({ currency, issuer, network } = LookupSchema.parse({
        currency,
        issuer,
        network,
      }));
      const onLedgerCurrency = ledgerCurrency(currency);
      const displayCode = codeFromCurrency(currency);
      // XRPL.to accepts issuer_currency as a token id:
      // https://xrpl.to/docs/token/get-token-id
      return withFallback([
        [
          "xrpl.to",
          async () => {
            if (network !== "mainnet" && network !== "testnet") {
              throw new ProviderError("UNSUPPORTED_NETWORK");
            }
            const path =
              network === "testnet"
                ? `testnet/tokens/${xrplToTokenId(issuer, onLedgerCurrency)}`
                : `token/${encodeURIComponent(`${issuer}_${onLedgerCurrency}`)}?desc=yes&skip_metrics=true`;
            // Testnet ids and response contract:
            // https://xrpl.to/docs/testnet/get-testnet-tokens-md5
            const response = XrplToTokenResponseSchema.parse(
              await get("xrpl.to", path),
            );
            return matchingToken(
              xrplToToken(response.token),
              issuer,
              onLedgerCurrency,
            );
          },
        ],
        [
          "xrpscan",
          async () => {
            if (network !== "mainnet") {
              throw new ProviderError("UNSUPPORTED_NETWORK");
            }
            // https://docs.xrpscan.com/api-documentation/token/token-info
            const response = XrpScanTokenSchema.parse(
              await get(
                "xrpscan",
                `token/${encodeURIComponent(`${displayCode}.${issuer}`)}`,
              ),
            );
            return matchingToken(
              xrpScanToken(response),
              issuer,
              onLedgerCurrency,
            );
          },
        ],
        [
          "bithomp",
          async () => {
            // https://docs.bithomp.com/ documents GET /v2/token/<issuer>/<currency>.
            // It publishes distinct mainnet, testnet, and devnet API hosts.
            if (network === "lending-devnet") {
              throw new ProviderError("UNSUPPORTED_NETWORK");
            }
            const documentedBase =
              network === "testnet"
                ? "https://test.bithomp.com/api/v2/"
                : network === "devnet"
                  ? "https://dev.bithomp.com/api/v2/"
                  : undefined;
            const response = BithompTokenSchema.parse(
              await get(
                "bithomp",
                `token/${encodeURIComponent(issuer)}/${encodeURIComponent(onLedgerCurrency)}`,
                options.baseUrls?.bithomp ?? documentedBase,
              ),
            );
            return matchingToken(
              bithompToken(response),
              issuer,
              onLedgerCurrency,
            );
          },
        ],
      ]);
    },

    trendingTokens({ limit }: { limit: number }) {
      limit = LimitSchema.parse(limit);
      return withFallback([
        [
          "xrpl.to",
          async () => {
            // https://xrpl.to/docs/tokens/get-tokens
            const response = XrplToTokensResponseSchema.parse(
              await get(
                "xrpl.to",
                `tokens?limit=${limit}&sort=trendingScore&order=desc&lightweight=true&skip_metrics=true`,
              ),
            );
            return response.tokens.slice(0, limit).map(xrplToToken);
          },
        ],
        [
          "xrpscan",
          async () => {
            // XRPSCAN has no trend score; its documented score ranking is the
            // closest provider-native discovery fallback.
            // https://docs.xrpscan.com/api-documentation/token/token-list
            const response = z.array(XrpScanTokenSchema).max(100).parse(
              await get(
                "xrpscan",
                `tokens?limit=${limit}&sort=score&direction=desc`,
              ),
            );
            return response.slice(0, limit).map(xrpScanToken);
          },
        ],
        [
          "bithomp",
          async () => {
            // https://docs.bithomp.com/ documents rating as the default token ranking.
            const response = BithompTokensResponseSchema.parse(
              await get(
                "bithomp",
                `trustlines/tokens?limit=${limit}&order=rating&lptokens=false`,
              ),
            );
            return response.tokens.slice(0, limit).map(bithompToken);
          },
        ],
      ]);
    },

    flaggedTokens({ limit }: { limit: number }) {
      limit = LimitSchema.parse(limit);
      return withFallback([
        [
          "xrpl.to",
          async () => {
            // This endpoint is the provider's verified, deduplicated blocklist:
            // https://xrpl.to/docs/scams/get-scams-addresses
            const response = XrplToFlaggedResponseSchema.parse(
              await get("xrpl.to", "scams/addresses"),
            );
            return response.addresses.slice(0, limit).map((issuer) => ({
              issuer,
              reason: "verified-blocklist" as const,
            }));
          },
        ],
        ["xrpscan", async () => Promise.reject(new ProviderError("UNSUPPORTED"))],
        ["bithomp", async () => Promise.reject(new ProviderError("UNSUPPORTED"))],
      ]);
    },

    ammPools({ limit }: { limit: number }) {
      limit = LimitSchema.parse(limit);
      return withFallback([
        [
          "xrpl.to",
          async () => {
            // https://xrpl.to/docs/token/get-amm
            const response = XrplToPoolsResponseSchema.parse(
              await get(
                "xrpl.to",
                `amm?limit=${limit}&status=active&sort=liquidity`,
              ),
            );
            return response.pools.slice(0, limit).map((pool) =>
              compact({
                id: pool._id,
                account: pool.ammAccount ?? undefined,
                asset1: normalizeAsset(pool.asset1),
                asset2: normalizeAsset(pool.asset2),
                tradingFee: pool.tradingFee ?? undefined,
                liquidityXrp:
                  pool.apy7d?.liquidity ?? pool.apy24h?.liquidity ?? undefined,
                volume24hXrp: pool.apy24h?.volume ?? undefined,
                volume7dXrp: pool.apy7d?.volume ?? undefined,
                fees24hXrp: pool.apy24h?.fees ?? undefined,
                apy7d: pool.apy7d?.apy ?? undefined,
              }),
            );
          },
        ],
        [
          "xrpscan",
          async () => {
            // https://docs.xrpscan.com/api-documentation/amm/pools
            const response = z.array(XrpScanPoolSchema).max(100).parse(
              await get("xrpscan", `amm/pools?limit=${limit}&offset=0`),
            );
            return response.slice(0, limit).map((pool) =>
              compact({
                id: pool.index,
                account: pool.Account,
                asset1: normalizeAsset(pool.Asset),
                asset2: normalizeAsset(pool.Asset2),
                tradingFee: pool.TradingFee ?? undefined,
              }),
            );
          },
        ],
        [
          "bithomp",
          async () => {
            // https://docs.bithomp.com/ documents GET /v2/amms.
            const response = BithompPoolsResponseSchema.parse(
              await get("bithomp", `amms?limit=${limit}`),
            );
            return response.amms.slice(0, limit).map((pool) =>
              compact({
                id: pool.ammID,
                account: pool.account ?? undefined,
                asset1: amountAsset(pool.amount),
                asset2: amountAsset(pool.amount2),
                tradingFee: pool.tradingFee ?? undefined,
              }),
            );
          },
        ],
      ]);
    },
  });
}
