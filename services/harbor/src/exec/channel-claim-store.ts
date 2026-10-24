import { isValidClassicAddress } from 'xrpl';

const CHANNEL_ID = /^[A-F0-9]{64}$/;
const TOKEN = /^[A-F0-9]{64}$/;
const PUBLIC_KEY = /^(?:ED|02|03)[A-F0-9]{64}$/;
const SIGNATURE = /^[A-F0-9]+$/;
const UINT = /^(?:0|[1-9]\d*)$/;
const MAX_DROPS = 100_000_000_000_000_000n;

export interface ChannelClaimProof {
	scheme: 'xrpl-paychan';
	channel_id: string;
	cumulative_drops: string;
	signature: string;
	public_key: string;
}

export interface ChannelClaimRow {
	principal: string;
	mandateId: string;
	merchantId: string;
	channelId: string;
	payer: string;
	channelAmountDrops: string;
	publicKey: string;
	cumulativeDrops: string;
	lastPriceDrops: string | null;
	lastIdempotencyKey: string | null;
	signature: string | null;
	pendingIdempotencyKey: string | null;
	pendingPriceDrops: string | null;
	pendingCumulativeDrops: string | null;
	pendingToken: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ReserveChannelClaimInput {
	principal: string;
	mandateId: string;
	merchantId: string;
	channelId: string;
	payer: string;
	channelAmountDrops: string;
	publicKey: string;
	priceDrops: string;
	idempotencyKey: string;
	token: string;
	at: string;
}

export interface ChannelClaimReservation {
	channelId: string;
	merchantId: string;
	idempotencyKey: string;
	priceDrops: string;
	cumulativeDrops: string;
	token: string;
	publicKey: string;
}

export type ReserveChannelClaimResult =
	| { outcome: 'reserved' | 'owner'; reservation: ChannelClaimReservation; row: ChannelClaimRow }
	| { outcome: 'replay'; proof: ChannelClaimProof; row: ChannelClaimRow }
	| { outcome: 'blocked'; row: ChannelClaimRow };

export interface CompleteChannelClaimInput extends ChannelClaimReservation {
	signature: string;
	at: string;
}

export type CompleteChannelClaimResult = {
	outcome: 'completed' | 'replay' | 'blocked';
	row: ChannelClaimRow;
};

export interface ChannelClaimStore {
	reserve(input: ReserveChannelClaimInput): Promise<ReserveChannelClaimResult>;
	complete(input: CompleteChannelClaimInput): Promise<CompleteChannelClaimResult>;
	get(channelId: string): Promise<ChannelClaimRow | null>;
	list(mandateId: string): Promise<ChannelClaimRow[]>;
}

export class ChannelClaimStoreError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_INPUT'
			| 'INVALID_DATA'
			| 'CLAIM_CAP_EXCEEDED'
			| 'STORE_CONFLICT'
			| 'SCHEMA_UNAVAILABLE',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'ChannelClaimStoreError';
	}
}

type RawRow = Record<string, unknown>;
type RawAttempt = Record<string, unknown>;

interface StoredAttempt {
	merchantId: string;
	channelId: string;
	idempotencyKey: string;
	priceDrops: string;
	cumulativeDrops: string;
	token: string;
	publicKey: string;
	signature: string | null;
	status: 'pending' | 'completed';
}

function text(value: string, field: string, max = 256): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
		throw new ChannelClaimStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return value;
}

