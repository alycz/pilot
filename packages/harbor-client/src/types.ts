import { AssetSchema, NetworkSchema, PolicySchema } from "@pilot/contracts";
import type {
  AccountLink,
  Asset,
  Envelope,
  ExecResult,
  Network,
  Policy,
  TxBuild,
  Venue,
} from "@pilot/contracts";
import { z } from "zod";

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

export interface AccountInfoResult {
  account: string;
  ledger_index: number;
  validated: boolean;
  account_data: JsonObject;
}

export interface AccountTrustLine extends JsonObject {
  account: string;
  balance: string;
  currency: string;
  limit: string;
  limit_peer: string;
  authorized?: boolean;
  freeze?: boolean;
}

export interface AccountLinesResult {
  account: string;
  ledger_index: number;
  validated: boolean;
  lines: AccountTrustLine[];
  marker?: PaginationMarker;
}

export interface AccountObjectsResult {
  account: string;
  ledger_index: number;
  validated: boolean;
  account_objects: JsonObject[];
  marker?: PaginationMarker;
}

export interface AccountTransaction {
  hash: string;
  ledger_index?: number;
  validated: boolean;
  tx: JsonObject;
  meta: JsonObject | null;
}

export interface AccountTransactionsResult {
  account: string;
  ledger_index_min: number;
  ledger_index_max: number;
  transactions: AccountTransaction[];
  marker?: PaginationMarker;
}

export type LedgerAmount = string | { currency: string; issuer: string; value: string };

export interface BookOffer extends JsonObject {
  taker_gets: LedgerAmount;
  taker_pays: LedgerAmount;
  quality: string;
}

export interface DexBookResult {
  network: Network;
  ledger_index: number;
  taker_gets: Asset;
  taker_pays: Asset;
  offers: BookOffer[];
}

export interface AmmInfoResult {
  network: Network;
  ledger_index: number;
  amm: JsonObject;
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

export type TxSubmitResult =
  | {
      status: "validated";
      hash: string;
      ledger_index: number;
      engine_result: string;
      result: "filled" | "partial" | "resting" | "success";
      signed_by: "owner";
    }
  | {
      status: "pending";
      hash: string;
      engine_result: string;
      signed_by: "owner";
    }
  | {
      status: "failed";
      hash?: string;
      engine_result: string;
      detail: string;
    };

export type TxStatusResult =
  | { status: "not_found"; hash: string }
  | { status: "pending"; hash: string }
  | {
      status: "validated";
      hash: string;
      ledger_index: number;
      engine_result: string;
      result: "filled" | "partial" | "resting" | "success";
    }
  | { status: "failed"; hash: string; engine_result: string; detail: string };

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
}

