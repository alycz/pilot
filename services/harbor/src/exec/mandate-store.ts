import {
  Ap4mReceiptSchema,
  MandateConstraintsSchema,
  MandateSchema,
  type Ap4mReceipt,
  type Mandate,
} from '../contracts';

type JsonObject = Record<string, unknown>;

interface MandateDbRow {
	id: string;
	principal: string;
	owner: string;
	network: string;
	status: string;
	execution_type: string;
	not_before: string;
	expires_at: string;
	constraints_json: string;
	agent_public_jwk: string;
	agent_key_enc: unknown;
	agent_key_iv: unknown;
	claim_keys_enc: unknown;
	claim_keys_iv: unknown;
	claim_public_keys_json: string;
	prepared_json: string;
	l1_digest: string;
	l2_digest: string;
	vi_chain_enc: unknown | null;
	vi_chain_iv: unknown | null;
	setup_batch_hash: string | null;
	channels_json: string;
	spent_usd: string;
	close_requested: number;
	created_at: string;
	updated_at: string;
}

interface SpendDbRow {
	id: string;
	principal: string;
	mandate_id: string;
	spend_day: string;
	idempotency_key: string;
	amount_usd: string;
	status: 'reserved' | 'committed' | 'released';
	receipt_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface StoredMandate {
	mandate: Mandate;
	agentKeyCiphertext: ArrayBuffer;
	agentKeyIv: ArrayBuffer;
	claimKeysCiphertext: ArrayBuffer;
	claimKeysIv: ArrayBuffer;
	claimPublicKeys: Array<{ merchant_id: string; public_key: string }>;
	prepared: {
		unsigned_batch: JsonObject;
		unsigned_sequential?: JsonObject[];
	};
	closeRequested: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface InsertPreparedMandate {
	id: string;
	owner: string;
	notBefore: string;
	expiresAt: string;
	constraints: Mandate['constraints'];
	agentPublicJwk: JsonObject;
	agentKeyCiphertext: ArrayBuffer;
	agentKeyIv: ArrayBuffer;
	claimKeysCiphertext: ArrayBuffer;
	claimKeysIv: ArrayBuffer;
	claimPublicKeys: Array<{ merchant_id: string; public_key: string }>;
	prepared: StoredMandate['prepared'];
	createdAt: string;
}

export interface ActivateMandate {
	l1Digest: string;
	l2Digest: string;
	viChainCiphertext: ArrayBuffer;
	viChainIv: ArrayBuffer;
	setupBatchHash: string;
	channels: Mandate['channels'];
	updatedAt: string;
}

export interface StoredWrappedViChain {
	owner: string;
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
}

export interface SpendReservation {
	id: string;
	mandateId: string;
	day: string;
	idempotencyKey: string;
	amountUsd: string;
	status: 'reserved' | 'committed' | 'released';
	receiptId?: string;
	createdAt: string;
	updatedAt: string;
}

export class MandateStoreError extends Error {
	constructor(
		message: string,
		readonly code: 'INVALID_DATA' | 'NOT_FOUND' | 'SPEND_LIMIT' | 'SPEND_CONFLICT',
	) {
		super(message);
		this.name = 'MandateStoreError';
	}
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new MandateStoreError(`${label} is invalid`, 'INVALID_DATA');
	}
}

function asBuffer(value: unknown, label: string): ArrayBuffer {
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (ArrayBuffer.isView(value)) {
		const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return Uint8Array.from(view).buffer;
	}
	throw new MandateStoreError(`${label} is invalid`, 'INVALID_DATA');
}

function decimalMicrousd(value: string, label: string): number {
	if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
		throw new MandateStoreError(`${label} must be a nonnegative decimal string`, 'INVALID_DATA');
	}
	const [whole, fraction = ''] = value.split('.');
	if (fraction.length > 6) throw new MandateStoreError(`${label} supports at most six decimal places`, 'INVALID_DATA');
	const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
	if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new MandateStoreError(`${label} is too large`, 'INVALID_DATA');
	return Number(micros);
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

function changed(result: D1Result): number {
	return Number(result.meta?.changes ?? 0);
}

function mandateFromRow(row: MandateDbRow): StoredMandate {
	const constraints = MandateConstraintsSchema.parse(parseJson(row.constraints_json, 'mandate constraints'));
	const agentPublicJwk = parseJson(row.agent_public_jwk, 'agent public JWK');
	const channels = parseJson(row.channels_json, 'mandate channels');
	const claimPublicKeys = parseJson(row.claim_public_keys_json, 'claim public keys');
	const prepared = parseJson(row.prepared_json, 'prepared mandate');
	if (!Array.isArray(claimPublicKeys) || !prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
		throw new MandateStoreError('prepared mandate data is invalid', 'INVALID_DATA');
	}
	for (const key of claimPublicKeys) {
		if (
			!key ||
			typeof key !== 'object' ||
			Array.isArray(key) ||
			typeof (key as JsonObject).merchant_id !== 'string' ||
			typeof (key as JsonObject).public_key !== 'string'
		) {
			throw new MandateStoreError('claim public keys are invalid', 'INVALID_DATA');
		}
	}
	const preparedRecord = prepared as JsonObject;
	if (!preparedRecord.unsigned_batch || typeof preparedRecord.unsigned_batch !== 'object') {
		throw new MandateStoreError('prepared Batch is invalid', 'INVALID_DATA');
	}
	const mandate = MandateSchema.parse({
		id: row.id,
		owner: row.owner,
		network: row.network,
		status: row.status,
		execution_type: row.execution_type,
		not_before: row.not_before,
		expires_at: row.expires_at,
		constraints,
		agent_public_jwk: agentPublicJwk,
		l1_digest: row.l1_digest,
		l2_digest: row.l2_digest,
		...(row.setup_batch_hash ? { setup_batch_hash: row.setup_batch_hash } : {}),
		channels,
		spent_usd: row.spent_usd,
	});
	return {
		mandate,
		agentKeyCiphertext: asBuffer(row.agent_key_enc, 'agent key ciphertext'),
		agentKeyIv: asBuffer(row.agent_key_iv, 'agent key IV'),
		claimKeysCiphertext: asBuffer(row.claim_keys_enc, 'claim key ciphertext'),
		claimKeysIv: asBuffer(row.claim_keys_iv, 'claim key IV'),
		claimPublicKeys: claimPublicKeys as StoredMandate['claimPublicKeys'],
		prepared: {
			unsigned_batch: preparedRecord.unsigned_batch as JsonObject,
			...(Array.isArray(preparedRecord.unsigned_sequential)
				? { unsigned_sequential: preparedRecord.unsigned_sequential as JsonObject[] }
				: {}),
		},
		closeRequested: row.close_requested === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function reservationFromRow(row: SpendDbRow): SpendReservation {
	return {
		id: row.id,
		mandateId: row.mandate_id,
		day: row.spend_day,
		idempotencyKey: row.idempotency_key,
		amountUsd: row.amount_usd,
		status: row.status,
		...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class MandateStore {
	constructor(
		private readonly db: D1Database,
		private readonly principal: string,
	) {
		if (!principal) throw new MandateStoreError('principal is required', 'INVALID_DATA');
	}

	async insertPrepared(input: InsertPreparedMandate): Promise<StoredMandate> {
		MandateConstraintsSchema.parse(input.constraints);
		await this.db
			.prepare(
				`INSERT INTO ap4m_mandates (
				  id, principal, owner, network, status, execution_type,
				  not_before, expires_at, constraints_json, agent_public_jwk,
				  agent_key_enc, agent_key_iv, claim_keys_enc, claim_keys_iv,
				  claim_public_keys_json, prepared_json, created_at, updated_at
				) VALUES (?, ?, ?, 'testnet', 'PENDING', 'DEFERRED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				this.principal,
				input.owner,
				input.notBefore,
				input.expiresAt,
				json(input.constraints),
				json(input.agentPublicJwk),
				input.agentKeyCiphertext,
				input.agentKeyIv,
				input.claimKeysCiphertext,
				input.claimKeysIv,
				json(input.claimPublicKeys),
				json(input.prepared),
				input.createdAt,
				input.createdAt,
			)
			.run();
		const stored = await this.get(input.id);
		if (!stored) throw new MandateStoreError('prepared mandate was not stored', 'NOT_FOUND');
		return stored;
	}

	async get(id: string): Promise<StoredMandate | null> {
		const row = await this.db
			.prepare('SELECT * FROM ap4m_mandates WHERE id = ? AND principal = ?')
			.bind(id, this.principal)
			.first<MandateDbRow>();
		return row ? mandateFromRow(row) : null;
	}

	async activate(id: string, input: ActivateMandate): Promise<StoredMandate> {
		const result = await this.db
			.prepare(
				`UPDATE ap4m_mandates
				 SET status = 'ACTIVE', l1_digest = ?, l2_digest = ?, vi_chain_enc = ?, vi_chain_iv = ?, setup_batch_hash = ?,
				     channels_json = ?, updated_at = ?
				 WHERE id = ? AND principal = ? AND status = 'PENDING'`,
			)
			.bind(
				input.l1Digest,
				input.l2Digest,
				input.viChainCiphertext,
				input.viChainIv,
				input.setupBatchHash,
				json(input.channels),
				input.updatedAt,
				id,
				this.principal,
			)
			.run();
		if (changed(result) !== 1) throw new MandateStoreError('pending mandate not found', 'NOT_FOUND');
		const stored = await this.get(id);
		if (!stored) throw new MandateStoreError('activated mandate not found', 'NOT_FOUND');
		return stored;
	}

	/** Return only the wrapped public chain for internal MH4 merchant transport. */
	async getWrappedViChain(id: string): Promise<StoredWrappedViChain | null> {
		const row = await this.db
			.prepare(
				`SELECT owner, vi_chain_enc, vi_chain_iv
				 FROM ap4m_mandates
				 WHERE id = ? AND principal = ? AND status = 'ACTIVE'`,
			)
			.bind(id, this.principal)
			.first<{ owner: string; vi_chain_enc: unknown | null; vi_chain_iv: unknown | null }>();
		if (!row) return null;
		if (row.vi_chain_enc === null || row.vi_chain_iv === null) {
			throw new MandateStoreError('active mandate VI chain is missing', 'INVALID_DATA');
		}
		return {
			owner: row.owner,
			ciphertext: asBuffer(row.vi_chain_enc, 'VI chain ciphertext'),
			iv: asBuffer(row.vi_chain_iv, 'VI chain IV'),
		};
	}

	async revoke(id: string, updatedAt: string): Promise<StoredMandate> {
		const result = await this.db
			.prepare(
				`UPDATE ap4m_mandates
				 SET status = 'REVOKED', close_requested = 1, updated_at = ?
				 WHERE id = ? AND principal = ? AND status IN ('PENDING', 'ACTIVE')`,
			)
			.bind(updatedAt, id, this.principal)
			.run();
		if (changed(result) !== 1) {
			const existing = await this.get(id);
			if (!existing) throw new MandateStoreError('mandate not found', 'NOT_FOUND');
			if (existing.mandate.status !== 'REVOKED') {
				throw new MandateStoreError('mandate cannot be revoked', 'SPEND_CONFLICT');
			}
			return existing;
		}
		const stored = await this.get(id);
		if (!stored) throw new MandateStoreError('revoked mandate not found', 'NOT_FOUND');
		return stored;
	}

	async dailySpentUsd(mandateId: string, day: string): Promise<number> {
		const row = await this.db
			.prepare(
				`SELECT COALESCE(SUM(amount_microusd), 0) AS total_micros
				 FROM ap4m_spend
				 WHERE principal = ? AND mandate_id = ? AND spend_day = ?
				   AND status IN ('reserved', 'committed')`,
			)
			.bind(this.principal, mandateId, day)
			.first<{ total_micros: number }>();
		return Number(row?.total_micros ?? 0) / 1_000_000;
	}

	async findReservation(mandateId: string, idempotencyKey: string): Promise<SpendReservation | null> {
		const row = await this.db
			.prepare(
				`SELECT * FROM ap4m_spend
				 WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?`,
			)
			.bind(this.principal, mandateId, idempotencyKey)
			.first<SpendDbRow>();
		return row ? reservationFromRow(row) : null;
	}

	async reserveSpend(input: {
		id: string;
		mandateId: string;
		day: string;
		idempotencyKey: string;
		amountUsd: string;
		now: string;
	}): Promise<SpendReservation> {
		const amountMicros = decimalMicrousd(input.amountUsd, 'amountUsd');
		const mandate = await this.get(input.mandateId);
		if (!mandate || mandate.mandate.status !== 'ACTIVE') throw new MandateStoreError('active mandate not found', 'NOT_FOUND');
		const totalMaxMicros = decimalMicrousd(mandate.mandate.constraints.total_max, 'mandate total_max');
		const dailyMaxMicros = decimalMicrousd(mandate.mandate.constraints.daily_max, 'mandate daily_max');
		const existing = await this.findReservation(input.mandateId, input.idempotencyKey);
		if (existing) {
			if (existing.amountUsd !== input.amountUsd || existing.day !== input.day) {
				throw new MandateStoreError('idempotency key was already used for a different spend', 'SPEND_CONFLICT');
			}
			return existing;
		}

		try {
			const [insert] = await this.db.batch([
				this.db
					.prepare(
						`INSERT INTO ap4m_spend (
						  id, principal, mandate_id, spend_day, idempotency_key,
						  amount_usd, amount_microusd, status, created_at, updated_at
						)
						SELECT ?, ?, id, ?, ?, ?, ?, 'reserved', ?, ?
						FROM ap4m_mandates
						WHERE id = ? AND principal = ? AND status = 'ACTIVE'
						  AND spent_microusd + ? <= ?
						  AND (SELECT COALESCE(SUM(amount_microusd), 0)
						       FROM ap4m_spend
						       WHERE principal = ? AND mandate_id = ? AND spend_day = ?
						         AND status IN ('reserved', 'committed')) + ? <= ?`,
					)
					.bind(
						input.id,
						this.principal,
						input.day,
						input.idempotencyKey,
						input.amountUsd,
						amountMicros,
						input.now,
						input.now,
						input.mandateId,
						this.principal,
						amountMicros,
						totalMaxMicros,
						this.principal,
						input.mandateId,
						input.day,
						amountMicros,
						dailyMaxMicros,
					),
				this.db
					.prepare(
						`UPDATE ap4m_mandates
						 SET spent_microusd = spent_microusd + ?,
						     spent_usd = printf('%.6f', (spent_microusd + ?) / 1000000.0), updated_at = ?
						 WHERE id = ? AND principal = ?
						   AND EXISTS (SELECT 1 FROM ap4m_spend WHERE id = ? AND principal = ?)`,
					)
					.bind(amountMicros, amountMicros, input.now, input.mandateId, this.principal, input.id, this.principal),
			]);
			if (changed(insert) !== 1) {
				throw new MandateStoreError('mandate spend limits would be exceeded', 'SPEND_LIMIT');
			}
		} catch (error) {
			const raced = await this.findReservation(input.mandateId, input.idempotencyKey);
			if (raced) {
				if (raced.amountUsd !== input.amountUsd || raced.day !== input.day) {
					throw new MandateStoreError('idempotency key was already used for a different spend', 'SPEND_CONFLICT');
				}
				return raced;
			}
			if (error instanceof MandateStoreError) throw error;
			throw new MandateStoreError('mandate spend reservation conflicted', 'SPEND_CONFLICT');
		}
		const reserved = await this.findReservation(input.mandateId, input.idempotencyKey);
		if (!reserved) throw new MandateStoreError('mandate spend reservation was not stored', 'SPEND_CONFLICT');
		return reserved;
	}

	async commitReservation(id: string, receipt: Ap4mReceipt, now: string): Promise<SpendReservation> {
		const validated = Ap4mReceiptSchema.parse(receipt);
		const [update] = await this.db.batch([
			this.db
				.prepare(
					`UPDATE ap4m_spend SET status = 'committed', receipt_id = ?, updated_at = ?
					 WHERE id = ? AND principal = ? AND status = 'reserved'`,
				)
				.bind(validated.receipt_id, now, id, this.principal),
			this.db
				.prepare(
					`INSERT INTO ap4m_receipts (
					  id, principal, mandate_id, merchant_id, idempotency_key, json, created_at
					)
					SELECT ?, principal, mandate_id, ?, idempotency_key, ?, ?
					FROM ap4m_spend WHERE id = ? AND principal = ?`,
				)
				.bind(validated.receipt_id, validated.merchant_id, json(validated), now, id, this.principal),
		]);
		if (changed(update) !== 1) throw new MandateStoreError('spend reservation not found', 'NOT_FOUND');
		const row = await this.db
			.prepare('SELECT * FROM ap4m_spend WHERE id = ? AND principal = ?')
			.bind(id, this.principal)
			.first<SpendDbRow>();
		if (!row) throw new MandateStoreError('spend reservation not found', 'NOT_FOUND');
		return reservationFromRow(row);
	}

	async releaseReservation(id: string, now: string): Promise<SpendReservation> {
		const row = await this.db
			.prepare('SELECT * FROM ap4m_spend WHERE id = ? AND principal = ?')
			.bind(id, this.principal)
			.first<SpendDbRow>();
		if (!row) throw new MandateStoreError('spend reservation not found', 'NOT_FOUND');
		if (row.status === 'released') return reservationFromRow(row);
		if (row.status !== 'reserved') throw new MandateStoreError('committed spend cannot be released', 'SPEND_CONFLICT');
		const amountMicros = decimalMicrousd(row.amount_usd, 'amount_usd');
		await this.db.batch([
			this.db
				.prepare(`UPDATE ap4m_spend SET status = 'released', updated_at = ? WHERE id = ? AND principal = ? AND status = 'reserved'`)
				.bind(now, id, this.principal),
			this.db
				.prepare(
					`UPDATE ap4m_mandates
					 SET spent_microusd = MAX(0, spent_microusd - ?),
					     spent_usd = printf('%.6f', MAX(0, spent_microusd - ?) / 1000000.0), updated_at = ?
					 WHERE id = ? AND principal = ? AND changes() = 1`,
				)
				.bind(amountMicros, amountMicros, now, row.mandate_id, this.principal),
		]);
		const released = await this.findReservation(row.mandate_id, row.idempotency_key);
		if (!released) throw new MandateStoreError('released reservation not found', 'NOT_FOUND');
		return released;
	}
}
