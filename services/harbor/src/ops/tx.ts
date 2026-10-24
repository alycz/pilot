import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpDef } from "../catalog/registry";
import { ExecutionContractSchema, type Network, type TxBuild } from "../contracts";
import {
  BuildValidationError,
  RLUSD_HEX_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  assertExecutionContractSupported,
  buildTransaction,
  checkRequireAuth,
  checkTrustLine,
  type BuildInput,
  type PreflightCheck,
} from "../exec/build";
import { assertLocalTradingTestnet } from "../local-trading";
import { isHarborDelegableTransactionType } from "../exec/delegation";

const STANDARD_CURRENCY_PATTERN = /^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/;
const HEX_CURRENCY_PATTERN = /^[A-Fa-f0-9]{40}$/;
const XRP_DROPS_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const HASH_256_PATTERN = /^[A-Fa-f0-9]{64}$/;
const NON_ZERO_HASH_256_PATTERN = /^(?!0{64}$)[A-Fa-f0-9]{64}$/;
const HEX_BLOB_PATTERN = /^(?:[A-Fa-f0-9]{2})+$/;
const UINT32_MAX = 0xffff_ffff;

const OFFER_TF_PASSIVE = 0x0001_0000;
const OFFER_TF_IMMEDIATE_OR_CANCEL = 0x0002_0000;
const OFFER_TF_FILL_OR_KILL = 0x0004_0000;
const OFFER_TF_SELL = 0x0008_0000;
const EXACT_OUTPUT_QUOTE_MAX_LEDGER_GAP = 1;
const ISSUED_LIMIT_SIGNIFICANT_DIGITS = 15;

const ExecutionNetworkSchema = z.enum([
  "testnet",
  "devnet",
  "lending-devnet",
]);
const VaultNetworkSchema = z.literal("devnet");
const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
const IssuedCurrencySchema = z.string().refine(
  (currency) =>
    currency.toUpperCase() !== "XRP" &&
    (STANDARD_CURRENCY_PATTERN.test(currency) ||
      HEX_CURRENCY_PATTERN.test(currency)),
  "issued currency must be a 3-character code other than XRP or a 40-character hexadecimal code",
);
const IntentIdSchema = z.string().trim().min(1).max(128);
const UInt32Schema = z.number().int().min(0).max(UINT32_MAX);
const PositiveUInt32Schema = z.number().int().min(1).max(UINT32_MAX);
const SwapExecutionModeSchema = z.enum([
  "immediate_or_cancel",
  "fill_or_kill",
]);
const XrpAssetSchema = z.object({ currency: z.literal("XRP") }).strict();
const IssuedAssetSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: ClassicAddressSchema,
  })
  .strict();
const AssetSchema = z.union([XrpAssetSchema, IssuedAssetSchema]);

const PositiveDropsSchema = z
  .string()
  .regex(XRP_DROPS_PATTERN, "XRP amount must be an integer drops string")
  .refine((value) => value !== "0", "XRP amount must be positive");

function validIssuedValue(value: string, allowZero: boolean): boolean {
  if (value.length > 128) return false;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return false;
  const exponentText = match[3] ?? "0";
  if (exponentText.length > 4) return false;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return false;
  const digits = `${match[1]}${match[2] ?? ""}`;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero === -1) return allowZero;
  const significant = digits.slice(firstNonZero).replace(/0+$/, "");
  if (significant.length > 16) return false;
  const magnitude =
    exponent - (match[2]?.length ?? 0) + digits.length - firstNonZero - 1;
  return magnitude >= -96 && magnitude <= 80;
}

const IssuedAmountSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: ClassicAddressSchema,
    value: z
      .string()
      .max(128)
      .regex(DECIMAL_PATTERN, "issued amount value must be a decimal string")
      .refine(
        (value) => validIssuedValue(value, false),
        "issued amount must be a positive XRPL-representable value",
      ),
  })
  .strict();
const IssuedLimitAmountSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: ClassicAddressSchema,
    value: z
      .string()
      .max(128)
      .regex(DECIMAL_PATTERN, "trust limit value must be a decimal string")
      .refine(
        (value) => validIssuedValue(value, true),
        "trust limit must be an XRPL-representable value",
      ),
  })
  .strict();
const CurrencyAmountSchema = z.union([PositiveDropsSchema, IssuedAmountSchema]);
const Hash256Schema = z.string().regex(HASH_256_PATTERN);
const NonZeroHash256Schema = z.string().regex(
  NON_ZERO_HASH_256_PATTERN,
  "must be a non-zero 64-character hexadecimal hash",
);
const HexBlobSchema = z
  .string()
  .max(2048)
  .regex(HEX_BLOB_PATTERN, "must be a non-empty, even-length hexadecimal blob");

type Asset = z.infer<typeof AssetSchema>;
type CurrencyAmount = z.infer<typeof CurrencyAmountSchema>;
type IssuedAmount = z.infer<typeof IssuedAmountSchema>;
type Rational = { numerator: bigint; denominator: bigint };

function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n) throw new RangeError("rational denominator must be positive");
  if (numerator <= 0n) throw new RangeError("rational value must be positive");
  return { numerator, denominator };
}

function parseRationalDecimal(value: string): Rational {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new TxOperationError("BOOK_MALFORMED", "decimal amount is malformed");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw new TxOperationError("BOOK_MALFORMED", "decimal exponent is invalid");
  }
  let numerator = BigInt(`${match[1]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator *= 10n ** BigInt(-exponent);
  if (numerator === 0n) {
    throw new TxOperationError("BOOK_MALFORMED", "amount must be positive");
  }
  return rational(numerator, denominator);
}

function multiply(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function divide(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function compare(left: Rational, right: Rational): number {
  const leftScaled = left.numerator * right.denominator;
  const rightScaled = right.numerator * left.denominator;
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function floorLog10(value: Rational): number {
  let exponent =
    value.numerator.toString().length - value.denominator.toString().length;
  const atLeastPower =
    exponent >= 0
      ? value.numerator >= value.denominator * 10n ** BigInt(exponent)
      : value.numerator * 10n ** BigInt(-exponent) >= value.denominator;
  if (!atLeastPower) exponent -= 1;
  return exponent;
}

function roundedInteger(
  numerator: bigint,
  denominator: bigint,
  rounding: "up" | "down",
): bigint {
  const quotient = numerator / denominator;
  return rounding === "up" && numerator % denominator !== 0n
    ? quotient + 1n
    : quotient;
}

function formatRational(
  value: Rational,
  rounding: "up" | "down",
  significantDigits = ISSUED_LIMIT_SIGNIFICANT_DIGITS,
): string {
  const scale = significantDigits - 1 - floorLog10(value);
  const numerator =
    scale >= 0
      ? value.numerator * 10n ** BigInt(scale)
      : value.numerator;
  const denominator =
    scale >= 0
      ? value.denominator
      : value.denominator * 10n ** BigInt(-scale);
  const rounded = roundedInteger(numerator, denominator, rounding);
  let digits = rounded.toString();
  if (scale <= 0) return `${digits}${"0".repeat(-scale)}`;
  digits = digits.padStart(scale + 1, "0");
  const split = digits.length - scale;
  return `${digits.slice(0, split)}.${digits.slice(split)}`
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function sameAsset(left: Asset, right: Asset): boolean {
  return (
    left.currency === right.currency &&
    (!("issuer" in left) ||
      ("issuer" in right && left.issuer === right.issuer))
  );
}

function amountAsset(amount: CurrencyAmount): Asset {
  return typeof amount === "string"
    ? { currency: "XRP" }
    : { currency: amount.currency, issuer: amount.issuer };
}

function amountMatchesAsset(amount: CurrencyAmount, asset: Asset): boolean {
  return sameAsset(amountAsset(amount), asset);
}

function equalAmounts(left: CurrencyAmount, right: CurrencyAmount): boolean {
  return (
    amountMatchesAsset(left, amountAsset(right)) &&
    compare(amountUnits(left), amountUnits(right)) === 0
  );
}

function distinctAssetPair(
  value: { asset: Asset; asset2: Asset },
  ctx: z.RefinementCtx,
): void {
  if (sameAsset(value.asset, value.asset2)) {
    ctx.addIssue({
      code: "custom",
      path: ["asset2"],
      message: "asset and asset2 must identify different assets",
    });
  }
}

function amountText(amount: CurrencyAmount): string {
  return typeof amount === "string"
    ? `${amount} drops XRP`
    : `${amount.value} ${amount.currency}.${amount.issuer}`;
}

function xrpSpendDrops(
  ...amounts: (CurrencyAmount | undefined)[]
): string {
  return amounts
    .filter((amount): amount is string => typeof amount === "string")
    .reduce((total, amount) => total + BigInt(amount), 0n)
    .toString();
}

function issuedAssets(
  ...amounts: (Asset | CurrencyAmount | undefined)[]
): Asset[] {
  const seen = new Set<string>();
  const assets: Asset[] = [];
  for (const amount of amounts) {
    if (amount === undefined || typeof amount === "string") continue;
    if (amount.currency === "XRP" || !("issuer" in amount)) continue;
    const key = `${amount.currency}:${amount.issuer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({ currency: amount.currency, issuer: amount.issuer });
  }
  return assets;
}

