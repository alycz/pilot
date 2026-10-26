import { z } from "zod";

const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ProviderStringSchema = z.string().min(1).max(512).regex(/^\S+$/);
const AtomicAmountSchema = z.string().regex(/^[1-9]\d*$/);
const DecimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const Sha256DigestSchema = z.string().regex(/^[A-F0-9]{64}$/);
const DateTimeSchema = z.string().datetime({ offset: true });
const HttpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  }, "URL must use HTTPS without embedded credentials");

/** Base58-encoded SHA-256 message hash used by 1Click quote signatures. */
export const Near1ClickQuoteHashSchema = z
  .string()
  .min(43)
  .max(45)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
export type Near1ClickQuoteHash = z.infer<typeof Near1ClickQuoteHashSchema>;

/**
 * 1Click asset identifiers are opaque provider identifiers, not ticker symbols.
 * Callers must select the exact current value returned by GET /v0/tokens.
 */
export const Near1ClickAssetIdSchema = z
  .string()
  .min(3)
  .max(320)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:\S+$/);
export type Near1ClickAssetId = z.infer<typeof Near1ClickAssetIdSchema>;

export const NEAR_1CLICK_BLOCKCHAINS = [
  "near", "eth", "base", "arb", "btc", "sol", "ton", "dash", "doge",
  "xrp", "zec", "gnosis", "bera", "bsc", "pol", "tron", "sui",
  "movement", "op", "avax", "stellar", "aptos", "cardano", "ltc",
  "xlayer", "monad", "bch", "adi", "plasma", "scroll", "starknet",
  "aleo", "hypercore", "fogo", "hood", "hlevm", "qtc", "abs",
] as const;

export const Near1ClickBlockchainSchema = z.enum(NEAR_1CLICK_BLOCKCHAINS);
export type Near1ClickBlockchain = z.infer<typeof Near1ClickBlockchainSchema>;

export const Near1ClickTokenSchema = z
  .object({
    assetId: Near1ClickAssetIdSchema,
    decimals: z.number().int().min(0).max(255),
    blockchain: Near1ClickBlockchainSchema,
    symbol: z.string().min(1).max(32),
    price: z.number().finite().nonnegative(),
    priceUpdatedAt: DateTimeSchema,
    contractAddress: z.string().min(1).max(320).optional(),
    coingeckoId: z.string().min(1).max(160).optional(),
  })
  .strict();
export type Near1ClickToken = z.infer<typeof Near1ClickTokenSchema>;

export const Near1ClickTokenListSchema = z.array(Near1ClickTokenSchema).max(20_000);
export type Near1ClickTokenList = z.infer<typeof Near1ClickTokenListSchema>;

const Near1ClickQuoteRequestBaseSchema = z
  .object({
    swapType: z.literal("EXACT_INPUT").default("EXACT_INPUT"),
    slippageTolerance: z.number().int().min(0).max(10_000),
    originAsset: Near1ClickAssetIdSchema,
    depositType: z.literal("ORIGIN_CHAIN").default("ORIGIN_CHAIN"),
    destinationAsset: Near1ClickAssetIdSchema,
    amount: AtomicAmountSchema,
    refundTo: ProviderStringSchema,
    refundType: z.literal("ORIGIN_CHAIN").default("ORIGIN_CHAIN"),
    recipient: ProviderStringSchema,
    recipientType: z.literal("DESTINATION_CHAIN").default("DESTINATION_CHAIN"),
    /** Provider refund-start deadline, not Pilot approval freshness. */
    deadline: DateTimeSchema,
    depositMode: z.enum(["SIMPLE", "MEMO"]).default("SIMPLE"),
    connectedWallets: z.array(ProviderStringSchema).max(16).optional(),
    sessionId: SafeIdentifierSchema.optional(),
    confidentiality: z.literal("public").default("public"),
    referral: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
    quoteWaitingTimeMs: z.number().int().min(0).max(30_000).default(0),
    insured: z.literal(false).default(false),
  })
  .strict();

