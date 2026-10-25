import {
	parseWorkAgreementRecord,
	type WorkAgreementRecord,
	type WorkAgreementStore,
} from './work-agreement-runtime';

const MAX_RECORD_BYTES = 512 * 1_024;

type EventRow = { principal: string; agreement_id: string; revision: number; record_json: string };

export class WorkAgreementStoreDataError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message); this.name = 'WorkAgreementStoreDataError';
	}
}

function changes(result: D1Result<unknown>): number {
	return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

function serialize(record: WorkAgreementRecord): string {
	const checked = parseWorkAgreementRecord(record);
	const serialized = JSON.stringify(checked);
	if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) throw new WorkAgreementStoreDataError('Work-agreement record is too large');
	if (/"signedBlob"|"signed_blob"|"tx_blob"/.test(serialized)) throw new WorkAgreementStoreDataError('Signed transaction blobs cannot be persisted');
	return serialized;
}

function decode(row: EventRow, principal: string, agreementId: string): WorkAgreementRecord {
	if (row.principal !== principal || row.agreement_id !== agreementId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
		typeof row.record_json !== 'string' || new TextEncoder().encode(row.record_json).byteLength > MAX_RECORD_BYTES) {
		throw new WorkAgreementStoreDataError('Persisted work-agreement row is invalid');
	}
	let record: WorkAgreementRecord;
	try { record = parseWorkAgreementRecord(JSON.parse(row.record_json)); }
	catch (error) { throw new WorkAgreementStoreDataError('Persisted work-agreement state is invalid', error); }
	if (record.principal !== principal || record.terms.agreementId !== agreementId || record.revision !== row.revision) throw new WorkAgreementStoreDataError('Persisted work-agreement identity is inconsistent');
	return record;
}

function oneNew(previous: string[], next: string[], field: string): string | null {
	if (next.length < previous.length || !previous.every((value, index) => next[index] === value) || next.length > previous.length + 1) {
		throw new WorkAgreementStoreDataError(`${field} history is not append-only`);
	}
	return next.length === previous.length ? null : next.at(-1)!;
}

/**
 * Local-only D1 event store. Each CAS appends one immutable revision. Unique
 * token columns on those revisions are permanent replay tombstones, including
 * after release/cancel and restart.
 */
export class D1WorkAgreementStore implements WorkAgreementStore {
	#initialized?: Promise<void>;

	constructor(private readonly db: D1Database) {}

