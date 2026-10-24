import { deriveAddress, isValidClassicAddress } from 'xrpl';

export type X402PayerNetwork = 'testnet';
export type X402PayerStatus = 'disabled' | 'ready' | 'suspended';

export interface X402PayerRow {
	principal: string;
	owner: string;
	network: X402PayerNetwork;
	payer: string;
	publicKey: string;
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
	status: X402PayerStatus;
	fundedLedgerIndex: number | null;
	fundedBalanceDrops: string | null;
	faucetRequestedAt: string | null;
	fundingCheckedAt: string | null;
	createdAt: string;
	updatedAt: string;
}
export type X402PayerInsert = Omit<
	X402PayerRow,
	'principal' | 'faucetRequestedAt' | 'fundingCheckedAt'
>;

export interface X402PayerUpdate {
	status?: X402PayerStatus;
	fundedLedgerIndex?: number | null;
	fundedBalanceDrops?: string | null;
	updatedAt: string;
}

export type InsertX402PayerInput = X402PayerInsert;
export type UpdateX402PayerInput = X402PayerUpdate;

type RawPayer = {
	principal: unknown;
	owner: unknown;
	network: unknown;
	payer: unknown;
	public_key: unknown;
	ciphertext_hex: unknown;
	iv_hex: unknown;
	status: unknown;
	funded_ledger_index: unknown;
	funded_balance_drops: unknown;
	faucet_requested_at: unknown;
	funding_checked_at: unknown;
	created_at: unknown;
	updated_at: unknown;
};

type PayerStoreErrorCode =
	| 'INVALID_DATA'
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'INVALID_TRANSITION'
	| 'STORAGE_ERROR';

const STATUS = new Set<X402PayerStatus>(['disabled', 'ready', 'suspended']);
const PUBLIC_KEY = /^(?:ED|02|03)[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]*$/;
const MAX_TEXT_LENGTH = 256;
const MAX_DROPS = 9_223_372_036_854_775_807n;

const TRANSITIONS: Readonly<Record<X402PayerStatus, ReadonlySet<X402PayerStatus>>> = {
	disabled: new Set(['ready']),
	ready: new Set(['disabled', 'suspended']),
	suspended: new Set(['disabled', 'ready']),
};

const INSERT_KEYS = new Set([
	'owner', 'network', 'payer', 'publicKey', 'ciphertext', 'iv', 'status',
	'fundedLedgerIndex', 'fundedBalanceDrops', 'createdAt', 'updatedAt',
]);
const UPDATE_KEYS = new Set(['status', 'fundedLedgerIndex', 'fundedBalanceDrops', 'updatedAt']);

export class X402PayerStoreDataError extends Error {
	constructor(
		message: string,
		readonly code: PayerStoreErrorCode = 'INVALID_DATA',
	) {
		super(message);
		this.name = 'X402PayerStoreDataError';
	}
}
function exactObject(value: unknown, allowed: ReadonlySet<string>, field: string): asserts value is Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Object.getOwnPropertySymbols(value).length !== 0 ||
		Object.keys(value).some((key) => !allowed.has(key))
	) {
		throw new X402PayerStoreDataError(`Invalid ${field}`);
	}
}
function requiredText(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_TEXT_LENGTH ||
		value.includes('\0') ||
		value.trim() !== value
	) {
		throw new X402PayerStoreDataError(`Invalid ${field}`);
	}
	return value;
}

function network(value: unknown): X402PayerNetwork {
	if (value !== 'testnet') throw new X402PayerStoreDataError('Invalid network');
	return value;
}

function status(value: unknown): X402PayerStatus {
	if (typeof value !== 'string' || !STATUS.has(value as X402PayerStatus)) {
		throw new X402PayerStoreDataError('Invalid payer status');
	}
	return value as X402PayerStatus;
}

function address(value: unknown, field: string): string {
	const candidate = requiredText(value, field);
	if (!isValidClassicAddress(candidate)) throw new X402PayerStoreDataError(`Invalid ${field}`);
	return candidate;
}

function publicKey(value: unknown): string {
	const candidate = requiredText(value, 'payer public key');
	if (!PUBLIC_KEY.test(candidate)) throw new X402PayerStoreDataError('Invalid payer public key');
	return candidate;
}

