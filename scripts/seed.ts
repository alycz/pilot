import { createHmac } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client,
  Wallet,
  xrpToDrops,
  type AccountOffer,
  type AccountSet,
  type AMMCreate,
  type Amount,
  type BookOffer,
  type BookOfferCurrency,
  type Currency,
  type IssuedCurrencyAmount,
  type IssuedCurrency,
  type Payment,
  type SubmittableTransaction,
  type TrustSet,
  type VaultCreate,
} from "xrpl";

import { buildLadder, planReconciliation } from "./mm-loop";

export type SeedNetwork = "testnet" | "devnet";

type PublicNetworkSeed = {
  marketMakerAddress?: string;
  stableIssuerAddress?: string;
  freemoneyIssuerAddress?: string;
  xrpVaultId?: string;
  rlusdVaultId?: string;
};

export type PublicSeedFile = Partial<Record<SeedNetwork, PublicNetworkSeed>>;

type StableAsset = {
  displayCode: string;
  currency: string;
  issuer: string;
};

type ParsedArgs = { network: SeedNetwork };

type FreemoneyOffer = {
  side: "ask" | "bid";
  level: number;
  takerGets: IssuedCurrencyAmount;
  takerPays: IssuedCurrencyAmount;
};

export type FreemoneyReconcileAction =
  | { kind: "create"; desired: FreemoneyOffer }
  | { kind: "replace"; desired: FreemoneyOffer; offerSequence: number }
  | { kind: "cancel"; offerSequence: number };

const TESTNET_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const DEFAULT_ENDPOINTS: Record<SeedNetwork, string> = {
  testnet: "wss://s.altnet.rippletest.net:51233",
  devnet: "wss://s.devnet.rippletest.net:51233",
};
const DEFAULT_MAINNET_ENDPOINT = "wss://s1.ripple.com";
const DEFAULT_LENDING_DEVNET_ENDPOINT = "wss://lend.devnet.rippletest.net:51233";
const LENDING_DEVNET_NETWORK_ID = 2;
const LADDER_LEVELS = 10;
const LADDER_STEP_BPS = 50;
const FREEMONEY_LEVELS = 2;
const XRP_CURRENCY = { currency: "XRP" } as const;
const PERSISTENCE_FLAG = "ALLOW_TEST_CREDENTIAL_PERSISTENCE";
const SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "seed.json");

/** Currency field formats: https://xrpl.org/docs/references/protocol/data-types/currency-formats */
export function toLedgerCurrency(code: string): string {
  if (/^[A-Fa-f0-9]{40}$/.test(code)) return code.toUpperCase();
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(code)) return code;
  const bytes = Buffer.from(code, "ascii");
  if (bytes.length < 4 || bytes.length > 20) {
    throw new Error(`Currency code must contain 3 characters or 4-20 ASCII bytes: ${code}`);
  }
  return bytes.toString("hex").toUpperCase().padEnd(40, "0");
}

function currencyMatches(actual: string, expectedLedgerCode: string): boolean {
  if (actual.toUpperCase() === expectedLedgerCode.toUpperCase()) return true;
  try {
    return toLedgerCurrency(actual).toUpperCase() === expectedLedgerCode.toUpperCase();
  } catch {
    return false;
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--network") value = argv[index + 1];
    if (arg.startsWith("--network=")) value = arg.slice("--network=".length);
  }
  if (!value) throw new Error("Missing required --network testnet|devnet argument.");
  if (value === "mainnet") {
    throw new Error("Refusing to seed mainnet. This command is testnet/devnet only.");
  }
  if (value !== "testnet" && value !== "devnet") {
    throw new Error(`Unsupported network ${value}; expected testnet or devnet.`);
  }
  return { network: value };
}

function amountValue(amount: Amount): number {
  return typeof amount === "string" ? Number(amount) : Number(amount.value);
}

function xrpAmount(amount: Amount): number {
  if (typeof amount !== "string") throw new Error("Expected an XRP amount in drops.");
  return Number(amount) / 1_000_000;
}

function issuedAmount(amount: Amount): number {
  if (typeof amount === "string") throw new Error("Expected an issued-currency amount.");
  return Number(amount.value);
}

function isIssuedAmount(amount: Amount, asset: StableAsset | IssuedCurrencyAmount): boolean {
  return (
    typeof amount !== "string" &&
    currencyMatches(amount.currency, asset.currency) &&
    amount.issuer === asset.issuer
  );
}

function issueCurrency(asset: StableAsset): IssuedCurrency {
  return { currency: asset.currency, issuer: asset.issuer };
}

