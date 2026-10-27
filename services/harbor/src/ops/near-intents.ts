import {
  quoteHash as officialQuoteHash,
  verifyQuoteSignature as verifyOfficialQuoteSignature,
} from "@defuse-protocol/one-click-sdk-typescript";
import { z } from "zod";

import type { OpContext, OpDef } from "../catalog/registry";
import {
  createOneClickClient,
  ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE,
  ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE,
  OneClickClientError,
  type OneClickClient,
  type OneClickToken,
  OneClickQuoteResponseSchema,
} from "../near/one-click";
import {
  D1NearAttemptStore,
  type NearHostedAttempt,
  type NearHostedNativeLifecycle,
  type NearHostedNativeToArbitrumBinding,
  type NearHostedReserveInput,
  type NearHostedNativeTransitionInput,
} from "../near/attempt-store";
import {
  createNearReconciliationRpcPort,
  NearReconciliationRpcError,
  type NearReconciliationRpcPort,
} from "../near/reconciliation-rpc";

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
export const ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE = "near-native-to-arbitrum-usdc-v1";
export const ONE_CLICK_HOSTED_NATIVE_NEAR_FIXTURE_ID = "near-native-to-arbitrum-usdc-review-fixture-v1";

type ExecutableReviewErrorCode =
  | "EXECUTABLE_REVIEW_DISABLED"
  | "EXECUTABLE_REVIEW_LOCAL_ONLY"
  | "EXECUTABLE_REVIEW_AUTH_REQUIRED"
  | "ROUTE_CATALOG_MISMATCH"
  | "UNSUPPORTED_MANUAL_FUNDING_QUOTE";

type OwnerFundedReserveErrorCode =
  | "OWNER_FUNDED_RESERVE_DISABLED"
  | "OWNER_FUNDED_RESERVE_AUTH_REQUIRED"
  | "OWNER_FUNDED_RESERVE_D1_REQUIRED"
  | "OWNER_FUNDED_RESERVE_INVALID"
  | "OWNER_FUNDED_RESERVE_EXPIRED"
  | "OWNER_FUNDED_RESERVE_BUDGET_EXCEEDED"
  | "OWNER_FUNDED_RESERVE_PROVIDER_VERIFICATION_FAILED"
  | "OWNER_FUNDED_RESERVE_UNAVAILABLE";

type OwnerFundedReconcileErrorCode =
  | "OWNER_FUNDED_RECONCILE_DISABLED"
  | "OWNER_FUNDED_RECONCILE_AUTH_REQUIRED"
  | "OWNER_FUNDED_RECONCILE_INVALID"
  | "OWNER_FUNDED_RECONCILE_UNAVAILABLE";

export class OneClickExecutableReviewError extends Error {
  constructor(readonly code: ExecutableReviewErrorCode, message: string) {
    super(message);
    this.name = "OneClickExecutableReviewError";
  }
}

export class OneClickOwnerFundedReserveError extends Error {
  constructor(readonly code: OwnerFundedReserveErrorCode, message: string) {
    super(message);
    this.name = "OneClickOwnerFundedReserveError";
  }
}

export class OneClickOwnerFundedReconcileError extends Error {
  constructor(readonly code: OwnerFundedReconcileErrorCode, message: string) {
    super(message);
    this.name = "OneClickOwnerFundedReconcileError";
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

function requireHostedNativeNearRuntime(ctx: OpContext): { fixture: boolean } {
  const env = isRecord(ctx.env) ? ctx.env : {};
  const fixture = isOneClickClient(ctx.nearOneClickClient);
  if (
    env.HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED !== "true" ||
    env.HARBOR_NEAR_INTENTS_PROVIDER_POST_ENABLED !== "true" ||
    env.HARBOR_NEAR_INTENTS_STATUS_ENABLED !== "true" ||
    env.HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE !== ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE ||
    env.MAINNET_EXECUTION !== "false" ||
    (!fixture && (typeof env.NEAR_INTENTS_API_KEY !== "string" || env.NEAR_INTENTS_API_KEY.trim() === ""))
  ) {
    throw new OneClickExecutableReviewError(
      "EXECUTABLE_REVIEW_DISABLED",
      "Hosted NEAR Intents executable quote review is disabled",
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
      "Hosted NEAR Intents executable quote review requires an explicitly configured principal",
    );
  }
  return { fixture };
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

function assertNativeNearManualFundingQuote(
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
    throw new OneClickClientError("REQUEST_MISMATCH", "NEAR Intents executable quote changed the exact native NEAR input amount");
  }
  if (!details.depositAddress || !NearAccountSchema.safeParse(details.depositAddress).success) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Native NEAR executable review requires a NEAR deposit account",
    );
  }
  if (details.depositMemo !== undefined) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Memo-bearing deposits are not supported by this SIMPLE native NEAR funding profile",
    );
  }
  if (!details.deadline || !details.timeWhenInactive) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Native NEAR executable review requires both provider funding deadlines",
    );
  }
  const inactiveMs = Date.parse(details.timeWhenInactive);
  const deadlineMs = Date.parse(details.deadline);
  if (inactiveMs <= nowMs || deadlineMs <= nowMs || inactiveMs > deadlineMs) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "Native NEAR executable review requires a live and ordered provider funding window",
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
      only?.blockchain !== ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.origin.blockchain ||
      only.address !== details.depositAddress ||
      only.memo !== undefined
    ) {
      throw new OneClickExecutableReviewError(
        "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
        "Provider chain deposit metadata did not match the exact native NEAR funding route",
      );
    }
  }
}

const ArbitrumUsdcExecutableQuoteReviewArgsSchema = z.object({
  route: z.literal(ONE_CLICK_ARB_USDC_TO_WNEAR_ROUTE.id),
  amount_atomic: AtomicAmountSchema,
  slippage_bps: z.number().int().min(0).max(1_000),
  recipient: NearAccountSchema,
  refund_to: EvmAddressSchema,
  refund_deadline: DateTimeSchema,
  quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
}).strict();

const NativeNearExecutableQuoteReviewArgsSchema = z.object({
  route: z.literal(ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.id),
  amount_atomic: AtomicAmountSchema,
  slippage_bps: z.number().int().min(0).max(1_000),
  recipient: EvmAddressSchema,
  refund_to: NearAccountSchema,
  refund_deadline: DateTimeSchema,
  quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
}).strict();

const ExecutableQuoteReviewArgsSchema = z.discriminatedUnion("route", [
  ArbitrumUsdcExecutableQuoteReviewArgsSchema,
  NativeNearExecutableQuoteReviewArgsSchema,
]);

const SafeIdentifierSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const UpperHexDigestSchema = z.string().regex(/^[A-F0-9]{64}$/);
const NativeNearRouteSchema = z.object({
  version: z.literal("pilot-near-native-to-arbitrum-usdc-route-v1"),
  profile_status: z.literal("hosted-default-off"),
  execution_default: z.literal("off"),
  activation_gate: z.literal("independent-source-and-destination-receipt-verification-required"),
  origin_chain: z.literal("near"),
  origin_network: z.literal("near:mainnet"),
  origin_asset_id: z.literal("nep141:wrap.near"),
  origin_token_contract: z.literal("wrap.near"),
  origin_decimals: z.literal(24),
  source_transfer_asset: z.literal("native-near"),
  managed_wrapping_by_1click: z.literal(true),
  destination_chain: z.literal("arb"),
  destination_chain_id: z.literal(42161),
  destination_asset_id: z.literal("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
  destination_token_contract: z.literal("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  destination_decimals: z.literal(6),
  deposit_mode: z.literal("SIMPLE"),
  funding_mode: z.literal("manual-owner-wallet-send"),
  manual_owner_funding_only: z.literal(true),
  pilot_budget_scope: z.literal("does-not-control-owner-wallet-send"),
}).strict();

const NativeNearExecutableRequestEchoSchema = z.object({
  dry: z.literal(false),
  swapType: z.literal("EXACT_INPUT"),
  slippageTolerance: z.number().int().min(0).max(10_000),
  originAsset: z.literal("nep141:wrap.near"),
  depositType: z.literal("ORIGIN_CHAIN"),
  destinationAsset: z.literal("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
  amount: AtomicAmountSchema,
  refundTo: NearAccountSchema,
  refundType: z.literal("ORIGIN_CHAIN"),
  recipient: EvmAddressSchema,
  recipientType: z.literal("DESTINATION_CHAIN"),
  deadline: DateTimeSchema,
  depositMode: z.literal("SIMPLE"),
  confidentiality: z.literal("public").optional(),
  quoteWaitingTimeMs: z.number().int().min(0).max(30_000).optional(),
  insured: z.literal(false).optional(),
}).strict();

const NativeNearExecutableBindingSchema = z.object({
  version: z.literal("pilot-near-native-to-arbitrum-usdc-quote-binding-v1"),
  route: NativeNearRouteSchema,
  provider_signature_verified: z.literal(true),
  provider_signature: z.string().min(1).max(2_048),
  quote_hash: QuoteHashSchema,
  correlation_id: CorrelationIdSchema,
  provider_timestamp: DateTimeSchema,
  request_echo: NativeNearExecutableRequestEchoSchema,
  provider_quote_response: OneClickQuoteResponseSchema,
  amount_in: AtomicAmountSchema,
  min_amount_out: AtomicAmountSchema,
  recipient: EvmAddressSchema,
  refund_to: NearAccountSchema,
  deposit_address: NearAccountSchema,
  deposit_memo_present: z.literal(false),
  provider_deadline_at: DateTimeSchema,
  provider_time_when_inactive_at: DateTimeSchema,
  approval_expires_at: DateTimeSchema,
}).strict().superRefine((binding, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  const response = binding.provider_quote_response;
  const quote = response.quote;
  if (binding.provider_signature !== response.signature) issue(["provider_signature"], "provider signature changed");
  if (binding.correlation_id !== response.correlationId) issue(["correlation_id"], "provider correlation changed");
  if (binding.provider_timestamp !== response.timestamp) issue(["provider_timestamp"], "provider timestamp changed");
  if (JSON.stringify(binding.request_echo) !== JSON.stringify(response.quoteRequest)) {
    issue(["request_echo"], "provider request echo changed");
  }
  if (binding.amount_in !== binding.request_echo.amount || binding.amount_in !== quote.amountIn) {
    issue(["amount_in"], "input amount changed");
  }
  if (binding.min_amount_out !== quote.minAmountOut) issue(["min_amount_out"], "minimum output changed");
  if (binding.recipient.toLowerCase() !== binding.request_echo.recipient.toLowerCase()) {
    issue(["recipient"], "destination recipient changed");
  }
  if (binding.refund_to !== binding.request_echo.refundTo) issue(["refund_to"], "refund account changed");
  if (binding.deposit_address !== quote.depositAddress || quote.depositMemo !== undefined) {
    issue(["deposit_address"], "deposit route changed or unexpectedly requires a memo");
  }
  if (binding.provider_deadline_at !== binding.request_echo.deadline || binding.provider_deadline_at !== quote.deadline) {
    issue(["provider_deadline_at"], "provider deadline changed");
  }
  if (binding.provider_time_when_inactive_at !== quote.timeWhenInactive) {
    issue(["provider_time_when_inactive_at"], "provider inactivity boundary changed");
  }
  if (Date.parse(binding.provider_time_when_inactive_at) > Date.parse(binding.provider_deadline_at)) {
    issue(["provider_time_when_inactive_at"], "provider inactivity boundary follows refund start");
  }
});

const NativeNearReservationSchema = z.object({
  version: z.literal("pilot-near-native-near-to-arbitrum-usdc-reservation-v1"),
  reservation_id: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  principal_id: SafeIdentifierSchema,
  near_account_id: NearAccountSchema,
  network: z.literal("near:mainnet"),
  idempotency_version: z.literal("pilot-near-idempotency-v1"),
  idempotency_key: SafeIdentifierSchema,
  request_digest: UpperHexDigestSchema,
  asset_id: z.literal("nep141:wrap.near"),
  amount_atomic: AtomicAmountSchema,
  expected_revision: z.literal(0),
  reserved_revision: z.literal(1),
}).strict();

const NativeNearApprovalPayloadSchema = z.object({
  version: z.literal("pilot-near-native-near-to-arbitrum-usdc-approval-payload-v1"),
  route: NativeNearRouteSchema,
  principal_id: SafeIdentifierSchema,
  near_account_id: NearAccountSchema,
  network: z.literal("near:mainnet"),
  policy_digest: UpperHexDigestSchema,
  quote_hash: QuoteHashSchema,
  correlation_id: CorrelationIdSchema,
  origin_asset_id: z.literal("nep141:wrap.near"),
  destination_asset_id: z.literal("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
  amount_in: AtomicAmountSchema,
  min_amount_out: AtomicAmountSchema,
  recipient: EvmAddressSchema,
  refund_to: NearAccountSchema,
  deposit_address: NearAccountSchema,
  deposit_memo_present: z.literal(false),
  provider_deadline_at: DateTimeSchema,
  approved_at: DateTimeSchema,
  approval_expires_at: DateTimeSchema,
  reservation: NativeNearReservationSchema,
}).strict();

const NativeNearEconomicApprovalSchema = z.object({
  version: z.literal("pilot-near-native-near-to-arbitrum-usdc-economic-approval-v1"),
  payload: NativeNearApprovalPayloadSchema,
  approval_digest: UpperHexDigestSchema,
  account_control: z.object({
    version: z.literal("pilot-near-account-control-proof-v1"),
    proof_kind: z.literal("nep413"),
    scope: z.literal("source-account-control-only"),
    grants_economic_transfer_approval: z.literal(false),
    authorization_id: SafeIdentifierSchema,
    principal_id: SafeIdentifierSchema,
    near_account_id: NearAccountSchema,
    network: z.literal("near:mainnet"),
    verified_at: DateTimeSchema,
  }).strict(),
  economic_approval: z.object({
    approval_id: SafeIdentifierSchema,
    method: z.literal("owner-reviewed-native-near-transfer"),
    owner_confirmed: z.literal(true),
    approved_payload_digest: UpperHexDigestSchema,
    confirmed_at: DateTimeSchema,
  }).strict(),
}).strict().superRefine((approval, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  const payload = approval.payload;
  const reservation = payload.reservation;
  if (approval.economic_approval.approved_payload_digest !== approval.approval_digest) {
    issue(["economic_approval", "approved_payload_digest"], "owner confirmation does not bind the approval digest");
  }
  if (approval.economic_approval.confirmed_at !== payload.approved_at) {
    issue(["economic_approval", "confirmed_at"], "owner confirmation time changed");
  }
  if (approval.account_control.principal_id !== payload.principal_id ||
      approval.account_control.near_account_id !== payload.near_account_id ||
      approval.account_control.network !== payload.network) {
    issue(["account_control"], "account-control proof does not match the approved owner scope");
  }
  if (reservation.principal_id !== payload.principal_id || reservation.near_account_id !== payload.near_account_id ||
      reservation.network !== payload.network || reservation.asset_id !== payload.origin_asset_id ||
      reservation.amount_atomic !== payload.amount_in) {
    issue(["payload", "reservation"], "reservation scope does not match the economic approval");
  }
});

const NativeNearOwnerFundedReserveRequestSchema = z.object({
  version: z.literal("pilot-near-native-to-arbitrum-usdc-reserve-request-v1"),
  quote_binding: NativeNearExecutableBindingSchema,
  approval: NativeNearEconomicApprovalSchema,
  idempotency_version: z.literal("pilot-near-idempotency-v1"),
  idempotency_key: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  reservation_id: SafeIdentifierSchema,
}).strict().superRefine((request, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  const quote = request.quote_binding;
  const payload = request.approval.payload;
  const reservation = payload.reservation;
  if (JSON.stringify(quote.route) !== JSON.stringify(payload.route) || payload.quote_hash !== quote.quote_hash ||
      payload.correlation_id !== quote.correlation_id || payload.origin_asset_id !== quote.route.origin_asset_id ||
      payload.destination_asset_id !== quote.route.destination_asset_id || payload.amount_in !== quote.amount_in ||
      payload.min_amount_out !== quote.min_amount_out || payload.recipient.toLowerCase() !== quote.recipient.toLowerCase() ||
      payload.refund_to !== quote.refund_to || payload.near_account_id !== quote.refund_to ||
      payload.deposit_address !== quote.deposit_address || payload.deposit_memo_present !== quote.deposit_memo_present ||
      payload.provider_deadline_at !== quote.provider_deadline_at || payload.approval_expires_at !== quote.approval_expires_at) {
    issue(["approval", "payload"], "economic approval does not exactly bind the executable quote and owner account");
  }
  if (request.idempotency_version !== reservation.idempotency_version ||
      request.idempotency_key !== reservation.idempotency_key || request.attempt_id !== reservation.attempt_id ||
      request.reservation_id !== reservation.reservation_id) {
    issue(["reservation_id"], "request identifiers do not match the approved reservation");
  }
});

type NativeNearOwnerFundedReserveRequest = z.infer<typeof NativeNearOwnerFundedReserveRequestSchema>;
const NativeNearOwnerFundedReconcileBaseSchema = z.object({
  ...NativeNearOwnerFundedReserveRequestSchema.shape,
  version: z.literal("pilot-near-native-to-arbitrum-usdc-reconcile-request-v1"),
  account_id: NearAccountSchema,
  transition_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  expected_entry_revision: z.number().int().positive(),
});
const NativeNearOwnerFundedReconcileRequestSchema = z.discriminatedUnion("stage", [
  NativeNearOwnerFundedReconcileBaseSchema.extend({
    stage: z.literal("source-funding"),
    near_transaction_hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,45}$/),
  }).strict(),
  NativeNearOwnerFundedReconcileBaseSchema.extend({
    stage: z.literal("settlement"),
  }).strict(),
]).superRefine((request, context) => {
  const { stage: _stage, account_id: _account, transition_id: _transition,
    expected_entry_revision: _revision, ...rest } = request;
  const { near_transaction_hash: _hash, ...reserveFields } = rest as typeof rest & {
    near_transaction_hash?: string;
  };
  const reserve = NativeNearOwnerFundedReserveRequestSchema.safeParse({
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
type NativeNearOwnerFundedReconcileRequest = z.infer<typeof NativeNearOwnerFundedReconcileRequestSchema>;
type NativeNearReservationResult = Readonly<{
  replay: boolean;
  attempt: NearHostedAttempt;
  lifecycle: NearHostedNativeLifecycle;
}>;
type NativeNearReservationPort = Readonly<{
  reserveNativeNearToArbitrum(
    input: NearHostedReserveInput,
    binding: NearHostedNativeToArbitrumBinding,
  ): Promise<NativeNearReservationResult>;
}>;
type NativeNearReconciliationPort = Readonly<{
  recordNativeNearToArbitrumEvidence(
    idempotencyKey: string,
    input: NearHostedNativeTransitionInput,
  ): Promise<NativeNearReservationResult>;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new OneClickOwnerFundedReserveError("OWNER_FUNDED_RESERVE_INVALID", "Approval contains an unsupported value");
}

async function upperSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function approvalDigest(payload: z.infer<typeof NativeNearApprovalPayloadSchema>): Promise<string> {
  return upperSha256(
    `pilot.near-intents.native-near-to-arbitrum-usdc.approval.v1\0${canonicalJson(payload)}`,
  );
}

function isD1Binding(value: unknown): value is D1Database {
  return isRecord(value) && typeof value.prepare === "function" && typeof value.batch === "function";
}

function isNativeNearReservationPort(value: unknown): value is NativeNearReservationPort {
  return isRecord(value) && typeof value.reserveNativeNearToArbitrum === "function";
}

function isNativeNearReconciliationPort(value: unknown): value is NativeNearReconciliationPort {
  return isRecord(value) && typeof value.recordNativeNearToArbitrumEvidence === "function";
}

function nativeNearReservationPort(ctx: OpContext, tenantId: string): NativeNearReservationPort {
  if (!isD1Binding(ctx.db)) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_D1_REQUIRED",
      "Owner-funded NEAR admission requires the durable D1 binding",
    );
  }
  if (isNativeNearReservationPort(ctx.nearNativeAttemptStore)) return ctx.nearNativeAttemptStore;
  return new D1NearAttemptStore(ctx.db, tenantId, ctx.principal);
}

function nativeNearReconciliationPort(ctx: OpContext, tenantId: string): NativeNearReconciliationPort {
  if (!isD1Binding(ctx.db)) {
    throw new OneClickOwnerFundedReconcileError(
      "OWNER_FUNDED_RECONCILE_UNAVAILABLE",
      "Owner-funded NEAR reconciliation requires the durable D1 binding",
    );
  }
  if (isNativeNearReconciliationPort(ctx.nearNativeAttemptStore)) return ctx.nearNativeAttemptStore;
  return new D1NearAttemptStore(ctx.db, tenantId, ctx.principal);
}

function nativeBinding(
  request: NativeNearOwnerFundedReserveRequest | NativeNearOwnerFundedReconcileRequest,
): NearHostedNativeToArbitrumBinding {
  const quote = request.quote_binding;
  return {
    version: "pilot-near-native-to-arbitrum-usdc-hosted-binding-v1",
    accountId: request.approval.payload.near_account_id,
    approvalDigest: request.approval.approval_digest,
    quoteId: quote.correlation_id,
    quoteHash: quote.quote_hash,
    correlationId: quote.correlation_id,
    originAssetId: quote.route.origin_asset_id,
    originTokenContract: quote.route.origin_token_contract,
    amountIn: quote.amount_in,
    refundTo: quote.refund_to,
    depositAddress: quote.deposit_address,
    destinationAssetId: quote.route.destination_asset_id,
    destinationTokenContract: quote.route.destination_token_contract,
    destinationRecipient: quote.recipient,
    minAmountOut: quote.min_amount_out,
  };
}

function requireOwnerFundedReconcileRuntime(ctx: OpContext): {
  tenantId: string;
  rpc: NearReconciliationRpcPort;
} {
  const env = isRecord(ctx.env) ? ctx.env : {};
  const gatewayPrincipal = env.HARBOR_NEAR_INTENTS_APPROVAL_GATEWAY_PRINCIPAL;
  const tenant = SafeIdentifierSchema.safeParse(env.HARBOR_NEAR_INTENTS_TENANT_ID);
  if (env.HARBOR_NEAR_INTENTS_OWNER_FUNDED_RECONCILE_ENABLED !== "true" ||
      env.HARBOR_NEAR_INTENTS_OWNER_FUNDED_RESERVE_ENABLED !== "true" ||
      env.HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED !== "true" ||
      env.HARBOR_NEAR_INTENTS_STATUS_ENABLED !== "true" ||
      env.HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE !== ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE ||
      env.MAINNET_EXECUTION !== "false" || !tenant.success ||
      typeof env.NEAR_INTENTS_API_KEY !== "string" || env.NEAR_INTENTS_API_KEY.trim() === "") {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_DISABLED", "Owner-funded NEAR reconciliation is disabled");
  }
  if (gatewayPrincipal !== ctx.principal || !hasConfiguredPrincipal(env.HARBOR_API_KEYS, ctx.principal)) {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_AUTH_REQUIRED", "Owner-funded NEAR reconciliation requires the configured approval gateway");
  }
  if (!isD1Binding(ctx.db)) {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_UNAVAILABLE", "Owner-funded NEAR reconciliation requires durable D1 state");
  }
  const injected = ctx.nearReconciliationRpc;
  if (isRecord(injected) && typeof injected.verifySource === "function" && typeof injected.verifyDestination === "function") {
    return { tenantId: tenant.data, rpc: injected as NearReconciliationRpcPort };
  }
  try {
    return {
      tenantId: tenant.data,
      rpc: createNearReconciliationRpcPort({
        nearRpcUrl: String(env.HARBOR_NEAR_INTENTS_NEAR_RPC_URL ?? ""),
        arbitrumRpcUrl: String(env.HARBOR_NEAR_INTENTS_ARBITRUM_RPC_URL ?? ""),
      }),
    };
  } catch {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_DISABLED", "Pinned reconciliation RPC endpoints are not configured");
  }
}

function transitionInput(
  request: NativeNearOwnerFundedReconcileRequest,
  transitionId: string,
  expectedEntryRevision: number,
  evidence: NearHostedNativeTransitionInput["evidence"],
): NearHostedNativeTransitionInput {
  return {
    accountId: request.account_id,
    transitionId,
    expectedEntryRevision,
    binding: nativeBinding(request),
    evidence,
  };
}

function configuredPositiveAtomic(env: Record<string, unknown>, name: string): string {
  const parsed = AtomicAmountSchema.safeParse(env[name]);
  if (!parsed.success) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_DISABLED",
      `${name} must be a server-configured positive atomic-unit limit`,
    );
  }
  return parsed.data;
}

function requireOwnerFundedReserveRuntime(ctx: OpContext): {
  env: Record<string, unknown>;
  tenantId: string;
  budgetLimitAtomic: string;
} {
  const env = isRecord(ctx.env) ? ctx.env : {};
  const gatewayPrincipal = env.HARBOR_NEAR_INTENTS_APPROVAL_GATEWAY_PRINCIPAL;
  const tenantId = env.HARBOR_NEAR_INTENTS_TENANT_ID;
  if (env.HARBOR_NEAR_INTENTS_OWNER_FUNDED_RESERVE_ENABLED !== "true" ||
      env.HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED !== "true" ||
      env.HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE !== ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE ||
      env.MAINNET_EXECUTION !== "false") {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_DISABLED",
      "Owner-funded NEAR admission is disabled",
    );
  }
  if (typeof gatewayPrincipal !== "string" || gatewayPrincipal !== ctx.principal ||
      !hasConfiguredPrincipal(env.HARBOR_API_KEYS, ctx.principal)) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_AUTH_REQUIRED",
      "Owner-funded NEAR admission requires the specifically configured approval-gateway principal",
    );
  }
  const parsedTenant = SafeIdentifierSchema.safeParse(tenantId);
  if (!parsedTenant.success) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_DISABLED",
      "Owner-funded NEAR admission requires a configured tenant scope",
    );
  }
  return {
    env,
    tenantId: parsedTenant.data,
    budgetLimitAtomic: configuredPositiveAtomic(env, "HARBOR_NEAR_INTENTS_NATIVE_NEAR_BUDGET_LIMIT_ATOMIC"),
  };
}

