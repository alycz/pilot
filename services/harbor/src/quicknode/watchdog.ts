import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { WatchdogEventSchema, type WatchdogEvent } from "../contracts";

const MAX_EVENTS = 256;
const HashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/).transform((value) => value.toUpperCase());
const AccountSchema = z.string().refine(isValidClassicAddress);
const TransactionTypeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
const TransactionResultSchema = z.union([
  z.string().regex(/^(?:tes|tec|tef|tel|tem|ter)[A-Za-z0-9_]{0,61}$/),
  z.literal("unknown"),
]);
const CloseTimeSchema = z.string().max(35).refine(
  (value) => /^\d{1,12}$/.test(value) || z.string().datetime().safeParse(value).success,
  "close_time must be a bounded ledger time",
);
const WatchdogFlagSchema = z.enum([
  "frozen_account",
  "tx_type_not_delegated",
  "issuer_not_allowlisted",
]);
const StreamEventSchema = z
  .object({
    tx_hash: HashSchema,
    account: AccountSchema,
    delegate: AccountSchema.nullable(),
    tx_type: TransactionTypeSchema,
    result: TransactionResultSchema,
    ledger_index: z.number().int().nonnegative(),
    close_time: CloseTimeSchema,
    flags: z.array(WatchdogFlagSchema).max(3).refine(
      (flags) => new Set(flags).size === flags.length,
      "watchdog flags must be unique",
    ),
  })
  .strict();
const StreamPayloadSchema = z.object({ events: z.array(StreamEventSchema).min(1).max(MAX_EVENTS) }).strict();
const NetworkSchema = z.enum(["testnet", "devnet"]);
const ActionSchema = z.enum(["freeze", "alert"]);
const RunTagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);

export type WatchdogStreamEvent = z.infer<typeof StreamEventSchema>;
export type WatchdogStreamPayload = z.infer<typeof StreamPayloadSchema>;
export type WatchdogNetwork = z.infer<typeof NetworkSchema>;
export type WatchdogAction = z.infer<typeof ActionSchema>;

export type WatchdogRegistry = Readonly<{
  freeze(
    network: WatchdogNetwork,
    account: string,
    frozen: boolean,
  ): Promise<{ ok: boolean; skipped: boolean }>;
}>;

/** The configured AP4M/x402 runtime supplies this without exposing its key. */
export type WatchdogPayerAuthority = Readonly<{
  isPayer(account: string, network: WatchdogNetwork): Promise<boolean>;
  ownsTransaction(hash: string): Promise<boolean>;
  disable(account: string, reason: string, at: string): Promise<boolean>;
}>;

export type ProcessWatchdogOptions = Readonly<{
  receivedAt: string;
  network: WatchdogNetwork;
  action: WatchdogAction;
  runTag: string;
  registry?: WatchdogRegistry;
  payer?: WatchdogPayerAuthority;
}>;

export type ProcessWatchdogResult = Readonly<{
  events: readonly WatchdogEvent[];
  inserted: number;
  newlyFrozen: number;
}>;

type LinkMatch = {
  id: string;
  owner: string;
  frozen_at: string | null;
};

type StoredEvent = {
  tx_hash: string;
  account: string;
  delegate: string | null;
  class: WatchdogEvent["class"];
  flags_json: string;
  ledger_index: number;
  close_time: string;
  action: WatchdogEvent["action"];
};

function changed(result: D1Result): number {
  return Number(result.meta.changes ?? 0);
}

export function parseWatchdogStreamPayload(value: unknown): WatchdogStreamPayload {
  return StreamPayloadSchema.parse(value);
}

async function executionExists(db: D1Database, hash: string): Promise<boolean> {
  return (await db
    .prepare("SELECT 1 AS present FROM executions WHERE hash = ? LIMIT 1")
    .bind(hash)
    .first<{ present: number }>())?.present === 1;
}

async function linkForDelegate(
  db: D1Database,
  event: WatchdogStreamEvent,
  network: WatchdogNetwork,
): Promise<LinkMatch | undefined> {
  if (!event.delegate) return undefined;
  const rows = await db
    .prepare(
      `SELECT id, owner, frozen_at FROM links
        WHERE network = ? AND owner = ? AND delegate = ?
          AND status <> 'revoked' AND revoke_tx IS NULL
        ORDER BY id LIMIT 2`,
    )
    .bind(network, event.account, event.delegate)
    .all<LinkMatch>();
  return rows.results.length === 1 ? rows.results[0] : undefined;
}

