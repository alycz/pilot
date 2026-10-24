import { isValidClassicAddress } from 'xrpl';

import { X402MerchantBodySchema } from '../x402-contract';

export type X402Network = 'testnet' | 'devnet';
export type X402Status =
	| 'claimed'
	| 'prepared'
	| 'signed'
	| 'settlement_unknown'
	| 'settled'
	| 'delivered'
	| 'failed';

export type JsonObject = Record<string, unknown>;

export interface X402PaymentRow {
	id: string;
	principal: string;
	idempotencyKey: string;
	requestFingerprint: string;
	owner: string;
	network: X402Network;
	delegate: string;
	url: string;
	status: X402Status;
	amountDrops: string | null;
	feeCapDrops: string | null;
	reservedTotalDrops: string | null;
	budgetConsumedDrops: string | null;
	budgetConsumedAt: string | null;
	callerMaxDrops: string | null;
	policyPerCallCapDrops: string | null;
	dailyCapDrops: string | null;
	payTo: string | null;
	invoiceId: string | null;
	requirements: JsonObject | null;
	transaction: JsonObject | null;
	signedBlob: string | null;
	hash: string | null;
	lastLedgerSeq: number | null;
	expiresAt: string | null;
	reservedAt: string | null;
	leaseAcquiredAt: string | null;
	signingStartedAt: string | null;
	signedAt: string | null;
	settlementUnknownAt: string | null;
	settledAt: string | null;
	deliveredAt: string | null;
	failedAt: string | null;
	settlement: JsonObject | null;
	delivery: JsonObject | null;
	failure: JsonObject | null;
	createdAt: string;
	updatedAt: string;
}

export interface ClaimX402Input {
	id: string;
	idempotencyKey: string;
	requestFingerprint: string;
	owner: string;
	network: X402Network;
	delegate: string;
	url: string;
	createdAt: string;
}

export interface ReserveX402Input {
	idempotencyKey: string;
	requestFingerprint: string;
	leaseAcquiredAt: string;
	invoiceId: string;
	amountDrops: string;
	feeCapDrops: string;
	callerMaxDrops: string;
	policyPerCallCapDrops: string;
	dailyCapDrops: string;
	payTo: string;
	requirements: JsonObject;
	transaction: JsonObject;
	lastLedgerSeq: number;
	expiresAt: string;
	reservedAt: string;
}

export type ClaimX402Result = {
	outcome: 'claimed' | 'replay' | 'mismatch';
	row: X402PaymentRow;
};

export type ReserveX402Outcome =
	| 'reserved'
	| 'replay'
	| 'mismatch'
	| 'caller-max'
	| 'policy-per-call-cap'
	| 'daily-cap'
	| 'invoice-conflict'
	| 'invalid-state';

export type ReserveX402Result = { outcome: ReserveX402Outcome; row: X402PaymentRow };
export type TransitionOutcome = 'transitioned' | 'replay' | 'mismatch' | 'invalid-state' | 'invalid-evidence';
export type TransitionResult = { outcome: TransitionOutcome; row: X402PaymentRow };

export interface X402ExpiredAbsentProof extends JsonObject {
	code: 'expired_absent';
	validated: true;
	transaction_found: false;
	validated_ledger_index: number;
	inclusion_ledgers_checked: number[];
	hash: string;
}

export interface X402SettlementProof extends JsonObject {
	validated: true;
	hash: string;
	ledger_index: number;
	engine_result: 'tesSUCCESS';
	transaction: JsonObject;
}

export interface X402ValidatedFailureProof extends JsonObject {
	validated: true;
	hash: string;
	ledger_index: number;
	engine_result: string;
	transaction: JsonObject;
}

export interface X402SigningAbandonedProof extends JsonObject {
	code: 'signing_abandoned';
	signed_blob_persisted: false;
	hash_persisted: false;
}

type RawPayment = Record<string, unknown>;

const STATUS = new Set<X402Status>([
	'claimed', 'prepared', 'signed', 'settlement_unknown', 'settled', 'delivered', 'failed',
]);
const NETWORK = new Set<X402Network>(['testnet', 'devnet']);
const SENSITIVE_FRAGMENT = /seed|secret|private|mnemonic/i;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const UINT32_MAX = 0xffff_ffff;
const TF_FULLY_CANONICAL_SIG = 0x8000_0000;
const RESERVED_PAYMENT_KEYS = new Set([
	'TransactionType', 'Account', 'Destination', 'Amount', 'InvoiceID', 'SourceTag', 'DestinationTag',
	'Fee', 'Sequence', 'LastLedgerSequence', 'Flags',
]);
const LEDGER_PAYMENT_KEYS = new Set([...RESERVED_PAYMENT_KEYS, 'SigningPubKey', 'TxnSignature']);
const SETTLEMENT_PROOF_KEYS = new Set(['validated', 'hash', 'ledger_index', 'engine_result', 'transaction']);
const SIGNING_ABANDONED_PROOF_KEYS = new Set(['code', 'signed_blob_persisted', 'hash_persisted']);
const DELIVERY_PROOF_KEYS = new Set(['http_status', 'content_type', 'body']);
const SQLITE_SIGNED_64_MAX = 9_223_372_036_854_775_807n;
const JS_SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_X402_FEE_CAP_DROPS = 100n;

export class X402StoreDataError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = 'X402StoreDataError';
	}
}

function requiredText(value: string, field: string, max = 512): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
		throw new X402StoreDataError(`Invalid ${field}`);
	}
	return value;
}

function timestamp(value: string, field: string): string {
	requiredText(value, field, 40);
	if (new Date(value).toISOString() !== value) throw new X402StoreDataError(`Invalid ${field}`);
	return value;
}

