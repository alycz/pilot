import { z } from "zod";

import type { OpContext, OpDef } from "../catalog/registry";
import {
  createOneClickClient,
  ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE,
  OneClickClientError,
  type OneClickClient,
  type OneClickToken,
} from "../near/one-click";

const VisibleTextSchema = z.string().trim().min(1).max(512)
  .regex(/^[\x21-\x7e]+$/, "must contain only visible ASCII characters");
const AssetIdSchema = z.string().trim().min(3).max(320)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:\S+$/, "must be a namespaced 1Click asset ID");
const BlockchainSchema = z.enum([
  "near", "eth", "base", "arb", "btc", "sol", "ton", "dash", "doge",
  "xrp", "zec", "gnosis", "bera", "bsc", "pol", "tron", "sui",
  "movement", "op", "avax", "stellar", "aptos", "cardano", "ltc",
  "xlayer", "monad", "bch", "adi", "plasma", "scroll", "starknet",
  "aleo", "hypercore", "fogo", "hood", "hlevm", "qtc", "abs",
]);
const AtomicAmountSchema = z.string().max(128)
  .regex(/^[1-9][0-9]*$/, "must be a positive atomic-unit integer string");
const DateTimeSchema = z.string().datetime({ offset: true });
const CorrelationIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const QuoteHashSchema = z.string().min(43).max(45)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const EvmAddressSchema = z.string().regex(/^0x[0-9A-Fa-f]{40}$/);
const NearAccountSchema = z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/);

export const ONE_CLICK_EXECUTABLE_REVIEW_PROFILE = "arb-usdc-to-wnear-manual-v1";
export const ONE_CLICK_EXECUTABLE_REVIEW_FIXTURE_ID = "arb-usdc-to-wnear-review-fixture-v1";

type ExecutableReviewErrorCode =
  | "EXECUTABLE_REVIEW_DISABLED"
  | "EXECUTABLE_REVIEW_LOCAL_ONLY"
  | "EXECUTABLE_REVIEW_AUTH_REQUIRED"
  | "ROUTE_CATALOG_MISMATCH"
  | "UNSUPPORTED_MANUAL_FUNDING_QUOTE";