function timestamp(value: unknown, field: string): string {
	const candidate = requiredText(value, field);
	try {
		if (new Date(candidate).toISOString() !== candidate) throw new TypeError('non-canonical timestamp');
	} catch {
		throw new X402PayerStoreDataError(`Invalid ${field}`);
	}
	return candidate;
}

function ledgerIndex(value: unknown): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new X402PayerStoreDataError('Invalid funded ledger index');
	}
	return value as number;
}

function balanceDrops(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new X402PayerStoreDataError('Invalid funded balance');
	}
	try {
		if (BigInt(value) > MAX_DROPS) throw new RangeError('out of range');
	} catch {
		throw new X402PayerStoreDataError('Invalid funded balance');
	}
	return value;
}

function validateFundingPair(index: number | null, balance: string | null): void {
	if ((index === null) !== (balance === null)) {
		throw new X402PayerStoreDataError('Funding metadata must be provided together');
	}
}

function bytes(value: unknown, field: string, exactLength?: number): ArrayBuffer {
	let view: Uint8Array;
	if (value instanceof ArrayBuffer) {
		view = new Uint8Array(value);
	} else if (ArrayBuffer.isView(value)) {
		view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	} else {
		throw new X402PayerStoreDataError(`Invalid ${field}`);
	}
	if ((exactLength !== undefined && view.byteLength !== exactLength) || (exactLength === undefined && view.byteLength <= 16)) {
		throw new X402PayerStoreDataError(`Invalid ${field}`);
	}
	const copy = new Uint8Array(view.byteLength);
	copy.set(view);
	return copy.buffer;
}