function txInput(
  network: Network,
  account: string,
  txJson: Record<string, unknown>,
  action: string,
  amounts: CurrencyAmount[],
  intentId: string | undefined,
  options: Partial<BuildInput> = {},
): BuildInput {
  return {
    network,
    owner: account,
    tx_json: txJson,
    action,
    amounts: amounts.map(amountText),
    intent_id: intentId,
    ...options,
  };
}

const SwapArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    sell: AssetSchema,
    buy: AssetSchema,
    amount: CurrencyAmountSchema,
    side: z.enum(["sell", "buy"]),
    max_slippage_bps: z.number().int().min(0).max(9_999),
    execution_mode: SwapExecutionModeSchema.optional(),
    intent_id: IntentIdSchema.optional(),
    execution_contract: ExecutionContractSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (sameAsset(value.sell, value.buy)) {
      ctx.addIssue({
        code: "custom",
        path: ["buy"],
        message: "sell and buy must identify different assets",
      });
    }
    const fixedAsset = value.side === "sell" ? value.sell : value.buy;
    if (!amountMatchesAsset(value.amount, fixedAsset)) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `amount must match the fixed ${value.side} asset`,
      });
    }
  });

const OfferArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    taker_gets: CurrencyAmountSchema,
    taker_pays: CurrencyAmountSchema,
    expiration: UInt32Schema.optional(),
    offer_sequence: PositiveUInt32Schema.optional(),
    flags: z
      .union([
        z.literal(0),
        z.literal(OFFER_TF_PASSIVE),
        z.literal(OFFER_TF_SELL),
        z.literal(OFFER_TF_PASSIVE | OFFER_TF_SELL),
      ])
      .optional(),
    intent_id: IntentIdSchema.optional(),
  })
  .strict()
  .refine(
    ({ taker_gets, taker_pays }) =>
      !sameAsset(amountAsset(taker_gets), amountAsset(taker_pays)),
    { path: ["taker_pays"], message: "offer assets must be different" },
  );

const OfferCancelArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    offer_sequence: PositiveUInt32Schema,
    intent_id: IntentIdSchema.optional(),
  })
  .strict();

const PaymentArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    destination: ClassicAddressSchema,
    amount: CurrencyAmountSchema,
    destination_tag: UInt32Schema.optional(),
    intent_id: IntentIdSchema.optional(),
  })
  .strict();

const EscrowCreateArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    destination: ClassicAddressSchema,
    amount: CurrencyAmountSchema,
    cancel_after: UInt32Schema.optional(),
    finish_after: UInt32Schema.optional(),
    condition: HexBlobSchema.optional(),
    destination_tag: UInt32Schema.optional(),
    intent_id: IntentIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.finish_after === undefined &&
      (value.condition === undefined || value.cancel_after === undefined)
    ) {
      ctx.addIssue({
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
      ctx.addIssue({
        code: "custom",
        path: ["cancel_after"],
        message: "cancel_after must be later than finish_after",
      });
    }
  });

const EscrowFinishArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    owner: ClassicAddressSchema,
    offer_sequence: PositiveUInt32Schema,
    condition: HexBlobSchema.optional(),
    fulfillment: HexBlobSchema.optional(),
    intent_id: IntentIdSchema.optional(),
  })
  .strict()
  .refine(
    ({ condition, fulfillment }) =>
      (condition === undefined) === (fulfillment === undefined),
    {
      path: ["fulfillment"],
      message: "condition and fulfillment must be provided together",
    },
  );

const EscrowCancelArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    owner: ClassicAddressSchema,
    offer_sequence: PositiveUInt32Schema,
    intent_id: IntentIdSchema.optional(),
  })
  .strict();

const CheckCreateArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    destination: ClassicAddressSchema,
    send_max: CurrencyAmountSchema,
    destination_tag: UInt32Schema.optional(),
    expiration: UInt32Schema.optional(),
    invoice_id: Hash256Schema.optional(),
    intent_id: IntentIdSchema.optional(),
  })
  .strict()
  .refine(({ account, destination }) => account !== destination, {
    path: ["destination"],
    message: "check destination must differ from account",
  });

const CheckCashArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    check_id: NonZeroHash256Schema,
    amount: CurrencyAmountSchema.optional(),
    deliver_min: CurrencyAmountSchema.optional(),
    intent_id: IntentIdSchema.optional(),
  })
  .strict()
  .refine(
    ({ amount, deliver_min }) =>
      (amount === undefined) !== (deliver_min === undefined),
    {
      path: ["amount"],
      message: "exactly one of amount or deliver_min is required",
    },
  );

const CheckCancelArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    check_id: NonZeroHash256Schema,
    intent_id: IntentIdSchema.optional(),
  })
  .strict();

const TRUST_FLAGS_MASK =
  0x0001_0000 |
  0x0002_0000 |
  0x0004_0000 |
  0x0010_0000 |
  0x0020_0000 |
  0x0040_0000 |
  0x0080_0000;
const TrustFlagsSchema = UInt32Schema.refine(
  (flags) =>
    (flags & ~TRUST_FLAGS_MASK) === 0 &&
    !(
      (flags & 0x0002_0000 && flags & 0x0004_0000) ||
      (flags & 0x0010_0000 && flags & 0x0020_0000) ||
      (flags & 0x0040_0000 && flags & 0x0080_0000)
    ),
  "TrustSet flags contain an unsupported bit or a set/clear conflict",
);
const TrustSetArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    limit_amount: IssuedLimitAmountSchema,
    flags: TrustFlagsSchema.optional(),
    quality_in: UInt32Schema.optional(),
    quality_out: UInt32Schema.optional(),
    intent_id: IntentIdSchema.optional(),
    execution_contract: ExecutionContractSchema.optional(),
  })
  .strict();

const AMM_DEPOSIT_FLAGS = [
  0x0001_0000,
  0x0008_0000,
  0x0010_0000,
  0x0020_0000,
  0x0040_0000,
  0x0080_0000,
] as const;
const AMM_WITHDRAW_FLAGS = [
  0x0001_0000,
  0x0002_0000,
  0x0004_0000,
  0x0008_0000,
  0x0010_0000,
  0x0020_0000,
  0x0040_0000,
] as const;

const AmmBaseSchema = z.object({
  network: ExecutionNetworkSchema,
  account: ClassicAddressSchema,
  asset: AssetSchema,
  asset2: AssetSchema,
  amount: CurrencyAmountSchema.optional(),
  amount2: CurrencyAmountSchema.optional(),
  eprice: CurrencyAmountSchema.optional(),
  intent_id: IntentIdSchema.optional(),
});

function validateAmmAmounts(
  value: {
    asset: Asset;
    asset2: Asset;
    amount?: CurrencyAmount;
    amount2?: CurrencyAmount;
  },
  ctx: z.RefinementCtx,
): void {
  distinctAssetPair(value, ctx);
  if (value.amount !== undefined && !amountMatchesAsset(value.amount, value.asset)) {
    ctx.addIssue({
      code: "custom",
      path: ["amount"],
      message: "amount must match asset",
    });
  }
  if (
    value.amount2 !== undefined &&
    !amountMatchesAsset(value.amount2, value.asset2)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["amount2"],
      message: "amount2 must match asset2",
    });
  }
}

const AmmDepositArgsSchema = AmmBaseSchema.safeExtend({
  lp_token_out: IssuedAmountSchema.optional(),
  trading_fee: z.number().int().min(0).max(1000).optional(),
  flags: z.union(AMM_DEPOSIT_FLAGS.map((flag) => z.literal(flag)) as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ]),
})
  .strict()
  .superRefine((value, ctx) => {
    validateAmmAmounts(value, ctx);
    const present = (name: "amount" | "amount2" | "eprice" | "lp_token_out") =>
      value[name] !== undefined;
    const expected: Record<number, string[]> = {
      0x0001_0000: ["lp_token_out"],
      0x0008_0000: ["amount"],
      0x0010_0000: ["amount", "amount2"],
      0x0020_0000: ["amount", "lp_token_out"],
      0x0040_0000: ["amount", "eprice"],
      0x0080_0000: ["amount", "amount2"],
    };
    const amountFields = ["amount", "amount2", "eprice", "lp_token_out"] as const;
    const required = new Set(expected[value.flags]);
    if (amountFields.some((field) => present(field) !== required.has(field))) {
      ctx.addIssue({
        code: "custom",
        path: ["flags"],
        message: "AMMDeposit flags do not match the supplied amount fields",
      });
    }
  });