function fingerprint(value: string): string {
	const normalized = requiredText(value, 'request fingerprint', 64).toUpperCase();
	if (!HASH.test(normalized)) throw new X402StoreDataError('Invalid request fingerprint');
	return normalized;
}

function hash(value: string): string {
	const normalized = requiredText(value, 'transaction hash', 64).toUpperCase();
	if (!HASH.test(normalized)) throw new X402StoreDataError('Invalid transaction hash');
	return normalized;
}

function isPlainObject(value: unknown): value is JsonObject {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function deliveryProofJson(value: unknown): string | null {
	try {
		if (!isPlainObject(value) || !hasOnlyKeys(value, DELIVERY_PROOF_KEYS) ||
			value.http_status !== 200 || value.content_type !== 'application/json' ||
			!Object.prototype.hasOwnProperty.call(value, 'body') || !isPlainObject(value.body) ||
			!X402MerchantBodySchema.safeParse(value.body).success) {
			return null;
		}
		return serializeStructuralObject(value, 'delivery proof');
	} catch {
		return null;
	}
}

function address(value: string, field: string): string {
	requiredText(value, field, 64);
	if (!isValidClassicAddress(value)) throw new X402StoreDataError(`Invalid ${field}`);
	return value;
}

function drops(value: string, field: string, allowZero = false): bigint {
	if (value.length > 16 || !/^(0|[1-9][0-9]*)$/.test(value)) throw new X402StoreDataError(`Invalid ${field}`);
	const parsed = BigInt(value);
	if ((!allowZero && parsed === 0n) || parsed > SQLITE_SIGNED_64_MAX || parsed > JS_SAFE_INTEGER_MAX) {
		throw new X402StoreDataError(`Invalid ${field}`);
	}
	return parsed;
}

function safeInteger(value: number, field: string, allowZero = false): number {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new X402StoreDataError(`Invalid ${field}`);
	return value;
}

function isUInt32(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function hasOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

async function invoiceHash(invoiceId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invoiceId));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function validFlags(value: unknown): boolean {
	return value === undefined || value === 0 || value === TF_FULLY_CANONICAL_SIG;
}

function exactOptionalField(left: JsonObject, right: JsonObject, key: string): boolean {
	return hasOwn(left, key) === hasOwn(right, key) && left[key] === right[key];
}

function validateReservedPayment(
	transaction: JsonObject,
	expected: { delegate: string; payTo: string; amountDrops: string; invoiceHash: string; lastLedgerSeq: number },
): void {
	if (!hasOnlyKeys(transaction, RESERVED_PAYMENT_KEYS) || transaction.TransactionType !== 'Payment' ||
		transaction.Account !== expected.delegate || transaction.Destination !== expected.payTo ||
		transaction.Amount !== expected.amountDrops || transaction.InvoiceID !== expected.invoiceHash ||
		!isUInt32(transaction.SourceTag) ||
		(hasOwn(transaction, 'DestinationTag') && !isUInt32(transaction.DestinationTag)) ||
		!validFlags(transaction.Flags) || typeof transaction.Fee !== 'string' ||
		!isUInt32(transaction.Sequence) || transaction.Sequence < 1 ||
		transaction.LastLedgerSequence !== expected.lastLedgerSeq) {
		throw new X402StoreDataError('Invalid reserved Payment transaction');
	}
	drops(transaction.Fee, 'transaction Fee');
}

function matchesLedgerPayment(transaction: JsonObject, reserved: JsonObject): boolean {
	if (!hasOnlyKeys(transaction, LEDGER_PAYMENT_KEYS) || transaction.TransactionType !== 'Payment' ||
		transaction.Account !== reserved.Account || transaction.Destination !== reserved.Destination ||
		transaction.Amount !== reserved.Amount || transaction.InvoiceID !== reserved.InvoiceID ||
		transaction.SourceTag !== reserved.SourceTag || !exactOptionalField(transaction, reserved, 'DestinationTag') ||
		!exactOptionalField(transaction, reserved, 'Flags') || transaction.Sequence !== reserved.Sequence ||
		transaction.LastLedgerSequence !== reserved.LastLedgerSequence || transaction.Fee !== reserved.Fee ||
		!validFlags(transaction.Flags) || typeof transaction.Fee !== 'string') return false;
	try {
		drops(transaction.Fee, 'ledger transaction Fee');
	} catch {
		return false;
	}
	return typeof transaction.SigningPubKey === 'string' && transaction.SigningPubKey.length > 0 &&
		HEX.test(transaction.SigningPubKey.toUpperCase()) && transaction.SigningPubKey.length % 2 === 0 &&
		typeof transaction.TxnSignature === 'string' && transaction.TxnSignature.length > 0 &&
		HEX.test(transaction.TxnSignature.toUpperCase()) && transaction.TxnSignature.length % 2 === 0;
}

function assertJsonStructure(value: unknown, ancestors: WeakSet<object>): void {
	if (value === null || typeof value === 'boolean') return;
	if (typeof value === 'string') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('expected a finite number');
		return;
	}
	if (typeof value !== 'object') throw new TypeError('expected a JSON value');
	if (ancestors.has(value)) throw new TypeError('cyclic JSON value');
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (const item of value) assertJsonStructure(item, ancestors);
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError('expected a plain JSON object');
		if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('symbol keys are not JSON serializable');
		for (const item of Object.values(value)) assertJsonStructure(item, ancestors);
	} finally {
		ancestors.delete(value);
	}
}

