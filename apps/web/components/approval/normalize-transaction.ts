/**
 * XRPL serializes non-standard issued currency codes as 160-bit hex values.
 * Harbor's readable mock fixtures use symbols such as RLUSD, so normalize a
 * transaction immediately before it is handed to a sign-only wallet.
 * https://xrpl.org/docs/references/protocol/data-types/currency-formats
 */
export function normalizeIssuedCurrencyCodes<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(normalizeIssuedCurrencyCodes) as T;
  }
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = key === "currency" && typeof child === "string"
      ? encodeCurrencyCode(child)
      : normalizeIssuedCurrencyCodes(child);
  }
  return result as T;
}

export function encodeCurrencyCode(currency: string): string {
  if (currency.length === 3 || /^[A-Fa-f0-9]{40}$/.test(currency)) return currency;
  const bytes = new TextEncoder().encode(currency);
  if (bytes.length > 20) throw new Error("Issued currency codes must fit in 20 bytes.");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(40, "0")
    .toUpperCase();
}