export function mainnetMidFromBooks(asks: readonly BookOffer[], bids: readonly BookOffer[]): number {
  const askPrices = asks
    .map((offer) => {
      const gets = offer.taker_gets_funded ?? offer.TakerGets;
      const pays = offer.taker_pays_funded ?? offer.TakerPays;
      try {
        return issuedAmount(pays) / xrpAmount(gets);
      } catch {
        return Number.NaN;
      }
    })
    .filter((price) => Number.isFinite(price) && price > 0);
  const bidPrices = bids
    .map((offer) => {
      const gets = offer.taker_gets_funded ?? offer.TakerGets;
      const pays = offer.taker_pays_funded ?? offer.TakerPays;
      try {
        return issuedAmount(gets) / xrpAmount(pays);
      } catch {
        return Number.NaN;
      }
    })
    .filter((price) => Number.isFinite(price) && price > 0);
  if (askPrices.length === 0 || bidPrices.length === 0) {
    throw new Error("Mainnet XRP/RLUSD does not currently have a funded two-sided book.");
  }
  const ask = Math.min(...askPrices);
  const bid = Math.max(...bidPrices);
  if (bid > ask * 1.25) throw new Error("Mainnet XRP/RLUSD book returned an implausible spread.");
  return (ask + bid) / 2;
}

function formatIssued(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Issued amount must be positive.");
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function formatXrpDrops(value: number): string {
  // XRP transaction amounts use drops: https://xrpl.org/docs/references/protocol/data-types/basic-data-types#specifying-currency-amounts
  return xrpToDrops(value.toFixed(6));
}

function envValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadEnvFile(path: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = envValue(match[2]);
  }
}

function pilotEnvPath(): string {
  return process.env.PILOT_ENV_PATH ?? resolve("/absolute/private/pilot/pilot-secrets/pilot.env.local");
}

function harborEnvPath(): string {
  return process.env.HARBOR_ENV_PATH ?? resolve("/absolute/private/pilot/harbor-secrets/harbor.dev.vars");
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function upsertEnv(path: string, values: Readonly<Record<string, string>>, secretKeys: Set<string>): Promise<void> {
  let contents = "";
  let mode = 0o600;
  try {
    contents = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o600;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
    if (index >= 0) {
      const current = envValue(lines[index].slice(lines[index].indexOf("=") + 1));
      if (secretKeys.has(key) && current !== value) {
        throw new Error(`Refusing to replace existing credential ${key} in ${path}.`);
      }
      lines[index] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  await atomicWrite(path, `${lines.join("\n")}\n`, mode || 0o600);
}

function assertCredentialPersistenceAllowed(): void {
  if (process.env[PERSISTENCE_FLAG] !== "1") {
    throw new Error(
      `A new test credential is required. Set ${PERSISTENCE_FLAG}=1 only after authorizing persistence in the external secrets file.`,
    );
  }
}

async function walletFor(name: string, addressFromSeedFile: string | undefined): Promise<Wallet> {
  const existing = process.env[name];
  if (existing) {
    const wallet = Wallet.fromSeed(existing);
    if (addressFromSeedFile && wallet.classicAddress !== addressFromSeedFile) {
      throw new Error(`${name} does not match the public address already recorded in seed.json.`);
    }
    return wallet;
  }
  if (addressFromSeedFile) {
    throw new Error(`${name} is missing; refusing to create a duplicate account for ${addressFromSeedFile}.`);
  }
  assertCredentialPersistenceAllowed();
  const wallet = Wallet.generate();
  if (!wallet.seed) throw new Error(`xrpl.js did not return a seed for ${name}.`);
  await upsertEnv(pilotEnvPath(), { [name]: wallet.seed }, new Set([name]));
  process.env[name] = wallet.seed;
  return wallet;
}

function fixtureWallet(marketMakerSeed: string, role: "tusd-issuer" | "freemoney-issuer", recorded?: string): Wallet {
  // The only persisted test credential is MM_WALLET_SEED. Domain-separated fixture wallets are
  // reproducibly derived in memory so reruns can manage their objects without storing more seeds.
  const entropy = createHmac("sha256", marketMakerSeed)
    .update(`pilot-p2.1-fixture/${role}/v1`, "utf8")
    .digest()
    .subarray(0, 16);
  const wallet = Wallet.fromEntropy(entropy);
  if (recorded && wallet.classicAddress !== recorded) {
    throw new Error(`${role} does not match the public address already recorded in seed.json.`);
  }
  return wallet;
}

async function ensureFaucetBalance(client: Client, wallet: Wallet, ownerObjectsNeeded: number): Promise<void> {
  const info = await client.request({ command: "server_info" });
  const ledger = info.result.info.validated_ledger;
  const reserveBase = Number(ledger?.reserve_base_xrp);
  const reserveIncrement = Number(ledger?.reserve_inc_xrp);
  if (!Number.isFinite(reserveBase) || !Number.isFinite(reserveIncrement)) {
    throw new Error("The connected server did not report validated-ledger reserve values.");
  }
  const minimum = reserveBase + reserveIncrement * ownerObjectsNeeded + 200;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let balance = 0;
    try {
      balance = Number(await client.getXrpBalance(wallet.classicAddress));
    } catch {
      // A not-yet-funded account has no AccountRoot and therefore no balance.
    }
    if (balance >= minimum) return;
    await client.fundWallet(wallet);
  }
  const balance = Number(await client.getXrpBalance(wallet.classicAddress));
  if (balance < minimum) {
    throw new Error(`Faucet balance for ${wallet.classicAddress} remains below the ledger reserve requirement.`);
  }
}

function assertConnectedNetwork(client: Client, network: SeedNetwork): void {
  const expectedNetworkId = network === "testnet" ? 1 : 2;
  // server_info network_id: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/server_info
  if (client.networkID !== expectedNetworkId) {
    throw new Error(
      `Refusing endpoint with network ID ${client.networkID ?? "unknown"}; ${network} must use network ID ${expectedNetworkId}.`,
    );
  }
}

function transactionResult(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const result = (meta as { TransactionResult?: unknown }).TransactionResult;
  return typeof result === "string" ? result : undefined;
}

async function submit<T extends SubmittableTransaction>(client: Client, wallet: Wallet, tx: T): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const prepared = await client.autofill(tx);
      const signed = wallet.sign(prepared);
      const response = await client.submitAndWait(signed.tx_blob);
      const code = transactionResult(response.result.meta);
      if (code !== "tesSUCCESS") {
        throw new Error(`${tx.TransactionType} failed with ${code ?? "an unknown result"}.`);
      }
      return prepared;
    } catch (error) {
      if (attempt === 2 || !isRetryableLedgerExpiry(error)) throw error;
    }
  }
  throw new Error(`${tx.TransactionType} exhausted its ledger-expiry retries.`);
}