async function verifyProviderBinding(
  ctx: OpContext,
  request: NativeNearOwnerFundedReserveRequest | NativeNearOwnerFundedReconcileRequest,
): Promise<void> {
  const raw = request.quote_binding.provider_quote_response;
  const injectedVerifier = typeof ctx.nearOneClickAdmissionQuoteVerifier === "function"
    ? ctx.nearOneClickAdmissionQuoteVerifier as (response: unknown) => boolean | Promise<boolean>
    : (response: unknown) => verifyOfficialQuoteSignature(
      response as Parameters<typeof verifyOfficialQuoteSignature>[0],
    );
  const injectedHasher = typeof ctx.nearOneClickAdmissionQuoteHasher === "function"
    ? ctx.nearOneClickAdmissionQuoteHasher as (response: unknown) => string
    : (response: unknown) => officialQuoteHash(response as Parameters<typeof officialQuoteHash>[0]);
  let verified = false;
  let hash = "";
  try {
    verified = await injectedVerifier(raw);
    hash = injectedHasher(raw);
  } catch {
    verified = false;
  }
  if (!verified || hash !== request.quote_binding.quote_hash) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_PROVIDER_VERIFICATION_FAILED",
      "Executable quote signature or provider quote hash could not be verified",
    );
  }
}

function validateActiveOwnerApproval(request: NativeNearOwnerFundedReserveRequest, principal: string, nowMs: number): void {
  const approval = request.approval;
  const payload = approval.payload;
  const approvedAt = Date.parse(payload.approved_at);
  const expiresAt = Date.parse(payload.approval_expires_at);
  const inactiveAt = Date.parse(request.quote_binding.provider_time_when_inactive_at);
  const deadlineAt = Date.parse(payload.provider_deadline_at);
  const providerTimestamp = Date.parse(request.quote_binding.provider_timestamp);
  const controlVerifiedAt = Date.parse(approval.account_control.verified_at);
  if (payload.principal_id !== principal || payload.reservation.principal_id !== principal ||
      approval.account_control.principal_id !== principal) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_AUTH_REQUIRED",
      "Approval principal does not match the authenticated approval gateway",
    );
  }
  if (approval.economic_approval.confirmed_at !== payload.approved_at ||
      approval.economic_approval.approved_payload_digest !== approval.approval_digest) {
    throw new OneClickOwnerFundedReserveError("OWNER_FUNDED_RESERVE_INVALID", "Economic owner approval is not exact");
  }
  if (nowMs < approvedAt || nowMs >= expiresAt || nowMs >= inactiveAt || nowMs >= deadlineAt ||
      expiresAt <= approvedAt || expiresAt - approvedAt > 5 * 60_000 || expiresAt > inactiveAt ||
      providerTimestamp > approvedAt || approvedAt - providerTimestamp > 5 * 60_000 ||
      controlVerifiedAt > approvedAt || approvedAt - controlVerifiedAt > 5 * 60_000) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_EXPIRED",
      "Owner approval, account proof, or provider funding window is not short and active",
    );
  }
}

