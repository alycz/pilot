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

export const NearAccountIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9._-]+$/);
export type NearAccountId = z.infer<typeof NearAccountIdSchema>;

export const NearIdempotencyVersionSchema = z.literal("pilot-near-idempotency-v1");
export type NearIdempotencyVersion = z.infer<typeof NearIdempotencyVersionSchema>;

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

export const NEAR_ARBITRUM_USDC_CONTRACT =
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const;
export const NEAR_ARBITRUM_USDC_ASSET_ID =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" as const;
export const NEAR_WRAPPED_NEAR_CONTRACT = "wrap.near" as const;
export const NEAR_WRAPPED_NEAR_ASSET_ID = "nep141:wrap.near" as const;

const ArbitrumAddressSchema = z.string().regex(/^0x[0-9A-Fa-f]{40}$/);
const ArbitrumTransactionHashSchema = z.string().regex(/^0x[0-9A-Fa-f]{64}$/);
const NearTransactionOrReceiptHashSchema = z
  .string()
  .min(43)
  .max(45)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

/**
 * The only owner-funded executable route in this slice. This describes asset
 * identity; it does not authorize Pilot to control or debit the owner's wallet.
 */
export const NearArbitrumUsdcToWnearRouteSchema = z
  .object({
    version: z.literal("pilot-near-arbitrum-usdc-to-wnear-route-v1"),
    origin_chain: z.literal("arb"),
    origin_chain_id: z.literal(42161),
    origin_token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
    origin_asset_id: z.literal(NEAR_ARBITRUM_USDC_ASSET_ID),
    origin_decimals: z.literal(6),
    destination_chain: z.literal("near"),
    destination_network: z.literal("mainnet"),
    destination_token_contract: z.literal(NEAR_WRAPPED_NEAR_CONTRACT),
    destination_asset_id: z.literal(NEAR_WRAPPED_NEAR_ASSET_ID),
    destination_decimals: z.literal(24),
    funding_mode: z.literal("manual-owner-wallet-send"),
    manual_owner_funding_only: z.literal(true),
    pilot_budget_scope: z.literal("does-not-control-owner-wallet-send"),
  })
  .strict();
export type NearArbitrumUsdcToWnearRoute = z.infer<
  typeof NearArbitrumUsdcToWnearRouteSchema
>;

/** Exact provider request echo accepted for the single supported route. */
export const NearArbitrumUsdcToWnearExecutableQuoteRequestSchema =
  Near1ClickExecutableQuoteRequestSchema.superRefine((request, context) => {
    if (request.originAsset !== NEAR_ARBITRUM_USDC_ASSET_ID) {
      context.addIssue({
        code: "custom",
        path: ["originAsset"],
        message: "origin asset must be the supported Arbitrum native USDC asset",
      });
    }
    if (request.destinationAsset !== NEAR_WRAPPED_NEAR_ASSET_ID) {
      context.addIssue({
        code: "custom",
        path: ["destinationAsset"],
        message: "destination asset must be wrapped NEAR",
      });
    }
    if (!ArbitrumAddressSchema.safeParse(request.refundTo).success) {
      context.addIssue({
        code: "custom",
        path: ["refundTo"],
        message: "refund address must be an Arbitrum address",
      });
    }
    if (!NearAccountIdSchema.safeParse(request.recipient).success) {
      context.addIssue({
        code: "custom",
        path: ["recipient"],
        message: "recipient must be a NEAR account",
      });
    }
    if (request.depositMode !== "SIMPLE") {
      context.addIssue({
        code: "custom",
        path: ["depositMode"],
        message: "the supported EVM deposit route must not use memo routing",
      });
    }
  });
export type NearArbitrumUsdcToWnearExecutableQuoteRequest = z.infer<
  typeof NearArbitrumUsdcToWnearExecutableQuoteRequestSchema
>;

/**
 * Signature verification and quote hashing happen over the provider response
 * before this normalized approval binding is constructed.
 */