export interface HarborOperationMap {
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
  "ledger.account.info": {
    args: AccountArgs & { ledger_index?: LedgerIndex };
    result: AccountInfoResult;
  };
  "ledger.account.lines": {
    args: AccountArgs & PaginatedArgs & { ledger_index?: LedgerIndex; peer?: string };
    result: AccountLinesResult;
  };
  "ledger.account.objects": {
    args: AccountArgs & PaginatedArgs & { ledger_index?: LedgerIndex; type?: string };
    result: AccountObjectsResult;
  };
  "ledger.account.tx": {
    args: AccountArgs &
      PaginatedArgs & {
        ledger_index_min?: number;
        ledger_index_max?: number;
        forward?: boolean;
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
    };
    result: DexBookResult;
  };
  "amm.info": {
    args: { network: Network; asset: Asset; asset2: Asset; account?: string };
    result: AmmInfoResult;
  };
  "tokens.lookup": {
    args: { network: Network; asset: Asset };
    result: TokenLookupResult;
  };
  "yield.options": {
    args: { network: Network; asset: Asset; amount?: string };
    result: YieldOptionsResult;
  };
  "account.link": {
    args: { owner: string; network: Network; permissions?: string[] };
    result: AccountLink;
  };
  "account.status": {
    args: { owner: string; network: Network };
    result: AccountLink;
  };
  "account.revoke": {
    args: { owner: string; network: Network };
    result: AccountLink;
  };
  "policy.get": {
    args: { owner: string; network: Network };
    result: Policy;
  };
  "policy.set": {
    args: { owner: string; network: Network; policy: Policy };
    result: Policy;
  };
  "tx.swap": {
    args: BuilderArgs & {
      sell: Asset;
      buy: Asset;
      amount: string;
      side: "sell" | "buy";
      max_slippage_bps: number;
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
    args: BuilderArgs & { asset: Asset; limit: string };
    result: TxBuild;
  };
  "tx.ammDeposit": {
    args: BuilderArgs & { asset: Asset; asset2: Asset; amount: string; amount2?: string };
    result: TxBuild;
  };
  "tx.ammWithdraw": {
    args: BuilderArgs & { asset: Asset; asset2: Asset; amount: string; amount2?: string };
    result: TxBuild;
  };
  "tx.vaultDeposit": {
    args: BuilderArgs & { vault_id: string; asset: Asset; amount: string };
    result: TxBuild;
  };
  "tx.vaultWithdraw": {
    args: BuilderArgs & { vault_id: string; asset: Asset; amount: string };
    result: TxBuild;
  };
  "tx.simulate": {
    args: BuilderArgs & { tx_json: JsonObject };
    result: TxBuild;
  };
  "tx.execute": {
    args: { build_id: string; idempotency_key: string };
    result: ExecResult;
  };
  "tx.submit": {
    args: { tx_blob: string; approval_id?: string };
    result: TxSubmitResult;
  };
  "tx.status": {
    args: { hash: string };
    result: TxStatusResult;
  };
}

export type HarborOpName = keyof HarborOperationMap;
export type ArgsFor<K extends HarborOpName> = HarborOperationMap[K]["args"];
export type ResultFor<K extends HarborOpName> = HarborOperationMap[K]["result"];

const NonEmptyStringSchema = z.string().trim().min(1);
const AccountSchema = NonEmptyStringSchema.max(64);
const PositiveDecimalStringSchema = z
  .string()
  .regex(/^(?=.*[1-9])\d+(?:\.\d+)?$/, "must be a positive decimal string");
const NonNegativeDecimalStringSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, "must be a non-negative decimal string");
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
const PermissionListSchema = z
  .array(NonEmptyStringSchema)
  .max(10)
  .refine(
    (permissions) => {
      const forbidden = new Set([
        "Payment",
        "EscrowCreate",
        "CheckCreate",
        "PaymentChannelCreate",
        "PaymentChannelFund",
        "NFTokenCreateOffer",
        "PaymentBurn",
        "PaymentMint",
        "VaultDeposit",
        "VaultWithdraw",
        "AccountSet",
        "SetRegularKey",
        "SignerListSet",
        "DelegateSet",
        "AccountDelete",
        "Batch",
      ]);
      return permissions.every((permission) => !forbidden.has(permission));
    },
    "one or more permissions cannot be delegated",
  );

const builderBaseShape = {
  account: AccountSchema,
  network: NetworkSchema,
  intent_id: NonEmptyStringSchema.optional(),
} as const;

export type HarborArgsSchemaMap = {
  [K in HarborOpName]: z.ZodType<ArgsFor<K>>;
};