export const Near1ClickDryQuoteRequestSchema = Near1ClickQuoteRequestBaseSchema
  .extend({ dry: z.literal(true).default(true) })
  .strict()
  .refine((request) => request.originAsset !== request.destinationAsset, {
    message: "origin and destination assets must differ",
    path: ["destinationAsset"],
  });
export type Near1ClickDryQuoteRequest = z.infer<typeof Near1ClickDryQuoteRequestSchema>;

export const Near1ClickExecutableQuoteRequestSchema = Near1ClickQuoteRequestBaseSchema
  .extend({ dry: z.literal(false) })
  .strict()
  .refine((request) => request.originAsset !== request.destinationAsset, {
    message: "origin and destination assets must differ",
    path: ["destinationAsset"],
  });
export type Near1ClickExecutableQuoteRequest = z.infer<typeof Near1ClickExecutableQuoteRequestSchema>;

export const Near1ClickQuoteRequestSchema = z.union([
  Near1ClickDryQuoteRequestSchema,
  Near1ClickExecutableQuoteRequestSchema,
]);
export type Near1ClickQuoteRequest = z.infer<typeof Near1ClickQuoteRequestSchema>;

const Near1ClickQuoteAmountsSchema = z
  .object({
    amountIn: AtomicAmountSchema,
    amountInFormatted: DecimalAmountSchema,
    amountInUsd: DecimalAmountSchema,
    minAmountIn: AtomicAmountSchema,
    amountOut: AtomicAmountSchema,
    amountOutFormatted: DecimalAmountSchema,
    amountOutUsd: DecimalAmountSchema,
    minAmountOut: AtomicAmountSchema,
    timeEstimate: z.number().int().nonnegative(),
    virtualChainRecipient: ProviderStringSchema.optional(),
    virtualChainRefundRecipient: ProviderStringSchema.optional(),
    customRecipientMsg: z.string().min(1).max(2_048).optional(),
    refundFee: z.string().regex(/^\d+$/).optional(),
    withdrawFee: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export const Near1ClickChainDepositAddressSchema = z
  .object({
    blockchain: Near1ClickBlockchainSchema,
    address: ProviderStringSchema,
    /** Deposit-side routing metadata; this is not a generic destination tag. */
    memo: ProviderStringSchema.optional(),
  })
  .strict();

const Near1ClickResponseHeaderSchema = z
  .object({
    correlationId: SafeIdentifierSchema,
    timestamp: DateTimeSchema,
    signature: z.string().min(1).max(2_048),
  })
  .strict();

export const Near1ClickDryQuoteResponseSchema = Near1ClickResponseHeaderSchema
  .extend({
    quoteRequest: Near1ClickDryQuoteRequestSchema,
    // Intentionally excludes depositAddress, depositMemo, deadline and
    // timeWhenInactive. A dry quote can never authorize execution.
    quote: Near1ClickQuoteAmountsSchema,
  })
  .strict();
export type Near1ClickDryQuoteResponse = z.infer<typeof Near1ClickDryQuoteResponseSchema>;

export const Near1ClickExecutableQuoteSchema = Near1ClickQuoteAmountsSchema
  .extend({
    depositAddress: ProviderStringSchema,
    /** Required only when returned; it is deposit-side routing metadata. */
    depositMemo: ProviderStringSchema.optional(),
    chainDepositAddresses: z.array(Near1ClickChainDepositAddressSchema).max(64).optional(),
    deadline: DateTimeSchema,
    timeWhenInactive: DateTimeSchema,
  })
  .strict();
export type Near1ClickExecutableQuote = z.infer<typeof Near1ClickExecutableQuoteSchema>;

export const Near1ClickExecutableQuoteResponseSchema = Near1ClickResponseHeaderSchema
  .extend({
    quoteRequest: Near1ClickExecutableQuoteRequestSchema,
    quote: Near1ClickExecutableQuoteSchema,
  })
  .strict();
export type Near1ClickExecutableQuoteResponse = z.infer<typeof Near1ClickExecutableQuoteResponseSchema>;

export const Near1ClickQuoteResponseSchema = z.union([
  Near1ClickDryQuoteResponseSchema,
  Near1ClickExecutableQuoteResponseSchema,
]);
export type Near1ClickQuoteResponse = z.infer<typeof Near1ClickQuoteResponseSchema>;

export const Near1ClickProviderStatusSchema = z.enum([
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
]);
export type Near1ClickProviderStatus = z.infer<typeof Near1ClickProviderStatusSchema>;

export const Near1ClickTransactionDetailsSchema = z
  .object({ hash: ProviderStringSchema, explorerUrl: HttpsUrlSchema })
  .strict();

export const Near1ClickSwapDetailsSchema = z
  .object({
    intentHashes: z.array(ProviderStringSchema).max(128),
    nearTxHashes: z.array(ProviderStringSchema).max(128),
    originChainTxHashes: z.array(Near1ClickTransactionDetailsSchema).max(128),
    destinationChainTxHashes: z.array(Near1ClickTransactionDetailsSchema).max(128),
    amountIn: AtomicAmountSchema.optional(),
    amountInFormatted: DecimalAmountSchema.optional(),
    amountInUsd: DecimalAmountSchema.optional(),
    amountOut: AtomicAmountSchema.optional(),
    amountOutFormatted: DecimalAmountSchema.optional(),
    amountOutUsd: DecimalAmountSchema.optional(),
    slippage: z.number().finite().optional(),
    refundedAmount: z.string().regex(/^\d+$/).optional(),
    refundedAmountFormatted: DecimalAmountSchema.optional(),
    refundedAmountUsd: DecimalAmountSchema.optional(),
    refundReason: z.string().min(1).max(256).optional(),
    depositedAmount: z.string().regex(/^\d+$/).optional(),
    depositedAmountFormatted: DecimalAmountSchema.optional(),
    depositedAmountUsd: DecimalAmountSchema.optional(),
    withdrawFee: z.string().regex(/^\d+$/).optional(),
    referral: z.string().min(1).max(128).optional(),
  })
  .strict();

export const Near1ClickStatusResponseSchema = z
  .object({
    correlationId: SafeIdentifierSchema,
    quoteResponse: Near1ClickExecutableQuoteResponseSchema,
    status: Near1ClickProviderStatusSchema,
    updatedAt: DateTimeSchema,
    swapDetails: Near1ClickSwapDetailsSchema,
  })
  .strict();
export type Near1ClickStatusResponse = z.infer<typeof Near1ClickStatusResponseSchema>;

export const NearApprovalBindingSchema = z
  .object({
    version: z.literal("pilot-near-1click-approval-v1"),
    principal_id: SafeIdentifierSchema,
    network: z.literal("near:mainnet"),
    idempotency_key: SafeIdentifierSchema,
    policy_digest: Sha256DigestSchema,
    quote_id: SafeIdentifierSchema,
    quote_hash: Near1ClickQuoteHashSchema,
    provider_signature_verified: z.literal(true),
    origin_asset: Near1ClickAssetIdSchema,
    destination_asset: Near1ClickAssetIdSchema,
    amount_in: AtomicAmountSchema,
    min_amount_out: AtomicAmountSchema,
    recipient: ProviderStringSchema,
    refund_to: ProviderStringSchema,
    deposit_address: ProviderStringSchema,
    /** Presence and value are digest-bound when the provider supplies a memo. */
    deposit_memo: ProviderStringSchema.optional(),
    /** Pilot-local approval freshness boundary. */
    approval_expires_at: DateTimeSchema,
    /** 1Click refund-start deadline from the executable quote. */
    provider_deadline_at: DateTimeSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.origin_asset === binding.destination_asset) {
      context.addIssue({
        code: "custom",
        path: ["destination_asset"],
        message: "origin and destination assets must differ",
      });
    }
    if (Date.parse(binding.approval_expires_at) > Date.parse(binding.provider_deadline_at)) {
      context.addIssue({
        code: "custom",
        path: ["approval_expires_at"],
        message: "approval must expire no later than the provider deadline",
      });
    }
  });
export type NearApprovalBinding = z.infer<typeof NearApprovalBindingSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON rejects unsupported values");
}