export const NearArbitrumUsdcToWnearExecutableQuoteBindingSchema = z
  .object({
    version: z.literal("pilot-near-arbitrum-usdc-to-wnear-quote-binding-v1"),
    route: NearArbitrumUsdcToWnearRouteSchema,
    provider_signature_verified: z.literal(true),
    provider_signature: z.string().min(1).max(2_048),
    quote_hash: Near1ClickQuoteHashSchema,
    correlation_id: SafeIdentifierSchema,
    provider_timestamp: DateTimeSchema,
    request_echo: NearArbitrumUsdcToWnearExecutableQuoteRequestSchema,
    provider_quote_response: Near1ClickExecutableQuoteResponseSchema,
    amount_in: AtomicAmountSchema,
    min_amount_out: AtomicAmountSchema,
    recipient: NearAccountIdSchema,
    refund_to: ArbitrumAddressSchema,
    deposit_address: ArbitrumAddressSchema,
    /** This supported EVM deposit path rejects memo-bearing quotes. */
    deposit_memo_present: z.literal(false),
    /** Provider refund-start boundary echoed by the executable quote. */
    provider_deadline_at: DateTimeSchema,
    provider_time_when_inactive_at: DateTimeSchema,
    /** Local review freshness, distinct from the provider refund boundary. */
    approval_expires_at: DateTimeSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    if (binding.amount_in !== binding.request_echo.amount) {
      issue(["amount_in"], "amount must match the signed provider request echo");
    }
    if (binding.provider_signature !== binding.provider_quote_response.signature) {
      issue(["provider_signature"], "provider signature must match the executable quote response");
    }
    if (binding.correlation_id !== binding.provider_quote_response.correlationId) {
      issue(["correlation_id"], "correlation id must match the executable quote response");
    }
    if (binding.provider_timestamp !== binding.provider_quote_response.timestamp) {
      issue(["provider_timestamp"], "provider timestamp must match the executable quote response");
    }
    if (
      JSON.stringify(binding.request_echo)
      !== JSON.stringify(binding.provider_quote_response.quoteRequest)
    ) {
      issue(["request_echo"], "request echo must match the executable quote response");
    }
    if (binding.amount_in !== binding.provider_quote_response.quote.amountIn) {
      issue(["amount_in"], "amount must match the executable quote response");
    }
    if (binding.min_amount_out !== binding.provider_quote_response.quote.minAmountOut) {
      issue(["min_amount_out"], "minimum output must match the executable quote response");
    }
    if (binding.recipient !== binding.request_echo.recipient) {
      issue(["recipient"], "recipient must match the signed provider request echo");
    }
    if (binding.refund_to.toLowerCase() !== binding.request_echo.refundTo.toLowerCase()) {
      issue(["refund_to"], "refund address must match the signed provider request echo");
    }
    if (binding.provider_deadline_at !== binding.request_echo.deadline) {
      issue(["provider_deadline_at"], "provider deadline must match the signed request echo");
    }
    if (
      binding.deposit_address.toLowerCase()
      !== binding.provider_quote_response.quote.depositAddress.toLowerCase()
    ) {
      issue(["deposit_address"], "deposit address must match the executable quote response");
    }
    if (binding.provider_quote_response.quote.depositMemo !== undefined) {
      issue(["provider_quote_response", "quote", "depositMemo"], "the supported EVM route must not include a deposit memo");
    }
    if (binding.provider_deadline_at !== binding.provider_quote_response.quote.deadline) {
      issue(["provider_deadline_at"], "provider deadline must match the executable quote response");
    }
    if (
      binding.provider_time_when_inactive_at
      !== binding.provider_quote_response.quote.timeWhenInactive
    ) {
      issue(
        ["provider_time_when_inactive_at"],
        "provider inactivity time must match the executable quote response",
      );
    }
    if (Date.parse(binding.approval_expires_at) > Date.parse(binding.provider_deadline_at)) {
      issue(["approval_expires_at"], "local approval must expire no later than provider refund start");
    }
    if (Date.parse(binding.provider_time_when_inactive_at) > Date.parse(binding.provider_deadline_at)) {
      issue(["provider_time_when_inactive_at"], "provider inactivity time cannot follow refund start");
    }
  });
export type NearArbitrumUsdcToWnearExecutableQuoteBinding = z.infer<
  typeof NearArbitrumUsdcToWnearExecutableQuoteBindingSchema
>;

/** Owner-reported origin-chain provenance; this is not independent verification. */
export const NearArbitrumUsdcOwnerFundingEvidenceSchema = z
  .object({
    version: z.literal("pilot-near-arbitrum-usdc-owner-funding-v1"),
    provenance: z.literal("owner-reported"),
    independently_verified: z.literal(false),
    funding_mode: z.literal("manual-owner-wallet-send"),
    chain: z.literal("arb"),
    chain_id: z.literal(42161),
    token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
    token_decimals: z.literal(6),
    transaction_hash: ArbitrumTransactionHashSchema,
    source_address: ArbitrumAddressSchema,
    deposit_address: ArbitrumAddressSchema,
    amount_in: AtomicAmountSchema,
    reported_at: DateTimeSchema,
  })
  .strict();
