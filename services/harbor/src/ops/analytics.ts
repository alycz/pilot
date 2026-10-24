import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { requestXrpl, XrplRpcError } from "../adapters/xrpl-rpc";
import type { OpContext, OpDef } from "../catalog/registry";
import { NetworkSchema, type Network } from "../contracts";

const STANDARD_CURRENCY = /^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/;
const HEX_CURRENCY = /^[A-Fa-f0-9]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const MAX_DECIMAL_CHARACTERS = 96;
const MAX_DECIMAL_DIGITS = 80;
const MAX_DECIMAL_EXPONENT = 96;
const OUTPUT_DECIMALS = 18;

function isPositiveDecimal(value: string): boolean {
  try {
    return parseDecimal(value, "amount").numerator > 0n;
  } catch {
    return false;
  }
}

const IssuedCurrencySchema = z.string().refine(
  (currency) =>
    currency !== "XRP" &&
    (STANDARD_CURRENCY.test(currency) || HEX_CURRENCY.test(currency)),
  "issued currency must be a three-character code other than XRP or a 40-character hexadecimal code",
);

const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");

const XrpAssetSchema = z.object({ currency: z.literal("XRP") }).strict();
const IssuedAssetSchema = z
  .object({
    currency: IssuedCurrencySchema,
    issuer: ClassicAddressSchema,
  })
  .strict();
const AssetSchema = z.union([XrpAssetSchema, IssuedAssetSchema]);

const PairSchema = z
  .object({ base: AssetSchema, quote: AssetSchema })
  .strict()
  .refine(({ base, quote }) => assetKey(base) !== assetKey(quote), {
    message: "base and quote must identify different assets",
  });

const PositiveDecimalSchema = z
  .string()
  .min(1)
  .max(MAX_DECIMAL_CHARACTERS)
  .regex(DECIMAL, "must be a non-negative decimal string")
  .refine(isPositiveDecimal, {
    message: "must be greater than zero",
  });

const MarketSnapshotArgsSchema = z
  .object({
    network: NetworkSchema,
    pair: PairSchema,
    depth_limit: z.number().int().min(1).max(100).optional(),
    sample_base_amounts: z
      .array(PositiveDecimalSchema)
      .min(1)
      .max(5)
      .optional(),
  })
  .strict();

type Asset = z.infer<typeof AssetSchema>;
type SnapshotArgs = z.infer<typeof MarketSnapshotArgsSchema>;
type Rational = { numerator: bigint; denominator: bigint };
type ReadStatus = "available" | "empty" | "unavailable" | "error";
type BookSide = "bid" | "ask";

type BookLevel = {
  price: string;
  base_size: string;
  quote_size: string;
  offer_count: number;
  cumulative_base_size: string;
};

type InternalBookLevel = BookLevel & {
  priceRatio: Rational;
  baseSizeRatio: Rational;
  quoteSizeRatio: Rational;
};

function assetKey(asset: Asset): string {
  return "issuer" in asset
    ? `${canonicalCurrency(asset.currency)}:${asset.issuer}`
    : "XRP";
}

function canonicalCurrency(currency: string): string {
  return HEX_CURRENCY.test(currency) ? currency.toUpperCase() : currency;
}

function normalizedAsset(asset: Asset) {
  return "issuer" in asset
    ? {
        kind: "issued" as const,
        currency: canonicalCurrency(asset.currency),
        issuer: asset.issuer,
      }
    : { kind: "native" as const, currency: "XRP", issuer: null };
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1n;
}

function ratio(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new Error("division by zero");
  const sign = denominator < 0n ? -1n : 1n;
  const common = gcd(numerator, denominator);
  return {
    numerator: (numerator / common) * sign,
    denominator: (denominator / common) * sign,
  };
}

