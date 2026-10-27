import {
  quoteHash as officialQuoteHash,
  verifyQuoteSignature as verifyOfficialQuoteSignature,
  type OneClickQuoteResponse as OfficialOneClickQuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import { z } from "zod";

const ONE_CLICK_ORIGIN = "https://1click.chaindefuser.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_JSON_NODES = 100_000;

const PrintableTextSchema = z.string().trim().min(1).max(512)
  .regex(/^[\x21-\x7e]+$/, "must contain only visible ASCII characters");
const AssetIdSchema = z.string().trim().min(3).max(320)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:\S+$/, "must be a namespaced 1Click asset ID");
const AddressSchema = PrintableTextSchema;
const CorrelationIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "must be a safe provider correlation ID");
const BlockchainSchema = z.enum([
  "near", "eth", "base", "arb", "btc", "sol", "ton", "dash", "doge",
  "xrp", "zec", "gnosis", "bera", "bsc", "pol", "tron", "sui",
  "movement", "op", "avax", "stellar", "aptos", "cardano", "ltc",
  "xlayer", "monad", "bch", "adi", "plasma", "scroll", "starknet",
  "aleo", "hypercore", "fogo", "hood", "hlevm", "qtc", "abs",
]);
const AtomicAmountSchema = z.string().max(128)
  .regex(/^[1-9][0-9]*$/, "must be a positive atomic-unit integer string");
const AtomicAmountOrZeroSchema = z.string().max(128)
  .regex(/^(?:0|[1-9][0-9]*)$/, "must be an atomic-unit integer string");
const NonnegativeDecimalSchema = z.string().max(128)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, "must be a nonnegative decimal string");
const DateTimeSchema = z.string().datetime({ offset: true });
const QuoteHashSchema = z.string().min(43).max(45)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must be a Base58 quote hash");
const HttpsUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}, "must be an HTTPS URL without credentials");

export const ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE = Object.freeze({
  id: "arbitrum-usdc-to-near-wnear-v1",
  origin: Object.freeze({
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    blockchain: "arb",
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    decimals: 6,
    symbol: "USDC",
    chainId: 42161,
  }),
  destination: Object.freeze({
    assetId: "nep141:wrap.near",
    blockchain: "near",
    contractAddress: "wrap.near",
    decimals: 24,
    symbol: "wNEAR",
  }),
} as const);

/**
 * 1Click represents native NEAR with the canonical wrap.near asset ID. For a
 * managed 1Click ORIGIN_CHAIN quote, the service handles the native wrapping;
 * the owner funds the returned NEAR deposit account with native NEAR.
 */
export const ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE = Object.freeze({
  id: "near-native-to-arbitrum-usdc-v1",
  origin: Object.freeze({
    assetId: "nep141:wrap.near",
    blockchain: "near",
    contractAddress: "wrap.near",
    decimals: 24,
    symbol: "NEAR",
    fundingAsset: "native-near",
  }),
  destination: Object.freeze({
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    blockchain: "arb",
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    decimals: 6,
    symbol: "USDC",
    chainId: 42161,
  }),
} as const);

const QuoteRequestSchema = z.object({
  dry: z.boolean(),
  swapType: z.literal("EXACT_INPUT"),
  slippageTolerance: z.number().int().min(0).max(10_000),
  originAsset: AssetIdSchema,
  depositType: z.literal("ORIGIN_CHAIN"),
  destinationAsset: AssetIdSchema,
  amount: AtomicAmountSchema,
  refundTo: AddressSchema,
  refundType: z.literal("ORIGIN_CHAIN"),
  recipient: AddressSchema,
  recipientType: z.literal("DESTINATION_CHAIN"),
  deadline: DateTimeSchema,
  depositMode: z.enum(["SIMPLE", "MEMO"]).optional(),
  confidentiality: z.literal("public").optional(),
  quoteWaitingTimeMs: z.number().int().min(0).max(30_000).optional(),
  insured: z.literal(false).optional(),
}).strip().refine((request) => request.originAsset !== request.destinationAsset, {
  path: ["destinationAsset"],
  message: "origin and destination assets must differ",
});

const ChainDepositAddressSchema = z.object({
  blockchain: BlockchainSchema,
  address: AddressSchema,
  memo: PrintableTextSchema.optional(),
}).strip();

