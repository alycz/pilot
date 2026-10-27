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
  "near.intents.owner-funded.reserve",
  "near.intents.owner-funded.reconcile",
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
    operations: z.array(NearAuthorizedOperationSchema).min(1).max(6)
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

/**
 * Hosted reverse route confirmed against the 1Click catalog. Execution stays
 * default-off until source and destination receipts are independently verified;
 * this contract does not imply that durable storage is always needed.
 */
export const NearNativeNearToArbitrumUsdcRouteSchema = z
  .object({
    version: z.literal("pilot-near-native-to-arbitrum-usdc-route-v1"),
    profile_status: z.literal("hosted-default-off"),
    execution_default: z.literal("off"),
    activation_gate: z.literal("independent-source-and-destination-receipt-verification-required"),
    origin_chain: z.literal("near"),
    origin_network: z.literal("near:mainnet"),
    origin_asset_id: z.literal(NEAR_WRAPPED_NEAR_ASSET_ID),
    origin_token_contract: z.literal(NEAR_WRAPPED_NEAR_CONTRACT),
    origin_decimals: z.literal(24),
    source_transfer_asset: z.literal("native-near"),
    managed_wrapping_by_1click: z.literal(true),
    destination_chain: z.literal("arb"),
    destination_chain_id: z.literal(42161),
    destination_asset_id: z.literal(NEAR_ARBITRUM_USDC_ASSET_ID),
    destination_token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
    destination_decimals: z.literal(6),
    deposit_mode: z.literal("SIMPLE"),
    funding_mode: z.literal("manual-owner-wallet-send"),
    manual_owner_funding_only: z.literal(true),
    pilot_budget_scope: z.literal("does-not-control-owner-wallet-send"),
  })
  .strict();
export type NearNativeNearToArbitrumUsdcRoute = z.infer<
  typeof NearNativeNearToArbitrumUsdcRouteSchema
>;

export const NearNativeNearToArbitrumUsdcExecutableQuoteRequestSchema =
  Near1ClickExecutableQuoteRequestSchema.superRefine((request, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    if (request.originAsset !== NEAR_WRAPPED_NEAR_ASSET_ID) {
      issue(["originAsset"], "origin asset must be the catalogued wrapped-NEAR identifier");
    }
    if (request.destinationAsset !== NEAR_ARBITRUM_USDC_ASSET_ID) {
      issue(["destinationAsset"], "destination asset must be canonical Arbitrum USDC");
    }
    if (!NearAccountIdSchema.safeParse(request.refundTo).success) {
      issue(["refundTo"], "refund destination must be a NEAR account");
    }
    if (!ArbitrumAddressSchema.safeParse(request.recipient).success) {
      issue(["recipient"], "recipient must be a reviewed Arbitrum address");
    }
    if (request.depositMode !== "SIMPLE") {
      issue(["depositMode"], "the provisional native NEAR route rejects memo deposits");
    }
  });
export type NearNativeNearToArbitrumUsdcExecutableQuoteRequest = z.infer<
  typeof NearNativeNearToArbitrumUsdcExecutableQuoteRequestSchema
>;

