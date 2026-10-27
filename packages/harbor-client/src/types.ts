import {
  AccountLinkSchema,
  AssetSchema,
  ExecResultSchema,
  ExecutionCapabilitySchema,
  ExecutionContractSchema,
  Ap4mPublicEvidenceSchema,
  Ap4mReceiptSchema,
  MandateConstraintsSchema,
  MandateSchema,
  MerchantSchema,
  NetworkSchema,
  PolicySchema,
  StrategyAuditEventSchema,
  StrategyCreateArgsSchema,
  StrategyKillSwitchSchema,
  StrategyOwnerAuthorizationSchema,
  StrategyPlanPreviewSchema,
  StrategyPlanValidationResultSchema,
  StrategySchema,
  StrategySimulateArgsSchema,
  StrategyValidateArgsSchema,
  TxBuildSchema,
  VenueSchema,
} from "@pilot/contracts";
import type {
  AccountLink,
  Ap4mPublicEvidence,
  Ap4mReceipt,
  Asset,
  Envelope,
  ExecResult,
  Mandate,
  Merchant,
  Network,
  Policy,
  Strategy,
  StrategyAuditEvent,
  StrategyCreateArgs,
  StrategyKillSwitch,
  StrategyOwnerAuthorization,
  StrategyPlanPreview,
  StrategyPlanValidationResult,
  StrategySimulateArgs,
  StrategyValidateArgs,
  TxBuild,
  Venue,
  ExecutionCapability,
} from "@pilot/contracts";
import {
  NEAR_ARBITRUM_USDC_ASSET_ID,
  NEAR_ARBITRUM_USDC_CONTRACT,
  NEAR_WRAPPED_NEAR_ASSET_ID,
  NEAR_WRAPPED_NEAR_CONTRACT,
  Near1ClickAssetIdSchema,
  Near1ClickBlockchainSchema,
  Near1ClickDryQuoteResponseSchema,
  Near1ClickQuoteHashSchema,
  Near1ClickStatusResponseSchema,
  Near1ClickTokenListSchema,
  NearAccountIdSchema,
  NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
  NearArbitrumUsdcToWnearExecutableQuoteRequestSchema,
  NearArbitrumUsdcToWnearRouteSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
  NearNativeNearToArbitrumUsdcExecutableQuoteRequestSchema,
  NearNativeNearToArbitrumUsdcReserveRequestSchema,
  NearNativeNearToArbitrumUsdcReserveResultSchema,
  NearNativeNearToArbitrumUsdcReconcileRequestSchema,
  NearNativeNearToArbitrumUsdcReconcileResultSchema,
  NearNativeNearToArbitrumUsdcRouteSchema,
  type Near1ClickBlockchain,
  type Near1ClickDryQuoteResponse,
  type Near1ClickStatusResponse,
  type Near1ClickToken,
  type NearArbitrumUsdcToWnearExecutableQuoteBinding,
  type NearArbitrumUsdcToWnearExecutableQuoteRequest,
  type NearArbitrumUsdcToWnearRoute,
  type NearNativeNearToArbitrumUsdcExecutableQuoteBinding,
  type NearNativeNearToArbitrumUsdcExecutableQuoteRequest,
  type NearNativeNearToArbitrumUsdcReserveRequest,
  type NearNativeNearToArbitrumUsdcReserveResult,
  type NearNativeNearToArbitrumUsdcReconcileRequest,
  type NearNativeNearToArbitrumUsdcReconcileResult,
  type NearNativeNearToArbitrumUsdcRoute,
} from "@pilot/contracts/near";
import { z } from "zod";
import { isValidClassicAddress } from "xrpl";
import {
  X402IssuedFixtureResultSchema,
  X402IssuedPayArgsSchema,
  type X402IssuedFixtureResult,
  type X402IssuedPayArgs,
} from "./x402-issued.js";