function assertNoSensitiveMaterial(value: unknown): void {
	if (typeof value === 'string') {
		if (SENSITIVE_FRAGMENT.test(value)) throw new TypeError('sensitive material is not accepted');
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertNoSensitiveMaterial(item);
		return;
	}
	if (typeof value !== 'object' || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_FRAGMENT.test(key)) throw new TypeError('sensitive material is not accepted');
		assertNoSensitiveMaterial(item);
	}
}

function serializeStructuralObject(value: JsonObject, field: string): string {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected an object');
		assertJsonStructure(value, new WeakSet<object>());
		return JSON.stringify(value);
	} catch (cause) {
		throw new X402StoreDataError(`Could not serialize ${field}`, cause);
	}
}

function serializeObject(value: JsonObject, field: string): string {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected an object');
		assertJsonStructure(value, new WeakSet<object>());
		assertNoSensitiveMaterial(value);
		return JSON.stringify(value);
	} catch (cause) {
		throw new X402StoreDataError(`Could not serialize ${field}`, cause);
	}
}

function parseObject(
	value: unknown,
	field: string,
	allowSensitiveMaterial = false,
): JsonObject | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(String(value));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('expected an object');
		assertJsonStructure(parsed, new WeakSet<object>());
		if (!allowSensitiveMaterial) assertNoSensitiveMaterial(parsed);
		return parsed as JsonObject;
	} catch (cause) {
		throw new X402StoreDataError(`Invalid JSON stored in ${field}`, cause);
	}
}

function asNullableString(value: unknown): string | null {
	return value === null ? null : String(value);
}

function asNullableSafeInteger(value: unknown, field: string): number | null {
	if (value === null) return null;
	return safeInteger(Number(value), field);
}

const SELECT_PAYMENT = `SELECT *,
  CAST(amount_drops AS TEXT) AS amount_drops_text,
  CAST(fee_cap_drops AS TEXT) AS fee_cap_drops_text,
  CAST(reserved_total_drops AS TEXT) AS reserved_total_drops_text,
  CAST(budget_consumed_drops AS TEXT) AS budget_consumed_drops_text,
  CAST(caller_max_drops AS TEXT) AS caller_max_drops_text,
  CAST(policy_per_call_cap_drops AS TEXT) AS policy_per_call_cap_drops_text,
  CAST(daily_cap_drops AS TEXT) AS daily_cap_drops_text
FROM x402_payments`;

function decode(row: RawPayment): X402PaymentRow {
	const status = String(row.status) as X402Status;
	const network = String(row.network) as X402Network;
	if (!STATUS.has(status) || !NETWORK.has(network)) throw new X402StoreDataError('Invalid x402 payment row');
	return {
		id: String(row.id), principal: String(row.principal), idempotencyKey: String(row.idempotency_key),
		requestFingerprint: String(row.request_fingerprint), owner: String(row.owner), network,
		delegate: String(row.delegate), url: String(row.url), status,
		amountDrops: asNullableString(row.amount_drops_text), callerMaxDrops: asNullableString(row.caller_max_drops_text),
		feeCapDrops: asNullableString(row.fee_cap_drops_text), reservedTotalDrops: asNullableString(row.reserved_total_drops_text),
		budgetConsumedDrops: asNullableString(row.budget_consumed_drops_text), budgetConsumedAt: asNullableString(row.budget_consumed_at),
		policyPerCallCapDrops: asNullableString(row.policy_per_call_cap_drops_text), dailyCapDrops: asNullableString(row.daily_cap_drops_text),
		payTo: asNullableString(row.pay_to), invoiceId: asNullableString(row.invoice_id),
		requirements: parseObject(row.requirements_json, 'requirements_json'), transaction: parseObject(row.transaction_json, 'transaction_json'),
		signedBlob: asNullableString(row.signed_blob), hash: asNullableString(row.hash),
		lastLedgerSeq: asNullableSafeInteger(row.last_ledger_seq, 'last_ledger_seq'), expiresAt: asNullableString(row.expires_at),
		reservedAt: asNullableString(row.reserved_at), leaseAcquiredAt: asNullableString(row.lease_acquired_at),
		signingStartedAt: asNullableString(row.signing_started_at),
		signedAt: asNullableString(row.signed_at),
		settlementUnknownAt: asNullableString(row.settlement_unknown_at), settledAt: asNullableString(row.settled_at),
		deliveredAt: asNullableString(row.delivered_at), failedAt: asNullableString(row.failed_at),
		settlement: parseObject(row.settlement_json, 'settlement_json'),
		delivery: parseObject(row.delivery_json, 'delivery_json', true),
		failure: parseObject(row.failure_json, 'failure_json'), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
	};
}

function changed(result: D1Result): boolean {
	return Number(result.meta?.changes ?? 0) === 1;
}

function sameClaim(row: X402PaymentRow, input: ClaimX402Input, normalizedFingerprint: string): boolean {
	return row.requestFingerprint === normalizedFingerprint && row.owner === input.owner && row.network === input.network &&
		row.delegate === input.delegate && row.url === input.url;
}

function utcDayBounds(value: string): [string, string] {
	const date = new Date(timestamp(value, 'reservedAt'));
	const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const end = new Date(start.getTime() + 86_400_000);
	return [start.toISOString(), end.toISOString()];
}

export function canTransitionX402Status(from: X402Status, to: X402Status): boolean {
	return (from === 'claimed' && (to === 'prepared' || to === 'failed')) ||
		(from === 'prepared' && (to === 'signed' || to === 'failed')) ||
		(from === 'signed' && (to === 'settlement_unknown' || to === 'failed')) ||
		(from === 'settlement_unknown' && (to === 'settled' || to === 'failed')) ||
		(from === 'settled' && to === 'delivered');
}