export const NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema = z
  .object({
    version: z.literal("pilot-near-native-to-arbitrum-usdc-quote-binding-v1"),
    route: NearNativeNearToArbitrumUsdcRouteSchema,
    provider_signature_verified: z.literal(true),
    provider_signature: z.string().min(1).max(2_048),
    quote_hash: Near1ClickQuoteHashSchema,
    correlation_id: SafeIdentifierSchema,
    provider_timestamp: DateTimeSchema,
    request_echo: NearNativeNearToArbitrumUsdcExecutableQuoteRequestSchema,
    provider_quote_response: Near1ClickExecutableQuoteResponseSchema,
    amount_in: AtomicAmountSchema,
    min_amount_out: AtomicAmountSchema,
    recipient: ArbitrumAddressSchema,
    refund_to: NearAccountIdSchema,
    deposit_address: NearAccountIdSchema,
    deposit_memo_present: z.literal(false),
    provider_deadline_at: DateTimeSchema,
    provider_time_when_inactive_at: DateTimeSchema,
    approval_expires_at: DateTimeSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    const response = binding.provider_quote_response;
    if (binding.provider_signature !== response.signature) {
      issue(["provider_signature"], "signature must match the verified executable response");
    }
    if (binding.correlation_id !== response.correlationId) {
      issue(["correlation_id"], "correlation id must match the verified executable response");
    }
    if (binding.provider_timestamp !== response.timestamp) {
      issue(["provider_timestamp"], "timestamp must match the verified executable response");
    }
    if (JSON.stringify(binding.request_echo) !== JSON.stringify(response.quoteRequest)) {
      issue(["request_echo"], "request echo must match the verified executable response");
    }
    if (binding.amount_in !== binding.request_echo.amount || binding.amount_in !== response.quote.amountIn) {
      issue(["amount_in"], "input amount must match the request echo and executable response");
    }
    if (binding.min_amount_out !== response.quote.minAmountOut) {
      issue(["min_amount_out"], "minimum output must match the executable response");
    }
    if (binding.recipient.toLowerCase() !== binding.request_echo.recipient.toLowerCase()) {
      issue(["recipient"], "recipient must match the signed request echo");
    }
    if (binding.refund_to !== binding.request_echo.refundTo) {
      issue(["refund_to"], "refund account must match the signed request echo");
    }
    if (binding.deposit_address !== response.quote.depositAddress) {
      issue(["deposit_address"], "deposit account must match the executable response");
    }
    if (response.quote.depositMemo !== undefined) {
      issue(["provider_quote_response", "quote", "depositMemo"], "memo-bearing deposits are not supported");
    }
    if (
      binding.provider_deadline_at !== binding.request_echo.deadline
      || binding.provider_deadline_at !== response.quote.deadline
    ) {
      issue(["provider_deadline_at"], "refund-start deadline must match request and response");
    }
    if (binding.provider_time_when_inactive_at !== response.quote.timeWhenInactive) {
      issue(["provider_time_when_inactive_at"], "inactivity time must match the executable response");
    }
    if (Date.parse(binding.provider_time_when_inactive_at) > Date.parse(binding.provider_deadline_at)) {
      issue(["provider_time_when_inactive_at"], "inactivity time cannot follow refund start");
    }
    if (
      Date.parse(binding.approval_expires_at) <= Date.parse(binding.provider_timestamp)
      || Date.parse(binding.approval_expires_at) > Date.parse(binding.provider_deadline_at)
    ) {
      issue(["approval_expires_at"], "quote review must expire after issuance and no later than refund start");
    }
  });
export type NearNativeNearToArbitrumUsdcExecutableQuoteBinding = z.infer<
  typeof NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema
>;

export const NearNativeNearToArbitrumUsdcReservationBindingSchema = z
  .object({
    version: z.literal("pilot-near-native-near-to-arbitrum-usdc-reservation-v1"),
    reservation_id: SafeIdentifierSchema,
    attempt_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    near_account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    idempotency_version: NearIdempotencyVersionSchema,
    idempotency_key: SafeIdentifierSchema,
    request_digest: Sha256DigestSchema,
    asset_id: z.literal(NEAR_WRAPPED_NEAR_ASSET_ID),
    amount_atomic: AtomicAmountSchema,
    expected_revision: z.number().int().nonnegative(),
    reserved_revision: z.number().int().positive(),
  })
  .strict()
  .refine((reservation) => reservation.reserved_revision === reservation.expected_revision + 1, {
    path: ["reserved_revision"],
    message: "an atomic reservation must advance the expected revision exactly once",
  });
export type NearNativeNearToArbitrumUsdcReservationBinding = z.infer<
  typeof NearNativeNearToArbitrumUsdcReservationBindingSchema
>;

