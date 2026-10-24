import {
  AssetSchema as ContractAssetSchema,
  IntentSchema as ContractIntentSchema,
  NetworkSchema as ContractNetworkSchema,
} from "@pilot/contracts";
import type { Asset, Intent, Network } from "@pilot/contracts";
import type { ArgsFor } from "../../harbor-client/src/types.js";
import { z } from "zod";

export type { Intent } from "@pilot/contracts";

const NonEmptyStringSchema = z.string().trim().min(1);
const IntentIdSchema = NonEmptyStringSchema.max(128);
const AccountAddressSchema = NonEmptyStringSchema.max(64);
const NetworkSchema = z.custom<Network>(
  (value) => ContractNetworkSchema.safeParse(value).success,
  "must be a supported network",
);
const PositiveDecimalStringSchema = z
  .string()
  .regex(
    /^(?=.*[1-9])(?:0|[1-9]\d*)(?:\.\d+)?$/,
    "must be a positive decimal string",
  );
const PositiveDropsSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer string");
const HttpUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => url.startsWith("https://") || url.startsWith("http://"),
    "must use http or https",
  );

/**
 * The contract schemas intentionally describe the wire shape. The intent package
 * tightens user-authored values before they reach a Harbor builder.
 */
export const StrictAssetSchema = z
  .object({
    currency: NonEmptyStringSchema.max(40),
    issuer: NonEmptyStringSchema.max(64).optional(),
  })
  .strict()
  .refine(
    (asset) => ContractAssetSchema.safeParse(asset).success,
    "must match the Asset contract",
  ) satisfies z.ZodType<Asset>;

const IntentBaseShape = {
  id: IntentIdSchema,
  network: NetworkSchema,
};

export const SwapIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("swap"),
    sell: StrictAssetSchema,
    buy: StrictAssetSchema,
    amount: PositiveDecimalStringSchema,
    side: z.enum(["sell", "buy"]),
    max_slippage_bps: z.number().int().min(0).max(10_000),
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "swap" }>>;

export const LimitIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("limit"),
    sell: StrictAssetSchema,
    buy: StrictAssetSchema,
    sell_amount: PositiveDecimalStringSchema,
    buy_amount: PositiveDecimalStringSchema,
    expires_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "limit" }>>;

export const CancelIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("cancel"),
    offer_sequence: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "cancel" }>>;

const LpIntentShape = {
  ...IntentBaseShape,
  asset: StrictAssetSchema,
  asset2: StrictAssetSchema,
  amount: PositiveDecimalStringSchema,
  amount2: PositiveDecimalStringSchema.optional(),
};

export const LpDepositIntentSchema = z
  .object({ ...LpIntentShape, kind: z.literal("lp_deposit") })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "lp_deposit" }>>;

export const LpWithdrawIntentSchema = z
  .object({ ...LpIntentShape, kind: z.literal("lp_withdraw") })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "lp_withdraw" }>>;

export const VaultDepositIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("vault_deposit"),
    vault_id: NonEmptyStringSchema.max(128),
    amount: PositiveDecimalStringSchema,
    asset: StrictAssetSchema,
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "vault_deposit" }>>;

export const PayIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("pay"),
    to: AccountAddressSchema,
    asset: StrictAssetSchema,
    amount: PositiveDecimalStringSchema,
    memo: NonEmptyStringSchema.max(256).optional(),
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "pay" }>>;

export const FundBudgetIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("fund_budget"),
    asset: StrictAssetSchema,
    amount: PositiveDecimalStringSchema,
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "fund_budget" }>>;

export const X402CallIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("x402_call"),
    url: HttpUrlSchema,
    max_price_drops: PositiveDropsSchema,
  })
  .strict() satisfies z.ZodType<Extract<Intent, { kind: "x402_call" }>>;

export const Ap4mPurchaseIntentSchema = z
  .object({
    ...IntentBaseShape,
    kind: z.literal("ap4m_purchase"),
    merchant_id: NonEmptyStringSchema.max(128),
    sku: NonEmptyStringSchema.max(128),
    mandate_id: NonEmptyStringSchema.max(128),
  })
  .strict()
  .refine((intent) => intent.network === "testnet", {
    message: "AP4M purchases are Testnet-only",
    path: ["network"],
  }) satisfies z.ZodType<Extract<Intent, { kind: "ap4m_purchase" }>>;

