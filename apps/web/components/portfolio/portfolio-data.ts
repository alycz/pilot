import {
  AccountLinkSchema,
  PolicySchema,
  type AccountLink,
  type Network,
  type Policy,
} from "@pilot/contracts";
import {
  VaultPositionsResponseSchema,
  type VaultPosition as HarborVaultPosition,
  type VaultPositionsResult,
} from "@pilot/harbor-client";
import { z } from "zod";

import harborReads from "../../../../packages/harbor-client/fixtures/reads.json";

const BUDGET_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const NETWORK: Network = "testnet";
const FIXTURE_STABLE_ASSET = {
  currency: "RLUSD",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};
const FIXTURE_XRP_USD = 0.512;
const LOCAL_LP_VALUE_USD = 398.2;
const LOCAL_VAULT_VALUE_USD = 51.2;

export type PortfolioBalance = {
  id: string;
  symbol: string;
  name: string;
  amount: number;
  usdValue: number | null;
  availabilityNote: string;
  accent: "aqua" | "violet";
};

export type PortfolioOffer = {
  id: string;
  sequence: number;
  side: "Sell" | "Buy" | "Swap";
  quantity: string;
  receive: string;
  price: string;
  status: "Open";
};

export type PortfolioPosition = {
  id: string;
  title: string;
  subtitle: string;
  network: Network;
  amount: string;
  usdValue: number | null;
  yield: string;
  fixtureLabel: string;
  available: boolean;
};

export type FeedItem = {
  id: string;
  title: string;
  detail: string;
  time: string;
  state: "executed" | "approval" | "info";
  hash?: string;
};

export type PortfolioContext = {
  network: Network;
  budgetAccount: string;
  mainAccount?: string;
  stableAsset: {
    currency: string;
    issuer: string;
  };
};

type JsonObject = Record<string, unknown>;

type AccountTransaction = {
  hash?: string;
  ledger_index?: number;
  validated: boolean;
  tx?: JsonObject;
  tx_json?: JsonObject;
  meta: JsonObject | string | null;
};

export type HarborEnvelope<T> =
  | {
      ok: true;
      data: T;
      asOf: string;
      asOfBasis: string;
      caveat?: string[];
    }
  | {
      ok: false;
      error: { message?: string; service?: string; code?: string };
    };

type AccountInfo = {
  account?: string;
  ledger_current_index?: number;
  ledger_index?: number;
  validated?: boolean;
  account_data: JsonObject;
};

type AccountLines = {
  account: string;
  ledger_index?: number;
  validated?: boolean;
  lines: Array<JsonObject & { currency: string; balance: string }>;
  marker?: unknown;
};

type AccountObjects = {
  account: string;
  ledger_index?: number;
  validated?: boolean;
  account_objects: JsonObject[];
  marker?: unknown;
};

type AccountTransactions = {
  account: string;
  ledger_index_min: number;
  ledger_index_max: number;
  transactions: AccountTransaction[];
};

type AmmInfo = {
  network: Network;
  ledger_index: number;
  amm: JsonObject;
};

export type PortfolioSnapshot = {
  network: Network;
  mode: "mock" | "live";
  account: string;
  ledgerIndex: number;
  asOf: string;
  asOfBasis: string;
  balances: PortfolioBalance[];
  totalUsd: number | null;
  changeUsd: number | null;
  changePercent: number | null;
  offers: PortfolioOffer[];
  lpPositions: PortfolioPosition[];
  vaultPositions: PortfolioPosition[];
  delegation: AccountLink;
  policy: Policy;
  dailySpendUsd: number | null;
  feed: FeedItem[];
  coverage: {
    balances: "complete" | "partial";
    offers: "complete" | "partial";
    unsupportedOfferCount: number;
    reasons: string[];
  };
  feedProvenance: string;
};

export type BrowserHarborClient = {
  op(name: string, args: Record<string, unknown>): Promise<unknown>;
};