async function handleOwnerFundedReserve(ctx: OpContext, rawArgs: unknown) {
  const runtime = requireOwnerFundedReserveRuntime(ctx);
  const parsed = NativeNearOwnerFundedReserveRequestSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_INVALID",
      "Owner-funded reservation request did not match the exact live quote and approval contract",
    );
  }
  const request = parsed.data;
  const nowMs = Date.now();
  validateActiveOwnerApproval(request, ctx.principal, nowMs);
  const computedApprovalDigest = await approvalDigest(request.approval.payload);
  if (computedApprovalDigest !== request.approval.approval_digest) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_INVALID",
      "Economic owner approval digest did not verify",
    );
  }
  await verifyProviderBinding(ctx, request);

  const quote = request.quote_binding;
  const payload = request.approval.payload;
  if (BigInt(payload.amount_in) > BigInt(runtime.budgetLimitAtomic)) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_BUDGET_EXCEEDED",
      "Approved native NEAR amount exceeds the server-configured budget limit",
    );
  }
  const storeInput: NearHostedReserveInput = {
    accountId: payload.near_account_id,
    authorizationId: request.approval.account_control.authorization_id,
    authorizationExpiresAt: payload.approval_expires_at,
    idempotencyVersion: request.idempotency_version,
    idempotencyKey: request.idempotency_key,
    requestDigest: payload.reservation.request_digest,
    requestFingerprint: payload.reservation.request_digest,
    attemptId: request.attempt_id,
    reservationId: request.reservation_id,
    approvalDigest: request.approval.approval_digest,
    policyDigest: payload.policy_digest,
    quoteId: quote.correlation_id,
    quoteHash: quote.quote_hash,
    depositAddress: quote.deposit_address,
    assetId: quote.route.origin_asset_id,
    amountAtomic: quote.amount_in,
    budgetLimitAtomic: runtime.budgetLimitAtomic,
    artifactKind: "provider_verified_executable_quote",
    providerSignatureVerified: true,
    approvalExpiresAt: payload.approval_expires_at,
    providerDeadlineAt: quote.provider_deadline_at,
    createdAt: payload.approved_at,
  };
  const storeBinding: NearHostedNativeToArbitrumBinding = {
    version: "pilot-near-native-to-arbitrum-usdc-hosted-binding-v1",
    accountId: payload.near_account_id,
    approvalDigest: request.approval.approval_digest,
    quoteId: quote.correlation_id,
    quoteHash: quote.quote_hash,
    correlationId: quote.correlation_id,
    originAssetId: quote.route.origin_asset_id,
    originTokenContract: quote.route.origin_token_contract,
    amountIn: quote.amount_in,
    refundTo: quote.refund_to,
    depositAddress: quote.deposit_address,
    destinationAssetId: quote.route.destination_asset_id,
    destinationTokenContract: quote.route.destination_token_contract,
    destinationRecipient: quote.recipient,
    minAmountOut: quote.min_amount_out,
  };
  const reserved = await nativeNearReservationPort(ctx, runtime.tenantId)
    .reserveNativeNearToArbitrum(storeInput, storeBinding);
  const attempt = reserved.attempt;
  const lifecycle = reserved.lifecycle;
  if (attempt.tenantId !== runtime.tenantId || attempt.principalId !== ctx.principal ||
      attempt.accountId !== payload.near_account_id || attempt.idempotencyKey !== request.idempotency_key ||
      attempt.requestDigest !== payload.reservation.request_digest || attempt.attemptId !== request.attempt_id ||
      attempt.reservationId !== request.reservation_id || attempt.assetId !== quote.route.origin_asset_id ||
      attempt.amountAtomic !== quote.amount_in || attempt.budgetLimitAtomic !== runtime.budgetLimitAtomic ||
      attempt.state !== "approved" || attempt.reservationState !== "reserved" ||
      lifecycle.tenantId !== runtime.tenantId || lifecycle.principalId !== ctx.principal ||
      lifecycle.accountId !== payload.near_account_id || lifecycle.idempotencyKey !== request.idempotency_key ||
      lifecycle.attemptId !== request.attempt_id || lifecycle.reservationId !== request.reservation_id ||
      lifecycle.lifecycleState !== "reserved" || lifecycle.entryRevision !== attempt.entryRevision) {
    throw new OneClickOwnerFundedReserveError(
      "OWNER_FUNDED_RESERVE_UNAVAILABLE",
      "Durable reservation did not return the exact immutable owner-funded admission",
    );
  }
  return {
    version: "pilot-near-native-to-arbitrum-usdc-reserve-result-v1" as const,
    source: "live" as const,
    provider_signature_verified: true as const,
    action: reserved.replay ? "replay" as const : "reserved" as const,
    replayed_existing: reserved.replay,
    admission_id: request.approval.economic_approval.approval_id,
    quote_hash: quote.quote_hash,
    correlation_id: quote.correlation_id,
    approval_digest: request.approval.approval_digest,
    request_digest: payload.reservation.request_digest,
    idempotency_version: request.idempotency_version,
    idempotency_key: request.idempotency_key,
    attempt_id: request.attempt_id,
    reservation_id: request.reservation_id,
    attempt_state: "approved" as const,
    reservation_state: "reserved" as const,
    attempt_revision: attempt.entryRevision,
    reservation_revision: attempt.reservationRevision,
    funding_instructions: {
      version: "pilot-near-native-near-to-arbitrum-usdc-funding-instructions-v1" as const,
      route_version: quote.route.version,
      funding_method: "manual-native-near-transfer" as const,
      network: "near:mainnet" as const,
      quote_hash: quote.quote_hash,
      correlation_id: quote.correlation_id,
      source_account_id: payload.near_account_id,
      refund_account_id: quote.refund_to,
      destination_recipient: quote.recipient,
      deposit_account_id: quote.deposit_address,
      deposit_memo_present: false as const,
      amount_yocto_near: quote.amount_in,
      provider_deadline_at: quote.provider_deadline_at,
    },
    execution_enabled: false as const,
    manual_owner_funding_only: true as const,
  };
}

