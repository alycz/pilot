import { isValidClassicAddress, type IssuedCurrencyAmount, type Payment } from 'xrpl';

import type { Network } from '../contracts';

type JsonObject = Record<string, unknown>;

const HASH_256 = /^[A-F0-9]{64}$/;
const POSITIVE_DROPS = /^[1-9]\d*$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_DROPS = 100_000_000_000_000_000n;
const MAX_LEDGER_DISTANCE = 1;
const MAX_ISSUED_VALUE_LENGTH = 96;
const MAX_ISSUED_SIGNIFICANT_DIGITS = 16;
const MIN_ISSUED_EXPONENT = -96;
const MAX_ISSUED_EXPONENT = 80;
const XRP_HEX_CURRENCY = '0000000000000000000000005852500000000000';
const ZERO_HEX_CURRENCY = '0000000000000000000000000000000000000000';

export type Ap4mCrossCurrencyErrorCode =
	| 'INVALID_PAYMENT_CONTEXT'
	| 'INVALID_PATH_QUOTE'
	| 'PATH_QUOTE_STALE'
	| 'INVALID_DELIVERY_EVIDENCE'
	| 'DELIVERY_MISMATCH'
	| 'SUBMISSION_ROUTE_UNAVAILABLE';

export class Ap4mCrossCurrencyError extends Error {
	constructor(message: string, readonly code: Ap4mCrossCurrencyErrorCode) {
		super(message);
		this.name = 'Ap4mCrossCurrencyError';
	}
}

export interface BuildAp4mCrossCurrencyPaymentInput {
	network: Network;
	payer: string;
	destination: string;
	amount: IssuedCurrencyAmount;
	credentialIds: readonly string[];
	sourceTag?: number;
	destinationTag?: number;
	sequence: number;
	feeDrops: string;
	lastLedgerSequence: number;
	validatedLedgerIndex: number;
	maxSlippageBps: number;
	/** Fully validated `ripple_path_find` result, without an outer RPC envelope. */
	pathFindResponse: unknown;
}

export interface Ap4mCrossCurrencyQuote {
	ledgerIndex: number;
	ledgerHash: string;
	sourceAmountDrops: string;
	sendMaxDrops: string;
}

export interface BuiltAp4mCrossCurrencyPayment {
	payment: Payment;
	quote: Ap4mCrossCurrencyQuote;
}

export interface SelectAp4mCrossCurrencySubmissionRouteInput {
	facilitatorStatus: 'accepted' | 'unsupported' | 'unknown';
	merchantDirectEnabled: boolean;
}

export type Ap4mCrossCurrencySubmissionRoute = 'facilitator' | 'merchant-direct';

type DecimalParts = { coefficient: bigint; scale: number };