/** Runtime argument validation shared by mock and live transports. */
export const HarborArgsSchemas = {
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
  "ledger.account.info": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ledger_index: LedgerIndexSchema.optional(),
    })
    .strict(),
  "ledger.account.lines": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ledger_index: LedgerIndexSchema.optional(),
      peer: AccountSchema.optional(),
      limit: z.number().int().min(1).max(400).optional(),
      marker: PaginationMarkerSchema.optional(),
    })
    .strict(),
  "ledger.account.objects": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ledger_index: LedgerIndexSchema.optional(),
      type: NonEmptyStringSchema.optional(),
      limit: z.number().int().min(1).max(400).optional(),
      marker: PaginationMarkerSchema.optional(),
    })
    .strict(),
  "ledger.account.tx": z
    .object({
      account: AccountSchema,
      network: NetworkSchema,
      ledger_index_min: z.number().int().min(-1).optional(),
      ledger_index_max: z.number().int().min(-1).optional(),
      forward: z.boolean().optional(),
      limit: z.number().int().min(1).max(400).optional(),
      marker: PaginationMarkerSchema.optional(),
    })
    .strict(),
  "dex.book": z
    .object({
      network: NetworkSchema,
      taker_gets: AssetSchema,
      taker_pays: AssetSchema,
      taker: AccountSchema.optional(),
      limit: z.number().int().min(1).max(400).optional(),
    })
    .strict(),
  "amm.info": z
    .object({
      network: NetworkSchema,
      asset: AssetSchema,
      asset2: AssetSchema,
      account: AccountSchema.optional(),
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
  "account.link": z
    .object({
      owner: AccountSchema,
      network: NetworkSchema,
      permissions: PermissionListSchema.optional(),
    })
    .strict(),
  "account.status": z
    .object({ owner: AccountSchema, network: NetworkSchema })
    .strict(),
  "account.revoke": z
    .object({ owner: AccountSchema, network: NetworkSchema })
    .strict(),
  "policy.get": z
    .object({ owner: AccountSchema, network: NetworkSchema })
    .strict(),
  "policy.set": z
    .object({ owner: AccountSchema, network: NetworkSchema, policy: PolicySchema })
    .strict(),
  "tx.swap": z
    .object({
      ...builderBaseShape,
      sell: AssetSchema,
      buy: AssetSchema,
      amount: PositiveDecimalStringSchema,
      side: z.enum(["sell", "buy"]),
      max_slippage_bps: z.number().int().min(0).max(10_000),
    })
    .strict(),
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
      asset: AssetSchema,
      limit: NonNegativeDecimalStringSchema,
    })
    .strict(),
  "tx.ammDeposit": z
    .object({
      ...builderBaseShape,
      asset: AssetSchema,
      asset2: AssetSchema,
      amount: PositiveDecimalStringSchema,
      amount2: PositiveDecimalStringSchema.optional(),
    })
    .strict(),
  "tx.ammWithdraw": z
    .object({
      ...builderBaseShape,
      asset: AssetSchema,
      asset2: AssetSchema,
      amount: PositiveDecimalStringSchema,
      amount2: PositiveDecimalStringSchema.optional(),
    })
    .strict(),
  "tx.vaultDeposit": z
    .object({
      ...builderBaseShape,
      vault_id: NonEmptyStringSchema,
      asset: AssetSchema,
      amount: PositiveDecimalStringSchema,
    })
    .strict(),
  "tx.vaultWithdraw": z
    .object({
      ...builderBaseShape,
      vault_id: NonEmptyStringSchema,
      asset: AssetSchema,
      amount: PositiveDecimalStringSchema,
    })
    .strict(),
  "tx.simulate": z
    .object({ ...builderBaseShape, tx_json: JsonObjectSchema })
    .strict(),
  "tx.execute": z
    .object({
      build_id: NonEmptyStringSchema,
      idempotency_key: NonEmptyStringSchema.max(256),
    })
    .strict(),
  "tx.submit": z
    .object({
      tx_blob: NonEmptyStringSchema,
      approval_id: NonEmptyStringSchema.optional(),
    })
    .strict(),
  "tx.status": z.object({ hash: NonEmptyStringSchema }).strict(),
} satisfies HarborArgsSchemaMap;

export interface HarborOp {
  <K extends HarborOpName>(
    name: K,
    args: ArgsFor<K>,
  ): Promise<Envelope<ResultFor<K>>>;
}

export interface HarborClient {
  op: HarborOp;
}