async function handleOwnerFundedReconcile(ctx: OpContext, rawArgs: unknown) {
  const runtime = requireOwnerFundedReconcileRuntime(ctx);
  const parsed = NativeNearOwnerFundedReconcileRequestSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_INVALID", "Reconciliation request did not match the exact approved attempt");
  }
  const request = parsed.data;
  if (request.approval.payload.principal_id !== ctx.principal ||
      request.approval.payload.reservation.principal_id !== ctx.principal) {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_AUTH_REQUIRED", "Reconciliation principal does not match the approved attempt");
  }
  const digest = await approvalDigest(request.approval.payload);
  if (digest !== request.approval.approval_digest) {
    throw new OneClickOwnerFundedReconcileError("OWNER_FUNDED_RECONCILE_INVALID", "Economic approval digest did not verify");
  }
  await verifyProviderBinding(ctx, request);
  const store = nativeNearReconciliationPort(ctx, runtime.tenantId);
  const checkedAt = new Date().toISOString();
  if (request.stage === "source-funding") {
    const evidence = await runtime.rpc.verifySource({
      transactionHash: request.near_transaction_hash,
      sourceAccountId: request.account_id,
      depositAccountId: request.quote_binding.deposit_address,
      amountYoctoNear: request.quote_binding.amount_in,
      verifiedAt: checkedAt,
    });
    const recorded = await store.recordNativeNearToArbitrumEvidence(
      request.idempotency_key,
      transitionInput(request, request.transition_id, request.expected_entry_revision, evidence),
    );
    return {
      version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
      stage: request.stage,
      action: recorded.replay ? "replay" as const : "source-verified" as const,
      attempt_id: request.attempt_id,
      lifecycle_state: recorded.lifecycle.lifecycleState,
      attempt_revision: recorded.attempt.entryRevision,
      lifecycle_revision: recorded.lifecycle.lifecycleRevision,
      source_transaction_hash: evidence.transaction_hash,
      safe_to_resubmit: false as const,
      execution_enabled: false as const,
    };
  }

  let status: Awaited<ReturnType<OneClickClient["status"]>>;
  try {
    status = await clientFor(ctx).status({
      depositAddress: request.quote_binding.deposit_address,
      expectedQuoteHash: request.quote_binding.quote_hash,
      expectedCorrelationId: request.quote_binding.correlation_id,
    });
  } catch (error) {
    const reason = error instanceof OneClickClientError && error.code === "TIMEOUT" ? "timeout" as const
      : error instanceof OneClickClientError && error.code === "UNKNOWN_OUTCOME" ? "not_found" as const
      : error instanceof OneClickClientError && (error.code === "INVALID_RESPONSE" || error.code === "INVALID_SIGNATURE" || error.code === "REQUEST_MISMATCH")
        ? "invalid_response" as const : "transport_error" as const;
    const recorded = await store.recordNativeNearToArbitrumEvidence(
      request.idempotency_key,
      transitionInput(request, `${request.transition_id}:unknown`, request.expected_entry_revision, {
        version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1",
        quote_hash: request.quote_binding.quote_hash,
        correlation_id: request.quote_binding.correlation_id,
        deposit_account_id: request.quote_binding.deposit_address,
        deposit_memo_present: false,
        checked_at: checkedAt,
        safe_to_resubmit: false,
        outcome: "unknown",
        reason,
      }),
    );
    return {
      version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
      stage: request.stage,
      action: recorded.replay ? "replay" as const : "unknown" as const,
      reason,
      attempt_id: request.attempt_id,
      lifecycle_state: recorded.lifecycle.lifecycleState,
      attempt_revision: recorded.attempt.entryRevision,
      lifecycle_revision: recorded.lifecycle.lifecycleRevision,
      safe_to_resubmit: false as const,
      execution_enabled: false as const,
    };
  }

  const providerStatus = status.status;
  if (providerStatus === "REFUNDED") {
    const recorded = await store.recordNativeNearToArbitrumEvidence(
      request.idempotency_key,
      transitionInput(request, `${request.transition_id}:refund`, request.expected_entry_revision, {
        version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1",
        quote_hash: request.quote_binding.quote_hash,
        correlation_id: request.quote_binding.correlation_id,
        deposit_account_id: request.quote_binding.deposit_address,
        deposit_memo_present: false,
        checked_at: checkedAt,
        safe_to_resubmit: false,
        outcome: "unknown",
        reason: "unavailable",
      }),
    );
    return {
      version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
      stage: request.stage,
      action: "unknown" as const,
      reason: "refund-receipt-required" as const,
      provider_status: providerStatus,
      attempt_id: request.attempt_id,
      lifecycle_state: recorded.lifecycle.lifecycleState,
      attempt_revision: recorded.attempt.entryRevision,
      lifecycle_revision: recorded.lifecycle.lifecycleRevision,
      safe_to_resubmit: false as const,
      execution_enabled: false as const,
    };
  }
  const pending = providerStatus === "KNOWN_DEPOSIT_TX" || providerStatus === "PENDING_DEPOSIT" ||
    providerStatus === "INCOMPLETE_DEPOSIT" || providerStatus === "PROCESSING";
  const providerEvidence = {
    version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1" as const,
    quote_hash: request.quote_binding.quote_hash,
    correlation_id: request.quote_binding.correlation_id,
    deposit_account_id: request.quote_binding.deposit_address,
    deposit_memo_present: false as const,
    checked_at: checkedAt,
    safe_to_resubmit: false as const,
    ...(pending ? { outcome: "pending" as const, provider_status: providerStatus }
      : providerStatus === "FAILED" ? { outcome: "failed" as const, provider_status: providerStatus, independent_terminal_evidence: false as const }
      : { outcome: "provider-success-only" as const, provider_status: "SUCCESS" as const, independent_destination_receipt: false as const }),
  };
  const observed = await store.recordNativeNearToArbitrumEvidence(
    request.idempotency_key,
    transitionInput(request, `${request.transition_id}:provider`, request.expected_entry_revision, providerEvidence),
  );
  if (providerStatus !== "SUCCESS") {
    return {
      version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
      stage: request.stage,
      action: observed.replay ? "replay" as const : "provider-observed" as const,
      provider_status: providerStatus,
      attempt_id: request.attempt_id,
      lifecycle_state: observed.lifecycle.lifecycleState,
      attempt_revision: observed.attempt.entryRevision,
      lifecycle_revision: observed.lifecycle.lifecycleRevision,
      safe_to_resubmit: false as const,
      execution_enabled: false as const,
    };
  }
  const hashes = [...new Set(status.swapDetails.destinationChainTxHashes.map((item) => item.hash.toLowerCase()))]
    .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)).slice(0, 4);
  for (const hash of hashes) {
    try {
      const receipt = await runtime.rpc.verifyDestination({
        transactionHash: hash,
        recipient: request.quote_binding.recipient,
        minimumAmount: request.quote_binding.min_amount_out,
        verifiedAt: new Date().toISOString(),
      });
      const settled = await store.recordNativeNearToArbitrumEvidence(
        request.idempotency_key,
        transitionInput(request, `${request.transition_id}:destination`, observed.attempt.entryRevision, {
          version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1",
          quote_hash: request.quote_binding.quote_hash,
          correlation_id: request.quote_binding.correlation_id,
          deposit_account_id: request.quote_binding.deposit_address,
          deposit_memo_present: false,
          checked_at: receipt.verified_at,
          safe_to_resubmit: false,
          outcome: "independently-settled",
          provider_status: "SUCCESS",
          destination_receipt: receipt,
        }),
      );
      return {
        version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
        stage: request.stage,
        action: settled.replay ? "replay" as const : "destination-verified" as const,
        provider_status: "SUCCESS" as const,
        attempt_id: request.attempt_id,
        lifecycle_state: settled.lifecycle.lifecycleState,
        attempt_revision: settled.attempt.entryRevision,
        lifecycle_revision: settled.lifecycle.lifecycleRevision,
        destination_transaction_hash: receipt.transaction_hash,
        safe_to_resubmit: false as const,
        execution_enabled: false as const,
      };
    } catch (error) {
      if (!(error instanceof NearReconciliationRpcError)) throw error;
    }
  }
  return {
    version: "pilot-near-native-to-arbitrum-usdc-reconcile-result-v1" as const,
    stage: request.stage,
    action: "unknown" as const,
    reason: "destination-receipt-unverified" as const,
    provider_status: "SUCCESS" as const,
    attempt_id: request.attempt_id,
    lifecycle_state: observed.lifecycle.lifecycleState,
    attempt_revision: observed.attempt.entryRevision,
    lifecycle_revision: observed.lifecycle.lifecycleRevision,
    safe_to_resubmit: false as const,
    execution_enabled: false as const,
  };
}