const AmmWithdrawArgsSchema = AmmBaseSchema.safeExtend({
  lp_token_in: IssuedAmountSchema.optional(),
  flags: z.union(AMM_WITHDRAW_FLAGS.map((flag) => z.literal(flag)) as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ]),
})
  .strict()
  .superRefine((value, ctx) => {
    validateAmmAmounts(value, ctx);
    const present = (name: "amount" | "amount2" | "eprice" | "lp_token_in") =>
      value[name] !== undefined;
    const expected: Record<number, string[]> = {
      0x0001_0000: ["lp_token_in"],
      0x0002_0000: [],
      0x0004_0000: ["amount"],
      0x0008_0000: ["amount"],
      0x0010_0000: ["amount", "amount2"],
      0x0020_0000: ["amount", "lp_token_in"],
      0x0040_0000: ["amount", "eprice"],
    };
    const amountFields = ["amount", "amount2", "eprice", "lp_token_in"] as const;
    const required = new Set(expected[value.flags]);
    if (amountFields.some((field) => present(field) !== required.has(field))) {
      ctx.addIssue({
        code: "custom",
        path: ["flags"],
        message: "AMMWithdraw flags do not match the supplied amount fields",
      });
    }
  });

function ammDepositPreflightAssets(
  flags: number,
  asset: Asset,
  asset2: Asset,
  amount?: CurrencyAmount,
  amount2?: CurrencyAmount,
): Asset[] {
  return flags === 0x0001_0000
    ? issuedAssets(asset, asset2)
    : issuedAssets(amount, amount2);
}

function ammWithdrawPreflightAssets(
  flags: number,
  asset: Asset,
  asset2: Asset,
  amount?: CurrencyAmount,
  amount2?: CurrencyAmount,
  lpTokenIn?: IssuedAmount,
): Asset[] {
  return flags === 0x0001_0000 || flags === 0x0002_0000
    ? issuedAssets(asset, asset2, lpTokenIn)
    : issuedAssets(amount, amount2, lpTokenIn);
}

const VaultDepositArgsSchema = z
  .object({
    network: VaultNetworkSchema,
    account: ClassicAddressSchema,
    vault_id: z.string().regex(HASH_256_PATTERN),
    amount: CurrencyAmountSchema,
    intent_id: IntentIdSchema.optional(),
  })
  .strict();
const VaultWithdrawArgsSchema = VaultDepositArgsSchema.safeExtend({
  destination: ClassicAddressSchema.optional(),
  destination_tag: UInt32Schema.optional(),
})
  .strict()
  .refine(
    ({ destination, destination_tag }) =>
      destination !== undefined || destination_tag === undefined,
    {
      path: ["destination_tag"],
      message: "destination_tag requires destination",
    },
  );

const SimulatedTxSchema = z.discriminatedUnion("TransactionType", [
  z
    .object({
      TransactionType: z.literal("OfferCreate"),
      Account: ClassicAddressSchema,
      TakerGets: CurrencyAmountSchema,
      TakerPays: CurrencyAmountSchema,
      Expiration: UInt32Schema.optional(),
      OfferSequence: PositiveUInt32Schema.optional(),
      Flags: z
        .union([
          z.literal(0),
          z.literal(OFFER_TF_PASSIVE),
          z.literal(OFFER_TF_SELL),
          z.literal(OFFER_TF_PASSIVE | OFFER_TF_SELL),
          z.literal(OFFER_TF_IMMEDIATE_OR_CANCEL),
          z.literal(OFFER_TF_IMMEDIATE_OR_CANCEL | OFFER_TF_SELL),
          z.literal(OFFER_TF_FILL_OR_KILL),
          z.literal(OFFER_TF_FILL_OR_KILL | OFFER_TF_SELL),
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("OfferCancel"),
      Account: ClassicAddressSchema,
      OfferSequence: PositiveUInt32Schema,
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("Payment"),
      Account: ClassicAddressSchema,
      Destination: ClassicAddressSchema,
      Amount: CurrencyAmountSchema,
      DestinationTag: UInt32Schema.optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("EscrowCreate"),
      Account: ClassicAddressSchema,
      Destination: ClassicAddressSchema,
      Amount: CurrencyAmountSchema,
      CancelAfter: UInt32Schema.optional(),
      FinishAfter: UInt32Schema.optional(),
      Condition: HexBlobSchema.optional(),
      DestinationTag: UInt32Schema.optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("EscrowFinish"),
      Account: ClassicAddressSchema,
      Owner: ClassicAddressSchema,
      OfferSequence: PositiveUInt32Schema,
      Condition: HexBlobSchema.optional(),
      Fulfillment: HexBlobSchema.optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("EscrowCancel"),
      Account: ClassicAddressSchema,
      Owner: ClassicAddressSchema,
      OfferSequence: PositiveUInt32Schema,
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("CheckCreate"),
      Account: ClassicAddressSchema,
      Destination: ClassicAddressSchema,
      SendMax: CurrencyAmountSchema,
      DestinationTag: UInt32Schema.optional(),
      Expiration: UInt32Schema.optional(),
      InvoiceID: Hash256Schema.optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("CheckCash"),
      Account: ClassicAddressSchema,
      CheckID: NonZeroHash256Schema,
      Amount: CurrencyAmountSchema.optional(),
      DeliverMin: CurrencyAmountSchema.optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("CheckCancel"),
      Account: ClassicAddressSchema,
      CheckID: NonZeroHash256Schema,
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("TrustSet"),
      Account: ClassicAddressSchema,
      LimitAmount: IssuedLimitAmountSchema,
      Flags: TrustFlagsSchema.optional(),
      QualityIn: UInt32Schema.optional(),
      QualityOut: UInt32Schema.optional(),
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("AMMDeposit"),
      Account: ClassicAddressSchema,
      Asset: AssetSchema,
      Asset2: AssetSchema,
      Amount: CurrencyAmountSchema.optional(),
      Amount2: CurrencyAmountSchema.optional(),
      EPrice: CurrencyAmountSchema.optional(),
      LPTokenOut: IssuedAmountSchema.optional(),
      TradingFee: z.number().int().min(0).max(1000).optional(),
      Flags: UInt32Schema,
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("AMMWithdraw"),
      Account: ClassicAddressSchema,
      Asset: AssetSchema,
      Asset2: AssetSchema,
      Amount: CurrencyAmountSchema.optional(),
      Amount2: CurrencyAmountSchema.optional(),
      EPrice: CurrencyAmountSchema.optional(),
      LPTokenIn: IssuedAmountSchema.optional(),
      Flags: UInt32Schema,
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("VaultDeposit"),
      Account: ClassicAddressSchema,
      VaultID: z.string().regex(HASH_256_PATTERN),
      Amount: CurrencyAmountSchema,
    })
    .strict(),
  z
    .object({
      TransactionType: z.literal("VaultWithdraw"),
      Account: ClassicAddressSchema,
      VaultID: z.string().regex(HASH_256_PATTERN),
      Amount: CurrencyAmountSchema,
      Destination: ClassicAddressSchema.optional(),
      DestinationTag: UInt32Schema.optional(),
    })
    .strict(),
]);
const SimulateArgsSchema = z
  .object({
    network: ExecutionNetworkSchema,
    account: ClassicAddressSchema,
    tx_json: SimulatedTxSchema,
    intent_id: IntentIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.account !== value.tx_json.Account) {
      ctx.addIssue({
        code: "custom",
        path: ["tx_json", "Account"],
        message: "tx_json.Account must match account",
      });
    }
    if (
      (value.tx_json.TransactionType === "VaultDeposit" ||
        value.tx_json.TransactionType === "VaultWithdraw") &&
      value.network !== "devnet"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["network"],
        message: "vault transactions are restricted to devnet",
      });
    }
    if (value.tx_json.TransactionType === "OfferCreate") {
      if (
        sameAsset(
          amountAsset(value.tx_json.TakerGets),
          amountAsset(value.tx_json.TakerPays),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json", "TakerPays"],
          message: "offer assets must be different",
        });
      }
    }
    if (value.tx_json.TransactionType === "EscrowCreate") {
      const parsed = EscrowCreateArgsSchema.safeParse({
        network: value.network,
        account: value.account,
        destination: value.tx_json.Destination,
        amount: value.tx_json.Amount,
        cancel_after: value.tx_json.CancelAfter,
        finish_after: value.tx_json.FinishAfter,
        condition: value.tx_json.Condition,
        destination_tag: value.tx_json.DestinationTag,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json"],
          message: "EscrowCreate fields do not form a valid escrow mode",
        });
      }
    }
    if (value.tx_json.TransactionType === "EscrowFinish") {
      const parsed = EscrowFinishArgsSchema.safeParse({
        network: value.network,
        account: value.account,
        owner: value.tx_json.Owner,
        offer_sequence: value.tx_json.OfferSequence,
        condition: value.tx_json.Condition,
        fulfillment: value.tx_json.Fulfillment,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json"],
          message: "EscrowFinish condition and fulfillment must be paired",
        });
      }
    }
    if (value.tx_json.TransactionType === "CheckCreate") {
      const parsed = CheckCreateArgsSchema.safeParse({
        network: value.network,
        account: value.account,
        destination: value.tx_json.Destination,
        send_max: value.tx_json.SendMax,
        destination_tag: value.tx_json.DestinationTag,
        expiration: value.tx_json.Expiration,
        invoice_id: value.tx_json.InvoiceID,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json"],
          message: "CheckCreate fields are invalid",
        });
      }
    }
    if (value.tx_json.TransactionType === "CheckCash") {
      const parsed = CheckCashArgsSchema.safeParse({
        network: value.network,
        account: value.account,
        check_id: value.tx_json.CheckID,
        amount: value.tx_json.Amount,
        deliver_min: value.tx_json.DeliverMin,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json"],
          message: "CheckCash requires exactly one amount mode",
        });
      }
    }
    if (value.tx_json.TransactionType === "AMMDeposit") {
      const parsed = AmmDepositArgsSchema.safeParse({
        network: value.network,
        account: value.account,
        asset: value.tx_json.Asset,
        asset2: value.tx_json.Asset2,
        amount: value.tx_json.Amount,
        amount2: value.tx_json.Amount2,
        eprice: value.tx_json.EPrice,
        lp_token_out: value.tx_json.LPTokenOut,
        trading_fee: value.tx_json.TradingFee,
        flags: value.tx_json.Flags,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json"],
          message: "AMMDeposit fields do not form a valid deposit mode",
        });
      }
    }
    if (value.tx_json.TransactionType === "AMMWithdraw") {
      const parsed = AmmWithdrawArgsSchema.safeParse({
        network: value.network,
        account: value.account,
        asset: value.tx_json.Asset,
        asset2: value.tx_json.Asset2,
        amount: value.tx_json.Amount,
        amount2: value.tx_json.Amount2,
        eprice: value.tx_json.EPrice,
        lp_token_in: value.tx_json.LPTokenIn,
        flags: value.tx_json.Flags,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["tx_json"],
          message: "AMMWithdraw fields do not form a valid withdrawal mode",
        });
      }
    }
  });

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TxOperationError("BOOK_MALFORMED", "book_offers result is malformed");
  }
  return value as Record<string, unknown>;
}