export const NearNativeNearToArbitrumUsdcApprovalPayloadSchema = z
  .object({
    version: z.literal("pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1"),
    route: NearNativeNearToArbitrumUsdcRouteSchema,
    principal_id: SafeIdentifierSchema,
    near_account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    policy_digest: Sha256DigestSchema,
    quote_hash: Near1ClickQuoteHashSchema,
    correlation_id: SafeIdentifierSchema,
    origin_asset_id: z.literal(NEAR_WRAPPED_NEAR_ASSET_ID),
    destination_asset_id: z.literal(NEAR_ARBITRUM_USDC_ASSET_ID),
    amount_in: AtomicAmountSchema,
    min_amount_out: AtomicAmountSchema,
    recipient: ArbitrumAddressSchema,
    refund_to: NearAccountIdSchema,
    deposit_address: NearAccountIdSchema,
    deposit_memo_present: z.literal(false),
    provider_deadline_at: DateTimeSchema,
    approved_at: DateTimeSchema,
    approval_expires_at: DateTimeSchema,
    reservation: NearNativeNearToArbitrumUsdcReservationBindingSchema,
  })
  .strict()
  .superRefine((approval, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    const approvedAt = Date.parse(approval.approved_at);
    const expiresAt = Date.parse(approval.approval_expires_at);
    if (expiresAt <= approvedAt || expiresAt - approvedAt > 5 * 60_000) {
      issue(["approval_expires_at"], "economic approval must be positive and no longer than five minutes");
    }
    if (expiresAt > Date.parse(approval.provider_deadline_at)) {
      issue(["approval_expires_at"], "economic approval must expire before provider refund start");
    }
    const reservation = approval.reservation;
    if (
      reservation.principal_id !== approval.principal_id
      || reservation.near_account_id !== approval.near_account_id
      || reservation.network !== approval.network
      || reservation.asset_id !== approval.origin_asset_id
      || reservation.amount_atomic !== approval.amount_in
    ) {
      issue(["reservation"], "reservation identity and amount must match the economic approval");
    }
  });
export type NearNativeNearToArbitrumUsdcApprovalPayload = z.infer<
  typeof NearNativeNearToArbitrumUsdcApprovalPayloadSchema
>;

export const NEAR_NATIVE_NEAR_TO_ARBITRUM_USDC_APPROVAL_DOMAIN =
  "pilot.near-intents.native-near-to-arbitrum-usdc.approval.v1" as const;

export function canonicalNearNativeNearToArbitrumUsdcApprovalJson(
  value: NearNativeNearToArbitrumUsdcApprovalPayload,
): string {
  return canonicalJson(NearNativeNearToArbitrumUsdcApprovalPayloadSchema.parse(value));
}