export function canonicalNearApprovalJson(value: NearApprovalBinding): string {
  return canonicalJson(NearApprovalBindingSchema.parse(value));
}

export async function computeNearApprovalDigest(value: NearApprovalBinding): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalNearApprovalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const NearExecutionAttemptStateSchema = z.enum([
  "quoted",
  "policy_checked",
  "approval_required",
  "approved",
  "submitting",
  "pending",
  "settled",
  "refunded",
  "failed",
  "unknown",
]);
export type NearExecutionAttemptState = z.infer<typeof NearExecutionAttemptStateSchema>;

export const NearExecutionAttemptSchema = z
  .object({
    attempt_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    idempotency_key: SafeIdentifierSchema,
    approval_digest: Sha256DigestSchema,
    quote_id: SafeIdentifierSchema,
    state: NearExecutionAttemptStateSchema,
    provider_status: Near1ClickProviderStatusSchema.optional(),
    updated_at: DateTimeSchema,
    unknown_since: DateTimeSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if ((attempt.state === "unknown") !== (attempt.unknown_since !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["unknown_since"],
        message: "unknown attempts must record when uncertainty began",
      });
    }
    const terminalStatus = attempt.state === "settled"
      ? "SUCCESS"
      : attempt.state === "refunded"
        ? "REFUNDED"
        : attempt.state === "failed"
          ? "FAILED"
          : undefined;
    if (terminalStatus && attempt.provider_status !== terminalStatus) {
      context.addIssue({
        code: "custom",
        path: ["provider_status"],
        message: `terminal ${attempt.state} requires provider status ${terminalStatus}`,
      });
    }
  });
