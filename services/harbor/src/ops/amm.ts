import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpDef } from "../catalog/registry";
import { NetworkSchema } from "../contracts";

const CLASSIC_ADDRESS_MESSAGE = "must be a valid XRPL classic address";
const STANDARD_CURRENCY_PATTERN = /^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/;
const HEX_CURRENCY_PATTERN = /^[A-Fa-f0-9]{40}$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, CLASSIC_ADDRESS_MESSAGE);

const IssuedCurrencySchema = z.string().refine(
  (currency) =>
    currency !== "XRP" &&
    (STANDARD_CURRENCY_PATTERN.test(currency) ||
      HEX_CURRENCY_PATTERN.test(currency)),
  "must be a 3-character issued currency code other than XRP, or 40 hex characters",
);

// Asset shapes follow the amm_info request contract: XRP has no issuer, while
// an issued asset always has one.
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info
const XrpAssetSchema = z.object({ currency: z.literal("XRP") }).strict();
const IssuedAssetSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: ClassicAddressSchema,
  })
  .strict();
const AmmAssetSchema = z.union([XrpAssetSchema, IssuedAssetSchema]);

const AmmPairSchema = z
  .object({
    network: NetworkSchema,
    asset: AmmAssetSchema,
    asset2: AmmAssetSchema,
  })
  .strict()
  .refine(
    ({ asset, asset2 }) =>
      asset.currency !== asset2.currency ||
      ("issuer" in asset &&
        "issuer" in asset2 &&
        asset.issuer !== asset2.issuer),
    { message: "asset and asset2 must identify different assets" },
  );

const AmmPositionSchema = AmmPairSchema.safeExtend({
  account: ClassicAddressSchema,
});

const IssuedAmountSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: ClassicAddressSchema,
    value: z.string().regex(DECIMAL_PATTERN),
  })
  .strict();
const CurrencyAmountSchema = z.union([
  z.string().regex(/^\d+$/),
  IssuedAmountSchema,
]);

const AmmInfoResultSchema = z
  .object({
    amm: z
      .object({
        account: ClassicAddressSchema,
        amount: CurrencyAmountSchema,
        amount2: CurrencyAmountSchema,
        lp_token: IssuedAmountSchema,
        trading_fee: z.number().int().nonnegative(),
      })
      .passthrough(),
    ledger_current_index: z.number().int().nonnegative().optional(),
    ledger_index: z.number().int().nonnegative().optional(),
    ledger_hash: z.string().optional(),
    validated: z.boolean().optional(),
  })
  .passthrough();

// XRP is represented only by { currency: "XRP" }; issued assets include both
// currency and issuer. The validated ledger is requested for deterministic
// reads. The `account` form makes lp_token the provider's balance.
// https://xrpl.org/docs/references/protocol/data-types/currency-formats#specifying-without-amounts
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info#request-format
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info#amm-description-object
export const ops: OpDef[] = [
  {
    name: "amm.info",
    family: "amm",
    summary: "Read the validated state of an XRPL automated market maker.",
    tags: ["amm", "liquidity", "pool", "lp-token"],
    args: AmmPairSchema,
    returns: "AMM reserves, LP-token supply, trading fee, and ledger metadata",
    caveats: [],
    example:
      'await harbor.amm.info({ network: "testnet", asset: { currency: "XRP" }, asset2: { currency: "USD", issuer: "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd" } })',
    handler: async (ctx, rawArgs) => {
      const { network, asset, asset2 } = rawArgs as z.infer<
        typeof AmmPairSchema
      >;
      const result = await requestXrpl(ctx, network, "amm_info", {
        asset,
        asset2,
        ledger_index: "validated",
      });
      return AmmInfoResultSchema.parse(result);
    },
  },
  {
    name: "amm.position",
    family: "amm",
    summary: "Read one account's LP-token position in an XRPL AMM.",
    tags: ["amm", "liquidity", "position", "lp-token"],
    args: AmmPositionSchema,
    returns:
      "the provider account and AMM state whose lp_token is that account's balance",
    caveats: [],
    example:
      'await harbor.amm.position({ network: "testnet", account: "rJVUeRqDFNs2xqA7ncVE6ZoAhPUoaJJSQm", asset: { currency: "XRP" }, asset2: { currency: "USD", issuer: "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd" } })',
    handler: async (ctx, rawArgs) => {
      const { network, account, asset, asset2 } = rawArgs as z.infer<
        typeof AmmPositionSchema
      >;
      const result = await requestXrpl(ctx, network, "amm_info", {
        account,
        asset,
        asset2,
        ledger_index: "validated",
      });
      return {
        account,
        ...AmmInfoResultSchema.parse(result),
      };
    },
  },
];