export class OneClickExecutableReviewError extends Error {
  constructor(readonly code: ExecutableReviewErrorCode, message: string) {
    super(message);
    this.name = "OneClickExecutableReviewError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneClickClient(value: unknown): value is OneClickClient {
  return isRecord(value) &&
    typeof value.tokens === "function" &&
    typeof value.quote === "function" &&
    typeof value.status === "function";
}

function clientFor(ctx: OpContext, allowExecutableQuotes = false): OneClickClient {
  if (isOneClickClient(ctx.nearOneClickClient)) return ctx.nearOneClickClient;
  const env = isRecord(ctx.env) ? ctx.env : {};
  const apiKey = typeof env.NEAR_INTENTS_API_KEY === "string"
    ? env.NEAR_INTENTS_API_KEY
    : undefined;
  return createOneClickClient({ apiKey, allowExecutableQuotes });
}

function hasConfiguredPrincipal(value: unknown, principal: string): boolean {
  if (typeof value !== "string") return false;
  return value.split(",").some((pair) => {
    const separator = pair.indexOf(":");
    return separator > 0 && separator < pair.length - 1 && pair.slice(0, separator) === principal;
  });
}

function requireExecutableReviewRuntime(ctx: OpContext): { fixture: boolean } {
  if (ctx.localDevRequest !== true) {
    throw new OneClickExecutableReviewError(
      "EXECUTABLE_REVIEW_LOCAL_ONLY",
      "NEAR Intents executable quote review is available only to local development requests",
    );
  }
  const env = isRecord(ctx.env) ? ctx.env : {};
  if (
    env.HARBOR_LOCAL_DEV !== "true" ||
    env.HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED !== "true" ||
    env.HARBOR_LOCAL_NEAR_INTENTS_PROVIDER_POST_ENABLED !== "true" ||
    env.HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE !== ONE_CLICK_EXECUTABLE_REVIEW_PROFILE ||
    env.MAINNET_EXECUTION !== "false"
  ) {
    throw new OneClickExecutableReviewError(
      "EXECUTABLE_REVIEW_DISABLED",
      "NEAR Intents executable quote review is disabled",
    );
  }
  if (
    typeof ctx.principal !== "string" ||
    ctx.principal.trim().length === 0 ||
    ctx.principal === "local-dev" ||
    !hasConfiguredPrincipal(env.HARBOR_API_KEYS, ctx.principal)
  ) {
    throw new OneClickExecutableReviewError(
      "EXECUTABLE_REVIEW_AUTH_REQUIRED",
      "NEAR Intents executable quote review requires an explicitly configured principal",
    );
  }
  return { fixture: isOneClickClient(ctx.nearOneClickClient) };
}

function requireExactCatalogToken(
  tokens: readonly OneClickToken[],
  expected: { assetId: string; blockchain: string; contractAddress: string; decimals: number },
): OneClickToken {
  const matches = tokens.filter((token) => token.assetId === expected.assetId);
  const token = matches.length === 1 ? matches[0] : undefined;
  if (
    !token ||
    token.blockchain !== expected.blockchain ||
    token.contractAddress !== expected.contractAddress ||
    token.decimals !== expected.decimals
  ) {
    throw new OneClickExecutableReviewError(
      "ROUTE_CATALOG_MISMATCH",
      `Current 1Click token metadata does not exactly attest ${expected.assetId}`,
    );
  }
  return token;
}

function assertManualFundingQuote(
  quote: Awaited<ReturnType<OneClickClient["quote"]>>,
  amountAtomic: string,
  nowMs: number,
): asserts quote is Awaited<ReturnType<OneClickClient["quote"]>> & {
  response: { quote: {
    depositAddress: string;
    deadline: string;
    timeWhenInactive: string;
  } };
} {
  const details = quote.response.quote;
  if (details.amountIn !== amountAtomic) {
    throw new OneClickClientError("REQUEST_MISMATCH", "NEAR Intents executable quote changed the exact input amount");
  }
  if (!details.depositAddress || !EvmAddressSchema.safeParse(details.depositAddress).success) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Executable review requires an Arbitrum EVM deposit address",
    );
  }
  if (details.depositMemo !== undefined) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Memo-based deposits are not supported by this manual Arbitrum funding slice",
    );
  }
  if (!details.deadline || !details.timeWhenInactive) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Executable review requires both provider funding deadlines",
    );
  }
  const inactiveMs = Date.parse(details.timeWhenInactive);
  const deadlineMs = Date.parse(details.deadline);
  if (inactiveMs <= nowMs || deadlineMs <= nowMs || inactiveMs > deadlineMs) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Executable review requires a live and ordered provider funding window",
    );
  }
  if (details.deadline !== quote.response.quoteRequest.deadline) {
    throw new OneClickClientError(
      "REQUEST_MISMATCH",
      "NEAR Intents executable quote deadline did not match the signed request echo",
    );
  }
  if (details.chainDepositAddresses !== undefined) {
    const [only] = details.chainDepositAddresses;
    if (
      details.chainDepositAddresses.length !== 1 ||
      only?.blockchain !== ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.blockchain ||
      only.address !== details.depositAddress ||
      only.memo !== undefined
    ) {
      throw new OneClickExecutableReviewError(
        "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
        "Provider chain deposit metadata did not match the exact Arbitrum funding route",
      );
    }
  }
}

const ExecutableQuoteReviewArgsSchema = z.object({
  route: z.literal(ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.id),
  amount_atomic: AtomicAmountSchema,
  slippage_bps: z.number().int().min(0).max(1_000),
  recipient: NearAccountSchema,
  refund_to: EvmAddressSchema,
  refund_deadline: DateTimeSchema,
  quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
}).strict();

