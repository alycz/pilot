import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Client,
  Wallet,
  xrpToDrops,
  type AccountOffer,
  type Amount,
  type OfferCancel,
  type OfferCreate,
} from "xrpl";

export type ExecutionNetwork = "testnet" | "devnet";
export type LadderSide = "ask" | "bid";

export interface StableAsset {
  currency: string;
  issuer: string;
}

export interface SeedMetadata {
  network: ExecutionNetwork;
  marketMakerAddress: string;
  stable: StableAsset;
}

export interface LadderOffer {
  side: LadderSide;
  level: number;
  priceStablePerXrp: number;
  takerGets: Amount;
  takerPays: Amount;
}

export type ReconcileAction =
  | { kind: "create"; desired: LadderOffer }
  | { kind: "replace"; desired: LadderOffer; offerSequence: number }
  | { kind: "cancel"; offerSequence: number };

interface LoopOptions {
  network: ExecutionNetwork;
  seedFile: string;
  once: boolean;
  dryRun: boolean;
  midOverride?: number;
}

interface ExistingLadderOffer {
  side: LadderSide;
  sequence: number;
  takerGets: Amount;
  takerPays: Amount;
  priceStablePerXrp: number;
}

const DEFAULT_ENDPOINTS: Record<ExecutionNetwork, string> = {
  testnet: "wss://s.altnet.rippletest.net:51233",
  devnet: "wss://s.devnet.rippletest.net:51233",
};

const MAINNET_ENDPOINT = "wss://s1.ripple.com";
const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const LEVELS_PER_SIDE = 10;
const LEVEL_SPACING_BPS = 50;
const XRP_PER_LEVEL = 10;
const REFRESH_INTERVAL_MS = 30_000;
const EQUIVALENCE_TOLERANCE_BPS = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function normalizeCurrencyCode(code: string): string {
  const trimmed = code.trim();
  if (/^[A-Fa-f0-9]{40}$/u.test(trimmed)) return trimmed.toUpperCase();
  if (/^[A-Za-z0-9]{3}$/u.test(trimmed)) return trimmed;
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.length < 4 || bytes.length > 20) {
    throw new Error("Currency codes must be 3 characters, 4-20 UTF-8 bytes, or 40 hexadecimal digits.");
  }
  // Non-standard codes occupy the full 160-bit CurrencyCode field.
  // https://xrpl.org/docs/references/protocol/data-types/currency-formats#nonstandard-currency-codes
  return bytes.toString("hex").toUpperCase().padEnd(40, "0");
}

export function requireExecutionNetwork(value: string | undefined): ExecutionNetwork {
  const normalized = (value ?? "testnet").trim().toLowerCase();
  if (normalized === "testnet" || normalized === "devnet") return normalized;
  throw new Error(
    `Refusing network ${JSON.stringify(normalized)}: the market-maker may execute only on testnet or devnet.`,
  );
}

export function parseSeedMetadata(
  document: unknown,
  network: ExecutionNetwork,
  stableCode: string,
  configuredStableIssuer?: string,
): SeedMetadata {
  if (!isRecord(document)) throw new Error("scripts/seed.json must contain a JSON object.");

  const networkValue = document[network];
  const networksValue = isRecord(document.networks) ? document.networks[network] : undefined;
  const selected = isRecord(networkValue)
    ? networkValue
    : isRecord(networksValue)
      ? networksValue
      : document;

  const nestedMarketMaker = isRecord(selected.marketMaker) ? selected.marketMaker : undefined;
  const nestedStable = isRecord(selected.stable)
    ? selected.stable
    : isRecord(selected.stablecoin)
      ? selected.stablecoin
      : undefined;

  const marketMakerAddress =
    getString(selected, ["marketMakerAddress", "market_maker_address"]) ??
    (typeof selected.marketMaker === "string" ? selected.marketMaker : undefined) ??
    (nestedMarketMaker ? getString(nestedMarketMaker, ["address", "account"]) : undefined);
  const metadataIssuer =
    getString(selected, ["stableIssuerAddress", "stableIssuer", "stable_issuer_address"]) ??
    (nestedStable ? getString(nestedStable, ["issuer", "issuerAddress"]) : undefined);
  if (metadataIssuer && configuredStableIssuer && metadataIssuer !== configuredStableIssuer) {
    throw new Error(
      `Stablecoin issuer mismatch for ${network}: scripts/seed.json and STABLE_ISSUER_${network.toUpperCase()} disagree.`,
    );
  }
  const issuer = configuredStableIssuer ?? metadataIssuer;
  const currency = normalizeCurrencyCode(
    (nestedStable ? getString(nestedStable, ["currency", "code"]) : undefined) ?? stableCode,
  );

  if (!marketMakerAddress?.startsWith("r")) {
    throw new Error(`scripts/seed.json has no market-maker address for ${network}.`);
  }
  if (!issuer?.startsWith("r")) {
    throw new Error(`scripts/seed.json has no stablecoin issuer address for ${network}.`);
  }
  if (!currency || currency === "XRP" || currency.length > 40) {
    throw new Error(`Invalid stablecoin currency code for ${network}.`);
  }

  return { network, marketMakerAddress, stable: { currency, issuer } };
}

