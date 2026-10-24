export const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

export type StableAssetNetwork = "testnet" | "devnet";

export type StableAssetConfiguration = {
  currency: string;
  displayCurrency: string;
  issuer?: string;
};

export function toLedgerCurrencyCode(code: string): string {
  if (/^[A-Fa-f0-9]{40}$/.test(code)) return code.toUpperCase();
  if (code.length === 3 && /^[\x21-\x7E]{3}$/.test(code)) return code.toUpperCase();

  const bytes = Buffer.from(code, "utf8");
  if (bytes.length < 4 || bytes.length > 20 || /[^\x21-\x7E]/.test(code)) {
    throw new Error("INVALID_STABLE_ASSET_CURRENCY");
  }
  return bytes.toString("hex").toUpperCase().padEnd(40, "0");
}

export function resolveStableAsset(
  environment: Readonly<Record<string, string | undefined>>,
  network: StableAssetNetwork,
): StableAssetConfiguration {
  // P2.3/P2.4 explicitly require the official Testnet RLUSD asset. Ops also
  // publishes tUSD fixtures for its own books, but accepting those variables
  // here would silently turn the RLUSD acceptance path into a different asset.
  if (network === "testnet") {
    return {
      currency: toLedgerCurrencyCode("RLUSD"),
      displayCurrency: "RLUSD",
      issuer: TESTNET_RLUSD_ISSUER,
    };
  }

  const suffix = network.toUpperCase();
  const displayCurrency =
    environment[`STABLE_CODE_${suffix}`]?.trim() ||
    environment.STABLE_CODE?.trim() ||
    "RLUSD";
  const issuer =
    environment[`STABLE_ISSUER_${suffix}`]?.trim() ||
    undefined;
  return {
    currency: toLedgerCurrencyCode(displayCurrency),
    displayCurrency,
    issuer,
  };
}
