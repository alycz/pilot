export const FIXED_SCALE_DIGITS = 12 as const;
export const FIXED_SCALE = 10n ** BigInt(FIXED_SCALE_DIGITS);

// Bounded inputs make accidental unit mistakes fail closed while retaining far
// more range than a bounded research portfolio needs.
const MAX_WHOLE = 10n ** 18n;
const MAX_ATOMS = MAX_WHOLE * FIXED_SCALE;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export type Fixed = bigint;

export function parseFixed(input: string, label = "decimal"): Fixed {
  if (typeof input !== "string" || input.trim() !== input || !DECIMAL_PATTERN.test(input)) {
    throw new TypeError(`${label} must be a canonical nonnegative decimal string`);
  }
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > FIXED_SCALE_DIGITS) {
    throw new TypeError(`${label} exceeds ${FIXED_SCALE_DIGITS} decimal places`);
  }
  const atoms = BigInt(whole!) * FIXED_SCALE + BigInt((fraction + "0".repeat(FIXED_SCALE_DIGITS)).slice(0, FIXED_SCALE_DIGITS));
  if (atoms > MAX_ATOMS) throw new RangeError(`${label} exceeds the supported fixed-point range`);
  return atoms;
}
export function formatFixed(value: Fixed): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / FIXED_SCALE;
  const fraction = (absolute % FIXED_SCALE).toString().padStart(FIXED_SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function multiplyFloor(left: Fixed, right: Fixed): Fixed {
  return (left * right) / FIXED_SCALE;
}

export function divideFloor(numerator: Fixed, denominator: Fixed): Fixed {
  if (denominator <= 0n) throw new RangeError("fixed-point divisor must be positive");
  return (numerator * FIXED_SCALE) / denominator;
}

export function bpsFloor(value: Fixed, bps: number): Fixed {
  return (value * BigInt(bps)) / 10_000n;
}

export function bpsCeil(value: Fixed, bps: number): Fixed {
  if (value === 0n || bps === 0) return 0n;
  return (value * BigInt(bps) + 9_999n) / 10_000n;
}

export function minFixed(...values: readonly Fixed[]): Fixed {
  if (values.length === 0) throw new TypeError("minFixed requires at least one value");
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}

export function ratioBps(numerator: Fixed, denominator: Fixed): number {
  if (denominator <= 0n) throw new RangeError("ratio denominator must be positive");
  // Hundredths of a basis point, rounded half-up.
  const scaledNumerator = numerator * 1_000_000n;
  const scaled = (scaledNumerator + (scaledNumerator < 0n ? -(denominator / 2n) : denominator / 2n)) / denominator;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("ratio exceeds the supported metric range");
  }
  return Number(scaled) / 100;
}