export const ops: OpDef[] = [
  {
    name: "near.intents.tokens",
    family: "near",
    summary: "Read current 1Click-supported asset identifiers without assuming chain or token support.",
    tags: ["near", "intents", "1click", "tokens", "discovery", "earn"],
    args: z.object({
      blockchain: BlockchainSchema.optional(),
      symbol: z.string().trim().min(1).max(32).optional(),
      include_ondo: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).strict(),
    returns: "live 1Click token metadata with exact asset IDs",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.tokens({ blockchain: "near", limit: 100 })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        blockchain?: string;
        symbol?: string;
        include_ondo?: boolean;
        limit?: number;
      };
      const tokens = await clientFor(ctx).tokens({ includeOndo: args.include_ondo });
      const symbol = args.symbol?.toLocaleLowerCase();
      const filtered = tokens.filter((token) =>
        (args.blockchain === undefined || token.blockchain === args.blockchain) &&
        (symbol === undefined || token.symbol.toLocaleLowerCase() === symbol)
      ).sort((left, right) =>
        left.blockchain.localeCompare(right.blockchain) ||
        left.symbol.localeCompare(right.symbol) ||
        left.assetId.localeCompare(right.assetId)
      ).slice(0, args.limit ?? 100);
      return {
        provider: "near-intents-1click",
        source: "live",
        live: true,
        execution_enabled: false,
        count: filtered.length,
        tokens: filtered,
      };
    },
  },
  {
    name: "near.intents.quote",
    family: "near",
    summary: "Request and verify a dry EXACT_INPUT 1Click quote; this operation cannot create a deposit address.",
    tags: ["near", "intents", "1click", "quote", "dry-run", "verified"],
    args: z.object({
      dry: z.literal(true).default(true),
      origin_asset_id: AssetIdSchema,
      destination_asset_id: AssetIdSchema,
      amount: AtomicAmountSchema,
      slippage_bps: z.number().int().min(0).max(10_000),
      deposit_type: z.literal("ORIGIN_CHAIN"),
      recipient: VisibleTextSchema,
      recipient_type: z.literal("DESTINATION_CHAIN"),
      refund_to: VisibleTextSchema,
      refund_type: z.literal("ORIGIN_CHAIN"),
      refund_deadline: DateTimeSchema,
      quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
    }).strict().refine((request) => request.origin_asset_id !== request.destination_asset_id, {
      path: ["destination_asset_id"],
      message: "origin and destination assets must differ",
    }),
    returns: "provider-signed dry quote with canonical quote hash and no execution address",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.quote({ dry: true, origin_asset_id: "asset-id-from-near.intents.tokens", destination_asset_id: "another-live-asset-id", amount: "1000000", slippage_bps: 100, deposit_type: "ORIGIN_CHAIN", recipient: "destination-address", recipient_type: "DESTINATION_CHAIN", refund_to: "refund-address", refund_type: "ORIGIN_CHAIN", refund_deadline: "2027-01-01T00:00:00.000Z" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        dry: true;
        origin_asset_id: string;
        destination_asset_id: string;
        amount: string;
        slippage_bps: number;
        deposit_type: "ORIGIN_CHAIN";
        recipient: string;
        recipient_type: "DESTINATION_CHAIN";
        refund_to: string;
        refund_type: "ORIGIN_CHAIN";
        refund_deadline: string;
        quote_waiting_time_ms?: number;
      };
      if (Date.parse(args.refund_deadline) <= Date.now()) {
        throw new Error("NEAR Intents refund deadline must be in the future");
      }
      const quote = await clientFor(ctx).quote({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: args.slippage_bps,
        originAsset: args.origin_asset_id,
        depositType: args.deposit_type,
        destinationAsset: args.destination_asset_id,
        amount: args.amount,
        refundTo: args.refund_to,
        refundType: args.refund_type,
        recipient: args.recipient,
        recipientType: args.recipient_type,
        deadline: args.refund_deadline,
        depositMode: "SIMPLE",
        confidentiality: "public",
        quoteWaitingTimeMs: args.quote_waiting_time_ms ?? 0,
        insured: false,
      });
      return {
        provider: "near-intents-1click",
        source: "live",
        mode: "dry",
        signature_verified: true,
        execution_enabled: false,
        quote_hash: quote.quoteHash,
        quote: quote.response,
      };
    },
  },
  {
    name: "near.intents.status",
    family: "near",
    summary: "Read 1Click settlement status using the exact deposit address and required memo.",
    tags: ["near", "intents", "1click", "status", "settlement", "verified"],
    args: z.object({
      deposit_address: VisibleTextSchema,
      deposit_memo: VisibleTextSchema.optional(),
      expected_quote_hash: QuoteHashSchema.optional(),
      expected_correlation_id: CorrelationIdSchema.optional(),
    }).strict(),
    returns: "verified 1Click quote binding and current provider settlement state",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.status({ deposit_address: "address-from-verified-quote", deposit_memo: "memo-when-present" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        deposit_address: string;
        deposit_memo?: string;
        expected_quote_hash?: string;
        expected_correlation_id?: string;
      };
      const status = await clientFor(ctx).status({
        depositAddress: args.deposit_address,
        ...(args.deposit_memo === undefined ? {} : { depositMemo: args.deposit_memo }),
        ...(args.expected_quote_hash === undefined ? {} : { expectedQuoteHash: args.expected_quote_hash }),
        ...(args.expected_correlation_id === undefined ? {} : { expectedCorrelationId: args.expected_correlation_id }),
      });
      return {
        provider: "near-intents-1click",
        source: "live",
        signature_verified: true,
        execution_enabled: false,
        status,
      };
    },
  },
  {
    name: "near.intents.executable-quote.review",
    family: "near",
    summary: "Create one local-only provider-signed Arbitrum USDC to NEAR wNEAR quote for owner manual-funding review.",
    tags: ["near", "intents", "1click", "quote", "executable-review", "local-only", "manual-funding"],
    args: ExecutableQuoteReviewArgsSchema,
    returns: "an exact manual-funding review; Harbor never builds, signs, broadcasts, or funds the transfer",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.executable-quote.review({ route: "arbitrum-usdc-to-near-wnear-v1", amount_atomic: "1000000", slippage_bps: 100, recipient: "owner.near", refund_to: "0x1111111111111111111111111111111111111111", refund_deadline: "2027-01-01T00:00:00.000Z" })',
    handler: async (ctx, rawArgs) => {
      const runtime = requireExecutableReviewRuntime(ctx);
      const args = ExecutableQuoteReviewArgsSchema.parse(rawArgs);
      if (Date.parse(args.refund_deadline) <= Date.now()) {
        throw new OneClickExecutableReviewError(
          "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
          "NEAR Intents refund deadline must be in the future",
        );
      }
      const client = clientFor(ctx, true);
      const tokens = await client.tokens();
      requireExactCatalogToken(tokens, ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin);
      requireExactCatalogToken(tokens, ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.destination);

      const quote = await client.quote({
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: args.slippage_bps,
        originAsset: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.destination.assetId,
        amount: args.amount_atomic,
        refundTo: args.refund_to,
        refundType: "ORIGIN_CHAIN",
        recipient: args.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: args.refund_deadline,
        depositMode: "SIMPLE",
        confidentiality: "public",
        quoteWaitingTimeMs: args.quote_waiting_time_ms ?? 0,
        insured: false,
      });
      const reviewedAtMs = Date.now();
      assertManualFundingQuote(quote, args.amount_atomic, reviewedAtMs);

      const details = quote.response.quote;
      const route = {
        version: "pilot-near-arbitrum-usdc-to-wnear-route-v1",
        origin_chain: "arb",
        origin_chain_id: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.chainId,
        origin_token_contract: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.contractAddress,
        origin_asset_id: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.assetId,
        origin_decimals: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.decimals,
        destination_chain: "near",
        destination_network: "mainnet",
        destination_token_contract: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.destination.contractAddress,
        destination_asset_id: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.destination.assetId,
        destination_decimals: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.destination.decimals,
        funding_mode: "manual-owner-wallet-send",
        manual_owner_funding_only: true,
        pilot_budget_scope: "does-not-control-owner-wallet-send",
      } as const;
      const approvalExpiresAt = new Date(Math.min(
        Date.parse(details.deadline),
        reviewedAtMs + 5 * 60_000,
      )).toISOString();
      const ownerReview = {
        action: "manually-transfer-origin-asset",
        network: "arbitrum-mainnet",
        chain_id: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.chainId,
        token_contract: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.contractAddress,
        token_decimals: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.origin.decimals,
        amount_atomic: args.amount_atomic,
        deposit_address: details.depositAddress,
        deposit_memo: null,
        provider_deadline: details.deadline,
        provider_time_when_inactive: details.timeWhenInactive,
        quote_correlation_id: quote.response.correlationId,
        destination_asset_id: ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.destination.assetId,
        destination_recipient: args.recipient,
        estimated_amount_out: details.amountOut,
        minimum_amount_out: details.minAmountOut,
        app_fee_bps: 0,
        transaction_built: false,
        transaction_signed: false,
        transaction_broadcast: false,
        funding_state: "not-funded",
        warning: "Transfer the exact USDC atomic amount to the quoted Arbitrum deposit address before the provider deadline only after owner review. Harbor has not built, signed, broadcast, or funded a transaction.",
      } as const;
      const statusLookup = {
        operation: "near.intents.status",
        deposit_address: details.depositAddress,
        deposit_memo: null,
        expected_correlation_id: quote.response.correlationId,
      } as const;
      const common = {
        provider: "near-intents-1click",
        mode: "executable-review",
        route,
        execution_enabled: false,
        manual_funding_required: true,
      } as const;
      return runtime.fixture
        ? {
            ...common,
            source: "fixture" as const,
            provider_signature_verified: false as const,
            local_fixture_id: ONE_CLICK_EXECUTABLE_REVIEW_FIXTURE_ID,
            fixture_quote: {
              version: "pilot-near-arbitrum-usdc-to-wnear-quote-fixture-v1" as const,
              route,
              correlation_id: quote.response.correlationId,
              provider_timestamp: quote.response.timestamp,
              request_echo: quote.response.quoteRequest,
              amount_in: details.amountIn,
              amount_out: details.amountOut,
              min_amount_out: details.minAmountOut,
              recipient: args.recipient,
              refund_to: args.refund_to,
              deposit_address: details.depositAddress,
              deposit_memo_present: false as const,
              provider_deadline_at: details.deadline,
              provider_time_when_inactive_at: details.timeWhenInactive,
              approval_expires_at: approvalExpiresAt,
            },
            owner_review: {
              ...ownerReview,
              status_lookup: {
                ...statusLookup,
                local_fixture_id: ONE_CLICK_EXECUTABLE_REVIEW_FIXTURE_ID,
              },
            },
          }
        : {
            ...common,
            source: "live" as const,
            provider_signature_verified: true as const,
            quote_hash: quote.quoteHash,
            quote_binding: {
              version: "pilot-near-arbitrum-usdc-to-wnear-quote-binding-v1" as const,
              route,
              provider_signature_verified: true as const,
              provider_signature: quote.response.signature,
              quote_hash: quote.quoteHash,
              correlation_id: quote.response.correlationId,
              provider_timestamp: quote.response.timestamp,
              request_echo: quote.response.quoteRequest,
              provider_quote_response: quote.response,
              amount_in: details.amountIn,
              min_amount_out: details.minAmountOut,
              recipient: args.recipient,
              refund_to: args.refund_to,
              deposit_address: details.depositAddress,
              deposit_memo_present: false as const,
              provider_deadline_at: details.deadline,
              provider_time_when_inactive_at: details.timeWhenInactive,
              approval_expires_at: approvalExpiresAt,
            },
            owner_review: {
              ...ownerReview,
              status_lookup: {
                ...statusLookup,
                expected_quote_hash: quote.quoteHash,
              },
            },
          };
    },
  },
];