function record(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paymentContextError(message: string): never {
	throw new Ap4mCrossCurrencyError(message, 'INVALID_PAYMENT_CONTEXT');
}

function quoteError(message: string): never {
	throw new Ap4mCrossCurrencyError(message, 'INVALID_PATH_QUOTE');
}

function safePositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function uint32(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}

function decimalParts(value: string, code: 'context' | 'delivery'): DecimalParts {
	if (value.length === 0 || value.length > MAX_ISSUED_VALUE_LENGTH) {
		if (code === 'context') paymentContextError('The issued amount is invalid');
		throw new Ap4mCrossCurrencyError('Delivered amount is invalid', 'INVALID_DELIVERY_EVIDENCE');
	}
	const match = DECIMAL.exec(value);
	if (!match) {
		if (code === 'context') paymentContextError('The issued amount is invalid');
		throw new Ap4mCrossCurrencyError('Delivered amount is invalid', 'INVALID_DELIVERY_EVIDENCE');
	}
	const [mantissa = '', exponentText] = value.toLowerCase().split('e');
	const [integer = '', fraction = ''] = mantissa.split('.');
	const exponent = Number(exponentText ?? 0);
	const digits = `${integer}${fraction}`;
	const firstNonzero = digits.search(/[1-9]/);
	const lastNonzero = Math.max(...[...digits].map((digit, index) => digit === '0' ? -1 : index));
	const significantDigits = firstNonzero < 0 ? 0 : lastNonzero - firstNonzero + 1;
	const normalizedExponent = integer.length - firstNonzero - 1 + exponent;
	// XRPL issued amounts permit at most 16 significant decimal digits with a
	// normalized exponent from -96 through +80. Validate before BigInt so
	// merchant-controlled delivery evidence cannot trigger unbounded parsing.
	if (
		!Number.isSafeInteger(exponent) ||
		firstNonzero < 0 ||
		significantDigits > MAX_ISSUED_SIGNIFICANT_DIGITS ||
		normalizedExponent < MIN_ISSUED_EXPONENT ||
		normalizedExponent > MAX_ISSUED_EXPONENT
	) {
		if (code === 'context') paymentContextError('The issued amount is invalid');
		throw new Ap4mCrossCurrencyError('Delivered amount is invalid', 'INVALID_DELIVERY_EVIDENCE');
	}
	const coefficient = BigInt(`${integer}${fraction}`);
	if (coefficient <= 0n) {
		if (code === 'context') paymentContextError('The issued amount is invalid');
		throw new Ap4mCrossCurrencyError('Delivered amount is invalid', 'INVALID_DELIVERY_EVIDENCE');
	}
	return { coefficient, scale: fraction.length - exponent };
}

function equalDecimal(left: string, right: string, code: 'context' | 'delivery'): boolean {
	const a = decimalParts(left, code);
	const b = decimalParts(right, code);
	const scale = Math.max(a.scale, b.scale, 0);
	return (
		a.coefficient * 10n ** BigInt(scale - a.scale) ===
		b.coefficient * 10n ** BigInt(scale - b.scale)
	);
}

function issuedAmount(value: unknown, code: 'context' | 'delivery'): IssuedCurrencyAmount {
	const invalid = (): never => {
		if (code === 'context') paymentContextError('The issued amount is invalid');
		throw new Ap4mCrossCurrencyError('Delivered amount is invalid', 'INVALID_DELIVERY_EVIDENCE');
	};
	const currency = record(value) && typeof value.currency === 'string' ? value.currency : undefined;
	if (
		!record(value) ||
		Object.keys(value).some((key) => !['currency', 'issuer', 'value'].includes(key)) ||
		currency === undefined ||
		currency === 'XRP' ||
		currency === ZERO_HEX_CURRENCY ||
		currency === XRP_HEX_CURRENCY ||
		!(/^[A-Z0-9]{3}$/.test(currency) || /^[A-F0-9]{40}$/.test(currency)) ||
		typeof value.issuer !== 'string' ||
		!isValidClassicAddress(value.issuer) ||
		typeof value.value !== 'string'
	) {
		return invalid();
	}
	decimalParts(value.value, code);
	return { currency, issuer: value.issuer, value: value.value };
}

function exactIssuedAmount(left: IssuedCurrencyAmount, right: IssuedCurrencyAmount, code: 'context' | 'delivery'): boolean {
	return (
		left.currency === right.currency &&
		left.issuer === right.issuer &&
		equalDecimal(left.value, right.value, code)
	);
}

function credentials(values: readonly string[]): string[] {
	if (
		values.length === 0 ||
		values.length > 8 ||
		values.some((value) => !HASH_256.test(value)) ||
		new Set(values).size !== values.length
	) {
		paymentContextError('CredentialIDs are invalid');
	}
	return [...values];
}

function drops(value: unknown): bigint {
	if (typeof value !== 'string' || !POSITIVE_DROPS.test(value)) {
		quoteError('Path quote source_amount must be positive XRP drops');
	}
	const parsed = BigInt(value);
	if (parsed > MAX_DROPS) quoteError('Path quote source_amount exceeds the XRP supply');
	return parsed;
}

function paths(value: unknown): Payment['Paths'] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 6) {
		quoteError('Path quote has no bounded computed path');
	}
	for (const path of value) {
		if (!Array.isArray(path) || path.length === 0 || path.length > 8) {
			quoteError('Path quote contains an invalid computed path');
		}
		for (const step of path) {
			if (!record(step) || Object.keys(step).length === 0) {
				quoteError('Path quote contains an invalid path step');
			}
			const allowed = new Set(['account', 'currency', 'issuer', 'type', 'type_hex']);
			if (Object.keys(step).some((key) => !allowed.has(key))) {
				quoteError('Path quote contains an unknown path step field');
			}
			if (
				('account' in step && (typeof step.account !== 'string' || !isValidClassicAddress(step.account))) ||
				('issuer' in step && (typeof step.issuer !== 'string' || !isValidClassicAddress(step.issuer))) ||
				('currency' in step && (typeof step.currency !== 'string' ||
					!(/^[A-Z0-9]{3}$/.test(step.currency) || /^[A-F0-9]{40}$/.test(step.currency)))) ||
				('type' in step && !Number.isSafeInteger(step.type)) ||
				('type_hex' in step && (typeof step.type_hex !== 'string' || !/^[A-F0-9]{16}$/.test(step.type_hex)))
			) {
				quoteError('Path quote contains an invalid path step');
			}
		}
	}
	return value as Payment['Paths'];
}