function hexBytes(value: unknown, field: string, exactLength?: number): ArrayBuffer {
	if (typeof value !== 'string' || value.length % 2 !== 0 || !HEX.test(value)) {
		throw new X402PayerStoreDataError(`Invalid ${field}`);
	}
	const output = new Uint8Array(value.length / 2);
	for (let index = 0; index < output.length; index += 1) {
		output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes(output, field, exactLength);
}

function validateInsert(input: X402PayerInsert): X402PayerInsert {
	exactObject(input, INSERT_KEYS, 'payer record');
	const createdAt = timestamp(input.createdAt, 'created timestamp');
	const updatedAt = timestamp(input.updatedAt, 'updated timestamp');
	if (updatedAt < createdAt) throw new X402PayerStoreDataError('Updated timestamp precedes creation');
	const fundedLedgerIndex = ledgerIndex(input.fundedLedgerIndex);
	const fundedBalanceDrops = balanceDrops(input.fundedBalanceDrops);
	validateFundingPair(fundedLedgerIndex, fundedBalanceDrops);
	const payer = address(input.payer, 'payer address');
	const validatedPublicKey = publicKey(input.publicKey);
	try {
		if (deriveAddress(validatedPublicKey) !== payer) throw new TypeError('public identity mismatch');
	} catch {
		throw new X402PayerStoreDataError('Payer public identity does not match');
	}
	return {
		owner: address(input.owner, 'owner address'),
		network: network(input.network),
		payer,
		publicKey: validatedPublicKey,
		ciphertext: bytes(input.ciphertext, 'payer ciphertext'),
		iv: bytes(input.iv, 'payer IV', 12),
		status: status(input.status),
		fundedLedgerIndex,
		fundedBalanceDrops,
		createdAt,
		updatedAt,
	};
}

function decode(raw: RawPayer): X402PayerRow {
	const row = validateInsert({
		owner: address(raw.owner, 'owner address'),
		network: network(raw.network),
		payer: address(raw.payer, 'payer address'),
		publicKey: publicKey(raw.public_key),
		ciphertext: hexBytes(raw.ciphertext_hex, 'payer ciphertext'),
		iv: hexBytes(raw.iv_hex, 'payer IV', 12),
		status: status(raw.status),
		fundedLedgerIndex: ledgerIndex(raw.funded_ledger_index),
		fundedBalanceDrops: balanceDrops(raw.funded_balance_drops),
		createdAt: timestamp(raw.created_at, 'created timestamp'),
		updatedAt: timestamp(raw.updated_at, 'updated timestamp'),
	});
	return {
		principal: requiredText(raw.principal, 'principal'),
		...row,
		faucetRequestedAt: raw.faucet_requested_at === null
			? null
			: timestamp(raw.faucet_requested_at, 'faucet requested timestamp'),
		fundingCheckedAt: raw.funding_checked_at === null
			? null
			: timestamp(raw.funding_checked_at, 'funding checked timestamp'),
	};
}

const SELECT_PAYER = `SELECT principal, owner, network, payer, public_key,
	hex(ciphertext) AS ciphertext_hex, hex(iv) AS iv_hex, status,
	funded_ledger_index, funded_balance_drops, faucet_requested_at, funding_checked_at,
	created_at, updated_at
	FROM x402_payers WHERE principal = ? AND owner = ? AND network = ?`;

export class X402PayerStore {
	private readonly principal: string;

	constructor(
		private readonly db: D1Database,
		principal: string,
	) {
		this.principal = requiredText(principal, 'principal');
	}

	async get(owner: string, payerNetwork: X402PayerNetwork = 'testnet'): Promise<X402PayerRow | null> {
		const validatedOwner = address(owner, 'owner address');
		const validatedNetwork = network(payerNetwork);
		let raw: RawPayer | null;
		try {
			raw = await this.db.prepare(SELECT_PAYER).bind(this.principal, validatedOwner, validatedNetwork).first<RawPayer>();
		} catch {
			throw new X402PayerStoreDataError('Could not read payer record', 'STORAGE_ERROR');
		}
		if (raw === null) return null;
		const row = decode(raw);
		if (row.principal !== this.principal) {
			throw new X402PayerStoreDataError('Stored payer record has invalid scope', 'STORAGE_ERROR');
		}
		return row;
	}

	async insert(input: X402PayerInsert): Promise<X402PayerRow> {
		const row = validateInsert(input);
		try {
			await this.db.prepare(`INSERT INTO x402_payers (
				principal, owner, network, payer, public_key, ciphertext, iv, status,
				funded_ledger_index, funded_balance_drops, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					this.principal, row.owner, row.network, row.payer, row.publicKey,
					row.ciphertext, row.iv, row.status, row.fundedLedgerIndex,
					row.fundedBalanceDrops, row.createdAt, row.updatedAt,
				)
				.run();
		} catch {
			throw new X402PayerStoreDataError('Payer record already exists', 'CONFLICT');
		}
		return {
			principal: this.principal,
			...row,
			faucetRequestedAt: null,
			fundingCheckedAt: null,
		};
	}

	async markFaucetRequested(
		owner: string,
		payerNetwork: X402PayerNetwork,
		at: string,
	): Promise<{ requested: boolean; row: X402PayerRow }> {
		const validatedOwner = address(owner, 'owner address');
		const validatedNetwork = network(payerNetwork);
		const requestedAt = timestamp(at, 'faucet requested timestamp');
		let result: D1Result;
		try {
			result = await this.db.prepare(`UPDATE x402_payers
				SET faucet_requested_at = ?, updated_at = ?
				WHERE principal = ? AND owner = ? AND network = ?
				AND status = 'disabled' AND faucet_requested_at IS NULL`)
				.bind(requestedAt, requestedAt, this.principal, validatedOwner, validatedNetwork)
				.run();
		} catch {
			throw new X402PayerStoreDataError('Could not record faucet request', 'STORAGE_ERROR');
		}
		const row = await this.get(validatedOwner, validatedNetwork);
		if (row === null) throw new X402PayerStoreDataError('Payer record not found', 'NOT_FOUND');
		if (result.meta.changes !== undefined && result.meta.changes === 1) return { requested: true, row };
		if (row.status === 'disabled' && row.faucetRequestedAt !== null) return { requested: false, row };
		throw new X402PayerStoreDataError('Payer cannot request funding', 'INVALID_TRANSITION');
	}

	async markFundingPending(
		owner: string,
		payerNetwork: X402PayerNetwork,
		checkedAt: string,
	): Promise<X402PayerRow> {
		const validatedOwner = address(owner, 'owner address');
		const validatedNetwork = network(payerNetwork);
		const observedAt = timestamp(checkedAt, 'funding checked timestamp');
		let result: D1Result;
		try {
			result = await this.db.prepare(`UPDATE x402_payers
				SET funding_checked_at = ?, updated_at = ?
				WHERE principal = ? AND owner = ? AND network = ? AND status = 'disabled'
				AND faucet_requested_at IS NOT NULL`)
				.bind(observedAt, observedAt, this.principal, validatedOwner, validatedNetwork)
				.run();
		} catch {
			throw new X402PayerStoreDataError('Could not record funding check', 'STORAGE_ERROR');
		}
		if (result.meta.changes !== undefined && result.meta.changes !== 1) {
			throw new X402PayerStoreDataError('Payer cannot record funding check', 'INVALID_TRANSITION');
		}
		const row = await this.get(validatedOwner, validatedNetwork);
		if (row === null) throw new X402PayerStoreDataError('Payer record not found', 'NOT_FOUND');
		return row;
	}

	async markReadyFromFunding(
		owner: string,
		payerNetwork: X402PayerNetwork,
		input: { ledgerIndex: number; balanceDrops: string; checkedAt: string },
	): Promise<X402PayerRow> {
		exactObject(input, new Set(['ledgerIndex', 'balanceDrops', 'checkedAt']), 'funding observation');
		const validatedOwner = address(owner, 'owner address');
		const validatedNetwork = network(payerNetwork);
		const validatedLedgerIndex = ledgerIndex(input.ledgerIndex);
		const validatedBalance = balanceDrops(input.balanceDrops);
		const observedAt = timestamp(input.checkedAt, 'funding checked timestamp');
		if (validatedLedgerIndex === null || validatedBalance === null || BigInt(validatedBalance) === 0n) {
			throw new X402PayerStoreDataError('Invalid funded account observation');
		}
		let result: D1Result;
		try {
			result = await this.db.prepare(`UPDATE x402_payers SET
				status = 'ready', funded_ledger_index = ?, funded_balance_drops = ?,
				funding_checked_at = ?, updated_at = ?
				WHERE principal = ? AND owner = ? AND network = ? AND status = 'disabled'
				AND faucet_requested_at IS NOT NULL`)
				.bind(
					validatedLedgerIndex, validatedBalance, observedAt, observedAt,
					this.principal, validatedOwner, validatedNetwork,
				)
				.run();
		} catch {
			throw new X402PayerStoreDataError('Could not activate funded payer', 'STORAGE_ERROR');
		}
		if (result.meta.changes !== undefined && result.meta.changes !== 1) {
			throw new X402PayerStoreDataError('Payer cannot become ready', 'INVALID_TRANSITION');
		}
		const row = await this.get(validatedOwner, validatedNetwork);
		if (row === null) throw new X402PayerStoreDataError('Payer record not found', 'NOT_FOUND');
		return row;
	}

	async update(
		owner: string,
		payerNetwork: X402PayerNetwork,
		input: X402PayerUpdate,
	): Promise<X402PayerRow> {
		exactObject(input, UPDATE_KEYS, 'payer update');
		const existing = await this.get(owner, payerNetwork);
		if (existing === null) throw new X402PayerStoreDataError('Payer record not found', 'NOT_FOUND');
		const updatedAt = timestamp(input.updatedAt, 'updated timestamp');
		if (updatedAt < existing.updatedAt) throw new X402PayerStoreDataError('Updated timestamp is stale');

		const nextStatus = input.status === undefined ? existing.status : status(input.status);
		if (nextStatus !== existing.status && !TRANSITIONS[existing.status].has(nextStatus)) {
			throw new X402PayerStoreDataError('Invalid payer status transition', 'INVALID_TRANSITION');
		}
		const nextLedger = input.fundedLedgerIndex === undefined
			? existing.fundedLedgerIndex
			: ledgerIndex(input.fundedLedgerIndex);
		const nextBalance = input.fundedBalanceDrops === undefined
			? existing.fundedBalanceDrops
			: balanceDrops(input.fundedBalanceDrops);
		validateFundingPair(nextLedger, nextBalance);

		let result: D1Result;
		try {
			result = await this.db.prepare(`UPDATE x402_payers
				SET status = ?, funded_ledger_index = ?, funded_balance_drops = ?, updated_at = ?
				WHERE principal = ? AND owner = ? AND network = ? AND status = ?`)
				.bind(
					nextStatus, nextLedger, nextBalance, updatedAt, this.principal,
					existing.owner, existing.network, existing.status,
				)
				.run();
		} catch {
			throw new X402PayerStoreDataError('Could not update payer record', 'STORAGE_ERROR');
		}
		if (result.meta.changes !== undefined && result.meta.changes !== 1) {
			throw new X402PayerStoreDataError('Payer record changed concurrently', 'CONFLICT');
		}
		return {
			...existing,
			status: nextStatus,
			fundedLedgerIndex: nextLedger,
			fundedBalanceDrops: nextBalance,
			updatedAt,
		};
	}
}