export const OnboardingReadinessResultSchema = z
  .object({
    ready: z.boolean(),
    scope: z
      .object({
        owner: z.string(),
        network: z.literal("testnet"),
      })
      .strict(),
    checks: z
      .object({
        reviewed_runtime: z.boolean(),
        exact_active_link: z.boolean(),
        exact_persisted_policy: z.boolean(),
        usable_encrypted_delegate: z.boolean(),
        validated_trust_set: z.boolean(),
        usable_trust_line: z.boolean(),
      })
      .strict(),
    evidence: z
      .object({
        delegate: z.string().optional(),
        link_ledger_index: z.number().int().positive().optional(),
        trust_set_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
        trust_set_ledger_index: z.number().int().positive().optional(),
        trust_line_ledger_index: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
export type OnboardingReadinessResult = z.infer<typeof OnboardingReadinessResultSchema>;

export type JsonObject = Record<string, unknown>;
export type PaginationMarker = string | number | JsonObject;
export type LedgerIndex = number | "validated" | "closed" | "current";

export interface VenueRouteQuote {
  venue_id: string;
  route: "order-book" | "amm" | "path";
  input_amount: string;
  output_amount: string;
  price: string;
  price_impact_bps?: number;
  fee?: string;
  available: boolean;
  detail?: string;
}

export interface VenueComparisonResult {
  network: Network;
  sell: Asset;
  buy: Asset;
  amount: string;
  side: "sell" | "buy";
  routes: VenueRouteQuote[];
}

export type NearIntentsTokensResult = {
  provider: "near-intents-1click";
  execution_enabled: false;
  count: number;
  tokens: Near1ClickToken[];
} & ({ source: "live"; live: true } | { source: "fixture"; live: false });

export type NearIntentsDryQuoteResult = {
  provider: "near-intents-1click";
  mode: "dry";
  execution_enabled: false;
  quote: Near1ClickDryQuoteResponse;
} & (
  | {
      source: "live";
      signature_verified: true;
      /** Official provider hash: Base58-encoded SHA-256 message hash. */
      quote_hash: string;
    }
  | {
      source: "fixture";
      signature_verified: false;
      /** Local evidence identifier only; never provider authorization. */
      local_fixture_id: string;
    }
);

export type NearIntentsStatusResult = {
  provider: "near-intents-1click";
  execution_enabled: false;
  status: Near1ClickStatusResponse;
} & (
  | { source: "live"; signature_verified: true }
  | { source: "fixture"; signature_verified: false }
);

export const NEAR_EXECUTABLE_REVIEW_ROUTE = "arbitrum-usdc-to-near-wnear-v1" as const;
export const NEAR_EXECUTABLE_REVIEW_FIXTURE_ID =
  "arb-usdc-to-wnear-review-fixture-v1" as const;
export const NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE = "near-native-to-arbitrum-usdc-v1" as const;
export const NEAR_NATIVE_EXECUTABLE_REVIEW_FIXTURE_ID =
  "near-native-to-arbitrum-usdc-review-fixture-v1" as const;

export type NearExecutableReviewOwnerFields = {
  action: "manually-transfer-origin-asset";
  network: "arbitrum-mainnet";
  chain_id: 42161;
  token_contract: typeof NEAR_ARBITRUM_USDC_CONTRACT;
  token_decimals: 6;
  amount_atomic: string;
  deposit_address: string;
  deposit_memo: null;
  provider_deadline: string;
  provider_time_when_inactive: string;
  quote_correlation_id: string;
  destination_asset_id: typeof NEAR_WRAPPED_NEAR_ASSET_ID;
  destination_recipient: string;
  estimated_amount_out: string;
  minimum_amount_out: string;
  app_fee_bps: 0;
  transaction_built: false;
  transaction_signed: false;
  transaction_broadcast: false;
  funding_state: "not-funded";
  warning: string;
};

export type NearExecutableReviewFixtureQuote = {
  version: "pilot-near-arbitrum-usdc-to-wnear-quote-fixture-v1";
  route: NearArbitrumUsdcToWnearRoute;
  correlation_id: string;
  provider_timestamp: string;
  request_echo: NearArbitrumUsdcToWnearExecutableQuoteRequest;
  amount_in: string;
  amount_out: string;
  min_amount_out: string;
  recipient: string;
  refund_to: string;
  deposit_address: string;
  deposit_memo_present: false;
  provider_deadline_at: string;
  provider_time_when_inactive_at: string;
  approval_expires_at: string;
};

type NearArbitrumExecutableReviewResultBase = {
  provider: "near-intents-1click";
  mode: "executable-review";
  route: NearArbitrumUsdcToWnearRoute;
  execution_enabled: false;
  manual_funding_required: true;
};

export type NearArbitrumExecutableQuoteReviewResult = NearArbitrumExecutableReviewResultBase & (
  | {
      source: "live";
      provider_signature_verified: true;
      quote_hash: string;
      quote_binding: NearArbitrumUsdcToWnearExecutableQuoteBinding;
      owner_review: NearExecutableReviewOwnerFields & {
        status_lookup: {
          operation: "near.intents.status";
          deposit_address: string;
          deposit_memo: null;
          expected_correlation_id: string;
          expected_quote_hash: string;
        };
      };
    }
  | {
      source: "fixture";
      provider_signature_verified: false;
      local_fixture_id: typeof NEAR_EXECUTABLE_REVIEW_FIXTURE_ID;
      fixture_quote: NearExecutableReviewFixtureQuote;
      owner_review: NearExecutableReviewOwnerFields & {
        status_lookup: {
          operation: "near.intents.status";
          deposit_address: string;
          deposit_memo: null;
          expected_correlation_id: string;
          local_fixture_id: typeof NEAR_EXECUTABLE_REVIEW_FIXTURE_ID;
        };
      };
    }
);

export type NearNativeExecutableReviewOwnerFields = {
  action: "manually-transfer-native-near";
  network: "near-mainnet";
  funding_asset: "native-near";
  amount_atomic: string;
  amount_unit: "yoctoNEAR";
  deposit_address: string;
  deposit_memo: null;
  managed_wrapping_by_1click: true;
  owner_should_send_native_near: true;
  owner_should_not_pre_wrap: true;
  provider_deadline: string;
  provider_time_when_inactive: string;
  quote_correlation_id: string;
  destination_chain_id: 42161;
  destination_token_contract: typeof NEAR_ARBITRUM_USDC_CONTRACT;
  destination_token_decimals: 6;
  destination_recipient: string;
  estimated_amount_out: string;
  minimum_amount_out: string;
  app_fee_bps: 0;
  transaction_built: false;
  transaction_signed: false;
  transaction_broadcast: false;
  funding_state: "not-funded";
  warning: string;
};

export type NearNativeExecutableReviewFixtureQuote = {
  version: "pilot-near-native-to-arbitrum-usdc-quote-fixture-v1";
  route: NearNativeNearToArbitrumUsdcRoute;
  correlation_id: string;
  provider_timestamp: string;
  request_echo: NearNativeNearToArbitrumUsdcExecutableQuoteRequest;
  amount_in: string;
  amount_out: string;
  min_amount_out: string;
  recipient: string;
  refund_to: string;
  deposit_address: string;
  deposit_memo_present: false;
  provider_deadline_at: string;
  provider_time_when_inactive_at: string;
  approval_expires_at: string;
};

type NearNativeExecutableReviewResultBase = {
  provider: "near-intents-1click";
  mode: "executable-review";
  route: NearNativeNearToArbitrumUsdcRoute;
  execution_enabled: false;
  manual_funding_required: true;
};

export type NearNativeExecutableQuoteReviewResult = NearNativeExecutableReviewResultBase & (
  | {
      source: "live";
      provider_signature_verified: true;
      quote_hash: string;
      quote_binding: NearNativeNearToArbitrumUsdcExecutableQuoteBinding;
      owner_review: NearNativeExecutableReviewOwnerFields & {
        status_lookup: {
          operation: "near.intents.status";
          profile: typeof NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE;
          deposit_address: string;
          deposit_memo: null;
          expected_correlation_id: string;
          expected_quote_hash: string;
        };
      };
    }
  | {
      source: "fixture";
      provider_signature_verified: false;
      local_fixture_id: typeof NEAR_NATIVE_EXECUTABLE_REVIEW_FIXTURE_ID;
      fixture_quote: NearNativeExecutableReviewFixtureQuote;
      owner_review: NearNativeExecutableReviewOwnerFields & {
        status_lookup: {
          operation: "near.intents.status";
          profile: typeof NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE;
          deposit_address: string;
          deposit_memo: null;
          expected_correlation_id: string;
          local_fixture_id: typeof NEAR_NATIVE_EXECUTABLE_REVIEW_FIXTURE_ID;
        };
      };
    }
);

export type NearIntentsExecutableQuoteReviewResult =
  | NearArbitrumExecutableQuoteReviewResult
  | NearNativeExecutableQuoteReviewResult;

export interface AccountInfoResult {
  account_data: JsonObject;
  ledger_current_index?: number;
  ledger_hash?: string;
  ledger_index?: number;
  validated?: boolean;
  queue_data?: JsonObject;
  signer_lists?: JsonObject[];
}

export interface AccountTrustLine extends JsonObject {
  account: string;
  balance: string;
  currency: string;
  limit: string;
  limit_peer?: string;
  authorized?: boolean;
  freeze?: boolean;
}

export interface AccountLinesResult {
  account: string;
  ledger_current_index?: number;
  ledger_hash?: string;
  ledger_index?: number;
  validated?: boolean;
  lines: AccountTrustLine[];
  marker?: PaginationMarker;
}

export interface AccountObjectsResult {
  account: string;
  ledger_current_index?: number;
  ledger_hash?: string;
  ledger_index?: number;
  validated?: boolean;
  account_objects: JsonObject[];
  marker?: PaginationMarker;
}

export interface AccountTransaction {
  hash?: string;
  close_time_iso?: string;
  ledger_index?: number;
  validated: boolean;
  tx?: JsonObject;
  tx_json?: JsonObject;
  meta: JsonObject | string | null;
}

export interface AccountTransactionsResult {
  account: string;
  ledger_index_min: number;
  ledger_index_max: number;
  transactions: AccountTransaction[];
  marker?: PaginationMarker;
}

export type CurrencyAmount =
  | string
  | { currency: string; issuer: string; value: string };
export type LedgerAmount = CurrencyAmount;

export interface BookOffer extends JsonObject {
  taker_gets: LedgerAmount;
  taker_pays: LedgerAmount;
  quality: string;
}

export interface DexBookResult {
  ledger_current_index?: number;
  ledger_hash?: string;
  ledger_index?: number;
  validated?: boolean;
  offers: JsonObject[];
}

export interface DexDepthResult {
  network: Network;
  taker_gets: Asset;
  taker_pays: Asset;
  ledger_current_index?: number;
  ledger_hash?: string;
  ledger_index?: number;
  levels: Array<{
    price: string;
    quality: string;
    taker_gets: string;
    taker_pays: string;
    offer_count: number;
  }>;
  totals: { taker_gets: string; taker_pays: string; offer_count: number };
}

export interface AmmInfoResult {
  network: Network;
  ledger_index: number;
  amm: JsonObject;
}

export type MarketAnalyticsAsset =
  | { kind: "native"; currency: "XRP"; issuer: null }
  | { kind: "issued"; currency: string; issuer: string };

export interface MarketAnalyticsEstimate {
  direction: "sell-base" | "buy-base";
  requested_base: string;
  filled_base: string;
  quote_amount: string;
  average_price: string | null;
  price_impact_bps: string | null;
  benchmark: "book-mid" | null;
  available: boolean;
  limited_by_depth: boolean;
  levels_consumed: number;
}

export interface MarketAnalyticsSnapshotResult {
  network: Network;
  pair: { base: MarketAnalyticsAsset; quote: MarketAnalyticsAsset };
  source: {
    operation: "analytics.marketSnapshot";
    providers: string[];
    request_count: number;
    bounded: true;
  };
  observed_at: string;
  ledger_index?: number;
  ledger_indexes?: { bids: number | null; asks: number | null; amm: number | null };
  freshness: {
    status: "live-observation" | "partial-observation" | "mixed-ledger";
    basis: "validated-ledger";
    age_seconds: null;
    note: string;
  };
  units: { base_size: string; quote_size: string; price: string; spread_bps: string };
  book: {
    bids: Array<{ price: string; base_size: string; quote_size: string; offer_count: number; cumulative_base_size: string }>;
    asks: Array<{ price: string; base_size: string; quote_size: string; offer_count: number; cumulative_base_size: string }>;
    limited: boolean;
    max_levels: number;
    availability: { bids: "available" | "empty" | "error"; asks: "available" | "empty" | "error" };
    invalid_offer_count: number;
  };
  metrics: {
    best_bid: string | null;
    best_ask: string | null;
    mid: string | null;
    spread: string | null;
    spread_bps: string | null;
  };
  executable_liquidity: Array<{
    base_amount: string;
    sell_base: MarketAnalyticsEstimate;
    buy_base: MarketAnalyticsEstimate;
  }>;
  amm?: {
    account: string | null;
    base_reserve: string;
    quote_reserve: string;
    implied_price: string;
    trading_fee_bps: string;
    units: Record<string, string>;
  };
  availability: { amm: "available" | "unavailable" | "error" };
  history: {
    points: Array<{ observed_at: string; ledger_index?: number; price: string }>;
    started_at: string;
    ended_at: string;
    max_samples: 1;
    complete: false;
    reason: string;
  };
  recent_trades: { support: "unsupported"; rows: []; reason: string };
  partial: boolean;
  partial_reasons: string[];
}

export interface VaultInfoResult {
  network: Extract<Network, "devnet" | "lending-devnet">;
  ledger_current_index?: number;
  ledger_hash?: string;
  ledger_index?: number;
  validated?: boolean;
  vault: JsonObject & { shares: JsonObject };
  risks: string[];
}

export type VaultPositionAsset =
  | { currency: "XRP" }
  | { currency: string; issuer: string }
  | { mpt_issuance_id: string };

export interface VaultPosition {
  asset: VaultPositionAsset;
  assets_available?: string;
  assets_total?: string;
  flags: number;
  locked_balance?: string;
  mpt_issuance_id: string;
  share_balance: string;
  share_asset_scale: number;
  share_issuer: string;
  vault_account: string;
  vault_id: string;
  vault_kind?: number;
  vault_owner: string;
  vault_sequence: number;
  withdrawal_policy: number;
}

export interface VaultPositionsResult {
  account: string;
  ledger_hash: string;
  ledger_index: number;
  marker?: string;
  network: Extract<Network, "devnet" | "lending-devnet">;
  positions: VaultPosition[];
  validated: true;
}

export interface TokenLedgerFlags {
  require_auth: boolean;
  global_freeze: boolean;
  clawback: boolean;
  blackholed: boolean;
}

export interface TokenLookupResult {
  network: Network;
  asset: Asset;
  name?: string;
  symbol?: string;
  description?: string;
  price_usd?: string;
  market_cap_usd?: string;
  volume_24h_usd?: string;
  flags: TokenLedgerFlags;
  sources: string[];
}

export interface YieldOption {
  id: string;
  name: string;
  kind: "amm" | "vault" | "protocol";
  venue_id: string;
  network: Network;
  asset: Asset;
  asset2?: Asset;
  apr_percent?: string;
  apy_percent?: string;
  tvl_usd?: string;
  risks: string[];
}

export interface YieldOptionsResult {
  network: Network;
  asset: Asset;
  amount?: string;
  options: YieldOption[];
}

export interface LoanBroker {
  LedgerEntryType: "LoanBroker";
  index: string;
  Flags: number;
  Account: string;
  CoverAvailable?: string;
  CoverRateMinimum?: number;
  CoverRateLiquidation?: number;
  Data?: string;
  DebtMaximum: string;
  DebtTotal?: string;
  LoanSequence: number;
  ManagementFeeRate?: number;
  Owner: string;
  OwnerCount?: number;
  OwnerNode: number | string;
  PreviousTxnID: string;
  PreviousTxnLgrSeq: number;
  Sequence: number;
  VaultNode: number | string;
  VaultID: string;
}

export interface LendingBrokersResult {
  network: "lending-devnet";
  ledger_hash: string;
  ledger_index: number;
  validated: true;
  brokers: LoanBroker[];
  marker?: string;
}

export type MandateConstraints = z.infer<typeof MandateConstraintsSchema>;

export interface MandatePrepareResult {
  mandate_id: string;
  agent_public_jwk: JsonObject;
  claim_public_keys: Array<{ merchant_id: string; public_key: string }>;
  unsigned_batch: JsonObject;
  unsigned_sequential?: JsonObject[];
}

export interface CredentialStatusResult {
  account: string;
  network: "testnet";
  credential_id?: string;
  issuer: string;
  credential_type_hex: string;
  accepted: boolean;
  expired: boolean;
  expiration?: string;
}

export interface CredentialPayerAcceptResult {
  account: string;
  credential_id: string;
  status: "validated" | "pending" | "failed";
  hash?: string;
  engine_result?: string;
}

export interface CredentialIdsResult {
  account: string;
  network: "testnet";
  credential_ids: string[];
}

export interface Ap4mPurchaseResult {
  receipt: Ap4mReceipt;
  data: JsonObject;
  evidence?: Ap4mPublicEvidence;
}

export interface ChannelStatusResult {
  channel_id: string;
  mandate_id: string;
  merchant_id: string;
  network: "testnet";
  amount_drops: string;
  highest_claim_drops: string;
  remaining_drops: string;
  status: "open" | "closing" | "closed";
  settle_delay: number;
}

export interface MastercardService {
  id: string;
  name: string;
  description?: string;
  docs_url?: string;
}

export interface MastercardDocument {
  title: string;
  path: string;
  url?: string;
  summary?: string;
}

export interface MastercardPage {
  title: string;
  path: string;
  summary: string;
  url: string;
}

export interface MastercardServicesResult {
  source: "Mastercard Developers";
  services: MastercardService[];
}

export interface MastercardDocsResult {
  source: "Mastercard Developers";
  service_id: string;
  pages: MastercardDocument[];
}

export interface MastercardPageResult extends MastercardPage {
  source: "Mastercard Developers";
}

export interface MastercardSearchResult {
  source: "Mastercard Developers";
  query: string;
  results: Array<{
    service_id: string;
    title: string;
    summary?: string;
    url?: string;
  }>;
}

export type TxSubmitResult =
  | {
      hash: string;
      ledger_index: number;
      engine_result: string;
      validated: true;
      tx_json?: JsonObject;
      meta?: JsonObject;
    }
  | {
      status: "failed";
      engine_result: string;
      detail: string;
    };

export type TxStatusResult = {
  hash: string;
  network: Extract<Network, "testnet" | "devnet">;
  validated: boolean;
  ledger_index?: number;
  engine_result?: string;
};

export type ApprovalPreflightResult = {
  status: "ready";
  approval_id: string;
  expires_at: string;
  validated_ledger: number;
  remaining_ledgers: number;
  execution_capability: ExecutionCapability;
};

export type ApprovalReconcileResult = {
  status: "expired_nonincluded";
  approval_id: string;
  execution_id: string;
  validated_ledger: number;
  first_inclusion_ledger: number;
  last_ledger_sequence: number;
  next_action: "request_fresh_build";
};

export const X402_COMPARE_PRICE_DROPS = "5000" as const;
export const X402_COMPARE_PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr" as const;

export type X402PayArgs = {
  owner: string;
  network: "testnet";
  resource: "compare";
  max_price_drops: typeof X402_COMPARE_PRICE_DROPS;
  pay_to: typeof X402_COMPARE_PAY_TO;
  idempotency_key: string;
};

export type X402DeliveredResult = {
  status: "delivered";
  payment_id: string;
  idempotency_key: string;
  owner: string;
  network: "testnet";
  resource: "compare";
  invoice_id: string;
  amount_drops: string;
  fee_drops: string;
  payer: string;
  pay_to: string;
  tx_hash: string;
  validated_ledger_index: number;
  merchant: {
    status: 200;
    content_type: "application/json";
    body: JsonObject;
  };
};

export type X402SettlementUnknownResult = {
  status: "settlement_unknown";
  payment_id: string;
  idempotency_key: string;
  owner: string;
  network: "testnet";
  resource: "compare";
  /** Harbor's uppercase SHA-256 over its principal-bound request record. */
  request_fingerprint: string;
  tx_hash: string;
  last_ledger_sequence: number;
  retry_after_seconds: number;
};

export type X402PayResult = X402DeliveredResult | X402SettlementUnknownResult;

export type EmptyArgs = Record<string, never>;

export interface AccountArgs {
  account: string;
  network: Network;
}

export interface PaginatedArgs {
  limit?: number;
  marker?: PaginationMarker;
}

export interface BuilderArgs {
  account: string;
  network: Network;
  intent_id?: string;
  execution_contract?: "xrpl_execution_v1" | "xrpl_execution_v2";
}

type NativeBuilderNetwork = Extract<
  Network,
  "testnet" | "devnet" | "lending-devnet"
>;

type NativeBuilderArgs = {
  network: NativeBuilderNetwork;
  account: string;
  intent_id?: string;
};

type CheckCashAmountArgs =
  | { amount: CurrencyAmount; deliver_min?: never }
  | { amount?: never; deliver_min: CurrencyAmount };

export interface HarborOperationMap {
  "merchants.list": {
    args: EmptyArgs;
    result: Merchant[];
  };
  "merchants.get": {
    args: { id: string };
    result: Merchant;
  };
  "mandate.prepare": {
    args: {
      owner: string;
      network: "testnet";
      constraints: MandateConstraints;
      payees: string[];
      expires_at: string;
    };
    result: MandatePrepareResult;
  };
  "mandate.register": {
    args: {
      mandate_id: string;
      l1: string;
      l2: string;
      setup_tx_hash: string | string[];
    };
    result: Mandate;
  };
  "mandate.status": {
    args: { mandate_id: string };
    result: Mandate;
  };
  "mandate.revoke": {
    args: { mandate_id: string };
    result: Mandate;
  };
  "credential.status": {
    args: { account: string };
    result: CredentialStatusResult;
  };
  "credential.payerAccept": {
    args: EmptyArgs;
    result: CredentialPayerAcceptResult;
  };
  "credential.ids": {
    args: { account: string };
    result: CredentialIdsResult;
  };
  "ap4m.purchase": {
    args: {
      mandate_id: string;
      merchant_id: string;
      sku: string;
      idempotency_key: string;
    };
    result: Ap4mPurchaseResult;
  };
  "channel.status": {
    args: { channel_id: string };
    result: ChannelStatusResult;
  };
  "channel.list": {
    args: { mandate_id: string };
    result: ChannelStatusResult[];
  };
  "mastercard.services": {
    args: EmptyArgs;
    result: MastercardServicesResult;
  };
  "mastercard.docs": {
    args: { service_id: string };
    result: MastercardDocsResult;
  };
  "mastercard.page": {
    args: { path: string };
    result: MastercardPageResult;
  };
  "mastercard.search": {
    args: { query: string };
    result: MastercardSearchResult;
  };
  "venues.list": {
    args: EmptyArgs;
    result: Venue[];
  };
  "venues.get": {
    args: { id: string };
    result: Venue;
  };
  "venues.compare": {
    args: {
      network: Network;
      sell: Asset;
      buy: Asset;
      amount: string;
      side: "sell" | "buy";
    };
    result: VenueComparisonResult;
  };
  "near.intents.tokens": {
    args: {
      blockchain?: Near1ClickBlockchain;
      symbol?: string;
      include_ondo?: boolean;
      limit?: number;
    };
    result: NearIntentsTokensResult;
  };
  "near.intents.quote": {
    args: {
      dry?: true;
      origin_asset_id: string;
      destination_asset_id: string;
      amount: string;
      slippage_bps: number;
      deposit_type: "ORIGIN_CHAIN";
      recipient: string;
      recipient_type: "DESTINATION_CHAIN";
      refund_to: string;
      refund_type: "ORIGIN_CHAIN";
      /** 1Click refund-start deadline, not Pilot approval freshness. */
      refund_deadline: string;
      quote_waiting_time_ms?: number;
    };
    result: NearIntentsDryQuoteResult;
  };
  "near.intents.status": {
    args: {
      deposit_address: string;
      deposit_memo?: string;
      profile?: typeof NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE;
      expected_quote_hash?: string;
      expected_correlation_id?: string;
    };
    result: NearIntentsStatusResult;
  };
  "near.intents.executable-quote.review": {
    args: {
      amount_atomic: string;
      slippage_bps: number;
      refund_deadline: string;
      quote_waiting_time_ms?: number;
    } & (
      | {
          route: typeof NEAR_EXECUTABLE_REVIEW_ROUTE;
          recipient: string;
          refund_to: string;
        }
      | {
          route: typeof NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE;
          recipient: string;
          refund_to: string;
        }
    );
    result: NearIntentsExecutableQuoteReviewResult;
  };
  "near.intents.owner-funded.reserve": {
    args: NearNativeNearToArbitrumUsdcReserveRequest;
    result: NearNativeNearToArbitrumUsdcReserveResult;
  };
  "near.intents.owner-funded.reconcile": {
    args: NearNativeNearToArbitrumUsdcReconcileRequest;
    result: NearNativeNearToArbitrumUsdcReconcileResult;
  };
  "ledger.account.info": {
    args: AccountArgs & { ledger_hash?: string; ledger_index?: LedgerIndex; queue?: boolean; signer_lists?: boolean };
    result: AccountInfoResult;
  };
  "ledger.account.lines": {
    args: AccountArgs & PaginatedArgs & { ignore_default?: boolean; ledger_hash?: string; ledger_index?: LedgerIndex; peer?: string };
    result: AccountLinesResult;
  };
  "ledger.account.objects": {
    args: AccountArgs & PaginatedArgs & { deletion_blockers_only?: boolean; ledger_hash?: string; ledger_index?: LedgerIndex; sponsored?: boolean; type?: string };
    result: AccountObjectsResult;
  };
  "ledger.account.tx": {
    args: AccountArgs &
      PaginatedArgs & {
        ledger_index_min?: number;
        ledger_index_max?: number;
        tx_type?: string;
        mpt_issuance_id?: string;
        binary?: boolean;
        forward?: boolean;
        delegate?: { delegate_filter: "actor" | "authorizer"; counter_party?: string };
      };
    result: AccountTransactionsResult;
  };
  "dex.book": {
    args: {
      network: Network;
      taker_gets: Asset;
      taker_pays: Asset;
      taker?: string;
      limit?: number;
      ledger_index?: "validated";
    };
    result: DexBookResult;
  };
  "dex.depth": {
    args: {
      network: Network;
      taker_gets: Asset;
      taker_pays: Asset;
      limit?: number;
      ledger_index?: "validated";
    };
    result: DexDepthResult;
  };
  "analytics.marketSnapshot": {
    args: {
      network: Network;
      pair: { base: Asset; quote: Asset };
      depth_limit?: number;
      sample_base_amounts?: string[];
    };
    result: MarketAnalyticsSnapshotResult;
  };
  "amm.info": {
    args: { network: Network; asset: Asset; asset2: Asset; account?: string };
    result: AmmInfoResult;
  };
  "vault.info": {
    args:
      | { network: Extract<Network, "devnet" | "lending-devnet">; vault_id: string }
      | { network: Extract<Network, "devnet" | "lending-devnet">; owner: string; seq: number };
    result: VaultInfoResult;
  };
  "vault.positions": {
    args: {
      network: Extract<Network, "devnet" | "lending-devnet">;
      account: string;
      ledger_index?: number;
      limit?: number;
      marker?: string;
    };
    result: VaultPositionsResult;
  };
  "lending.brokers": {
    args: {
      network: "lending-devnet";
      limit?: number;
      marker?: string;
    };
    result: LendingBrokersResult;
  };
  "tokens.lookup": {
    args: { network: Network; asset: Asset };
    result: TokenLookupResult;
  };
  "yield.options": {
    args: { network: Network; asset: Asset; amount?: string };
    result: YieldOptionsResult;
  };
  "onboarding.readiness": {
    args: {
      owner: string;
      network: "testnet";
      expected_policy: Policy;
      trust_set_hash: string;
    };
    result: OnboardingReadinessResult;
  };
  "account.link": {
    args: { owner: string; network: Extract<Network, "testnet" | "devnet">; permissions?: string[] };
    result: AccountLink;
  };
  "account.status": {
    args: { owner: string; network: Extract<Network, "testnet" | "devnet"> };
    result: AccountLink;
  };
  "account.revoke": {
    args: { owner: string; network: Extract<Network, "testnet" | "devnet"> };
    result: AccountLink;
  };
  "policy.get": {
    args: { owner: string; network: Extract<Network, "testnet" | "devnet"> };
    result: Policy;
  };
  "policy.set": {
    args: { owner: string; network: Extract<Network, "testnet" | "devnet">; policy: Policy };
    result: Policy;
  };
  "tx.swap": {
    args: BuilderArgs & {
      sell: Asset;
      buy: Asset;
      amount: CurrencyAmount;
      side: "sell" | "buy";
      max_slippage_bps: number;
      execution_mode?: "immediate_or_cancel" | "fill_or_kill";
    };
    result: TxBuild;
  };
  "tx.offer": {
    args: BuilderArgs & {
      sell: Asset;
      buy: Asset;
      sell_amount: string;
      buy_amount: string;
      expires_at?: string;
    };
    result: TxBuild;
  };
  "tx.offerCancel": {
    args: BuilderArgs & { offer_sequence: number };
    result: TxBuild;
  };
  "tx.payment": {
    args: BuilderArgs & { to: string; asset: Asset; amount: string; memo?: string };
    result: TxBuild;
  };
  "tx.trustSet": {
    args: BuilderArgs & {
      limit_amount: { currency: string; issuer: string; value: string };
      flags?: number;
      quality_in?: number;
      quality_out?: number;
    };
    result: TxBuild;
  };
  "tx.ammDeposit": {
    args: BuilderArgs & {
      asset: Asset;
      asset2: Asset;
      amount?: CurrencyAmount;
      amount2?: CurrencyAmount;
      eprice?: CurrencyAmount;
      lp_token_out?: Exclude<CurrencyAmount, string>;
      trading_fee?: number;
      flags: number;
    };
    result: TxBuild;
  };
  "tx.ammWithdraw": {
    args: BuilderArgs & {
      asset: Asset;
      asset2: Asset;
      amount?: CurrencyAmount;
      amount2?: CurrencyAmount;
      eprice?: CurrencyAmount;
      lp_token_in?: Exclude<CurrencyAmount, string>;
      flags: number;
    };
    result: TxBuild;
  };
  "tx.vaultDeposit": {
    args: BuilderArgs & { vault_id: string; amount: CurrencyAmount };
    result: TxBuild;
  };
  "tx.vaultWithdraw": {
    args: BuilderArgs & {
      vault_id: string;
      amount: CurrencyAmount;
      destination?: string;
      destination_tag?: number;
    };
    result: TxBuild;
  };
  "tx.escrowCreate": {
    args: NativeBuilderArgs & {
      destination: string;
      amount: CurrencyAmount;
      cancel_after?: number;
      finish_after?: number;
      condition?: string;
      destination_tag?: number;
    };
    result: TxBuild;
  };
  "tx.escrowFinish": {
    args: NativeBuilderArgs & {
      owner: string;
      offer_sequence: number;
      condition?: string;
      fulfillment?: string;
    };
    result: TxBuild;
  };
  "tx.escrowCancel": {
    args: NativeBuilderArgs & {
      owner: string;
      offer_sequence: number;
    };
    result: TxBuild;
  };
  "tx.checkCreate": {
    args: NativeBuilderArgs & {
      destination: string;
      send_max: CurrencyAmount;
      destination_tag?: number;
      expiration?: number;
      invoice_id?: string;
    };
    result: TxBuild;
  };
  "tx.checkCash": {
    args: NativeBuilderArgs & {
      check_id: string;
    } & CheckCashAmountArgs;
    result: TxBuild;
  };
  "tx.checkCancel": {
    args: NativeBuilderArgs & {
      check_id: string;
    };
    result: TxBuild;
  };
  "tx.simulate": {
    args: BuilderArgs & { tx_json: JsonObject };
    result: TxBuild;
  };
  "tx.execute": {
    args:
      | {
          build_id: string;
          idempotency_key: string;
          require_owner_approval?: true;
          execution_contract?: "xrpl_execution_v1";
        }
      | {
          build_id: string;
          idempotency_key: string;
          require_owner_approval?: true;
          execution_contract: "xrpl_execution_v2";
          build_revision: number;
        };
    result: ExecResult;
  };
  "tx.approvalPreflight": {
    args: {
      approval_id: string;
      execution_contract: "xrpl_execution_v2";
      build_revision: number;
      unsigned_tx_digest: string;
      economic_fingerprint: string;
    };
    result: ApprovalPreflightResult;
  };
  "tx.approvalReconcile": {
    args: {
      approval_id: string;
      execution_contract: "xrpl_execution_v2";
      build_revision: number;
      unsigned_tx_digest: string;
      economic_fingerprint: string;
    };
    result: ApprovalReconcileResult;
  };
  "tx.submit": {
    args:
      | {
          tx_blob: string;
          network: Extract<Network, "testnet" | "devnet">;
          approval_id?: string;
          execution_contract?: "xrpl_execution_v1";
        }
      | {
          tx_blob: string;
          approval_id: string;
          network?: Extract<Network, "testnet" | "devnet">;
          execution_contract?: "xrpl_execution_v1";
        }
      | {
          tx_blob: string;
          approval_id: string;
          network?: Extract<Network, "testnet" | "devnet">;
          execution_contract: "xrpl_execution_v2";
          build_revision: number;
          unsigned_tx_digest: string;
          economic_fingerprint: string;
        };
    result: TxSubmitResult;
  };
  "tx.status": {
    args:
      | { hash: string }
      | { hash: string; account: string; network: Extract<Network, "testnet" | "devnet"> };
    result: TxStatusResult;
  };
  "strategy.create": {
    args: StrategyCreateArgs & { request_id: string };
    result: Strategy;
  };
  "strategy.validate": {
    args: StrategyValidateArgs;
    result: StrategyPlanValidationResult;
  };
  "strategy.simulate": {
    args: StrategySimulateArgs;
    result: StrategyPlanPreview;
  };
  "strategy.list": {
    args: { owner: string; network: "testnet" };
    result: Strategy[];
  };
  "strategy.get": {
    args: { strategy_id: string; owner: string; network: "testnet" };
    result: Strategy;
  };
  "strategy.audit": {
    args: { strategy_id: string; owner: string; network: "testnet"; limit?: number };
    result: StrategyAuditEvent[];
  };
  "strategy.authorize": {
    args: {
      strategy_id: string; owner: string; network: "testnet";
      mandate_version: number; mandate_digest: string;
      authorization: StrategyOwnerAuthorization; request_id: string;
    };
    result: Strategy;
  };
  "strategy.pause": {
    args: { strategy_id: string; owner: string; network: "testnet"; reason: string; request_id: string };
    result: Strategy;
  };
  "strategy.resume": {
    args: {
      strategy_id: string; owner: string; network: "testnet";
      mandate_version: number; mandate_digest: string;
      authorization: StrategyOwnerAuthorization; request_id: string;
    };
    result: Strategy;
  };
  "strategy.stop": {
    args: { strategy_id: string; owner: string; network: "testnet"; reason: string; request_id: string };
    result: Strategy;
  };
  "strategy.kill": {
    args: { strategy_id: string; owner: string; network: "testnet"; reason: string; request_id: string };
    result: Strategy;
  };
  "strategy.globalKill.get": {
    args: { owner: string; network: "testnet" };
    result: StrategyKillSwitch;
  };
  "strategy.globalKill.set": {
    args: {
      owner: string; network: "testnet"; enabled: true; reason: string; request_id: string;
    } | {
      owner: string; network: "testnet"; enabled: false; reason: string; request_id: string;
      strategy_id: string; mandate_version: number; mandate_digest: string;
      authorization: StrategyOwnerAuthorization;
    };
    result: StrategyKillSwitch;
  };
  "x402.pay": {
    args: X402PayArgs;
    result: X402PayResult;
  };
  "x402.payIssuedFixture": {
    args: X402IssuedPayArgs;
    result: X402IssuedFixtureResult;
  };
}

export type HarborOpName = keyof HarborOperationMap;
export type ArgsFor<K extends HarborOpName> = HarborOperationMap[K]["args"];
export type ResultFor<K extends HarborOpName> = HarborOperationMap[K]["result"];

const NonEmptyStringSchema = z.string().trim().min(1);
const NearVisibleTextSchema = z.string().trim().min(1).max(512)
  .regex(/^[\x21-\x7e]+$/, "must contain only visible ASCII characters");
const NearAtomicAmountSchema = z.string().max(128)
  .regex(/^[1-9]\d*$/, "must be a positive atomic-unit integer string");
const NearCorrelationIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const NearArbitrumAddressSchema = z.string().regex(/^0x[0-9A-Fa-f]{40}$/);
const TransactionHashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const LedgerHashSchema = TransactionHashSchema;
const ExecutionNetworkSchema = z.enum(["testnet", "devnet"]);
const DevVaultNetworkSchema = z.enum(["devnet", "lending-devnet"]);
const MptIssuanceIdSchema = z.string().regex(/^[A-Fa-f0-9]{48}$/);
const HexSchema = z.string().regex(/^(?:[A-Fa-f0-9]{2})*$/);
const UINT64_MAX = "18446744073709551615";
const XrplUint64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,19})$/)
  .refine(
    (value) => value.length < UINT64_MAX.length || value <= UINT64_MAX,
    "must fit XRPL's unsigned 64-bit amount range",
  );
function isCanonicalXrplDecimal(value: string): boolean {
  if (value === "0") return true;
  if (value.length > 98) return false;
  if (!/^(?:0\.\d*[1-9]|[1-9]\d*(?:\.\d*[1-9])?)$/.test(value)) {
    return false;
  }
  const [integer = "", fraction = ""] = value.split(".");
  const digits = `${integer}${fraction}`;
  const firstNonZero = digits.search(/[1-9]/);
  const lastNonZero = Math.max(
    ...Array.from(digits, (digit, index) => (digit === "0" ? -1 : index)),
  );
  const significantDigits = lastNonZero - firstNonZero + 1;
  const magnitude = integer.length - firstNonZero - 1;
  return significantDigits <= 16 && magnitude >= -96 && magnitude <= 80;
}
const CanonicalXrplDecimalSchema = z
  .string()
  .max(98)
  .refine(isCanonicalXrplDecimal, "must be a canonical bounded XRPL decimal");
const AccountSchema = NonEmptyStringSchema.max(64).refine(
  isValidClassicAddress,
  "must be a valid XRPL classic address",
);
const PositiveDecimalStringSchema = z
  .string()
  .regex(/^(?=.*[1-9])\d+(?:\.\d+)?$/, "must be a positive decimal string");
const NonNegativeDecimalStringSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, "must be a non-negative decimal string");
const PositiveDropsSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "XRP amount must be a positive integer drops string");
const IssuedCurrencySchema = z.string().refine(
  (currency) =>
    currency.toUpperCase() !== "XRP" &&
    (/^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(currency) ||
      /^[A-Fa-f0-9]{40}$/.test(currency)),
  "issued currency must be a 3-character code or 40-character hex code",
);
const IssuedAmountSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: AccountSchema,
    value: PositiveDecimalStringSchema,
  })
  .strict();
const IssuedLimitAmountSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: AccountSchema,
    value: NonNegativeDecimalStringSchema,
  })
  .strict();
const CurrencyAmountSchema = z.union([PositiveDropsSchema, IssuedAmountSchema]);
const NativeBuilderNetworkSchema = z.enum([
  "testnet",
  "devnet",
  "lending-devnet",
]);
const NativeIntentIdSchema = z.string().trim().min(1).max(128);
const UInt32Schema = z.number().int().min(0).max(0xffff_ffff);
const PositiveUInt32Schema = z.number().int().min(1).max(0xffff_ffff);
const NonZeroHash256Schema = z
  .string()
  .regex(/^(?!0{64}$)[A-Fa-f0-9]{64}$/);
const HexBlobSchema = z
  .string()
  .max(2048)
  .regex(/^(?:[A-Fa-f0-9]{2})+$/);
const XrplDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/);
const AnalyticsPositiveDecimalSchema = XrplDecimalSchema
  .max(96)
  .refine((value) => /[1-9]/.test(value.split(/[eE]/, 1)[0] ?? ""), "must be greater than zero");

function validNativeIssuedValue(value: string): boolean {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return false;
  const exponentText = match[3] ?? "0";
  if (exponentText.length > 4) return false;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return false;
  const digits = `${match[1]}${match[2] ?? ""}`;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero === -1) return false;
  const significant = digits.slice(firstNonZero).replace(/0+$/, "");
  if (significant.length > 16) return false;
  const magnitude =
    exponent - (match[2]?.length ?? 0) + digits.length - firstNonZero - 1;
  return magnitude >= -96 && magnitude <= 80;
}

const NativeIssuedAmountSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: AccountSchema,
    value: XrplDecimalSchema.refine(validNativeIssuedValue),
  })
  .strict();
const NativeCurrencyAmountSchema = z.union([
  PositiveDropsSchema,
  NativeIssuedAmountSchema,
]);
const PaginationMarkerSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative(),
  z.record(z.string(), z.unknown()),
]);
const LedgerIndexSchema = z.union([
  z.number().int().nonnegative(),
  z.enum(["validated", "closed", "current"]),
]);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const X402_MERCHANT_BODY_MAX_BYTES = 64 * 1024;
export const X402_MERCHANT_JSON_MAX_DEPTH = 16;
export const X402_MERCHANT_JSON_MAX_NODES = 2_000;
export const X402_MERCHANT_JSON_MAX_STRING_BYTES = 16 * 1024;
export const X402_MERCHANT_JSON_MAX_KEY_BYTES = 256;
const MAX_X402_POLICY_INTEGER_DIGITS = 18;
const MAX_X402_FEE_DROPS = 100n;
const X402_COMPARE_PRICE_DROPS_VALUE = 5_000n;
const MAX_X402_TOTAL_DROPS = 5_100n;
const X402_TRANSACTION_HASH_SCHEMA = z.string().regex(/^[A-F0-9]{64}$/);
const X402_PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const X402IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(X402_PRINTABLE_ASCII);
const StrategyRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/);
const StrictStrategySchema = StrategySchema.refine(
  (strategy) => /^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/.test(strategy.mandate.issued_asset.currency),
  { path: ["mandate", "issued_asset", "currency"], message: "invalid XRPL currency code" },
);

