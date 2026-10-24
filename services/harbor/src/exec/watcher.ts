import type { DelegateSet } from "xrpl";

import { requestXrpl, type XrplRpc, type XrplRpcEnv } from "../adapters/xrpl-rpc";
import type { Network } from "../contracts";
import { prepareDelegateRevoke } from "./delegation";
import { createXrplDelegationLedgerAdapter } from "../ops/account";

const ACCOUNT_TX_LIMIT = 200;
const MAX_ACCOUNT_TX_PAGES = 100;
const UINT32_MAX = 0xffff_ffff;
const TRANSACTION_HASH = /^[A-Fa-f0-9]{64}$/;
const SENSITIVE_FRAGMENT = /seed|secret|private|mnemonic/i;

export interface WatchedLink {
  id: string;
  principal: string;
  owner: string;
  network: Network;
  delegate: string;
  status: "active" | "suspended";
  lastLedger: number | null;
}

export interface ForeignTransaction {
  hash: string;
  ledgerIndex: number;
  transactionType: string | null;
  delegate: string;
}

export interface AccountTxPage {
  transactions: ForeignTransaction[];
  ledgerIndexMax: number | null;
  marker?: unknown;
}

export interface WatcherLedger {
  accountTransactions(link: WatchedLink, marker?: unknown): Promise<AccountTxPage>;
  prepareRevoke(link: WatchedLink): Promise<DelegateSet>;
}

export interface QuarantineResult {
  quarantined: boolean;
  eventsInserted: number;
}

export interface WatcherStore {
  listWatchedLinks(): Promise<WatchedLink[]>;
  hasExecutionHash(principal: string, hash: string): Promise<boolean>;
  quarantine(
    link: WatchedLink,
    transactions: readonly ForeignTransaction[],
    revoke: DelegateSet | null,
    lastLedger: number,
    eventIds: readonly string[],
    createdAt: string,
  ): Promise<QuarantineResult>;
  advanceLastLedger(link: WatchedLink, lastLedger: number): Promise<boolean>;
}

export interface WatcherOptions {
  db?: D1Database;
  env?: XrplRpcEnv;
  xrplRpc?: XrplRpc;
  store?: WatcherStore;
  ledger?: WatcherLedger;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface WatcherRunResult {
  linksScanned: number;
  linksSuspended: number;
  eventsInserted: number;
  linksAdvanced: number;
  linksSkipped: number;
  linksFailed: number;
}

type RawWatchedLink = {
  id: string;
  principal: string;
  owner: string;
  network: string;
  delegate: string;
  status: string;
  last_ledger: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLedgerIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= UINT32_MAX;
}

function isExecutionNetwork(network: Network): network is "testnet" | "devnet" {
  return network === "testnet" || network === "devnet";
}

function readNetwork(value: string): Network {
  if (value === "mainnet" || value === "testnet" || value === "devnet" || value === "lending-devnet") {
    return value;
  }
  throw new Error("Active link has an invalid network");
}

function validateLink(row: RawWatchedLink): WatchedLink {
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.principal !== "string" ||
    row.principal.length === 0 ||
    typeof row.owner !== "string" ||
    row.owner.length === 0 ||
    typeof row.delegate !== "string" ||
    row.delegate.length === 0 ||
    (row.status !== "active" && row.status !== "suspended") ||
    (row.last_ledger !== null && !isLedgerIndex(row.last_ledger))
  ) {
    throw new Error("Watched link row is malformed");
  }
  return {
    id: row.id,
    principal: row.principal,
    owner: row.owner,
    network: readNetwork(row.network),
    delegate: row.delegate,
    status: row.status,
    lastLedger: row.last_ledger,
  };
}

function transactionJson(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(entry.tx_json)) return entry.tx_json;
  if (isRecord(entry.tx)) return entry.tx;
  return null;
}

/**
 * Normalize only the documented account_tx fields the watcher needs. The
 * request range, forward pagination, marker, validated flag, hash,
 * ledger_index, and tx_json response fields are documented here:
 * https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_tx
 */