export type NearArbitrumUsdcOwnerFundingEvidence = z.infer<
  typeof NearArbitrumUsdcOwnerFundingEvidenceSchema
>;

const NearArbitrumUsdcOriginReceiptEvidenceBaseSchema = z.object({
  version: z.literal("pilot-near-arbitrum-usdc-origin-receipt-v1"),
  provenance: z.literal("origin-chain-verified"),
  verification_source: z.literal("arbitrum-rpc-transaction-receipt"),
  chain: z.literal("arb"),
  chain_id: z.literal(42161),
  token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
  token_decimals: z.literal(6),
  funding_transaction_hash: ArbitrumTransactionHashSchema,
  source_address: ArbitrumAddressSchema,
  deposit_address: ArbitrumAddressSchema,
  amount_in: AtomicAmountSchema,
  block_number: z.number().int().nonnegative(),
  block_hash: ArbitrumTransactionHashSchema,
  verified_at: DateTimeSchema,
});

/**
 * Durable origin-chain evidence intake. Defining this contract does not claim
 * that an Arbitrum receipt verifier is installed or has run.
 */
export const NearArbitrumUsdcOriginReceiptEvidenceSchema = z.discriminatedUnion(
  "outcome",
  [
    NearArbitrumUsdcOriginReceiptEvidenceBaseSchema.extend({
      outcome: z.literal("funding-confirmed"),
      receipt_status: z.literal("success"),
    }).strict(),
    NearArbitrumUsdcOriginReceiptEvidenceBaseSchema.extend({
      outcome: z.literal("funding-failed"),
      receipt_status: z.literal("failed"),
    }).strict(),
    NearArbitrumUsdcOriginReceiptEvidenceBaseSchema.extend({
      outcome: z.literal("refund-confirmed"),
      receipt_status: z.literal("success"),
      refund_transaction_hash: ArbitrumTransactionHashSchema,
      refund_to: ArbitrumAddressSchema,
      refunded_amount: AtomicAmountSchema,
    }).strict(),
  ],
);
export type NearArbitrumUsdcOriginReceiptEvidence = z.infer<
  typeof NearArbitrumUsdcOriginReceiptEvidenceSchema
>;

const NearArbitrumUsdcToWnearProviderStatusEvidenceBaseSchema = z.object({
  version: z.literal("pilot-near-arbitrum-usdc-to-wnear-settlement-v1"),
  correlation_id: SafeIdentifierSchema,
  quote_hash: Near1ClickQuoteHashSchema,
  nested_quote_signature_verified: z.literal(true),
  deposit_address: ArbitrumAddressSchema,
  deposit_memo_present: z.literal(false),
  provider_status: Near1ClickProviderStatusSchema,
  provider_checked_at: DateTimeSchema,
  safe_to_resubmit: z.literal(false),
});

export const NearWnearIndependentDestinationReceiptSchema = z
  .object({
    source: z.literal("near-rpc-final-receipt"),
    network: z.literal("near:mainnet"),
    receipt_id: NearTransactionOrReceiptHashSchema,
    transaction_hash: NearTransactionOrReceiptHashSchema.optional(),
    block_height: z.number().int().positive(),
    execution_status: z.literal("SUCCESS"),
    recipient: NearAccountIdSchema,
    token_contract: z.literal(NEAR_WRAPPED_NEAR_CONTRACT),
    asset_id: z.literal(NEAR_WRAPPED_NEAR_ASSET_ID),
    token_decimals: z.literal(24),
    amount_received: AtomicAmountSchema,
    verified_at: DateTimeSchema,
  })
  .strict();
export type NearWnearIndependentDestinationReceipt = z.infer<
  typeof NearWnearIndependentDestinationReceiptSchema
>;

