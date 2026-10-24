import { decode, hashes, type IssuedCurrencyAmount, type Payment } from 'xrpl';

import type { SignedTransaction } from './keys';
import { validateAp4mSignedPayment } from './ap4m-purchase';

type JsonObject = Record<string, unknown>;

const HASH = /^[A-F0-9]{64}$/;
const PARTIAL_PAYMENT_FLAG = 0x0002_0000;
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d*[1-9]))?(?:[eE]([+-]?\d+))?$/;

export class Ap4mSettlementError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'SETTLEMENT_PENDING'
			| 'INVALID_SETTLEMENT_EVIDENCE'
			| 'SETTLEMENT_FAILED'
			| 'SETTLEMENT_MISMATCH',
	) {
		super(message);
		this.name = 'Ap4mSettlementError';
	}
}

export interface ValidateAp4mSettlementInput {
	signed: SignedTransaction;
	expectedPayment: Payment;
	/** A `tx` RPC result, with or without the outer `{ result }` envelope. */
	evidence: unknown;
}

export interface ValidatedAp4mSettlement {
	hash: string;
	ledgerIndex: number;
	deliveredAmount: IssuedCurrencyAmount;
}

export type ClassifiedAp4mSettlement =
	| { status: 'success'; settlement: ValidatedAp4mSettlement }
	| { status: 'failed'; hash: string; ledgerIndex: number; transactionResult: string };

export interface Ap4mAbsentSettlementInput {
	lookupCode: string;
	validatedLedgerIndex: number;
	firstEligibleLedgerIndex: number;
	lastLedgerSequence: number;
	/** Ledgers independently checked for the exact locally-derived hash. */
	inclusionLedgersChecked: readonly number[];
}

export type Ap4mAbsentSettlement =
	| { status: 'pending' }
	| { status: 'expired-absent'; checkedFrom: number; checkedThrough: number };

function record(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!record(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, canonical(nested)]),
	);
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function integer(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Ap4mSettlementError(`${field} is invalid`, 'INVALID_SETTLEMENT_EVIDENCE');
	}
	return Number(value);
}

function transactionResult(value: unknown): JsonObject {
	if (!record(value)) {
		throw new Ap4mSettlementError('Settlement response is invalid', 'INVALID_SETTLEMENT_EVIDENCE');
	}
	const result = record(value.result) ? value.result : value;
	if (!record(result)) {
		throw new Ap4mSettlementError('Settlement response is invalid', 'INVALID_SETTLEMENT_EVIDENCE');
	}
	return result;
}

function transactionJson(result: JsonObject): JsonObject {
	if (record(result.tx_json)) return result.tx_json;
	const omitted = new Set(['validated', 'ledger_index', 'ledger_hash', 'close_time_iso', 'meta', 'meta_blob', 'hash']);
	return Object.fromEntries(Object.entries(result).filter(([key]) => !omitted.has(key)));
}

function exactSignedTransaction(actual: JsonObject, expected: JsonObject): void {
	for (const forbidden of ['SendMax', 'DeliverMin', 'Paths']) {
		if (Object.hasOwn(actual, forbidden) || Object.hasOwn(expected, forbidden)) {
			throw new Ap4mSettlementError(
				`AP4M settlement contains forbidden ${forbidden}`,
				'SETTLEMENT_MISMATCH',
			);
		}
	}
	const flags = actual.Flags ?? expected.Flags ?? 0;
	if (!Number.isSafeInteger(flags) || (Number(flags) & PARTIAL_PAYMENT_FLAG) !== 0) {
		throw new Ap4mSettlementError(
			'AP4M settlement enables partial payment',
			'SETTLEMENT_MISMATCH',
		);
	}
	if (!equal(actual, expected)) {
		throw new Ap4mSettlementError(
			'Validated transaction does not match the signed AP4M Payment',
			'SETTLEMENT_MISMATCH',
		);
	}
}

function issuedAmount(value: unknown, field: string): IssuedCurrencyAmount {
	if (
		!record(value) ||
		typeof value.currency !== 'string' ||
		typeof value.issuer !== 'string' ||
		typeof value.value !== 'string'
	) {
		throw new Ap4mSettlementError(`${field} is invalid`, 'INVALID_SETTLEMENT_EVIDENCE');
	}
	return {
		currency: value.currency,
		issuer: value.issuer,
		value: value.value,
	};
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
	const match = DECIMAL.exec(value);
	if (!match) {
		throw new Ap4mSettlementError('Delivered amount is invalid', 'INVALID_SETTLEMENT_EVIDENCE');
	}
	const [mantissa, fraction = ''] = value.toLowerCase().split('e')[0]!.split('.');
	const exponent = Number(match[3] ?? 0);
	if (!Number.isSafeInteger(exponent) || exponent < -96 || exponent > 80) {
		throw new Ap4mSettlementError('Delivered amount is invalid', 'INVALID_SETTLEMENT_EVIDENCE');
	}
	const coefficient = BigInt(`${mantissa}${fraction}`);
	return { coefficient, scale: fraction.length - exponent };
}