function issued(currency: string, issuer: string, value: number): Amount {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Offer amount must be positive.");
  return { currency, issuer, value: formatDecimal(value) };
}

function formatDecimal(value: number): string {
  // Six decimals are ample for the demo ladder and remain within issued-currency precision.
  return value.toFixed(6).replace(/\.?0+$/u, "");
}

export function buildLadder(
  midStablePerXrp: number,
  stable: StableAsset,
  options: { levels?: number; spacingBps?: number; xrpPerLevel?: number } = {},
): LadderOffer[] {
  const levels = options.levels ?? LEVELS_PER_SIDE;
  const spacingBps = options.spacingBps ?? LEVEL_SPACING_BPS;
  const xrpPerLevel = options.xrpPerLevel ?? XRP_PER_LEVEL;
  if (!Number.isFinite(midStablePerXrp) || midStablePerXrp <= 0) {
    throw new Error("The XRP/RLUSD reference mid must be a positive number.");
  }
  if (!Number.isInteger(levels) || levels < 1 || levels > 50) {
    throw new Error("Ladder levels must be an integer from 1 through 50.");
  }
  if (!Number.isFinite(spacingBps) || spacingBps <= 0 || spacingBps * levels >= 10_000) {
    throw new Error("Ladder spacing must keep every bid price positive.");
  }
  if (!Number.isFinite(xrpPerLevel) || xrpPerLevel <= 0) {
    throw new Error("XRP per ladder level must be positive.");
  }

  const drops = xrpToDrops(formatDecimal(xrpPerLevel));
  const result: LadderOffer[] = [];
  for (let level = 1; level <= levels; level += 1) {
    const offset = (spacingBps * level) / 10_000;
    const askPrice = midStablePerXrp * (1 + offset);
    const bidPrice = midStablePerXrp * (1 - offset);

    // OfferCreate TakerGets is sold and TakerPays is bought:
    // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
    result.push({
      side: "ask",
      level,
      priceStablePerXrp: askPrice,
      takerGets: drops,
      takerPays: issued(stable.currency, stable.issuer, xrpPerLevel * askPrice),
    });
    result.push({
      side: "bid",
      level,
      priceStablePerXrp: bidPrice,
      takerGets: issued(stable.currency, stable.issuer, xrpPerLevel * bidPrice),
      takerPays: drops,
    });
  }
  return result;
}

function isIssuedAmount(amount: Amount): amount is Exclude<Amount, string> {
  return typeof amount !== "string" && "currency" in amount && "issuer" in amount && "value" in amount;
}

function matchesStable(amount: Amount, stable: StableAsset): boolean {
  return isIssuedAmount(amount) && amount.currency === stable.currency && amount.issuer === stable.issuer;
}

function xrpFromDrops(amount: Amount): number | undefined {
  if (typeof amount !== "string") return undefined;
  const drops = Number(amount);
  return Number.isFinite(drops) && drops > 0 ? drops / 1_000_000 : undefined;
}

function toExistingOffer(offer: AccountOffer, stable: StableAsset): ExistingLadderOffer | undefined {
  const getsXrp = xrpFromDrops(offer.taker_gets);
  const paysXrp = xrpFromDrops(offer.taker_pays);
  if (getsXrp && isIssuedAmount(offer.taker_pays) && matchesStable(offer.taker_pays, stable)) {
    return {
      side: "ask",
      sequence: offer.seq,
      takerGets: offer.taker_gets,
      takerPays: offer.taker_pays,
      priceStablePerXrp: Number(offer.taker_pays.value) / getsXrp,
    };
  }
  if (paysXrp && isIssuedAmount(offer.taker_gets) && matchesStable(offer.taker_gets, stable)) {
    return {
      side: "bid",
      sequence: offer.seq,
      takerGets: offer.taker_gets,
      takerPays: offer.taker_pays,
      priceStablePerXrp: Number(offer.taker_gets.value) / paysXrp,
    };
  }
  return undefined;
}