/** Provider SUCCESS alone remains provider-reported until a receipt is supplied. */
export const NearArbitrumUsdcToWnearSettlementEvidenceSchema = z
  .discriminatedUnion("evidence_level", [
    NearArbitrumUsdcToWnearProviderStatusEvidenceBaseSchema.extend({
      evidence_level: z.literal("provider-reported-only"),
      independent_destination_receipt: z.literal(false),
    }).strict(),
    NearArbitrumUsdcToWnearProviderStatusEvidenceBaseSchema.extend({
      evidence_level: z.literal("independent-destination-receipt"),
      independent_destination_receipt: NearWnearIndependentDestinationReceiptSchema,
    }).strict(),
  ])
  .superRefine((evidence, context) => {
    if (
      evidence.evidence_level === "independent-destination-receipt"
      && ["REFUNDED", "FAILED"].includes(evidence.provider_status)
    ) {
      context.addIssue({
        code: "custom",
        path: ["provider_status"],
        message: "terminal provider failure conflicts with successful destination receipt evidence",
      });
    }
  });
export type NearArbitrumUsdcToWnearSettlementEvidence = z.infer<
  typeof NearArbitrumUsdcToWnearSettlementEvidenceSchema
>;

export const NearArbitrumUsdcToWnearOwnerFundedExecutionSchema = z
  .object({
    version: z.literal("pilot-near-arbitrum-usdc-to-wnear-owner-funded-execution-v1"),
    route: NearArbitrumUsdcToWnearRouteSchema,
    quote: NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
    funding: NearArbitrumUsdcOwnerFundingEvidenceSchema,
    origin_verification: NearArbitrumUsdcOriginReceiptEvidenceSchema.optional(),
    settlement: NearArbitrumUsdcToWnearSettlementEvidenceSchema,
  })
  .strict()
  .superRefine((execution, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    if (JSON.stringify(execution.route) !== JSON.stringify(execution.quote.route)) {
      issue(["quote", "route"], "quote route must match the execution route");
    }
    if (execution.funding.amount_in !== execution.quote.amount_in) {
      issue(["funding", "amount_in"], "owner funding amount must match the executable quote");
    }
    if (
      execution.funding.source_address.toLowerCase()
      !== execution.quote.refund_to.toLowerCase()
    ) {
      issue(["funding", "source_address"], "owner funding source must match the refund address");
    }
    if (
      execution.funding.deposit_address.toLowerCase()
      !== execution.quote.deposit_address.toLowerCase()
    ) {
      issue(["funding", "deposit_address"], "owner funding destination must match the provider deposit address");
    }
    if (execution.origin_verification) {
      const origin = execution.origin_verification;
      if (origin.funding_transaction_hash !== execution.funding.transaction_hash) {
        issue(
          ["origin_verification", "funding_transaction_hash"],
          "verified origin receipt must match the owner-reported transaction",
        );
      }
      if (origin.source_address.toLowerCase() !== execution.funding.source_address.toLowerCase()) {
        issue(["origin_verification", "source_address"], "verified origin source must match owner report");
      }
      if (origin.deposit_address.toLowerCase() !== execution.funding.deposit_address.toLowerCase()) {
        issue(["origin_verification", "deposit_address"], "verified origin destination must match owner report");
      }
      if (origin.amount_in !== execution.funding.amount_in) {
        issue(["origin_verification", "amount_in"], "verified origin amount must match owner report");
      }
      if (
        origin.outcome === "refund-confirmed"
        && origin.refund_to.toLowerCase() !== execution.quote.refund_to.toLowerCase()
      ) {
        issue(["origin_verification", "refund_to"], "verified refund must return to the quote refund address");
      }
    }
    if (execution.settlement.correlation_id !== execution.quote.correlation_id) {
      issue(["settlement", "correlation_id"], "settlement must match the quote correlation id");
    }
    if (execution.settlement.quote_hash !== execution.quote.quote_hash) {
      issue(["settlement", "quote_hash"], "settlement must match the verified quote hash");
    }
    if (
      execution.settlement.deposit_address.toLowerCase()
      !== execution.quote.deposit_address.toLowerCase()
    ) {
      issue(["settlement", "deposit_address"], "settlement must match the provider deposit address");
    }
    if (execution.settlement.evidence_level === "independent-destination-receipt") {
      const receipt = execution.settlement.independent_destination_receipt;
      if (receipt.recipient !== execution.quote.recipient) {
        issue(
          ["settlement", "independent_destination_receipt", "recipient"],
          "destination receipt recipient must match the executable quote",
        );
      }
      if (BigInt(receipt.amount_received) < BigInt(execution.quote.min_amount_out)) {
        issue(
          ["settlement", "independent_destination_receipt", "amount_received"],
          "destination receipt amount must satisfy the quote minimum output",
        );
      }
    }
  });