const QuoteSchema = z.object({
  amountIn: AtomicAmountSchema,
  amountInFormatted: NonnegativeDecimalSchema,
  amountInUsd: NonnegativeDecimalSchema,
  minAmountIn: AtomicAmountSchema,
  amountOut: AtomicAmountSchema,
  amountOutFormatted: NonnegativeDecimalSchema,
  amountOutUsd: NonnegativeDecimalSchema,
  minAmountOut: AtomicAmountSchema,
  timeEstimate: z.number().int().nonnegative(),
  depositAddress: AddressSchema.optional(),
  depositMemo: PrintableTextSchema.optional(),
  chainDepositAddresses: z.array(ChainDepositAddressSchema).max(64).optional(),
  deadline: DateTimeSchema.optional(),
  timeWhenInactive: DateTimeSchema.optional(),
  refundFee: AtomicAmountOrZeroSchema.optional(),
  withdrawFee: AtomicAmountOrZeroSchema.optional(),
}).strip();

export const OneClickQuoteResponseSchema = z.object({
  correlationId: CorrelationIdSchema,
  timestamp: DateTimeSchema,
  signature: PrintableTextSchema,
  quoteRequest: QuoteRequestSchema,
  quote: QuoteSchema,
}).strip().superRefine((response, context) => {
  if (response.quoteRequest.dry) {
    for (const field of ["depositAddress", "depositMemo", "deadline", "timeWhenInactive"] as const) {
      if (response.quote[field] !== undefined) {
        context.addIssue({ code: "custom", path: ["quote", field], message: `dry quote must not contain ${field}` });
      }
    }
    return;
  }
  for (const field of ["depositAddress", "deadline", "timeWhenInactive"] as const) {
    if (response.quote[field] === undefined) {
      context.addIssue({ code: "custom", path: ["quote", field], message: `executable quote must contain ${field}` });
    }
  }
});

export type OneClickQuoteRequest = z.input<typeof QuoteRequestSchema>;
export type OneClickQuoteResponse = z.output<typeof OneClickQuoteResponseSchema>;

const TokenSchema = z.object({
  assetId: AssetIdSchema,
  decimals: z.number().int().min(0).max(255),
  blockchain: BlockchainSchema,
  symbol: z.string().trim().min(1).max(32),
  price: z.union([
    z.number().finite().nonnegative(),
    z.string().max(128).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).transform(Number),
  ]).pipe(z.number().finite().nonnegative()),
  priceUpdatedAt: DateTimeSchema,
  contractAddress: z.string().min(1).max(320).optional(),
  coingeckoId: z.string().min(1).max(160).optional(),
}).strip();

export const OneClickTokenListSchema = z.array(TokenSchema).max(20_000);
export type OneClickToken = z.infer<typeof TokenSchema>;
export const OneClickProviderStatusSchema = z.enum([
  "KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING",
  "SUCCESS", "REFUNDED", "FAILED",
]);

const TransactionDetailsSchema = z.object({
  hash: PrintableTextSchema,
  explorerUrl: HttpsUrlSchema,
}).strip();
const SwapDetailsSchema = z.object({
  intentHashes: z.array(PrintableTextSchema).max(128),
  nearTxHashes: z.array(PrintableTextSchema).max(128),
  originChainTxHashes: z.array(TransactionDetailsSchema).max(128),
  destinationChainTxHashes: z.array(TransactionDetailsSchema).max(128),
  amountIn: AtomicAmountSchema.optional(),
  amountOut: AtomicAmountSchema.optional(),
  refundedAmount: AtomicAmountOrZeroSchema.optional(),
  depositedAmount: AtomicAmountOrZeroSchema.optional(),
  refundReason: z.string().max(256).optional(),
  withdrawFee: AtomicAmountOrZeroSchema.optional(),
}).strip();
export const OneClickStatusResponseSchema = z.object({
  correlationId: CorrelationIdSchema,
  quoteResponse: OneClickQuoteResponseSchema,
  status: OneClickProviderStatusSchema,
  updatedAt: DateTimeSchema,
  swapDetails: SwapDetailsSchema,
}).strip();
export type OneClickStatusResponse = z.output<typeof OneClickStatusResponseSchema>;
export type OneClickStatusInput = Readonly<{
  depositAddress: string;
  depositMemo?: string;
  expectedCorrelationId?: string;
  expectedQuoteHash?: string;
}>;
export type VerifiedOneClickQuote = Readonly<{
  response: OneClickQuoteResponse;
  quoteHash: string;
}>;

