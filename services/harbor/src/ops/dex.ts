import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl } from "../adapters/xrpl-rpc";
import type { OpDef } from "../catalog/registry";
import { NetworkSchema, type Network } from "../contracts";

const STANDARD_CURRENCY = /^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/;
const HEX_CURRENCY = /^[A-Fa-f0-9]{40}$/;
const DROPS = /^(?:0|[1-9][0-9]*)$/;
const TOKEN_VALUE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

const IssuedCurrencyCodeSchema = z
  .string()
  .refine(
    (currency) =>
      currency !== "XRP" &&
      (STANDARD_CURRENCY.test(currency) || HEX_CURRENCY.test(currency)),
    "issued currency must be a three-character code other than XRP or a 40-character hexadecimal code",
  );

const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");

const AssetSchema = z.union([
  z.object({ currency: z.literal("XRP") }).strict(),
  z
    .object({
      currency: IssuedCurrencyCodeSchema,
      issuer: ClassicAddressSchema,
    })
    .strict(),
]);

const PositiveAmountSchema = z.union([
  z.string().regex(DROPS, "XRP amount must be an integer drops string"),
  z
    .object({
      currency: IssuedCurrencyCodeSchema,
      issuer: ClassicAddressSchema,
      value: z
        .string()
        .regex(TOKEN_VALUE, "issued-token value must be a non-negative decimal string"),
    })
    .strict(),
]);

const PathDestinationAmountSchema = z.union([
  PositiveAmountSchema,
  z.literal("-1"),
  z
    .object({
      currency: IssuedCurrencyCodeSchema,
      issuer: ClassicAddressSchema,
      value: z.literal("-1"),
    })
    .strict(),
]);

const LedgerIndexSchema = z.literal("validated");
const BookLimitSchema = z.number().int().min(1).max(400);

type Asset = z.infer<typeof AssetSchema>;
type PositiveAmount = z.infer<typeof PositiveAmountSchema>;
type PathDestinationAmount = z.infer<typeof PathDestinationAmountSchema>;
type BookArgs = {
  network: Network;
  taker_gets: Asset;
  taker_pays: Asset;
  taker?: string;
  limit?: number;
  ledger_index?: "validated";
};
type QuoteArgs = {
  network: Network;
  source_account: string;
  destination_account: string;
  destination_amount: PathDestinationAmount;
  send_max?: PositiveAmount;
  source_currencies?: Asset[];
};

type Decimal = { coefficient: bigint; scale: number };

function parseDecimal(value: string, field: string): Decimal {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error(`book_offers response has invalid ${field}`);

  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw new Error(`book_offers response has invalid ${field}`);
  }

  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function addDecimals(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function shiftDecimal(decimal: Decimal, places: number): Decimal {
  const scale = decimal.scale - places;
  if (scale >= 0) return { coefficient: decimal.coefficient, scale };
  return {
    coefficient: decimal.coefficient * 10n ** BigInt(-scale),
    scale: 0,
  };
}

function formatDecimal(decimal: Decimal): string {
  let digits = decimal.coefficient.toString();
  if (decimal.scale === 0) return digits;
  digits = digits.padStart(decimal.scale + 1, "0");
  const split = digits.length - decimal.scale;
  const formatted = `${digits.slice(0, split)}.${digits.slice(split)}`
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return formatted || "0";
}

function requiredAmountValue(value: unknown, field: string): string {
  if (typeof value === "string") {
    parseDecimal(value, field);
    return value;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const amount = value as Record<string, unknown>;
    if (typeof amount.value === "string") {
      parseDecimal(amount.value, `${field}.value`);
      return amount.value;
    }
  }
  throw new Error(`book_offers response has invalid ${field}`);
}

function optionalLedgerFields(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const name of ["ledger_hash", "ledger_index", "ledger_current_index"]) {
    if (result[name] !== undefined) fields[name] = result[name];
  }
  return fields;
}

type DepthLevel = {
  price: string;
  quality: string;
  taker_gets: Decimal;
  taker_pays: Decimal;
  offer_count: number;
};

function normalizedPrice(quality: string, takerGets: Asset, takerPays: Asset) {
  let price = parseDecimal(quality, "quality");
  // Offer quality uses protocol units. Convert drops to XRP so price is in
  // user-facing asset units while retaining raw `quality` beside it.
  // https://xrpl.org/docs/references/protocol/data-types/currency-formats#xrp-amounts
  if (takerGets.currency === "XRP") price = shiftDecimal(price, 6);
  if (takerPays.currency === "XRP") price = shiftDecimal(price, -6);
  return formatDecimal(price);
}

