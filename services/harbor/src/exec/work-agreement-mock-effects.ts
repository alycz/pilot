import { Buffer } from 'node:buffer';

import { decode, hashes } from 'xrpl';

import {
	type JsonObject,
	type WorkAgreementEffects,
	type WorkAgreementLookupResult,
} from './work-agreement-runtime';

const MAX_PAYLOAD_BYTES = 64 * 1024;

type RelayEntry = Readonly<{
	principal: string;
	agreementId: string;
	action: 'create' | 'release' | 'cancel';
	approvalId: string;
	idempotencyKey: string;
	attemptId: string;
	hash: string;
	signedBlob: string;
}>;

export class WorkAgreementMockEffectsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkAgreementMockEffectsError';
	}
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
		.join(',')}}`;
}

function parseEntry(raw: unknown): RelayEntry {
	if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
		throw new WorkAgreementMockEffectsError('Mock relay entry is invalid');
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new WorkAgreementMockEffectsError('Mock relay entry is invalid');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new WorkAgreementMockEffectsError('Mock relay entry is invalid');
	}
	const entry = value as Record<string, unknown>;
	const keys = Object.keys(entry).sort();
	const expected = [
		'action', 'agreementId', 'approvalId', 'attemptId', 'hash',
		'idempotencyKey', 'principal', 'signedBlob',
	].sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
		throw new WorkAgreementMockEffectsError('Mock relay entry is invalid');
	}
	for (const field of [
		'principal', 'agreementId', 'approvalId', 'idempotencyKey', 'attemptId', 'hash', 'signedBlob',
	] as const) {
		if (typeof entry[field] !== 'string' || entry[field].length === 0) {
			throw new WorkAgreementMockEffectsError('Mock relay entry is invalid');
		}
	}
	if (entry.action !== 'create' && entry.action !== 'release' && entry.action !== 'cancel') {
		throw new WorkAgreementMockEffectsError('Mock relay entry is invalid');
	}
	return entry as unknown as RelayEntry;
}

/**
 * Durable, local-only stand-in for an XRPL relay and ledger lookup. It performs
 * no network I/O. Persisting the signed public transaction allows a fresh
 * worker instance to reconcile an ambiguous mock dispatch without resending.
 */
export class D1LocalMockWorkAgreementEffects implements WorkAgreementEffects {
	constructor(private readonly database: D1Database) {}

	async initialize(): Promise<void> {
		await this.database.prepare(`
			CREATE TABLE IF NOT EXISTS work_agreement_mock_relay (
				principal TEXT NOT NULL,
				agreement_id TEXT NOT NULL,
				hash TEXT NOT NULL,
				approval_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				PRIMARY KEY (principal, agreement_id, hash),
				UNIQUE (principal, agreement_id, approval_id),
				UNIQUE (principal, agreement_id, attempt_id)
			)
		`).run();
	}

	async dispatch(input: Parameters<WorkAgreementEffects['dispatch']>[0]): Promise<void> {
		const entry: RelayEntry = {
			principal: input.principal,
			agreementId: input.agreementId,
			action: input.action,
			approvalId: input.approvalId,
			idempotencyKey: input.idempotencyKey,
			attemptId: input.attemptId,
			hash: input.hash.toUpperCase(),
			signedBlob: input.signedBlob.toUpperCase(),
		};
		const payload = JSON.stringify(entry);
		if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
			throw new WorkAgreementMockEffectsError('Mock relay entry is too large');
		}
		await this.database.prepare(`
			INSERT OR IGNORE INTO work_agreement_mock_relay
				(principal, agreement_id, hash, approval_id, attempt_id, payload_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`).bind(
			entry.principal,
			entry.agreementId,
			entry.hash,
			entry.approvalId,
			entry.attemptId,
			payload,
		).run();
		const stored = await this.readByApproval(entry.principal, entry.agreementId, entry.approvalId);
		if (stored === null || canonical(stored) !== canonical(entry)) {
			throw new WorkAgreementMockEffectsError('Mock relay replay binding changed');
		}
	}

	async lookup(input: Parameters<WorkAgreementEffects['lookup']>[0]): Promise<WorkAgreementLookupResult> {
		const row = await this.database.prepare(`
			SELECT payload_json FROM work_agreement_mock_relay
			WHERE principal = ? AND agreement_id = ? AND hash = ?
		`).bind(input.principal, input.agreementId, input.hash.toUpperCase())
			.first<{ payload_json: string }>();
		if (row === null) return { status: 'pending', hash: input.hash.toUpperCase() };
		const entry = parseEntry(row.payload_json);
		if (
			entry.action !== input.action || entry.approvalId !== input.approvalId ||
			entry.idempotencyKey !== input.idempotencyKey || entry.hash !== input.hash.toUpperCase()
		) {
			throw new WorkAgreementMockEffectsError('Mock lookup binding changed');
		}
		let txJson: JsonObject;
		try {
			if (hashes.hashSignedTx(entry.signedBlob).toUpperCase() !== entry.hash) {
				throw new Error('hash mismatch');
			}
			txJson = decode(entry.signedBlob) as JsonObject;
		} catch {
			throw new WorkAgreementMockEffectsError('Mock relay transaction is invalid');
		}
		const lastLedger = txJson.LastLedgerSequence;
		if (typeof lastLedger !== 'number' || !Number.isSafeInteger(lastLedger) || lastLedger <= 1) {
			throw new WorkAgreementMockEffectsError('Mock relay ledger window is invalid');
		}
		return {
			status: 'validated',
			hash: entry.hash,
			ledgerIndex: lastLedger - 1,
			validated: true,
			engineResult: 'tesSUCCESS',
			txJson,
		};
	}

	async readByApproval(
		principal: string,
		agreementId: string,
		approvalId: string,
	): Promise<RelayEntry | null> {
		const row = await this.database.prepare(`
			SELECT payload_json FROM work_agreement_mock_relay
			WHERE principal = ? AND agreement_id = ? AND approval_id = ?
		`).bind(principal, agreementId, approvalId).first<{ payload_json: string }>();
		return row === null ? null : parseEntry(row.payload_json);
	}
}
