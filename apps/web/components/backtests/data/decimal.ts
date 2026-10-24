const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export const MAX_DECIMAL_DIGITS = 30;
export const MAX_DECIMAL_SCALE = 18;

export function isCanonicalDecimal(value: string): boolean {
  if (!DECIMAL_PATTERN.test(value) || value.length > MAX_DECIMAL_DIGITS + 1) return false;
  const [whole, fraction = ""] = value.split(".");
  return whole!.length + fraction.length <= MAX_DECIMAL_DIGITS;
}

export function canonicalDecimal(value: string): string {
  if (!isCanonicalDecimal(value)) throw new TypeError("decimal must be a nonnegative canonical string with at most 18 fractional digits");
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole!;
}

type DecimalParts = Readonly<{ coefficient: bigint; scale: number }>;

function parts(value: string): DecimalParts {
  const canonical = canonicalDecimal(value);
  const [whole, fraction = ""] = canonical.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

export function compareDecimals(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  const leftCoefficient = a.coefficient * 10n ** BigInt(scale - a.scale);
  const rightCoefficient = b.coefficient * 10n ** BigInt(scale - b.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function positiveDecimal(value: string): boolean {
  return isCanonicalDecimal(value) && compareDecimals(value, "0") > 0;
}