export async function computeNearNativeNearToArbitrumUsdcApprovalDigest(
  value: NearNativeNearToArbitrumUsdcApprovalPayload,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${NEAR_NATIVE_NEAR_TO_ARBITRUM_USDC_APPROVAL_DOMAIN}\0${canonicalNearNativeNearToArbitrumUsdcApprovalJson(value)}`,
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const NearNativeNearAccountControlProofSchema = z
  .object({
    version: z.literal("pilot-near-account-control-proof-v1"),
    proof_kind: z.literal("nep413"),
    scope: z.literal("source-account-control-only"),
    grants_economic_transfer_approval: z.literal(false),
    authorization_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    near_account_id: NearAccountIdSchema,
    network: z.literal("near:mainnet"),
    verified_at: DateTimeSchema,
  })
  .strict();
export type NearNativeNearAccountControlProof = z.infer<
  typeof NearNativeNearAccountControlProofSchema
>;

export const NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema = z
  .object({
    version: z.literal("pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1"),
    payload: NearNativeNearToArbitrumUsdcApprovalPayloadSchema,
    approval_digest: Sha256DigestSchema,
    account_control: NearNativeNearAccountControlProofSchema,
    economic_approval: z.object({
      approval_id: SafeIdentifierSchema,
      method: z.literal("owner-reviewed-native-near-transfer"),
      owner_confirmed: z.literal(true),
      approved_payload_digest: Sha256DigestSchema,
      confirmed_at: DateTimeSchema,
    }).strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    if (envelope.economic_approval.approved_payload_digest !== envelope.approval_digest) {
      issue(["economic_approval", "approved_payload_digest"], "owner confirmation must bind the approval digest");
    }
    if (
      envelope.account_control.principal_id !== envelope.payload.principal_id
      || envelope.account_control.near_account_id !== envelope.payload.near_account_id
      || envelope.account_control.network !== envelope.payload.network
    ) {
      issue(["account_control"], "account-control proof must match approval principal and NEAR account");
    }
    const verifiedAt = Date.parse(envelope.account_control.verified_at);
    const confirmedAt = Date.parse(envelope.economic_approval.confirmed_at);
    if (verifiedAt > confirmedAt || confirmedAt - verifiedAt > 5 * 60_000) {
      issue(["account_control", "verified_at"], "account-control proof must be fresh when economic approval is confirmed");
    }
    if (envelope.economic_approval.confirmed_at !== envelope.payload.approved_at) {
      issue(["economic_approval", "confirmed_at"], "confirmation time must match approval issue time");
    }
  });
export type NearNativeNearToArbitrumUsdcEconomicApprovalEnvelope = z.infer<
  typeof NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema
>;

export async function verifyNearNativeNearToArbitrumUsdcEconomicApproval(
  value: NearNativeNearToArbitrumUsdcEconomicApprovalEnvelope,
): Promise<boolean> {
  const parsed = NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema.safeParse(value);
  if (!parsed.success) return false;
  return await computeNearNativeNearToArbitrumUsdcApprovalDigest(parsed.data.payload)
    === parsed.data.approval_digest;
}

export const NearNativeNearToArbitrumUsdcFundingInstructionsSchema = z
  .object({
    version: z.literal("pilot-near-native-near-to-arbitrum-usdc-funding-instructions-v1"),
    route_version: z.literal("pilot-near-native-to-arbitrum-usdc-route-v1"),
    funding_method: z.literal("manual-native-near-transfer"),
    network: z.literal("near:mainnet"),
    quote_hash: Near1ClickQuoteHashSchema,
    correlation_id: SafeIdentifierSchema,
    source_account_id: NearAccountIdSchema,
    refund_account_id: NearAccountIdSchema,
    destination_recipient: ArbitrumAddressSchema,
    deposit_account_id: NearAccountIdSchema,
    deposit_memo_present: z.literal(false),
    amount_yocto_near: AtomicAmountSchema,
    provider_deadline_at: DateTimeSchema,
  })
  .strict();
export type NearNativeNearToArbitrumUsdcFundingInstructions = z.infer<
  typeof NearNativeNearToArbitrumUsdcFundingInstructionsSchema
>;

export const NearNativeNearSourceFundingEvidenceSchema = z
  .object({
    version: z.literal("pilot-near-native-near-source-funding-v1"),
    provenance: z.literal("near-rpc-finalized-native-transfer"),
    network: z.literal("near:mainnet"),
    transaction_hash: NearTransactionOrReceiptHashSchema,
    receipt_id: NearTransactionOrReceiptHashSchema,
    block_height: z.number().int().positive(),
    finality: z.literal("final"),
    execution_status: z.literal("SUCCESS"),
    source_account_id: NearAccountIdSchema,
    receiver_account_id: NearAccountIdSchema,
    amount_yocto_near: AtomicAmountSchema,
    included_at: DateTimeSchema,
    verified_at: DateTimeSchema,
  })
  .strict();
export type NearNativeNearSourceFundingEvidence = z.infer<
  typeof NearNativeNearSourceFundingEvidenceSchema
>;

export const NearArbitrumCanonicalUsdcReceiptEvidenceSchema = z
  .object({
    version: z.literal("pilot-near-arbitrum-canonical-usdc-receipt-v1"),
    provenance: z.literal("arbitrum-rpc-finalized-erc20-transfer"),
    chain: z.literal("arb"),
    chain_id: z.literal(42161),
    transaction_hash: ArbitrumTransactionHashSchema,
    block_hash: ArbitrumTransactionHashSchema,
    block_number: z.number().int().nonnegative(),
    transaction_index: z.number().int().nonnegative(),
    log_index: z.number().int().nonnegative(),
    finality: z.literal("final"),
    receipt_status: z.literal("success"),
    event_signature: z.literal("Transfer(address,address,uint256)"),
    token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
    token_decimals: z.literal(6),
    sender_address: ArbitrumAddressSchema,
    recipient_address: ArbitrumAddressSchema,
    amount_received: AtomicAmountSchema,
    verified_at: DateTimeSchema,
  })
  .strict();
export type NearArbitrumCanonicalUsdcReceiptEvidence = z.infer<
  typeof NearArbitrumCanonicalUsdcReceiptEvidenceSchema
>;

export const NearNativeNearRefundReceiptEvidenceSchema = z
  .object({
    version: z.literal("pilot-near-native-near-refund-receipt-v1"),
    provenance: z.literal("near-rpc-finalized-refund"),
    network: z.literal("near:mainnet"),
    transaction_hash: NearTransactionOrReceiptHashSchema,
    receipt_id: NearTransactionOrReceiptHashSchema,
    block_height: z.number().int().positive(),
    finality: z.literal("final"),
    execution_status: z.literal("SUCCESS"),
    refund_account_id: NearAccountIdSchema,
    amount_refunded_yocto_near: AtomicAmountSchema,
    verified_at: DateTimeSchema,
  })
  .strict();
export type NearNativeNearRefundReceiptEvidence = z.infer<
  typeof NearNativeNearRefundReceiptEvidenceSchema
>;

const NearNativeNearToArbitrumUsdcReconciliationBaseSchema = z.object({
  version: z.literal("pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1"),
  quote_hash: Near1ClickQuoteHashSchema,
  correlation_id: SafeIdentifierSchema,
  deposit_account_id: NearAccountIdSchema,
  deposit_memo_present: z.literal(false),
  checked_at: DateTimeSchema,
  safe_to_resubmit: z.literal(false),
});

export const NearNativeNearToArbitrumUsdcReconciliationSchema = z
  .discriminatedUnion("outcome", [
    NearNativeNearToArbitrumUsdcReconciliationBaseSchema.extend({
      outcome: z.literal("pending"),
      provider_status: Near1ClickPendingStatusSchema,
    }).strict(),
    NearNativeNearToArbitrumUsdcReconciliationBaseSchema.extend({
      outcome: z.literal("unknown"),
      reason: NearReconciliationUnknownReasonSchema,
    }).strict(),
    NearNativeNearToArbitrumUsdcReconciliationBaseSchema.extend({
      outcome: z.literal("refunded"),
      provider_status: z.literal("REFUNDED"),
      refund_receipt: NearNativeNearRefundReceiptEvidenceSchema,
    }).strict(),
    NearNativeNearToArbitrumUsdcReconciliationBaseSchema.extend({
      outcome: z.literal("failed"),
      provider_status: z.literal("FAILED"),
      independent_terminal_evidence: z.literal(false),
    }).strict(),
    NearNativeNearToArbitrumUsdcReconciliationBaseSchema.extend({
      outcome: z.literal("provider-success-only"),
      provider_status: z.literal("SUCCESS"),
      independent_destination_receipt: z.literal(false),
    }).strict(),
    NearNativeNearToArbitrumUsdcReconciliationBaseSchema.extend({
      outcome: z.literal("independently-settled"),
      provider_status: Near1ClickProviderStatusSchema,
      destination_receipt: NearArbitrumCanonicalUsdcReceiptEvidenceSchema,
    }).strict(),
  ])
  .superRefine((reconciliation, context) => {
    if (
      reconciliation.outcome === "independently-settled"
      && ["REFUNDED", "FAILED"].includes(reconciliation.provider_status)
    ) {
      context.addIssue({
        code: "custom",
        path: ["provider_status"],
        message: "terminal provider failure conflicts with independently verified delivery",
      });
    }
  });
export type NearNativeNearToArbitrumUsdcReconciliation = z.infer<
  typeof NearNativeNearToArbitrumUsdcReconciliationSchema
>;

export const NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema = z
  .object({
    version: z.literal("pilot-near-native-near-to-arbitrum-usdc-owner-funded-execution-v1"),
    route: NearNativeNearToArbitrumUsdcRouteSchema,
    quote: NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
    approval: NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema,
    funding_instructions: NearNativeNearToArbitrumUsdcFundingInstructionsSchema,
    source_funding: NearNativeNearSourceFundingEvidenceSchema,
    reconciliation: NearNativeNearToArbitrumUsdcReconciliationSchema,
  })
  .strict()
  .superRefine((execution, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    const quote = execution.quote;
    const payload = execution.approval.payload;
    const instructions = execution.funding_instructions;
    const source = execution.source_funding;
    const reconciliation = execution.reconciliation;
    if (
      JSON.stringify(execution.route) !== JSON.stringify(quote.route)
      || JSON.stringify(execution.route) !== JSON.stringify(payload.route)
    ) {
      issue(["route"], "quote and approval must bind the same route profile");
    }
    if (
      payload.quote_hash !== quote.quote_hash
      || payload.correlation_id !== quote.correlation_id
      || payload.origin_asset_id !== quote.route.origin_asset_id
      || payload.destination_asset_id !== quote.route.destination_asset_id
      || payload.amount_in !== quote.amount_in
      || payload.min_amount_out !== quote.min_amount_out
      || payload.recipient.toLowerCase() !== quote.recipient.toLowerCase()
      || payload.refund_to !== quote.refund_to
      || payload.deposit_address !== quote.deposit_address
      || payload.provider_deadline_at !== quote.provider_deadline_at
      || payload.approval_expires_at !== quote.approval_expires_at
    ) {
      issue(["approval", "payload"], "economic approval must bind every material quote field");
    }
    if (Date.parse(payload.approved_at) < Date.parse(quote.provider_timestamp)) {
      issue(["approval", "payload", "approved_at"], "approval cannot predate the provider quote");
    }
    if (
      instructions.route_version !== execution.route.version
      || instructions.quote_hash !== quote.quote_hash
      || instructions.correlation_id !== quote.correlation_id
      || instructions.source_account_id !== payload.near_account_id
      || instructions.refund_account_id !== quote.refund_to
      || instructions.destination_recipient.toLowerCase() !== quote.recipient.toLowerCase()
      || instructions.deposit_account_id !== quote.deposit_address
      || instructions.amount_yocto_near !== quote.amount_in
      || instructions.provider_deadline_at !== quote.provider_deadline_at
    ) {
      issue(["funding_instructions"], "funding instructions must bind the approved executable quote");
    }
    if (
      source.source_account_id !== instructions.source_account_id
      || source.receiver_account_id !== instructions.deposit_account_id
      || source.amount_yocto_near !== instructions.amount_yocto_near
    ) {
      issue(["source_funding"], "finalized source transfer must match funding instructions");
    }
    if (
      Date.parse(source.included_at) < Date.parse(payload.approved_at)
      || Date.parse(source.included_at) > Date.parse(payload.approval_expires_at)
      || Date.parse(source.verified_at) < Date.parse(source.included_at)
    ) {
      issue(
        ["source_funding", "included_at"],
        "native transfer must be included during the fresh economic approval window",
      );
    }
    if (
      reconciliation.quote_hash !== quote.quote_hash
      || reconciliation.correlation_id !== quote.correlation_id
      || reconciliation.deposit_account_id !== quote.deposit_address
    ) {
      issue(["reconciliation"], "reconciliation must bind the executable quote and deposit route");
    }
    if (reconciliation.outcome === "refunded") {
      if (reconciliation.refund_receipt.refund_account_id !== quote.refund_to) {
        issue(["reconciliation", "refund_receipt", "refund_account_id"], "refund must return to the reviewed NEAR account");
      }
    }
    if (reconciliation.outcome === "independently-settled") {
      const receipt = reconciliation.destination_receipt;
      if (receipt.recipient_address.toLowerCase() !== quote.recipient.toLowerCase()) {
        issue(["reconciliation", "destination_receipt", "recipient_address"], "USDC event recipient must match owner review");
      }
      if (BigInt(receipt.amount_received) < BigInt(quote.min_amount_out)) {
        issue(["reconciliation", "destination_receipt", "amount_received"], "USDC event must satisfy minimum output");
      }
    }
  });
export type NearNativeNearToArbitrumUsdcOwnerFundedExecution = z.infer<
  typeof NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema
>;

export async function verifyNearNativeNearToArbitrumUsdcOwnerFundedExecution(
  value: NearNativeNearToArbitrumUsdcOwnerFundedExecution,
): Promise<boolean> {
  const parsed = NearNativeNearToArbitrumUsdcOwnerFundedExecutionSchema.safeParse(value);
  if (!parsed.success) return false;
  return verifyNearNativeNearToArbitrumUsdcEconomicApproval(parsed.data.approval);
}

export const NearNativeNearToArbitrumUsdcReserveRequestSchema = z
  .object({
    version: z.literal("pilot-near-native-to-arbitrum-usdc-reserve-request-v1"),
    quote_binding: NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
    approval: NearNativeNearToArbitrumUsdcEconomicApprovalEnvelopeSchema,
    idempotency_version: NearIdempotencyVersionSchema,
    idempotency_key: SafeIdentifierSchema,
    attempt_id: SafeIdentifierSchema,
    reservation_id: SafeIdentifierSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const issue = (path: string[], message: string) => context.addIssue({
      code: "custom",
      path,
      message,
    });
    const quote = request.quote_binding;
    const payload = request.approval.payload;
    const reservation = payload.reservation;
    if (
      JSON.stringify(quote.route) !== JSON.stringify(payload.route)
      || payload.quote_hash !== quote.quote_hash
      || payload.correlation_id !== quote.correlation_id
      || payload.origin_asset_id !== quote.route.origin_asset_id
      || payload.destination_asset_id !== quote.route.destination_asset_id
      || payload.amount_in !== quote.amount_in
      || payload.min_amount_out !== quote.min_amount_out
      || payload.recipient.toLowerCase() !== quote.recipient.toLowerCase()
      || payload.refund_to !== quote.refund_to
      || payload.deposit_address !== quote.deposit_address
      || payload.deposit_memo_present !== quote.deposit_memo_present
      || payload.provider_deadline_at !== quote.provider_deadline_at
      || payload.approval_expires_at !== quote.approval_expires_at
    ) {
      issue(["approval", "payload"], "admission approval must bind every material executable quote field");
    }
    if (
      request.idempotency_version !== reservation.idempotency_version
      || request.idempotency_key !== reservation.idempotency_key
      || request.attempt_id !== reservation.attempt_id
      || request.reservation_id !== reservation.reservation_id
    ) {
      issue(["reservation_id"], "admission identifiers must match the approved atomic reservation");
    }
  });
export type NearNativeNearToArbitrumUsdcReserveRequest = z.infer<
  typeof NearNativeNearToArbitrumUsdcReserveRequestSchema
>;

/** Verify the economic approval with a trusted server clock before admission. */
export async function verifyNearNativeNearToArbitrumUsdcReserveRequest(
  value: NearNativeNearToArbitrumUsdcReserveRequest,
  nowMs: number,
): Promise<boolean> {
  if (!Number.isFinite(nowMs)) return false;
  const parsed = NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse(value);
  if (!parsed.success) return false;
  const approvedAt = Date.parse(parsed.data.approval.payload.approved_at);
  const approvalExpiresAt = Date.parse(parsed.data.approval.payload.approval_expires_at);
  const providerDeadlineAt = Date.parse(parsed.data.quote_binding.provider_deadline_at);
  if (nowMs < approvedAt || nowMs >= approvalExpiresAt || nowMs >= providerDeadlineAt) {
    return false;
  }
  return verifyNearNativeNearToArbitrumUsdcEconomicApproval(parsed.data.approval);
}

const NearNativeNearToArbitrumUsdcReserveResultBaseSchema = z.object({
  version: z.literal("pilot-near-native-to-arbitrum-usdc-reserve-result-v1"),
  source: z.literal("live"),
  provider_signature_verified: z.literal(true),
  admission_id: SafeIdentifierSchema,
  quote_hash: Near1ClickQuoteHashSchema,
  correlation_id: SafeIdentifierSchema,
  approval_digest: Sha256DigestSchema,
  request_digest: Sha256DigestSchema,
  idempotency_version: NearIdempotencyVersionSchema,
  idempotency_key: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  reservation_id: SafeIdentifierSchema,
  attempt_state: z.literal("approved"),
  reservation_state: z.literal("reserved"),
  attempt_revision: z.number().int().positive(),
  reservation_revision: z.number().int().positive(),
  funding_instructions: NearNativeNearToArbitrumUsdcFundingInstructionsSchema,
  execution_enabled: z.literal(false),
  manual_owner_funding_only: z.literal(true),
});

export const NearNativeNearToArbitrumUsdcReserveResultSchema = z.discriminatedUnion(
  "action",
  [
    NearNativeNearToArbitrumUsdcReserveResultBaseSchema.extend({
      action: z.literal("reserved"),
      replayed_existing: z.literal(false),
    }).strict(),
    NearNativeNearToArbitrumUsdcReserveResultBaseSchema.extend({
      action: z.literal("replay"),
      replayed_existing: z.literal(true),
    }).strict(),
  ],
);
export type NearNativeNearToArbitrumUsdcReserveResult = z.infer<
  typeof NearNativeNearToArbitrumUsdcReserveResultSchema
>;

const NearNativeNearToArbitrumUsdcReconcileBaseSchema = z.object({
  ...NearNativeNearToArbitrumUsdcReserveRequestSchema.shape,
  version: z.literal("pilot-near-native-to-arbitrum-usdc-reconcile-request-v1"),
  account_id: NearAccountIdSchema,
  transition_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  expected_entry_revision: z.number().int().positive(),
});

export const NearNativeNearToArbitrumUsdcReconcileRequestSchema = z.discriminatedUnion(
  "stage",
  [
    NearNativeNearToArbitrumUsdcReconcileBaseSchema.extend({
      stage: z.literal("source-funding"),
      near_transaction_hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,45}$/),
    }).strict(),
    NearNativeNearToArbitrumUsdcReconcileBaseSchema.extend({
      stage: z.literal("settlement"),
    }).strict(),
  ],
).superRefine((request, context) => {
  const { stage: _stage, account_id: _account, transition_id: _transition,
    expected_entry_revision: _revision, ...rest } = request;
  const { near_transaction_hash: _hash, ...reserveFields } = rest as typeof rest & {
    near_transaction_hash?: string;
  };
  const reserve = NearNativeNearToArbitrumUsdcReserveRequestSchema.safeParse({
    ...reserveFields,
    version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1",
  });
  if (!reserve.success) {
    context.addIssue({ code: "custom", path: ["approval"], message: "reconciliation must preserve the exact approved reservation" });
  }
  if (request.account_id !== request.approval.payload.near_account_id ||
      request.account_id !== request.quote_binding.refund_to) {
    context.addIssue({ code: "custom", path: ["account_id"], message: "reconciliation account must match the approved source and refund account" });
  }
});
export type NearNativeNearToArbitrumUsdcReconcileRequest = z.infer<
  typeof NearNativeNearToArbitrumUsdcReconcileRequestSchema
>;

export const NearNativeNearToArbitrumUsdcReconcileResultSchema = z.object({
  version: z.literal("pilot-near-native-to-arbitrum-usdc-reconcile-result-v1"),
  stage: z.enum(["source-funding", "settlement"]),
  action: z.enum(["source-verified", "provider-observed", "destination-verified", "unknown", "replay"]),
  attempt_id: SafeIdentifierSchema,
  lifecycle_state: z.enum(["reserved", "source_verified", "provider_observed", "destination_verified", "refunded"]),
  attempt_revision: z.number().int().positive(),
  lifecycle_revision: z.number().int().positive(),
  provider_status: Near1ClickProviderStatusSchema.optional(),
  source_transaction_hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,45}$/).optional(),
  destination_transaction_hash: ArbitrumTransactionHashSchema.optional(),
  reason: z.enum([
    "timeout", "not_found", "invalid_response", "transport_error",
    "refund-receipt-required", "destination-receipt-unverified",
  ]).optional(),
  safe_to_resubmit: z.literal(false),
  execution_enabled: z.literal(false),
}).strict().superRefine((result, context) => {
  if (result.action === "source-verified" && result.source_transaction_hash === undefined) {
    context.addIssue({ code: "custom", path: ["source_transaction_hash"], message: "source evidence hash is required" });
  }
  if (result.action === "destination-verified" && result.destination_transaction_hash === undefined) {
    context.addIssue({ code: "custom", path: ["destination_transaction_hash"], message: "destination evidence hash is required" });
  }
  if (result.action === "unknown" && result.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "unknown reconciliation requires a bounded reason" });
  }
});
export type NearNativeNearToArbitrumUsdcReconcileResult = z.infer<
  typeof NearNativeNearToArbitrumUsdcReconcileResultSchema
>;