export class X402Store {
	constructor(private readonly db: D1Database, private readonly principal: string) {
		requiredText(principal, 'principal', 256);
	}

	async getByIdempotencyKey(idempotencyKey: string): Promise<X402PaymentRow | null> {
		requiredText(idempotencyKey, 'idempotency key', 200);
		const row = await this.db.prepare(`${SELECT_PAYMENT} WHERE principal = ? AND idempotency_key = ?`)
			.bind(this.principal, idempotencyKey).first<RawPayment>();
		return row === null ? null : decode(row);
	}

	async findByHash(value: string): Promise<X402PaymentRow | null> {
		const normalized = hash(value);
		const row = await this.db.prepare(`${SELECT_PAYMENT} WHERE principal = ? AND hash = ?`)
			.bind(this.principal, normalized).first<RawPayment>();
		return row === null ? null : decode(row);
	}

	async claim(input: ClaimX402Input): Promise<ClaimX402Result> {
		requiredText(input.id, 'id', 200);
		requiredText(input.idempotencyKey, 'idempotency key', 200);
		const fp = fingerprint(input.requestFingerprint);
		address(input.owner, 'owner');
		address(input.delegate, 'delegate');
		if (!NETWORK.has(input.network)) throw new X402StoreDataError('Invalid network');
		const parsedUrl = new URL(requiredText(input.url, 'url', 4096));
		if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new X402StoreDataError('Invalid url');
		timestamp(input.createdAt, 'createdAt');
		try {
				const result = await this.db.prepare(`INSERT INTO x402_payments
					(id, principal, idempotency_key, request_fingerprint, owner, network, delegate, url, status,
					 created_at, updated_at, lease_acquired_at)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?
					WHERE NOT EXISTS (SELECT 1 FROM x402_payer_quarantine WHERE network = ? AND payer = ?)
				ON CONFLICT(principal, idempotency_key) DO NOTHING`)
				.bind(input.id, this.principal, input.idempotencyKey, fp, input.owner, input.network, input.delegate, input.url,
						input.createdAt, input.createdAt, input.createdAt, input.network, input.delegate).run();
			const row = await this.getByIdempotencyKey(input.idempotencyKey);
			if (row === null) throw new X402StoreDataError('Claim was not persisted');
			return { outcome: changed(result) ? 'claimed' : sameClaim(row, input, fp) ? 'replay' : 'mismatch', row };
		} catch (cause) {
			const row = await this.getByIdempotencyKey(input.idempotencyKey);
			if (row !== null) return { outcome: sameClaim(row, input, fp) ? 'replay' : 'mismatch', row };
			throw new X402StoreDataError('Could not claim x402 payment', cause);
		}
	}

	async acquireClaimRecovery(
		idempotencyKey: string,
		expectedLeaseAcquiredAt: string,
		staleBefore: string,
		acquiredAt: string,
	): Promise<TransitionResult> {
		requiredText(idempotencyKey, 'idempotency key', 200);
		timestamp(expectedLeaseAcquiredAt, 'expectedLeaseAcquiredAt');
		timestamp(staleBefore, 'staleBefore');
		timestamp(acquiredAt, 'acquiredAt');
		const result = await this.db.prepare(`UPDATE x402_payments
			SET lease_acquired_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'claimed'
			AND lease_acquired_at = ? AND lease_acquired_at <= ?`)
			.bind(
				acquiredAt,
				acquiredAt,
				this.principal,
				idempotencyKey,
				expectedLeaseAcquiredAt,
				staleBefore,
			)
			.run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		return { outcome: 'invalid-state', row };
	}