export const QuickNodeStatusSchema = z
  .object({
    mode: z.enum(["off", "mock", "live"]),
    rpc: z
      .object({
        calls_quicknode: z.number().int().nonnegative(),
        calls_fallback: z.number().int().nonnegative(),
        share: z.number().finite().min(0).max(1),
      })
      .strict(),
    webhook: z
      .object({
        confirmations: z.number().int().nonnegative(),
        last_at: z.string().datetime().nullable(),
      })
      .strict(),
    watchdog: z
      .object({
        ledgers_seen: z.number().int().nonnegative(),
        last_ledger: z.number().int().nonnegative().nullable(),
        events: z.number().int().nonnegative(),
        frozen_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type QuickNodeStatus = z.infer<typeof QuickNodeStatusSchema>;

export const demoQuickNodeStatus: QuickNodeStatus = {
  mode: "mock",
  rpc: {
    calls_quicknode: 42,
    calls_fallback: 8,
    share: 0.84,
  },
  webhook: {
    confirmations: 7,
    last_at: "2026-10-21T12:04:20.000Z",
  },
  watchdog: {
    ledgers_seen: 128,
    last_ledger: 9_843_207,
    events: 1,
    frozen_count: 1,
  },
};

type PortfolioReadSet = {
  accountInfo: HarborEnvelope<AccountInfo>;
  lines: HarborEnvelope<AccountLines>;
  objects: HarborEnvelope<AccountObjects>;
  transactions: HarborEnvelope<AccountTransactions>;
  delegation: HarborEnvelope<AccountLink>;
  policy: HarborEnvelope<Policy>;
  vaultPositions?: HarborEnvelope<VaultPositionsResult>;
  pagination?: {
    linesComplete: boolean;
    objectsComplete: boolean;
    vaultsComplete?: boolean;
    reasons: string[];
  };
};

const ACCOUNT_PAGE_LIMIT = 400;
const MAX_ACCOUNT_PAGES = 8;
const MAX_ACCOUNT_ITEMS = ACCOUNT_PAGE_LIMIT * MAX_ACCOUNT_PAGES;

function record(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown, fallback = "0"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(stringValue(value, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedCurrency(currency: string): string {
  if (!/^[A-Fa-f0-9]{40}$/.test(currency)) return currency;
  let decoded = "";
  for (let index = 0; index < currency.length; index += 2) {
    const code = Number.parseInt(currency.slice(index, index + 2), 16);
    if (code !== 0) decoded += String.fromCharCode(code);
  }
  return decoded.trim() || currency.toUpperCase();
}

function compactAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 7)}…${address.slice(-6)}` : address;
}

function fixture<T>(name: keyof typeof harborReads): HarborEnvelope<T> {
  const value = harborReads[name];
  if (!value || value.ok !== true) throw new Error(`Missing Harbor mock fixture: ${name}`);
  return value as unknown as HarborEnvelope<T>;
}

function requireOk<T>(envelope: HarborEnvelope<T>, operation: string) {
  if (!envelope.ok) {
    throw new Error(envelope.error.message ?? `${operation} did not return data`);
  }
  return envelope;
}

function amountFromLedgerValue(value: unknown): {
  amount: number;
  assetLabel: string;
  displayAmount: string;
  native: boolean;
} | undefined {
  if (typeof value === "string") {
    const amount = numberValue(value) / 1_000_000;
    if (amount <= 0) return undefined;
    return {
      amount,
      assetLabel: "XRP",
      displayAmount: amount.toLocaleString("en-US", { maximumFractionDigits: 6 }),
      native: true,
    };
  }
  const issued = record(value);
  if (!issued) return undefined;
  const amount = numberValue(issued.value);
  const symbol = normalizedCurrency(stringValue(issued.currency, "Issued"));
  const issuer = stringValue(issued.issuer, "");
  if (
    amount <= 0 ||
    symbol.length === 0 ||
    !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer)
  ) return undefined;
  return {
    amount,
    assetLabel: `${symbol} (${compactAddress(issuer)})`,
    displayAmount: amount.toLocaleString("en-US", { maximumFractionDigits: 6 }),
    native: false,
  };
}

function offerFromObject(value: JsonObject): PortfolioOffer | undefined {
  if (value.LedgerEntryType !== "Offer") return undefined;
  const gets = amountFromLedgerValue(value.TakerGets);
  const pays = amountFromLedgerValue(value.TakerPays);
  if (!gets || !pays) return undefined;
  const getsXrp = gets.native;
  const paysXrp = pays.native;
  const price = getsXrp
    ? `${(pays.amount / gets.amount).toFixed(6)} ${pays.assetLabel}/XRP`
    : paysXrp
      ? `${(gets.amount / pays.amount).toFixed(6)} ${gets.assetLabel}/XRP`
      : `${(pays.amount / gets.amount).toFixed(6)} ${pays.assetLabel}/${gets.assetLabel}`;
  return {
    id: stringValue(value.index, `offer-${stringValue(value.Sequence)}`),
    sequence: numberValue(value.Sequence),
    side: getsXrp ? "Sell" : paysXrp ? "Buy" : "Swap",
    quantity: `${gets.displayAmount} ${gets.assetLabel}`,
    receive: `${pays.displayAmount} ${pays.assetLabel}`,
    price,
    status: "Open",
  };
}

function feedFromTransaction(transaction: AccountTransaction, network: Network): FeedItem {
  const tx = transaction.tx_json ?? transaction.tx ?? {};
  const hash = transaction.hash ?? stringValue(tx.hash, `ledger-${transaction.ledger_index ?? "unknown"}`);
  const transactionType = stringValue(tx.TransactionType, "Transaction");
  const succeeded = record(transaction.meta)?.TransactionResult === "tesSUCCESS";
  return {
    id: hash,
    title: transactionType === "OfferCreate" ? "Offer transaction" : transactionType,
    detail: succeeded
      ? `Validated on XRPL ${network.replace("-", " ")}`
      : "Ledger result available",
    time: "Just now",
    state: succeeded ? "executed" : "info",
    hash,
  };
}

function balancesFromReads(
  info: AccountInfo,
  lines: AccountLines,
  stableAsset: PortfolioContext["stableAsset"],
  fixtureXrpUsd?: number,
): PortfolioBalance[] {
  const xrp = numberValue(info.account_data.Balance) / 1_000_000;
  const balances: PortfolioBalance[] = [{
    id: "xrp",
    symbol: "XRP",
    name: "XRP Ledger",
    amount: xrp,
    usdValue: fixtureXrpUsd === undefined ? null : xrp * fixtureXrpUsd,
    availabilityNote: fixtureXrpUsd === undefined
      ? "Ledger balance · XRP reserve not deducted"
      : "Demo balance",
    accent: "aqua",
  }];
  for (const line of lines.lines) {
    // XRPL AMM LP token trust lines are rendered as positions below, not as
    // ordinary spendable balances.
    if (/^03[A-Fa-f0-9]{38}$/.test(line.currency)) continue;
    const amount = numberValue(line.balance);
    const symbol = normalizedCurrency(line.currency);
    const issuer = stringValue(line.account, "unknown-issuer");
    const stable = symbol === normalizedCurrency(stableAsset.currency) && issuer === stableAsset.issuer;
    balances.push({
      id: `${line.currency}:${issuer}`,
      symbol,
      name: stable && symbol === "RLUSD" ? "Ripple USD" : symbol,
      amount,
      usdValue: stable ? amount : null,
      availabilityNote: fixtureXrpUsd === undefined
        ? "Ledger balance · freeze/auth limits not deducted"
        : "Demo balance",
      accent: "violet",
    });
  }
  return balances;
}

function lpPositionsFromLines(
  lines: AccountLines,
  network: Network,
  complete: boolean,
): PortfolioPosition[] {
  const lpLines = lines.lines.filter((line) =>
    /^03[A-Fa-f0-9]{38}$/.test(line.currency) && numberValue(line.balance) !== 0
  );
  if (lpLines.length === 0) {
    if (!complete) {
      return [{
        id: "lp-position-partial",
        title: "AMM liquidity position",
        subtitle: "No LP token was found in the loaded trust-line prefix; the read is incomplete",
        network,
        amount: "Unknown",
        usdValue: null,
        yield: "—",
        fixtureLabel: "Partial live ledger.account.lines read",
        available: false,
      }];
    }
    return [{
      id: "lp-position-empty",
      title: "AMM liquidity position",
      subtitle: "No non-zero AMM LP token balance was found",
      network,
      amount: "None found",
      usdValue: null,
      yield: "—",
      fixtureLabel: "Live ledger.account.lines read",
      available: true,
    }];
  }
  return lpLines.map((lpLine) => {
    const issuer = stringValue(lpLine.account, "Unknown issuer");
    return {
      id: `${lpLine.currency}:${issuer}`,
      title: "AMM liquidity position",
      subtitle: `LP token issuer ${compactAddress(issuer)}`,
      network,
      amount: `${numberValue(lpLine.balance).toLocaleString("en-US", { maximumFractionDigits: 8 })} LP`,
      usdValue: null,
      yield: "—",
      fixtureLabel: complete
        ? "Live ledger.account.lines read"
        : "Partial live ledger.account.lines read · additional LP positions may be missing",
      available: true,
    };
  });
}

function unavailablePosition(kind: "lp" | "vault", network: Network): PortfolioPosition {
  return {
    id: `${kind}-position-unavailable`,
    title: kind === "lp" ? "AMM liquidity position" : "Single Asset Vault position",
    subtitle: "No compatible Harbor position operation is available",
    network,
    amount: "Unavailable",
    usdValue: null,
    yield: "—",
    fixtureLabel: "Live position read unavailable",
    available: false,
  };
}

function vaultAssetLabel(asset: HarborVaultPosition["asset"]): string {
  if ("mpt_issuance_id" in asset) {
    return `MPT ${asset.mpt_issuance_id.slice(0, 8)}…${asset.mpt_issuance_id.slice(-6)}`;
  }
  if ("issuer" in asset) {
    return `${normalizedCurrency(asset.currency)} (${compactAddress(asset.issuer)})`;
  }
  return "XRP";
}

function formatScaledUint64(value: string, scale: number): string {
  if (scale === 0) return value;
  const padded = value.padStart(scale + 1, "0");
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function vaultPositionsFromRead(
  read: VaultPositionsResult | undefined,
  network: Network,
  complete: boolean,
): PortfolioPosition[] {
  if (!read) return [unavailablePosition("vault", network)];
  if (read.positions.length === 0) {
    return [{
      id: "vault-position-empty",
      title: "Single Asset Vault position",
      subtitle: complete
        ? "No non-zero vault share balance was found"
        : "No position was found in the loaded vault-position prefix; the read is incomplete",
      network,
      amount: complete ? "None found" : "Unknown",
      usdValue: null,
      yield: "—",
      fixtureLabel: complete
        ? "Live owner-scoped vault.positions read"
        : "Partial live owner-scoped vault.positions read",
      available: complete,
    }];
  }
  return read.positions.map((position) => ({
    id: position.vault_id,
    title: `${vaultAssetLabel(position.asset)} Single Asset Vault`,
    subtitle: `Vault ${compactAddress(position.vault_account)} · owner-scoped ledger position`,
    network,
    amount: `${formatScaledUint64(position.share_balance, position.share_asset_scale)} vault shares${position.locked_balance === undefined ? "" : ` · ${formatScaledUint64(position.locked_balance, position.share_asset_scale)} locked`}`,
    usdValue: null,
    yield: "—",
    fixtureLabel: complete
      ? "Live owner-scoped vault.positions read"
      : "Partial live owner-scoped vault.positions read · additional positions may be missing",
    available: true,
  }));
}

export function buildLivePortfolioSnapshot(
  context: PortfolioContext,
  reads: PortfolioReadSet,
): PortfolioSnapshot {
  const accountInfoEnvelope = requireOk(reads.accountInfo, "ledger.account.info");
  const linesEnvelope = requireOk(reads.lines, "ledger.account.lines");
  const objectsEnvelope = requireOk(reads.objects, "ledger.account.objects");
  const txEnvelope = requireOk(reads.transactions, "ledger.account.tx");
  const delegationEnvelope = requireOk(reads.delegation, "account.status");
  const policyEnvelope = requireOk(reads.policy, "policy.get");
  const account = stringValue(accountInfoEnvelope.data.account_data.Account, "");
  const pinnedLedger = accountInfoEnvelope.data.ledger_index;
  if (
    account !== context.budgetAccount ||
    linesEnvelope.data.account !== context.budgetAccount ||
    objectsEnvelope.data.account !== context.budgetAccount ||
    txEnvelope.data.account !== context.budgetAccount
  ) {
    throw new Error("Harbor returned portfolio data for a different account");
  }
  if (
    accountInfoEnvelope.data.validated !== true ||
    !Number.isSafeInteger(pinnedLedger) ||
    (pinnedLedger ?? 0) < 1
  ) {
    throw new Error("Harbor account snapshot is not from a validated ledger");
  }
  if (
    linesEnvelope.data.validated !== true ||
    objectsEnvelope.data.validated !== true ||
    linesEnvelope.data.ledger_index !== pinnedLedger ||
    objectsEnvelope.data.ledger_index !== pinnedLedger
  ) {
    throw new Error("Harbor portfolio reads do not share the pinned validated ledger");
  }
  const delegation = AccountLinkSchema.parse(delegationEnvelope.data);
  if (delegation.owner !== context.budgetAccount || delegation.network !== context.network) {
    throw new Error("Harbor returned delegation data for a different owner or network");
  }
  if (delegation.status === "revoked" && delegation.permissions.length !== 0) {
    throw new Error("Harbor returned inconsistent revoked delegation permissions");
  }
  const balances = balancesFromReads(
    accountInfoEnvelope.data,
    linesEnvelope.data,
    context.stableAsset,
  );
  const knownValues = balances
    .map((balance) => balance.usdValue)
    .filter((value): value is number => value !== null);
  const offerObjects = objectsEnvelope.data.account_objects;
  const offers = offerObjects
    .map(offerFromObject)
    .filter((offer): offer is PortfolioOffer => offer !== undefined);
  const unsupportedOfferCount = offerObjects.length - offers.length;
  const pagination = reads.pagination ?? {
    linesComplete: true,
    objectsComplete: true,
    vaultsComplete: false,
    reasons: [],
  };
  const coverageReasons = [...pagination.reasons];
  if (unsupportedOfferCount > 0) {
    coverageReasons.push(
      `${unsupportedOfferCount} offer${unsupportedOfferCount === 1 ? " was" : "s were"} not rendered because its ledger amounts were unsupported.`,
    );
  }

  return {
    network: context.network,
    mode: "live",
    account,
    ledgerIndex: pinnedLedger!,
    asOf: accountInfoEnvelope.asOf,
    asOfBasis: accountInfoEnvelope.asOfBasis,
    balances,
    // Harbor's account reads do not include a live XRP/USD price. A partial
    // portfolio total would look authoritative, so live mode omits it.
    totalUsd: balances.every((balance) => balance.usdValue !== null)
      ? knownValues.reduce((sum, value) => sum + value, 0)
      : null,
    changeUsd: null,
    changePercent: null,
    offers,
    lpPositions: lpPositionsFromLines(
      linesEnvelope.data,
      context.network,
      pagination.linesComplete,
    ),
    vaultPositions: vaultPositionsFromRead(
      reads.vaultPositions?.ok ? reads.vaultPositions.data : undefined,
      context.network,
      pagination.vaultsComplete === true,
    ),
    delegation,
    policy: PolicySchema.parse(policyEnvelope.data),
    dailySpendUsd: null,
    feed: txEnvelope.data.transactions
      .filter((transaction) => transaction.validated)
      .slice(0, 8)
      .map((transaction) => feedFromTransaction(transaction, context.network)),
    coverage: {
      balances: pagination.linesComplete ? "complete" : "partial",
      offers: pagination.objectsComplete && unsupportedOfferCount === 0 ? "complete" : "partial",
      unsupportedOfferCount,
      reasons: coverageReasons,
    },
    feedProvenance:
      "Recent validated ledger.account.tx entries were fetched independently from the pinned balance and offer ledger.",
  };
}

async function harborRead<T>(
  client: BrowserHarborClient,
  operation: string,
  args: Record<string, unknown>,
): Promise<HarborEnvelope<T>> {
  return (await client.op(operation, args)) as HarborEnvelope<T>;
}

/** Strict, read-only projection of Harbor's QN-2 status operation. */
export async function fetchQuickNodeStatus(
  client: BrowserHarborClient,
): Promise<QuickNodeStatus> {
  const envelope = requireOk(
    await harborRead<unknown>(client, "quicknode.status", {}),
    "quicknode.status",
  );
  return QuickNodeStatusSchema.parse(envelope.data);
}

type PageMarker = string | number | JsonObject;

type MarkerCheck =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; marker: PageMarker; key: string };

function canonicalMarkerValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 8) throw new Error("marker is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("marker contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("marker is cyclic");
    seen.add(value);
    const normalized = value.map((item) => canonicalMarkerValue(item, seen, depth + 1));
    seen.delete(value);
    return normalized;
  }
  const object = record(value);
  if (!object || seen.has(object)) throw new Error("marker is not a JSON object");
  seen.add(object);
  const normalized = Object.fromEntries(
    Object.keys(object).sort().map((key) => [
      key,
      canonicalMarkerValue(object[key], seen, depth + 1),
    ]),
  );
  seen.delete(object);
  return normalized;
}

function checkMarker(marker: unknown): MarkerCheck {
  if (marker === undefined) return { kind: "none" };
  if (typeof marker === "string") {
    if (marker.length === 0 || marker.length > 4_096) return { kind: "invalid" };
    return { kind: "valid", marker, key: `s:${marker}` };
  }
  if (typeof marker === "number") {
    if (!Number.isSafeInteger(marker) || marker < 0) return { kind: "invalid" };
    return { kind: "valid", marker, key: `n:${marker}` };
  }
  const object = record(marker);
  if (!object) return { kind: "invalid" };
  try {
    const serialized = JSON.stringify(canonicalMarkerValue(object, new WeakSet(), 0));
    if (serialized.length > 4_096) return { kind: "invalid" };
    return { kind: "valid", marker: object, key: `o:${serialized}` };
  } catch {
    return { kind: "invalid" };
  }
}

type PagedRead<T> = {
  envelope: HarborEnvelope<T>;
  complete: boolean;
  reason?: string;
};

type VaultPagedRead = {
  envelope?: HarborEnvelope<VaultPositionsResult>;
  complete: boolean;
  reason?: string;
};

const VAULT_POSITION_PAGE_LIMIT = 100;
const MAX_VAULT_POSITION_PAGES = 8;

async function fetchVaultPositionPages(
  client: BrowserHarborClient,
  context: PortfolioContext,
  ledgerIndex: number,
): Promise<VaultPagedRead> {
  if (context.network !== "devnet" && context.network !== "lending-devnet") {
    return {
      complete: false,
      reason: `vault.positions is unavailable on XRPL ${context.network.replace("-", " ")}`,
    };
  }
  let firstEnvelope: Extract<HarborEnvelope<VaultPositionsResult>, { ok: true }> | undefined;
  let marker: string | undefined;
  const seenMarkers = new Set<string>();
  const positions: HarborVaultPosition[] = [];

  const partial = (reason: string): VaultPagedRead => ({
    ...(firstEnvelope
      ? { envelope: { ...firstEnvelope, data: { ...firstEnvelope.data, positions, marker: undefined } } }
      : {}),
    complete: false,
    reason,
  });

  for (let page = 0; page < MAX_VAULT_POSITION_PAGES; page += 1) {
    let envelope: HarborEnvelope<unknown>;
    try {
      envelope = await harborRead<unknown>(client, "vault.positions", {
        account: context.budgetAccount,
        network: context.network,
        ledger_index: ledgerIndex,
        limit: VAULT_POSITION_PAGE_LIMIT,
        ...(marker === undefined ? {} : { marker }),
      });
    } catch {
      return partial(
        `vault.positions stopped after ${page} page${page === 1 ? "" : "s"}: request failed`,
      );
    }
    if (!envelope.ok) {
      return partial(
        `vault.positions stopped after ${page} page${page === 1 ? "" : "s"}: request failed`,
      );
    }
    const parsed = VaultPositionsResponseSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return partial("vault.positions returned a response outside the strict public schema");
    }
    const data = parsed.data;
    if (
      data.account !== context.budgetAccount ||
      data.network !== context.network ||
      data.ledger_index !== ledgerIndex ||
      (firstEnvelope !== undefined &&
        data.ledger_hash.toUpperCase() !== firstEnvelope.data.ledger_hash.toUpperCase()) ||
      data.validated !== true
    ) {
      return partial("vault.positions returned data outside the owner, network, or pinned ledger");
    }
    const typedEnvelope = { ...envelope, data };
    if (!firstEnvelope) firstEnvelope = typedEnvelope;
    positions.push(...data.positions);
    marker = data.marker;
    if (marker === undefined) {
      return {
        envelope: { ...firstEnvelope, data: { ...firstEnvelope.data, positions, marker: undefined } },
        complete: true,
      };
    }
    if (seenMarkers.has(marker)) {
      return partial("vault.positions returned a repeated continuation handle");
    }
    seenMarkers.add(marker);
  }
  return partial(`vault.positions reached the bounded ${MAX_VAULT_POSITION_PAGES}-page read limit`);
}

async function fetchAccountPages<T extends AccountLines | AccountObjects>({
  client,
  context,
  ledgerIndex,
  operation,
  extraArgs,
  getItems,
  mergeItems,
}: {
  client: BrowserHarborClient;
  context: PortfolioContext;
  ledgerIndex: number;
  operation: "ledger.account.lines" | "ledger.account.objects";
  extraArgs?: Record<string, unknown>;
  getItems(data: T): JsonObject[];
  mergeItems(first: T, items: JsonObject[]): T;
}): Promise<PagedRead<T>> {
  let firstEnvelope: Extract<HarborEnvelope<T>, { ok: true }> | undefined;
  let marker: PageMarker | undefined;
  const seenMarkers = new Set<string>();
  const items: JsonObject[] = [];

  const partial = (reason: string): PagedRead<T> => {
    if (!firstEnvelope) throw new Error(`${operation} failed before a validated page was available: ${reason}`);
    return {
      envelope: { ...firstEnvelope, data: mergeItems(firstEnvelope.data, items) },
      complete: false,
      reason,
    };
  };

  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    let envelope: HarborEnvelope<T>;
    try {
      envelope = await harborRead<T>(client, operation, {
        account: context.budgetAccount,
        network: context.network,
        ledger_index: ledgerIndex,
        limit: ACCOUNT_PAGE_LIMIT,
        ...extraArgs,
        ...(marker === undefined ? {} : { marker }),
      });
    } catch (error) {
      return partial(
        `${operation} stopped after ${page} page${page === 1 ? "" : "s"}: ${error instanceof Error ? error.message : "request failed"}`,
      );
    }
    if (!envelope.ok) {
      return partial(
        `${operation} stopped after ${page} page${page === 1 ? "" : "s"}: ${envelope.error.message ?? envelope.error.code ?? "request failed"}`,
      );
    }
    if (envelope.data.account !== context.budgetAccount) {
      throw new Error(`${operation} returned data for a different account`);
    }
    if (envelope.data.validated !== true || envelope.data.ledger_index !== ledgerIndex) {
      return partial(`${operation} stopped because a page did not match validated ledger ${ledgerIndex}`);
    }
    if (!firstEnvelope) firstEnvelope = envelope;

    const pageItems = getItems(envelope.data);
    const remaining = MAX_ACCOUNT_ITEMS - items.length;
    const accepted = pageItems.slice(0, Math.min(ACCOUNT_PAGE_LIMIT, remaining));
    items.push(...accepted);
    if (pageItems.length > accepted.length) {
      return partial(`${operation} exceeded the bounded ${MAX_ACCOUNT_ITEMS}-item read limit`);
    }

    const nextMarker = checkMarker(envelope.data.marker);
    if (nextMarker.kind === "none") {
      return {
        envelope: { ...firstEnvelope, data: mergeItems(firstEnvelope.data, items) },
        complete: true,
      };
    }
    if (nextMarker.kind === "invalid") {
      return partial(`${operation} returned an invalid pagination marker`);
    }
    if (seenMarkers.has(nextMarker.key)) {
      return partial(`${operation} returned a repeated pagination marker`);
    }
    seenMarkers.add(nextMarker.key);
    marker = nextMarker.marker;
  }

  return partial(`${operation} reached the bounded ${MAX_ACCOUNT_PAGES}-page read limit`);
}

/** Refetch supported owner-scoped reads, pinning paginated ledger data to one validated ledger. */
export async function fetchLivePortfolioSnapshot(
  client: BrowserHarborClient,
  context: PortfolioContext,
): Promise<PortfolioSnapshot> {
  const accountArgs = { account: context.budgetAccount, network: context.network, ledger_index: "validated" };
  const ownerArgs = { owner: context.budgetAccount, network: context.network };
  const [accountInfo, transactions, delegation, policy] = await Promise.all([
    harborRead<AccountInfo>(client, "ledger.account.info", accountArgs),
    harborRead<AccountTransactions>(client, "ledger.account.tx", { account: context.budgetAccount, network: context.network, limit: 20 }),
    harborRead<AccountLink>(client, "account.status", ownerArgs),
    harborRead<Policy>(client, "policy.get", ownerArgs),
  ]);
  const info = requireOk(accountInfo, "ledger.account.info").data;
  const pinnedLedger = info.ledger_index;
  if (stringValue(info.account_data.Account, "") !== context.budgetAccount) {
    throw new Error("Harbor returned portfolio data for a different account");
  }
  if (
    info.validated !== true ||
    !Number.isSafeInteger(pinnedLedger) ||
    (pinnedLedger ?? 0) < 1
  ) {
    throw new Error("Harbor account snapshot is not bound to the requested owner and a validated ledger");
  }
  const [linesRead, objectsRead, vaultRead] = await Promise.all([
    fetchAccountPages<AccountLines>({
      client,
      context,
      ledgerIndex: pinnedLedger!,
      operation: "ledger.account.lines",
      getItems: (data) => data.lines,
      mergeItems: (first, items) => ({
        ...first,
        lines: items as AccountLines["lines"],
        marker: undefined,
      }),
    }),
    fetchAccountPages<AccountObjects>({
      client,
      context,
      ledgerIndex: pinnedLedger!,
      operation: "ledger.account.objects",
      extraArgs: { type: "offer" },
      getItems: (data) => data.account_objects,
      mergeItems: (first, items) => ({ ...first, account_objects: items, marker: undefined }),
    }),
    fetchVaultPositionPages(client, context, pinnedLedger!),
  ]);
  return buildLivePortfolioSnapshot(context, {
    accountInfo,
    lines: linesRead.envelope,
    objects: objectsRead.envelope,
    transactions,
    delegation,
    policy,
    vaultPositions: vaultRead.envelope,
    pagination: {
      linesComplete: linesRead.complete,
      objectsComplete: objectsRead.complete,
      vaultsComplete: vaultRead.complete,
      reasons: [linesRead.reason, objectsRead.reason, vaultRead.reason]
        .filter((reason): reason is string => Boolean(reason)),
    },
  });
}

/** Explicit fixture loader retained for mock mode and deterministic tests. */
export async function loadPortfolioSnapshot(): Promise<PortfolioSnapshot> {
  const accountInfoEnvelope = requireOk(fixture<AccountInfo>("ledger.account.info"), "ledger.account.info");
  const linesEnvelope = requireOk(fixture<AccountLines>("ledger.account.lines"), "ledger.account.lines");
  const objectsEnvelope = requireOk(fixture<AccountObjects>("ledger.account.objects"), "ledger.account.objects");
  const txEnvelope = requireOk(fixture<AccountTransactions>("ledger.account.tx"), "ledger.account.tx");
  const ammEnvelope = requireOk(fixture<AmmInfo>("amm.info"), "amm.info");
  const policyEnvelope = requireOk(fixture<Policy>("policy.get"), "policy.get");
  const delegationEnvelope = requireOk(fixture<AccountLink>("account.status"), "account.status");
  const balances = balancesFromReads(
    accountInfoEnvelope.data,
    linesEnvelope.data,
    FIXTURE_STABLE_ASSET,
    FIXTURE_XRP_USD,
  );
  const pool = record(ammEnvelope.data.amm);
  const poolXrp = numberValue(pool?.Amount) / 1_000_000;
  const poolIssued = numberValue(record(pool?.Amount2)?.value);
  const poolTvl = poolXrp * FIXTURE_XRP_USD + poolIssued;

  return {
    network: NETWORK,
    mode: "mock",
    account: accountInfoEnvelope.data.account ?? stringValue(accountInfoEnvelope.data.account_data.Account, BUDGET_ACCOUNT),
    ledgerIndex: accountInfoEnvelope.data.ledger_index ?? accountInfoEnvelope.data.ledger_current_index ?? 0,
    asOf: accountInfoEnvelope.asOf,
    asOfBasis: accountInfoEnvelope.asOfBasis,
    balances,
    totalUsd:
      balances.reduce((sum, balance) => sum + (balance.usdValue ?? 0), 0) +
      LOCAL_LP_VALUE_USD + LOCAL_VAULT_VALUE_USD,
    changeUsd: 18.42,
    changePercent: 1.64,
    offers: objectsEnvelope.data.account_objects
      .map(offerFromObject)
      .filter((offer): offer is PortfolioOffer => offer !== undefined),
    lpPositions: [{
      id: "xrpl-amm-xrp-rlusd",
      title: "XRP / RLUSD",
      subtitle: `$${poolTvl.toLocaleString("en-US", { maximumFractionDigits: 0 })} pool TVL`,
      network: "testnet",
      amount: "1,359.53 LP",
      usdValue: LOCAL_LP_VALUE_USD,
      yield: "6.84% APR",
      fixtureLabel: "Demo position · simulated",
      available: true,
    }],
    vaultPositions: [{
      id: "xrpl-vault-xrp",
      title: "XRP Single Asset Vault",
      subtitle: "Owner-signed position",
      network: "devnet",
      amount: "100 XRP",
      usdValue: LOCAL_VAULT_VALUE_USD,
      yield: "4.20% APY",
      fixtureLabel: "Demo position · simulated",
      available: true,
    }],
    delegation: AccountLinkSchema.parse(delegationEnvelope.data),
    policy: PolicySchema.parse(policyEnvelope.data),
    dailySpendUsd: 820.48,
    feed: [
      ...txEnvelope.data.transactions.slice(0, 1).map((transaction) => feedFromTransaction(transaction, NETWORK)),
      { id: "mock-feed-amm", title: "AMM deposit executed", detail: "200 RLUSD + 390.625 XRP · delegated", time: "12m", state: "executed" },
      { id: "mock-feed-approval", title: "Vault deposit awaiting approval", detail: "100 XRP · owner signature required", time: "38m", state: "approval" },
      { id: "mock-feed-policy", title: "Daily policy checked", detail: "$820.48 of $5,000 delegated budget used", time: "1h", state: "info" },
    ],
    coverage: {
      balances: "complete",
      offers: "complete",
      unsupportedOfferCount: 0,
      reasons: [],
    },
    feedProvenance: "Simulated demo activity · not from a real account.",
  };
}

export { BUDGET_ACCOUNT as FIXTURE_BUDGET_ACCOUNT };