/** Strict runtime validation for the fixed Intent contract. */
export const IntentSchema = z
  .discriminatedUnion("kind", [
    SwapIntentSchema,
    LimitIntentSchema,
    CancelIntentSchema,
    LpDepositIntentSchema,
    LpWithdrawIntentSchema,
    VaultDepositIntentSchema,
    PayIntentSchema,
    FundBudgetIntentSchema,
    X402CallIntentSchema,
    Ap4mPurchaseIntentSchema,
  ])
  .refine(
    (intent) => ContractIntentSchema.safeParse(intent).success,
    "must match the Intent contract",
  ) satisfies z.ZodType<Intent>;

export const BuildAccountContextSchema = z
  .object({
    main_account: AccountAddressSchema,
    budget_account: AccountAddressSchema,
    delegate_account: AccountAddressSchema.optional(),
  })
  .strict();
export type BuildAccountContext = z.infer<typeof BuildAccountContextSchema>;

type KnownBuildRequest<K extends
  | "tx.offer"
  | "tx.offerCancel"
  | "tx.ammDeposit"
  | "tx.ammWithdraw"
  | "tx.vaultDeposit"
  | "tx.payment"> = { op: K; args: ArgsFor<K> };

export type HarborCurrencyAmount =
  | string
  | { currency: string; issuer: string; value: string };

type SwapBuildRequest = {
  op: "tx.swap";
  args: Omit<ArgsFor<"tx.swap">, "amount"> & {
    amount: HarborCurrencyAmount;
  };
};

export interface Ap4mPurchaseArgs {
  mandate_id: string;
  merchant_id: string;
  sku: string;
  idempotency_key: string;
}

export type BuildRequest =
  | SwapBuildRequest
  | KnownBuildRequest<"tx.offer">
  | KnownBuildRequest<"tx.offerCancel">
  | KnownBuildRequest<"tx.ammDeposit">
  | KnownBuildRequest<"tx.ammWithdraw">
  | KnownBuildRequest<"tx.vaultDeposit">
  | KnownBuildRequest<"tx.payment">
  | { op: "ap4m.purchase"; args: Ap4mPurchaseArgs };

const STANDARD_CURRENCY_BYTES = 3;
const XRPL_CURRENCY_BYTES = 20;
const HEX_CURRENCY = /^[A-Fa-f0-9]{40}$/;

/** Keep Intent user-facing; normalize non-standard codes only on the live wire. */
function harborAsset(asset: Asset): Asset {
  if (
    asset.currency.toUpperCase() === "XRP"
  ) {
    return asset;
  }
  if (HEX_CURRENCY.test(asset.currency)) {
    return { ...asset, currency: asset.currency.toUpperCase() };
  }
  const bytes = new TextEncoder().encode(asset.currency);
  if (bytes.length <= STANDARD_CURRENCY_BYTES) return asset;
  if (bytes.length > XRPL_CURRENCY_BYTES) {
    throw new Error("XRPL currency codes must encode to at most 20 bytes");
  }
  const currency = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .padEnd(XRPL_CURRENCY_BYTES * 2, "0")
    .toUpperCase();
  return { ...asset, currency };
}

function xrpDrops(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > 6) {
    throw new Error("XRP amounts must use at most 6 decimal places");
  }
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return (whole * 1_000_000n + fraction).toString();
}

/** Harbor carries every transaction amount in canonical ledger form. */
function harborAmount(asset: Asset, value: string): HarborCurrencyAmount {
  const wireAsset = harborAsset(asset);
  if (wireAsset.currency.toUpperCase() === "XRP") return xrpDrops(value);
  if (!wireAsset.issuer) {
    throw new Error("Issued-currency swap amounts require an issuer");
  }
  return {
    currency: wireAsset.currency,
    issuer: wireAsset.issuer,
    value,
  };
}

