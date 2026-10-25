export const KRAKEN_XRP_USD_DAILY_SOURCE_ID = "kraken.xrp-usd.spot.daily.v1" as const;

export type TrustedDailyBarSource = Readonly<{
  id: string;
  provider: string;
  providerDisplayName: string;
  apiReference: string;
  metadataEndpoint: string;
  dataEndpoint: string;
  requestedPair: string;
  providerResultKey: string;
  providerAltName: string;
  providerWebsocketName: string;
  providerBaseCode: string;
  providerQuoteCode: string;
  baseSymbol: string;
  quoteSymbol: string;
  intervalMinutes: 1440;
  intervalSeconds: 86400;
  maximumRecentBars: 720;
  authentication: "none";
  accessCost: "free-public-endpoint";
  priceCapability: "market-level-spot-ohlc";
  liquidityCapability: "not-executable-venue-liquidity";
  redistribution: "rights-review-required-before-publication";
}>;

const SOURCES = {
  [KRAKEN_XRP_USD_DAILY_SOURCE_ID]: Object.freeze({
    id: KRAKEN_XRP_USD_DAILY_SOURCE_ID,
    provider: "kraken",
    providerDisplayName: "Kraken",
    apiReference: "https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/",
    metadataEndpoint: "https://api.kraken.com/0/public/AssetPairs?pair=XRPUSD&assetVersion=1",
    dataEndpoint: "https://api.kraken.com/0/public/OHLC",
    requestedPair: "XRPUSD",
    providerResultKey: "XRP/USD",
    providerAltName: "XRPUSD",
    providerWebsocketName: "XRP/USD",
    providerBaseCode: "XRP",
    providerQuoteCode: "USD",
    baseSymbol: "XRP",
    quoteSymbol: "USD",
    intervalMinutes: 1440,
    intervalSeconds: 86_400,
    maximumRecentBars: 720,
    authentication: "none",
    accessCost: "free-public-endpoint",
    priceCapability: "market-level-spot-ohlc",
    liquidityCapability: "not-executable-venue-liquidity",
    redistribution: "rights-review-required-before-publication",
  } satisfies TrustedDailyBarSource),
} as const;

export type TrustedDailyBarSourceId = keyof typeof SOURCES;

export function trustedDailyBarSource(id: TrustedDailyBarSourceId): TrustedDailyBarSource {
  return SOURCES[id];
}

export function isTrustedDailyBarSourceId(value: string): value is TrustedDailyBarSourceId {
  return Object.hasOwn(SOURCES, value);
}