	async reserve(input: ReserveX402Input): Promise<ReserveX402Result> {
		requiredText(input.idempotencyKey, 'idempotency key', 200);
		const fp = fingerprint(input.requestFingerprint);
		timestamp(input.leaseAcquiredAt, 'leaseAcquiredAt');
		const amount = drops(input.amountDrops, 'amountDrops');
		const feeCap = drops(input.feeCapDrops, 'feeCapDrops');
		if (feeCap > MAX_X402_FEE_CAP_DROPS) throw new X402StoreDataError('Invalid feeCapDrops');
		const reservedTotal = amount + feeCap;
		if (reservedTotal > JS_SAFE_INTEGER_MAX || reservedTotal > SQLITE_SIGNED_64_MAX) {
			throw new X402StoreDataError('Invalid reserved total');
		}
		const callerMax = drops(input.callerMaxDrops, 'callerMaxDrops', true);
		const perCall = drops(input.policyPerCallCapDrops, 'policyPerCallCapDrops', true);
		const daily = drops(input.dailyCapDrops, 'dailyCapDrops', true);
		address(input.payTo, 'payTo');
		requiredText(input.invoiceId, 'invoiceId', 200);
		if (new TextEncoder().encode(input.invoiceId).byteLength > 200) throw new X402StoreDataError('Invalid invoiceId');
		const requirementsJson = serializeObject(input.requirements, 'requirements');
		const transactionJson = serializeObject(input.transaction, 'transaction');
		if (!isUInt32(input.lastLedgerSeq) || input.lastLedgerSeq < 1) throw new X402StoreDataError('Invalid lastLedgerSeq');
		timestamp(input.expiresAt, 'expiresAt');
		const [dayStart, dayEnd] = utcDayBounds(input.reservedAt);
		const existing = await this.getByIdempotencyKey(input.idempotencyKey);
		if (existing === null) throw new X402StoreDataError('Payment claim not found');
		if (existing.requestFingerprint !== fp) return { outcome: 'mismatch', row: existing };
		validateReservedPayment(input.transaction, {
			delegate: existing.delegate,
			payTo: input.payTo,
			amountDrops: input.amountDrops,
			invoiceHash: await invoiceHash(input.invoiceId),
			lastLedgerSeq: input.lastLedgerSeq,
		});
		if (typeof input.transaction.Fee !== 'string' || drops(input.transaction.Fee, 'transaction Fee') > feeCap) {
			throw new X402StoreDataError('Transaction Fee exceeds fee cap');
		}
		if (amount > callerMax) return { outcome: 'caller-max', row: existing };
		if (amount > perCall) return { outcome: 'policy-per-call-cap', row: existing };
		if (reservedTotal > daily) return { outcome: 'daily-cap', row: existing };

		try {
			const result = await this.db.prepare(`UPDATE x402_payments SET
				status = 'prepared', amount_drops = ?, fee_cap_drops = ?, reserved_total_drops = ?,
				caller_max_drops = ?, policy_per_call_cap_drops = ?, daily_cap_drops = ?,
				pay_to = ?, invoice_id = ?, requirements_json = ?, transaction_json = ?, last_ledger_seq = ?, expires_at = ?,
				reserved_at = ?, updated_at = ?
				WHERE principal = ? AND idempotency_key = ? AND request_fingerprint = ? AND status = 'claimed'
				AND lease_acquired_at = ?
				AND ? <= COALESCE((SELECT CAST(json_extract(policy.json, '$.x402_max_per_call_drops') AS INTEGER)
					FROM policies policy WHERE policy.principal = ? AND policy.owner = x402_payments.owner
					AND policy.network = x402_payments.network), ?)
				AND NOT EXISTS (SELECT 1 FROM x402_payments other WHERE other.principal = ? AND other.network = x402_payments.network
					AND other.invoice_id = ? AND other.id <> x402_payments.id)
				AND COALESCE((SELECT SUM(CASE
						WHEN active.status NOT IN ('failed', 'settled', 'delivered') THEN active.reserved_total_drops
						WHEN active.budget_consumed_drops IS NOT NULL
							AND active.budget_consumed_at >= ? AND active.budget_consumed_at < ?
							THEN active.budget_consumed_drops
						WHEN active.status IN ('settled', 'delivered') AND active.budget_consumed_drops IS NULL
							THEN active.reserved_total_drops
						WHEN active.budget_consumed_drops > 0 AND active.budget_consumed_at IS NULL
							THEN active.budget_consumed_drops
						ELSE 0
					END) FROM x402_payments active
					WHERE active.principal = ? AND active.owner = x402_payments.owner AND active.network = x402_payments.network
					AND active.reserved_total_drops IS NOT NULL), 0) <=
					MIN(?, COALESCE((SELECT CAST(json_extract(policy.json, '$.x402_daily_cap_drops') AS INTEGER)
						FROM policies policy WHERE policy.principal = ? AND policy.owner = x402_payments.owner
						AND policy.network = x402_payments.network), ?)) - ?`)
				.bind(Number(amount), Number(feeCap), Number(reservedTotal), Number(callerMax), Number(perCall), Number(daily), input.payTo, input.invoiceId,
					requirementsJson, transactionJson, input.lastLedgerSeq, input.expiresAt, input.reservedAt, input.reservedAt,
					this.principal, input.idempotencyKey, fp, input.leaseAcquiredAt,
					Number(amount), this.principal, Number(perCall),
					this.principal, input.invoiceId, dayStart, dayEnd, this.principal, Number(daily),
					this.principal, Number(daily), Number(reservedTotal)).run();
			if (changed(result)) {
				const row = await this.required(input.idempotencyKey);
				return { outcome: 'reserved', row };
			}
		} catch (cause) {
			const conflict = await this.invoiceConflict(existing.network, input.invoiceId, existing.id);
			if (conflict) return { outcome: 'invoice-conflict', row: await this.required(input.idempotencyKey) };
			throw new X402StoreDataError('Could not reserve x402 payment', cause);
		}

		const row = await this.required(input.idempotencyKey);
		if (row.requestFingerprint !== fp) return { outcome: 'mismatch', row };
		if (this.sameReservation(row, input, requirementsJson, transactionJson)) return { outcome: 'replay', row };
		if (await this.invoiceConflict(row.network, input.invoiceId, row.id)) return { outcome: 'invoice-conflict', row };
		if (row.status !== 'claimed') return { outcome: 'invalid-state', row };
		const total = await this.activeTotal(row.owner, row.network, dayStart, dayEnd);
		return { outcome: total + reservedTotal > daily ? 'daily-cap' : 'invalid-state', row };
	}