function rawAmountValue(raw: unknown, asset: Asset): Rational {
  if (asset.currency === "XRP") {
    if (typeof raw !== "string" || !XRP_DROPS_PATTERN.test(raw)) {
      throw new TxOperationError("BOOK_MALFORMED", "book offer has an invalid XRP amount");
    }
    return rational(BigInt(raw), 1_000_000n);
  }
  if (!("issuer" in asset)) {
    throw new TxOperationError("BOOK_MALFORMED", "book asset is malformed");
  }
  const amount = asRecord(raw);
  if (
    amount.currency !== asset.currency ||
    amount.issuer !== asset.issuer ||
    typeof amount.value !== "string" ||
    !DECIMAL_PATTERN.test(amount.value)
  ) {
    throw new TxOperationError("BOOK_MALFORMED", "book offer has an invalid issued amount");
  }
  return parseRationalDecimal(amount.value);
}

function bestBookPrice(
  result: Record<string, unknown>,
  takerGets: Asset,
  takerPays: Asset,
): Rational {
  if (!Array.isArray(result.offers) || result.offers.length === 0) {
    throw new TxOperationError("BOOK_EMPTY", "the execution-network book has no offers");
  }
  const offer = asRecord(result.offers[0]);
  const gets = rawAmountValue(
    offer.taker_gets_funded ?? offer.TakerGets,
    takerGets,
  );
  const pays = rawAmountValue(
    offer.taker_pays_funded ?? offer.TakerPays,
    takerPays,
  );
  return divide(pays, gets);
}

function amountUnits(amount: CurrencyAmount): Rational {
  return typeof amount === "string"
    ? rational(BigInt(amount), 1_000_000n)
    : parseRationalDecimal(amount.value);
}

function amountFromUnits(
  asset: Asset,
  units: Rational,
  rounding: "up" | "down",
): CurrencyAmount {
  if (asset.currency === "XRP") {
    const drops = roundedInteger(
      units.numerator * 1_000_000n,
      units.denominator,
      rounding,
    );
    if (drops <= 0n) {
      throw new TxOperationError("INVALID_LIMIT", "calculated swap limit is below one drop");
    }
    return drops.toString();
  }
  if (!("issuer" in asset)) {
    throw new TxOperationError("INVALID_LIMIT", "swap asset is malformed");
  }
  return {
    currency: asset.currency,
    issuer: asset.issuer,
    value: formatRational(units, rounding),
  };
}

function decimalXrpToDrops(value: unknown): string {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") {
    throw new TxOperationError("BOOK_MALFORMED", "server reserve increment is malformed");
  }
  const parsed = parseRationalDecimal(raw);
  return roundedInteger(
    parsed.numerator * 1_000_000n,
    parsed.denominator,
    "up",
  ).toString();
}

async function reserveIncrementDrops(
  ctx: Parameters<typeof buildTransaction>[0],
  network: Network,
): Promise<string> {
  const result = await requestXrpl(ctx, network, "server_info");
  const info = asRecord(result.info);
  const ledger = asRecord(info.validated_ledger);
  return decimalXrpToDrops(ledger.reserve_inc_xrp);
}

async function destinationChecks(
  ctx: Parameters<typeof buildTransaction>[0],
  network: Network,
  destination: string,
  amount: CurrencyAmount,
): Promise<PreflightCheck[]> {
  if (typeof amount === "string") return [];
  const asset = { currency: amount.currency, issuer: amount.issuer };
  return Promise.all([
    checkTrustLine(ctx, network, destination, asset),
    checkRequireAuth(ctx, network, destination, asset),
  ]);
}

async function escrowFinishFeeDrops(
  ctx: Parameters<typeof buildTransaction>[0],
  network: Network,
  fulfillment: string | undefined,
): Promise<string | undefined> {
  if (fulfillment === undefined) return undefined;
  const result = await requestXrpl(ctx, network, "fee");
  const drops = asRecord(result.drops).open_ledger_fee;
  if (typeof drops !== "string" || !XRP_DROPS_PATTERN.test(drops)) {
    throw new Error("fee response has invalid drops.open_ledger_fee");
  }
  const fulfillmentBytes = BigInt(Math.ceil(fulfillment.length / 2));
  // EscrowFinish with a fulfillment costs BaseFee ×
  // (33 + Fulfillment bytes / 16), rounded up:
  // https://xrpl.org/docs/references/protocol/transactions/types/escrowfinish#transaction-cost
  const numerator = BigInt(drops) * (528n + fulfillmentBytes);
  return ((numerator + 15n) / 16n).toString();
}

export class TxOperationError extends Error {
  constructor(
    readonly code:
      | "BOOK_EMPTY"
      | "BOOK_MALFORMED"
      | "INVALID_LIMIT"
      | "QUOTE_UNAVAILABLE"
      | "QUOTE_STALE",
    message: string,
  ) {
    super(message);
    this.name = "TxOperationError";
  }
}

function executableQuoteAmount(
  value: unknown,
  asset: Asset,
  sourceAccount: string,
): CurrencyAmount | undefined {
  const parsed = CurrencyAmountSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (amountMatchesAsset(parsed.data, asset)) return parsed.data;
  if (
    "issuer" in asset &&
    typeof parsed.data !== "string" &&
    parsed.data.currency === asset.currency &&
    parsed.data.issuer === sourceAccount
  ) {
    // rippled represents an issued source_amount with the source account as
    // issuer. Only one exact source asset was requested, so restore that asset
    // after validating both the returned currency and source-account marker.
    // https://github.com/XRPLF/rippled/blob/release/3.4.x/src/xrpld/rpc/detail/PathRequest.cpp
    return { ...asset, value: parsed.data.value };
  }
  return undefined;
}

type ExactOutputQuote = {
  sourceAmount: CurrencyAmount;
  ledgerIndex: number;
};