async function isBudgetAccount(
  db: D1Database,
  account: string,
  network: WatchdogNetwork,
): Promise<boolean> {
  return (await db
    .prepare(
      `SELECT 1 AS present FROM links
        WHERE network = ? AND owner = ?
          AND status <> 'revoked' AND revoke_tx IS NULL
        LIMIT 1`,
    )
    .bind(network, account)
    .first<{ present: number }>())?.present === 1;
}

async function classify(
  db: D1Database,
  event: WatchdogStreamEvent,
  network: WatchdogNetwork,
  payer: WatchdogPayerAuthority | undefined,
): Promise<{ classification: WatchdogEvent["class"]; link?: LinkMatch } | undefined> {
  const link = await linkForDelegate(db, event, network);
  if (link) {
    return {
      classification: await executionExists(db, event.tx_hash)
        ? "harbor"
        : "out_of_band_delegate",
      link,
    };
  }
  if (!event.delegate && await isBudgetAccount(db, event.account, network)) {
    return { classification: "owner" };
  }
  if (payer && await payer.isPayer(event.account, network)) {
    return {
      classification: await payer.ownsTransaction(event.tx_hash)
        ? "harbor"
        : "out_of_band_payer",
    };
  }
  return undefined;
}

function publicEvent(row: StoredEvent): WatchdogEvent {
  const outOfBand =
    row.class === "out_of_band_delegate" ||
    row.class === "out_of_band_payer";
  return WatchdogEventSchema.parse({
    tx_hash: row.tx_hash,
    account: row.account,
    ...(row.delegate ? { delegate: row.delegate } : {}),
    class: row.class,
    flags: z.array(WatchdogFlagSchema).max(3).refine(
      (flags) => new Set(flags).size === flags.length,
      "watchdog flags must be unique",
    ).parse(JSON.parse(row.flags_json) as unknown),
    ledger_index: row.ledger_index,
    close_time: row.close_time,
    action: row.action,
    ...(outOfBand ? { next_step: "owner_revoke_onledger" } : {}),
  });
}

/**
 * Return only events for budget accounts owned by the authenticated principal.
 * Payer-wide events remain internal because they are not owner-authorized.
 */
export async function readQuickNodeWatchdogEvents(
  db: D1Database,
  principal: string,
  account: string | undefined,
  limit: number,
): Promise<readonly WatchdogEvent[]> {
  const rows = await db
    .prepare(
      `SELECT event.tx_hash, event.account, event.delegate, event.class,
              event.flags_json, event.ledger_index, event.close_time, event.action
         FROM qn_watchdog_events AS event
        WHERE (? IS NULL OR event.account = ?)
          AND EXISTS (
            SELECT 1 FROM links
             WHERE links.principal = ?
               AND links.owner = event.account
          )
        ORDER BY event.received_at DESC, event.tx_hash DESC
        LIMIT ?`,
    )
    .bind(account ?? null, account ?? null, principal, limit)
    .all<StoredEvent>();
  return Object.freeze(rows.results.map(publicEvent));
}

async function readStoredEvent(db: D1Database, hash: string): Promise<WatchdogEvent | undefined> {
  const row = await db
    .prepare(
      `SELECT tx_hash, account, delegate, class, flags_json,
              ledger_index, close_time, action
         FROM qn_watchdog_events WHERE tx_hash = ?`,
    )
    .bind(hash)
    .first<StoredEvent>();
  return row ? publicEvent(row) : undefined;
}

async function claimEvent(
  db: D1Database,
  event: WatchdogStreamEvent,
  classification: WatchdogEvent["class"],
  action: WatchdogEvent["action"],
  receivedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO qn_watchdog_events
        (tx_hash, account, delegate, class, flags_json, ledger_index,
         close_time, action, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.tx_hash,
      event.account,
      event.delegate,
      classification,
      JSON.stringify(event.flags),
      event.ledger_index,
      event.close_time,
      action,
      receivedAt,
    )
    .run();
  return changed(result) === 1;
}

async function freezeDelegate(
  db: D1Database,
  link: LinkMatch,
  hash: string,
  receivedAt: string,
): Promise<{ success: boolean; newlyFrozen: boolean }> {
  if (link.frozen_at !== null) return { success: true, newlyFrozen: false };
  const result = await db
    .prepare(
      `UPDATE links SET frozen_at = ?, frozen_reason = ?
        WHERE id = ? AND owner = ? AND frozen_at IS NULL`,
    )
    .bind(receivedAt, `quicknode:${hash}`, link.id, link.owner)
    .run();
  const didChange = changed(result) === 1;
  return { success: didChange, newlyFrozen: didChange };
}