function identifier(value: string, field: string): string {
	text(value, field, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
		throw new ChannelClaimStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return value;
}

function timestamp(value: string, field = 'timestamp'): string {
	text(value, field, 40);
	if (new Date(value).toISOString() !== value) {
		throw new ChannelClaimStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return value;
}

function drops(value: string, field: string, allowZero = false): string {
	if (typeof value !== 'string' || value.length > 18 || !UINT.test(value)) {
		throw new ChannelClaimStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	const amount = BigInt(value);
	if (amount > MAX_DROPS || (!allowZero && amount === 0n)) {
		throw new ChannelClaimStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return value;
}

function channelId(value: string): string {
	const normalized = text(value, 'channel id', 64).toUpperCase();
	if (!CHANNEL_ID.test(normalized)) throw new ChannelClaimStoreError('Invalid channel id', 'INVALID_INPUT');
	return normalized;
}

function publicKey(value: string): string {
	const normalized = text(value, 'claim public key', 66).toUpperCase();
	if (!PUBLIC_KEY.test(normalized)) throw new ChannelClaimStoreError('Invalid claim public key', 'INVALID_INPUT');
	return normalized;
}

function signature(value: string): string {
	const normalized = text(value, 'claim signature', 256).toUpperCase();
	if (normalized.length % 2 !== 0 || !SIGNATURE.test(normalized)) {
		throw new ChannelClaimStoreError('Invalid claim signature', 'INVALID_INPUT');
	}
	return normalized;
}

function token(value: string): string {
	const normalized = text(value, 'claim token', 64).toUpperCase();
	if (!TOKEN.test(normalized)) throw new ChannelClaimStoreError('Invalid claim token', 'INVALID_INPUT');
	return normalized;
}

function payer(value: string): string {
	text(value, 'payer', 64);
	if (!isValidClassicAddress(value)) throw new ChannelClaimStoreError('Invalid payer', 'INVALID_INPUT');
	return value;
}

function nullableText(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (typeof value !== 'string') throw new ChannelClaimStoreError(`Invalid stored ${field}`, 'INVALID_DATA');
	return value;
}

function parseRow(raw: RawRow | null): ChannelClaimRow {
	if (raw === null) throw new ChannelClaimStoreError('Missing channel claim row', 'INVALID_DATA');
	try {
		const row: ChannelClaimRow = {
			principal: text(String(raw.principal), 'stored principal'),
			mandateId: identifier(String(raw.mandate_id), 'stored mandate id'),
			merchantId: identifier(String(raw.merchant_id), 'stored merchant id'),
			channelId: channelId(String(raw.channel_id)),
			payer: payer(String(raw.payer)),
			channelAmountDrops: drops(String(raw.channel_amount_drops), 'stored channel amount'),
			publicKey: publicKey(String(raw.public_key)),
			cumulativeDrops: drops(String(raw.cumulative_drops), 'stored cumulative drops', true),
			lastPriceDrops: nullableText(raw.last_price_drops, 'last price'),
			lastIdempotencyKey: nullableText(raw.last_idempotency_key, 'last idempotency key'),
			signature: nullableText(raw.signature, 'signature'),
			pendingIdempotencyKey: nullableText(raw.pending_idempotency_key, 'pending idempotency key'),
			pendingPriceDrops: nullableText(raw.pending_price_drops, 'pending price'),
			pendingCumulativeDrops: nullableText(raw.pending_cumulative_drops, 'pending cumulative drops'),
			pendingToken: nullableText(raw.pending_token, 'pending token'),
			createdAt: timestamp(String(raw.created_at), 'stored created timestamp'),
			updatedAt: timestamp(String(raw.updated_at), 'stored updated timestamp'),
		};
		if (row.lastPriceDrops !== null) drops(row.lastPriceDrops, 'stored last price');
		if (row.lastIdempotencyKey !== null) identifier(row.lastIdempotencyKey, 'stored last idempotency key');
		if (row.signature !== null) signature(row.signature);
		if (row.pendingPriceDrops !== null) drops(row.pendingPriceDrops, 'stored pending price');
		if (row.pendingCumulativeDrops !== null) drops(row.pendingCumulativeDrops, 'stored pending cumulative drops');
		if (row.pendingIdempotencyKey !== null) identifier(row.pendingIdempotencyKey, 'stored pending idempotency key');
		if (row.pendingToken !== null) token(row.pendingToken);
		const completedFields = [row.lastPriceDrops, row.lastIdempotencyKey, row.signature];
		if (completedFields.some((value) => value === null) && completedFields.some((value) => value !== null)) {
			throw new ChannelClaimStoreError('Stored completed claim is incomplete', 'INVALID_DATA');
		}
		const pendingFields = [row.pendingIdempotencyKey, row.pendingPriceDrops, row.pendingCumulativeDrops, row.pendingToken];
		if (pendingFields.some((value) => value === null) && pendingFields.some((value) => value !== null)) {
			throw new ChannelClaimStoreError('Stored pending claim is incomplete', 'INVALID_DATA');
		}
		if (BigInt(row.cumulativeDrops) > BigInt(row.channelAmountDrops)) {
			throw new ChannelClaimStoreError('Stored claim exceeds the channel cap', 'INVALID_DATA');
		}
		return row;
	} catch (error) {
		if (error instanceof ChannelClaimStoreError && error.code === 'INVALID_DATA') throw error;
		throw new ChannelClaimStoreError('Stored channel claim is invalid', 'INVALID_DATA', error);
	}
}

function parseAttempt(raw: RawAttempt | null): StoredAttempt | null {
	if (raw === null) return null;
	try {
		const status = raw.status;
		if (status !== 'pending' && status !== 'completed') {
			throw new ChannelClaimStoreError('Invalid stored claim-attempt status', 'INVALID_DATA');
		}
		const attempt: StoredAttempt = {
			merchantId: identifier(String(raw.merchant_id), 'stored merchant id'),
			channelId: channelId(String(raw.channel_id)),
			idempotencyKey: identifier(String(raw.idempotency_key), 'stored idempotency key'),
			priceDrops: drops(String(raw.price_drops), 'stored claim price'),
			cumulativeDrops: drops(String(raw.cumulative_drops), 'stored claim cumulative'),
			token: token(String(raw.claim_token)),
			publicKey: publicKey(String(raw.public_key)),
			signature: nullableText(raw.signature, 'attempt signature'),
			status,
		};
		if (attempt.signature !== null) signature(attempt.signature);
		if ((attempt.status === 'completed') !== (attempt.signature !== null)) {
			throw new ChannelClaimStoreError('Stored claim attempt is incomplete', 'INVALID_DATA');
		}
		return attempt;
	} catch (error) {
		if (error instanceof ChannelClaimStoreError && error.code === 'INVALID_DATA') throw error;
		throw new ChannelClaimStoreError('Stored claim attempt is invalid', 'INVALID_DATA', error);
	}
}

function proof(row: ChannelClaimRow): ChannelClaimProof {
	if (!row.signature || row.cumulativeDrops === '0') {
		throw new ChannelClaimStoreError('Stored channel claim proof is incomplete', 'INVALID_DATA');
	}
	return {
		scheme: 'xrpl-paychan',
		channel_id: row.channelId,
		cumulative_drops: row.cumulativeDrops,
		signature: row.signature,
		public_key: row.publicKey,
	};
}

function attemptProof(attempt: StoredAttempt): ChannelClaimProof {
	if (attempt.status !== 'completed' || attempt.signature === null) {
		throw new ChannelClaimStoreError('Stored claim attempt proof is incomplete', 'INVALID_DATA');
	}
	return {
		scheme: 'xrpl-paychan',
		channel_id: attempt.channelId,
		cumulative_drops: attempt.cumulativeDrops,
		signature: attempt.signature,
		public_key: attempt.publicKey,
	};
}

function changes(result: D1Result): number {
	return Number(result.meta?.changes ?? 0);
}

const SELECT = `SELECT principal, mandate_id, merchant_id, channel_id, payer,
  channel_amount_drops, public_key, cumulative_drops, last_price_drops,
  last_idempotency_key, signature, pending_idempotency_key, pending_price_drops,
  pending_cumulative_drops, pending_token, created_at, updated_at
FROM ap4m_channel_claims WHERE principal = ? AND channel_id = ?`;

const SELECT_ATTEMPT = `SELECT merchant_id, channel_id, idempotency_key, price_drops,
  cumulative_drops, claim_token, public_key, signature, status
FROM ap4m_channel_claim_attempts
WHERE principal = ? AND channel_id = ? AND idempotency_key = ?`;

export class D1ChannelClaimStore implements ChannelClaimStore {
	private schemaChecked?: Promise<void>;

	constructor(private readonly db: D1Database, private readonly principal: string) {
		text(principal, 'principal');
	}

	private ensureSchema(): Promise<void> {
		return this.schemaChecked ??= Promise.resolve().then(async () => {
			await Promise.all([
				this.db.prepare(`SELECT principal, mandate_id, merchant_id, channel_id, payer,
        channel_amount_drops, public_key, cumulative_drops, last_price_drops,
        last_idempotency_key, signature, pending_idempotency_key, pending_price_drops,
        pending_cumulative_drops, pending_token, created_at, updated_at
        FROM ap4m_channel_claims LIMIT 0`).all(),
				this.db.prepare(`SELECT principal, channel_id, idempotency_key, merchant_id,
        price_drops, cumulative_drops, claim_token, public_key, signature, status,
        created_at, updated_at FROM ap4m_channel_claim_attempts LIMIT 0`).all(),
			]);
		}).catch((error: unknown) => {
			throw new ChannelClaimStoreError(
				'Payment-channel claim schema is unavailable',
				'SCHEMA_UNAVAILABLE',
				error,
			);
		});
	}

	private async required(id: string): Promise<ChannelClaimRow> {
		const raw = await this.db.prepare(SELECT).bind(this.principal, id).first<RawRow>();
		return parseRow(raw);
	}

	private async attempt(id: string, idempotencyKey: string): Promise<StoredAttempt | null> {
		return parseAttempt(await this.db.prepare(SELECT_ATTEMPT)
			.bind(this.principal, id, idempotencyKey).first<RawAttempt>());
	}

	async reserve(input: ReserveChannelClaimInput): Promise<ReserveChannelClaimResult> {
		await this.ensureSchema();
		if (input.principal !== this.principal) throw new ChannelClaimStoreError('Principal mismatch', 'INVALID_INPUT');
		const mandateId = identifier(input.mandateId, 'mandate id');
		const merchantId = identifier(input.merchantId, 'merchant id');
		const id = channelId(input.channelId);
		const selectedPayer = payer(input.payer);
		const channelAmount = drops(input.channelAmountDrops, 'channel amount');
		const selectedPublicKey = publicKey(input.publicKey);
		const price = drops(input.priceDrops, 'claim price');
		const idempotencyKey = identifier(input.idempotencyKey, 'idempotency key');
		const selectedToken = token(input.token);
		const at = timestamp(input.at);

		await this.db.prepare(`INSERT OR IGNORE INTO ap4m_channel_claims (
      principal, mandate_id, merchant_id, channel_id, payer, channel_amount_drops,
      public_key, cumulative_drops, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`).bind(
			this.principal, mandateId, merchantId, id, selectedPayer,
			channelAmount, selectedPublicKey, at, at,
		).run();
		let row = await this.required(id);
		if (
			row.mandateId !== mandateId || row.merchantId !== merchantId || row.payer !== selectedPayer ||
			row.channelAmountDrops !== channelAmount || row.publicKey !== selectedPublicKey
		) {
			throw new ChannelClaimStoreError('Channel binding conflicts with durable state', 'STORE_CONFLICT');
		}
		const existingAttempt = await this.attempt(id, idempotencyKey);
		if (existingAttempt !== null) {
			if (
				existingAttempt.merchantId !== merchantId || existingAttempt.priceDrops !== price ||
				existingAttempt.publicKey !== selectedPublicKey
			) {
				throw new ChannelClaimStoreError('Idempotency key belongs to another claim', 'STORE_CONFLICT');
			}
			if (existingAttempt.status === 'completed') {
				const previous = BigInt(existingAttempt.cumulativeDrops) - BigInt(existingAttempt.priceDrops);
				if (
					previous >= 0n &&
					row.pendingIdempotencyKey === idempotencyKey &&
					row.pendingPriceDrops === existingAttempt.priceDrops &&
					row.pendingCumulativeDrops === existingAttempt.cumulativeDrops &&
					row.pendingToken === existingAttempt.token &&
					existingAttempt.signature !== null
				) {
					await this.db.prepare(`UPDATE ap4m_channel_claims SET
          cumulative_drops = ?, last_price_drops = ?, last_idempotency_key = ?,
          signature = ?, pending_idempotency_key = NULL, pending_price_drops = NULL,
          pending_cumulative_drops = NULL, pending_token = NULL, updated_at = ?
          WHERE principal = ? AND channel_id = ? AND cumulative_drops = ?
            AND pending_idempotency_key = ? AND pending_price_drops = ?
            AND pending_cumulative_drops = ? AND pending_token = ?`).bind(
						existingAttempt.cumulativeDrops, existingAttempt.priceDrops, idempotencyKey,
						existingAttempt.signature, at, this.principal, id,
						previous.toString(), idempotencyKey, existingAttempt.priceDrops,
						existingAttempt.cumulativeDrops, existingAttempt.token,
					).run();
					row = await this.required(id);
				}
				if (
					BigInt(row.cumulativeDrops) < BigInt(existingAttempt.cumulativeDrops) ||
					(row.cumulativeDrops === existingAttempt.cumulativeDrops &&
						row.lastIdempotencyKey !== idempotencyKey)
				) {
					return { outcome: 'blocked', row };
				}
				return { outcome: 'replay', proof: attemptProof(existingAttempt), row };
			}
			if (
				existingAttempt.token === selectedToken && row.pendingIdempotencyKey === null &&
				(BigInt(row.cumulativeDrops) + BigInt(price)).toString() === existingAttempt.cumulativeDrops
			) {
				await this.db.prepare(`UPDATE ap4m_channel_claims SET
          pending_idempotency_key = ?, pending_price_drops = ?, pending_cumulative_drops = ?,
          pending_token = ?, updated_at = ?
          WHERE principal = ? AND channel_id = ? AND cumulative_drops = ?
            AND pending_idempotency_key IS NULL`).bind(
					idempotencyKey, price, existingAttempt.cumulativeDrops, selectedToken, at,
					this.principal, id, row.cumulativeDrops,
				).run();
				row = await this.required(id);
			}
			if (
				existingAttempt.token !== selectedToken || row.pendingIdempotencyKey !== idempotencyKey ||
				row.pendingToken !== selectedToken || row.pendingCumulativeDrops !== existingAttempt.cumulativeDrops
			) {
				return { outcome: 'blocked', row };
			}
			return {
				outcome: 'owner',
				reservation: {
					channelId: id, merchantId, idempotencyKey, priceDrops: price,
					cumulativeDrops: existingAttempt.cumulativeDrops, token: selectedToken,
					publicKey: selectedPublicKey,
				},
				row,
			};
		}
		if (row.pendingIdempotencyKey !== null) {
			if (
				row.pendingIdempotencyKey === idempotencyKey && row.pendingPriceDrops === price &&
				row.pendingToken === selectedToken && row.pendingCumulativeDrops !== null &&
				(BigInt(row.cumulativeDrops) + BigInt(price)).toString() === row.pendingCumulativeDrops
			) {
				await this.db.prepare(`INSERT OR IGNORE INTO ap4m_channel_claim_attempts (
          principal, channel_id, idempotency_key, merchant_id, price_drops,
          cumulative_drops, claim_token, public_key, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(
					this.principal, id, idempotencyKey, merchantId, price,
					row.pendingCumulativeDrops, selectedToken, selectedPublicKey, at, at,
				).run();
				const repaired = await this.attempt(id, idempotencyKey);
				if (
					repaired?.status === 'pending' && repaired.token === selectedToken &&
					repaired.priceDrops === price && repaired.cumulativeDrops === row.pendingCumulativeDrops
				) {
					return {
						outcome: 'owner',
						reservation: {
							channelId: id, merchantId, idempotencyKey, priceDrops: price,
							cumulativeDrops: repaired.cumulativeDrops, token: selectedToken,
							publicKey: selectedPublicKey,
						},
						row,
					};
				}
			}
			return { outcome: 'blocked', row };
		}
		const next = BigInt(row.cumulativeDrops) + BigInt(price);
		if (next > BigInt(channelAmount)) {
			throw new ChannelClaimStoreError('Payment-channel amount would be exceeded', 'CLAIM_CAP_EXCEEDED');
		}
		const cumulative = next.toString();
		const updated = await this.db.prepare(`UPDATE ap4m_channel_claims SET
      pending_idempotency_key = ?, pending_price_drops = ?, pending_cumulative_drops = ?,
      pending_token = ?, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND cumulative_drops = ?
		AND pending_idempotency_key IS NULL`).bind(
			idempotencyKey, price, cumulative, selectedToken, at,
			this.principal, id, row.cumulativeDrops,
		).run();
		row = await this.required(id);
		if (changes(updated) !== 1) {
			return { outcome: 'blocked', row };
		}
		await this.db.prepare(`INSERT OR IGNORE INTO ap4m_channel_claim_attempts (
      principal, channel_id, idempotency_key, merchant_id, price_drops,
      cumulative_drops, claim_token, public_key, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(
			this.principal, id, idempotencyKey, merchantId, price, cumulative,
			selectedToken, selectedPublicKey, at, at,
		).run();
		const insertedAttempt = await this.attempt(id, idempotencyKey);
		if (
			insertedAttempt?.status !== 'pending' || insertedAttempt.token !== selectedToken ||
			insertedAttempt.cumulativeDrops !== cumulative || insertedAttempt.priceDrops !== price
		) {
			throw new ChannelClaimStoreError('Channel claim reservation conflicted', 'STORE_CONFLICT');
		}
		return {
			outcome: 'reserved',
			reservation: {
				channelId: id, merchantId, idempotencyKey, priceDrops: price,
				cumulativeDrops: cumulative, token: selectedToken, publicKey: selectedPublicKey,
			},
			row,
		};
	}

	async complete(input: CompleteChannelClaimInput): Promise<CompleteChannelClaimResult> {
		await this.ensureSchema();
		const id = channelId(input.channelId);
		const merchantId = identifier(input.merchantId, 'merchant id');
		const idempotencyKey = identifier(input.idempotencyKey, 'idempotency key');
		const price = drops(input.priceDrops, 'claim price');
		const cumulative = drops(input.cumulativeDrops, 'claim cumulative');
		const selectedToken = token(input.token);
		const selectedPublicKey = publicKey(input.publicKey);
		const selectedSignature = signature(input.signature);
		const at = timestamp(input.at);
		const attemptUpdate = this.db.prepare(`UPDATE ap4m_channel_claim_attempts SET
        signature = ?, status = 'completed', updated_at = ?
        WHERE principal = ? AND channel_id = ? AND idempotency_key = ?
          AND merchant_id = ? AND price_drops = ? AND cumulative_drops = ?
		  AND claim_token = ? AND public_key = ? AND status = 'pending'
		  AND EXISTS (
		    SELECT 1 FROM ap4m_channel_claims claim
		    WHERE claim.principal = ? AND claim.channel_id = ?
		      AND claim.merchant_id = ? AND claim.public_key = ?
		      AND claim.pending_idempotency_key = ? AND claim.pending_price_drops = ?
		      AND claim.pending_cumulative_drops = ? AND claim.pending_token = ?
		  )`).bind(
				selectedSignature, at, this.principal, id, idempotencyKey,
			merchantId, price, cumulative, selectedToken, selectedPublicKey,
			this.principal, id, merchantId, selectedPublicKey,
			idempotencyKey, price, cumulative, selectedToken,
		);
		const rowUpdate = this.db.prepare(`UPDATE ap4m_channel_claims SET
      cumulative_drops = ?, last_price_drops = ?, last_idempotency_key = ?,
      signature = ?, pending_idempotency_key = NULL, pending_price_drops = NULL,
      pending_cumulative_drops = NULL, pending_token = NULL, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND merchant_id = ? AND public_key = ?
        AND pending_idempotency_key = ? AND pending_price_drops = ?
		AND pending_cumulative_drops = ? AND pending_token = ?
		AND EXISTS (
		  SELECT 1 FROM ap4m_channel_claim_attempts attempt
		  WHERE attempt.principal = ? AND attempt.channel_id = ?
		    AND attempt.idempotency_key = ? AND attempt.signature = ?
		    AND attempt.status = 'completed'
		)`).bind(
			cumulative, price, idempotencyKey, selectedSignature, at,
			this.principal, id, merchantId, selectedPublicKey,
			idempotencyKey, price, cumulative, selectedToken,
			this.principal, id, idempotencyKey, selectedSignature,
		);
		const [attemptUpdated, rowUpdated] = await this.db.batch([attemptUpdate, rowUpdate]);
		let row = await this.required(id);
		if (changes(attemptUpdated) === 1 && changes(rowUpdated) === 1) return { outcome: 'completed', row };
		const attempt = await this.attempt(id, idempotencyKey);
		if (
			attempt?.status === 'completed' && attempt.signature === selectedSignature &&
			attempt.cumulativeDrops === cumulative && attempt.publicKey === selectedPublicKey
		) {
			if (
				row.pendingIdempotencyKey === idempotencyKey && row.pendingToken === selectedToken &&
				row.pendingCumulativeDrops === cumulative
			) {
				await this.db.prepare(`UPDATE ap4m_channel_claims SET
          cumulative_drops = ?, last_price_drops = ?, last_idempotency_key = ?,
          signature = ?, pending_idempotency_key = NULL, pending_price_drops = NULL,
          pending_cumulative_drops = NULL, pending_token = NULL, updated_at = ?
          WHERE principal = ? AND channel_id = ? AND pending_idempotency_key = ?
            AND pending_token = ? AND pending_cumulative_drops = ?`).bind(
					cumulative, price, idempotencyKey, selectedSignature, at,
					this.principal, id, idempotencyKey, selectedToken, cumulative,
				).run();
				row = await this.required(id);
			}
			if (row.cumulativeDrops === cumulative && row.lastIdempotencyKey === idempotencyKey) {
				return { outcome: 'replay', row };
			}
		}
		return { outcome: 'blocked', row };
	}

	async get(value: string): Promise<ChannelClaimRow | null> {
		await this.ensureSchema();
		const id = channelId(value);
		const raw = await this.db.prepare(SELECT).bind(this.principal, id).first<RawRow>();
		return raw === null ? null : parseRow(raw);
	}

	async list(value: string): Promise<ChannelClaimRow[]> {
		await this.ensureSchema();
		const mandateId = identifier(value, 'mandate id');
		const result = await this.db.prepare(`${SELECT.replace('WHERE principal = ? AND channel_id = ?',
			'WHERE principal = ? AND mandate_id = ?')} ORDER BY merchant_id, channel_id`)
			.bind(this.principal, mandateId).all<RawRow>();
		return (result.results ?? []).map((raw) => parseRow(raw));
	}
}

export function channelClaimProof(row: ChannelClaimRow): ChannelClaimProof {
	return proof(row);
}