async function quoteExactOutputSource(
  ctx: Parameters<typeof buildTransaction>[0],
  args: z.infer<typeof SwapArgsSchema>,
): Promise<ExactOutputQuote> {
  // ripple_path_find is the one-shot, validated-ledger variant of XRPL path
  // finding. Its source_amount is an account-specific exact-destination quote
  // across available paths and includes transfer fees. It is only a candidate
  // for OfferCreate: buildTransaction below still simulates the exact FOK offer
  // so Payment-only paths or a stale quote fail closed before persistence.
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/ripple_path_find
  const result = await requestXrpl(ctx, args.network, "ripple_path_find", {
    source_account: args.account,
    destination_account: args.account,
    destination_amount: args.amount,
    source_currencies: [args.sell],
    ledger_index: "validated",
  });
  if (
    result.validated !== true ||
    result.full_reply !== true ||
    typeof result.ledger_index !== "number" ||
    !Number.isSafeInteger(result.ledger_index) ||
    result.ledger_index < 1 ||
    typeof result.ledger_hash !== "string" ||
    !HASH_256_PATTERN.test(result.ledger_hash) ||
    result.source_account !== args.account ||
    result.destination_account !== args.account
  ) {
    throw new TxOperationError(
      "QUOTE_STALE",
      "exact-output quote is not bound to the requested accounts and a fully validated ledger",
    );
  }
  const echoedDestination = CurrencyAmountSchema.safeParse(
    result.destination_amount,
  );
  if (
    !echoedDestination.success ||
    !equalAmounts(echoedDestination.data, args.amount)
  ) {
    throw new TxOperationError(
      "QUOTE_STALE",
      "exact-output quote does not echo the requested destination amount",
    );
  }
  if (!Array.isArray(result.alternatives)) {
    throw new TxOperationError(
      "QUOTE_UNAVAILABLE",
      "exact-output quote response is malformed",
    );
  }
  const candidates = result.alternatives
    .map((alternative) =>
      alternative !== null &&
      typeof alternative === "object" &&
      !Array.isArray(alternative)
        ? executableQuoteAmount(
            (alternative as Record<string, unknown>).source_amount,
            args.sell,
            args.account,
          )
        : undefined,
    )
    .filter((amount): amount is CurrencyAmount => amount !== undefined);
  if (candidates.length === 0) {
    throw new TxOperationError(
      "QUOTE_UNAVAILABLE",
      "validated XRPL liquidity cannot deliver the exact output",
    );
  }
  return {
    sourceAmount: candidates.reduce((best, candidate) =>
      compare(amountUnits(candidate), amountUnits(best)) < 0 ? candidate : best,
    ),
    ledgerIndex: result.ledger_index,
  };
}

async function officialRlusdAcquisitionInvariant(
  ctx: Parameters<typeof buildTransaction>[0],
  args: z.infer<typeof SwapArgsSchema>,
): Promise<BuildInput["acquisition_balance_invariant"]> {
  if (
    args.execution_contract !== "xrpl_execution_v2" ||
    args.network !== "testnet" ||
    args.buy.currency.toUpperCase() !== RLUSD_HEX_CURRENCY ||
    !("issuer" in args.buy) ||
    args.buy.issuer !== TESTNET_RLUSD_ISSUER
  ) {
    return undefined;
  }
  const result = await requestXrpl(ctx, args.network, "account_lines", {
    account: args.account,
    peer: TESTNET_RLUSD_ISSUER,
    ledger_index: "validated",
  });
  if (
    result.validated !== true ||
    !Number.isSafeInteger(result.ledger_index) ||
    (result.ledger_index as number) < 1 ||
    !Array.isArray(result.lines)
  ) {
    throw new BuildValidationError(
      "official testnet RLUSD balance must come from a validated account_lines read",
      "INVALID_BUILD",
    );
  }
  const line = result.lines.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).account === TESTNET_RLUSD_ISSUER &&
      String((candidate as Record<string, unknown>).currency).toUpperCase() ===
        RLUSD_HEX_CURRENCY,
  ) as Record<string, unknown> | undefined;
  if (line === undefined || typeof line.balance !== "string") {
    throw new BuildValidationError(
      "official testnet RLUSD trust-line balance is missing",
      "INVALID_BUILD",
    );
  }
  return {
    kind: "issued_balance_unchanged",
    currency: RLUSD_HEX_CURRENCY,
    issuer: TESTNET_RLUSD_ISSUER,
    balance: line.balance,
    ledger_index: result.ledger_index as number,
  };
}