function aggregateDepth(
  result: Record<string, unknown>,
  network: Network,
  takerGets: Asset,
  takerPays: Asset,
) {
  if (!Array.isArray(result.offers)) {
    throw new Error("book_offers response is missing offers");
  }

  const levels = new Map<string, DepthLevel>();
  let totalGets: Decimal = { coefficient: 0n, scale: 0 };
  let totalPays: Decimal = { coefficient: 0n, scale: 0 };

  result.offers.forEach((rawOffer, index) => {
    if (
      rawOffer === null ||
      typeof rawOffer !== "object" ||
      Array.isArray(rawOffer)
    ) {
      throw new Error(`book_offers response has invalid offers[${index}]`);
    }
    const offer = rawOffer as Record<string, unknown>;
    if (typeof offer.quality !== "string") {
      throw new Error(`book_offers response has invalid offers[${index}].quality`);
    }
    parseDecimal(offer.quality, `offers[${index}].quality`);

    // The funded fields, when present, are the maximum available amounts for
    // a partially funded offer. Otherwise the canonical offer amounts apply.
    // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
    const getsValue = requiredAmountValue(
      offer.taker_gets_funded ?? offer.TakerGets,
      `offers[${index}].taker_gets`,
    );
    const paysValue = requiredAmountValue(
      offer.taker_pays_funded ?? offer.TakerPays,
      `offers[${index}].taker_pays`,
    );
    const gets = parseDecimal(getsValue, `offers[${index}].taker_gets`);
    const pays = parseDecimal(paysValue, `offers[${index}].taker_pays`);

    const level = levels.get(offer.quality) ?? {
      price: normalizedPrice(offer.quality, takerGets, takerPays),
      quality: offer.quality,
      taker_gets: { coefficient: 0n, scale: 0 },
      taker_pays: { coefficient: 0n, scale: 0 },
      offer_count: 0,
    };
    level.taker_gets = addDecimals(level.taker_gets, gets);
    level.taker_pays = addDecimals(level.taker_pays, pays);
    level.offer_count += 1;
    levels.set(offer.quality, level);
    totalGets = addDecimals(totalGets, gets);
    totalPays = addDecimals(totalPays, pays);
  });

  return {
    network,
    taker_gets: takerGets,
    taker_pays: takerPays,
    ...optionalLedgerFields(result),
    levels: [...levels.values()].map((level) => ({
      price: level.price,
      quality: level.quality,
      taker_gets: formatDecimal(level.taker_gets),
      taker_pays: formatDecimal(level.taker_pays),
      offer_count: level.offer_count,
    })),
    totals: {
      taker_gets: formatDecimal(totalGets),
      taker_pays: formatDecimal(totalPays),
      offer_count: result.offers.length,
    },
  };
}

export const ops: OpDef[] = [
  {
    name: "dex.book",
    family: "dex",
    summary: "Read offers from one side of an XRPL decentralized exchange book.",
    tags: ["dex", "order-book", "offers", "spot"],
    args: z
      .object({
        network: NetworkSchema,
        taker_gets: AssetSchema,
        taker_pays: AssetSchema,
        taker: ClassicAddressSchema.optional(),
        limit: BookLimitSchema.optional(),
        ledger_index: LedgerIndexSchema.optional(),
      })
      .strict(),
    returns: "the XRPL book_offers response",
    caveats: [],
    example: 'await harbor.dex.book({ network: "testnet", taker_gets: { currency: "XRP" }, taker_pays: { currency: "USD", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B" }, ledger_index: "validated" })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as BookArgs;
      // Request and response fields follow the official command reference:
      // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
      return requestXrpl(ctx, args.network, "book_offers", {
        taker_gets: args.taker_gets,
        taker_pays: args.taker_pays,
        ledger_index: args.ledger_index ?? "validated",
        ...(args.taker === undefined ? {} : { taker: args.taker }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
    },
  },
  {
    name: "dex.quote",
    family: "dex",
    summary: "Request an indicative first-pass XRPL payment-path quote for a destination amount.",
    tags: ["dex", "quote", "path-find", "payment"],
    args: z
      .object({
        network: NetworkSchema,
        source_account: ClassicAddressSchema,
        destination_account: ClassicAddressSchema,
        destination_amount: PathDestinationAmountSchema,
        send_max: PositiveAmountSchema.optional(),
        source_currencies: z.array(AssetSchema).min(1).max(18).optional(),
      })
      .strict(),
    returns: "the initial path_find response, which may have full_reply false",
    caveats: ["unverified-match"],
    example: 'await harbor.dex.quote({ network: "testnet", source_account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59", destination_account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", destination_amount: { currency: "USD", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", value: "10" } })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as QuoteArgs;
      if (args.send_max !== undefined && args.source_currencies !== undefined) {
        throw new Error("path_find send_max is not compatible with source_currencies");
      }
      // path_find is WebSocket-only and its server-selected alternatives may
      // not be optimal, so callers must treat this as an indicative quote.
      // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/path_find
      return requestXrpl(ctx, args.network, "path_find", {
        subcommand: "create",
        source_account: args.source_account,
        destination_account: args.destination_account,
        destination_amount: args.destination_amount,
        ...(args.send_max === undefined ? {} : { send_max: args.send_max }),
        ...(args.source_currencies === undefined
          ? {}
          : { source_currencies: args.source_currencies }),
      });
    },
  },
  {
    name: "dex.depth",
    family: "dex",
    summary: "Aggregate funded XRPL order-book offers into price levels and totals.",
    tags: ["dex", "depth", "order-book", "liquidity"],
    args: z
      .object({
        network: NetworkSchema,
        taker_gets: AssetSchema,
        taker_pays: AssetSchema,
        limit: BookLimitSchema.optional(),
        ledger_index: LedgerIndexSchema.optional(),
      })
      .strict(),
    returns: "funded book levels and aggregate taker-get/taker-pay totals",
    caveats: [],
    example: 'await harbor.dex.depth({ network: "testnet", taker_gets: { currency: "XRP" }, taker_pays: { currency: "USD", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B" } })',
    handler: async (ctx, rawArgs) => {
      const args = rawArgs as BookArgs;
      const result = await requestXrpl(ctx, args.network, "book_offers", {
        taker_gets: args.taker_gets,
        taker_pays: args.taker_pays,
        ledger_index: args.ledger_index ?? "validated",
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return aggregateDepth(
        result,
        args.network,
        args.taker_gets,
        args.taker_pays,
      );
    },
  },
];