const StrategyCreateTransportArgsSchema = z.object({
  request_id: StrategyRequestIdSchema,
}).passthrough().superRefine((value, context) => {
  const { request_id: _requestId, ...draft } = value;
  const parsed = StrategyCreateArgsSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: issue.path });
    }
  } else if (!/^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/.test(parsed.data.issued_asset.currency)) {
    context.addIssue({
      code: "custom",
      path: ["issued_asset", "currency"],
      message: "issued currency must be an XRPL 3-character code or exact 40-hex value",
    });
  }
});

function utf8BytesWithin(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return false;
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

function plainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedJson(value: unknown): boolean {
  if (!plainJsonObject(value)) return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > X402_MERCHANT_JSON_MAX_NODES || current.depth > X402_MERCHANT_JSON_MAX_DEPTH) {
      return false;
    }
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "string") {
      if (!utf8BytesWithin(current.value, X402_MERCHANT_JSON_MAX_STRING_BYTES)) return false;
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (!plainJsonObject(current.value) || Object.getOwnPropertySymbols(current.value).length > 0) {
      return false;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (!utf8BytesWithin(key, X402_MERCHANT_JSON_MAX_KEY_BYTES)) return false;
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" &&
      utf8BytesWithin(serialized, X402_MERCHANT_BODY_MAX_BYTES);
  } catch {
    return false;
  }
}
const PermissionNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, "must be an exact XRPL permission name");
const NEVER_DELEGATED_PERMISSIONS = new Set([
  "Payment",
  "EscrowCreate",
  "CheckCreate",
  "PaymentChannelCreate",
  "PaymentChannelFund",
  "NFTokenCreateOffer",
  "PaymentBurn",
  "PaymentMint",
  "AccountSet",
  "SetRegularKey",
  "SignerListSet",
  "DelegateSet",
  "AccountDelete",
  "Batch",
  "ConfidentialMPTConvert",
  "EnableAmendment",
  "LedgerStateFix",
  "SetFee",
  "SponsorshipTransfer",
  "UNLModify",
]);
const PermissionListSchema = z
  .array(PermissionNameSchema)
  .min(1)
  .max(10)
  .superRefine((permissions, context) => {
    if (new Set(permissions).size !== permissions.length) {
      context.addIssue({ code: "custom", message: "permissions must be unique" });
    }
    if (permissions.some((permission) =>
      NEVER_DELEGATED_PERMISSIONS.has(permission) ||
      ["Vault", "Loan", "LoanBroker"].some((prefix) => permission.startsWith(prefix)))) {
      context.addIssue({ code: "custom", message: "one or more permissions cannot be delegated" });
    }
  });

const NonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const NonnegativeDropsSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const SafePolicySchema = PolicySchema.extend({
  max_per_tx_usd: NonnegativeFiniteNumberSchema,
  daily_cap_usd: NonnegativeFiniteNumberSchema,
  execute_under_usd: NonnegativeFiniteNumberSchema,
  max_slippage_bps: NonnegativeFiniteNumberSchema,
  allowed_tx_types: z.array(NonEmptyStringSchema),
  issuer_allowlist: z.array(NonEmptyStringSchema),
  networks: z.array(NetworkSchema),
  x402_max_per_call_drops: NonnegativeDropsSchema.max(MAX_X402_POLICY_INTEGER_DIGITS),
  x402_daily_cap_drops: NonnegativeDropsSchema.max(MAX_X402_POLICY_INTEGER_DIGITS),
}).strict().superRefine((policy, context) => {
  if (policy.execute_under_usd > policy.max_per_tx_usd) {
    context.addIssue({ code: "custom", path: ["execute_under_usd"], message: "must not exceed max_per_tx_usd" });
  }
  if (policy.max_per_tx_usd > policy.daily_cap_usd) {
    context.addIssue({ code: "custom", path: ["max_per_tx_usd"], message: "must not exceed daily_cap_usd" });
  }
  for (const field of ["allowed_tx_types", "issuer_allowlist", "networks"] as const) {
    if (new Set(policy[field]).size !== policy[field].length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must contain unique values` });
    }
  }
  if (policy.networks.includes("mainnet")) {
    context.addIssue({ code: "custom", path: ["networks"], message: "mainnet execution cannot be enabled" });
  }
  if (BigInt(policy.x402_max_per_call_drops) > BigInt(policy.x402_daily_cap_drops)) {
    context.addIssue({ code: "custom", path: ["x402_max_per_call_drops"], message: "must not exceed x402_daily_cap_drops" });
  }
  if (BigInt(policy.x402_max_per_call_drops) > 100_000n) {
    context.addIssue({ code: "custom", path: ["x402_max_per_call_drops"], message: "must not exceed the approved 100000 drop call cap" });
  }
  if (BigInt(policy.x402_daily_cap_drops) > 1_000_000n) {
    context.addIssue({ code: "custom", path: ["x402_daily_cap_drops"], message: "must not exceed the approved 1000000 drop daily cap" });
  }
});

function sameAsset(left: Asset, right: Asset): boolean {
  return left.currency === right.currency &&
    (!("issuer" in left) || ("issuer" in right && left.issuer === right.issuer));
}

function amountMatchesAsset(amount: CurrencyAmount, asset: Asset): boolean {
  return typeof amount === "string"
    ? asset.currency === "XRP"
    : asset.currency === amount.currency && "issuer" in asset && asset.issuer === amount.issuer;
}

const TRUST_FLAGS_MASK =
  0x0001_0000 | 0x0002_0000 | 0x0004_0000 |
  0x0010_0000 | 0x0020_0000 | 0x0040_0000 | 0x0080_0000;
const TrustFlagsSchema = z.number().int().min(0).max(0xffff_ffff).refine(
  (flags) => (flags & ~TRUST_FLAGS_MASK) === 0 && !(
    (flags & 0x0002_0000 && flags & 0x0004_0000) ||
    (flags & 0x0010_0000 && flags & 0x0020_0000) ||
    (flags & 0x0040_0000 && flags & 0x0080_0000)
  ),
  "TrustSet flags contain an unsupported bit or a set/clear conflict",
);

const builderBaseShape = {
  account: AccountSchema,
  network: NetworkSchema,
  intent_id: NonEmptyStringSchema.optional(),
  execution_contract: ExecutionContractSchema.optional(),
} as const;

const nativeBuilderBaseShape = {
  account: AccountSchema,
  network: NativeBuilderNetworkSchema,
  intent_id: NativeIntentIdSchema.optional(),
} as const;

export type HarborArgsSchemaMap = {
  [K in HarborOpName]: z.ZodType<ArgsFor<K>>;
};

/** Runtime argument validation shared by mock and live transports. */
export const HarborArgsSchemas = {
  "merchants.list": z.object({}).strict(),
  "merchants.get": z.object({ id: NonEmptyStringSchema }).strict(),
  "mandate.prepare": z
    .object({
      owner: AccountSchema,
      network: z.literal("testnet"),
      constraints: MandateConstraintsSchema,
      payees: z.array(NonEmptyStringSchema).min(1),
      expires_at: z.string().datetime({ offset: true }),
    })
    .strict(),
  "mandate.register": z
    .object({
      mandate_id: NonEmptyStringSchema,
      l1: NonEmptyStringSchema,
      l2: NonEmptyStringSchema,
      setup_tx_hash: z.union([
        NonEmptyStringSchema,
        z.array(NonEmptyStringSchema).min(1),
      ]),
    })
    .strict(),
  "mandate.status": z.object({ mandate_id: NonEmptyStringSchema }).strict(),
  "mandate.revoke": z.object({ mandate_id: NonEmptyStringSchema }).strict(),
  "credential.status": z.object({ account: AccountSchema }).strict(),
  "credential.payerAccept": z.object({}).strict(),
  "credential.ids": z.object({ account: AccountSchema }).strict(),
  "ap4m.purchase": z
    .object({
      mandate_id: NonEmptyStringSchema,
      merchant_id: NonEmptyStringSchema,
      sku: NonEmptyStringSchema,
      idempotency_key: NonEmptyStringSchema.max(256),
    })
    .strict(),
  "channel.status": z.object({ channel_id: NonEmptyStringSchema }).strict(),
  "channel.list": z.object({ mandate_id: NonEmptyStringSchema }).strict(),
  "mastercard.services": z.object({}).strict(),
  "mastercard.docs": z.object({ service_id: NonEmptyStringSchema }).strict(),
  "mastercard.page": z.object({ path: NonEmptyStringSchema }).strict(),
  "mastercard.search": z.object({ query: NonEmptyStringSchema }).strict(),
  "venues.list": z.object({}).strict(),
  "venues.get": z.object({ id: NonEmptyStringSchema }).strict(),
  "venues.compare": z
    .object({
      network: NetworkSchema,
      sell: AssetSchema,
      buy: AssetSchema,
      amount: PositiveDecimalStringSchema,
      side: z.enum(["sell", "buy"]),
    })
    .strict(),
  "near.intents.tokens": z
    .object({
      blockchain: Near1ClickBlockchainSchema.optional(),
      symbol: z.string().trim().min(1).max(32).optional(),
      include_ondo: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  "near.intents.quote": z
    .object({
      dry: z.literal(true).default(true),
      origin_asset_id: Near1ClickAssetIdSchema,
      destination_asset_id: Near1ClickAssetIdSchema,
      amount: NearAtomicAmountSchema,
      slippage_bps: z.number().int().min(0).max(10_000),
      deposit_type: z.literal("ORIGIN_CHAIN"),
      recipient: NearVisibleTextSchema,
      recipient_type: z.literal("DESTINATION_CHAIN"),
      refund_to: NearVisibleTextSchema,
      refund_type: z.literal("ORIGIN_CHAIN"),
      refund_deadline: z.string().datetime({ offset: true }),
      quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
    })
    .strict()
    .refine((request) => request.origin_asset_id !== request.destination_asset_id, {
      path: ["destination_asset_id"],
      message: "origin and destination assets must differ",
    }),
  "near.intents.status": z
    .object({
      profile: z.literal(NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE).optional(),
      deposit_address: NearVisibleTextSchema,
      deposit_memo: NearVisibleTextSchema.optional(),
      expected_quote_hash: Near1ClickQuoteHashSchema.optional(),
      expected_correlation_id: NearCorrelationIdSchema.optional(),
    })
    .strict()
    .superRefine((request, context) => {
      if (request.profile !== NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE) return;
      if (request.deposit_memo !== undefined) context.addIssue({ code: "custom", path: ["deposit_memo"], message: "native NEAR status rejects deposit memos" });
      if (request.expected_quote_hash === undefined) context.addIssue({ code: "custom", path: ["expected_quote_hash"], message: "native NEAR status requires the reviewed quote hash" });
      if (request.expected_correlation_id === undefined) context.addIssue({ code: "custom", path: ["expected_correlation_id"], message: "native NEAR status requires the reviewed correlation id" });
      if (!NearAccountIdSchema.safeParse(request.deposit_address).success) context.addIssue({ code: "custom", path: ["deposit_address"], message: "native NEAR status requires a NEAR deposit account" });
    }),
  "near.intents.executable-quote.review": z.discriminatedUnion("route", [
    z.object({
      route: z.literal(NEAR_EXECUTABLE_REVIEW_ROUTE),
      amount_atomic: NearAtomicAmountSchema,
      slippage_bps: z.number().int().min(0).max(1_000),
      recipient: NearAccountIdSchema,
      refund_to: NearArbitrumAddressSchema,
      refund_deadline: z.string().datetime({ offset: true }),
      quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
    }).strict(),
    z.object({
      route: z.literal(NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE),
      amount_atomic: NearAtomicAmountSchema,
      slippage_bps: z.number().int().min(0).max(1_000),
      recipient: NearArbitrumAddressSchema,
      refund_to: NearAccountIdSchema,
      refund_deadline: z.string().datetime({ offset: true }),
      quote_waiting_time_ms: z.number().int().min(0).max(30_000).optional(),
    }).strict(),
  ]),
  "near.intents.owner-funded.reserve": NearNativeNearToArbitrumUsdcReserveRequestSchema,
  "near.intents.owner-funded.reconcile": NearNativeNearToArbitrumUsdcReconcileRequestSchema,
  "ledger.account.info": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ledger_hash: LedgerHashSchema.optional(),
      ledger_index: LedgerIndexSchema.optional(),
      queue: z.boolean().optional(),
      signer_lists: z.boolean().optional(),
    })
    .strict(),
  "ledger.account.lines": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ignore_default: z.boolean().optional(),
      ledger_hash: LedgerHashSchema.optional(),
      ledger_index: LedgerIndexSchema.optional(),
      peer: AccountSchema.optional(),
      limit: z.number().int().min(10).max(400).optional(),
      marker: PaginationMarkerSchema.optional(),
    })
    .strict(),
  "ledger.account.objects": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      deletion_blockers_only: z.boolean().optional(),
      ledger_hash: LedgerHashSchema.optional(),
      ledger_index: LedgerIndexSchema.optional(),
      sponsored: z.boolean().optional(),
      type: NonEmptyStringSchema.optional(),
      limit: z.number().int().min(10).max(400).optional(),
      marker: PaginationMarkerSchema.optional(),
    })
    .strict(),
  "ledger.account.tx": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ledger_index_min: z.number().int().min(-1).optional(),
      ledger_index_max: z.number().int().min(-1).optional(),
      tx_type: NonEmptyStringSchema.max(64).optional(),
      mpt_issuance_id: MptIssuanceIdSchema.optional(),
      binary: z.boolean().optional(),
      forward: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      marker: PaginationMarkerSchema.optional(),
      delegate: z.object({
        delegate_filter: z.enum(["actor", "authorizer"]),
        counter_party: AccountSchema.optional(),
      }).strict().optional(),
    })
    .strict(),
  "dex.book": z
    .object({
      network: NetworkSchema,
      taker_gets: AssetSchema,
      taker_pays: AssetSchema,
      taker: AccountSchema.optional(),
      limit: z.number().int().min(1).max(400).optional(),
      ledger_index: z.literal("validated").optional(),
    })
    .strict(),
  "dex.depth": z.object({
    network: NetworkSchema,
    taker_gets: AssetSchema,
    taker_pays: AssetSchema,
    limit: z.number().int().min(1).max(400).optional(),
    ledger_index: z.literal("validated").optional(),
  }).strict(),
  "analytics.marketSnapshot": z.object({
    network: NetworkSchema,
    pair: z.object({ base: AssetSchema, quote: AssetSchema }).strict().refine(
      ({ base, quote }) =>
        base.currency !== quote.currency ||
        ("issuer" in base ? base.issuer : undefined) !== ("issuer" in quote ? quote.issuer : undefined),
      "base and quote must identify different assets",
    ),
    depth_limit: z.number().int().min(1).max(100).optional(),
    sample_base_amounts: z.array(AnalyticsPositiveDecimalSchema).min(1).max(5).optional(),
  }).strict(),
  "amm.info": z
    .object({
      network: NetworkSchema,
      asset: AssetSchema,
      asset2: AssetSchema,
      account: AccountSchema.optional(),
    })
    .strict(),
  "vault.info": z.union([
    z.object({ network: DevVaultNetworkSchema, vault_id: TransactionHashSchema }).strict(),
    z.object({
      network: DevVaultNetworkSchema,
      owner: AccountSchema,
      seq: z.number().int().nonnegative(),
    }).strict(),
  ]),
  "vault.positions": z
    .object({
      network: DevVaultNetworkSchema,
      account: AccountSchema,
      ledger_index: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      marker: z.string().regex(/^v1\.[a-f0-9]{64}$/).optional(),
    })
    .strict(),
  "lending.brokers": z
    .object({
      network: z.literal("lending-devnet"),
      limit: z.number().int().min(1).max(256).optional(),
      marker: z.string().min(1).max(256).optional(),
    })
    .strict(),
  "tokens.lookup": z
    .object({ network: NetworkSchema, asset: AssetSchema })
    .strict(),
  "yield.options": z
    .object({
      network: NetworkSchema,
      asset: AssetSchema,
      amount: PositiveDecimalStringSchema.optional(),
    })
    .strict(),
  "onboarding.readiness": z
    .object({
      owner: AccountSchema,
      network: z.literal("testnet"),
      expected_policy: SafePolicySchema,
      trust_set_hash: TransactionHashSchema,
    })
    .strict(),
  "account.link": z
    .object({
      owner: AccountSchema,
      network: ExecutionNetworkSchema,
      permissions: PermissionListSchema.optional(),
    })
    .strict(),
  "account.status": z
    .object({ owner: AccountSchema, network: ExecutionNetworkSchema })
    .strict(),
  "account.revoke": z
    .object({ owner: AccountSchema, network: ExecutionNetworkSchema })
    .strict(),
  "policy.get": z
    .object({ owner: AccountSchema, network: ExecutionNetworkSchema })
    .strict(),
  "policy.set": z
    .object({ owner: AccountSchema, network: ExecutionNetworkSchema, policy: SafePolicySchema })
    .strict(),
  "tx.swap": z
    .object({
      ...builderBaseShape,
      sell: AssetSchema,
      buy: AssetSchema,
      amount: CurrencyAmountSchema,
      side: z.enum(["sell", "buy"]),
      max_slippage_bps: z.number().int().min(0).max(9_999),
      execution_mode: z.enum(["immediate_or_cancel", "fill_or_kill"]).optional(),
    })
    .strict()
    .superRefine(({ sell, buy, amount, side }, context) => {
      if (sameAsset(sell, buy)) {
        context.addIssue({ code: "custom", path: ["buy"], message: "sell and buy must identify different assets" });
      }
      if (!amountMatchesAsset(amount, side === "sell" ? sell : buy)) {
        context.addIssue({ code: "custom", path: ["amount"], message: `amount must match the fixed ${side} asset` });
      }
    }),
  "tx.offer": z
    .object({
      ...builderBaseShape,
      sell: AssetSchema,
      buy: AssetSchema,
      sell_amount: PositiveDecimalStringSchema,
      buy_amount: PositiveDecimalStringSchema,
      expires_at: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  "tx.offerCancel": z
    .object({
      ...builderBaseShape,
      offer_sequence: z.number().int().positive(),
    })
    .strict(),
  "tx.payment": z
    .object({
      ...builderBaseShape,
      to: AccountSchema,
      asset: AssetSchema,
      amount: PositiveDecimalStringSchema,
      memo: z.string().max(256).optional(),
    })
    .strict(),
  "tx.trustSet": z
    .object({
      ...builderBaseShape,
      limit_amount: IssuedLimitAmountSchema,
      flags: TrustFlagsSchema.optional(),
      quality_in: z.number().int().min(0).max(0xffff_ffff).optional(),
      quality_out: z.number().int().min(0).max(0xffff_ffff).optional(),
    })
    .strict(),
  "tx.ammDeposit": z
    .object({
      ...builderBaseShape,
      asset: AssetSchema,
      asset2: AssetSchema,
      amount: CurrencyAmountSchema.optional(),
      amount2: CurrencyAmountSchema.optional(),
      eprice: CurrencyAmountSchema.optional(),
      lp_token_out: IssuedAmountSchema.optional(),
      trading_fee: z.number().int().min(0).max(1000).optional(),
      flags: z.union([
        z.literal(65536),
        z.literal(524288),
        z.literal(1048576),
        z.literal(2097152),
        z.literal(4194304),
        z.literal(8388608),
      ]),
    })
    .strict(),
  "tx.ammWithdraw": z
    .object({
      ...builderBaseShape,
      asset: AssetSchema,
      asset2: AssetSchema,
      amount: CurrencyAmountSchema.optional(),
      amount2: CurrencyAmountSchema.optional(),
      eprice: CurrencyAmountSchema.optional(),
      lp_token_in: IssuedAmountSchema.optional(),
      flags: z.union([
        z.literal(65536),
        z.literal(131072),
        z.literal(262144),
        z.literal(524288),
        z.literal(1048576),
        z.literal(2097152),
        z.literal(4194304),
      ]),
    })
    .strict(),
  "tx.vaultDeposit": z
    .object({
      account: AccountSchema,
      network: z.literal("devnet"),
      intent_id: NonEmptyStringSchema.optional(),
      vault_id: z.string().regex(/^[A-Fa-f0-9]{64}$/),
      amount: CurrencyAmountSchema,
    })
    .strict(),
  "tx.vaultWithdraw": z
    .object({
      ...builderBaseShape,
      vault_id: z.string().regex(/^[A-Fa-f0-9]{64}$/),
      amount: CurrencyAmountSchema,
      destination: AccountSchema.optional(),
      destination_tag: z.number().int().min(0).max(0xffff_ffff).optional(),
    })
    .strict()
    .refine(({ destination, destination_tag }) => destination !== undefined || destination_tag === undefined, {
      path: ["destination_tag"],
      message: "destination_tag requires destination",
    }),
  "tx.escrowCreate": z
    .object({
      ...nativeBuilderBaseShape,
      destination: AccountSchema,
      amount: NativeCurrencyAmountSchema,
      cancel_after: UInt32Schema.optional(),
      finish_after: UInt32Schema.optional(),
      condition: HexBlobSchema.optional(),
      destination_tag: UInt32Schema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.finish_after === undefined &&
        (value.condition === undefined || value.cancel_after === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["finish_after"],
          message:
            "escrow requires finish_after, or condition together with cancel_after",
        });
      }
      if (
        value.finish_after !== undefined &&
        value.cancel_after !== undefined &&
        value.cancel_after <= value.finish_after
      ) {
        context.addIssue({
          code: "custom",
          path: ["cancel_after"],
          message: "cancel_after must be later than finish_after",
        });
      }
    }),
  "tx.escrowFinish": z
    .object({
      ...nativeBuilderBaseShape,
      owner: AccountSchema,
      offer_sequence: PositiveUInt32Schema,
      condition: HexBlobSchema.optional(),
      fulfillment: HexBlobSchema.optional(),
    })
    .strict()
    .refine(
      ({ condition, fulfillment }) =>
        (condition === undefined) === (fulfillment === undefined),
      {
        path: ["fulfillment"],
        message: "condition and fulfillment must be provided together",
      },
    ),
  "tx.escrowCancel": z
    .object({
      ...nativeBuilderBaseShape,
      owner: AccountSchema,
      offer_sequence: PositiveUInt32Schema,
    })
    .strict(),
  "tx.checkCreate": z
    .object({
      ...nativeBuilderBaseShape,
      destination: AccountSchema,
      send_max: NativeCurrencyAmountSchema,
      destination_tag: UInt32Schema.optional(),
      expiration: UInt32Schema.optional(),
      invoice_id: TransactionHashSchema.optional(),
    })
    .strict()
    .refine(({ account, destination }) => account !== destination, {
      path: ["destination"],
      message: "check destination must differ from account",
    }),
  "tx.checkCash": z
    .object({
      ...nativeBuilderBaseShape,
      check_id: NonZeroHash256Schema,
      amount: NativeCurrencyAmountSchema.optional(),
      deliver_min: NativeCurrencyAmountSchema.optional(),
    })
    .strict()
    .refine(
      ({ amount, deliver_min }) =>
        (amount === undefined) !== (deliver_min === undefined),
      {
        path: ["amount"],
        message: "exactly one of amount or deliver_min is required",
      },
    ) as z.ZodType<HarborOperationMap["tx.checkCash"]["args"]>,
  "tx.checkCancel": z
    .object({
      ...nativeBuilderBaseShape,
      check_id: NonZeroHash256Schema,
    })
    .strict(),
  "tx.simulate": z
    .object({ ...builderBaseShape, tx_json: JsonObjectSchema })
    .strict(),
  "tx.execute": z.union([
    z.object({
      build_id: NonEmptyStringSchema,
      idempotency_key: NonEmptyStringSchema.max(200),
      require_owner_approval: z.literal(true).optional(),
      execution_contract: z.literal("xrpl_execution_v1").optional(),
    }).strict(),
    z.object({
      build_id: NonEmptyStringSchema,
      idempotency_key: NonEmptyStringSchema.max(200),
      require_owner_approval: z.literal(true).optional(),
      execution_contract: z.literal("xrpl_execution_v2"),
      build_revision: z.number().int().positive().safe(),
    }).strict(),
  ]),
  "tx.approvalPreflight": z.object({
    approval_id: NonEmptyStringSchema.max(256),
    execution_contract: z.literal("xrpl_execution_v2"),
    build_revision: z.number().int().positive().safe(),
    unsigned_tx_digest: z.string().regex(/^[A-F0-9]{64}$/),
    economic_fingerprint: z.string().regex(/^[A-F0-9]{64}$/),
  }).strict(),
  "tx.approvalReconcile": z.object({
    approval_id: NonEmptyStringSchema.max(256),
    execution_contract: z.literal("xrpl_execution_v2"),
    build_revision: z.number().int().positive().safe(),
    unsigned_tx_digest: z.string().regex(/^[A-F0-9]{64}$/),
    economic_fingerprint: z.string().regex(/^[A-F0-9]{64}$/),
  }).strict(),
  "tx.submit": z.union([
    z.object({
      tx_blob: z.string().regex(/^[A-Fa-f0-9]+$/),
      network: ExecutionNetworkSchema,
      approval_id: z.undefined().optional(),
      execution_contract: z.literal("xrpl_execution_v1").optional(),
    }).strict(),
    z.object({
      tx_blob: z.string().regex(/^[A-Fa-f0-9]+$/),
      approval_id: NonEmptyStringSchema,
      network: ExecutionNetworkSchema.optional(),
      execution_contract: z.literal("xrpl_execution_v1").optional(),
    }).strict(),
    z.object({
      tx_blob: z.string().regex(/^[A-Fa-f0-9]+$/),
      approval_id: NonEmptyStringSchema,
      network: ExecutionNetworkSchema.optional(),
      execution_contract: z.literal("xrpl_execution_v2"),
      build_revision: z.number().int().positive().safe(),
      unsigned_tx_digest: z.string().regex(/^[A-F0-9]{64}$/),
      economic_fingerprint: z.string().regex(/^[A-F0-9]{64}$/),
    }).strict(),
  ]),
  "tx.status": z.object({
    hash: TransactionHashSchema,
    account: AccountSchema.optional(),
    network: ExecutionNetworkSchema.optional(),
  }).strict().superRefine(({ account, network }, context) => {
    if ((account === undefined) !== (network === undefined)) {
      context.addIssue({ code: "custom", message: "account and network must be provided together" });
    }
  }),
  "strategy.create": StrategyCreateTransportArgsSchema as unknown as z.ZodType<HarborOperationMap["strategy.create"]["args"]>,
  "strategy.validate": StrategyValidateArgsSchema,
  "strategy.simulate": StrategySimulateArgsSchema,
  "strategy.list": z.object({ owner: AccountSchema, network: z.literal("testnet") }).strict(),
  "strategy.get": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema, network: z.literal("testnet"),
  }).strict(),
  "strategy.audit": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema,
    network: z.literal("testnet"), limit: z.number().int().min(1).max(200).optional(),
  }).strict(),
  "strategy.authorize": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema, network: z.literal("testnet"),
    mandate_version: z.number().int().positive(), mandate_digest: TransactionHashSchema,
    authorization: StrategyOwnerAuthorizationSchema, request_id: StrategyRequestIdSchema,
  }).strict(),
  "strategy.pause": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema, network: z.literal("testnet"),
    reason: NonEmptyStringSchema.max(240), request_id: StrategyRequestIdSchema,
  }).strict(),
  "strategy.resume": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema, network: z.literal("testnet"),
    mandate_version: z.number().int().positive(), mandate_digest: TransactionHashSchema,
    authorization: StrategyOwnerAuthorizationSchema, request_id: StrategyRequestIdSchema,
  }).strict(),
  "strategy.stop": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema, network: z.literal("testnet"),
    reason: NonEmptyStringSchema.max(240), request_id: StrategyRequestIdSchema,
  }).strict(),
  "strategy.kill": z.object({
    strategy_id: NonEmptyStringSchema.max(96), owner: AccountSchema, network: z.literal("testnet"),
    reason: NonEmptyStringSchema.max(240), request_id: StrategyRequestIdSchema,
  }).strict(),
  "strategy.globalKill.get": z.object({ owner: AccountSchema, network: z.literal("testnet") }).strict(),
  "strategy.globalKill.set": z.discriminatedUnion("enabled", [
    z.object({
      owner: AccountSchema, network: z.literal("testnet"), enabled: z.literal(true),
      reason: NonEmptyStringSchema.max(240), request_id: StrategyRequestIdSchema,
    }).strict(),
    z.object({
      owner: AccountSchema, network: z.literal("testnet"), enabled: z.literal(false),
      reason: NonEmptyStringSchema.max(240), request_id: StrategyRequestIdSchema,
      strategy_id: NonEmptyStringSchema.max(96), mandate_version: z.number().int().positive(),
      mandate_digest: TransactionHashSchema, authorization: StrategyOwnerAuthorizationSchema,
    }).strict(),
  ]),
  "x402.pay": z.object({
    owner: AccountSchema,
    network: z.literal("testnet"),
    resource: z.literal("compare"),
    max_price_drops: z.literal(X402_COMPARE_PRICE_DROPS),
    pay_to: z.literal(X402_COMPARE_PAY_TO),
    idempotency_key: X402IdempotencyKeySchema,
  }).strict(),
  "x402.payIssuedFixture": X402IssuedPayArgsSchema,
} satisfies HarborArgsSchemaMap;

const TxSubmitResultSchema = z.union([
  z.object({
    hash: TransactionHashSchema,
    ledger_index: z.number().int().nonnegative(), engine_result: NonEmptyStringSchema,
    validated: z.literal(true),
    tx_json: JsonObjectSchema.optional(),
    meta: JsonObjectSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    engine_result: NonEmptyStringSchema, detail: NonEmptyStringSchema,
  }).strict(),
]);

const TxStatusResultSchema = z.object({
  hash: TransactionHashSchema,
  network: ExecutionNetworkSchema,
  validated: z.boolean(),
  ledger_index: z.number().int().nonnegative().optional(),
  engine_result: NonEmptyStringSchema.optional(),
}).strict().superRefine(({ validated, ledger_index, engine_result }, context) => {
  if (validated && (ledger_index === undefined || engine_result === undefined)) {
    context.addIssue({ code: "custom", message: "validated status requires ledger_index and engine_result" });
  }
});

const X402MerchantBodySchema = JsonObjectSchema.refine(isBoundedJson, {
  message: "merchant body must be bounded JSON data",
});
const X402InvoiceIdSchema = z.string().min(1).refine(
  (value) => utf8BytesWithin(value, 200),
  "invoice_id must not exceed 200 UTF-8 bytes",
);

const X402DeliveredResultSchema = z.object({
  status: z.literal("delivered"),
  payment_id: z.string().min(1).max(200),
  idempotency_key: X402IdempotencyKeySchema,
  owner: AccountSchema,
  network: z.literal("testnet"),
  resource: z.literal("compare"),
  invoice_id: X402InvoiceIdSchema,
  amount_drops: PositiveDropsSchema.max(6, {
    message: "must use a canonical bounded drops integer",
  }),
  fee_drops: PositiveDropsSchema.max(3, {
    message: "must use a canonical bounded drops integer",
  }),
  payer: AccountSchema,
  pay_to: z.literal(X402_COMPARE_PAY_TO),
  tx_hash: X402_TRANSACTION_HASH_SCHEMA,
  validated_ledger_index: z.number().int().safe().positive(),
  merchant: z.object({
    status: z.literal(200),
    content_type: z.literal("application/json"),
    body: X402MerchantBodySchema,
  }).strict(),
}).strict().superRefine((result, context) => {
  const amount = BigInt(result.amount_drops);
  const fee = BigInt(result.fee_drops);
  if (amount !== X402_COMPARE_PRICE_DROPS_VALUE) {
    context.addIssue({ code: "custom", path: ["amount_drops"], message: "must equal the approved 5000 drop price" });
  }
  if (fee > MAX_X402_FEE_DROPS) {
    context.addIssue({ code: "custom", path: ["fee_drops"], message: "must not exceed the approved 100 drop fee cap" });
  }
  if (amount + fee > MAX_X402_TOTAL_DROPS) {
    context.addIssue({ code: "custom", path: ["fee_drops"], message: "amount plus fee exceeds the approved total budget" });
  }
  if (result.payer === result.owner) {
    context.addIssue({ code: "custom", path: ["payer"], message: "payer must be a dedicated account distinct from owner" });
  }
});

const X402SettlementUnknownResultSchema = z.object({
  status: z.literal("settlement_unknown"),
  payment_id: z.string().min(1).max(200),
  idempotency_key: X402IdempotencyKeySchema,
  owner: AccountSchema,
  network: z.literal("testnet"),
  resource: z.literal("compare"),
  request_fingerprint: X402_TRANSACTION_HASH_SCHEMA,
  tx_hash: X402_TRANSACTION_HASH_SCHEMA,
  last_ledger_sequence: z.number().int().safe().positive(),
  retry_after_seconds: z.number().int().safe().positive(),
}).strict();

export const X402PayResultSchema = z.union([
  X402DeliveredResultSchema,
  X402SettlementUnknownResultSchema,
]);

const FullVaultSharesSchema = z.object({
  AssetScale: z.number().int().min(0).max(18).optional(),
  DomainID: TransactionHashSchema.optional(),
  Flags: z.number().int().nonnegative(),
  Issuer: AccountSchema,
  LedgerEntryType: z.literal("MPTokenIssuance"),
  LockedAmount: z.string().regex(/^\d+$/).optional(),
  MaximumAmount: z.string().regex(/^\d+$/).optional(),
  MPTokenMetadata: HexSchema.optional(),
  OutstandingAmount: z.string().regex(/^\d+$/),
  OwnerNode: z.string(),
  PreviousTxnID: TransactionHashSchema,
  PreviousTxnLgrSeq: z.number().int().nonnegative(),
  ReferenceHolding: TransactionHashSchema.optional(),
  Sequence: z.number().int().nonnegative(),
  TransferFee: z.number().int().min(0).max(50_000).optional(),
  index: TransactionHashSchema,
  mpt_issuance_id: MptIssuanceIdSchema.optional(),
}).strict();
const CompactVaultSharesSchema = z.object({
  DomainID: TransactionHashSchema.optional(),
  mpt_issuance_id: MptIssuanceIdSchema,
}).strict();
const VaultSharesSchema = z.union([FullVaultSharesSchema, CompactVaultSharesSchema]);
const VaultAssetSchema = z.union([
  z.object({ currency: z.literal("XRP") }).strict(),
  z.object({ currency: NonEmptyStringSchema, issuer: AccountSchema }).strict(),
  z.object({ mpt_issuance_id: MptIssuanceIdSchema }).strict(),
]);
const VaultPositionAssetSchema = z.union([
  z.object({ currency: z.literal("XRP") }).strict(),
  z.object({ currency: IssuedCurrencySchema, issuer: AccountSchema }).strict(),
  z.object({ mpt_issuance_id: MptIssuanceIdSchema }).strict(),
]);
const VaultDescriptionSchema = z.object({
  Account: AccountSchema,
  Asset: VaultAssetSchema,
  AssetsAvailable: z.string().optional(),
  AssetsMaximum: z.string().optional(),
  AssetsTotal: z.string().optional(),
  Data: HexSchema.optional(),
  Flags: z.number().int().nonnegative(),
  LedgerEntryType: z.literal("Vault"),
  LEVersion: z.number().int().nonnegative().optional(),
  LossUnrealized: z.string().optional(),
  Owner: AccountSchema,
  OwnerNode: z.string(),
  PreviousTxnID: TransactionHashSchema,
  PreviousTxnLgrSeq: z.number().int().nonnegative(),
  RedemptionDate: z.number().int().nonnegative().optional(),
  Scale: z.number().int().min(0).max(18).optional(),
  Sequence: z.number().int().nonnegative(),
  ShareMPTID: MptIssuanceIdSchema,
  SubscriptionDate: z.number().int().nonnegative().optional(),
  VaultKind: z.number().int().min(0).max(1).optional(),
  WithdrawalPolicy: z.number().int().nonnegative(),
  index: TransactionHashSchema,
  shares: VaultSharesSchema,
}).strict().superRefine(({ Account, ShareMPTID, shares }, context) => {
  if (shares.mpt_issuance_id !== undefined && shares.mpt_issuance_id !== ShareMPTID) {
    context.addIssue({ code: "custom", path: ["shares", "mpt_issuance_id"], message: "must match ShareMPTID" });
  }
  if ("Issuer" in shares && shares.Issuer !== Account) {
    context.addIssue({ code: "custom", path: ["shares", "Issuer"], message: "must match vault Account" });
  }
});
const VaultInfoResultSchema = z.object({
  network: DevVaultNetworkSchema,
  ledger_current_index: z.number().int().nonnegative().optional(),
  ledger_hash: TransactionHashSchema.optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  validated: z.boolean().optional(),
  vault: VaultDescriptionSchema,
  risks: z.array(NonEmptyStringSchema),
}).strict();
const VaultPositionSchema = z.object({
  asset: VaultPositionAssetSchema,
  assets_available: CanonicalXrplDecimalSchema.optional(),
  assets_total: CanonicalXrplDecimalSchema.optional(),
  flags: z.number().int().nonnegative(),
  locked_balance: XrplUint64StringSchema.optional(),
  mpt_issuance_id: MptIssuanceIdSchema,
  share_balance: XrplUint64StringSchema,
  share_asset_scale: z.number().int().min(0).max(18),
  share_issuer: AccountSchema,
  vault_account: AccountSchema,
  vault_id: TransactionHashSchema,
  vault_kind: z.number().int().min(0).max(1).optional(),
  vault_owner: AccountSchema,
  vault_sequence: z.number().int().nonnegative(),
  withdrawal_policy: z.number().int().nonnegative(),
}).strict();
export const VaultPositionsResponseSchema = z.object({
  account: AccountSchema,
  ledger_hash: TransactionHashSchema,
  ledger_index: z.number().int().nonnegative(),
  marker: z.string().regex(/^v1\.[a-f0-9]{64}$/).optional(),
  network: DevVaultNetworkSchema,
  positions: z.array(VaultPositionSchema).max(100),
  validated: z.literal(true),
}).strict();
const LendingDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/);
const LendingUInt64Schema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(?:0|[1-9][0-9]*)$/),
]);
const LoanBrokerSchema = z
  .object({
    LedgerEntryType: z.literal("LoanBroker"),
    index: TransactionHashSchema,
    Flags: z.number().int().nonnegative(),
    Account: AccountSchema,
    CoverAvailable: LendingDecimalSchema.optional(),
    CoverRateMinimum: z.number().int().min(0).max(100_000).optional(),
    CoverRateLiquidation: z.number().int().min(0).max(100_000).optional(),
    Data: z.string().regex(/^(?:[A-Fa-f0-9]{2}){0,256}$/).optional(),
    DebtMaximum: LendingDecimalSchema,
    DebtTotal: LendingDecimalSchema.optional(),
    LoanSequence: z.number().int().nonnegative(),
    ManagementFeeRate: z.number().int().min(0).max(10_000).optional(),
    Owner: AccountSchema,
    OwnerCount: z.number().int().nonnegative().optional(),
    OwnerNode: LendingUInt64Schema,
    PreviousTxnID: TransactionHashSchema,
    PreviousTxnLgrSeq: z.number().int().nonnegative(),
    Sequence: z.number().int().nonnegative(),
    VaultNode: LendingUInt64Schema,
    VaultID: TransactionHashSchema,
  })
  .strict();
const LendingBrokersResultSchema = z
  .object({
    network: z.literal("lending-devnet"),
    ledger_hash: TransactionHashSchema,
    ledger_index: z.number().int().nonnegative(),
    validated: z.literal(true),
    brokers: z.array(LoanBrokerSchema),
    marker: z.string().min(1).max(256).optional(),
  })
  .strict();

const VenueRouteQuoteSchema = z.object({
  venue_id: NonEmptyStringSchema,
  route: z.enum(["order-book", "amm", "path"]),
  input_amount: NonEmptyStringSchema,
  output_amount: NonEmptyStringSchema,
  price: NonEmptyStringSchema,
  price_impact_bps: z.number().optional(),
  fee: z.string().optional(),
  available: z.boolean(),
  detail: z.string().optional(),
}).strict();
const VenueComparisonResultSchema = z.object({
  network: NetworkSchema,
  sell: AssetSchema,
  buy: AssetSchema,
  amount: NonEmptyStringSchema,
  side: z.enum(["sell", "buy"]),
  routes: z.array(VenueRouteQuoteSchema),
}).strict();
const NearIntentsTokensResultBaseSchema = z.object({
  provider: z.literal("near-intents-1click"),
  execution_enabled: z.literal(false),
  count: z.number().int().min(0).max(500),
  tokens: Near1ClickTokenListSchema,
}).strict();
const NearIntentsTokensResultSchema = z.discriminatedUnion("source", [
  NearIntentsTokensResultBaseSchema.extend({
    source: z.literal("live"),
    live: z.literal(true),
  }).strict(),
  NearIntentsTokensResultBaseSchema.extend({
    source: z.literal("fixture"),
    live: z.literal(false),
  }).strict(),
]).superRefine((result, context) => {
  if (result.count !== result.tokens.length) {
    context.addIssue({
      code: "custom",
      path: ["count"],
      message: "token count must match the returned token list",
    });
  }
});
const NearIntentsDryQuoteResultBaseSchema = z.object({
  provider: z.literal("near-intents-1click"),
  mode: z.literal("dry"),
  execution_enabled: z.literal(false),
  quote: Near1ClickDryQuoteResponseSchema,
}).strict();
const NearIntentsDryQuoteResultSchema = z.discriminatedUnion("source", [
  NearIntentsDryQuoteResultBaseSchema.extend({
    source: z.literal("live"),
    signature_verified: z.literal(true),
    quote_hash: Near1ClickQuoteHashSchema,
  }).strict(),
  NearIntentsDryQuoteResultBaseSchema.extend({
    source: z.literal("fixture"),
    signature_verified: z.literal(false),
    local_fixture_id: z.string().regex(/^near-fixture-[a-z0-9-]{1,96}$/),
  }).strict(),
]);
const NearIntentsStatusResultBaseSchema = z.object({
  provider: z.literal("near-intents-1click"),
  execution_enabled: z.literal(false),
  status: Near1ClickStatusResponseSchema,
}).strict();
const NearIntentsStatusResultSchema = z.discriminatedUnion("source", [
  NearIntentsStatusResultBaseSchema.extend({
    source: z.literal("live"),
    signature_verified: z.literal(true),
  }).strict(),
  NearIntentsStatusResultBaseSchema.extend({
    source: z.literal("fixture"),
    signature_verified: z.literal(false),
  }).strict(),
]);
const NearExecutableReviewStatusLookupBaseSchema = z.object({
  operation: z.literal("near.intents.status"),
  deposit_address: NearArbitrumAddressSchema,
  deposit_memo: z.null(),
  expected_correlation_id: NearCorrelationIdSchema,
});
const NearExecutableReviewOwnerBaseSchema = z.object({
  action: z.literal("manually-transfer-origin-asset"),
  network: z.literal("arbitrum-mainnet"),
  chain_id: z.literal(42161),
  token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
  token_decimals: z.literal(6),
  amount_atomic: NearAtomicAmountSchema,
  deposit_address: NearArbitrumAddressSchema,
  deposit_memo: z.null(),
  provider_deadline: z.string().datetime({ offset: true }),
  provider_time_when_inactive: z.string().datetime({ offset: true }),
  quote_correlation_id: NearCorrelationIdSchema,
  destination_asset_id: z.literal(NEAR_WRAPPED_NEAR_ASSET_ID),
  destination_recipient: NearAccountIdSchema,
  estimated_amount_out: NearAtomicAmountSchema,
  minimum_amount_out: NearAtomicAmountSchema,
  app_fee_bps: z.literal(0),
  transaction_built: z.literal(false),
  transaction_signed: z.literal(false),
  transaction_broadcast: z.literal(false),
  funding_state: z.literal("not-funded"),
  warning: z.string().min(1).max(1_024),
});
const NearExecutableReviewFixtureQuoteSchema = z.object({
  version: z.literal("pilot-near-arbitrum-usdc-to-wnear-quote-fixture-v1"),
  route: NearArbitrumUsdcToWnearRouteSchema,
  correlation_id: NearCorrelationIdSchema,
  provider_timestamp: z.string().datetime({ offset: true }),
  request_echo: NearArbitrumUsdcToWnearExecutableQuoteRequestSchema,
  amount_in: NearAtomicAmountSchema,
  amount_out: NearAtomicAmountSchema,
  min_amount_out: NearAtomicAmountSchema,
  recipient: NearAccountIdSchema,
  refund_to: NearArbitrumAddressSchema,
  deposit_address: NearArbitrumAddressSchema,
  deposit_memo_present: z.literal(false),
  provider_deadline_at: z.string().datetime({ offset: true }),
  provider_time_when_inactive_at: z.string().datetime({ offset: true }),
  approval_expires_at: z.string().datetime({ offset: true }),
}).strict().superRefine((quote, context) => {
  const issue = (path: string[], message: string) => context.addIssue({
    code: "custom",
    path,
    message,
  });
  if (quote.amount_in !== quote.request_echo.amount) {
    issue(["amount_in"], "fixture amount must match its request echo");
  }
  if (quote.recipient !== quote.request_echo.recipient) {
    issue(["recipient"], "fixture recipient must match its request echo");
  }
  if (quote.refund_to.toLowerCase() !== quote.request_echo.refundTo.toLowerCase()) {
    issue(["refund_to"], "fixture refund address must match its request echo");
  }
  if (quote.provider_deadline_at !== quote.request_echo.deadline) {
    issue(["provider_deadline_at"], "fixture deadline must match its request echo");
  }
  if (Date.parse(quote.approval_expires_at) > Date.parse(quote.provider_deadline_at)) {
    issue(["approval_expires_at"], "fixture review must expire no later than provider refund start");
  }
});
const NearExecutableReviewResultBaseSchema = z.object({
  provider: z.literal("near-intents-1click"),
  mode: z.literal("executable-review"),
  route: NearArbitrumUsdcToWnearRouteSchema,
  execution_enabled: z.literal(false),
  manual_funding_required: z.literal(true),
});
const NearArbitrumExecutableQuoteReviewResultSchema = z.discriminatedUnion("source", [
  NearExecutableReviewResultBaseSchema.extend({
    source: z.literal("live"),
    provider_signature_verified: z.literal(true),
    quote_hash: Near1ClickQuoteHashSchema,
    quote_binding: NearArbitrumUsdcToWnearExecutableQuoteBindingSchema,
    owner_review: NearExecutableReviewOwnerBaseSchema.extend({
      status_lookup: NearExecutableReviewStatusLookupBaseSchema.extend({
        expected_quote_hash: Near1ClickQuoteHashSchema,
      }).strict(),
    }).strict(),
  }).strict(),
  NearExecutableReviewResultBaseSchema.extend({
    source: z.literal("fixture"),
    provider_signature_verified: z.literal(false),
    local_fixture_id: z.literal(NEAR_EXECUTABLE_REVIEW_FIXTURE_ID),
    fixture_quote: NearExecutableReviewFixtureQuoteSchema,
    owner_review: NearExecutableReviewOwnerBaseSchema.extend({
      status_lookup: NearExecutableReviewStatusLookupBaseSchema.extend({
        local_fixture_id: z.literal(NEAR_EXECUTABLE_REVIEW_FIXTURE_ID),
      }).strict(),
    }).strict(),
  }).strict(),
]).superRefine((result, context) => {
  const quote = result.source === "live" ? result.quote_binding : result.fixture_quote;
  const owner = result.owner_review;
  const issue = (path: string[], message: string) => context.addIssue({
    code: "custom",
    path,
    message,
  });
  if (owner.amount_atomic !== quote.amount_in) issue(["owner_review", "amount_atomic"], "owner amount must match quote");
  if (owner.minimum_amount_out !== quote.min_amount_out) issue(["owner_review", "minimum_amount_out"], "owner minimum output must match quote");
  if (owner.destination_recipient !== quote.recipient) issue(["owner_review", "destination_recipient"], "owner recipient must match quote");
  if (owner.deposit_address.toLowerCase() !== quote.deposit_address.toLowerCase()) issue(["owner_review", "deposit_address"], "owner deposit address must match quote");
  if (owner.provider_deadline !== quote.provider_deadline_at) issue(["owner_review", "provider_deadline"], "owner deadline must match quote");
  if (owner.provider_time_when_inactive !== quote.provider_time_when_inactive_at) issue(["owner_review", "provider_time_when_inactive"], "owner inactivity time must match quote");
  if (owner.quote_correlation_id !== quote.correlation_id) issue(["owner_review", "quote_correlation_id"], "owner correlation id must match quote");
  if (owner.status_lookup.deposit_address.toLowerCase() !== quote.deposit_address.toLowerCase()) issue(["owner_review", "status_lookup", "deposit_address"], "status lookup deposit address must match quote");
  if (owner.status_lookup.expected_correlation_id !== quote.correlation_id) issue(["owner_review", "status_lookup", "expected_correlation_id"], "status lookup correlation id must match quote");
  if (result.source === "live") {
    if (result.quote_hash !== result.quote_binding.quote_hash) issue(["quote_hash"], "top-level quote hash must match quote binding");
    if (result.owner_review.estimated_amount_out !== result.quote_binding.provider_quote_response.quote.amountOut) issue(["owner_review", "estimated_amount_out"], "estimated output must match provider quote");
    if (result.owner_review.status_lookup.expected_quote_hash !== result.quote_hash) issue(["owner_review", "status_lookup", "expected_quote_hash"], "status lookup quote hash must match quote binding");
  } else if (owner.estimated_amount_out !== result.fixture_quote.amount_out) {
    issue(["owner_review", "estimated_amount_out"], "fixture estimated output must match fixture quote");
  }
});
const NearNativeReviewStatusLookupBaseSchema = z.object({
  operation: z.literal("near.intents.status"),
  profile: z.literal(NEAR_NATIVE_EXECUTABLE_REVIEW_ROUTE),
  deposit_address: NearAccountIdSchema,
  deposit_memo: z.null(),
  expected_correlation_id: NearCorrelationIdSchema,
});
const NearNativeReviewOwnerBaseSchema = z.object({
  action: z.literal("manually-transfer-native-near"),
  network: z.literal("near-mainnet"),
  funding_asset: z.literal("native-near"),
  amount_atomic: NearAtomicAmountSchema,
  amount_unit: z.literal("yoctoNEAR"),
  deposit_address: NearAccountIdSchema,
  deposit_memo: z.null(),
  managed_wrapping_by_1click: z.literal(true),
  owner_should_send_native_near: z.literal(true),
  owner_should_not_pre_wrap: z.literal(true),
  provider_deadline: z.string().datetime({ offset: true }),
  provider_time_when_inactive: z.string().datetime({ offset: true }),
  quote_correlation_id: NearCorrelationIdSchema,
  destination_chain_id: z.literal(42161),
  destination_token_contract: z.literal(NEAR_ARBITRUM_USDC_CONTRACT),
  destination_token_decimals: z.literal(6),
  destination_recipient: NearArbitrumAddressSchema,
  estimated_amount_out: NearAtomicAmountSchema,
  minimum_amount_out: NearAtomicAmountSchema,
  app_fee_bps: z.literal(0),
  transaction_built: z.literal(false),
  transaction_signed: z.literal(false),
  transaction_broadcast: z.literal(false),
  funding_state: z.literal("not-funded"),
  warning: z.string().min(1).max(1_024),
});
const NearNativeReviewFixtureQuoteSchema = z.object({
  version: z.literal("pilot-near-native-to-arbitrum-usdc-quote-fixture-v1"),
  route: NearNativeNearToArbitrumUsdcRouteSchema,
  correlation_id: NearCorrelationIdSchema,
  provider_timestamp: z.string().datetime({ offset: true }),
  request_echo: NearNativeNearToArbitrumUsdcExecutableQuoteRequestSchema,
  amount_in: NearAtomicAmountSchema,
  amount_out: NearAtomicAmountSchema,
  min_amount_out: NearAtomicAmountSchema,
  recipient: NearArbitrumAddressSchema,
  refund_to: NearAccountIdSchema,
  deposit_address: NearAccountIdSchema,
  deposit_memo_present: z.literal(false),
  provider_deadline_at: z.string().datetime({ offset: true }),
  provider_time_when_inactive_at: z.string().datetime({ offset: true }),
  approval_expires_at: z.string().datetime({ offset: true }),
}).strict().superRefine((quote, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  if (quote.amount_in !== quote.request_echo.amount) issue(["amount_in"], "fixture amount must match its request echo");
  if (quote.recipient.toLowerCase() !== quote.request_echo.recipient.toLowerCase()) issue(["recipient"], "fixture recipient must match its request echo");
  if (quote.refund_to !== quote.request_echo.refundTo) issue(["refund_to"], "fixture refund account must match its request echo");
  if (quote.provider_deadline_at !== quote.request_echo.deadline) issue(["provider_deadline_at"], "fixture deadline must match its request echo");
  if (Date.parse(quote.approval_expires_at) <= Date.parse(quote.provider_timestamp) || Date.parse(quote.approval_expires_at) > Date.parse(quote.provider_deadline_at)) issue(["approval_expires_at"], "fixture review expiry must follow issuance and not exceed refund start");
});
const NearNativeReviewResultBaseSchema = z.object({
  provider: z.literal("near-intents-1click"),
  mode: z.literal("executable-review"),
  route: NearNativeNearToArbitrumUsdcRouteSchema,
  execution_enabled: z.literal(false),
  manual_funding_required: z.literal(true),
});
const NearNativeExecutableQuoteReviewResultSchema = z.discriminatedUnion("source", [
  NearNativeReviewResultBaseSchema.extend({
    source: z.literal("live"),
    provider_signature_verified: z.literal(true),
    quote_hash: Near1ClickQuoteHashSchema,
    quote_binding: NearNativeNearToArbitrumUsdcExecutableQuoteBindingSchema,
    owner_review: NearNativeReviewOwnerBaseSchema.extend({
      status_lookup: NearNativeReviewStatusLookupBaseSchema.extend({ expected_quote_hash: Near1ClickQuoteHashSchema }).strict(),
    }).strict(),
  }).strict(),
  NearNativeReviewResultBaseSchema.extend({
    source: z.literal("fixture"),
    provider_signature_verified: z.literal(false),
    local_fixture_id: z.literal(NEAR_NATIVE_EXECUTABLE_REVIEW_FIXTURE_ID),
    fixture_quote: NearNativeReviewFixtureQuoteSchema,
    owner_review: NearNativeReviewOwnerBaseSchema.extend({
      status_lookup: NearNativeReviewStatusLookupBaseSchema.extend({ local_fixture_id: z.literal(NEAR_NATIVE_EXECUTABLE_REVIEW_FIXTURE_ID) }).strict(),
    }).strict(),
  }).strict(),
]).superRefine((result, context) => {
  const quote = result.source === "live" ? result.quote_binding : result.fixture_quote;
  const owner = result.owner_review;
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  if (owner.amount_atomic !== quote.amount_in) issue(["owner_review", "amount_atomic"], "owner amount must match quote");
  if (owner.minimum_amount_out !== quote.min_amount_out) issue(["owner_review", "minimum_amount_out"], "owner minimum output must match quote");
  if (owner.destination_recipient.toLowerCase() !== quote.recipient.toLowerCase()) issue(["owner_review", "destination_recipient"], "owner recipient must match quote");
  if (owner.deposit_address !== quote.deposit_address) issue(["owner_review", "deposit_address"], "owner deposit account must match quote");
  if (owner.provider_deadline !== quote.provider_deadline_at) issue(["owner_review", "provider_deadline"], "owner deadline must match quote");
  if (owner.provider_time_when_inactive !== quote.provider_time_when_inactive_at) issue(["owner_review", "provider_time_when_inactive"], "owner inactivity time must match quote");
  if (owner.quote_correlation_id !== quote.correlation_id) issue(["owner_review", "quote_correlation_id"], "owner correlation id must match quote");
  if (owner.status_lookup.deposit_address !== quote.deposit_address) issue(["owner_review", "status_lookup", "deposit_address"], "status deposit account must match quote");
  if (owner.status_lookup.expected_correlation_id !== quote.correlation_id) issue(["owner_review", "status_lookup", "expected_correlation_id"], "status correlation id must match quote");
  if (result.source === "live") {
    if (result.quote_hash !== result.quote_binding.quote_hash) issue(["quote_hash"], "top-level quote hash must match quote binding");
    if (result.owner_review.estimated_amount_out !== result.quote_binding.provider_quote_response.quote.amountOut) issue(["owner_review", "estimated_amount_out"], "estimated output must match provider quote");
    if (result.owner_review.status_lookup.expected_quote_hash !== result.quote_hash) issue(["owner_review", "status_lookup", "expected_quote_hash"], "status quote hash must match quote binding");
  } else if (owner.estimated_amount_out !== result.fixture_quote.amount_out) {
    issue(["owner_review", "estimated_amount_out"], "fixture estimated output must match fixture quote");
  }
});
const NearIntentsExecutableQuoteReviewResultSchema = z.union([
  NearArbitrumExecutableQuoteReviewResultSchema,
  NearNativeExecutableQuoteReviewResultSchema,
]);
const AccountInfoResultSchema = z.object({
  account_data: JsonObjectSchema,
  ledger_current_index: z.number().int().nonnegative().optional(),
  ledger_hash: LedgerHashSchema.optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  validated: z.boolean().optional(),
  queue_data: JsonObjectSchema.optional(),
  signer_lists: z.array(JsonObjectSchema).optional(),
}).passthrough();
const AccountTrustLineSchema = z.object({
  account: AccountSchema,
  balance: z.string(),
  currency: NonEmptyStringSchema,
  limit: z.string(),
  limit_peer: z.string().optional(),
  authorized: z.boolean().optional(),
  freeze: z.boolean().optional(),
}).passthrough();
const AccountLinesResultSchema = z.object({
  account: AccountSchema,
  ledger_current_index: z.number().int().nonnegative().optional(),
  ledger_hash: LedgerHashSchema.optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  validated: z.boolean().optional(),
  lines: z.array(AccountTrustLineSchema),
  marker: PaginationMarkerSchema.optional(),
}).passthrough();
const AccountObjectsResultSchema = z.object({
  account: AccountSchema,
  ledger_current_index: z.number().int().nonnegative().optional(),
  ledger_hash: LedgerHashSchema.optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  validated: z.boolean().optional(),
  account_objects: z.array(JsonObjectSchema),
  marker: PaginationMarkerSchema.optional(),
}).passthrough();
const AccountTransactionSchema = z.object({
  hash: TransactionHashSchema.optional(),
  close_time_iso: z.string().optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  validated: z.boolean(),
  tx: JsonObjectSchema.optional(),
  tx_json: JsonObjectSchema.optional(),
  meta: z.union([JsonObjectSchema, z.string(), z.null()]),
}).passthrough().refine((value) => value.tx !== undefined || value.tx_json !== undefined, {
  message: "account transaction must include tx or tx_json",
});
const AccountTransactionsResultSchema = z.object({
  account: AccountSchema,
  ledger_index_min: z.number().int(),
  ledger_index_max: z.number().int(),
  transactions: z.array(AccountTransactionSchema),
  marker: PaginationMarkerSchema.optional(),
}).passthrough();
const LedgerAmountSchema = z.union([z.string(), z.object({
  currency: NonEmptyStringSchema,
  issuer: AccountSchema,
  value: z.string(),
}).strict()]);
const BookOfferSchema = z.object({
  taker_gets: LedgerAmountSchema,
  taker_pays: LedgerAmountSchema,
  quality: z.string(),
}).passthrough();
const DexBookResultSchema = z.object({
  ledger_current_index: z.number().int().nonnegative().optional(),
  ledger_hash: LedgerHashSchema.optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  validated: z.boolean().optional(),
  offers: z.array(JsonObjectSchema),
}).passthrough();
const DexDepthResultSchema = z.object({
  network: NetworkSchema,
  taker_gets: AssetSchema,
  taker_pays: AssetSchema,
  ledger_current_index: z.number().int().nonnegative().optional(),
  ledger_hash: LedgerHashSchema.optional(),
  ledger_index: z.number().int().nonnegative().optional(),
  levels: z.array(z.object({
    price: z.string(),
    quality: z.string(),
    taker_gets: z.string(),
    taker_pays: z.string(),
    offer_count: z.number().int().nonnegative(),
  }).strict()),
  totals: z.object({
    taker_gets: z.string(),
    taker_pays: z.string(),
    offer_count: z.number().int().nonnegative(),
  }).strict(),
}).strict();
const AmmInfoResultSchema = z.object({
  network: NetworkSchema,
  ledger_index: z.number().int().nonnegative(),
  amm: JsonObjectSchema,
}).strict();
const MarketAnalyticsIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), currency: z.literal("XRP"), issuer: z.null() }).strict(),
  z.object({ kind: z.literal("issued"), currency: IssuedCurrencySchema, issuer: AccountSchema }).strict(),
]);
const MarketAnalyticsLevelSchema = z.object({
  price: AnalyticsPositiveDecimalSchema,
  base_size: AnalyticsPositiveDecimalSchema,
  quote_size: AnalyticsPositiveDecimalSchema,
  offer_count: z.number().int().positive(),
  cumulative_base_size: AnalyticsPositiveDecimalSchema,
}).strict();
const SignedAnalyticsDecimalSchema = z.string().max(96).regex(
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/,
);
const MarketAnalyticsEstimateSchema = z.object({
  direction: z.enum(["sell-base", "buy-base"]),
  requested_base: AnalyticsPositiveDecimalSchema,
  filled_base: XrplDecimalSchema,
  quote_amount: XrplDecimalSchema,
  average_price: AnalyticsPositiveDecimalSchema.nullable(),
  price_impact_bps: SignedAnalyticsDecimalSchema.nullable(),
  benchmark: z.literal("book-mid").nullable(),
  available: z.boolean(),
  limited_by_depth: z.boolean(),
  levels_consumed: z.number().int().nonnegative(),
}).strict();
const MarketAnalyticsSnapshotResultSchema = z.object({
  network: NetworkSchema,
  pair: z.object({ base: MarketAnalyticsIdentitySchema, quote: MarketAnalyticsIdentitySchema }).strict(),
  source: z.object({
    operation: z.literal("analytics.marketSnapshot"),
    providers: z.array(z.string().min(1).max(120)).min(1).max(8),
    request_count: z.number().int().min(1).max(10),
    bounded: z.literal(true),
  }).strict(),
  observed_at: z.string().datetime({ offset: true }),
  ledger_index: z.number().int().nonnegative().optional(),
  ledger_indexes: z.object({
    bids: z.number().int().nonnegative().nullable(),
    asks: z.number().int().nonnegative().nullable(),
    amm: z.number().int().nonnegative().nullable(),
  }).strict().optional(),
  freshness: z.object({
    status: z.enum(["live-observation", "partial-observation", "mixed-ledger"]),
    basis: z.literal("validated-ledger"),
    age_seconds: z.null(),
    note: z.string().min(1).max(500),
  }).strict(),
  units: z.object({
    base_size: z.string().min(1),
    quote_size: z.string().min(1),
    price: z.string().min(1),
    spread_bps: z.string().min(1),
  }).strict(),
  book: z.object({
    bids: z.array(MarketAnalyticsLevelSchema).max(100),
    asks: z.array(MarketAnalyticsLevelSchema).max(100),
    limited: z.boolean(),
    max_levels: z.number().int().min(1).max(100),
    availability: z.object({
      bids: z.enum(["available", "empty", "error"]),
      asks: z.enum(["available", "empty", "error"]),
    }).strict(),
    invalid_offer_count: z.number().int().nonnegative(),
  }).strict(),
  metrics: z.object({
    best_bid: AnalyticsPositiveDecimalSchema.nullable(),
    best_ask: AnalyticsPositiveDecimalSchema.nullable(),
    mid: AnalyticsPositiveDecimalSchema.nullable(),
    spread: SignedAnalyticsDecimalSchema.nullable(),
    spread_bps: SignedAnalyticsDecimalSchema.nullable(),
  }).strict(),
  executable_liquidity: z.array(z.object({
    base_amount: AnalyticsPositiveDecimalSchema,
    sell_base: MarketAnalyticsEstimateSchema.extend({ direction: z.literal("sell-base") }).strict(),
    buy_base: MarketAnalyticsEstimateSchema.extend({ direction: z.literal("buy-base") }).strict(),
  }).strict()).max(5),
  amm: z.object({
    account: AccountSchema.nullable(),
    base_reserve: AnalyticsPositiveDecimalSchema,
    quote_reserve: AnalyticsPositiveDecimalSchema,
    implied_price: AnalyticsPositiveDecimalSchema,
    trading_fee_bps: XrplDecimalSchema,
    units: z.record(z.string(), z.string()),
  }).strict().optional(),
  availability: z.object({ amm: z.enum(["available", "unavailable", "error"]) }).strict(),
  history: z.object({
    points: z.array(z.object({
      observed_at: z.string().datetime({ offset: true }),
      ledger_index: z.number().int().nonnegative().optional(),
      price: AnalyticsPositiveDecimalSchema,
    }).strict()).max(1),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }),
    max_samples: z.literal(1),
    complete: z.literal(false),
    reason: z.string().min(1).max(500),
  }).strict(),
  recent_trades: z.object({
    support: z.literal("unsupported"),
    rows: z.tuple([]),
    reason: z.string().min(1).max(500),
  }).strict(),
  partial: z.boolean(),
  partial_reasons: z.array(z.string().min(1).max(300)).max(20),
}).strict();
const TokenLookupResultSchema = z.object({
  network: NetworkSchema,
  asset: AssetSchema,
  name: z.string().optional(),
  symbol: z.string().optional(),
  description: z.string().optional(),
  price_usd: z.string().optional(),
  market_cap_usd: z.string().optional(),
  volume_24h_usd: z.string().optional(),
  flags: z.object({
    require_auth: z.boolean(),
    global_freeze: z.boolean(),
    clawback: z.boolean(),
    blackholed: z.boolean(),
  }).strict(),
  sources: z.array(z.string()),
}).strict();
const YieldOptionSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  kind: z.enum(["amm", "vault", "protocol"]),
  venue_id: NonEmptyStringSchema,
  network: NetworkSchema,
  asset: AssetSchema,
  asset2: AssetSchema.optional(),
  apr_percent: z.string().optional(),
  apy_percent: z.string().optional(),
  tvl_usd: z.string().optional(),
  risks: z.array(z.string()),
}).strict();
const YieldOptionsResultSchema = z.object({
  network: NetworkSchema,
  asset: AssetSchema,
  amount: z.string().optional(),
  options: z.array(YieldOptionSchema),
}).strict();

const SafeExecResultSchema = ExecResultSchema.superRefine((result, context) => {
  if (result.status === "executed") {
    if (!/^[A-Fa-f0-9]{64}$/.test(result.hash)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hash"], message: "invalid transaction hash" });
    }
    if (!Number.isSafeInteger(result.ledger_index) || result.ledger_index < 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["ledger_index"], message: "invalid validated ledger index" });
    }
  }
  if (result.status === "needs_approval") {
    if (result.approval_id.trim().length === 0 || result.approval_id.length > 256) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["approval_id"], message: "invalid approval id" });
    }
    if (!Number.isFinite(Date.parse(result.expires_at))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expires_at"], message: "invalid approval expiry" });
    }
    if (typeof result.tx_json.Account !== "string" || result.tx_json.Account.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tx_json", "Account"], message: "missing approval account" });
    }
    if (typeof result.tx_json.TransactionType !== "string" || result.tx_json.TransactionType.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tx_json", "TransactionType"], message: "missing transaction type" });
    }
  }
});

const ApprovalPreflightResultSchema = z.object({
  status: z.literal("ready"),
  approval_id: NonEmptyStringSchema.max(256),
  expires_at: z.string().datetime({ offset: true }),
  validated_ledger: z.number().int().positive().safe(),
  remaining_ledgers: z.number().int().nonnegative().safe(),
  execution_capability: ExecutionCapabilitySchema,
}).strict();

const ApprovalReconcileResultSchema = z.object({
  status: z.literal("expired_nonincluded"),
  approval_id: NonEmptyStringSchema.max(256),
  execution_id: NonEmptyStringSchema.max(256),
  validated_ledger: z.number().int().positive().safe(),
  first_inclusion_ledger: z.number().int().positive().safe(),
  last_ledger_sequence: z.number().int().positive().safe(),
  next_action: z.literal("request_fresh_build"),
}).strict().superRefine((result, context) => {
  if (result.first_inclusion_ledger > result.last_ledger_sequence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["first_inclusion_ledger"],
      message: "inclusion window is reversed",
    });
  }
  if (result.validated_ledger <= result.last_ledger_sequence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validated_ledger"],
      message: "validated ledger has not passed the inclusion window",
    });
  }
});

const MandatePrepareResultSchema = z.object({
  mandate_id: NonEmptyStringSchema,
  agent_public_jwk: JsonObjectSchema,
  claim_public_keys: z.array(z.object({
    merchant_id: NonEmptyStringSchema,
    public_key: NonEmptyStringSchema,
  }).strict()),
  unsigned_batch: JsonObjectSchema,
  unsigned_sequential: z.array(JsonObjectSchema).optional(),
}).strict();
const CredentialStatusResultSchema = z.object({
  account: AccountSchema,
  network: z.literal("testnet"),
  issuer: AccountSchema,
  credential_type_hex: NonEmptyStringSchema,
  credential_id: NonEmptyStringSchema.optional(),
  accepted: z.boolean(),
  expired: z.boolean(),
  expiration: z.string().optional(),
}).strict();
const CredentialPayerAcceptResultSchema = z.object({
  account: AccountSchema,
  credential_id: NonEmptyStringSchema,
  status: z.enum(["validated", "pending", "failed"]),
  hash: z.string().optional(),
  engine_result: z.string().optional(),
}).strict();
const CredentialIdsResultSchema = z.object({
  account: AccountSchema,
  network: z.literal("testnet"),
  credential_ids: z.array(NonEmptyStringSchema),
}).strict();
const Ap4mPurchaseResultSchema = z.object({
  receipt: Ap4mReceiptSchema,
  data: JsonObjectSchema,
  evidence: Ap4mPublicEvidenceSchema.optional(),
}).strict();
const ChannelStatusResultSchema = z.object({
  channel_id: NonEmptyStringSchema,
  mandate_id: NonEmptyStringSchema,
  merchant_id: NonEmptyStringSchema,
  network: z.literal("testnet"),
  amount_drops: NonEmptyStringSchema,
  highest_claim_drops: NonEmptyStringSchema,
  remaining_drops: NonEmptyStringSchema,
  status: z.enum(["open", "closing", "closed"]),
  settle_delay: z.number().int().nonnegative(),
}).strict();
const MastercardServicesResultSchema = z.object({
  source: z.literal("Mastercard Developers"),
  services: z.array(JsonObjectSchema),
}).strict();
const MastercardDocsResultSchema = z.object({
  source: z.literal("Mastercard Developers"),
  service_id: NonEmptyStringSchema,
  pages: z.array(JsonObjectSchema),
}).strict();
const MastercardPageResultSchema = z.object({
  source: z.literal("Mastercard Developers"),
  path: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),
  url: NonEmptyStringSchema,
}).strict();
const MastercardSearchResultSchema = z.object({
  source: z.literal("Mastercard Developers"),
  query: z.string(),
  results: z.array(JsonObjectSchema),
}).strict();

/** Runtime result validation for every supported Harbor operation. */
export const HarborResultSchemas = {
  "merchants.list": z.array(MerchantSchema),
  "merchants.get": MerchantSchema,
  "mandate.prepare": MandatePrepareResultSchema,
  "mandate.register": MandateSchema,
  "mandate.status": MandateSchema,
  "mandate.revoke": MandateSchema,
  "credential.status": CredentialStatusResultSchema,
  "credential.payerAccept": CredentialPayerAcceptResultSchema,
  "credential.ids": CredentialIdsResultSchema,
  "ap4m.purchase": Ap4mPurchaseResultSchema,
  "channel.status": ChannelStatusResultSchema,
  "channel.list": z.array(ChannelStatusResultSchema),
  "mastercard.services": MastercardServicesResultSchema,
  "mastercard.docs": MastercardDocsResultSchema,
  "mastercard.page": MastercardPageResultSchema,
  "mastercard.search": MastercardSearchResultSchema,
  "venues.list": z.array(VenueSchema),
  "venues.get": VenueSchema,
  "venues.compare": VenueComparisonResultSchema,
  "near.intents.tokens": NearIntentsTokensResultSchema,
  "near.intents.quote": NearIntentsDryQuoteResultSchema,
  "near.intents.status": NearIntentsStatusResultSchema,
  "near.intents.executable-quote.review": NearIntentsExecutableQuoteReviewResultSchema,
  "near.intents.owner-funded.reserve": NearNativeNearToArbitrumUsdcReserveResultSchema,
  "near.intents.owner-funded.reconcile": NearNativeNearToArbitrumUsdcReconcileResultSchema,
  "ledger.account.info": AccountInfoResultSchema,
  "ledger.account.lines": AccountLinesResultSchema,
  "ledger.account.objects": AccountObjectsResultSchema,
  "ledger.account.tx": AccountTransactionsResultSchema,
  "dex.book": DexBookResultSchema,
  "dex.depth": DexDepthResultSchema,
  "analytics.marketSnapshot": MarketAnalyticsSnapshotResultSchema,
  "amm.info": AmmInfoResultSchema,
  "vault.info": VaultInfoResultSchema,
  "vault.positions": VaultPositionsResponseSchema,
  "lending.brokers": LendingBrokersResultSchema,
  "tokens.lookup": TokenLookupResultSchema,
  "yield.options": YieldOptionsResultSchema,
  "onboarding.readiness": OnboardingReadinessResultSchema,
  "account.link": AccountLinkSchema,
  "account.status": AccountLinkSchema,
  "account.revoke": AccountLinkSchema,
  "policy.get": PolicySchema,
  "policy.set": PolicySchema,
  "tx.swap": TxBuildSchema,
  "tx.offer": TxBuildSchema,
  "tx.offerCancel": TxBuildSchema,
  "tx.payment": TxBuildSchema,
  "tx.trustSet": TxBuildSchema,
  "tx.ammDeposit": TxBuildSchema,
  "tx.ammWithdraw": TxBuildSchema,
  "tx.vaultDeposit": TxBuildSchema,
  "tx.vaultWithdraw": TxBuildSchema,
  "tx.escrowCreate": TxBuildSchema,
  "tx.escrowFinish": TxBuildSchema,
  "tx.escrowCancel": TxBuildSchema,
  "tx.checkCreate": TxBuildSchema,
  "tx.checkCash": TxBuildSchema,
  "tx.checkCancel": TxBuildSchema,
  "tx.simulate": TxBuildSchema,
  "tx.execute": SafeExecResultSchema,
  "tx.approvalPreflight": ApprovalPreflightResultSchema,
  "tx.approvalReconcile": ApprovalReconcileResultSchema,
  "tx.submit": TxSubmitResultSchema,
  "tx.status": TxStatusResultSchema,
  "strategy.create": StrictStrategySchema,
  "strategy.validate": StrategyPlanValidationResultSchema,
  "strategy.simulate": StrategyPlanPreviewSchema,
  "strategy.list": z.array(StrictStrategySchema),
  "strategy.get": StrictStrategySchema,
  "strategy.audit": z.array(StrategyAuditEventSchema),
  "strategy.authorize": StrictStrategySchema,
  "strategy.pause": StrictStrategySchema,
  "strategy.resume": StrictStrategySchema,
  "strategy.stop": StrictStrategySchema,
  "strategy.kill": StrictStrategySchema,
  "strategy.globalKill.get": StrategyKillSwitchSchema,
  "strategy.globalKill.set": StrategyKillSwitchSchema,
  "x402.pay": X402PayResultSchema,
  "x402.payIssuedFixture": X402IssuedFixtureResultSchema,
} satisfies Record<HarborOpName, z.ZodTypeAny>;

export interface HarborOp {
  <K extends HarborOpName>(
    name: K,
    args: ArgsFor<K>,
  ): Promise<Envelope<ResultFor<K>>>;
}

export interface HarborClient {
  op: HarborOp;
}