	async initialize(): Promise<void> {
		this.#initialized ??= this.db.exec(`
CREATE TABLE IF NOT EXISTS local_work_agreement_events (
  principal TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  approval_token TEXT,
  idempotency_token TEXT,
  attempt_token TEXT,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, agreement_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS local_work_agreement_approval_replay
  ON local_work_agreement_events(principal, approval_token) WHERE approval_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS local_work_agreement_idempotency_replay
  ON local_work_agreement_events(principal, idempotency_token) WHERE idempotency_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS local_work_agreement_attempt_replay
  ON local_work_agreement_events(principal, attempt_token) WHERE attempt_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS local_work_agreement_latest
  ON local_work_agreement_events(principal, agreement_id, revision DESC);
`).then(() => undefined);
		return this.#initialized;
	}

	async get(principal: string, agreementId: string): Promise<WorkAgreementRecord | null> {
		await this.initialize();
		const row = await this.db.prepare(`SELECT principal, agreement_id, revision, record_json
FROM local_work_agreement_events WHERE principal = ? AND agreement_id = ?
ORDER BY revision DESC LIMIT 1`).bind(principal, agreementId).first<EventRow>();
		return row === null ? null : decode(row, principal, agreementId);
	}

	async hasReplay(principal: string, input: { approvalId?: string; idempotencyKey?: string; attemptId?: string }): Promise<boolean> {
		await this.initialize();
		if (input.approvalId === undefined && input.idempotencyKey === undefined && input.attemptId === undefined) return false;
		const row = await this.db.prepare(`SELECT 1 AS found FROM local_work_agreement_events
WHERE principal = ? AND ((? IS NOT NULL AND approval_token = ?) OR (? IS NOT NULL AND idempotency_token = ?)
  OR (? IS NOT NULL AND attempt_token = ?)) LIMIT 1`).bind(principal,
			input.approvalId ?? null, input.approvalId ?? null, input.idempotencyKey ?? null, input.idempotencyKey ?? null,
			input.attemptId ?? null, input.attemptId ?? null).first<{ found: number }>();
		return row !== null;
	}

	async insert(record: WorkAgreementRecord): Promise<boolean> {
		await this.initialize();
		if (record.revision !== 0 || record.history.approvalIds.length !== 1 ||
			record.history.idempotencyKeys.length !== 1 || record.history.attemptIds.length !== 0) {
			throw new WorkAgreementStoreDataError('Initial work-agreement record has invalid history');
		}
		const serialized = serialize(record);
		try {
			const result = await this.db.prepare(`INSERT OR IGNORE INTO local_work_agreement_events(
principal, agreement_id, revision, approval_token, idempotency_token, attempt_token, record_json, created_at
) VALUES (?, ?, 0, ?, ?, NULL, ?, ?)`).bind(record.principal, record.terms.agreementId,
				record.history.approvalIds[0], record.history.idempotencyKeys[0], serialized, record.updatedAt).run();
			return changes(result) === 1;
		} catch (error) { throw new WorkAgreementStoreDataError('Initial work-agreement claim failed', error); }
	}

	async compareAndSwap(principal: string, agreementId: string, expectedRevision: number, next: WorkAgreementRecord): Promise<boolean> {
		await this.initialize();
		if (next.principal !== principal || next.terms.agreementId !== agreementId || next.revision !== expectedRevision + 1) throw new WorkAgreementStoreDataError('CAS identity or revision is invalid');
		const priorRow = await this.db.prepare(`SELECT principal, agreement_id, revision, record_json
FROM local_work_agreement_events WHERE principal = ? AND agreement_id = ? AND revision = ?`)
			.bind(principal, agreementId, expectedRevision).first<EventRow>();
		if (priorRow === null) return false;
		const previous = decode(priorRow, principal, agreementId);
		const approval = oneNew(previous.history.approvalIds, next.history.approvalIds, 'approval');
		const idempotency = oneNew(previous.history.idempotencyKeys, next.history.idempotencyKeys, 'idempotency');
		const attempt = oneNew(previous.history.attemptIds, next.history.attemptIds, 'attempt');
		const serialized = serialize(next);
		try {
			const result = await this.db.prepare(`INSERT OR IGNORE INTO local_work_agreement_events(
principal, agreement_id, revision, approval_token, idempotency_token, attempt_token, record_json, created_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (
  SELECT 1 FROM local_work_agreement_events WHERE principal = ? AND agreement_id = ? AND revision = ?
)
AND NOT EXISTS (
  SELECT 1 FROM local_work_agreement_events WHERE principal = ? AND agreement_id = ? AND revision > ?
)`).bind(principal, agreementId, next.revision, approval, idempotency, attempt, serialized, next.updatedAt,
				principal, agreementId, expectedRevision, principal, agreementId, expectedRevision).run();
			return changes(result) === 1;
		} catch (error) { throw new WorkAgreementStoreDataError('Work-agreement CAS failed', error); }
	}
}

/** Durable-shaped deterministic backing for focused local/runtime tests. */
export class MemoryWorkAgreementStore implements WorkAgreementStore {
	readonly #records = new Map<string, WorkAgreementRecord>();
	readonly #approvalTokens = new Set<string>();
	readonly #idempotencyTokens = new Set<string>();
	readonly #attemptTokens = new Set<string>();

	async get(principal: string, agreementId: string): Promise<WorkAgreementRecord | null> {
		const found = this.#records.get(`${principal}\0${agreementId}`); return found === undefined ? null : parseWorkAgreementRecord(JSON.parse(JSON.stringify(found)));
	}

	async hasReplay(principal: string, input: { approvalId?: string; idempotencyKey?: string; attemptId?: string }): Promise<boolean> {
		return (input.approvalId !== undefined && this.#approvalTokens.has(`${principal}\0${input.approvalId}`)) ||
			(input.idempotencyKey !== undefined && this.#idempotencyTokens.has(`${principal}\0${input.idempotencyKey}`)) ||
			(input.attemptId !== undefined && this.#attemptTokens.has(`${principal}\0${input.attemptId}`));
	}

	async insert(record: WorkAgreementRecord): Promise<boolean> {
		const key = `${record.principal}\0${record.terms.agreementId}`;
		const approval = record.history.approvalIds[0]!; const idempotency = record.history.idempotencyKeys[0]!;
		if (this.#records.has(key) || this.#approvalTokens.has(`${record.principal}\0${approval}`) || this.#idempotencyTokens.has(`${record.principal}\0${idempotency}`)) return false;
		serialize(record); this.#records.set(key, parseWorkAgreementRecord(record));
		this.#approvalTokens.add(`${record.principal}\0${approval}`); this.#idempotencyTokens.add(`${record.principal}\0${idempotency}`); return true;
	}

	async compareAndSwap(principal: string, agreementId: string, expectedRevision: number, next: WorkAgreementRecord): Promise<boolean> {
		const key = `${principal}\0${agreementId}`; const previous = this.#records.get(key);
		if (previous === undefined || previous.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false;
		const approval = oneNew(previous.history.approvalIds, next.history.approvalIds, 'approval');
		const idempotency = oneNew(previous.history.idempotencyKeys, next.history.idempotencyKeys, 'idempotency');
		const attempt = oneNew(previous.history.attemptIds, next.history.attemptIds, 'attempt');
		if ((approval !== null && this.#approvalTokens.has(`${principal}\0${approval}`)) ||
			(idempotency !== null && this.#idempotencyTokens.has(`${principal}\0${idempotency}`)) ||
			(attempt !== null && this.#attemptTokens.has(`${principal}\0${attempt}`))) return false;
		serialize(next); this.#records.set(key, parseWorkAgreementRecord(next));
		if (approval !== null) this.#approvalTokens.add(`${principal}\0${approval}`);
		if (idempotency !== null) this.#idempotencyTokens.add(`${principal}\0${idempotency}`);
		if (attempt !== null) this.#attemptTokens.add(`${principal}\0${attempt}`);
		return true;
	}
}
