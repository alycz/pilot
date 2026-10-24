import { AP4M_EVM_EVENT_PROFILE } from './event-config';

export type Ap4mEvmAttemptStatus = 'prepared' | 'submission_unknown' | 'confirmed' | 'failed_absent';

export interface Ap4mEvmChannelRow {
	principal: string;
	channelId: string;
	merchantId: string;
	agentWallet: string;
	fundingWallet: string;
	payoutWallet: string;
	tokenAddress: string;
	generation: number;
	capBaseUnits: string;
	cumulativeBaseUnits: string;
	status: 'open' | 'closed';
	pendingIdempotencyKey: string | null;
	pendingRequestFingerprint: string | null;
	pendingNextCumulative: string | null;
	pendingAttemptToken: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Ap4mEvmAttemptRow {
	principal: string;
	channelId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	merchantId: string;
	previousCumulative: string;
	nextCumulative: string;
	attemptToken: string;
	status: Ap4mEvmAttemptStatus;
	txHash: string | null;
	receiptFingerprint: string | null;
	blockNumber: number | null;
	confirmations: number | null;
	absenceFingerprint: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ReserveAp4mEvmVoucherInput {
	principal: string;
	channelId: string;
	merchantId: string;
	agentWallet: string;
	fundingWallet: string;
	payoutWallet: string;
	tokenAddress: string;
	generation: number;
	capBaseUnits: string;
	nextCumulative: string;
	idempotencyKey: string;
	requestFingerprint: string;
	attemptToken: string;
	at: string;
}

export type ReserveAp4mEvmVoucherResult =
	| { outcome: 'reserved' | 'owner' | 'pending' | 'replay'; channel: Ap4mEvmChannelRow; attempt: Ap4mEvmAttemptRow }
	| { outcome: 'mismatch' | 'blocked'; channel: Ap4mEvmChannelRow; attempt?: Ap4mEvmAttemptRow };

export interface MarkAp4mEvmSubmissionUnknownInput {
	channelId: string;
	idempotencyKey: string;
	attemptToken: string;
	txHash: string;
	at: string;
}

export interface ConfirmAp4mEvmReceiptInput extends MarkAp4mEvmSubmissionUnknownInput {
	receiptFingerprint: string;
	blockNumber: number;
	confirmations: number;
}

export interface FailAp4mEvmAbsentInput extends MarkAp4mEvmSubmissionUnknownInput {
	absenceFingerprint: string;
}

export type Ap4mEvmTransitionResult = {
	outcome: 'transitioned' | 'replay' | 'mismatch' | 'blocked';
	channel: Ap4mEvmChannelRow;
	attempt: Ap4mEvmAttemptRow;
};

export interface Ap4mEvmStore {
	reserve(input: ReserveAp4mEvmVoucherInput): Promise<ReserveAp4mEvmVoucherResult>;
	markSubmissionUnknown(input: MarkAp4mEvmSubmissionUnknownInput): Promise<Ap4mEvmTransitionResult>;
	confirm(input: ConfirmAp4mEvmReceiptInput): Promise<Ap4mEvmTransitionResult>;
	markAbsent(input: FailAp4mEvmAbsentInput): Promise<Ap4mEvmTransitionResult>;
	getChannel(channelId: string): Promise<Ap4mEvmChannelRow | null>;
	getAttempt(channelId: string, idempotencyKey: string): Promise<Ap4mEvmAttemptRow | null>;
	getAttemptByHash(txHash: string): Promise<Ap4mEvmAttemptRow | null>;
}

export class Ap4mEvmStoreError extends Error {
	constructor(
		message: string,
		readonly code: 'INVALID_INPUT' | 'INVALID_DATA' | 'CAP_EXCEEDED' | 'STORE_CONFLICT' | 'SCHEMA_UNAVAILABLE',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'Ap4mEvmStoreError';
	}
}

type Raw = Record<string, unknown>;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT127 = (1n << 127n) - 1n;

function requiredText(value: unknown, field: string, max: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
		throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return value;
}

function identifier(value: unknown, field: string): string {
	const selected = requiredText(value, field, 128);
	if (!IDENTIFIER.test(selected)) throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	return selected;
}

function address(value: unknown, field: string): string {
	const normalized = requiredText(value, field, 42).toLowerCase();
	if (!ADDRESS.test(normalized) || normalized === `0x${'0'.repeat(40)}`) {
		throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return normalized;
}

function bytes32(value: unknown, field: string): string {
	const normalized = requiredText(value, field, 66).toLowerCase();
	if (!BYTES32.test(normalized)) throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	return normalized;
}

function digest(value: unknown, field: string): string {
	const normalized = requiredText(value, field, 64).toLowerCase();
	if (!DIGEST.test(normalized)) throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	return normalized;
}

function amount(value: unknown, field: string, allowZero = false): string {
	const selected = requiredText(value, field, 39);
	if (!UINT.test(selected)) throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	const parsed = BigInt(selected);
	if (parsed > MAX_UINT127 || (!allowZero && parsed === 0n)) {
		throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	}
	return selected;
}

function timestamp(value: unknown, field = 'timestamp'): string {
	const selected = requiredText(value, field, 40);
	if (new Date(selected).toISOString() !== selected) throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	return selected;
}

function positiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Ap4mEvmStoreError(`Invalid ${field}`, 'INVALID_INPUT');
	return Number(value);
}

function nullableText(value: unknown, field: string): string | null {
	return value === null ? null : requiredText(value, field, 256);
}

function parseStatus(value: unknown): Ap4mEvmAttemptStatus {
	if (value !== 'prepared' && value !== 'submission_unknown' && value !== 'confirmed' && value !== 'failed_absent') {
		throw new Ap4mEvmStoreError('Invalid stored attempt status', 'INVALID_DATA');
	}
	return value;
}

function parseChannel(raw: Raw | null): Ap4mEvmChannelRow {
	if (raw === null) throw new Ap4mEvmStoreError('Missing EVM channel', 'INVALID_DATA');
	try {
		if (raw.status !== 'open' && raw.status !== 'closed') throw new Error('status');
		const parsed: Ap4mEvmChannelRow = {
			principal: requiredText(raw.principal, 'stored principal', 256),
			channelId: bytes32(raw.channel_id, 'stored channel id'),
			merchantId: identifier(raw.merchant_id, 'stored merchant id'),
			agentWallet: address(raw.agent_wallet, 'stored agent wallet'),
			fundingWallet: address(raw.funding_wallet, 'stored funding wallet'),
			payoutWallet: address(raw.payout_wallet, 'stored payout wallet'),
			tokenAddress: address(raw.token_address, 'stored token address'),
			generation: Number.isSafeInteger(raw.generation) && Number(raw.generation) >= 0
				? Number(raw.generation)
				: (() => { throw new Error('generation'); })(),
			capBaseUnits: amount(raw.cap_base_units, 'stored cap'),
			cumulativeBaseUnits: amount(raw.cumulative_base_units, 'stored cumulative', true),
			status: raw.status,
			pendingIdempotencyKey: nullableText(raw.pending_idempotency_key, 'stored pending idempotency key'),
			pendingRequestFingerprint: nullableText(raw.pending_request_fingerprint, 'stored pending fingerprint'),
			pendingNextCumulative: nullableText(raw.pending_next_cumulative, 'stored pending cumulative'),
			pendingAttemptToken: nullableText(raw.pending_attempt_token, 'stored pending token'),
			createdAt: timestamp(raw.created_at, 'stored created timestamp'),
			updatedAt: timestamp(raw.updated_at, 'stored updated timestamp'),
		};
		if (parsed.pendingIdempotencyKey !== null) identifier(parsed.pendingIdempotencyKey, 'stored pending idempotency key');
		if (parsed.pendingRequestFingerprint !== null) digest(parsed.pendingRequestFingerprint, 'stored pending fingerprint');
		if (parsed.pendingNextCumulative !== null) amount(parsed.pendingNextCumulative, 'stored pending cumulative');
		if (parsed.pendingAttemptToken !== null) digest(parsed.pendingAttemptToken, 'stored pending token');
		const pending = [parsed.pendingIdempotencyKey, parsed.pendingRequestFingerprint, parsed.pendingNextCumulative, parsed.pendingAttemptToken];
		if (pending.some((value) => value === null) && pending.some((value) => value !== null)) throw new Error('pending');
		if (BigInt(parsed.cumulativeBaseUnits) > BigInt(parsed.capBaseUnits)) throw new Error('cap');
		if (parsed.pendingNextCumulative !== null && (
			BigInt(parsed.pendingNextCumulative) <= BigInt(parsed.cumulativeBaseUnits) ||
			BigInt(parsed.pendingNextCumulative) > BigInt(parsed.capBaseUnits)
		)) throw new Error('pending amount');
		if (parsed.payoutWallet === parsed.agentWallet || parsed.payoutWallet === parsed.fundingWallet) throw new Error('roles');
		return parsed;
	} catch (error) {
		throw new Ap4mEvmStoreError('Stored EVM channel is invalid', 'INVALID_DATA', error);
	}
}

function parseAttempt(raw: Raw | null): Ap4mEvmAttemptRow | null {
	if (raw === null) return null;
	try {
		const parsed: Ap4mEvmAttemptRow = {
			principal: requiredText(raw.principal, 'stored principal', 256),
			channelId: bytes32(raw.channel_id, 'stored channel id'),
			idempotencyKey: identifier(raw.idempotency_key, 'stored idempotency key'),
			requestFingerprint: digest(raw.request_fingerprint, 'stored request fingerprint'),
			merchantId: identifier(raw.merchant_id, 'stored merchant id'),
			previousCumulative: amount(raw.previous_cumulative, 'stored previous cumulative', true),
			nextCumulative: amount(raw.next_cumulative, 'stored next cumulative'),
			attemptToken: digest(raw.attempt_token, 'stored attempt token'),
			status: parseStatus(raw.status),
			txHash: raw.tx_hash === null ? null : bytes32(raw.tx_hash, 'stored transaction hash'),
			receiptFingerprint: raw.receipt_fingerprint === null ? null : digest(raw.receipt_fingerprint, 'stored receipt fingerprint'),
			blockNumber: raw.block_number === null ? null : positiveInteger(raw.block_number, 'stored block number'),
			confirmations: raw.confirmations === null ? null : positiveInteger(raw.confirmations, 'stored confirmations'),
			absenceFingerprint: raw.absence_fingerprint === null ? null : digest(raw.absence_fingerprint, 'stored absence fingerprint'),
			createdAt: timestamp(raw.created_at, 'stored created timestamp'),
			updatedAt: timestamp(raw.updated_at, 'stored updated timestamp'),
		};
		if (BigInt(parsed.nextCumulative) <= BigInt(parsed.previousCumulative)) throw new Error('non-monotonic');
		if (parsed.status === 'prepared' && [parsed.txHash, parsed.receiptFingerprint, parsed.blockNumber, parsed.confirmations, parsed.absenceFingerprint].some((value) => value !== null)) throw new Error('prepared evidence');
		if (parsed.status === 'submission_unknown' && (parsed.txHash === null || [parsed.receiptFingerprint, parsed.blockNumber, parsed.confirmations, parsed.absenceFingerprint].some((value) => value !== null))) throw new Error('unknown evidence');
		if (parsed.status === 'confirmed' && (parsed.txHash === null || parsed.receiptFingerprint === null || parsed.blockNumber === null || parsed.confirmations === null || parsed.absenceFingerprint !== null)) throw new Error('confirmation evidence');
		if (parsed.status === 'failed_absent' && (parsed.txHash === null || parsed.absenceFingerprint === null || [parsed.receiptFingerprint, parsed.blockNumber, parsed.confirmations].some((value) => value !== null))) throw new Error('absence evidence');
		return parsed;
	} catch (error) {
		throw new Ap4mEvmStoreError('Stored EVM attempt is invalid', 'INVALID_DATA', error);
	}
}

function changes(result: D1Result): number {
	return Number(result.meta?.changes ?? 0);
}

const CHANNEL_SELECT = `SELECT principal, channel_id, merchant_id, agent_wallet, funding_wallet,
  payout_wallet, token_address, generation, cap_base_units, cumulative_base_units, status,
  pending_idempotency_key, pending_request_fingerprint, pending_next_cumulative,
  pending_attempt_token, created_at, updated_at
FROM ap4m_evm_channels WHERE principal = ? AND channel_id = ?`;

const ATTEMPT_COLUMNS = `principal, channel_id, idempotency_key, request_fingerprint,
  merchant_id, previous_cumulative, next_cumulative, attempt_token, status, tx_hash,
  receipt_fingerprint, block_number, confirmations, absence_fingerprint, created_at, updated_at`;
const ATTEMPT_SELECT = `SELECT ${ATTEMPT_COLUMNS}
FROM ap4m_evm_attempts WHERE principal = ? AND channel_id = ? AND idempotency_key = ?`;

export class D1Ap4mEvmStore implements Ap4mEvmStore {
	private schemaChecked?: Promise<void>;

	constructor(private readonly db: D1Database, private readonly principal: string) {
		requiredText(principal, 'principal', 256);
	}

	private ensureSchema(): Promise<void> {
		return this.schemaChecked ??= Promise.resolve().then(() => Promise.all([
			this.db.prepare(`SELECT principal, channel_id FROM ap4m_evm_channels LIMIT 0`).all(),
			this.db.prepare(`SELECT principal, channel_id, idempotency_key FROM ap4m_evm_attempts LIMIT 0`).all(),
			this.db.prepare(`SELECT sequence, principal FROM ap4m_evm_journal LIMIT 0`).all(),
		])).then(() => undefined).catch((error: unknown) => {
			throw new Ap4mEvmStoreError('AP4M EVM schema is unavailable', 'SCHEMA_UNAVAILABLE', error);
		});
	}

	private async requiredChannel(id: string): Promise<Ap4mEvmChannelRow> {
		return parseChannel(await this.db.prepare(CHANNEL_SELECT).bind(this.principal, id).first<Raw>());
	}

	async getChannel(value: string): Promise<Ap4mEvmChannelRow | null> {
		await this.ensureSchema();
		const id = bytes32(value, 'channel id');
		const raw = await this.db.prepare(CHANNEL_SELECT).bind(this.principal, id).first<Raw>();
		return raw === null ? null : parseChannel(raw);
	}

	async getAttempt(channel: string, key: string): Promise<Ap4mEvmAttemptRow | null> {
		await this.ensureSchema();
		return parseAttempt(await this.db.prepare(ATTEMPT_SELECT)
			.bind(this.principal, bytes32(channel, 'channel id'), identifier(key, 'idempotency key')).first<Raw>());
	}

	async getAttemptByHash(value: string): Promise<Ap4mEvmAttemptRow | null> {
		await this.ensureSchema();
		return parseAttempt(await this.db.prepare(`SELECT ${ATTEMPT_COLUMNS}
      FROM ap4m_evm_attempts WHERE principal = ? AND tx_hash = ?`)
			.bind(this.principal, bytes32(value, 'transaction hash')).first<Raw>());
	}

	async reserve(input: ReserveAp4mEvmVoucherInput): Promise<ReserveAp4mEvmVoucherResult> {
		await this.ensureSchema();
		if (input.principal !== this.principal) throw new Ap4mEvmStoreError('Principal mismatch', 'INVALID_INPUT');
		const id = bytes32(input.channelId, 'channel id');
		const merchant = identifier(input.merchantId, 'merchant id');
		const agent = address(input.agentWallet, 'agent wallet');
		const funding = address(input.fundingWallet, 'funding wallet');
		const payout = address(input.payoutWallet, 'payout wallet');
		const token = address(input.tokenAddress, 'token address');
		if (token !== AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase()) {
			throw new Ap4mEvmStoreError('Token does not match event RLUSD', 'INVALID_INPUT');
		}
		if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
			throw new Ap4mEvmStoreError('Invalid channel generation', 'INVALID_INPUT');
		}
		if (payout === agent || payout === funding) {
			throw new Ap4mEvmStoreError('Merchant payout must differ from agent and funding wallets', 'INVALID_INPUT');
		}
		const cap = amount(input.capBaseUnits, 'channel cap');
		const next = amount(input.nextCumulative, 'next cumulative');
		if (BigInt(next) > BigInt(cap)) throw new Ap4mEvmStoreError('Channel cap exceeded', 'CAP_EXCEEDED');
		const key = identifier(input.idempotencyKey, 'idempotency key');
		const fingerprint = digest(input.requestFingerprint, 'request fingerprint');
		const attemptToken = digest(input.attemptToken, 'attempt token');
		const at = timestamp(input.at);

		await this.db.prepare(`INSERT OR IGNORE INTO ap4m_evm_channels (
      principal, channel_id, merchant_id, agent_wallet, funding_wallet, payout_wallet,
      token_address, generation, cap_base_units, cumulative_base_units, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', 'open', ?, ?)`).bind(
			this.principal, id, merchant, agent, funding, payout, token, input.generation, cap, at, at,
		).run();
		let channel = await this.requiredChannel(id);
		if (
			channel.merchantId !== merchant || channel.agentWallet !== agent ||
			channel.fundingWallet !== funding || channel.payoutWallet !== payout ||
			channel.tokenAddress !== token || channel.generation !== input.generation || channel.capBaseUnits !== cap
		) throw new Ap4mEvmStoreError('Channel binding conflicts with durable state', 'STORE_CONFLICT');
		if (channel.status !== 'open') return { outcome: 'blocked', channel };

		let existing = await this.getAttempt(id, key);
		if (existing !== null) {
			if (existing.requestFingerprint !== fingerprint || existing.nextCumulative !== next || existing.merchantId !== merchant) {
				return { outcome: 'mismatch', channel, attempt: existing };
			}
			if (existing.status === 'confirmed') {
				if (this.pendingMatches(channel, existing)) {
					await this.advanceConfirmed(channel, existing, at);
					channel = await this.requiredChannel(id);
				}
				if (channel.cumulativeBaseUnits !== existing.nextCumulative) return { outcome: 'blocked', channel, attempt: existing };
				await this.appendJournal(id, key, 'confirmed', existing.receiptFingerprint!, at);
				return { outcome: 'replay', channel, attempt: existing };
			}
			if (existing.status === 'failed_absent') {
				if (this.pendingMatches(channel, existing)) {
					await this.clearAbsent(channel, existing, at);
					channel = await this.requiredChannel(id);
				}
				if (channel.cumulativeBaseUnits !== existing.previousCumulative || channel.pendingIdempotencyKey === key) return { outcome: 'blocked', channel, attempt: existing };
				await this.appendJournal(id, key, 'failed_absent', existing.absenceFingerprint!, at);
				return { outcome: 'replay', channel, attempt: existing };
			}
			if (!this.pendingMatches(channel, existing)) return { outcome: 'blocked', channel, attempt: existing };
			if (existing.status === 'submission_unknown') {
				await this.appendJournal(id, key, 'submission_unknown', existing.txHash!.slice(2), at);
				return { outcome: 'pending', channel, attempt: existing };
			}
			await this.appendJournal(id, key, 'reserved', existing.attemptToken, at);
			return { outcome: existing.attemptToken === attemptToken ? 'owner' : 'pending', channel, attempt: existing };
		}

		if (channel.pendingIdempotencyKey !== null) {
			if (
				channel.pendingIdempotencyKey !== key || channel.pendingRequestFingerprint !== fingerprint ||
				channel.pendingNextCumulative !== next || channel.pendingAttemptToken !== attemptToken
			) return { outcome: 'blocked', channel };
			await this.insertAttempt(channel, { key, fingerprint, next, attemptToken, merchant, at });
			existing = await this.getAttempt(id, key);
			if (existing === null) throw new Ap4mEvmStoreError('EVM attempt repair failed', 'STORE_CONFLICT');
			if (!this.pendingMatches(channel, existing)) {
				throw new Ap4mEvmStoreError('EVM attempt repair conflicts with durable state', 'STORE_CONFLICT');
			}
			return { outcome: 'owner', channel, attempt: existing };
		}

		if (BigInt(next) <= BigInt(channel.cumulativeBaseUnits)) {
			throw new Ap4mEvmStoreError('Voucher cumulative amount must increase', 'INVALID_INPUT');
		}
		const updated = await this.db.prepare(`UPDATE ap4m_evm_channels SET
      pending_idempotency_key = ?, pending_request_fingerprint = ?, pending_next_cumulative = ?,
      pending_attempt_token = ?, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND status = 'open'
        AND cumulative_base_units = ? AND pending_idempotency_key IS NULL`).bind(
			key, fingerprint, next, attemptToken, at, this.principal, id, channel.cumulativeBaseUnits,
		).run();
		channel = await this.requiredChannel(id);
		if (changes(updated) !== 1) return { outcome: 'blocked', channel };
		await this.insertAttempt(channel, { key, fingerprint, next, attemptToken, merchant, at });
		existing = await this.getAttempt(id, key);
		if (existing === null) throw new Ap4mEvmStoreError('EVM attempt reservation failed', 'STORE_CONFLICT');
		return { outcome: 'reserved', channel, attempt: existing };
	}

	private async insertAttempt(
		channel: Ap4mEvmChannelRow,
		input: { key: string; fingerprint: string; next: string; attemptToken: string; merchant: string; at: string },
	): Promise<void> {
		await this.db.prepare(`INSERT OR IGNORE INTO ap4m_evm_attempts (
      principal, channel_id, idempotency_key, request_fingerprint, merchant_id,
      previous_cumulative, next_cumulative, attempt_token, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`).bind(
			this.principal, channel.channelId, input.key, input.fingerprint, input.merchant,
			channel.cumulativeBaseUnits, input.next, input.attemptToken, input.at, input.at,
		).run();
		await this.appendJournal(channel.channelId, input.key, 'reserved', input.attemptToken, input.at);
	}

	private async appendJournal(
		channelId: string,
		idempotencyKey: string,
		event: 'reserved' | 'submission_unknown' | 'confirmed' | 'failed_absent',
		transitionKey: string,
		at: string,
	): Promise<void> {
		await this.db.prepare(`INSERT OR IGNORE INTO ap4m_evm_journal (
      principal, channel_id, idempotency_key, event, transition_key, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).bind(
			this.principal, channelId, idempotencyKey, event, digest(transitionKey, 'transition key'), at,
		).run();
	}

	private async requiredAttempt(channel: string, key: string): Promise<Ap4mEvmAttemptRow> {
		const row = await this.getAttempt(channel, key);
		if (row === null) throw new Ap4mEvmStoreError('Missing EVM attempt', 'INVALID_DATA');
		return row;
	}

	private pendingMatches(channel: Ap4mEvmChannelRow, attempt: Ap4mEvmAttemptRow): boolean {
		return channel.principal === attempt.principal && channel.channelId === attempt.channelId &&
			channel.merchantId === attempt.merchantId &&
			channel.cumulativeBaseUnits === attempt.previousCumulative &&
			channel.pendingIdempotencyKey === attempt.idempotencyKey &&
			channel.pendingRequestFingerprint === attempt.requestFingerprint &&
			channel.pendingNextCumulative === attempt.nextCumulative &&
			channel.pendingAttemptToken === attempt.attemptToken;
	}

	async markSubmissionUnknown(input: MarkAp4mEvmSubmissionUnknownInput): Promise<Ap4mEvmTransitionResult> {
		await this.ensureSchema();
		const id = bytes32(input.channelId, 'channel id');
		const key = identifier(input.idempotencyKey, 'idempotency key');
		const attemptToken = digest(input.attemptToken, 'attempt token');
		const txHash = bytes32(input.txHash, 'transaction hash');
		const at = timestamp(input.at);
		let attempt = await this.requiredAttempt(id, key);
		let channel = await this.requiredChannel(id);
		if (attempt.attemptToken !== attemptToken) return { outcome: 'mismatch', channel, attempt };
		if (attempt.status === 'submission_unknown') {
			if (attempt.txHash !== txHash) return { outcome: 'mismatch', channel, attempt };
			if (!this.pendingMatches(channel, attempt)) return { outcome: 'blocked', channel, attempt };
			await this.appendJournal(id, key, 'submission_unknown', txHash.slice(2), at);
			return { outcome: 'replay', channel, attempt };
		}
		if (attempt.status !== 'prepared' || !this.pendingMatches(channel, attempt)) {
			return { outcome: 'blocked', channel, attempt };
		}
		try {
			await this.db.prepare(`UPDATE ap4m_evm_attempts SET status = 'submission_unknown',
      tx_hash = ?, updated_at = ? WHERE principal = ? AND channel_id = ? AND idempotency_key = ?
      AND status = 'prepared' AND attempt_token = ?`).bind(
				txHash, at, this.principal, id, key, attemptToken,
			).run();
		} catch (error) {
			throw new Ap4mEvmStoreError('Submission transition conflicted with durable state', 'STORE_CONFLICT', error);
		}
		attempt = await this.requiredAttempt(id, key);
		channel = await this.requiredChannel(id);
		if (attempt.status === 'submission_unknown' && attempt.txHash === txHash) {
			await this.appendJournal(id, key, 'submission_unknown', txHash.slice(2), at);
		}
		return {
			outcome: attempt.status === 'submission_unknown' && attempt.txHash === txHash ? 'transitioned' : 'blocked',
			channel,
			attempt,
		};
	}

	async confirm(input: ConfirmAp4mEvmReceiptInput): Promise<Ap4mEvmTransitionResult> {
		await this.ensureSchema();
		const id = bytes32(input.channelId, 'channel id');
		const key = identifier(input.idempotencyKey, 'idempotency key');
		const attemptToken = digest(input.attemptToken, 'attempt token');
		const txHash = bytes32(input.txHash, 'transaction hash');
		const receipt = digest(input.receiptFingerprint, 'receipt fingerprint');
		const block = positiveInteger(input.blockNumber, 'block number');
		const confirmations = positiveInteger(input.confirmations, 'confirmations');
		const at = timestamp(input.at);
		let attempt = await this.requiredAttempt(id, key);
		let channel = await this.requiredChannel(id);
		if (attempt.attemptToken !== attemptToken || attempt.txHash !== txHash) return { outcome: 'mismatch', channel, attempt };
		if (attempt.status === 'confirmed') {
			const matches = attempt.receiptFingerprint === receipt && attempt.blockNumber === block && attempt.confirmations === confirmations;
			if (matches && this.pendingMatches(channel, attempt)) {
				await this.advanceConfirmed(channel, attempt, at);
				channel = await this.requiredChannel(id);
			}
			if (!matches) return { outcome: 'mismatch', channel, attempt };
			if (channel.cumulativeBaseUnits !== attempt.nextCumulative) return { outcome: 'blocked', channel, attempt };
			await this.appendJournal(id, key, 'confirmed', receipt, at);
			return { outcome: 'replay', channel, attempt };
		}
		if (attempt.status !== 'submission_unknown' || !this.pendingMatches(channel, attempt)) {
			return { outcome: 'blocked', channel, attempt };
		}
		await this.db.prepare(`UPDATE ap4m_evm_attempts SET status = 'confirmed',
      receipt_fingerprint = ?, block_number = ?, confirmations = ?, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND idempotency_key = ?
        AND status = 'submission_unknown' AND tx_hash = ? AND attempt_token = ?`).bind(
			receipt, block, confirmations, at, this.principal, id, key, txHash, attemptToken,
		).run();
		attempt = await this.requiredAttempt(id, key);
		if (attempt.status !== 'confirmed') return { outcome: 'blocked', channel, attempt };
		await this.appendJournal(id, key, 'confirmed', receipt, at);
		await this.advanceConfirmed(channel, attempt, at);
		channel = await this.requiredChannel(id);
		return { outcome: channel.cumulativeBaseUnits === attempt.nextCumulative ? 'transitioned' : 'blocked', channel, attempt };
	}

	private async advanceConfirmed(channel: Ap4mEvmChannelRow, attempt: Ap4mEvmAttemptRow, at: string): Promise<void> {
		await this.db.prepare(`UPDATE ap4m_evm_channels SET cumulative_base_units = ?,
      pending_idempotency_key = NULL, pending_request_fingerprint = NULL,
      pending_next_cumulative = NULL, pending_attempt_token = NULL, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND status = 'open'
        AND cumulative_base_units = ? AND pending_idempotency_key = ?
        AND pending_request_fingerprint = ? AND pending_next_cumulative = ?
        AND pending_attempt_token = ?`).bind(
			attempt.nextCumulative, at, this.principal, channel.channelId, attempt.previousCumulative,
			attempt.idempotencyKey, attempt.requestFingerprint, attempt.nextCumulative, attempt.attemptToken,
		).run();
	}

	private async clearAbsent(channel: Ap4mEvmChannelRow, attempt: Ap4mEvmAttemptRow, at: string): Promise<void> {
		await this.db.prepare(`UPDATE ap4m_evm_channels SET
      pending_idempotency_key = NULL, pending_request_fingerprint = NULL,
      pending_next_cumulative = NULL, pending_attempt_token = NULL, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND cumulative_base_units = ?
        AND pending_idempotency_key = ? AND pending_request_fingerprint = ?
        AND pending_next_cumulative = ? AND pending_attempt_token = ?`).bind(
			at, this.principal, channel.channelId, attempt.previousCumulative, attempt.idempotencyKey,
			attempt.requestFingerprint, attempt.nextCumulative, attempt.attemptToken,
		).run();
	}

	async markAbsent(input: FailAp4mEvmAbsentInput): Promise<Ap4mEvmTransitionResult> {
		await this.ensureSchema();
		const id = bytes32(input.channelId, 'channel id');
		const key = identifier(input.idempotencyKey, 'idempotency key');
		const attemptToken = digest(input.attemptToken, 'attempt token');
		const txHash = bytes32(input.txHash, 'transaction hash');
		const absence = digest(input.absenceFingerprint, 'absence fingerprint');
		const at = timestamp(input.at);
		let attempt = await this.requiredAttempt(id, key);
		let channel = await this.requiredChannel(id);
		if (attempt.attemptToken !== attemptToken || attempt.txHash !== txHash) return { outcome: 'mismatch', channel, attempt };
		if (attempt.status === 'failed_absent') {
			if (attempt.absenceFingerprint !== absence) return { outcome: 'mismatch', channel, attempt };
			if (this.pendingMatches(channel, attempt)) {
				await this.clearAbsent(channel, attempt, at);
				channel = await this.requiredChannel(id);
			}
			if (channel.cumulativeBaseUnits !== attempt.previousCumulative || channel.pendingIdempotencyKey === key) return { outcome: 'blocked', channel, attempt };
			await this.appendJournal(id, key, 'failed_absent', absence, at);
			return { outcome: 'replay', channel, attempt };
		}
		if (attempt.status !== 'submission_unknown' || !this.pendingMatches(channel, attempt)) {
			return { outcome: 'blocked', channel, attempt };
		}
		await this.db.prepare(`UPDATE ap4m_evm_attempts SET status = 'failed_absent',
      absence_fingerprint = ?, updated_at = ?
      WHERE principal = ? AND channel_id = ? AND idempotency_key = ?
        AND status = 'submission_unknown' AND tx_hash = ? AND attempt_token = ?`).bind(
			absence, at, this.principal, id, key, txHash, attemptToken,
		).run();
		attempt = await this.requiredAttempt(id, key);
		if (attempt.status !== 'failed_absent') return { outcome: 'blocked', channel, attempt };
		await this.appendJournal(id, key, 'failed_absent', absence, at);
		await this.clearAbsent(channel, attempt, at);
		channel = await this.requiredChannel(id);
		return { outcome: channel.pendingIdempotencyKey === null ? 'transitioned' : 'blocked', channel, attempt };
	}
}