function amountNumber(amount: Amount): number {
  return Number(typeof amount === "string" ? amount : amount.value);
}

function withinBps(left: number, right: number, toleranceBps: number): boolean {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    left > 0 &&
    right > 0 &&
    (Math.abs(left - right) / Math.max(left, right)) * 10_000 <= toleranceBps
  );
}

function offersEquivalent(existing: ExistingLadderOffer, desired: LadderOffer): boolean {
  return (
    existing.side === desired.side &&
    withinBps(existing.priceStablePerXrp, desired.priceStablePerXrp, EQUIVALENCE_TOLERANCE_BPS) &&
    withinBps(amountNumber(existing.takerGets), amountNumber(desired.takerGets), EQUIVALENCE_TOLERANCE_BPS) &&
    withinBps(amountNumber(existing.takerPays), amountNumber(desired.takerPays), EQUIVALENCE_TOLERANCE_BPS)
  );
}

export function planReconciliation(
  accountOffers: AccountOffer[],
  desiredOffers: LadderOffer[],
  stable: StableAsset,
): ReconcileAction[] {
  const current = accountOffers.map((offer) => toExistingOffer(offer, stable)).filter((offer) => offer !== undefined);
  const currentAsks = current.filter((offer) => offer.side === "ask").map((offer) => offer.priceStablePerXrp);
  const currentBids = current.filter((offer) => offer.side === "bid").map((offer) => offer.priceStablePerXrp);
  const desiredAsks = desiredOffers
    .filter((offer) => offer.side === "ask")
    .map((offer) => offer.priceStablePerXrp);
  const desiredBids = desiredOffers
    .filter((offer) => offer.side === "bid")
    .map((offer) => offer.priceStablePerXrp);

  // A large reference-price jump can put a new level through the old opposite
  // side. Cancel the pair first in that rare case so replacements cannot trade
  // against this wallet's own stale offers.
  const crossingRisk =
    (currentBids.length > 0 && desiredAsks.length > 0 && Math.min(...desiredAsks) <= Math.max(...currentBids)) ||
    (currentAsks.length > 0 && desiredBids.length > 0 && Math.max(...desiredBids) >= Math.min(...currentAsks));
  if (crossingRisk) {
    return [
      ...current.map((offer) => ({ kind: "cancel" as const, offerSequence: offer.sequence })),
      ...desiredOffers.map((desired) => ({ kind: "create" as const, desired })),
    ];
  }
  const actions: ReconcileAction[] = [];

  for (const side of ["ask", "bid"] as const) {
    const desired = desiredOffers
      .filter((offer) => offer.side === side)
      .sort((a, b) =>
        side === "ask"
          ? a.priceStablePerXrp - b.priceStablePerXrp
          : b.priceStablePerXrp - a.priceStablePerXrp,
      );
    const existing = current
      .filter((offer) => offer.side === side)
      .sort((a, b) =>
        side === "ask"
          ? a.priceStablePerXrp - b.priceStablePerXrp
          : b.priceStablePerXrp - a.priceStablePerXrp,
      );
    // First retain equivalent levels regardless of array position. This prevents one
    // stale or partially-filled level from shifting the sorted list and churning the
    // other nineteen offers.
    const remainingExisting = [...existing];
    const remainingDesired = desired.filter((newOffer) => {
      const matchIndex = remainingExisting.findIndex((oldOffer) => offersEquivalent(oldOffer, newOffer));
      if (matchIndex < 0) return true;
      remainingExisting.splice(matchIndex, 1);
      return false;
    });
    const count = Math.max(remainingExisting.length, remainingDesired.length);

    for (let index = 0; index < count; index += 1) {
      const oldOffer = remainingExisting[index];
      const newOffer = remainingDesired[index];
      if (oldOffer && newOffer) {
        actions.push({ kind: "replace", desired: newOffer, offerSequence: oldOffer.sequence });
      } else if (newOffer) {
        actions.push({ kind: "create", desired: newOffer });
      } else if (oldOffer) {
        actions.push({ kind: "cancel", offerSequence: oldOffer.sequence });
      }
    }
  }
  return actions;
}

