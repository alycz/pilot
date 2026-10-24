import type { Asset } from "@pilot/contracts";

import { TESTNET_RLUSD_ISSUER } from "../../lib/stable-asset";

import type { LedgerNetwork } from "./ledger-client";

/**
 * Markets read live from the XRP Ledger. Only issuers with a published,
 * citable source are listed here.
 */

/**
 * Ripple USD (RLUSD). Mainnet issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De and
 * Testnet issuer rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV, per
 * https://docs.ripple.com/stablecoin/developer-resources/rlusd-on-the-xrpl
 * Currency code is the 160-bit hex encoding of "RLUSD".
 */
export const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
export const RLUSD_MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

/**
 * Circle USDC. Mainnet issuer rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE with currency
 * 5553444300000000000000000000000000000000, per
 * https://www.circle.com/blog/now-available-usdc-on-the-xrpl
 */
export const USDC_CURRENCY = "5553444300000000000000000000000000000000";
export const USDC_MAINNET_ISSUER = "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE";

export const XRP_ASSET: Asset = { currency: "XRP" };

export type CatalogAsset = {
  asset: Asset;
  symbol: string;
  name: string;
  /** Source URL backing the issuer address (issued assets only). */
  source?: string;
};

export type CatalogPair = {
  id: string;
  network: LedgerNetwork;
  base: CatalogAsset;
  quote: CatalogAsset;
  label: string;
  /** Trade sizes for route quotes, in base units. */
  sizes: readonly number[];
};

const XRP: CatalogAsset = { asset: XRP_ASSET, symbol: "XRP", name: "XRP" };

const RLUSD_MAINNET: CatalogAsset = {
  asset: { currency: RLUSD_CURRENCY, issuer: RLUSD_MAINNET_ISSUER },
  symbol: "RLUSD",
  name: "Ripple USD",
  source: "https://docs.ripple.com/stablecoin/developer-resources/rlusd-on-the-xrpl",
};

const RLUSD_TESTNET: CatalogAsset = {
  asset: { currency: RLUSD_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
  symbol: "RLUSD",
  name: "Ripple USD (Testnet)",
  source: "https://docs.ripple.com/stablecoin/developer-resources/rlusd-on-the-xrpl",
};

const USDC_MAINNET: CatalogAsset = {
  asset: { currency: USDC_CURRENCY, issuer: USDC_MAINNET_ISSUER },
  symbol: "USDC",
  name: "USD Coin",
  source: "https://www.circle.com/blog/now-available-usdc-on-the-xrpl",
};

const XRP_SIZES = [100, 1_000, 10_000] as const;
const STABLE_SIZES = [1_000, 10_000, 100_000] as const;

export const MARKET_CATALOG: Record<LedgerNetwork, readonly CatalogPair[]> = {
  mainnet: [
    { id: "mainnet:xrp-rlusd", network: "mainnet", base: XRP, quote: RLUSD_MAINNET, label: "XRP / RLUSD", sizes: XRP_SIZES },
    { id: "mainnet:xrp-usdc", network: "mainnet", base: XRP, quote: USDC_MAINNET, label: "XRP / USDC", sizes: XRP_SIZES },
    { id: "mainnet:rlusd-usdc", network: "mainnet", base: RLUSD_MAINNET, quote: USDC_MAINNET, label: "RLUSD / USDC", sizes: STABLE_SIZES },
  ],
  testnet: [
    { id: "testnet:xrp-rlusd", network: "testnet", base: XRP, quote: RLUSD_TESTNET, label: "XRP / RLUSD", sizes: XRP_SIZES },
  ],
};

export const NETWORK_LABELS: Record<LedgerNetwork, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
};

/** Ledger request shape for an asset (XRP has no issuer). */
export function ledgerAsset(asset: Asset): Record<string, string> {
  return asset.issuer ? { currency: asset.currency, issuer: asset.issuer } : { currency: "XRP" };
}

/** Issued assets in a pair whose issuer account we can describe. */
export function issuedAssets(pair: CatalogPair): CatalogAsset[] {
  return [pair.base, pair.quote].filter((entry) => Boolean(entry.asset.issuer));
}
