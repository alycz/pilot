import {
	type OwnerReviewClaimResult,
	type OwnerReviewRecord,
	type OwnerReviewStatus,
	type OwnerReviewStore,
	type OwnerReviewTransitionResult,
} from "./x402-owner-review";

const STATUSES = new Set<OwnerReviewStatus>([
	"challenge",
	"awaiting_approval",
	"signed",
	"relaying",
	"settlement_unknown",
	"settled",
	"delivering",
	"delivered",
	"rejected",
	"expired",
]);
const HASH = /^[A-F0-9]{64}$/;

function changed(result: D1Result): boolean {
	return Number(result.meta?.changes ?? 0) === 1;
}

function decodeRecord(value: string): OwnerReviewRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw new Error("Stored owner-review x402 record is invalid");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Stored owner-review x402 record is invalid");
	}
	const record = parsed as Record<string, unknown>;
	if (
		typeof record.id !== "string" || record.id.length === 0 ||
		typeof record.approvalId !== "string" || record.approvalId.length === 0 ||
		typeof record.principal !== "string" || record.principal.length === 0 ||
		typeof record.idempotencyKey !== "string" || record.idempotencyKey.length === 0 ||
		typeof record.requestFingerprint !== "string" || !HASH.test(record.requestFingerprint) ||
		typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
		typeof record.status !== "string" || !STATUSES.has(record.status as OwnerReviewStatus) ||
		record.network !== "testnet" || record.asset !== "XRP" || record.amountDrops !== "5000" ||
		record.resourceUrl !== "http://127.0.0.1:8000/api/x402/compare" ||
		record.payTo !== "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr" ||
		typeof record.owner !== "string" ||
		typeof record.createdAt !== "string" || typeof record.updatedAt !== "string"
	) throw new Error("Stored owner-review x402 record is invalid");
	return parsed as OwnerReviewRecord;
}

function encodeRecord(record: OwnerReviewRecord): string {
	const encoded = JSON.stringify(record);
	if (encoded.length > 300_000) throw new Error("Owner-review x402 record is too large");
	return encoded;
}

/**
 * Durable local/mock adapter. Claims and transitions are conditional single
 * statements, so idempotency and relay ownership remain atomic across Worker
 * requests. initialize() is called only by the explicit default-off route.
 */
export class D1OwnerReviewStore implements OwnerReviewStore {
	constructor(private readonly db: D1Database) {}

	async initialize(): Promise<void> {
		await this.db.prepare(`CREATE TABLE IF NOT EXISTS x402_owner_reviews (
			approval_id TEXT PRIMARY KEY,
			principal TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			request_fingerprint TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK(revision >= 0),
			status TEXT NOT NULL,
			tx_hash TEXT,
			mock_relay_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(mock_relay_dispatched IN (0, 1)),
			record_json TEXT NOT NULL,
			UNIQUE(principal, idempotency_key)
		)`).run();
		// Local databases created by an earlier owner-review build are upgraded
		// in place. The following index creation remains the fail-closed check
		// that both columns are available after duplicate-column errors.
		try {
			await this.db.prepare(`ALTER TABLE x402_owner_reviews ADD COLUMN tx_hash TEXT`).run();
		} catch {
			// Expected when the current schema already contains this column.
		}
		try {
			await this.db.prepare(`ALTER TABLE x402_owner_reviews ADD COLUMN mock_relay_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(mock_relay_dispatched IN (0, 1))`).run();
		} catch {
			// Expected when the current schema already contains this column.
		}
		await this.db.prepare(`UPDATE x402_owner_reviews
			SET tx_hash = json_extract(record_json, '$.txHash')
			WHERE tx_hash IS NULL AND json_extract(record_json, '$.txHash') IS NOT NULL`).run();
		await this.db.prepare(`CREATE INDEX IF NOT EXISTS x402_owner_reviews_tx_hash
			ON x402_owner_reviews(tx_hash)`).run();
	}

	async markMockRelayDispatched(txHash: string): Promise<void> {
		if (!HASH.test(txHash)) throw new Error("Owner-review x402 transaction hash is invalid");
		const result = await this.db.prepare(`UPDATE x402_owner_reviews
			SET mock_relay_dispatched = 1
			WHERE tx_hash = ? AND status IN ('relaying', 'settlement_unknown')`)
			.bind(txHash).run();
		if (!changed(result)) throw new Error("Owner-review x402 relay marker was not persisted");
	}

	async getMockDispatchedByHash(txHash: string): Promise<OwnerReviewRecord | null> {
		if (!HASH.test(txHash)) return null;
		const row = await this.db.prepare(`SELECT record_json FROM x402_owner_reviews
			WHERE tx_hash = ? AND mock_relay_dispatched = 1 LIMIT 1`)
			.bind(txHash).first<{ record_json: string }>();
		return row === null ? null : decodeRecord(row.record_json);
	}

	async getByIdempotencyKey(principal: string, idempotencyKey: string): Promise<OwnerReviewRecord | null> {
		const row = await this.db.prepare(`SELECT record_json FROM x402_owner_reviews
			WHERE principal = ? AND idempotency_key = ?`)
			.bind(principal, idempotencyKey).first<{ record_json: string }>();
		return row === null ? null : decodeRecord(row.record_json);
	}

	async getByApprovalId(approvalId: string): Promise<OwnerReviewRecord | null> {
		const row = await this.db.prepare(`SELECT record_json FROM x402_owner_reviews
			WHERE approval_id = ?`).bind(approvalId).first<{ record_json: string }>();
		return row === null ? null : decodeRecord(row.record_json);
	}

	async claim(record: OwnerReviewRecord): Promise<OwnerReviewClaimResult> {
		const result = await this.db.prepare(`INSERT INTO x402_owner_reviews (
			approval_id, principal, idempotency_key, request_fingerprint, revision, status, tx_hash, record_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(principal, idempotency_key) DO NOTHING`)
			.bind(
				record.approvalId,
				record.principal,
				record.idempotencyKey,
				record.requestFingerprint,
				record.revision,
				record.status,
				record.txHash,
				encodeRecord(record),
			).run();
		const current = await this.getByIdempotencyKey(record.principal, record.idempotencyKey);
		if (current === null) throw new Error("Owner-review x402 claim was not persisted");
		if (changed(result)) return { outcome: "claimed", record: current };
		return {
			outcome: current.requestFingerprint === record.requestFingerprint ? "replay" : "mismatch",
			record: current,
		};
	}

	async compareAndSwap(
		approvalId: string,
		expectedRevision: number,
		expectedStatus: OwnerReviewStatus,
		next: OwnerReviewRecord,
	): Promise<OwnerReviewTransitionResult> {
		if (
			next.approvalId !== approvalId ||
			next.revision !== expectedRevision + 1 ||
			next.status === expectedStatus
		) throw new Error("Owner-review x402 transition is invalid");
		const result = await this.db.prepare(`UPDATE x402_owner_reviews
			SET revision = ?, status = ?, tx_hash = ?, record_json = ?
			WHERE approval_id = ? AND revision = ? AND status = ?`)
			.bind(
				next.revision,
				next.status,
				next.txHash,
				encodeRecord(next),
				approvalId,
				expectedRevision,
				expectedStatus,
			).run();
		const current = await this.getByApprovalId(approvalId);
		if (current === null) throw new Error("Owner-review x402 approval was not found");
		return { outcome: changed(result) ? "transitioned" : "conflict", record: current };
	}
}