function parseArgs(argv: string[]): LoopOptions {
  let networkValue = process.env.EXEC_NETWORK;
  let seedFile = resolve(process.cwd(), "scripts/seed.json");
  let once = false;
  let dryRun = false;
  let midOverride: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--network") networkValue = argv[++index];
    else if (argument.startsWith("--network=")) networkValue = argument.slice("--network=".length);
    else if (argument === "--seed-file") seedFile = resolve(argv[++index] ?? "");
    else if (argument.startsWith("--seed-file=")) seedFile = resolve(argument.slice("--seed-file=".length));
    else if (argument === "--mid") midOverride = Number(argv[++index]);
    else if (argument.startsWith("--mid=")) midOverride = Number(argument.slice("--mid=".length));
    else if (argument === "--once") once = true;
    else if (argument === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (midOverride !== undefined && (!Number.isFinite(midOverride) || midOverride <= 0)) {
    throw new Error("--mid must be a positive number.");
  }
  return { network: requireExecutionNetwork(networkValue), seedFile, once, dryRun, midOverride };
}

async function readEnvValue(path: string, key: string): Promise<string | undefined> {
  try {
    const source = await readFile(path, "utf8");
    for (const rawLine of source.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
      if (!match || match[1] !== key) continue;
      const rawValue = match[2].trim();
      if (
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ) {
        return rawValue.slice(1, -1);
      }
      return rawValue.replace(/\s+#.*$/u, "").trim();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

async function loadSecret(name: string): Promise<string | undefined> {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  return readEnvValue(resolve(process.cwd(), "apps/web/.env.local"), name);
}

async function getAllAccountOffers(client: Client, account: string): Promise<AccountOffer[]> {
  const offers: AccountOffer[] = [];
  let marker: unknown;
  do {
    // account_offers fields: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_offers
    const response = await client.request({
      command: "account_offers",
      account,
      ledger_index: "validated",
      limit: 400,
      ...(marker === undefined ? {} : { marker }),
    });
    offers.push(...(response.result.offers ?? []));
    marker = response.result.marker;
  } while (marker !== undefined);
  return offers;
}

function offerPriceStablePerXrp(takerGets: Amount, takerPays: Amount): number | undefined {
  const getsXrp = xrpFromDrops(takerGets);
  const paysXrp = xrpFromDrops(takerPays);
  if (getsXrp && isIssuedAmount(takerPays)) return Number(takerPays.value) / getsXrp;
  if (paysXrp && isIssuedAmount(takerGets)) return Number(takerGets.value) / paysXrp;
  return undefined;
}

export async function fetchMainnetXrpRlusdMid(client: Client): Promise<number> {
  const rlusdCurrency = normalizeCurrencyCode("RLUSD");
  // book_offers request fields: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
  const [asks, bids] = await Promise.all([
    client.request({
      command: "book_offers",
      ledger_index: "validated",
      taker_gets: { currency: "XRP" },
      taker_pays: { currency: rlusdCurrency, issuer: MAINNET_RLUSD_ISSUER },
      limit: 1,
    }),
    client.request({
      command: "book_offers",
      ledger_index: "validated",
      taker_gets: { currency: rlusdCurrency, issuer: MAINNET_RLUSD_ISSUER },
      taker_pays: { currency: "XRP" },
      limit: 1,
    }),
  ]);
  const ask = asks.result.offers[0];
  const bid = bids.result.offers[0];
  const askPrice = ask ? offerPriceStablePerXrp(ask.TakerGets, ask.TakerPays) : undefined;
  const bidPrice = bid ? offerPriceStablePerXrp(bid.TakerGets, bid.TakerPays) : undefined;
  if (!askPrice || !bidPrice || askPrice <= bidPrice) {
    throw new Error("Mainnet XRP/RLUSD does not currently expose a usable two-sided book.");
  }
  return (askPrice + bidPrice) / 2;
}

async function assertConnectedToExpectedNetwork(client: Client, network: ExecutionNetwork): Promise<void> {
  // server_info response fields: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/server_info
  const response = await client.request({ command: "server_info" });
  const networkId = response.result.info.network_id;
  const expectedId = network === "testnet" ? 1 : 2;
  if (networkId === 0) throw new Error("Refusing to submit: the configured execution endpoint is mainnet.");
  if (networkId !== expectedId) {
    throw new Error(
      `Refusing to submit: expected ${network} network ID ${expectedId}, received ${networkId ?? "no network ID"}.`,
    );
  }
}

function transactionResult(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  const meta = response.result.meta;
  if (isRecord(meta) && typeof meta.TransactionResult === "string") return meta.TransactionResult;
  return undefined;
}

async function submitAction(
  client: Client,
  wallet: Wallet,
  action: ReconcileAction,
): Promise<void> {
  let transaction: OfferCreate | OfferCancel;
  if (action.kind === "cancel") {
    // OfferCancel Account and OfferSequence fields:
    // https://xrpl.org/docs/references/protocol/transactions/types/offercancel
    transaction = {
      TransactionType: "OfferCancel",
      Account: wallet.address,
      OfferSequence: action.offerSequence,
    };
  } else {
    // OfferCreate Account, Flags, TakerGets, TakerPays, and OfferSequence fields:
    // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
    transaction = {
      TransactionType: "OfferCreate",
      Account: wallet.address,
      Flags: 65_536, // tfPassive: do not consume an offer at exactly the same quality.
      TakerGets: action.desired.takerGets,
      TakerPays: action.desired.takerPays,
      ...(action.kind === "replace" ? { OfferSequence: action.offerSequence } : {}),
    };
  }

  const prepared = await client.autofill(transaction);
  const signed = wallet.sign(prepared);
  const response = await client.submitAndWait(signed.tx_blob);
  const result = transactionResult(response);
  if (result !== "tesSUCCESS") throw new Error(`Ladder transaction failed with ${result ?? "an unknown result"}.`);
}

async function refreshOnce(
  executionClient: Client,
  referenceClient: Client,
  wallet: Wallet,
  metadata: SeedMetadata,
  options: Pick<LoopOptions, "dryRun" | "midOverride">,
): Promise<void> {
  const mid = options.midOverride ?? (await fetchMainnetXrpRlusdMid(referenceClient));
  const desired = buildLadder(mid, metadata.stable);
  const accountOffers = await getAllAccountOffers(executionClient, wallet.address);
  const actions = planReconciliation(accountOffers, desired, metadata.stable);

  console.log(
    `[mm-loop] ${metadata.network}: mid=${formatDecimal(mid)} stable/XRP, ${actions.length} reconciliation action(s)${options.dryRun ? " (dry run)" : ""}.`,
  );
  if (options.dryRun) return;
  for (const action of actions) await submitAction(executionClient, wallet, action);
}

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const onAbort = (): void => finish();

    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const seed = await loadSecret("MM_WALLET_SEED");
  if (!seed) throw new Error("MM_WALLET_SEED is required (environment or apps/web/.env.local).");

  const stableCode =
    (await loadSecret(`STABLE_CODE_${options.network.toUpperCase()}`)) ??
    (await loadSecret("STABLE_CODE")) ??
    "RLUSD";
  const stableIssuer = await loadSecret(`STABLE_ISSUER_${options.network.toUpperCase()}`);
  const seedDocument = JSON.parse(await readFile(options.seedFile, "utf8")) as unknown;
  const metadata = parseSeedMetadata(seedDocument, options.network, stableCode, stableIssuer);
  const wallet = Wallet.fromSeed(seed);
  if (wallet.address !== metadata.marketMakerAddress) {
    throw new Error("MM_WALLET_SEED does not match the market-maker address in scripts/seed.json.");
  }

  const executionUrl =
    (await loadSecret(options.network === "testnet" ? "XRPL_TESTNET_URL" : "XRPL_DEVNET_URL")) ??
    DEFAULT_ENDPOINTS[options.network];
  const mainnetUrl = (await loadSecret("XRPL_MAINNET_URL")) ?? MAINNET_ENDPOINT;
  const executionClient = new Client(executionUrl);
  const referenceClient = new Client(mainnetUrl);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await Promise.all([executionClient.connect(), referenceClient.connect()]);
    await assertConnectedToExpectedNetwork(executionClient, options.network);
    if (referenceClient.networkID !== 0) {
      throw new Error(
        `Refusing reference endpoint with network ID ${referenceClient.networkID ?? "unknown"}; XRPL_MAINNET_URL must be read-only mainnet (network ID 0).`,
      );
    }
    console.log(`[mm-loop] Connected for ${options.network}; refreshing ${LEVELS_PER_SIDE} levels per side every 30 seconds.`);
    do {
      try {
        await refreshOnce(executionClient, referenceClient, wallet, metadata, options);
      } catch {
        // Deliberately omit raw errors: some library errors can contain transaction material.
        console.error("[mm-loop] Refresh failed; the next interval will retry safely.");
        if (options.once) throw new Error("One-shot ladder refresh failed.");
      }
      if (!options.once && !controller.signal.aborted) {
        await sleep(REFRESH_INTERVAL_MS, controller.signal);
      }
    } while (!options.once && !controller.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await Promise.allSettled([
      executionClient.isConnected() ? executionClient.disconnect() : Promise.resolve(),
      referenceClient.isConnected() ? referenceClient.disconnect() : Promise.resolve(),
    ]);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch(() => {
    console.error("[mm-loop] Stopped without exposing credential or transaction details.");
    process.exitCode = 1;
  });
}