/**
 * Build a cross-currency Payment from one fully validated `ripple_path_find`
 * response. Field semantics:
 * https://xrpl.org/docs/references/protocol/transactions/types/payment
 * Path response semantics:
 * https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/ripple_path_find
 */
export function buildAp4mCrossCurrencyPayment(
	input: BuildAp4mCrossCurrencyPaymentInput,
): BuiltAp4mCrossCurrencyPayment {
	if (
		!(['testnet', 'devnet', 'lending-devnet'] as const).includes(
			input.network as 'testnet' | 'devnet' | 'lending-devnet',
		) ||
		!isValidClassicAddress(input.payer) ||
		!isValidClassicAddress(input.destination) ||
		input.payer === input.destination ||
		!safePositiveInteger(input.sequence) ||
		input.sequence > 0xffff_ffff ||
		!POSITIVE_DROPS.test(input.feeDrops) ||
		BigInt(input.feeDrops) > MAX_DROPS ||
		!safePositiveInteger(input.lastLedgerSequence) ||
		input.lastLedgerSequence > 0xffff_ffff ||
		!safePositiveInteger(input.validatedLedgerIndex) ||
		input.validatedLedgerIndex > 0xffff_ffff ||
		input.lastLedgerSequence <= input.validatedLedgerIndex ||
		!Number.isInteger(input.maxSlippageBps) ||
		input.maxSlippageBps < 0 ||
		input.maxSlippageBps > 10_000 ||
		(input.sourceTag !== undefined && !uint32(input.sourceTag)) ||
		(input.destinationTag !== undefined && !uint32(input.destinationTag))
	) {
		paymentContextError('The AP4M cross-currency payment context is invalid');
	}
	const amount = issuedAmount(input.amount, 'context');
	const credentialIds = credentials(input.credentialIds);
	const quote = input.pathFindResponse;
	if (
		!record(quote) ||
		quote.validated !== true ||
		quote.full_reply !== true ||
		!safePositiveInteger(quote.ledger_index) ||
		typeof quote.ledger_hash !== 'string' ||
		!HASH_256.test(quote.ledger_hash) ||
		quote.source_account !== input.payer ||
		quote.destination_account !== input.destination
	) {
		quoteError('Path quote is not fully validated and bound to the requested accounts');
	}
	const quoteLedgerIndex = quote.ledger_index;
	if (
		quoteLedgerIndex > input.validatedLedgerIndex ||
		input.validatedLedgerIndex - quoteLedgerIndex > MAX_LEDGER_DISTANCE
	) {
		throw new Ap4mCrossCurrencyError('Path quote is stale', 'PATH_QUOTE_STALE');
	}
	let echoedAmount: IssuedCurrencyAmount;
	try {
		echoedAmount = issuedAmount(quote.destination_amount, 'context');
	} catch {
		quoteError('Path quote destination_amount is invalid');
	}
	if (!exactIssuedAmount(echoedAmount, amount, 'context')) {
		quoteError('Path quote does not echo the requested destination amount');
	}
	if (!Array.isArray(quote.alternatives) || quote.alternatives.length === 0 || quote.alternatives.length > 16) {
		quoteError('Path quote has no bounded alternatives');
	}
	const candidates = quote.alternatives.map((alternative) => {
		if (!record(alternative)) quoteError('Path quote alternative is invalid');
		return {
			sourceAmount: drops(alternative.source_amount),
			paths: paths(alternative.paths_computed),
		};
	});
	let selected = candidates[0]!;
	let minimumCount = 1;
	for (const candidate of candidates.slice(1)) {
		if (candidate.sourceAmount < selected.sourceAmount) {
			selected = candidate;
			minimumCount = 1;
		} else if (candidate.sourceAmount === selected.sourceAmount) {
			minimumCount += 1;
		}
	}
	if (minimumCount !== 1) quoteError('Path quote has an ambiguous minimum XRP alternative');
	const sendMax = (
		selected.sourceAmount * BigInt(10_000 + input.maxSlippageBps) + 9_999n
	) / 10_000n;
	if (sendMax <= 0n || sendMax > MAX_DROPS) quoteError('Slippage-adjusted SendMax is invalid');

	const payment: Payment = {
		TransactionType: 'Payment',
		Account: input.payer,
		Destination: input.destination,
		Amount: amount,
		SendMax: sendMax.toString(),
		Paths: selected.paths,
		CredentialIDs: credentialIds,
		...(input.sourceTag === undefined ? {} : { SourceTag: input.sourceTag }),
		...(input.destinationTag === undefined ? {} : { DestinationTag: input.destinationTag }),
		Sequence: input.sequence,
		Fee: input.feeDrops,
		LastLedgerSequence: input.lastLedgerSequence,
	};
	return {
		payment,
		quote: {
			ledgerIndex: quoteLedgerIndex,
			ledgerHash: quote.ledger_hash,
			sourceAmountDrops: selected.sourceAmount.toString(),
			sendMaxDrops: sendMax.toString(),
		},
	};
}

