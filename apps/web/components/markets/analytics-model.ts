import type {
  AnalyticsDepthLevel,
  AnalyticsPricePoint,
  AnalyticsSpread,
  ExecutableBookQuote,
  MarketComparison,
  PairAnalyticsSnapshot,
} from "./analytics-types";

type Decimal = { coefficient: bigint; scale: number };

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const DEFAULT_DIVISION_SCALE = 18;
const MAX_DECIMAL_DIGITS = 96;

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > MAX_DECIMAL_DIGITS) {
    throw new Error("Decimal exponent is outside the supported range.");
  }
  return 10n ** BigInt(exponent);
}

export function parseExactDecimal(value: string): Decimal {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal value: ${value}`);
  const fraction = match[3] ?? "";
  const exponent = Number.parseInt(match[4] ?? "0", 10);
  if (!Number.isSafeInteger(exponent)) throw new Error(`Invalid decimal exponent: ${value}`);
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_DECIMAL_DIGITS) throw new Error("Decimal precision exceeds the supported range.");
  let coefficient = BigInt(digits || "0");
  if (match[1] === "-") coefficient = -coefficient;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }
  return normalize({ coefficient, scale });
}

function normalize(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

export function formatExactDecimal(value: Decimal): string {
  const normalized = normalize(value);
  if (normalized.scale === 0) return normalized.coefficient.toString();
  const negative = normalized.coefficient < 0n;
  let digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  digits = digits.padStart(normalized.scale + 1, "0");
  const split = digits.length - normalized.scale;
  return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

function add(left: Decimal, right: Decimal): Decimal {
  const [a, b, scale] = align(left, right);
  return normalize({ coefficient: a + b, scale });
}

function subtract(left: Decimal, right: Decimal): Decimal {
  const [a, b, scale] = align(left, right);
  return normalize({ coefficient: a - b, scale });
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return normalize({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

function divide(left: Decimal, right: Decimal, resultScale = DEFAULT_DIVISION_SCALE): Decimal {
  if (right.coefficient === 0n) throw new Error("Cannot divide by zero.");
  const negative = (left.coefficient < 0n) !== (right.coefficient < 0n);
  const numerator = (left.coefficient < 0n ? -left.coefficient : left.coefficient) *
    powerOfTen(resultScale + right.scale);
  const denominator = (right.coefficient < 0n ? -right.coefficient : right.coefficient) *
    powerOfTen(left.scale);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return normalize({ coefficient: negative ? -quotient : quotient, scale: resultScale });
}

function compare(left: Decimal, right: Decimal): number {
  const [a, b] = align(left, right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function positive(value: string, field: string): Decimal {
  const parsed = parseExactDecimal(value);
  if (parsed.coefficient <= 0n) throw new Error(`${field} must be greater than zero.`);
  return parsed;
}

function safePositive(value: string): Decimal | null {
  try {
    return positive(value, "value");
  } catch {
    return null;
  }
}

function min(left: Decimal, right: Decimal): Decimal {
  return compare(left, right) <= 0 ? left : right;
}

function decimalBpsDifference(value: Decimal, reference: Decimal): Decimal {
  return multiply(divide(subtract(value, reference), reference), { coefficient: 10_000n, scale: 0 });
}

function bestPrice(levels: AnalyticsDepthLevel[], direction: "max" | "min"): Decimal | null {
  let best: Decimal | null = null;
  for (const level of levels) {
    const price = safePositive(level.price);
    if (!price) continue;
    if (!best || (direction === "max" ? compare(price, best) > 0 : compare(price, best) < 0)) best = price;
  }
  return best;
}

export function deriveSpread(input: {
  bids: AnalyticsDepthLevel[];
  asks: AnalyticsDepthLevel[];
}): AnalyticsSpread {
  const bid = bestPrice(input.bids, "max");
  const ask = bestPrice(input.asks, "min");
  if (!bid && !ask) {
    return { bestBid: null, bestAsk: null, midpoint: null, spread: null, spreadBps: null, condition: "empty" };
  }
  if (!bid || !ask) {
    const only = bid ?? ask!;
    return {
      bestBid: bid ? formatExactDecimal(bid) : null,
      bestAsk: ask ? formatExactDecimal(ask) : null,
      midpoint: formatExactDecimal(only),
      spread: null,
      spreadBps: null,
      condition: "one-sided",
    };
  }
  const midpoint = divide(add(bid, ask), { coefficient: 2n, scale: 0 });
  const spread = subtract(ask, bid);
  return {
    bestBid: formatExactDecimal(bid),
    bestAsk: formatExactDecimal(ask),
    midpoint: formatExactDecimal(midpoint),
    spread: formatExactDecimal(spread),
    spreadBps: formatExactDecimal(multiply(divide(spread, midpoint), { coefficient: 10_000n, scale: 0 })),
    condition: spread.coefficient < 0n ? "crossed" : "two-sided",
  };
}

export function executableBookQuote(input: {
  side: "buy" | "sell";
  requestedBase: string;
  levels: AnalyticsDepthLevel[];
  referencePrice?: string | null;
  maxLevels?: number;
}): ExecutableBookQuote {
  const requested = positive(input.requestedBase, "requestedBase");
  const maxLevels = Math.max(1, Math.min(200, Math.trunc(input.maxLevels ?? 200)));
  let remaining = requested;
  let filled: Decimal = { coefficient: 0n, scale: 0 };
  let quote: Decimal = { coefficient: 0n, scale: 0 };
  let levelsUsed = 0;

  for (const level of input.levels.slice(0, maxLevels)) {
    if (remaining.coefficient === 0n) break;
    const price = safePositive(level.price);
    const available = safePositive(level.baseSize);
    if (!price || !available) continue;
    const take = min(remaining, available);
    filled = add(filled, take);
    quote = add(quote, multiply(take, price));
    remaining = subtract(remaining, take);
    levelsUsed += 1;
  }

  const average = filled.coefficient === 0n ? null : divide(quote, filled);
  const reference = input.referencePrice ? safePositive(input.referencePrice) : null;
  let slippage: Decimal | null = null;
  if (average && reference) {
    const raw = decimalBpsDifference(average, reference);
    slippage = input.side === "sell" ? { ...raw, coefficient: -raw.coefficient } : raw;
  }
  const complete = remaining.coefficient === 0n;
  const unavailableReason = filled.coefficient === 0n
    ? "no-liquidity"
    : !complete
      ? "insufficient-depth"
      : input.referencePrice && !reference
        ? "invalid-reference"
        : undefined;

  return {
    side: input.side,
    requestedBase: formatExactDecimal(requested),
    filledBase: formatExactDecimal(filled),
    quoteAmount: formatExactDecimal(quote),
    averagePrice: average ? formatExactDecimal(average) : null,
    referencePrice: reference ? formatExactDecimal(reference) : null,
    slippageBps: slippage ? formatExactDecimal(slippage) : null,
    complete,
    levelsUsed,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

function ammPrice(snapshot: PairAnalyticsSnapshot): Decimal | null {
  if (!snapshot.amm) return null;
  const base = safePositive(snapshot.amm.baseReserve);
  const quote = safePositive(snapshot.amm.quoteReserve);
  return base && quote ? divide(quote, base) : null;
}

/**
 * Builds scanner rows only from observed values. Crossed books, stale rows and
 * implausibly divergent rows are retained but explicitly excluded.
 */
export function compareMarkets(
  snapshots: PairAnalyticsSnapshot[],
  options: { maxAbsDivergenceBps?: string } = {},
): MarketComparison[] {
  const threshold = positive(options.maxAbsDivergenceBps ?? "5000", "maxAbsDivergenceBps");
  return snapshots.map((snapshot) => {
    const spread = deriveSpread(snapshot.book);
    const mid = spread.midpoint ? parseExactDecimal(spread.midpoint) : null;
    const pool = ammPrice(snapshot);
    const divergence = mid && pool ? decimalBpsDifference(pool, mid) : null;
    const absoluteDivergence = divergence
      ? { ...divergence, coefficient: divergence.coefficient < 0n ? -divergence.coefficient : divergence.coefficient }
      : null;
    let exclusionReason: string | undefined;
    if (snapshot.meta.freshness.state === "stale") exclusionReason = "Stale observation";
    else if (spread.condition === "crossed") exclusionReason = "Crossed order book";
    else if (!mid) exclusionReason = "No two-sided midpoint";
    else if (!pool) exclusionReason = "No usable AMM reserves";
    else if (absoluteDivergence && compare(absoluteDivergence, threshold) > 0) exclusionReason = "Divergence exceeds outlier threshold";
    return {
      id: `${snapshot.meta.network}:${snapshot.pair.base.currency}:${snapshot.pair.base.issuer ?? "native"}/${snapshot.pair.quote.currency}:${snapshot.pair.quote.issuer ?? "native"}`,
      pair: snapshot.pair,
      meta: snapshot.meta,
      midpoint: mid ? formatExactDecimal(mid) : null,
      ammPrice: pool ? formatExactDecimal(pool) : null,
      divergenceBps: divergence ? formatExactDecimal(divergence) : null,
      excluded: exclusionReason !== undefined,
      ...(exclusionReason ? { exclusionReason } : {}),
    };
  });
}

/** Keeps sampled live history bounded and de-duplicates identical observations. */
export function appendHistoryPoint(
  history: AnalyticsPricePoint[],
  point: AnalyticsPricePoint,
  maxSamples = 250,
): AnalyticsPricePoint[] {
  const bound = Math.max(1, Math.min(250, Math.trunc(maxSamples)));
  positive(point.price, "history price");
  if (!Number.isFinite(Date.parse(point.observedAt))) throw new Error("History point has an invalid observation time.");
  const next = history.filter((entry) =>
    !(entry.observedAt === point.observedAt && entry.ledgerIndex === point.ledgerIndex));
  next.push(point);
  next.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  return next.slice(-bound);
}