async function accountLines(client: Client, account: string) {
  const lines: Array<{ account: string; balance: string; currency: string }> = [];
  let marker: unknown;
  do {
    const page = await client.request({
      command: "account_lines",
      account,
      ledger_index: "validated",
      limit: 400,
      marker,
    });
    lines.push(...page.result.lines);
    marker = page.result.marker;
  } while (marker !== undefined);
  return lines;
}

async function issuedBalance(client: Client, account: string, asset: StableAsset): Promise<number> {
  const lines = await accountLines(client, account);
  const line = lines.find(
    (entry) => entry.account === asset.issuer && currencyMatches(entry.currency, asset.currency),
  );
  return line ? Number(line.balance) : 0;
}

async function ensureTrustLine(client: Client, wallet: Wallet, asset: StableAsset, limit = "1000000000") {
  const lines = await accountLines(client, wallet.classicAddress);
  if (
    lines.some(
      (line) => line.account === asset.issuer && currencyMatches(line.currency, asset.currency),
    )
  ) {
    return;
  }
  // TrustSet field definitions: https://xrpl.org/docs/references/protocol/transactions/types/trustset
  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: wallet.classicAddress,
    LimitAmount: { currency: asset.currency, issuer: asset.issuer, value: limit },
  };
  await submit(client, wallet, tx);
}

async function ensureDefaultRipple(client: Client, issuer: Wallet): Promise<void> {
  // AccountSet SetFlag values: https://xrpl.org/docs/references/protocol/transactions/types/accountset
  const tx: AccountSet = {
    TransactionType: "AccountSet",
    Account: issuer.classicAddress,
    SetFlag: 8,
  };
  await submit(client, issuer, tx);
}

async function ensureIssuedFunds(
  client: Client,
  issuer: Wallet,
  recipient: Wallet,
  asset: StableAsset,
  target: number,
): Promise<void> {
  const balance = await issuedBalance(client, recipient.classicAddress, asset);
  if (balance >= target) return;
  // Payment Amount and Destination fields: https://xrpl.org/docs/references/protocol/transactions/types/payment
  const tx: Payment = {
    TransactionType: "Payment",
    Account: issuer.classicAddress,
    Destination: recipient.classicAddress,
    Amount: {
      currency: asset.currency,
      issuer: issuer.classicAddress,
      value: formatIssued(target - balance),
    },
  };
  await submit(client, issuer, tx);
}

async function findRlusd(client: Client, account: string, network: SeedNetwork): Promise<StableAsset | undefined> {
  const currency = toLedgerCurrency("RLUSD");
  const requiredIssuer = network === "testnet" ? TESTNET_RLUSD_ISSUER : undefined;
  const line = (await accountLines(client, account)).find(
    (entry) =>
      currencyMatches(entry.currency, currency) &&
      Number(entry.balance) > 0 &&
      (requiredIssuer === undefined || entry.account === requiredIssuer),
  );
  return line ? { displayCode: "RLUSD", currency, issuer: line.account } : undefined;
}