function atLeast(actual: string, required: string): boolean {
	const left = decimalParts(actual);
	const right = decimalParts(required);
	const scale = Math.max(left.scale, right.scale, 0);
	const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
	const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
	return leftValue >= rightValue;
}

/**
 * Validate settlement from ledger evidence rather than trusting the merchant.
 * The locally signed blob remains the source of truth for every Payment field.
 */
export function validateAp4mSettlement(
	input: ValidateAp4mSettlementInput,
): ValidatedAp4mSettlement {
	const classified = classifyAp4mSettlement(input);
	if (classified.status === 'failed') {
		throw new Ap4mSettlementError('AP4M Payment did not succeed', 'SETTLEMENT_FAILED');
	}
	return classified.settlement;
}

/** Classify only exact, validated ledger evidence as success or terminal failure. */
export function classifyAp4mSettlement(
	input: ValidateAp4mSettlementInput,
): ClassifiedAp4mSettlement {
	const signed = validateAp4mSignedPayment(input.signed, input.expectedPayment);
	let signedTransaction: JsonObject;
	let derivedHash: string;
	try {
		signedTransaction = decode(signed.tx_blob) as JsonObject;
		derivedHash = hashes.hashSignedTx(signed.tx_blob).toUpperCase();
	} catch {
		throw new Ap4mSettlementError('Signed Payment is invalid', 'INVALID_SETTLEMENT_EVIDENCE');
	}
	if (!HASH.test(derivedHash) || derivedHash !== signed.hash) {
		throw new Ap4mSettlementError('Signed Payment hash does not match', 'SETTLEMENT_MISMATCH');
	}

	const result = transactionResult(input.evidence);
	if (result.validated !== true) {
		throw new Ap4mSettlementError('AP4M settlement is not validated', 'SETTLEMENT_PENDING');
	}
	if (typeof result.hash !== 'string' || result.hash.toUpperCase() !== derivedHash) {
		throw new Ap4mSettlementError('Validated settlement hash does not match', 'SETTLEMENT_MISMATCH');
	}
	const ledgerIndex = integer(result.ledger_index, 'settlement ledger index');
	const lastLedgerSequence = integer(signedTransaction.LastLedgerSequence, 'last ledger sequence');
	if (ledgerIndex > lastLedgerSequence) {
		throw new Ap4mSettlementError(
			'Validated settlement is outside the authorized ledger window',
			'SETTLEMENT_MISMATCH',
		);
	}
	const actualTransaction = transactionJson(result);
	exactSignedTransaction(actualTransaction, signedTransaction);
	if (signedTransaction.TransactionType !== 'Payment') {
		throw new Ap4mSettlementError('Signed transaction is not a Payment', 'SETTLEMENT_MISMATCH');
	}
	if (!record(result.meta) || typeof result.meta.TransactionResult !== 'string' ||
		!/^(?:tesSUCCESS|tec[A-Z0-9_]{1,64})$/.test(result.meta.TransactionResult)) {
		throw new Ap4mSettlementError('Settlement result is invalid', 'INVALID_SETTLEMENT_EVIDENCE');
	}
	if (result.meta.TransactionResult !== 'tesSUCCESS') {
		return { status: 'failed', hash: derivedHash, ledgerIndex,
			transactionResult: result.meta.TransactionResult };
	}
	const required = issuedAmount(signedTransaction.Amount, 'signed Payment amount');
	const delivered = issuedAmount(result.meta.DeliveredAmount, 'delivered amount');
	if (
		delivered.currency !== required.currency ||
		delivered.issuer !== required.issuer ||
		!atLeast(delivered.value, required.value)
	) {
		throw new Ap4mSettlementError(
			'Delivered amount does not satisfy the signed AP4M Payment',
			'SETTLEMENT_MISMATCH',
		);
	}
	return { status: 'success', settlement: { hash: derivedHash, ledgerIndex, deliveredAmount: delivered } };
}

/**
 * A single `txnNotFound` is never absence proof. Expiry is final only after a
 * later validated ledger and an exact, contiguous check of every eligible
 * inclusion ledger through LastLedgerSequence.
 */
export function classifyAbsentAp4mSettlement(
	input: Ap4mAbsentSettlementInput,
): Ap4mAbsentSettlement {
	const validated = integer(input.validatedLedgerIndex, 'validated ledger index');
	const first = integer(input.firstEligibleLedgerIndex, 'first eligible ledger index');
	const last = integer(input.lastLedgerSequence, 'last ledger sequence');
	if (first > last || input.lookupCode !== 'txnNotFound' || validated <= last) {
		return { status: 'pending' };
	}
	const checked = [...new Set(input.inclusionLedgersChecked)].sort((left, right) => left - right);
	if (
		checked.length !== last - first + 1 ||
		checked.some((ledger, index) => ledger !== first + index)
	) {
		return { status: 'pending' };
	}
	return { status: 'expired-absent', checkedFrom: first, checkedThrough: last };
}