function add(left: Rational, right: Rational): Rational {
  return ratio(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: Rational, right: Rational): Rational {
  return ratio(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left: Rational, right: Rational): Rational {
  return ratio(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function divide(left: Rational, right: Rational): Rational {
  return ratio(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

function compare(left: Rational, right: Rational): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function minimum(left: Rational, right: Rational): Rational {
  return compare(left, right) <= 0 ? left : right;
}

function parseDecimal(value: string, field: string): Rational {
  if (value.length > MAX_DECIMAL_CHARACTERS) {
    throw new Error(`${field} exceeds the decimal length limit`);
  }
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error(`${field} is not a decimal string`);

  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`;
  if (digits.length > MAX_DECIMAL_DIGITS) {
    throw new Error(`${field} exceeds the decimal precision limit`);
  }
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) {
    throw new Error(`${field} has an unsupported exponent`);
  }

  const scale = fraction.length - exponent;
  if (scale <= 0) {
    return ratio(BigInt(digits) * 10n ** BigInt(-scale));
  }
  return ratio(BigInt(digits), 10n ** BigInt(scale));
}

function formatRational(value: Rational, places = OUTPUT_DECIMALS): string {
  if (value.numerator === 0n) return "0";
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const integer = numerator / value.denominator;
  let remainder = numerator % value.denominator;
  let fraction = "";
  for (let index = 0; index < places && remainder !== 0n; index += 1) {
    remainder *= 10n;
    fraction += (remainder / value.denominator).toString();
    remainder %= value.denominator;
  }
  // Preserve nonzero XRPL token amounts below the fixed-decimal display
  // window. Scientific notation stays bounded while avoiding a false zero.
  if (integer === 0n && !/[1-9]/.test(fraction)) {
    let scientificRemainder = numerator;
    let exponent = 0;
    while (scientificRemainder < value.denominator) {
      scientificRemainder *= 10n;
      exponent -= 1;
    }
    let significant = (scientificRemainder / value.denominator).toString();
    scientificRemainder %= value.denominator;
    for (
      let index = 1;
      index < places && scientificRemainder !== 0n;
      index += 1
    ) {
      scientificRemainder *= 10n;
      significant += (scientificRemainder / value.denominator).toString();
      scientificRemainder %= value.denominator;
    }
    significant = significant.replace(/0+$/, "");
    const mantissa =
      significant.length > 1
        ? `${significant[0]}.${significant.slice(1)}`
        : significant;
    return `${negative ? "-" : ""}${mantissa}e${exponent}`;
  }
  const formatted = fraction ? `${integer}.${fraction}` : integer.toString();
  return negative ? `-${formatted}` : formatted;
}

function requiredRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseIssuedLedgerAmount(value: string, field: string): Rational {
  const parsed = parseDecimal(value, field);
  if (parsed.numerator === 0n) return parsed;

  const match = /^(\d+)(?:\.(\d+))?(?:[eE][+-]?\d+)?$/.exec(value);
  const significantDigits = `${match?.[1] ?? ""}${match?.[2] ?? ""}`
    .replace(/^0+/, "")
    .replace(/0+$/, "");
  // XRPL tokens have at most 16 significant digits, with the documented
  // nonzero magnitude range 1000000000000000e-96..9999999999999999e80.
  // https://xrpl.org/docs/references/protocol/data-types/currency-formats#token-precision
  if (significantDigits.length > 16) {
    throw new Error(`${field} exceeds XRPL token precision`);
  }
  const minimum = parseDecimal("1000000000000000e-96", "XRPL minimum");
  const maximum = parseDecimal("9999999999999999e80", "XRPL maximum");
  if (compare(parsed, minimum) < 0 || compare(parsed, maximum) > 0) {
    throw new Error(`${field} exceeds the XRPL token magnitude range`);
  }
  return parsed;
}

function amountForAsset(
  value: unknown,
  asset: Asset,
  field: string,
): Rational {
  if (!("issuer" in asset)) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new Error(`${field} is not an XRP drops amount`);
    }
    // The total XRP supply cannot exceed 10^17 drops.
    // https://xrpl.org/docs/references/protocol/data-types/currency-formats#xrp-amounts
    if (value.length > 18 || BigInt(value) > 100_000_000_000_000_000n) {
      throw new Error(`${field} exceeds the XRP drops range`);
    }
    return divide(parseDecimal(value, field), ratio(1_000_000n));
  }

  const record = requiredRecord(value);
  if (
    !record ||
    typeof record.currency !== "string" ||
    canonicalCurrency(record.currency) !== canonicalCurrency(asset.currency) ||
    record.issuer !== asset.issuer ||
    typeof record.value !== "string"
  ) {
    throw new Error(`${field} does not match the requested issued asset`);
  }
  return parseIssuedLedgerAmount(record.value, `${field}.value`);
}

function ledgerIndex(result: Record<string, unknown>): number | null {
  for (const field of ["ledger_index", "ledger_current_index"]) {
    const value = result[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function offerAmount(
  offer: Record<string, unknown>,
  fundedField: "taker_gets_funded" | "taker_pays_funded",
  nominalField: "TakerGets" | "TakerPays",
): unknown {
  return offer[fundedField] ?? offer[nominalField];
}

function bookLevels(
  result: Record<string, unknown>,
  side: BookSide,
  base: Asset,
  quote: Asset,
): {
  levels: InternalBookLevel[];
  invalidOffers: number;
  rawOfferCount: number;
} {
  if (!Array.isArray(result.offers)) {
    throw new Error("book_offers response is missing offers");
  }

  const rows: Array<{
    price: Rational;
    base: Rational;
    quote: Rational;
  }> = [];
  let invalidOffers = 0;
  for (const candidate of result.offers) {
    const offer = requiredRecord(candidate);
    if (!offer) {
      invalidOffers += 1;
      continue;
    }
    try {
      const getsAsset = side === "ask" ? base : quote;
      const paysAsset = side === "ask" ? quote : base;
      const gets = amountForAsset(
        offerAmount(offer, "taker_gets_funded", "TakerGets"),
        getsAsset,
        "offer.taker_gets",
      );
      const pays = amountForAsset(
        offerAmount(offer, "taker_pays_funded", "TakerPays"),
        paysAsset,
        "offer.taker_pays",
      );
      const baseSize = side === "ask" ? gets : pays;
      const quoteSize = side === "ask" ? pays : gets;
      if (baseSize.numerator <= 0n || quoteSize.numerator <= 0n) {
        invalidOffers += 1;
        continue;
      }
      rows.push({
        price: divide(quoteSize, baseSize),
        base: baseSize,
        quote: quoteSize,
      });
    } catch {
      invalidOffers += 1;
    }
  }

  rows.sort((left, right) => {
    const order = compare(left.price, right.price);
    return side === "ask" ? order : -order;
  });

  let cumulative = ratio(0n);
  const levels: InternalBookLevel[] = [];
  for (const row of rows) {
    const previous = levels.at(-1);
    if (previous && compare(previous.priceRatio, row.price) === 0) {
      previous.baseSizeRatio = add(previous.baseSizeRatio, row.base);
      previous.quoteSizeRatio = add(previous.quoteSizeRatio, row.quote);
      previous.base_size = formatRational(previous.baseSizeRatio);
      previous.quote_size = formatRational(previous.quoteSizeRatio);
      previous.offer_count += 1;
      cumulative = add(cumulative, row.base);
      previous.cumulative_base_size = formatRational(cumulative);
      continue;
    }
    cumulative = add(cumulative, row.base);
    levels.push({
      price: formatRational(row.price),
      base_size: formatRational(row.base),
      quote_size: formatRational(row.quote),
      offer_count: 1,
      cumulative_base_size: formatRational(cumulative),
      priceRatio: row.price,
      baseSizeRatio: row.base,
      quoteSizeRatio: row.quote,
    });
  }

  return { levels, invalidOffers, rawOfferCount: result.offers.length };
}

function publicLevel(level: InternalBookLevel): BookLevel {
  const { priceRatio: _price, baseSizeRatio: _base, quoteSizeRatio: _quote, ...result } =
    level;
  return result;
}

function readStatus(levels: readonly InternalBookLevel[]): ReadStatus {
  return levels.length > 0 ? "available" : "empty";
}

function bpsFromReference(value: Rational, reference: Rational): string {
  if (reference.numerator === 0n) return "0";
  return formatRational(
    multiply(divide(subtract(value, reference), reference), ratio(10_000n)),
    4,
  );
}

function executableEstimate(
  levels: readonly InternalBookLevel[],
  requestedBase: Rational,
  benchmark: Rational | null,
  direction: "sell-base" | "buy-base",
) {
  let remaining = requestedBase;
  let filled = ratio(0n);
  let quote = ratio(0n);
  let consumedLevels = 0;

  for (const level of levels) {
    if (remaining.numerator <= 0n) break;
    const take = minimum(remaining, level.baseSizeRatio);
    quote = add(quote, multiply(take, level.priceRatio));
    filled = add(filled, take);
    remaining = subtract(remaining, take);
    consumedLevels += 1;
  }

  const complete = remaining.numerator === 0n;
  const averagePrice = filled.numerator > 0n ? divide(quote, filled) : null;
  return {
    direction,
    requested_base: formatRational(requestedBase),
    filled_base: formatRational(filled),
    quote_amount: formatRational(quote),
    average_price: averagePrice ? formatRational(averagePrice) : null,
    price_impact_bps:
      averagePrice && benchmark
        ? bpsFromReference(averagePrice, benchmark)
        : null,
    benchmark: benchmark ? "book-mid" : null,
    available: complete,
    limited_by_depth: !complete,
    levels_consumed: consumedLevels,
  };
}

function summarizeAmm(
  result: Record<string, unknown>,
  base: Asset,
  quote: Asset,
) {
  const amm = requiredRecord(result.amm);
  if (!amm) throw new Error("amm_info response is missing amm");
  const first = amm.amount;
  const second = amm.amount2;

  let baseReserve: Rational;
  let quoteReserve: Rational;
  try {
    baseReserve = amountForAsset(first, base, "amm.amount");
    quoteReserve = amountForAsset(second, quote, "amm.amount2");
  } catch {
    baseReserve = amountForAsset(second, base, "amm.amount2");
    quoteReserve = amountForAsset(first, quote, "amm.amount");
  }
  if (baseReserve.numerator <= 0n || quoteReserve.numerator <= 0n) {
    throw new Error("amm_info response has non-positive reserves");
  }

  const tradingFee = amm.trading_fee;
  // XRPL AMM trading fees use 1/100,000 units and are capped at 1000 (1%).
  // Dividing by 10 converts the protocol value to basis points.
  // https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amm
  if (
    typeof tradingFee !== "number" ||
    !Number.isSafeInteger(tradingFee) ||
    tradingFee < 0 ||
    tradingFee > 1_000
  ) {
    throw new Error("amm_info response has invalid trading_fee");
  }
  if (typeof amm.account !== "string" || !isValidClassicAddress(amm.account)) {
    throw new Error("amm_info response has invalid account");
  }

  return {
    account: amm.account,
    base_reserve: formatRational(baseReserve),
    quote_reserve: formatRational(quoteReserve),
    implied_price: formatRational(divide(quoteReserve, baseReserve)),
    trading_fee_bps: formatRational(ratio(BigInt(tradingFee), 10n), 4),
    units: {
      base_reserve: `${canonicalCurrency(base.currency)} display units`,
      quote_reserve: `${canonicalCurrency(quote.currency)} display units`,
      implied_price: `${canonicalCurrency(quote.currency)} per ${canonicalCurrency(base.currency)}`,
      trading_fee_bps: "basis points",
    },
  };
}

function settledRecord(
  result: PromiseSettledResult<Record<string, unknown>>,
): Record<string, unknown> | null {
  return result.status === "fulfilled" ? result.value : null;
}

function rejectedReadStatus(
  result: PromiseSettledResult<Record<string, unknown>>,
): "unavailable" | "error" {
  return result.status === "rejected" &&
    result.reason instanceof XrplRpcError &&
    result.reason.kind === "soft-empty"
    ? "unavailable"
    : "error";
}

async function marketSnapshot(ctx: OpContext, args: SnapshotArgs) {
  const depthLimit = args.depth_limit ?? 50;
  const sampleAmounts = (args.sample_base_amounts ?? ["1", "10", "100"]).map(
    (value) => parseDecimal(value, "sample_base_amounts"),
  );
  // Each snapshot is bounded to exactly three validated-ledger reads. The two
  // book orientations follow the documented book_offers request contract:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
  // AMM state follows the documented amm_info asset-pair request contract:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info
  const [asksRead, bidsRead, ammRead] = await Promise.allSettled([
    requestXrpl(ctx, args.network, "book_offers", {
      taker_gets: args.pair.base,
      taker_pays: args.pair.quote,
      ledger_index: "validated",
      limit: depthLimit,
    }),
    requestXrpl(ctx, args.network, "book_offers", {
      taker_gets: args.pair.quote,
      taker_pays: args.pair.base,
      ledger_index: "validated",
      limit: depthLimit,
    }),
    requestXrpl(ctx, args.network, "amm_info", {
      asset: args.pair.base,
      asset2: args.pair.quote,
      ledger_index: "validated",
    }),
  ]);
  const observedAt = new Date().toISOString();

  if (
    asksRead.status === "rejected" &&
    bidsRead.status === "rejected" &&
    ammRead.status === "rejected"
  ) {
    throw new Error("market analytics unavailable: all bounded XRPL reads failed");
  }

  let asks: ReturnType<typeof bookLevels> | null = null;
  let bids: ReturnType<typeof bookLevels> | null = null;
  const partialReasons: string[] = [];
  const asksResult = settledRecord(asksRead);
  const bidsResult = settledRecord(bidsRead);
  const ammResult = settledRecord(ammRead);
  if (asksResult) {
    try {
      asks = bookLevels(asksResult, "ask", args.pair.base, args.pair.quote);
      if (asks.invalidOffers > 0) {
        partialReasons.push(`${asks.invalidOffers} malformed ask offers omitted`);
      }
    } catch {
      partialReasons.push("ask book response could not be normalized");
    }
  } else {
    partialReasons.push("ask book read failed");
  }
  if (bidsResult) {
    try {
      bids = bookLevels(bidsResult, "bid", args.pair.base, args.pair.quote);
      if (bids.invalidOffers > 0) {
        partialReasons.push(`${bids.invalidOffers} malformed bid offers omitted`);
      }
    } catch {
      partialReasons.push("bid book response could not be normalized");
    }
  } else {
    partialReasons.push("bid book read failed");
  }

  let amm: ReturnType<typeof summarizeAmm> | null = null;
  let ammAvailability: "available" | "unavailable" | "error" = "error";
  if (ammResult) {
    try {
      amm = summarizeAmm(ammResult, args.pair.base, args.pair.quote);
      ammAvailability = "available";
    } catch {
      partialReasons.push("AMM response could not be normalized");
    }
  } else {
    ammAvailability = rejectedReadStatus(ammRead);
    partialReasons.push(
      ammAvailability === "unavailable"
        ? "AMM pool is unavailable for this pair"
        : "AMM pool read failed",
    );
  }

  const bidLevels = bids?.levels ?? [];
  const askLevels = asks?.levels ?? [];
  const bestBid = bidLevels[0]?.priceRatio ?? null;
  const bestAsk = askLevels[0]?.priceRatio ?? null;
  const ledgerIndexes = {
    bids: bidsResult ? ledgerIndex(bidsResult) : null,
    asks: asksResult ? ledgerIndex(asksResult) : null,
    amm: ammResult ? ledgerIndex(ammResult) : null,
  };
  const bookLedgersAligned =
    ledgerIndexes.bids === null ||
    ledgerIndexes.asks === null ||
    ledgerIndexes.bids === ledgerIndexes.asks;
  if (!bookLedgersAligned) {
    partialReasons.push(
      "bid and ask books observed different validated ledger indexes; midpoint omitted",
    );
  }
  const mid =
    bestBid && bestAsk && bookLedgersAligned
      ? divide(add(bestBid, bestAsk), ratio(2n))
      : null;
  const spread = mid && bestBid && bestAsk ? subtract(bestAsk, bestBid) : null;
  const bookLedger = bookLedgersAligned
    ? ledgerIndexes.bids ?? ledgerIndexes.asks
    : null;

  const ledgers = Object.values(ledgerIndexes)
    .filter((value): value is number => value !== null);
  const uniqueLedgers = [...new Set(ledgers)];
  if (uniqueLedgers.length > 1) {
    partialReasons.push("upstream reads observed different validated ledger indexes");
  }
  const observedLedger = uniqueLedgers.length === 1 ? uniqueLedgers[0]! : null;

  const points = mid
    ? [
        {
          observed_at: observedAt,
          ...(bookLedger === null ? {} : { ledger_index: bookLedger }),
          price: formatRational(mid),
        },
      ]
    : [];

  return {
    network: args.network,
    pair: {
      base: normalizedAsset(args.pair.base),
      quote: normalizedAsset(args.pair.quote),
    },
    source: {
      operation: "analytics.marketSnapshot",
      providers: ["xrpl:book_offers", "xrpl:amm_info"],
      request_count: 3,
      bounded: true,
    },
    observed_at: observedAt,
    ...(observedLedger === null ? {} : { ledger_index: observedLedger }),
    ledger_indexes: ledgerIndexes,
    freshness: {
      status:
        uniqueLedgers.length > 1
          ? "mixed-ledger"
          : partialReasons.length > 0
            ? "partial-observation"
            : "live-observation",
      basis: "validated-ledger",
      age_seconds: null,
      note:
        "The endpoint did not provide a comparable wall-clock close time; observed_at is Harbor's read time.",
    },
    units: {
      base_size: `${canonicalCurrency(args.pair.base.currency)} display units`,
      quote_size: `${canonicalCurrency(args.pair.quote.currency)} display units`,
      price: `${canonicalCurrency(args.pair.quote.currency)} per ${canonicalCurrency(args.pair.base.currency)}`,
      spread_bps: "basis points",
    },
    book: {
      bids: bidLevels.map(publicLevel),
      asks: askLevels.map(publicLevel),
      limited:
        (bids?.rawOfferCount ?? 0) >= depthLimit ||
        (asks?.rawOfferCount ?? 0) >= depthLimit,
      max_levels: depthLimit,
      availability: {
        bids: bids ? readStatus(bidLevels) : "error",
        asks: asks ? readStatus(askLevels) : "error",
      },
      invalid_offer_count:
        (bids?.invalidOffers ?? 0) + (asks?.invalidOffers ?? 0),
    },
    metrics: {
      best_bid: bestBid ? formatRational(bestBid) : null,
      best_ask: bestAsk ? formatRational(bestAsk) : null,
      mid: mid ? formatRational(mid) : null,
      spread: spread ? formatRational(spread) : null,
      spread_bps:
        spread && mid
          ? formatRational(multiply(divide(spread, mid), ratio(10_000n)), 4)
          : null,
    },
    executable_liquidity: sampleAmounts.map((amount) => ({
      base_amount: formatRational(amount),
      sell_base: executableEstimate(bidLevels, amount, mid, "sell-base"),
      buy_base: executableEstimate(askLevels, amount, mid, "buy-base"),
    })),
    ...(amm ? { amm } : {}),
    availability: {
      amm: ammAvailability,
    },
    history: {
      points,
      started_at: observedAt,
      ended_at: observedAt,
      max_samples: 1,
      complete: false,
      reason:
        "This read op returns one validated live observation; Pilot may retain an explicitly bounded in-session sample history from this point forward.",
    },
    recent_trades: {
      support: "unsupported",
      rows: [],
      reason:
        "book_offers and amm_info expose current venue state, not a canonical recent-trades feed.",
    },
    partial: partialReasons.length > 0,
    partial_reasons: partialReasons,
  };
}

export const ops: OpDef[] = [
  {
    name: "analytics.marketSnapshot",
    family: "analytics",
    summary:
      "Read one bounded, normalized XRPL pair snapshot with book, AMM, spread, and executable-liquidity estimates.",
    tags: ["analytics", "market", "dex", "order-book", "amm", "slippage"],
    args: MarketSnapshotArgsSchema,
    returns:
      "a source-labelled validated-ledger pair snapshot with explicit availability, units, and freshness",
    caveats: [],
    example:
      'await harbor.analytics.marketSnapshot({ network: "testnet", pair: { base: { currency: "XRP" }, quote: { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" } }, depth_limit: 50, sample_base_amounts: ["1", "10", "100"] })',
    handler: (ctx, rawArgs) => marketSnapshot(ctx, rawArgs as SnapshotArgs),
  },
];