async function stableAsset(
  client: Client,
  network: SeedNetwork,
  marketMaker: Wallet,
  marketMakerSeed: string,
  publicSeed: PublicNetworkSeed,
): Promise<StableAsset> {
  const rlusd = await findRlusd(client, marketMaker.classicAddress, network);
  if (rlusd) {
    await persistStableConfig(network, rlusd);
    return rlusd;
  }

  const configuredCode =
    process.env[`STABLE_CODE_${network.toUpperCase()}`] ?? process.env.STABLE_CODE;
  const recordedTusdIssuer = configuredCode === "tUSD" ? publicSeed.stableIssuerAddress : undefined;
  const issuer = fixtureWallet(marketMakerSeed, "tusd-issuer", recordedTusdIssuer);
  await ensureFaucetBalance(client, issuer, 4);
  await ensureDefaultRipple(client, issuer);
  const asset: StableAsset = {
    displayCode: "tUSD",
    currency: toLedgerCurrency("tUSD"),
    issuer: issuer.classicAddress,
  };
  await ensureTrustLine(client, marketMaker, asset);
  await ensureIssuedFunds(client, issuer, marketMaker, asset, 100_000);

  await persistStableConfig(network, asset);
  return asset;
}

export function stableConfigEntries(
  network: SeedNetwork,
  asset: Pick<StableAsset, "displayCode" | "issuer">,
  executionNetwork: string,
): Record<string, string> {
  const publicConfig: Record<string, string> = {
    [`STABLE_CODE_${network.toUpperCase()}`]: asset.displayCode,
    [`STABLE_ISSUER_${network.toUpperCase()}`]: asset.issuer,
  };
  if (executionNetwork === network) publicConfig.STABLE_CODE = asset.displayCode;
  return publicConfig;
}

async function persistStableConfig(network: SeedNetwork, asset: StableAsset): Promise<void> {
  const executionNetwork = process.env.EXEC_NETWORK ?? "testnet";
  const publicConfig = stableConfigEntries(network, asset, executionNetwork);
  await upsertEnv(pilotEnvPath(), publicConfig, new Set());
  await upsertEnv(harborEnvPath(), publicConfig, new Set());
  process.env[`STABLE_CODE_${network.toUpperCase()}`] = asset.displayCode;
  if (executionNetwork === network) process.env.STABLE_CODE = asset.displayCode;
  process.env[`STABLE_ISSUER_${network.toUpperCase()}`] = asset.issuer;
}