async function setStoredAction(
  db: D1Database,
  hash: string,
  action: WatchdogEvent["action"],
): Promise<void> {
  await db
    .prepare("UPDATE qn_watchdog_events SET action = ? WHERE tx_hash = ?")
    .bind(action, hash)
    .run();
}

async function updateCounters(
  db: D1Database,
  runTag: string,
  ledgerIndex: number,
  inserted: number,
  newlyFrozen: number,
  receivedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO qn_rpc_counters
        (run_tag, watchdog_ledgers_seen, watchdog_last_ledger,
         watchdog_events, watchdog_frozen_count, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(run_tag) DO UPDATE SET
        watchdog_ledgers_seen = watchdog_ledgers_seen + 1,
        watchdog_last_ledger = MAX(COALESCE(watchdog_last_ledger, 0), excluded.watchdog_last_ledger),
        watchdog_events = watchdog_events + excluded.watchdog_events,
        watchdog_frozen_count = watchdog_frozen_count + excluded.watchdog_frozen_count,
        updated_at = excluded.updated_at`,
    )
    .bind(runTag, ledgerIndex, inserted, newlyFrozen, receivedAt)
    .run();
}

async function applyFreeze(
  db: D1Database,
  event: WatchdogStreamEvent,
  classification: WatchdogEvent["class"],
  link: LinkMatch | undefined,
  options: ProcessWatchdogOptions,
): Promise<boolean> {
  let frozen = { success: false, newlyFrozen: false };
  if (classification === "out_of_band_delegate" && link) {
    frozen = await freezeDelegate(db, link, event.tx_hash, options.receivedAt);
  } else if (classification === "out_of_band_payer" && options.payer) {
    const changedState = await options.payer.disable(
      event.account,
      `quicknode:${event.tx_hash}`,
      options.receivedAt,
    );
    frozen = { success: true, newlyFrozen: changedState };
  }
  if (!frozen.success) return false;

  await setStoredAction(db, event.tx_hash, "frozen");
  if (options.registry) {
    const mutation = await options.registry.freeze(options.network, event.account, true);
    if (!mutation.ok) {
      console.warn("qn_watchdog_kv_failed", {
        evt: "qn_watchdog_kv_failed",
        code: "QN_WATCHDOG_KV_FAILED",
      });
    }
  }
  return frozen.newlyFrozen;
}

/** Classify one verified Streams delivery and apply only Harbor-local actions. */
export async function processQuickNodeWatchdog(
  db: D1Database,
  rawPayload: unknown,
  rawOptions: ProcessWatchdogOptions,
): Promise<ProcessWatchdogResult> {
  const payload = parseWatchdogStreamPayload(rawPayload);
  const receivedAt = z.string().datetime().parse(rawOptions.receivedAt);
  const network = NetworkSchema.parse(rawOptions.network);
  const actionMode = ActionSchema.parse(rawOptions.action);
  const runTag = RunTagSchema.parse(rawOptions.runTag);
  const results: WatchdogEvent[] = [];
  let inserted = 0;
  let newlyFrozen = 0;

  for (const event of payload.events) {
    const classified = await classify(db, event, network, rawOptions.payer);
    if (!classified) continue;
    const violation = classified.classification === "out_of_band_delegate" ||
      classified.classification === "out_of_band_payer";
    const initialAction: WatchdogEvent["action"] = violation ? "alerted" : "none";
    const claimed = await claimEvent(
      db,
      event,
      classified.classification,
      initialAction,
      receivedAt,
    );
    if (!claimed) {
      let existing = await readStoredEvent(db, event.tx_hash);
      if (
        existing?.action === "alerted" &&
        violation &&
        actionMode === "freeze"
      ) {
        newlyFrozen += await applyFreeze(
          db,
          event,
          classified.classification,
          classified.link,
          rawOptions,
        ) ? 1 : 0;
        existing = await readStoredEvent(db, event.tx_hash);
      }
      if (existing) results.push(existing);
      continue;
    }
    inserted += 1;

    if (violation && actionMode === "freeze") {
      newlyFrozen += await applyFreeze(
        db,
        event,
        classified.classification,
        classified.link,
        rawOptions,
      ) ? 1 : 0;
    }
    const stored = await readStoredEvent(db, event.tx_hash);
    if (stored) results.push(stored);
  }

  const lastLedger = payload.events.reduce(
    (maximum, event) => Math.max(maximum, event.ledger_index),
    0,
  );
  await updateCounters(db, runTag, lastLedger, inserted, newlyFrozen, receivedAt);
  return { events: results, inserted, newlyFrozen };
}