export type NearArbitrumUsdcToWnearOwnerFundedExecution = z.infer<
  typeof NearArbitrumUsdcToWnearOwnerFundedExecutionSchema
>;

export const NearAuthorizedOperationSchema = z.enum([
  "near.intents.tokens",
  /** The current Harbor operation is contractually dry-only. */
  "near.intents.quote",
  "near.intents.executable-quote.review",
  "near.intents.status",
  "near.intents.approval.review",
]);
export type NearAuthorizedOperation = z.infer<typeof NearAuthorizedOperationSchema>;

export const NearPrincipalAuthorizationSchema = z
  .object({
    version: z.literal("pilot-near-principal-authorization-v1"),
    authorization_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    operations: z.array(NearAuthorizedOperationSchema).min(1).max(5)
      .refine((operations) => new Set(operations).size === operations.length, {
        message: "authorized operations must be unique",
      }),
    issued_at: DateTimeSchema,
    expires_at: DateTimeSchema,
  })
  .strict()
  .refine((authorization) =>
    Date.parse(authorization.expires_at) > Date.parse(authorization.issued_at), {
    message: "principal authorization must expire after issuance",
    path: ["expires_at"],
  });
export type NearPrincipalAuthorization = z.infer<typeof NearPrincipalAuthorizationSchema>;

export const NearIdempotencyBindingSchema = z
  .object({
    version: NearIdempotencyVersionSchema,
    principal_id: SafeIdentifierSchema,
    account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    idempotency_key: SafeIdentifierSchema,
    request_digest: Sha256DigestSchema,
    created_at: DateTimeSchema,
  })
  .strict();
export type NearIdempotencyBinding = z.infer<typeof NearIdempotencyBindingSchema>;