async function readMainnetMid(): Promise<number> {
  const client = new Client(process.env.XRPL_MAINNET_URL ?? DEFAULT_MAINNET_ENDPOINT);
  const rlusd = { currency: toLedgerCurrency("RLUSD"), issuer: MAINNET_RLUSD_ISSUER };
  try {
    await client.connect();
    if (client.networkID !== 0) {
      throw new Error(`XRPL_MAINNET_URL must be mainnet (network ID 0), not ${client.networkID ?? "unknown"}.`);
    }
    // book_offers request fields: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
    const [asks, bids] = await Promise.all([
      client.request({
        command: "book_offers",
        ledger_index: "validated",
        taker_gets: XRP_CURRENCY,
        taker_pays: rlusd,
        limit: 20,
      }),
      client.request({
        command: "book_offers",
        ledger_index: "validated",
        taker_gets: rlusd,
        taker_pays: XRP_CURRENCY,
        limit: 20,
      }),
    ]);
    return mainnetMidFromBooks(asks.result.offers, bids.result.offers);
  } finally {
    if (client.isConnected()) await client.disconnect();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableLedgerExpiry(error: unknown): boolean {
  return /\btefPAST_SEQ\b/.test(errorText(error));
}

function isMissingLedgerObject(error: unknown): boolean {
  return /(?:act|entry|object)NotFound|does not exist|not found/i.test(errorText(error));
}

export function isDuplicateAmm(error: unknown): boolean {
  return /AMMCreate failed with tecDUPLICATE/i.test(errorText(error));
}

async function findAmmAccount(client: Client, asset: StableAsset): Promise<string | undefined> {
  try {
    const response = await client.request({
      command: "amm_info",
      asset: XRP_CURRENCY,
      asset2: issueCurrency(asset),
    });
    return response.result.amm.account;
  } catch (error) {
    if (isMissingLedgerObject(error)) return undefined;
    throw error;
  }
}

async function ensureAmm(client: Client, wallet: Wallet, asset: StableAsset, mid: number): Promise<string> {
  const existing = await findAmmAccount(client, asset);
  if (existing) return existing;
  const stableBalance = await issuedBalance(client, wallet.classicAddress, asset);
  const stableDeposit = Math.min(2_000, mid * 100, Math.max(stableBalance * 0.2, 0.0001));
  const xrpDeposit = stableDeposit / mid;
  // AMMCreate Amount, Amount2 and TradingFee fields: https://xrpl.org/docs/references/protocol/transactions/types/ammcreate
  const tx: AMMCreate = {
    TransactionType: "AMMCreate",
    Account: wallet.classicAddress,
    Amount: formatXrpDrops(xrpDeposit),
    Amount2: { currency: asset.currency, issuer: asset.issuer, value: formatIssued(stableDeposit) },
    TradingFee: 300,
  };
  try {
    await submit(client, wallet, tx);
  } catch (error) {
    // A validated AMM can briefly be absent from the read endpoint used above. Treat a duplicate
    // result as an idempotent race, then wait for the public object to become readable.
    if (!isDuplicateAmm(error)) throw error;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const created = await findAmmAccount(client, asset);
    if (created) return created;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("AMMCreate validated or found a duplicate, but amm_info did not return the pool.");
}

async function accountOffers(client: Client, account: string): Promise<AccountOffer[]> {
  const offers: AccountOffer[] = [];
  let marker: unknown;
  do {
    const page = await client.request({
      command: "account_offers",
      account,
      ledger_index: "validated",
      limit: 400,
      marker,
    });
    offers.push(...(page.result.offers ?? []));
    marker = page.result.marker;
  } while (marker !== undefined);
  return offers;
}

function fundedOfferAmount(offer: BookOffer, field: "gets" | "pays"): number {
  const funded = field === "gets" ? offer.taker_gets_funded : offer.taker_pays_funded;
  const nominal = field === "gets" ? offer.TakerGets : offer.TakerPays;
  return amountValue(funded ?? nominal);
}

async function fundedBookCount(
  client: Client,
  owner: string,
  takerGets: BookOfferCurrency,
  takerPays: BookOfferCurrency,
): Promise<number> {
  // book_offers omits unfunded offers unless the owner is passed as taker, which we intentionally do not do:
  // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
  const response = await client.request({
    command: "book_offers",
    ledger_index: "validated",
    taker_gets: takerGets,
    taker_pays: takerPays,
    limit: 400,
  });
  return response.result.offers.filter(
    (offer) =>
      offer.Account === owner &&
      fundedOfferAmount(offer, "gets") > 0 &&
      fundedOfferAmount(offer, "pays") > 0,
  ).length;
}

async function assertFundedPair(
  client: Client,
  owner: string,
  first: BookOfferCurrency,
  second: BookOfferCurrency,
  minimumEachSide: number,
  label: string,
): Promise<void> {
  const [forward, reverse] = await Promise.all([
    fundedBookCount(client, owner, first, second),
    fundedBookCount(client, owner, second, first),
  ]);
  if (forward < minimumEachSide || reverse < minimumEachSide) {
    throw new Error(
      `${label} book has ${forward}/${reverse} funded market-maker levels; expected at least ${minimumEachSide} per side.`,
    );
  }
}

async function ensureXrpStableLadder(
  client: Client,
  wallet: Wallet,
  asset: StableAsset,
  mid: number,
): Promise<void> {
  const stableBalance = await issuedBalance(client, wallet.classicAddress, asset);
  const xrpPerLevel = Math.min(5, Math.max(0.01, (stableBalance * 0.25) / (LADDER_LEVELS * mid)));
  const desired = buildLadder(
    mid,
    { currency: asset.currency, issuer: asset.issuer },
    { levels: LADDER_LEVELS, spacingBps: LADDER_STEP_BPS, xrpPerLevel },
  );
  const actions = planReconciliation(
    await accountOffers(client, wallet.classicAddress),
    desired,
    { currency: asset.currency, issuer: asset.issuer },
  );
  for (const action of actions) {
    if (action.kind === "cancel") {
      // OfferCancel OfferSequence field: https://xrpl.org/docs/references/protocol/transactions/types/offercancel
      await submit(client, wallet, {
        TransactionType: "OfferCancel",
        Account: wallet.classicAddress,
        OfferSequence: action.offerSequence,
      });
      continue;
    }
    // OfferCreate TakerGets/TakerPays/OfferSequence fields:
    // https://xrpl.org/docs/references/protocol/transactions/types/offercreate
    await submit(client, wallet, {
      TransactionType: "OfferCreate",
      Account: wallet.classicAddress,
      Flags: 65_536,
      TakerGets: action.desired.takerGets,
      TakerPays: action.desired.takerPays,
      ...(action.kind === "replace" ? { OfferSequence: action.offerSequence } : {}),
    });
  }
  await assertFundedPair(
    client,
    wallet.classicAddress,
    XRP_CURRENCY,
    issueCurrency(asset),
    LADDER_LEVELS,
    "XRP/stable",
  );
}

function pairSide(
  offer: AccountOffer,
  provided: StableAsset,
  requested: StableAsset,
): "ask" | "bid" | undefined {
  if (isIssuedAmount(offer.taker_gets, provided) && isIssuedAmount(offer.taker_pays, requested)) return "ask";
  if (isIssuedAmount(offer.taker_gets, requested) && isIssuedAmount(offer.taker_pays, provided)) return "bid";
  return undefined;
}

function freemoneyDesiredOffers(stable: StableAsset, free: StableAsset): FreemoneyOffer[] {
  const desired: FreemoneyOffer[] = [];
  for (let level = 1; level <= FREEMONEY_LEVELS; level += 1) {
    desired.push({
      side: "ask",
      level,
      takerGets: { currency: free.currency, issuer: free.issuer, value: formatIssued(1_000 * level) },
      takerPays: { currency: stable.currency, issuer: stable.issuer, value: formatIssued(10.5 * level) },
    });
    desired.push({
      side: "bid",
      level,
      takerGets: { currency: stable.currency, issuer: stable.issuer, value: formatIssued(8 * level) },
      takerPays: { currency: free.currency, issuer: free.issuer, value: formatIssued(1_000 * level) },
    });
  }
  return desired;
}

function issuedAmountsEquivalent(left: Amount, right: IssuedCurrencyAmount): boolean {
  if (typeof left === "string" || !isIssuedAmount(left, right)) return false;
  const leftValue = Number(left.value);
  const rightValue = Number(right.value);
  return (
    Number.isFinite(leftValue) &&
    Number.isFinite(rightValue) &&
    leftValue > 0 &&
    rightValue > 0 &&
    (Math.abs(leftValue - rightValue) / Math.max(leftValue, rightValue)) * 10_000 <= 1
  );
}

function freemoneyOffersEquivalent(existing: AccountOffer, desired: FreemoneyOffer): boolean {
  return (
    issuedAmountsEquivalent(existing.taker_gets, desired.takerGets) &&
    issuedAmountsEquivalent(existing.taker_pays, desired.takerPays)
  );
}

export function planFreemoneyReconciliation(
  accountOfferList: AccountOffer[],
  fundedSequences: ReadonlySet<number>,
  stable: StableAsset,
  free: StableAsset,
): FreemoneyReconcileAction[] {
  const desired = freemoneyDesiredOffers(stable, free);
  const actions: FreemoneyReconcileAction[] = [];

  for (const side of ["ask", "bid"] as const) {
    const remainingExisting = accountOfferList
      .filter((offer) => pairSide(offer, free, stable) === side)
      .sort((left, right) => left.seq - right.seq);
    const remainingDesired = desired.filter((offer) => offer.side === side);

    // Retain only funded, equivalent levels. An offer may remain in account_offers
    // after its owner can no longer fund it, while public book_offers omits it.
    for (let index = remainingDesired.length - 1; index >= 0; index -= 1) {
      const desiredOffer = remainingDesired[index];
      const matchIndex = remainingExisting.findIndex(
        (offer) => fundedSequences.has(offer.seq) && freemoneyOffersEquivalent(offer, desiredOffer),
      );
      if (matchIndex >= 0) {
        remainingDesired.splice(index, 1);
        remainingExisting.splice(matchIndex, 1);
      }
    }

    const count = Math.max(remainingExisting.length, remainingDesired.length);
    for (let index = 0; index < count; index += 1) {
      const existing = remainingExisting[index];
      const desiredOffer = remainingDesired[index];
      if (existing && desiredOffer) {
        actions.push({ kind: "replace", desired: desiredOffer, offerSequence: existing.seq });
      } else if (desiredOffer) {
        actions.push({ kind: "create", desired: desiredOffer });
      } else if (existing) {
        actions.push({ kind: "cancel", offerSequence: existing.seq });
      }
    }
  }
  return actions;
}

async function fundedFreemoneySequences(
  client: Client,
  owner: string,
  stable: StableAsset,
  free: StableAsset,
): Promise<Set<number>> {
  const books = await Promise.all([
    client.request({
      command: "book_offers",
      ledger_index: "validated",
      taker_gets: issueCurrency(free),
      taker_pays: issueCurrency(stable),
      limit: 400,
    }),
    client.request({
      command: "book_offers",
      ledger_index: "validated",
      taker_gets: issueCurrency(stable),
      taker_pays: issueCurrency(free),
      limit: 400,
    }),
  ]);
  return new Set(
    books.flatMap((book) =>
      book.result.offers
        .filter(
          (offer) =>
            offer.Account === owner &&
            fundedOfferAmount(offer, "gets") > 0 &&
            fundedOfferAmount(offer, "pays") > 0,
        )
        .map((offer) => offer.Sequence),
    ),
  );
}

async function ensureFreemoneyBook(
  client: Client,
  marketMaker: Wallet,
  stable: StableAsset,
  free: StableAsset,
): Promise<void> {
  const actions = planFreemoneyReconciliation(
    await accountOffers(client, marketMaker.classicAddress),
    await fundedFreemoneySequences(client, marketMaker.classicAddress, stable, free),
    stable,
    free,
  );
  for (const action of actions) {
    if (action.kind === "cancel") {
      // OfferCancel OfferSequence field: https://xrpl.org/docs/references/protocol/transactions/types/offercancel
      await submit(client, marketMaker, {
        TransactionType: "OfferCancel",
        Account: marketMaker.classicAddress,
        OfferSequence: action.offerSequence,
      });
      continue;
    }
    // OfferCreate TakerGets/TakerPays fields: https://xrpl.org/docs/references/protocol/transactions/types/offercreate
    await submit(client, marketMaker, {
      TransactionType: "OfferCreate",
      Account: marketMaker.classicAddress,
      Flags: 65_536,
      TakerGets: action.desired.takerGets,
      TakerPays: action.desired.takerPays,
      ...(action.kind === "replace" ? { OfferSequence: action.offerSequence } : {}),
    });
  }
  await assertFundedPair(
    client,
    marketMaker.classicAddress,
    issueCurrency(free),
    issueCurrency(stable),
    FREEMONEY_LEVELS,
    "FREEMONEY/stable",
  );
}

export function vaultLedgerIndex(object: { index?: unknown }): string | undefined {
  return typeof object.index === "string" && /^[A-Fa-f0-9]{64}$/.test(object.index)
    ? object.index
    : undefined;
}

async function accountVaults(client: Client, owner: string) {
  const vaults: Array<{
    LedgerEntryType: "Vault";
    index: string;
    Asset: Currency;
  }> = [];
  let marker: unknown;
  do {
    const page = await client.request({
      command: "account_objects",
      account: owner,
      type: "vault",
      ledger_index: "validated",
      limit: 400,
      marker,
    });
    for (const object of page.result.account_objects) {
      const index = vaultLedgerIndex(object);
      if (object.LedgerEntryType === "Vault" && index) {
        vaults.push({ ...object, index });
      }
    }
    marker = page.result.marker;
  } while (marker !== undefined);
  return vaults;
}

function sameCurrency(left: Currency, right: Currency): boolean {
  if (!("currency" in left) || !("currency" in right)) {
    return "mpt_issuance_id" in left && "mpt_issuance_id" in right && left.mpt_issuance_id === right.mpt_issuance_id;
  }
  return (
    currencyMatches(left.currency, right.currency) &&
    ("issuer" in left ? left.issuer : undefined) === ("issuer" in right ? right.issuer : undefined)
  );
}

async function ensureVault(client: Client, owner: Wallet, asset: Currency, label: string): Promise<string> {
  const existing = (await accountVaults(client, owner.classicAddress)).find((vault) => sameCurrency(vault.Asset, asset));
  if (existing) return existing.index;
  // VaultCreate Asset, Data and WithdrawalPolicy fields: https://xrpl.org/docs/references/protocol/transactions/types/vaultcreate
  const tx: VaultCreate = {
    TransactionType: "VaultCreate",
    Account: owner.classicAddress,
    Asset: asset,
    Data: Buffer.from(label, "utf8").toString("hex").toUpperCase(),
    WithdrawalPolicy: 1,
    ...("currency" in asset && asset.currency === "XRP" ? {} : { Scale: 6 }),
  };
  await submit(client, owner, tx);
  const created = (await accountVaults(client, owner.classicAddress)).find((vault) => sameCurrency(vault.Asset, asset));
  if (!created) throw new Error(`VaultCreate validated, but the ${label} vault was not returned by account_objects.`);
  return created.index;
}

function isVaultFeatureUnavailable(error: unknown): boolean {
  return /VaultCreate failed with temDISABLED|SingleAssetVault|LendingProtocol/i.test(errorText(error));
}

export function assertLendingDevnetEndpoint(endpoint: string, networkID: number | undefined): void {
  const url = new URL(endpoint);
  if (
    url.protocol !== "wss:" ||
    url.hostname !== "lend.devnet.rippletest.net" ||
    url.port !== "51233" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `Refusing unapproved Lending-Devnet endpoint; expected ${DEFAULT_LENDING_DEVNET_ENDPOINT}.`,
    );
  }
  if (networkID !== LENDING_DEVNET_NETWORK_ID) {
    throw new Error(
      `Refusing Lending-Devnet endpoint with network ID ${networkID ?? "unknown"}; expected ${LENDING_DEVNET_NETWORK_ID}.`,
    );
  }
}

async function ensureDevnetXrpVault(primaryClient: Client, owner: Wallet): Promise<string> {
  try {
    return await ensureVault(primaryClient, owner, XRP_CURRENCY, "Pilot public XRP vault");
  } catch (error) {
    if (!isVaultFeatureUnavailable(error)) throw error;
  }

  const fallbackEndpoint = process.env.XRPL_LENDING_DEVNET_URL ?? DEFAULT_LENDING_DEVNET_ENDPOINT;
  const fallback = new Client(fallbackEndpoint);
  try {
    await fallback.connect();
    assertLendingDevnetEndpoint(fallbackEndpoint, fallback.networkID);
    await ensureFaucetBalance(fallback, owner, 4);
    return await ensureVault(fallback, owner, XRP_CURRENCY, "Pilot public XRP vault");
  } finally {
    if (fallback.isConnected()) await fallback.disconnect();
  }
}

export function assertPublicSeedFile(seed: PublicSeedFile): void {
  const allowedKeys = new Set([
    "marketMakerAddress",
    "stableIssuerAddress",
    "freemoneyIssuerAddress",
    "xrpVaultId",
    "rlusdVaultId",
  ]);
  for (const [network, entry] of Object.entries(seed)) {
    if (network !== "testnet" && network !== "devnet") {
      throw new Error(`Unexpected network key in seed.json: ${network}`);
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`seed.json ${network} entry must be an object.`);
    }
    for (const [key, value] of Object.entries(entry)) {
      if (/seed|secret|private|mnemonic/i.test(key)) {
        throw new Error(`Secret-shaped key is forbidden in seed.json: ${network}.${key}`);
      }
      if (!allowedKeys.has(key)) throw new Error(`Unexpected key in seed.json: ${network}.${key}`);
      const pattern = key.endsWith("VaultId")
        ? /^[A-Fa-f0-9]{64}$/
        : /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
      if (typeof value !== "string" || !pattern.test(value)) {
        throw new Error(`seed.json values must be XRPL addresses or ledger IDs: ${network}.${key}`);
      }
    }
  }
}

async function readPublicSeedFile(): Promise<PublicSeedFile> {
  try {
    return JSON.parse(await readFile(SEED_PATH, "utf8")) as PublicSeedFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writePublicSeedFile(seed: PublicSeedFile): Promise<void> {
  assertPublicSeedFile(seed);
  await atomicWrite(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`, 0o644);
}

async function run(network: SeedNetwork): Promise<void> {
  await loadEnvFile(pilotEnvPath());
  const allPublic = await readPublicSeedFile();
  const publicSeed = allPublic[network] ?? {};
  const endpoint =
    network === "testnet"
      ? process.env.XRPL_TESTNET_URL ?? DEFAULT_ENDPOINTS.testnet
      : process.env.XRPL_DEVNET_URL ?? DEFAULT_ENDPOINTS.devnet;
  const client = new Client(endpoint);
  const knownSecrets: string[] = [];
  try {
    if (!process.env.MM_WALLET_SEED && !publicSeed.marketMakerAddress) {
      assertCredentialPersistenceAllowed();
    }
    await client.connect();
    assertConnectedNetwork(client, network);
    const marketMaker = await walletFor("MM_WALLET_SEED", publicSeed.marketMakerAddress);
    if (marketMaker.seed) knownSecrets.push(marketMaker.seed);
    await ensureFaucetBalance(client, marketMaker, 40);

    const marketMakerSeed = process.env.MM_WALLET_SEED;
    if (!marketMakerSeed) throw new Error("MM_WALLET_SEED was not available after wallet initialization.");
    const stable = await stableAsset(client, network, marketMaker, marketMakerSeed, publicSeed);
    const mainnetMid = await readMainnetMid();
    await ensureAmm(client, marketMaker, stable, mainnetMid);
    await ensureXrpStableLadder(client, marketMaker, stable, mainnetMid);

    const freemoneyIssuer = fixtureWallet(
      marketMakerSeed,
      "freemoney-issuer",
      publicSeed.freemoneyIssuerAddress,
    );
    await ensureFaucetBalance(client, freemoneyIssuer, 4);
    await ensureDefaultRipple(client, freemoneyIssuer);
    const freemoney: StableAsset = {
      displayCode: "FREEMONEY",
      currency: toLedgerCurrency("FREEMONEY"),
      issuer: freemoneyIssuer.classicAddress,
    };
    await ensureTrustLine(client, marketMaker, freemoney);
    await ensureIssuedFunds(client, freemoneyIssuer, marketMaker, freemoney, 100_000);
    await ensureFreemoneyBook(client, marketMaker, stable, freemoney);

    const nextPublic: PublicNetworkSeed = {
      ...publicSeed,
      marketMakerAddress: marketMaker.classicAddress,
      stableIssuerAddress: stable.issuer,
      freemoneyIssuerAddress: freemoneyIssuer.classicAddress,
    };
    if (network === "devnet") {
      nextPublic.xrpVaultId = await ensureDevnetXrpVault(client, marketMaker);
      if (stable.displayCode === "RLUSD") {
        nextPublic.rlusdVaultId = await ensureVault(
          client,
          marketMaker,
          issueCurrency(stable),
          "Pilot public RLUSD vault",
        );
      }
    }
    allPublic[network] = nextPublic;
    await writePublicSeedFile(allPublic);
    console.log(`Seeded ${network} for market maker ${marketMaker.classicAddress}.`);
  } catch (error) {
    let message = errorText(error);
    const environmentSecrets = Object.entries(process.env)
      .filter(([key, value]) => /SEED|SECRET|TOKEN|(?:API_)?KEY/i.test(key) && (value?.length ?? 0) >= 8)
      .map(([, value]) => value);
    for (const secret of [...knownSecrets, ...environmentSecrets]) {
      if (secret) message = message.split(secret).join("[REDACTED]");
    }
    throw new Error(message);
  } finally {
    if (client.isConnected()) await client.disconnect();
  }
}

const isDirectExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void (async () => {
    try {
      const { network } = parseArgs(process.argv.slice(2));
      await run(network);
    } catch (error) {
      console.error(errorText(error));
      process.exitCode = 1;
    }
  })();
}