/**
 * Convert a validated Pilot intent into a Harbor operation request.
 *
 * The account context selects the budget account for normal activity, maps
 * main_account -> budget_account for funding. x402 uses its dedicated bounded
 * operation and must never pass through the generic transaction build path.
 */
export function toBuild(
  input: Intent,
  account?: BuildAccountContext,
): BuildRequest {
  const intent = IntentSchema.parse(input);
  const accounts = BuildAccountContextSchema.parse(account);
  if (intent.kind === "x402_call") {
    throw new Error("x402_call requires the dedicated local Testnet x402 operation");
  }
  if (
    intent.kind === "fund_budget" &&
    accounts.main_account === accounts.budget_account
  ) {
    throw new Error("fund_budget requires a separate main_account");
  }
  const source = intent.kind === "fund_budget"
    ? accounts.main_account
    : accounts.budget_account;
  const base = {
    account: source,
    network: intent.network,
    intent_id: intent.id,
  };

  switch (intent.kind) {
    case "swap":
      const sell = harborAsset(intent.sell);
      const buy = harborAsset(intent.buy);
      return {
        op: "tx.swap",
        args: {
          ...base,
          sell,
          buy,
          amount: harborAmount(
            intent.side === "sell" ? intent.sell : intent.buy,
            intent.amount,
          ),
          side: intent.side,
          max_slippage_bps: intent.max_slippage_bps,
          execution_mode: "fill_or_kill",
        },
      };
    case "limit":
      return {
        op: "tx.offer",
        args: {
          ...base,
          sell: harborAsset(intent.sell),
          buy: harborAsset(intent.buy),
          sell_amount: intent.sell_amount,
          buy_amount: intent.buy_amount,
          ...(intent.expires_at === undefined
            ? {}
            : { expires_at: intent.expires_at }),
        },
      };
    case "cancel":
      return {
        op: "tx.offerCancel",
        args: { ...base, offer_sequence: intent.offer_sequence },
      };
    case "lp_deposit":
      const depositAmount = harborAmount(intent.asset, intent.amount);
      const depositAmount2 = intent.amount2 === undefined
        ? undefined
        : harborAmount(intent.asset2, intent.amount2);
      return {
        op: "tx.ammDeposit",
        args: {
          ...base,
          asset: harborAsset(intent.asset),
          asset2: harborAsset(intent.asset2),
          amount: depositAmount,
          ...(depositAmount2 === undefined ? {} : { amount2: depositAmount2 }),
          flags: depositAmount2 === undefined ? 0x0008_0000 : 0x0010_0000,
        },
      };
    case "lp_withdraw":
      const withdrawAmount = harborAmount(intent.asset, intent.amount);
      const withdrawAmount2 = intent.amount2 === undefined
        ? undefined
        : harborAmount(intent.asset2, intent.amount2);
      return {
        op: "tx.ammWithdraw",
        args: {
          ...base,
          asset: harborAsset(intent.asset),
          asset2: harborAsset(intent.asset2),
          amount: withdrawAmount,
          ...(withdrawAmount2 === undefined ? {} : { amount2: withdrawAmount2 }),
          flags: withdrawAmount2 === undefined ? 0x0008_0000 : 0x0010_0000,
        },
      };
    case "vault_deposit":
      return {
        op: "tx.vaultDeposit",
        args: {
          ...base,
          vault_id: intent.vault_id,
          amount: harborAmount(intent.asset, intent.amount),
        },
      };
    case "pay":
      return {
        op: "tx.payment",
        args: {
          ...base,
          to: intent.to,
          asset: harborAsset(intent.asset),
          amount: intent.amount,
          ...(intent.memo === undefined ? {} : { memo: intent.memo }),
        },
      };
    case "fund_budget": {
      return {
        op: "tx.payment",
        args: {
          ...base,
          account: accounts.main_account,
          to: accounts.budget_account,
          asset: harborAsset(intent.asset),
          amount: intent.amount,
        },
      };
    }
    case "ap4m_purchase":
      return {
        op: "ap4m.purchase",
        args: {
          mandate_id: intent.mandate_id,
          merchant_id: intent.merchant_id,
          sku: intent.sku,
          idempotency_key: intent.id,
        },
      };
  }
}