/** Validate the merchant's delivered_amount as the exact signed IOU amount. */
export function validateAp4mCrossCurrencyDeliveredAmount(
	delivered: unknown,
	required: IssuedCurrencyAmount,
): IssuedCurrencyAmount {
	const expected = issuedAmount(required, 'context');
	const actual = issuedAmount(delivered, 'delivery');
	if (!exactIssuedAmount(actual, expected, 'delivery')) {
		throw new Ap4mCrossCurrencyError(
			'Merchant delivered_amount does not exactly match the requested amount',
			'DELIVERY_MISMATCH',
		);
	}
	return actual;
}

/**
 * The direct merchant route is enabled only after t54 explicitly reports that
 * it cannot accept this cross-currency Payment. Unknown results fail closed.
 */
export function selectAp4mCrossCurrencySubmissionRoute(
	input: SelectAp4mCrossCurrencySubmissionRouteInput,
): Ap4mCrossCurrencySubmissionRoute {
	if (input.facilitatorStatus === 'accepted') return 'facilitator';
	if (input.facilitatorStatus === 'unsupported' && input.merchantDirectEnabled === true) {
		return 'merchant-direct';
	}
	throw new Ap4mCrossCurrencyError(
		'No explicitly verified cross-currency submission route is available',
		'SUBMISSION_ROUTE_UNAVAILABLE',
	);
}