export type NearExecutionAttempt = z.infer<typeof NearExecutionAttemptSchema>;

export const NearExecutionReplayDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("return_existing"), attempt: NearExecutionAttemptSchema }).strict(),
  z.object({ action: z.literal("poll_existing"), attempt: NearExecutionAttemptSchema }).strict(),
  z.object({
    action: z.literal("blocked_unknown"),
    attempt: NearExecutionAttemptSchema.refine((attempt) => attempt.state === "unknown"),
    safe_to_resubmit: z.literal(false),
  }).strict(),
  z.object({
    action: z.literal("terminal"),
    attempt: NearExecutionAttemptSchema.refine((attempt) =>
      ["settled", "refunded", "failed"].includes(attempt.state)),
  }).strict(),
]);
export type NearExecutionReplayDecision = z.infer<typeof NearExecutionReplayDecisionSchema>;

export const NearWalletConnectionSchema = z
  .object({
    connection_id: SafeIdentifierSchema,
    provider_id: SafeIdentifierSchema,
    account_id: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
    network: z.enum(["near:mainnet", "near:testnet"]),
    connected_at: DateTimeSchema,
    capabilities: z.object({
      sign_message: z.boolean(),
      sign_transaction: z.boolean(),
      sign_and_send_transaction: z.boolean(),
    }).strict(),
  })
  .strict();
export type NearWalletConnection = z.infer<typeof NearWalletConnectionSchema>;

export const NearWalletExecutionPolicySchema = z
  .object({
    mode: z.enum(["disabled", "owner-approval"]).default("disabled"),
    mainnet_execution_enabled: z.boolean().default(false),
  })
  .strict()
  .refine((policy) => !policy.mainnet_execution_enabled || policy.mode === "owner-approval", {
    message: "mainnet execution requires owner-approval mode",
    path: ["mode"],
  });
export type NearWalletExecutionPolicy = z.infer<typeof NearWalletExecutionPolicySchema>;
