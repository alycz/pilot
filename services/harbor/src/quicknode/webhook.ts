import { z } from "zod";
import { isValidClassicAddress } from "xrpl";

import { ExecResultSchema, type Confirmation } from "../contracts";

const MAX_DEPTH = 16;
const MAX_VISITED_OBJECTS = 10_000;
const MAX_TRANSACTIONS = 256;

const HashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/).transform((value) => value.toUpperCase());
const TransactionTypeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
const AccountSchema = z.string().refine(isValidClassicAddress);
const TransactionResultSchema = z.union([
  z.string().regex(/^(?:tes|tec|tef|tel|tem|ter)[A-Za-z0-9_]{0,61}$/),
  z.literal("unknown"),
]);
const RunTagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);
const ReceivedAtSchema = z.string().datetime();
const ProviderSchema = z.enum(["quicknode-webhook", "quicknode-mock"]);
const StoredConfirmationProviderSchema = z.enum([
  "quicknode-webhook",
  "quicknode-mock",
  "poll",
]);
const ResultEventSchema = z
  .object({ result: ExecResultSchema })
  .strict();

const EvidenceIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const QuickNodeWebhookEvidenceSchema = z
  .object({
    hash: HashSchema,
    account: AccountSchema,
    delegate: AccountSchema.optional(),
    tx_type: TransactionTypeSchema,
    result: TransactionResultSchema,
    ledger_index: z.number().int().nonnegative(),
    received_at: ReceivedAtSchema,
    execution: z
      .object({
        id: EvidenceIdentifierSchema,
        confirmed_by: z.literal("quicknode-webhook"),
        confirmed_at: ReceivedAtSchema,
        latency_ms: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type QuickNodeWebhookEvidence = z.infer<
  typeof QuickNodeWebhookEvidenceSchema
>;

export type QuickNodeConfirmationProvider = z.infer<typeof ProviderSchema>;

export type QuickNodeWalletTransaction = Readonly<{
  hash: string;
  account: string;
  delegate?: string;
  txType: string;
  result: string;
  ledgerIndex: number;
}>;

export type ProcessQuickNodeWalletWebhookOptions = Readonly<{
  receivedAt: string;
  provider: QuickNodeConfirmationProvider;
  runTag: string;
}>;

export type QuickNodeWalletWebhookResult = Readonly<{
  events: number;
  confirmations: number;
}>;

type ExecutionMatch = {
  id: string;
  principal: string;
  created_at: string;
};

type ConfirmationState = {
  confirmed_by: string | null;
};

type ConfirmationProjectionRow = ExecutionMatch & {
  confirmed_by: string;
  confirmed_at: string;
};

type ResultEventRow = {
  detail: string;
};

type WebhookEvidenceRow = {
  tx_hash: string;
  account: string;
  delegate: string | null;
  tx_type: string;
  result: string;
  ledger_index: number;
  received_at: string;
  execution_id: string;
  execution_created_at: string;
  confirmed_by: string;
  confirmed_at: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ledgerIndex(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}

function transactionResult(
  transaction: Record<string, unknown>,
  wrapper?: Record<string, unknown>,
): string {
  for (const candidate of [
    record(wrapper?.metaData)?.TransactionResult,
    record(wrapper?.meta)?.TransactionResult,
    record(transaction.metaData)?.TransactionResult,
    record(transaction.meta)?.TransactionResult,
  ]) {
		const value = TransactionResultSchema.safeParse(candidate);
		if (value.success) return value.data;
  }
  return "unknown";
}

function normalizedTransaction(
  transaction: Record<string, unknown>,
  wrapper?: Record<string, unknown>,
): QuickNodeWalletTransaction | undefined {
	const hash = HashSchema.safeParse(transaction.hash);
	const txType = TransactionTypeSchema.safeParse(transaction.TransactionType);
	if (!hash.success || !txType.success) return undefined;

	const parsedAccount = AccountSchema.safeParse(transaction.Account);
	const parsedDelegate = AccountSchema.safeParse(transaction.Delegate);
  return {
		hash: hash.data,
		account: parsedAccount.success ? parsedAccount.data : "unknown",
		...(parsedDelegate.success ? { delegate: parsedDelegate.data } : {}),
		txType: txType.data,
    result: transactionResult(transaction, wrapper),
    ledgerIndex: ledgerIndex(
      transaction.ledger_index,
      transaction.ledgerIndex,
      wrapper?.ledger_index,
      wrapper?.ledgerIndex,
    ),
  };
}

/**
 * Collect only the fixed fields required by Harbor from either the flat or
 * nested QuickNode wallet payload. Arbitrary keys and values are deliberately
 * discarded before durable storage or any response is constructed.
 */
export function collectQuickNodeWalletTransactions(
  payload: unknown,
): QuickNodeWalletTransaction[] {
  const transactions = new Map<string, QuickNodeWalletTransaction>();
  const seen = new Set<object>();
  let visited = 0;

  const add = (
    transaction: Record<string, unknown>,
    wrapper?: Record<string, unknown>,
  ): void => {
    if (transactions.size >= MAX_TRANSACTIONS) return;
    const normalized = normalizedTransaction(transaction, wrapper);
    if (normalized && !transactions.has(normalized.hash)) {
      transactions.set(normalized.hash, normalized);
    }
  };

  const visit = (value: unknown, depth: number): void => {
    if (
      depth > MAX_DEPTH ||
      visited >= MAX_VISITED_OBJECTS ||
      transactions.size >= MAX_TRANSACTIONS ||
      typeof value !== "object" ||
      value === null
    ) return;
    if (seen.has(value)) return;
    seen.add(value);
    visited += 1;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const object = value as Record<string, unknown>;
    const nestedTransaction = record(object.transaction);
    if (nestedTransaction) add(nestedTransaction, object);
    add(object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };

  visit(payload, 0);
  return [...transactions.values()];
}

function storedTransaction(transaction: QuickNodeWalletTransaction): string {
  return JSON.stringify({
    hash: transaction.hash,
    Account: transaction.account,
    ...(transaction.delegate ? { Delegate: transaction.delegate } : {}),
    TransactionType: transaction.txType,
    ledger_index: transaction.ledgerIndex,
    metaData: { TransactionResult: transaction.result },
  });
}

function latencyMs(createdAt: string, receivedAt: string): number {
  const created = Date.parse(createdAt);
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(created) || !Number.isFinite(received)) return 0;
  return Math.max(0, Math.round(received - created));
}

async function updateResultEvent(
  db: D1Database,
  execution: ExecutionMatch,
  hash: string,
  confirmation: Confirmation,
): Promise<void> {
  const eventId = `execution-result:${execution.id}`;
  const row = await db
    .prepare(
      `SELECT detail FROM events
        WHERE principal = ? AND id = ? AND kind = 'execution_result'`,
    )
    .bind(execution.principal, eventId)
    .first<ResultEventRow>();
  if (!row) return;

  let detail: unknown;
  try {
    detail = JSON.parse(row.detail) as unknown;
  } catch {
    return;
  }
  const parsed = ResultEventSchema.safeParse(detail);
  if (
    !parsed.success ||
    parsed.data.result.status !== "executed" ||
    parsed.data.result.hash !== hash
  ) return;

  const updated = ResultEventSchema.parse({
    result: { ...parsed.data.result, confirmation },
  });
  await db
    .prepare(
      `UPDATE events SET detail = ?
        WHERE principal = ? AND id = ? AND kind = 'execution_result'`,
    )
    .bind(JSON.stringify(updated), execution.principal, eventId)
    .run();
}

async function confirmExecution(
  db: D1Database,
  execution: ExecutionMatch,
  hash: string,
  provider: QuickNodeConfirmationProvider,
  receivedAt: string,
): Promise<boolean> {
  const before = await db
    .prepare(
      `SELECT confirmed_by FROM executions
        WHERE principal = ? AND id = ? AND hash = ?
          AND status IN ('submitted', 'executed')`,
    )
    .bind(execution.principal, execution.id, hash)
    .first<ConfirmationState>();
  if (!before) {
    return false;
  }
	const confirmation = {
		provider,
		at: receivedAt,
		latency_ms: latencyMs(execution.created_at, receivedAt),
	} satisfies Confirmation;
	if (before.confirmed_by === provider) {
		await updateResultEvent(db, execution, hash, confirmation);
		return false;
	}
	if (before.confirmed_by !== null && before.confirmed_by !== "poll") return false;

  const result = await db
    .prepare(
      `UPDATE executions
          SET confirmed_by = ?, confirmed_at = ?
        WHERE principal = ? AND id = ? AND hash = ?
          AND status IN ('submitted', 'executed')
          AND (confirmed_by IS NULL OR confirmed_by = 'poll')`,
    )
    .bind(provider, receivedAt, execution.principal, execution.id, hash)
    .run();
  if (result.meta.changes !== 1) return false;

	await updateResultEvent(db, execution, hash, confirmation);
  return true;
}

async function updateCounters(
  db: D1Database,
  runTag: string,
  confirmations: number,
  receivedAt: string,
): Promise<void> {
  if (confirmations === 0) return;
  await db
    .prepare(
      `INSERT INTO qn_rpc_counters
        (run_tag, webhook_confirmations, webhook_last_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_tag) DO UPDATE SET
        webhook_confirmations = webhook_confirmations + excluded.webhook_confirmations,
        webhook_last_at = excluded.webhook_last_at,
        updated_at = excluded.updated_at`,
    )
    .bind(runTag, confirmations, receivedAt, receivedAt)
    .run();
}

/**
 * Finish the polling backstop and project the durable winning confirmation.
 * The execute path calls this only after it has created execution_result.
 */
export async function projectExecutionConfirmation(
  db: D1Database,
  input: Readonly<{
    principal: string;
    executionId: string;
    hash: string;
    pollAt: string;
  }>,
): Promise<Confirmation | undefined> {
  const hash = HashSchema.parse(input.hash);
  const pollAt = ReceivedAtSchema.parse(input.pollAt);
  await db
    .prepare(
      `UPDATE executions
          SET confirmed_by = 'poll', confirmed_at = ?
        WHERE principal = ? AND id = ? AND hash = ? AND status = 'executed'
          AND confirmed_by IS NULL`,
    )
    .bind(pollAt, input.principal, input.executionId, hash)
    .run();
  const row = await db
    .prepare(
      `SELECT id, principal, created_at, confirmed_by, confirmed_at
         FROM executions
        WHERE principal = ? AND id = ? AND hash = ? AND status = 'executed'`,
    )
    .bind(input.principal, input.executionId, hash)
    .first<ConfirmationProjectionRow>();
  if (!row) return undefined;
  const provider = StoredConfirmationProviderSchema.safeParse(row.confirmed_by);
  const at = ReceivedAtSchema.safeParse(row.confirmed_at);
  if (!provider.success || !at.success) return undefined;
  const confirmation = {
    provider: provider.data,
    at: at.data,
    latency_ms: latencyMs(row.created_at, at.data),
  } satisfies Confirmation;
  await updateResultEvent(db, row, hash, confirmation);
  return confirmation;
}

/** Persist one verified wallet delivery and attach confirmation provenance. */
export async function processQuickNodeWalletWebhook(
  db: D1Database,
  payload: unknown,
  rawOptions: ProcessQuickNodeWalletWebhookOptions,
): Promise<QuickNodeWalletWebhookResult> {
  const receivedAt = ReceivedAtSchema.parse(rawOptions.receivedAt);
  const provider = ProviderSchema.parse(rawOptions.provider);
  const runTag = RunTagSchema.parse(rawOptions.runTag);
  const transactions = collectQuickNodeWalletTransactions(payload);
  let confirmations = 0;

  for (const transaction of transactions) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO qn_wallet_events
          (tx_hash, account, delegate, tx_type, result, ledger_index, raw_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        transaction.hash,
        transaction.account,
        transaction.delegate ?? null,
        transaction.txType,
        transaction.result,
        transaction.ledgerIndex,
        storedTransaction(transaction),
        receivedAt,
      )
      .run();

    const matching = await db
      .prepare(
        `SELECT id, principal, created_at FROM executions
          WHERE hash = ? AND status IN ('submitted', 'executed')
          ORDER BY created_at, id LIMIT 16`,
      )
      .bind(transaction.hash)
      .all<ExecutionMatch>();
    for (const execution of matching.results) {
      if (await confirmExecution(
        db,
        execution,
        transaction.hash,
        provider,
        receivedAt,
      )) confirmations += 1;
    }
  }

  await updateCounters(db, runTag, confirmations, receivedAt);
  return { events: transactions.length, confirmations };
}

/**
 * Read the fixed-field projection of one HMAC-verified QuickNode delivery.
 *
 * The raw provider payload is deliberately absent from both the query and the
 * public result. Evidence is released only after the same hash has durably won
 * execution confirmation with the real QuickNode webhook provider.
 */
export async function readQuickNodeWebhookEvidence(
  db: D1Database,
  principal: string,
  rawHash: string,
): Promise<QuickNodeWebhookEvidence> {
  const hash = HashSchema.parse(rawHash);
  const rows = await db
    .prepare(
      `SELECT wallet.tx_hash, wallet.account, wallet.delegate,
              wallet.tx_type, wallet.result, wallet.ledger_index,
              wallet.received_at, execution.id AS execution_id,
              execution.created_at AS execution_created_at,
              execution.confirmed_by, execution.confirmed_at
         FROM qn_wallet_events AS wallet
         JOIN executions AS execution ON execution.hash = wallet.tx_hash
        WHERE execution.principal = ? AND wallet.tx_hash = ?
          AND execution.status IN ('submitted', 'executed')
          AND execution.confirmed_by = 'quicknode-webhook'
          AND execution.confirmed_at IS NOT NULL
        ORDER BY execution.confirmed_at DESC, execution.id
        LIMIT 2`,
    )
    .bind(principal, hash)
    .all<WebhookEvidenceRow>();
  if (rows.results.length === 0) {
    throw new Error("QN_WEBHOOK_EVIDENCE_NOT_FOUND");
  }
  if (rows.results.length !== 1) {
    throw new Error("QN_WEBHOOK_EVIDENCE_AMBIGUOUS");
  }
  const row = rows.results[0];
  return QuickNodeWebhookEvidenceSchema.parse({
    hash: row.tx_hash,
    account: row.account,
    ...(row.delegate ? { delegate: row.delegate } : {}),
    tx_type: row.tx_type,
    result: row.result,
    ledger_index: row.ledger_index,
    received_at: row.received_at,
    execution: {
      id: row.execution_id,
      confirmed_by: row.confirmed_by,
      confirmed_at: row.confirmed_at,
      latency_ms: latencyMs(row.execution_created_at, row.received_at),
    },
  });
}