async function handleNativeNearExecutableReview(
  ctx: OpContext,
  args: z.infer<typeof NativeNearExecutableQuoteReviewArgsSchema>,
) {
  const runtime = requireHostedNativeNearRuntime(ctx);
  if (Date.parse(args.refund_deadline) <= Date.now()) {
    throw new OneClickExecutableReviewError(
      "UNSUPPORTED_MANUAL_FUNDING_QUOTE",
      "NEAR Intents refund deadline must be in the future",
    );
  }
  const client = clientFor(ctx, true);
  const tokens = await client.tokens();
  requireExactCatalogToken(tokens, ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.origin);
  requireExactCatalogToken(tokens, ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination);

  const quote = await client.quote({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: args.slippage_bps,
    originAsset: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.assetId,
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
  assertNativeNearManualFundingQuote(quote, args.amount_atomic, reviewedAtMs);

  const details = quote.response.quote;
  const route = {
    version: "pilot-near-native-to-arbitrum-usdc-route-v1",
    profile_status: "hosted-default-off",
    execution_default: "off",
    activation_gate: "independent-source-and-destination-receipt-verification-required",
    origin_chain: "near",
    origin_network: "near:mainnet",
    origin_asset_id: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.origin.assetId,
    origin_token_contract: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.origin.contractAddress,
    origin_decimals: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.origin.decimals,
    source_transfer_asset: "native-near",
    managed_wrapping_by_1click: true,
    destination_chain: "arb",
    destination_chain_id: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.chainId,
    destination_token_contract: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.contractAddress,
    destination_asset_id: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.assetId,
    destination_decimals: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.decimals,
    deposit_mode: "SIMPLE",
    funding_mode: "manual-owner-wallet-send",
    manual_owner_funding_only: true,
    pilot_budget_scope: "does-not-control-owner-wallet-send",
  } as const;
  const approvalExpiresAt = new Date(Math.min(
    Date.parse(details.deadline),
    reviewedAtMs + 5 * 60_000,
  )).toISOString();
  const ownerReview = {
    action: "manually-transfer-native-near",
    network: "near-mainnet",
    funding_asset: "native-near",
    amount_atomic: args.amount_atomic,
    amount_unit: "yoctoNEAR",
    deposit_address: details.depositAddress,
    deposit_memo: null,
    managed_wrapping_by_1click: true,
    owner_should_send_native_near: true,
    owner_should_not_pre_wrap: true,
    provider_deadline: details.deadline,
    provider_time_when_inactive: details.timeWhenInactive,
    quote_correlation_id: quote.response.correlationId,
    destination_chain_id: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.chainId,
    destination_token_contract: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.contractAddress,
    destination_token_decimals: ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.destination.decimals,
    destination_recipient: args.recipient,
    estimated_amount_out: details.amountOut,
    minimum_amount_out: details.minAmountOut,
    app_fee_bps: 0,
    transaction_built: false,
    transaction_signed: false,
    transaction_broadcast: false,
    funding_state: "not-funded",
    warning: "Send the exact native NEAR amount from the owner wallet to the quoted NEAR deposit account before the provider deadline only after owner review. The managed 1Click flow handles wrapping. Harbor has not built, signed, broadcast, or funded a transaction.",
  } as const;
  const statusLookup = {
    operation: "near.intents.status",
    profile: ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE,
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
        local_fixture_id: ONE_CLICK_HOSTED_NATIVE_NEAR_FIXTURE_ID,
        fixture_quote: {
          version: "pilot-near-native-to-arbitrum-usdc-quote-fixture-v1" as const,
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
            local_fixture_id: ONE_CLICK_HOSTED_NATIVE_NEAR_FIXTURE_ID,
          },
        },
      }
    : {
        ...common,
        source: "live" as const,
        provider_signature_verified: true as const,
        quote_hash: quote.quoteHash,
        quote_binding: {
          version: "pilot-near-native-to-arbitrum-usdc-quote-binding-v1" as const,
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
}

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
      profile: z.literal(ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE).optional(),
      deposit_address: VisibleTextSchema,
      deposit_memo: VisibleTextSchema.optional(),
      expected_quote_hash: QuoteHashSchema.optional(),
      expected_correlation_id: CorrelationIdSchema.optional(),
    }).strict().superRefine((value, context) => {
      if (value.profile === undefined) return;
      if (value.deposit_memo !== undefined) {
        context.addIssue({ code: "custom", path: ["deposit_memo"], message: "native NEAR SIMPLE funding must not include a memo" });
      }
      if (!NearAccountSchema.safeParse(value.deposit_address).success) {
        context.addIssue({ code: "custom", path: ["deposit_address"], message: "native NEAR status requires a NEAR deposit account" });
      }
      if (value.expected_quote_hash === undefined) {
        context.addIssue({ code: "custom", path: ["expected_quote_hash"], message: "hosted status requires the exact reviewed quote hash" });
      }
      if (value.expected_correlation_id === undefined) {
        context.addIssue({ code: "custom", path: ["expected_correlation_id"], message: "hosted status requires the exact reviewed correlation id" });
      }
    }),
    returns: "verified 1Click quote binding and current provider settlement state",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.status({ deposit_address: "address-from-verified-quote", deposit_memo: "memo-when-present" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as {
        profile?: typeof ONE_CLICK_HOSTED_NATIVE_NEAR_PROFILE;
        deposit_address: string;
        deposit_memo?: string;
        expected_quote_hash?: string;
        expected_correlation_id?: string;
      };
      if (args.profile !== undefined) requireHostedNativeNearRuntime(ctx);
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
    summary: "Create an explicitly enabled provider-signed quote for one reviewed owner-funded NEAR Intents route.",
    tags: ["near", "intents", "1click", "quote", "executable-review", "manual-funding"],
    args: ExecutableQuoteReviewArgsSchema,
    returns: "an exact manual-funding review; Harbor never builds, signs, broadcasts, or funds the transfer",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.executable-quote.review({ route: "arbitrum-usdc-to-near-wnear-v1", amount_atomic: "1000000", slippage_bps: 100, recipient: "owner.near", refund_to: "0x1111111111111111111111111111111111111111", refund_deadline: "2027-01-01T00:00:00.000Z" })',
    handler: async (ctx, rawArgs) => {
      const args = ExecutableQuoteReviewArgsSchema.parse(rawArgs);
      if (args.route === ONE_CLICK_NATIVE_NEAR_TO_ARB_USDC_ROUTE.id) {
        return handleNativeNearExecutableReview(ctx, args);
      }
      const runtime = requireExecutableReviewRuntime(ctx);
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
  {
    name: "near.intents.owner-funded.reserve",
    family: "near",
    summary: "Durably reserve a reviewed, provider-verified native NEAR owner-funded attempt without executing it.",
    tags: ["near", "intents", "1click", "owner-funded", "approval", "reservation"],
    args: NativeNearOwnerFundedReserveRequestSchema,
    returns: "a durable admission and manual owner-funding instructions; no transaction is built, signed, broadcast, or funded",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.owner-funded.reserve({ version: "pilot-near-native-to-arbitrum-usdc-reserve-request-v1", quote_binding, approval, idempotency_version: "pilot-near-idempotency-v1", idempotency_key, attempt_id, reservation_id })',
    handler: handleOwnerFundedReserve,
  },
  {
    name: "near.intents.owner-funded.reconcile",
    family: "near",
    summary: "Verify and durably reconcile an owner-funded native NEAR attempt without constructing or submitting transactions.",
    tags: ["near", "intents", "1click", "owner-funded", "reconciliation", "receipts"],
    args: NativeNearOwnerFundedReconcileRequestSchema,
    returns: "source/provider/destination evidence state with safe_to_resubmit always false",
    caveats: ["off-ledger"],
    example: 'await harbor.near.intents.owner-funded.reconcile({ version: "pilot-near-native-to-arbitrum-usdc-reconcile-request-v1", stage: "source-funding", quote_binding, approval, idempotency_version: "pilot-near-idempotency-v1", idempotency_key, attempt_id, reservation_id, account_id, transition_id, expected_entry_revision, near_transaction_hash })',
    handler: handleOwnerFundedReconcile,
  },
];