export type OneClickQuoteVerifier = (response: unknown) => boolean | Promise<boolean>;
export type OneClickFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type OneClickClientOptions = Readonly<{
  fetch?: OneClickFetch;
  apiKey?: string;
  verifyQuoteSignature?: OneClickQuoteVerifier;
  allowExecutableQuotes?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export class OneClickClientError extends Error {
  constructor(
    readonly code: "EXECUTION_DISABLED" | "HTTP_ERROR" | "INVALID_RESPONSE" |
      "INVALID_SIGNATURE" | "REQUEST_MISMATCH" | "RESPONSE_TOO_LARGE" | "TIMEOUT" |
      "UNKNOWN_OUTCOME" | "RESPONSE_TOO_COMPLEX",
    message: string,
  ) {
    super(message);
    this.name = "OneClickClientError";
  }
}

function officialVerifier(response: unknown): boolean {
  return verifyOfficialQuoteSignature(response as OfficialOneClickQuoteResponse);
}

function quoteHash(response: unknown): string {
  let hash: string;
  try {
    hash = officialQuoteHash(response as OfficialOneClickQuoteResponse);
  } catch {
    throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents quote hash canonicalization failed");
  }
  const parsed = QuoteHashSchema.safeParse(hash);
  if (!parsed.success) throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned an invalid quote hash");
  return parsed.data;
}

function integerOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be a positive safe integer`);
  return resolved;
}

/**
 * Bound work performed after JSON.parse but before recursive provider
 * canonicalization or schema validation. JSON values cannot contain cycles,
 * so an explicit stack provides deterministic limits without risking the JS
 * call stack on attacker-controlled nesting.
 */
function assertBoundedJsonComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let discoveredNodes = 1;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > DEFAULT_MAX_JSON_DEPTH) {
      throw new OneClickClientError(
        "RESPONSE_TOO_COMPLEX",
        "NEAR Intents response exceeded the configured JSON depth bound",
      );
    }

    let children: unknown[];
    if (Array.isArray(current.value)) {
      children = current.value;
    } else if (current.value !== null && typeof current.value === "object") {
      children = Object.values(current.value as Record<string, unknown>);
    } else {
      continue;
    }

    if (children.length > 0 && current.depth >= DEFAULT_MAX_JSON_DEPTH) {
      throw new OneClickClientError(
        "RESPONSE_TOO_COMPLEX",
        "NEAR Intents response exceeded the configured JSON depth bound",
      );
    }
    if (children.length > DEFAULT_MAX_JSON_NODES - discoveredNodes) {
      throw new OneClickClientError(
        "RESPONSE_TOO_COMPLEX",
        "NEAR Intents response exceeded the configured JSON node bound",
      );
    }
    discoveredNodes += children.length;
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new OneClickClientError("RESPONSE_TOO_LARGE", "NEAR Intents response exceeded the configured size bound");
    }
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned a non-JSON response");
  }
  if (!response.body) throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OneClickClientError("RESPONSE_TOO_LARGE", "NEAR Intents response exceeded the configured size bound");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned invalid JSON");
  }
  assertBoundedJsonComplexity(parsed);
  return parsed;
}

function assertQuoteMatchesRequest(response: OneClickQuoteResponse, request: OneClickQuoteRequest): void {
  const echoed = response.quoteRequest;
  const fields = [
    "dry", "swapType", "slippageTolerance", "originAsset", "depositType",
    "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline",
  ] as const;
  for (const field of fields) {
    if (echoed[field] !== request[field]) {
      throw new OneClickClientError("REQUEST_MISMATCH", `NEAR Intents quote did not match requested ${field}`);
    }
  }
  const optionalFields = ["depositMode", "confidentiality", "quoteWaitingTimeMs", "insured"] as const;
  for (const field of optionalFields) {
    if (request[field] !== undefined && echoed[field] !== request[field]) {
      throw new OneClickClientError("REQUEST_MISMATCH", `NEAR Intents quote did not match requested ${field}`);
    }
  }
}

export class OneClickClient {
  readonly #fetch: OneClickFetch;
  readonly #apiKey?: string;
  readonly #verify: OneClickQuoteVerifier;
  readonly #allowExecutableQuotes: boolean;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: OneClickClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.#verify = options.verifyQuoteSignature ?? officialVerifier;
    this.#allowExecutableQuotes = options.allowExecutableQuotes === true;
    this.#timeoutMs = integerOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#maxResponseBytes = integerOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, ONE_CLICK_ORIGIN);
    if (url.origin !== ONE_CLICK_ORIGIN) throw new OneClickClientError("INVALID_RESPONSE", "Invalid NEAR Intents request origin");
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.#apiKey) headers.set("x-api-key", this.#apiKey);
    try {
      const response = await this.#fetch(url, {
        ...init, headers, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.status === 404) {
        throw new OneClickClientError("UNKNOWN_OUTCOME", "NEAR Intents did not recognize the requested resource; outcome remains unknown");
      }
      if (!response.ok) throw new OneClickClientError("HTTP_ERROR", `NEAR Intents request failed with HTTP ${response.status}`);
      return await readBoundedJson(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof OneClickClientError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new OneClickClientError("TIMEOUT", "NEAR Intents request timed out");
      }
      throw new OneClickClientError("HTTP_ERROR", "NEAR Intents request failed");
    }
  }

  async tokens(options: { includeOndo?: boolean } = {}): Promise<OneClickToken[]> {
    const raw = await this.#request(`/v0/tokens${options.includeOndo ? "?ondoTokens=true" : ""}`);
    const parsed = OneClickTokenListSchema.safeParse(raw);
    if (!parsed.success) throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned invalid tokens");
    return parsed.data;
  }

  async quote(requestInput: OneClickQuoteRequest): Promise<VerifiedOneClickQuote> {
    const request = QuoteRequestSchema.parse(requestInput);
    if (!request.dry && !this.#allowExecutableQuotes) {
      throw new OneClickClientError("EXECUTION_DISABLED", "Executable NEAR Intents quotes are disabled");
    }
    const raw = await this.#request("/v0/quote", { method: "POST", body: JSON.stringify(request) });
    let verified = false;
    try { verified = await this.#verify(raw); } catch { verified = false; }
    if (!verified) throw new OneClickClientError("INVALID_SIGNATURE", "NEAR Intents quote signature verification failed");
    const parsed = OneClickQuoteResponseSchema.safeParse(raw);
    if (!parsed.success) throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned an invalid quote");
    assertQuoteMatchesRequest(parsed.data, request);
    if (!request.dry && !parsed.data.quote.depositAddress) {
      throw new OneClickClientError("INVALID_RESPONSE", "Executable NEAR Intents quote did not include a deposit address");
    }
    return {
      response: parsed.data,
      quoteHash: quoteHash(raw),
    };
  }

  async status(input: OneClickStatusInput): Promise<OneClickStatusResponse> {
    const depositAddress = AddressSchema.parse(input.depositAddress);
    const depositMemo = input.depositMemo === undefined ? undefined : PrintableTextSchema.parse(input.depositMemo);
    const expectedCorrelationId = input.expectedCorrelationId === undefined
      ? undefined
      : CorrelationIdSchema.parse(input.expectedCorrelationId);
    const expectedQuoteHash = input.expectedQuoteHash === undefined
      ? undefined
      : QuoteHashSchema.parse(input.expectedQuoteHash);
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo !== undefined) query.set("depositMemo", depositMemo);
    const raw = await this.#request(`/v0/status?${query.toString()}`);
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const rawQuote = record?.quoteResponse;
    let verified = false;
    try { verified = await this.#verify(rawQuote); } catch { verified = false; }
    if (!verified) throw new OneClickClientError("INVALID_SIGNATURE", "NEAR Intents status quote signature verification failed");
    const actualQuoteHash = quoteHash(rawQuote);
    const parsed = OneClickStatusResponseSchema.safeParse(raw);
    if (!parsed.success) throw new OneClickClientError("INVALID_RESPONSE", "NEAR Intents returned an invalid status");
    if (parsed.data.correlationId !== parsed.data.quoteResponse.correlationId) {
      throw new OneClickClientError("REQUEST_MISMATCH", "NEAR Intents status correlation did not match the verified quote");
    }
    if (expectedCorrelationId !== undefined && parsed.data.quoteResponse.correlationId !== expectedCorrelationId) {
      throw new OneClickClientError("REQUEST_MISMATCH", "NEAR Intents status did not match the expected quote correlation");
    }
    if (expectedQuoteHash !== undefined && actualQuoteHash !== expectedQuoteHash) {
      throw new OneClickClientError("REQUEST_MISMATCH", "NEAR Intents status did not match the expected quote hash");
    }
    const quoted = parsed.data.quoteResponse.quote;
    if (quoted.depositAddress !== depositAddress || quoted.depositMemo !== depositMemo) {
      throw new OneClickClientError("REQUEST_MISMATCH", "NEAR Intents status did not match the deposit address and memo");
    }
    return parsed.data;
  }
}

export function createOneClickClient(options: OneClickClientOptions = {}): OneClickClient {
  return new OneClickClient(options);
}