export const NearApprovalBindingSchema = z
  .object({
    version: z.literal("pilot-near-1click-approval-v2"),
    principal_id: SafeIdentifierSchema,
    account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    idempotency_version: NearIdempotencyVersionSchema,
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

/** Explicit domain separation keeps this digest distinct from other canonical payload hashes. */
export const NEAR_APPROVAL_DIGEST_DOMAIN = "pilot.near-intents.approval.v2" as const;

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
    new TextEncoder().encode(
      `${NEAR_APPROVAL_DIGEST_DOMAIN}\0${canonicalNearApprovalJson(value)}`,
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const NearBudgetReservationStateSchema = z.enum([
  "reserved",
  "committed",
  "outcome_unknown",
  "released",
]);
export type NearBudgetReservationState = z.infer<typeof NearBudgetReservationStateSchema>;

export const NearBudgetReleaseReasonSchema = z.enum([
  "cancelled_before_dispatch",
  "provider_refunded",
  "provider_failed_after_reconciliation",
]);
export type NearBudgetReleaseReason = z.infer<typeof NearBudgetReleaseReasonSchema>;

const NearBudgetReservationBaseSchema = z.object({
  version: z.literal("pilot-near-budget-reservation-v1"),
  reservation_id: SafeIdentifierSchema,
  principal_id: SafeIdentifierSchema,
  account_id: NearAccountIdSchema,
  network: z.literal("near:mainnet"),
  idempotency_version: NearIdempotencyVersionSchema,
  idempotency_key: SafeIdentifierSchema,
  request_digest: Sha256DigestSchema,
  policy_digest: Sha256DigestSchema,
  asset_id: Near1ClickAssetIdSchema,
  amount_atomic: AtomicAmountSchema,
  /** Monotonic compare-and-swap revision for durable reservation updates. */
  revision: z.number().int().positive(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
});

export const NearBudgetReservationSchema = z
  .discriminatedUnion("state", [
    NearBudgetReservationBaseSchema.extend({
      state: z.literal("reserved"),
      counts_against_budget: z.literal(true),
    }).strict(),
    NearBudgetReservationBaseSchema.extend({
      state: z.literal("committed"),
      counts_against_budget: z.literal(true),
      committed_at: DateTimeSchema,
    }).strict(),
    NearBudgetReservationBaseSchema.extend({
      state: z.literal("outcome_unknown"),
      counts_against_budget: z.literal(true),
      unknown_since: DateTimeSchema,
    }).strict(),
    NearBudgetReservationBaseSchema.extend({
      state: z.literal("released"),
      counts_against_budget: z.literal(false),
      released_at: DateTimeSchema,
      release_reason: NearBudgetReleaseReasonSchema,
    }).strict(),
  ])
  .superRefine((reservation, context) => {
    if (Date.parse(reservation.updated_at) < Date.parse(reservation.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "reservation cannot be updated before creation",
      });
    }
  });
export type NearBudgetReservation = z.infer<typeof NearBudgetReservationSchema>;

export const NearReconciliationUnknownReasonSchema = z.enum([
  "timeout",
  "transport_error",
  "not_found",
  "invalid_response",
  "unavailable",
]);
export type NearReconciliationUnknownReason = z.infer<typeof NearReconciliationUnknownReasonSchema>;

const Near1ClickPendingStatusSchema = z.enum([
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
]);
const Near1ClickTerminalStatusSchema = z.enum(["SUCCESS", "REFUNDED", "FAILED"]);
const NearReconciliationEvidenceBaseSchema = z.object({
  version: z.literal("pilot-near-reconciliation-v1"),
  attempt_id: SafeIdentifierSchema,
  principal_id: SafeIdentifierSchema,
  account_id: NearAccountIdSchema,
  network: z.literal("near:mainnet"),
  checked_at: DateTimeSchema,
  deposit_address: ProviderStringSchema,
  deposit_memo: ProviderStringSchema.optional(),
  evidence_digest: Sha256DigestSchema.optional(),
  /** Provider uncertainty never proves that a second submission is safe. */
  safe_to_resubmit: z.literal(false),
});

export const NearReconciliationEvidenceSchema = z.discriminatedUnion("outcome", [
  NearReconciliationEvidenceBaseSchema.extend({
    outcome: z.literal("pending"),
    provider_status: Near1ClickPendingStatusSchema,
  }).strict(),
  NearReconciliationEvidenceBaseSchema.extend({
    outcome: z.literal("terminal"),
    provider_status: Near1ClickTerminalStatusSchema,
  }).strict(),
  NearReconciliationEvidenceBaseSchema.extend({
    outcome: z.literal("unknown"),
    reason: NearReconciliationUnknownReasonSchema,
  }).strict(),
]);
export type NearReconciliationEvidence = z.infer<typeof NearReconciliationEvidenceSchema>;

/**
 * Persistence adapters must atomically compare expected_state/revision before
 * storing next. Parsing validates the transition but does not implement CAS.
 */
export const NearBudgetReservationTransitionSchema = z
  .object({
    version: z.literal("pilot-near-budget-reservation-transition-v1"),
    reservation_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    expected_state: NearBudgetReservationStateSchema,
    expected_revision: z.number().int().nonnegative(),
    next: NearBudgetReservationSchema,
    reconciliation: NearReconciliationEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((transition, context) => {
    const identityMatches = transition.next.reservation_id === transition.reservation_id
      && transition.next.principal_id === transition.principal_id
      && transition.next.account_id === transition.account_id
      && transition.next.network === transition.network;
    if (!identityMatches) {
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: "reservation transition must preserve principal, account, network, and reservation id",
      });
    }
    if (transition.next.revision !== transition.expected_revision + 1) {
      context.addIssue({
        code: "custom",
        path: ["next", "revision"],
        message: "reservation transition must increment the expected revision exactly once",
      });
    }

    const allowedNextStates: Record<NearBudgetReservationState, readonly NearBudgetReservationState[]> = {
      reserved: ["committed", "outcome_unknown", "released"],
      // Once an observed deposit or terminal success commits budget, later
      // contradictory provider observations must be investigated without
      // releasing or reusing that budget.
      committed: [],
      outcome_unknown: ["committed", "outcome_unknown", "released"],
      released: [],
    };
    if (!allowedNextStates[transition.expected_state].includes(transition.next.state)) {
      context.addIssue({
        code: "custom",
        path: ["next", "state"],
        message: `invalid reservation transition from ${transition.expected_state} to ${transition.next.state}`,
      });
    }

    const reconciliationIdentityMatches = !transition.reconciliation
      || (
        transition.reconciliation.principal_id === transition.principal_id
        && transition.reconciliation.account_id === transition.account_id
        && transition.reconciliation.network === transition.network
      );
    if (!reconciliationIdentityMatches) {
      context.addIssue({
        code: "custom",
        path: ["reconciliation"],
        message: "reservation reconciliation must match principal, account, and network",
      });
    }

    if (
      transition.next.state === "outcome_unknown"
      && transition.reconciliation?.outcome !== "unknown"
    ) {
      context.addIssue({
        code: "custom",
        path: ["reconciliation"],
        message: "an unknown reservation requires explicit unknown reconciliation evidence",
      });
    }
    if (transition.next.state === "committed") {
      const hasTerminalSuccess = transition.reconciliation?.outcome === "terminal"
        && transition.reconciliation.provider_status === "SUCCESS";
      const hasObservedDeposit = transition.reconciliation?.outcome === "pending"
        && ["KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING"]
          .includes(transition.reconciliation.provider_status);
      if (!hasTerminalSuccess && !hasObservedDeposit) {
        context.addIssue({
          code: "custom",
          path: ["reconciliation"],
          message: "committing a reservation requires observed-deposit or terminal-success evidence",
        });
      }
      if (transition.expected_state === "outcome_unknown" && !hasTerminalSuccess) {
        context.addIssue({
          code: "custom",
          path: ["reconciliation"],
          message: "an unknown reservation becomes committed only after terminal-success reconciliation",
        });
      }
    }
    if (transition.next.state === "released") {
      if (
        transition.next.release_reason === "cancelled_before_dispatch"
        && (transition.expected_state !== "reserved" || transition.reconciliation !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["next", "release_reason"],
          message: "pre-dispatch cancellation can release only a reserved, unreconciled reservation",
        });
      }
      const requiredTerminalStatus = transition.next.release_reason === "provider_refunded"
        ? "REFUNDED"
        : transition.next.release_reason === "provider_failed_after_reconciliation"
          ? "FAILED"
          : undefined;
      if (requiredTerminalStatus && (
        transition.reconciliation?.outcome !== "terminal"
        || transition.reconciliation.provider_status !== requiredTerminalStatus
      )) {
        context.addIssue({
          code: "custom",
          path: ["reconciliation"],
          message: `${transition.next.release_reason} requires matching terminal reconciliation evidence`,
        });
      }
    }
  });
export type NearBudgetReservationTransition = z.infer<typeof NearBudgetReservationTransitionSchema>;

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
    version: z.literal("pilot-near-execution-attempt-v1"),
    attempt_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    idempotency_version: NearIdempotencyVersionSchema,
    idempotency_key: SafeIdentifierSchema,
    idempotency_request_digest: Sha256DigestSchema,
    reservation_id: SafeIdentifierSchema,
    approval_digest: Sha256DigestSchema,
    quote_id: SafeIdentifierSchema,
    state: NearExecutionAttemptStateSchema,
    provider_status: Near1ClickProviderStatusSchema.optional(),
    reconciliation: NearReconciliationEvidenceSchema.optional(),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
    unknown_since: DateTimeSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (Date.parse(attempt.updated_at) < Date.parse(attempt.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "attempt cannot be updated before creation",
      });
    }
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
    if (attempt.state === "unknown" && attempt.reconciliation?.outcome !== "unknown") {
      context.addIssue({
        code: "custom",
        path: ["reconciliation"],
        message: "unknown attempts require explicit unknown reconciliation evidence",
      });
    }
    if (terminalStatus && (
      attempt.reconciliation?.outcome !== "terminal"
      || attempt.reconciliation.provider_status !== terminalStatus
    )) {
      context.addIssue({
        code: "custom",
        path: ["reconciliation"],
        message: `terminal ${attempt.state} requires matching terminal reconciliation evidence`,
      });
    }
    if (attempt.reconciliation) {
      const identityMatches = attempt.reconciliation.attempt_id === attempt.attempt_id
        && attempt.reconciliation.principal_id === attempt.principal_id
        && attempt.reconciliation.account_id === attempt.account_id
        && attempt.reconciliation.network === attempt.network;
      if (!identityMatches) {
        context.addIssue({
          code: "custom",
          path: ["reconciliation"],
          message: "reconciliation evidence must match attempt principal, account, and network",
        });
      }
      if (
        "provider_status" in attempt.reconciliation
        && attempt.provider_status !== undefined
        && attempt.reconciliation.provider_status !== attempt.provider_status
      ) {
        context.addIssue({
          code: "custom",
          path: ["provider_status"],
          message: "attempt and reconciliation provider statuses must match",
        });
      }
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
    account_id: NearAccountIdSchema,
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