	async markSigned(idempotencyKey: string, value: { hash: string; signedBlob: string; signedAt: string }): Promise<TransitionResult> {
		const txHash = hash(value.hash);
		const blob = requiredText(value.signedBlob, 'signedBlob', 200_000).toUpperCase();
		if (!HEX.test(blob) || blob.length % 2 !== 0) throw new X402StoreDataError('Invalid signedBlob');
		timestamp(value.signedAt, 'signedAt');
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'signed', hash = ?, signed_blob = ?, signed_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'prepared' AND signing_started_at IS NOT NULL`)
			.bind(txHash, blob, value.signedAt, value.signedAt, this.principal, idempotencyKey).run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.status === 'signed' && row.hash === txHash && row.signedBlob === blob) return { outcome: 'replay', row };
		return { outcome: row.status === 'signed' ? 'mismatch' : 'invalid-state', row };
	}

	async markSigningStarted(idempotencyKey: string, at: string): Promise<TransitionResult> {
		timestamp(at, 'signingStartedAt');
		const result = await this.db.prepare(`UPDATE x402_payments SET signing_started_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'prepared' AND signing_started_at IS NULL`)
			.bind(at, at, this.principal, idempotencyKey).run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.status === 'prepared' && row.signingStartedAt === at) return { outcome: 'replay', row };
		return { outcome: row.status === 'prepared' ? 'mismatch' : 'invalid-state', row };
	}

	async markSigningAbandoned(
		idempotencyKey: string,
		proof: X402SigningAbandonedProof,
		at: string,
	): Promise<TransitionResult> {
		timestamp(at, 'failedAt');
		const candidate = proof as Partial<X402SigningAbandonedProof> | null;
		if (candidate === null || typeof candidate !== 'object' ||
			!hasOnlyKeys(candidate as JsonObject, SIGNING_ABANDONED_PROOF_KEYS) ||
			candidate.code !== 'signing_abandoned' || candidate.signed_blob_persisted !== false ||
			candidate.hash_persisted !== false) {
			return { outcome: 'invalid-evidence', row: await this.required(idempotencyKey) };
		}
		const proofJson = serializeObject(proof, 'signing abandonment proof');
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'failed', failed_at = ?, failure_json = ?,
			budget_consumed_drops = 0, budget_consumed_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'prepared'
			AND signing_started_at IS NOT NULL AND hash IS NULL AND signed_blob IS NULL`)
			.bind(at, proofJson, at, at, this.principal, idempotencyKey).run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.status === 'failed' && JSON.stringify(row.failure) === proofJson &&
			row.budgetConsumedDrops === '0' && row.budgetConsumedAt !== null) {
			return { outcome: 'replay', row };
		}
		return { outcome: row.status === 'failed' ? 'mismatch' : 'invalid-state', row };
	}

	async markSettlementUnknown(
		idempotencyKey: string,
		at: string,
		pendingDelivery?: JsonObject & { http_status: 200; content_type: 'application/json' },
	): Promise<TransitionResult> {
		timestamp(at, 'settlementUnknownAt');
		const deliveryJson = pendingDelivery === undefined ? null : deliveryProofJson(pendingDelivery);
		// Delivery caching is optional. Once the signed request may have reached the
		// merchant, malformed or non-persistable response data must not prevent the
		// durable settlement-unknown transition and hash-based reconciliation.
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'settlement_unknown',
			settlement_unknown_at = COALESCE(settlement_unknown_at, ?),
			delivery_json = COALESCE(delivery_json, ?), updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND hash IS NOT NULL AND (
				status = 'signed' OR (status = 'settlement_unknown' AND delivery_json IS NULL AND ? IS NOT NULL)
			)`)
			.bind(at, deliveryJson, at, this.principal, idempotencyKey, deliveryJson).run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.status === 'settlement_unknown') {
			if (deliveryJson === null || JSON.stringify(row.delivery) === deliveryJson) return { outcome: 'replay', row };
			return { outcome: 'mismatch', row };
		}
		return { outcome: 'invalid-state', row };
	}

	async markClaimFailed(
		idempotencyKey: string,
		failure: JsonObject,
		at: string,
		leaseAcquiredAt: string,
	): Promise<TransitionResult> {
		timestamp(leaseAcquiredAt, 'leaseAcquiredAt');
		return this.failFrom(
			idempotencyKey,
			failure,
			at,
			`status = 'claimed' AND lease_acquired_at = ?`,
			[leaseAcquiredAt],
		);
	}

	async markSettled(idempotencyKey: string, proof: X402SettlementProof, at: string): Promise<TransitionResult> {
		timestamp(at, 'settledAt');
		const row = await this.required(idempotencyKey);
		if (row.status !== 'settlement_unknown' && row.status !== 'settled') return { outcome: 'invalid-state', row };
		const candidate = proof as Partial<X402SettlementProof> | null;
		const transaction = candidate?.transaction;
		const evidenceShapeValid = candidate !== null && typeof candidate === 'object' &&
			hasOnlyKeys(candidate as JsonObject, SETTLEMENT_PROOF_KEYS) && candidate.validated === true &&
			candidate.engine_result === 'tesSUCCESS' && typeof candidate.hash === 'string' &&
			HASH.test(candidate.hash.toUpperCase()) && Number.isSafeInteger(candidate.ledger_index) &&
			(candidate.ledger_index ?? 0) > 0 && typeof transaction === 'object' && transaction !== null &&
			!Array.isArray(transaction);
		let reservedPaymentValid = row.transaction !== null && row.amountDrops !== null && row.payTo !== null &&
			row.invoiceId !== null && row.lastLedgerSeq !== null;
		if (reservedPaymentValid) {
			try {
				validateReservedPayment(row.transaction!, {
					delegate: row.delegate,
					payTo: row.payTo!,
					amountDrops: row.amountDrops!,
					invoiceHash: await invoiceHash(row.invoiceId!),
					lastLedgerSeq: row.lastLedgerSeq!,
				});
			} catch {
				reservedPaymentValid = false;
			}
		}
		if (!evidenceShapeValid || !reservedPaymentValid || row.transaction === null || row.hash !== candidate.hash?.toUpperCase() ||
			row.lastLedgerSeq === null || (candidate.ledger_index ?? Number.MAX_SAFE_INTEGER) > row.lastLedgerSeq ||
			!matchesLedgerPayment(transaction as JsonObject, row.transaction)) {
			return { outcome: 'invalid-evidence', row };
		}
		const proofHash = candidate.hash!.toUpperCase();
		const proofJson = serializeObject({ ...proof, hash: proofHash }, 'settlement proof');
		const actualFee = drops(String((transaction as JsonObject).Fee), 'settlement Fee');
		const consumed = BigInt(row.amountDrops!) + actualFee;
		if (row.reservedTotalDrops === null || consumed > BigInt(row.reservedTotalDrops)) {
			return { outcome: 'invalid-evidence', row };
		}
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'settled', settled_at = ?, settlement_json = ?,
			budget_consumed_drops = ?, budget_consumed_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'settlement_unknown' AND hash = ?`)
			.bind(at, proofJson, Number(consumed), at, at, this.principal, idempotencyKey, proofHash).run();
		const updated = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row: updated };
		if (updated.status === 'settled' && updated.hash === proofHash && JSON.stringify(updated.settlement) === proofJson &&
			updated.budgetConsumedDrops === consumed.toString() && updated.budgetConsumedAt !== null) {
			return { outcome: 'replay', row: updated };
		}
		return { outcome: updated.status === 'settled' ? 'mismatch' : 'invalid-state', row: updated };
	}

	async markValidatedFailure(
		idempotencyKey: string,
		proof: X402ValidatedFailureProof,
		at: string,
	): Promise<TransitionResult> {
		timestamp(at, 'failedAt');
		const row = await this.required(idempotencyKey);
		if (row.status !== 'settlement_unknown' && row.status !== 'failed') return { outcome: 'invalid-state', row };
		const candidate = proof as Partial<X402ValidatedFailureProof> | null;
		const transaction = candidate?.transaction;
		const evidenceShapeValid = candidate !== null && typeof candidate === 'object' &&
			hasOnlyKeys(candidate as JsonObject, SETTLEMENT_PROOF_KEYS) && candidate.validated === true &&
			typeof candidate.engine_result === 'string' && /^tec[A-Z0-9_]{1,63}$/.test(candidate.engine_result) &&
			typeof candidate.hash === 'string' && HASH.test(candidate.hash.toUpperCase()) &&
			Number.isSafeInteger(candidate.ledger_index) && (candidate.ledger_index ?? 0) > 0 &&
			typeof transaction === 'object' && transaction !== null && !Array.isArray(transaction);
		let reservedPaymentValid = row.transaction !== null && row.amountDrops !== null && row.payTo !== null &&
			row.invoiceId !== null && row.lastLedgerSeq !== null;
		if (reservedPaymentValid) {
			try {
				validateReservedPayment(row.transaction!, {
					delegate: row.delegate,
					payTo: row.payTo!,
					amountDrops: row.amountDrops!,
					invoiceHash: await invoiceHash(row.invoiceId!),
					lastLedgerSeq: row.lastLedgerSeq!,
				});
			} catch {
				reservedPaymentValid = false;
			}
		}
		if (!evidenceShapeValid || !reservedPaymentValid || row.transaction === null ||
			row.hash !== candidate.hash?.toUpperCase() || row.lastLedgerSeq === null ||
			(candidate.ledger_index ?? Number.MAX_SAFE_INTEGER) > row.lastLedgerSeq ||
			!matchesLedgerPayment(transaction as JsonObject, row.transaction)) {
			return { outcome: 'invalid-evidence', row };
		}
		const proofHash = candidate.hash!.toUpperCase();
		const actualFee = drops(String((transaction as JsonObject).Fee), 'settlement Fee');
		const proofJson = serializeObject({ ...proof, hash: proofHash }, 'validated failure proof');
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'failed', failed_at = ?, failure_json = ?,
			budget_consumed_drops = ?, budget_consumed_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'settlement_unknown' AND hash = ?`)
			.bind(at, proofJson, Number(actualFee), at, at, this.principal, idempotencyKey, proofHash).run();
		const updated = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row: updated };
		if (updated.status === 'failed' && updated.hash === proofHash && JSON.stringify(updated.failure) === proofJson &&
			updated.budgetConsumedDrops === actualFee.toString() && updated.budgetConsumedAt !== null) {
			return { outcome: 'replay', row: updated };
		}
		return { outcome: updated.status === 'failed' ? 'mismatch' : 'invalid-state', row: updated };
	}

	async markDelivered(idempotencyKey: string, delivery: JsonObject & { http_status: number }, at: string): Promise<TransitionResult> {
		timestamp(at, 'deliveredAt');
		const deliveryJson = deliveryProofJson(delivery);
		if (deliveryJson === null) {
			const row = await this.required(idempotencyKey);
			return { outcome: 'invalid-evidence', row };
		}
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'delivered', delivered_at = ?, delivery_json = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status = 'settled' AND settlement_json IS NOT NULL`)
			.bind(at, deliveryJson, at, this.principal, idempotencyKey).run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.status === 'delivered' && JSON.stringify(row.delivery) === deliveryJson) return { outcome: 'replay', row };
		return { outcome: row.status === 'delivered' ? 'mismatch' : 'invalid-state', row };
	}

	async markFailed(idempotencyKey: string, failure: JsonObject, at: string): Promise<TransitionResult> {
		return this.failFrom(
			idempotencyKey,
			failure,
			at,
			`(status = 'claimed' OR (status = 'prepared' AND signing_started_at IS NULL))`,
			[],
		);
	}

	async markExpiredAbsentFailed(idempotencyKey: string, proof: X402ExpiredAbsentProof, at: string): Promise<TransitionResult> {
		timestamp(at, 'failedAt');
		const row = await this.required(idempotencyKey);
		const candidate = proof as Partial<X402ExpiredAbsentProof> | null;
		const evidenceShapeValid = candidate !== null && typeof candidate === 'object' &&
			candidate.code === 'expired_absent' && candidate.validated === true && candidate.transaction_found === false &&
			Number.isSafeInteger(candidate.validated_ledger_index) && (candidate.validated_ledger_index ?? 0) > 0 &&
			Array.isArray(candidate.inclusion_ledgers_checked) && candidate.inclusion_ledgers_checked.length > 0 &&
			candidate.inclusion_ledgers_checked.length <= 64 && candidate.inclusion_ledgers_checked.every((value) =>
				Number.isSafeInteger(value) && value > 0) &&
			typeof candidate.hash === 'string' && HASH.test(candidate.hash.toUpperCase());
		if (!evidenceShapeValid) return { outcome: 'invalid-evidence', row };
		const proofHash = proof.hash.toUpperCase();
		const proofJson = serializeObject({ ...proof, hash: proofHash }, 'expired-absent proof');
		if (row.hash !== proofHash || row.lastLedgerSeq === null || proof.validated_ledger_index <= row.lastLedgerSeq ||
			proof.inclusion_ledgers_checked.at(-1) !== row.lastLedgerSeq ||
			proof.inclusion_ledgers_checked.some((value, index, values) => index > 0 && value !== values[index - 1]! + 1)) {
			return { outcome: 'invalid-evidence', row };
		}
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'failed', failed_at = ?, failure_json = ?,
			budget_consumed_drops = 0, budget_consumed_at = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND status IN ('signed', 'settlement_unknown')
			AND hash = ? AND last_ledger_seq IS NOT NULL AND last_ledger_seq < ?`)
			.bind(at, proofJson, at, at, this.principal, idempotencyKey, proofHash, proof.validated_ledger_index).run();
		const updated = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row: updated };
		if (updated.status === 'failed' && JSON.stringify(updated.failure) === proofJson) return { outcome: 'replay', row: updated };
		if (updated.hash !== proofHash || updated.lastLedgerSeq === null || proof.validated_ledger_index <= updated.lastLedgerSeq ||
			proof.inclusion_ledgers_checked.at(-1) !== updated.lastLedgerSeq ||
			proof.inclusion_ledgers_checked.some((value, index, values) => index > 0 && value !== values[index - 1]! + 1)) {
			return { outcome: 'invalid-evidence', row: updated };
		}
		return { outcome: updated.status === 'failed' ? 'mismatch' : 'invalid-state', row: updated };
	}

	private async failFrom(idempotencyKey: string, failure: JsonObject, at: string, condition: string, args: unknown[]): Promise<TransitionResult> {
		timestamp(at, 'failedAt');
		const failureJson = serializeObject(failure, 'failure');
		const result = await this.db.prepare(`UPDATE x402_payments SET status = 'failed', failed_at = ?, failure_json = ?, updated_at = ?
			WHERE principal = ? AND idempotency_key = ? AND ${condition}`)
			.bind(at, failureJson, at, this.principal, idempotencyKey, ...args).run();
		const row = await this.required(idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.status === 'failed' && JSON.stringify(row.failure) === failureJson) return { outcome: 'replay', row };
		return { outcome: row.status === 'failed' ? 'mismatch' : 'invalid-state', row };
	}

	private async required(idempotencyKey: string): Promise<X402PaymentRow> {
		const row = await this.getByIdempotencyKey(idempotencyKey);
		if (row === null) throw new X402StoreDataError('Payment claim not found');
		return row;
	}

	private sameReservation(row: X402PaymentRow, input: ReserveX402Input, requirementsJson: string, transactionJson: string): boolean {
		return !['claimed', 'failed'].includes(row.status) && row.invoiceId === input.invoiceId && row.amountDrops === input.amountDrops &&
			row.feeCapDrops === input.feeCapDrops &&
			row.reservedTotalDrops === String(BigInt(input.amountDrops) + BigInt(input.feeCapDrops)) &&
			row.callerMaxDrops === input.callerMaxDrops && row.policyPerCallCapDrops === input.policyPerCallCapDrops &&
			row.dailyCapDrops === input.dailyCapDrops && row.payTo === input.payTo && row.lastLedgerSeq === input.lastLedgerSeq &&
			row.expiresAt === input.expiresAt && row.reservedAt === input.reservedAt && JSON.stringify(row.requirements) === requirementsJson &&
			JSON.stringify(row.transaction) === transactionJson;
	}

	private async invoiceConflict(network: X402Network, invoiceId: string, id: string): Promise<boolean> {
		return (await this.db.prepare(`SELECT 1 AS found FROM x402_payments
			WHERE principal = ? AND network = ? AND invoice_id = ? AND id <> ? LIMIT 1`)
			.bind(this.principal, network, invoiceId, id).first('found')) !== null;
	}

	private async activeTotal(owner: string, network: X402Network, start: string, end: string): Promise<bigint> {
		const value = await this.db.prepare(`SELECT CAST(COALESCE(SUM(CASE
				WHEN status NOT IN ('failed', 'settled', 'delivered') THEN reserved_total_drops
				WHEN budget_consumed_drops IS NOT NULL AND budget_consumed_at >= ? AND budget_consumed_at < ?
					THEN budget_consumed_drops
				WHEN status IN ('settled', 'delivered') AND budget_consumed_drops IS NULL THEN reserved_total_drops
				WHEN budget_consumed_drops > 0 AND budget_consumed_at IS NULL THEN budget_consumed_drops
				ELSE 0
			END), 0) AS TEXT) AS total FROM x402_payments
			WHERE principal = ? AND owner = ? AND network = ? AND reserved_total_drops IS NOT NULL`)
			.bind(start, end, this.principal, owner, network).first<string>('total');
		return BigInt(value ?? '0');
	}
}