async function buildSwap(
  ctx: Parameters<typeof buildTransaction>[0],
  args: z.infer<typeof SwapArgsSchema>,
): Promise<TxBuild> {
  assertLocalTradingTestnet(ctx, args.network);
  assertExecutionContractSupported(ctx, args.execution_contract);
  const acquisitionBalanceInvariant =
    await officialRlusdAcquisitionInvariant(ctx, args);
  if (
    args.side === "buy" &&
    args.execution_mode === "fill_or_kill"
  ) {
    const quote = await quoteExactOutputSource(ctx, args);
    const slippageUp = rational(
      BigInt(10_000 + args.max_slippage_bps),
      10_000n,
    );
    const takerGets = amountFromUnits(
      args.sell,
      multiply(amountUnits(quote.sourceAmount), slippageUp),
      "up",
    );
    const takerPays = args.amount;
    // OfferCreate's TakerGets/TakerPays orientation and tfFillOrKill's exact
    // TakerPays behavior are defined here. Omitting tfSell is intentional.
    // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
    const txJson: Record<string, unknown> = {
      TransactionType: "OfferCreate",
      Account: args.account,
      TakerGets: takerGets,
      TakerPays: takerPays,
      Flags: OFFER_TF_FILL_OR_KILL,
    };
    return buildTransaction(
      ctx,
      txInput(
        args.network,
        args.account,
        txJson,
        "swap",
        [takerGets, takerPays],
        args.intent_id,
        {
          permissions: ["OfferCreate"],
          est_slippage_bps: args.max_slippage_bps,
          valuation_amounts: [takerGets, takerPays],
          validated_ledger_reference: {
            ledger_index: quote.ledgerIndex,
            max_ledger_gap: EXACT_OUTPUT_QUOTE_MAX_LEDGER_GAP,
          },
          require_simulation_success: true,
          execution_contract: args.execution_contract,
          acquisition_balance_invariant: acquisitionBalanceInvariant,
          preflight: {
            spendDrops: xrpSpendDrops(takerGets),
            trustLines: issuedAssets(takerGets, takerPays),
            requireAuthAssets: issuedAssets(takerGets, takerPays),
            flagConflicts: [],
          },
        },
      ),
    );
  }
  const [forwardBook, reverseBook] = await Promise.all([
    requestXrpl(ctx, args.network, "book_offers", {
      taker_gets: args.sell,
      taker_pays: args.buy,
      ledger_index: "validated",
      limit: 1,
    }),
    requestXrpl(ctx, args.network, "book_offers", {
      taker_gets: args.buy,
      taker_pays: args.sell,
      ledger_index: "validated",
      limit: 1,
    }),
  ]);
  const sellToBuy = bestBookPrice(forwardBook, args.sell, args.buy);
  const reverseSellToBuy = divide(
    rational(1n),
    bestBookPrice(reverseBook, args.buy, args.sell),
  );
  const quoteLedgers = [forwardBook.ledger_index, reverseBook.ledger_index];
  const quoteLedger = quoteLedgers.every(
    (value) => Number.isSafeInteger(value) && (value as number) > 0,
  ) && quoteLedgers[0] === quoteLedgers[1]
    ? (quoteLedgers[0] as number)
    : undefined;
  if (args.execution_contract === "xrpl_execution_v2" && quoteLedger === undefined) {
    throw new BuildValidationError(
      "v2 market-derived quotes require one exact validated ledger",
      "INVALID_BUILD",
    );
  }
  const mid = divide(add(sellToBuy, reverseSellToBuy), rational(2n));
  const slippageDown = rational(BigInt(10_000 - args.max_slippage_bps), 10_000n);

  let takerGets: CurrencyAmount;
  let takerPays: CurrencyAmount;
  if (args.side === "sell") {
    takerGets = args.amount;
    takerPays = amountFromUnits(
      args.buy,
      multiply(multiply(amountUnits(args.amount), mid), slippageDown),
      "down",
    );
  } else {
    takerPays = args.amount;
    takerGets = amountFromUnits(
      args.sell,
      divide(amountUnits(args.amount), multiply(mid, slippageDown)),
      "up",
    );
  }

  // OfferCreate's Account, TakerGets, TakerPays, and Flags fields are defined
  // at https://xrpl.org/docs/references/protocol/transactions/types/offercreate
  // (tfImmediateOrCancel, tfFillOrKill, and tfSell are documented in its
  // flags table). Exactly one execution mode is selected; omitted mode keeps
  // the existing IOC behavior.
  const executionFlag =
    args.execution_mode === "fill_or_kill"
      ? OFFER_TF_FILL_OR_KILL
      : OFFER_TF_IMMEDIATE_OR_CANCEL;
  const txJson: Record<string, unknown> = {
    TransactionType: "OfferCreate",
    Account: args.account,
    TakerGets: takerGets,
    TakerPays: takerPays,
    Flags: executionFlag | (args.side === "sell" ? OFFER_TF_SELL : 0),
  };
  return buildTransaction(
    ctx,
    txInput(
      args.network,
      args.account,
      txJson,
      "swap",
      [takerGets, takerPays],
      args.intent_id,
      {
        permissions: ["OfferCreate"],
        est_slippage_bps: args.max_slippage_bps,
        valuation_amounts: [takerGets, takerPays],
        execution_contract: args.execution_contract,
        acquisition_balance_invariant: acquisitionBalanceInvariant,
        ...(args.execution_contract === "xrpl_execution_v2" && quoteLedger !== undefined
          ? {
              validated_ledger_reference: {
                ledger_index: quoteLedger,
                max_ledger_gap: EXACT_OUTPUT_QUOTE_MAX_LEDGER_GAP,
              },
            }
          : {}),
        preflight: {
          spendDrops: xrpSpendDrops(takerGets),
          trustLines: issuedAssets(takerGets, takerPays),
          requireAuthAssets: issuedAssets(takerGets, takerPays),
          flagConflicts: [],
        },
      },
    ),
  );
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export const ops: OpDef[] = [
  {
    name: "tx.swap",
    family: "tx",
    summary: "Build and simulate an unsigned IOC swap at a book-mid limit or an exact-output FOK swap from validated executable liquidity.",
    tags: ["transaction", "dex", "swap", "unsigned"],
    args: SwapArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.swap({ network: "testnet", account: "r...", sell: { currency: "XRP" }, buy: { currency: "USD", issuer: "r..." }, amount: "1000000", side: "sell", max_slippage_bps: 100, execution_mode: "fill_or_kill" })',
    handler: (ctx, rawArgs) =>
      buildSwap(ctx, rawArgs as z.infer<typeof SwapArgsSchema>),
  },
  {
    name: "tx.offer",
    family: "tx",
    summary: "Build and simulate an unsigned XRPL limit offer.",
    tags: ["transaction", "dex", "offer", "unsigned"],
    args: OfferArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.offer({ network: "testnet", account: "r...", taker_gets: "1000000", taker_pays: { currency: "USD", issuer: "r...", value: "0.5" } })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof OfferArgsSchema>;
      const reserveDelta = await reserveIncrementDrops(ctx, args.network);
      // OfferCreate fields: https://xrpl.org/docs/references/protocol/transactions/types/offercreate
      const txJson = {
        TransactionType: "OfferCreate",
        Account: args.account,
        TakerGets: args.taker_gets,
        TakerPays: args.taker_pays,
        ...(args.expiration === undefined ? {} : { Expiration: args.expiration }),
        ...(args.offer_sequence === undefined
          ? {}
          : { OfferSequence: args.offer_sequence }),
        ...(args.flags === undefined ? {} : { Flags: args.flags }),
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "offer",
          [args.taker_gets, args.taker_pays],
          args.intent_id,
          {
            permissions: ["OfferCreate"],
            valuation_amounts: [args.taker_gets, args.taker_pays],
            reserve_delta_drops: reserveDelta,
            preflight: {
              trustLines: issuedAssets(args.taker_gets, args.taker_pays),
              requireAuthAssets: issuedAssets(args.taker_gets, args.taker_pays),
              expiresAt: args.expiration,
              flagConflicts: [],
              reserveDeltaDrops: reserveDelta,
              spendDrops: xrpSpendDrops(args.taker_gets),
            },
          },
        ),
      );
    },
  },
  {
    name: "tx.offerCancel",
    family: "tx",
    summary: "Build and simulate an unsigned offer cancellation.",
    tags: ["transaction", "dex", "cancel", "unsigned"],
    args: OfferCancelArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.offerCancel({ network: "testnet", account: "r...", offer_sequence: 7 })',
    handler: (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof OfferCancelArgsSchema>;
      // OfferCancel fields: https://xrpl.org/docs/references/protocol/transactions/types/offercancel
      const txJson = {
        TransactionType: "OfferCancel",
        Account: args.account,
        OfferSequence: args.offer_sequence,
      };
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "offer cancel", [], args.intent_id, {
          permissions: ["OfferCancel"],
        }),
      );
    },
  },
  {
    name: "tx.payment",
    family: "tx",
    summary: "Build and simulate an unsigned, always owner-signed payment.",
    tags: ["transaction", "payment", "non-delegable", "unsigned"],
    args: PaymentArgsSchema,
    returns: "a stored, unsigned non-delegable TxBuild",
    caveats: [],
    example:
      'await harbor.tx.payment({ network: "testnet", account: "r...", destination: "r...", amount: "1000000" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof PaymentArgsSchema>;
      const additional = await destinationChecks(
        ctx,
        args.network,
        args.destination,
        args.amount,
      );
      // Payment fields: https://xrpl.org/docs/references/protocol/transactions/types/payment
      const txJson = {
        TransactionType: "Payment",
        Account: args.account,
        Destination: args.destination,
        Amount: args.amount,
        ...(args.destination_tag === undefined
          ? {}
          : { DestinationTag: args.destination_tag }),
      };
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "payment", [args.amount], args.intent_id, {
          delegable: false,
          permissions: [],
          valuation_amounts: [args.amount],
          preflight: {
            spendDrops: xrpSpendDrops(args.amount),
            additional,
          },
        }),
      );
    },
  },
  {
    name: "tx.escrowCreate",
    family: "tx",
    summary: "Build and simulate an unsigned, owner-signed XRPL escrow creation.",
    tags: ["transaction", "escrow", "payment", "non-delegable", "unsigned"],
    args: EscrowCreateArgsSchema,
    returns: "a stored, unsigned non-delegable TxBuild",
    caveats: [],
    example:
      'await harbor.tx.escrowCreate({ network: "testnet", account: "r...", destination: "r...", amount: "1000000", finish_after: 900000000 })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof EscrowCreateArgsSchema>;
      const [reserveDelta, additional] = await Promise.all([
        reserveIncrementDrops(ctx, args.network),
        destinationChecks(ctx, args.network, args.destination, args.amount),
      ]);
      // EscrowCreate Amount, Destination, CancelAfter, FinishAfter, Condition,
      // and DestinationTag fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/escrowcreate
      const txJson = {
        TransactionType: "EscrowCreate",
        Account: args.account,
        Amount: args.amount,
        Destination: args.destination,
        ...(args.cancel_after === undefined
          ? {}
          : { CancelAfter: args.cancel_after }),
        ...(args.finish_after === undefined
          ? {}
          : { FinishAfter: args.finish_after }),
        ...(args.condition === undefined ? {} : { Condition: args.condition }),
        ...(args.destination_tag === undefined
          ? {}
          : { DestinationTag: args.destination_tag }),
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "escrow create",
          [args.amount],
          args.intent_id,
          {
            delegable: false,
            permissions: [],
            valuation_amounts: [args.amount],
            reserve_delta_drops: reserveDelta,
            preflight: {
              reserveDeltaDrops: reserveDelta,
              spendDrops: xrpSpendDrops(args.amount),
              trustLines: issuedAssets(args.amount),
              requireAuthAssets: issuedAssets(args.amount),
              expiresAt: args.cancel_after,
              additional,
            },
          },
        ),
      );
    },
  },
  {
    name: "tx.escrowFinish",
    family: "tx",
    summary: "Build and simulate an unsigned escrow finish.",
    tags: ["transaction", "escrow", "settlement", "unsigned"],
    args: EscrowFinishArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.escrowFinish({ network: "testnet", account: "r...", owner: "r...", offer_sequence: 7 })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof EscrowFinishArgsSchema>;
      const fee = await escrowFinishFeeDrops(
        ctx,
        args.network,
        args.fulfillment,
      );
      // EscrowFinish Owner, OfferSequence, Condition, and Fulfillment fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/escrowfinish
      const txJson = {
        TransactionType: "EscrowFinish",
        Account: args.account,
        Owner: args.owner,
        OfferSequence: args.offer_sequence,
        ...(args.condition === undefined ? {} : { Condition: args.condition }),
        ...(args.fulfillment === undefined
          ? {}
          : { Fulfillment: args.fulfillment }),
        ...(fee === undefined ? {} : { Fee: fee }),
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "escrow finish",
          [],
          args.intent_id,
          { permissions: ["EscrowFinish"] },
        ),
      );
    },
  },
  {
    name: "tx.escrowCancel",
    family: "tx",
    summary: "Build and simulate an unsigned escrow cancellation.",
    tags: ["transaction", "escrow", "cancel", "unsigned"],
    args: EscrowCancelArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.escrowCancel({ network: "testnet", account: "r...", owner: "r...", offer_sequence: 7 })',
    handler: (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof EscrowCancelArgsSchema>;
      // EscrowCancel Owner and OfferSequence fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/escrowcancel
      const txJson = {
        TransactionType: "EscrowCancel",
        Account: args.account,
        Owner: args.owner,
        OfferSequence: args.offer_sequence,
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "escrow cancel",
          [],
          args.intent_id,
          { permissions: ["EscrowCancel"] },
        ),
      );
    },
  },
  {
    name: "tx.checkCreate",
    family: "tx",
    summary: "Build and simulate an unsigned, owner-signed XRPL Check creation.",
    tags: ["transaction", "check", "payment", "non-delegable", "unsigned"],
    args: CheckCreateArgsSchema,
    returns: "a stored, unsigned non-delegable TxBuild",
    caveats: [],
    example:
      'await harbor.tx.checkCreate({ network: "testnet", account: "r...", destination: "r...", send_max: "1000000" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof CheckCreateArgsSchema>;
      const [reserveDelta, additional] = await Promise.all([
        reserveIncrementDrops(ctx, args.network),
        destinationChecks(ctx, args.network, args.destination, args.send_max),
      ]);
      // CheckCreate Destination, SendMax, DestinationTag, Expiration, and
      // InvoiceID fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/checkcreate
      const txJson = {
        TransactionType: "CheckCreate",
        Account: args.account,
        Destination: args.destination,
        SendMax: args.send_max,
        ...(args.destination_tag === undefined
          ? {}
          : { DestinationTag: args.destination_tag }),
        ...(args.expiration === undefined
          ? {}
          : { Expiration: args.expiration }),
        ...(args.invoice_id === undefined
          ? {}
          : { InvoiceID: args.invoice_id }),
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "check create",
          [args.send_max],
          args.intent_id,
          {
            delegable: false,
            permissions: [],
            valuation_amounts: [args.send_max],
            reserve_delta_drops: reserveDelta,
            preflight: {
              reserveDeltaDrops: reserveDelta,
              trustLines: issuedAssets(args.send_max),
              requireAuthAssets: issuedAssets(args.send_max),
              expiresAt: args.expiration,
              additional,
            },
          },
        ),
      );
    },
  },
  {
    name: "tx.checkCash",
    family: "tx",
    summary: "Build and simulate an unsigned XRPL Check redemption.",
    tags: ["transaction", "check", "settlement", "unsigned"],
    args: CheckCashArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.checkCash({ network: "testnet", account: "r...", check_id: "64 hex characters", amount: "1000000" })',
    handler: (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof CheckCashArgsSchema>;
      const amount = args.amount ?? args.deliver_min!;
      // CheckCash CheckID, Amount, and DeliverMin fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/checkcash
      const txJson = {
        TransactionType: "CheckCash",
        Account: args.account,
        CheckID: args.check_id,
        ...(args.amount === undefined ? {} : { Amount: args.amount }),
        ...(args.deliver_min === undefined
          ? {}
          : { DeliverMin: args.deliver_min }),
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "check cash",
          [amount],
          args.intent_id,
          {
            permissions: ["CheckCash"],
            valuation_amounts: [amount],
            preflight: {
              trustLines: issuedAssets(amount),
              requireAuthAssets: issuedAssets(amount),
            },
          },
        ),
      );
    },
  },
  {
    name: "tx.checkCancel",
    family: "tx",
    summary: "Build and simulate an unsigned XRPL Check cancellation.",
    tags: ["transaction", "check", "cancel", "unsigned"],
    args: CheckCancelArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.checkCancel({ network: "testnet", account: "r...", check_id: "64 hex characters" })',
    handler: (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof CheckCancelArgsSchema>;
      // CheckCancel CheckID field:
      // https://xrpl.org/docs/references/protocol/transactions/types/checkcancel
      const txJson = {
        TransactionType: "CheckCancel",
        Account: args.account,
        CheckID: args.check_id,
      };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          "check cancel",
          [],
          args.intent_id,
          { permissions: ["CheckCancel"] },
        ),
      );
    },
  },
  {
    name: "tx.trustSet",
    family: "tx",
    summary: "Build and simulate an unsigned trust-line update.",
    tags: ["transaction", "trust-line", "unsigned"],
    args: TrustSetArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.trustSet({ network: "testnet", account: "r...", limit_amount: { currency: "USD", issuer: "r...", value: "100" } })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof TrustSetArgsSchema>;
      assertExecutionContractSupported(ctx, args.execution_contract);
      const reserveDelta = await reserveIncrementDrops(ctx, args.network);
      // TrustSet fields: https://xrpl.org/docs/references/protocol/transactions/types/trustset
      const txJson = {
        TransactionType: "TrustSet",
        Account: args.account,
        LimitAmount: args.limit_amount,
        ...(args.flags === undefined ? {} : { Flags: args.flags }),
        ...(args.quality_in === undefined ? {} : { QualityIn: args.quality_in }),
        ...(args.quality_out === undefined
          ? {}
          : { QualityOut: args.quality_out }),
      };
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "trust set", [args.limit_amount], args.intent_id, {
          permissions: ["TrustSet"],
          execution_contract: args.execution_contract,
          reserve_delta_drops: reserveDelta,
          preflight: { reserveDeltaDrops: reserveDelta, flagConflicts: [] },
        }),
      );
    },
  },
  {
    name: "tx.ammDeposit",
    family: "tx",
    summary: "Build and simulate an unsigned AMM liquidity deposit.",
    tags: ["transaction", "amm", "liquidity", "unsigned"],
    args: AmmDepositArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.ammDeposit({ network: "testnet", account: "r...", asset: { currency: "XRP" }, asset2: { currency: "USD", issuer: "r..." }, amount: "1000000", amount2: { currency: "USD", issuer: "r...", value: "0.5" }, flags: 1048576 })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof AmmDepositArgsSchema>;
      const reserveDelta = await reserveIncrementDrops(ctx, args.network);
      // AMMDeposit fields and mode flags:
      // https://xrpl.org/docs/references/protocol/transactions/types/ammdeposit
      const txJson = {
        TransactionType: "AMMDeposit",
        Account: args.account,
        Asset: args.asset,
        Asset2: args.asset2,
        ...(args.amount === undefined ? {} : { Amount: args.amount }),
        ...(args.amount2 === undefined ? {} : { Amount2: args.amount2 }),
        ...(args.eprice === undefined ? {} : { EPrice: args.eprice }),
        ...(args.lp_token_out === undefined
          ? {}
          : { LPTokenOut: args.lp_token_out }),
        ...(args.trading_fee === undefined
          ? {}
          : { TradingFee: args.trading_fee }),
        Flags: args.flags,
      };
      const amounts = [
        args.amount,
        args.amount2,
        args.eprice,
        args.lp_token_out,
      ].filter(present);
      const preflightAssets = ammDepositPreflightAssets(
        args.flags,
        args.asset,
        args.asset2,
        args.amount,
        args.amount2,
      );
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "AMM deposit", amounts, args.intent_id, {
          permissions: ["AMMDeposit"],
          valuation_amounts: [args.amount, args.amount2].filter(present),
          reserve_delta_drops: reserveDelta,
          preflight: {
            reserveDeltaDrops: reserveDelta,
            spendDrops: xrpSpendDrops(args.amount, args.amount2),
            trustLines: preflightAssets,
            requireAuthAssets: preflightAssets,
            flagConflicts: [],
          },
        }),
      );
    },
  },
  {
    name: "tx.ammWithdraw",
    family: "tx",
    summary: "Build and simulate an unsigned AMM liquidity withdrawal.",
    tags: ["transaction", "amm", "liquidity", "unsigned"],
    args: AmmWithdrawArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.ammWithdraw({ network: "testnet", account: "r...", asset: { currency: "XRP" }, asset2: { currency: "USD", issuer: "r..." }, amount: "1000000", flags: 524288 })',
    handler: (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof AmmWithdrawArgsSchema>;
      // AMMWithdraw fields and mode flags:
      // https://xrpl.org/docs/references/protocol/transactions/types/ammwithdraw
      const txJson = {
        TransactionType: "AMMWithdraw",
        Account: args.account,
        Asset: args.asset,
        Asset2: args.asset2,
        ...(args.amount === undefined ? {} : { Amount: args.amount }),
        ...(args.amount2 === undefined ? {} : { Amount2: args.amount2 }),
        ...(args.eprice === undefined ? {} : { EPrice: args.eprice }),
        ...(args.lp_token_in === undefined ? {} : { LPTokenIn: args.lp_token_in }),
        Flags: args.flags,
      };
      const amounts = [
        args.amount,
        args.amount2,
        args.eprice,
        args.lp_token_in,
      ].filter(present);
      const preflightAssets = ammWithdrawPreflightAssets(
        args.flags,
        args.asset,
        args.asset2,
        args.amount,
        args.amount2,
        args.lp_token_in,
      );
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "AMM withdraw", amounts, args.intent_id, {
          permissions: ["AMMWithdraw"],
          valuation_amounts: [args.amount, args.amount2].filter(present),
          preflight: {
            trustLines: preflightAssets,
            requireAuthAssets: preflightAssets,
            flagConflicts: [],
          },
        }),
      );
    },
  },
  {
    name: "tx.vaultDeposit",
    family: "tx",
    summary: "Build and simulate an unsigned, owner-signed devnet vault deposit.",
    tags: ["transaction", "vault", "non-delegable", "devnet", "unsigned"],
    args: VaultDepositArgsSchema,
    returns: "a stored, unsigned non-delegable TxBuild",
    caveats: ["devnet-only"],
    example:
      'await harbor.tx.vaultDeposit({ network: "devnet", account: "r...", vault_id: "64 hex characters", amount: "1000000" })',
    handler: (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof VaultDepositArgsSchema>;
      // VaultDeposit fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/vaultdeposit
      const txJson = {
        TransactionType: "VaultDeposit",
        Account: args.account,
        VaultID: args.vault_id,
        Amount: args.amount,
      };
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "vault deposit", [args.amount], args.intent_id, {
          delegable: false,
          permissions: [],
          valuation_amounts: [args.amount],
          preflight: {
            spendDrops: xrpSpendDrops(args.amount),
            trustLines: issuedAssets(args.amount),
            requireAuthAssets: issuedAssets(args.amount),
          },
        }),
      );
    },
  },
  {
    name: "tx.vaultWithdraw",
    family: "tx",
    summary: "Build and simulate an unsigned, owner-signed devnet vault withdrawal.",
    tags: ["transaction", "vault", "non-delegable", "devnet", "unsigned"],
    args: VaultWithdrawArgsSchema,
    returns: "a stored, unsigned non-delegable TxBuild",
    caveats: ["devnet-only"],
    example:
      'await harbor.tx.vaultWithdraw({ network: "devnet", account: "r...", vault_id: "64 hex characters", amount: "1000000" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof VaultWithdrawArgsSchema>;
      const additional = await destinationChecks(
        ctx,
        args.network,
        args.destination ?? args.account,
        args.amount,
      );
      // VaultWithdraw fields:
      // https://xrpl.org/docs/references/protocol/transactions/types/vaultwithdraw
      const txJson = {
        TransactionType: "VaultWithdraw",
        Account: args.account,
        VaultID: args.vault_id,
        Amount: args.amount,
        ...(args.destination === undefined
          ? {}
          : { Destination: args.destination }),
        ...(args.destination_tag === undefined
          ? {}
          : { DestinationTag: args.destination_tag }),
      };
      return buildTransaction(
        ctx,
        txInput(args.network, args.account, txJson, "vault withdraw", [args.amount], args.intent_id, {
          delegable: false,
          permissions: [],
          valuation_amounts: [args.amount],
          preflight: {
            trustLines: issuedAssets(args.amount),
            requireAuthAssets: issuedAssets(args.amount),
            additional,
          },
        }),
      );
    },
  },
  {
    name: "tx.simulate",
    family: "tx",
    summary: "Autofill, tag, preflight, simulate, and store a supported unsigned transaction.",
    tags: ["transaction", "simulate", "unsigned"],
    args: SimulateArgsSchema,
    returns: "a stored, unsigned TxBuild",
    caveats: [],
    example:
      'await harbor.tx.simulate({ network: "testnet", account: "r...", tx_json: { TransactionType: "OfferCancel", Account: "r...", OfferSequence: 7 } })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as z.infer<typeof SimulateArgsSchema>;
      const transactionType = args.tx_json.TransactionType;
      const amounts = Object.entries(args.tx_json)
        .filter(([key]) =>
          [
            "Amount",
            "Amount2",
            "TakerGets",
            "TakerPays",
            "LimitAmount",
            "SendMax",
            "DeliverMin",
          ].includes(key),
        )
        .map(([, amount]) => amount as CurrencyAmount);
      // A TrustSet LimitAmount is a credit ceiling, not value transferred.
      // Keep it in the human-readable summary but never treat it as spend.
      const valuationAmounts =
        transactionType === "TrustSet" ? [] : amounts;
      const createsOwnerObject =
        transactionType === "TrustSet" ||
        transactionType === "AMMDeposit" ||
        transactionType === "EscrowCreate" ||
        transactionType === "CheckCreate" ||
        (transactionType === "OfferCreate" &&
          (((args.tx_json.Flags as number | undefined) ?? 0) &
            (OFFER_TF_IMMEDIATE_OR_CANCEL | OFFER_TF_FILL_OR_KILL)) ===
            0);
      const reserveDelta = createsOwnerObject
        ? await reserveIncrementDrops(ctx, args.network)
        : "0";
      const spendDrops =
        transactionType === "OfferCreate"
          ? xrpSpendDrops(args.tx_json.TakerGets)
          : transactionType === "Payment" ||
              transactionType === "VaultDeposit" ||
              transactionType === "EscrowCreate"
            ? xrpSpendDrops(args.tx_json.Amount)
            : transactionType === "AMMDeposit"
              ? xrpSpendDrops(args.tx_json.Amount, args.tx_json.Amount2)
              : "0";
      let preflightAssets = issuedAssets(...amounts);
      if (transactionType === "TrustSet" || transactionType === "OfferCancel") {
        preflightAssets = [];
      } else if (transactionType === "AMMDeposit") {
        // LPTokenOut may create the holder's LP-token line, so it must not be
        // treated as a required pre-existing trust line.
        preflightAssets = ammDepositPreflightAssets(
          args.tx_json.Flags,
          args.tx_json.Asset,
          args.tx_json.Asset2,
          args.tx_json.Amount,
          args.tx_json.Amount2,
        );
      } else if (transactionType === "AMMWithdraw") {
        preflightAssets = ammWithdrawPreflightAssets(
          args.tx_json.Flags,
          args.tx_json.Asset,
          args.tx_json.Asset2,
          args.tx_json.Amount,
          args.tx_json.Amount2,
          args.tx_json.LPTokenIn,
        );
      }
      let additional: PreflightCheck[] = [];
      if (transactionType === "Payment") {
        additional = await destinationChecks(
          ctx,
          args.network,
          args.tx_json.Destination,
          args.tx_json.Amount,
        );
      } else if (transactionType === "EscrowCreate") {
        additional = await destinationChecks(
          ctx,
          args.network,
          args.tx_json.Destination,
          args.tx_json.Amount,
        );
      } else if (transactionType === "CheckCreate") {
        additional = await destinationChecks(
          ctx,
          args.network,
          args.tx_json.Destination,
          args.tx_json.SendMax,
        );
      } else if (transactionType === "VaultWithdraw") {
        additional = await destinationChecks(
          ctx,
          args.network,
          args.tx_json.Destination ?? args.account,
          args.tx_json.Amount,
        );
      }
      const finishFee =
        transactionType === "EscrowFinish"
          ? await escrowFinishFeeDrops(
              ctx,
              args.network,
              args.tx_json.Fulfillment,
            )
          : undefined;
      const txJson =
        finishFee === undefined
          ? args.tx_json
          : { ...args.tx_json, Fee: finishFee };
      return buildTransaction(
        ctx,
        txInput(
          args.network,
          args.account,
          txJson,
          `simulate ${transactionType}`,
          amounts,
          args.intent_id,
          {
            ...(isHarborDelegableTransactionType(transactionType)
              ? {}
              : { delegable: false }),
            permissions: isHarborDelegableTransactionType(transactionType)
              ? [transactionType]
              : [],
            valuation_amounts: valuationAmounts,
            reserve_delta_drops: reserveDelta,
            preflight: {
              reserveDeltaDrops: reserveDelta,
              spendDrops,
              trustLines: preflightAssets,
              requireAuthAssets: preflightAssets,
              expiresAt:
                transactionType === "EscrowCreate"
                  ? args.tx_json.CancelAfter
                  : undefined,
              additional,
            },
          },
        ),
      );
    },
  },
];