export function parseAccountTxPage(
  result: Record<string, unknown>,
  owner: string,
): AccountTxPage {
  if (!Array.isArray(result.transactions)) {
    throw new Error("XRPL account_tx returned malformed transactions");
  }

  const transactions = new Map<string, ForeignTransaction>();
  for (const candidate of result.transactions) {
    if (!isRecord(candidate) || typeof candidate.validated !== "boolean") {
      throw new Error("XRPL account_tx returned a malformed transaction entry");
    }
    if (!candidate.validated) continue;
    const tx = transactionJson(candidate);
    if (tx === null || typeof tx.Account !== "string") {
      throw new Error("XRPL account_tx returned a malformed validated transaction");
    }
    if (tx.Account !== owner || tx.Delegate === undefined) {
      continue;
    }
    if (typeof tx.Delegate !== "string" || tx.Delegate.length === 0) {
      throw new Error("XRPL account_tx returned a malformed delegated transaction");
    }
    const hash = typeof candidate.hash === "string" ? candidate.hash : tx.hash;
    const ledgerIndex = candidate.ledger_index ?? tx.ledger_index;
    if (typeof hash !== "string" || !TRANSACTION_HASH.test(hash) || !isLedgerIndex(ledgerIndex)) {
      throw new Error("XRPL account_tx returned a malformed delegated transaction");
    }
    transactions.set(hash.toUpperCase(), {
      hash: hash.toUpperCase(),
      ledgerIndex,
      transactionType: typeof tx.TransactionType === "string" ? tx.TransactionType : null,
      delegate: tx.Delegate,
    });
  }

  const ledgerIndexMax = isLedgerIndex(result.ledger_index_max)
    ? result.ledger_index_max
    : transactions.size > 0
      ? Math.max(...[...transactions.values()].map((transaction) => transaction.ledgerIndex))
      : null;
  return {
    transactions: [...transactions.values()],
    ledgerIndexMax,
    ...(Object.hasOwn(result, "marker") && result.marker !== null
      ? { marker: result.marker }
      : {}),
  };
}

function assertSecretSafeJson(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (SENSITIVE_FRAGMENT.test(value)) throw new Error("Prepared revoke contains sensitive material");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Prepared revoke contains a non-finite number");
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error("Prepared revoke is not JSON-safe");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertSecretSafeJson(item, ancestors);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_FRAGMENT.test(key)) throw new Error("Prepared revoke contains sensitive material");
      assertSecretSafeJson(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validatePreparedRevoke(link: WatchedLink, revoke: DelegateSet): DelegateSet {
  if (
    !isRecord(revoke) ||
    revoke.TransactionType !== "DelegateSet" ||
    revoke.Account !== link.owner ||
    revoke.Authorize !== link.delegate ||
    !Array.isArray(revoke.Permissions) ||
    revoke.Permissions.length !== 0 ||
    Object.hasOwn(revoke, "TxnSignature") ||
    Object.hasOwn(revoke, "Signers") ||
    (typeof revoke.SigningPubKey === "string" && revoke.SigningPubKey.length > 0)
  ) {
    throw new Error("Prepared revoke changed protected DelegateSet fields");
  }
  assertSecretSafeJson(revoke);
  return revoke;
}

function cursorPredicate(link: WatchedLink): { sql: string; values: unknown[] } {
  return link.lastLedger === null
    ? { sql: "last_ledger IS NULL", values: [] }
    : { sql: "last_ledger = ?", values: [link.lastLedger] };
}

export function createD1WatcherStore(db: D1Database): WatcherStore {
  return {
    async listWatchedLinks() {
      // Deliberately omit delegate_seed_enc and iv: a watcher never needs to
      // read, return, or log encrypted key material.
      const result = await db
        .prepare(
          `SELECT id, principal, owner, network, delegate, status, last_ledger
             FROM links
            WHERE status IN (?, ?)
            ORDER BY principal, created_at, id`,
        )
        .bind("active", "suspended")
        .all<RawWatchedLink>();
      return result.results.map(validateLink);
    },

    async hasExecutionHash(principal, hash) {
      const row = await db
        .prepare("SELECT 1 AS present FROM executions WHERE principal = ? AND hash = ? LIMIT 1")
        .bind(principal, hash)
        .first<{ present: number }>();
      return row !== null;
    },

    async quarantine(link, transactions, revoke, lastLedger, eventIds, createdAt) {
      if (transactions.length === 0 || transactions.length !== eventIds.length) {
        return { quarantined: false, eventsInserted: 0 };
      }
      const cursor = cursorPredicate(link);
      const statements: D1PreparedStatement[] = transactions.map((transaction, index) => {
        const detail = JSON.stringify({
          hash: transaction.hash,
          ledger_index: transaction.ledgerIndex,
          transaction_type: transaction.transactionType,
          delegate: transaction.delegate,
        });
        return db
          .prepare(
            `INSERT INTO events (id, principal, owner, kind, detail, created_at)
             SELECT ?, ?, ?, 'foreign', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM links
                 WHERE id = ? AND principal = ? AND status = ? AND ${cursor.sql}
              )
                AND NOT EXISTS (
                  SELECT 1 FROM executions WHERE principal = ? AND hash = ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM events
                   WHERE principal = ? AND owner = ? AND kind = 'foreign'
                     AND json_extract(detail, '$.hash') = ?
                )`,
          )
          .bind(
            eventIds[index],
            link.principal,
            link.owner,
            detail,
            createdAt,
            link.id,
            link.principal,
            link.status,
            ...cursor.values,
            link.principal,
            transaction.hash,
            link.principal,
            link.owner,
            transaction.hash,
          );
      });
      const eventPlaceholders = eventIds.map(() => "?").join(", ");
      const eventEvidence = link.status === "active"
        ? `AND EXISTS (
             SELECT 1 FROM events WHERE principal = ? AND id IN (${eventPlaceholders})
           )`
        : "";
      statements.push(
        db
          .prepare(
            `UPDATE links
                SET status = 'suspended',
                    revoke_tx = CASE WHEN status = 'active' THEN ? ELSE revoke_tx END,
                    last_ledger = ?
              WHERE id = ? AND principal = ? AND status = ? AND ${cursor.sql}
                ${eventEvidence}`,
          )
          .bind(
            revoke === null ? null : JSON.stringify(revoke),
            lastLedger,
            link.id,
            link.principal,
            link.status,
            ...cursor.values,
            ...(link.status === "active" ? [link.principal, ...eventIds] : []),
          ),
      );

      // D1 batch statements execute transactionally. Conditional inserts plus
      // the cursor/status compare-and-set make concurrent cron deliveries
      // idempotent and prevent an execution inserted during the scan from
      // being classified as foreign.
      const results = await db.batch(statements);
      const eventResults = results.slice(0, -1);
      const updateResult = results.at(-1);
      return {
        quarantined: link.status === "active" && (updateResult?.meta.changes ?? 0) > 0,
        eventsInserted: eventResults.reduce((total, result) => total + result.meta.changes, 0),
      };
    },

    async advanceLastLedger(link, lastLedger) {
      if (link.lastLedger !== null && lastLedger <= link.lastLedger) return false;
      const cursor = cursorPredicate(link);
      const result = await db
        .prepare(
          `UPDATE links SET last_ledger = ?
            WHERE id = ? AND principal = ? AND status = ? AND ${cursor.sql}`,
        )
        .bind(lastLedger, link.id, link.principal, link.status, ...cursor.values)
        .run();
      return result.meta.changes > 0;
    },
  };
}

export function createXrplWatcherLedger(options: Pick<WatcherOptions, "env" | "xrplRpc"> = {}): WatcherLedger {
  return {
    async accountTransactions(link, marker) {
      // Keep a one-ledger overlap. account_tx bounds are inclusive, and the
      // execution/hash checks make replay harmless; the overlap avoids a gap
      // when activation and the first delegated transaction share a ledger.
      const ledgerIndexMin = link.lastLedger ?? -1;
      const context = {
        principal: link.principal,
        env: options.env ?? {},
        ...(options.xrplRpc ? { xrplRpc: options.xrplRpc } : {}),
      };
      // account_tx range and pagination fields:
      // https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_tx
      const result = await requestXrpl(context, link.network, "account_tx", {
        account: link.owner,
        ledger_index_min: ledgerIndexMin,
        ledger_index_max: -1,
        binary: false,
        forward: true,
        limit: ACCOUNT_TX_LIMIT,
        ...(marker === undefined ? {} : { marker }),
      });
      return parseAccountTxPage(result, link.owner);
    },

    async prepareRevoke(link) {
      const context = {
        principal: link.principal,
        env: options.env ?? {},
        ...(options.xrplRpc ? { xrplRpc: options.xrplRpc } : {}),
      };
      // DelegateSet Account, Authorize and Permissions are defined here; an
      // empty Permissions array deletes the delegation:
      // https://xrpl.org/docs/references/protocol/transactions/types/delegateset
      return prepareDelegateRevoke(
        createXrplDelegationLedgerAdapter(context),
        link.network,
        link.owner,
        link.delegate,
      );
    },
  };
}

async function scanLink(
  link: WatchedLink,
  store: WatcherStore,
  ledger: WatcherLedger,
  now: () => Date,
  randomUUID: () => string,
): Promise<{ suspended: boolean; events: number; advanced: boolean }> {
  const transactions = new Map<string, ForeignTransaction>();
  const seenMarkers = new Set<string>();
  let marker: unknown;
  let safeLedgerMax: number | null = null;

  for (let pageNumber = 0; pageNumber < MAX_ACCOUNT_TX_PAGES; pageNumber += 1) {
    const page = await ledger.accountTransactions(link, marker);
    for (const transaction of page.transactions) transactions.set(transaction.hash, transaction);
    if (page.ledgerIndexMax !== null) {
      safeLedgerMax = safeLedgerMax === null
        ? page.ledgerIndexMax
        : Math.min(safeLedgerMax, page.ledgerIndexMax);
    }
    if (page.marker === undefined) break;
    const markerKey = JSON.stringify(page.marker);
    if (markerKey === undefined || seenMarkers.has(markerKey)) {
      throw new Error("XRPL account_tx returned an invalid pagination marker");
    }
    seenMarkers.add(markerKey);
    marker = page.marker;
    if (pageNumber === MAX_ACCOUNT_TX_PAGES - 1) {
      throw new Error("XRPL account_tx pagination limit exceeded");
    }
  }

  const foreign: ForeignTransaction[] = [];
  for (const transaction of transactions.values()) {
    if (!(await store.hasExecutionHash(link.principal, transaction.hash))) {
      foreign.push(transaction);
    }
  }

  if (foreign.length > 0) {
    let revoke: DelegateSet | null = null;
    try {
      // A suspended link may already have an owner-reviewed revoke transaction.
      // Keep observing it without replacing that transaction or preparing a
      // second one with a different sequence/fee window.
      if (link.status === "active") {
        revoke = validatePreparedRevoke(link, await ledger.prepareRevoke(link));
      }
    } catch {
      // Quarantine is the safety boundary; revoke preparation is advisory and
      // network-dependent. Persist null so a later workflow can prepare it,
      // but never leave a compromised delegation active because RPC failed.
    }
    const lastLedger = Math.max(
      safeLedgerMax ?? 0,
      ...foreign.map((transaction) => transaction.ledgerIndex),
    );
    const result = await store.quarantine(
      link,
      foreign,
      revoke,
      lastLedger,
      foreign.map(() => randomUUID()),
      now().toISOString(),
    );
    return { suspended: result.quarantined, events: result.eventsInserted, advanced: false };
  }

  const advanced = safeLedgerMax !== null && (await store.advanceLastLedger(link, safeLedgerMax));
  return { suspended: false, events: 0, advanced };
}

/** Run one secret-free, read-only-ledger watcher pass across every D1 principal. */
export async function runWatcher(options: WatcherOptions): Promise<WatcherRunResult> {
  const store = options.store ?? (options.db ? createD1WatcherStore(options.db) : undefined);
  if (!store) throw new Error("Watcher store is not configured");
  const ledger = options.ledger ?? createXrplWatcherLedger(options);
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const result: WatcherRunResult = {
    linksScanned: 0,
    linksSuspended: 0,
    eventsInserted: 0,
    linksAdvanced: 0,
    linksSkipped: 0,
    linksFailed: 0,
  };

  const links = await store.listWatchedLinks();
  for (const link of links) {
    // Account delegation and execution are test/devnet-only. In particular,
    // never contact mainnet from the execution watcher, even for preparation.
    if (!isExecutionNetwork(link.network)) {
      result.linksSkipped += 1;
      continue;
    }
    result.linksScanned += 1;
    try {
      const scanned = await scanLink(link, store, ledger, now, randomUUID);
      if (scanned.suspended) result.linksSuspended += 1;
      result.eventsInserted += scanned.events;
      if (scanned.advanced) result.linksAdvanced += 1;
    } catch {
      // One malformed or temporarily unavailable account must not prevent the
      // remaining principals from being checked. Do not log the thrown value:
      // injected transports must never make credentials observable.
      result.linksFailed += 1;
    }
  }
  return result;
}

export const watchForForeignTransactions = runWatcher;
