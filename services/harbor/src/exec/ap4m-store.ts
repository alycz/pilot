import {
	Ap4mReceiptSchema,
	McIntentSchema,
	MerchantSchema,
	type Ap4mReceipt,
	type McIntent,
	type Merchant,
} from '../contracts';
import { Ap4mMerchantSuccessSchema } from './ap4m-response';
import { xrplCurrencyCodeForAp4m } from './ap4m-x402';

export type Ap4mPurchaseStatus =
	| 'claimed'
	| 'prepared'
	| 'signed'
	| 'settlement_unknown'
	| 'settled'
	| 'delivered'
	| 'failed';

export type JsonObject = Record<string, unknown>;

export interface Ap4mStoredResult {
	receipt: Ap4mReceipt;
	data: JsonObject;
}

export interface Ap4mPreparedExecutionContext {
	intent: McIntent;
	vi: {
		l1: string;
		l2: string;
		l3a: string;
		l3b: string;
		l3aDigest: string;
		l3bDigest: string;
	};
	challenge: JsonObject;
	challengeState: string;
	payer: string;
	merchantSnapshot: Merchant;
	receiptAmount: {
		asset: { kind: 'iou'; currency: string; issuer: string };
		value: string;
	};
	acceptedRequirement: JsonObject;
	resourceUrl: string;
	receiptId: string;
	retryHeaders: {
		'x-mastercard-intent': string;
		'x-vi-l1': string;
		'x-vi-l2': string;
		'x-vi-l3b': string;
	};
}

export interface Ap4mRecoveryIdentity {
	principal: string;
	mandateId: string;
	idempotencyKey: string;
}

export interface WrappedAp4mPreparedContext {
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
	digest: string;
}

export interface Ap4mPreparedContextBinding {
	version: 'ap4m-recovery-v1';
	intentId: string;
	l3aDigest: string;
	l3bDigest: string;
	receiptId: string;
	challenge: {
		scheme: 'exact';
		network: 'xrpl:1';
		asset: { currency: string; issuer: string };
		amount: string;
		payTo: string;
		resourceUrl: string;
	};
	receiptAmount: {
		asset: { kind: 'iou'; currency: string; issuer: string };
		value: string;
	};
	ciphertextDigest: string;
}

export type Ap4mValidatedMerchantResponse = {
	data: JsonObject;
	intent_validation: JsonObject;
};

export interface Ap4mPurchaseAttempt {
	id: string;
	principal: string;
	mandateId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	merchantId: string;
	sku: string;
	status: Ap4mPurchaseStatus;
	spendId: string | null;
	spendDay: string | null;
	amountUsd: string | null;
	preparedContextWrapped: WrappedAp4mPreparedContext | null;
	preparedContextBinding: Ap4mPreparedContextBinding | null;
	leaseAcquiredAt: string;
	signingStartedAt: string | null;
	firstEligibleLedgerIndex: number | null;
	signedBlob: string | null;
	txHash: string | null;
	lastLedgerSequence: number | null;
	settlementUnknownAt: string | null;
	settledAt: string | null;
	deliveredAt: string | null;
	failedAt: string | null;
	ledgerIndex: number | null;
	deliveredAmount: string | null;
	receiptId: string | null;
	merchantResponse: Ap4mValidatedMerchantResponse | null;
	merchantResponseAt: string | null;
	result: Ap4mStoredResult | null;
	failure: JsonObject | null;
	createdAt: string;
	updatedAt: string;
}

export interface ClaimAp4mPurchaseInput {
	id: string;
	mandateId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	merchantId: string;
	sku: string;
	createdAt: string;
}

export interface ReserveAp4mPurchaseInput {
	mandateId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	leaseAcquiredAt: string;
	spendId: string;
	spendDay: string;
	amountUsd: string;
	preparedContext: Ap4mPreparedExecutionContext;
	preparedAt: string;
}

export type ClaimAp4mPurchaseResult = {
	outcome: 'claimed' | 'replay' | 'mismatch';
	row: Ap4mPurchaseAttempt;
};

export type ReserveAp4mPurchaseResult = {
	outcome: 'reserved' | 'replay' | 'mismatch' | 'spend-limit' | 'invalid-state';
	row: Ap4mPurchaseAttempt;
};

export type Ap4mTransitionResult = {
	outcome: 'transitioned' | 'replay' | 'mismatch' | 'invalid-state' | 'invalid-evidence' | 'not-owner';
	row: Ap4mPurchaseAttempt;
};

export type AcquireAp4mSigningLeaseResult = {
	outcome: 'acquired' | 'owner' | 'busy' | 'stale' | 'invalid-state';
	row: Ap4mPurchaseAttempt;
};

interface RawAttempt {
	id: unknown;
	principal: unknown;
	mandate_id: unknown;
	idempotency_key: unknown;
	request_fingerprint: unknown;
	merchant_id: unknown;
	sku: unknown;
	status: unknown;
	spend_id: unknown;
	spend_day: unknown;
	amount_usd: unknown;
	prepared_context_enc: unknown;
	prepared_context_iv: unknown;
	prepared_context_public_json: unknown;
	prepared_context_digest: unknown;
	lease_acquired_at: unknown;
	signing_started_at: unknown;
	first_eligible_ledger_index: unknown;
	signed_blob: unknown;
	tx_hash: unknown;
	last_ledger_sequence: unknown;
	settlement_unknown_at: unknown;
	settled_at: unknown;
	delivered_at: unknown;
	failed_at: unknown;
	ledger_index: unknown;
	delivered_amount: unknown;
	receipt_id: unknown;
	merchant_response_json: unknown;
	merchant_response_at: unknown;
	result_json: unknown;
	failure_json: unknown;
	created_at: unknown;
	updated_at: unknown;
}

const STATUSES = new Set<Ap4mPurchaseStatus>([
	'claimed',
	'prepared',
	'signed',
	'settlement_unknown',
	'settled',
	'delivered',
	'failed',
]);
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_KEY = /seed|secret|private|mnemonic/i;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PREPARED_CONTEXT_BYTES = 192 * 1024;
const PRESENTATION_MAX_BYTES = 32 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const IV_BYTES = 12;
const KEK_BYTES = 32;
const RECOVERY_VERSION = 'ap4m-recovery-v1' as const;
const RESERVATION_FRESHNESS_MS = 5_000;
const SIGNING_TOKEN = /^(?:[A-Fa-f0-9]{64}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-4[A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12})$/;
const VALIDATED_TERMINAL_RESULT = /^tec[A-Z0-9_]{1,64}$/;

export class Ap4mPurchaseStoreError extends Error {
	constructor(
		message: string,
		readonly code: 'INVALID_DATA' | 'NOT_FOUND' | 'STORE_CONFLICT',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'Ap4mPurchaseStoreError';
	}
}

function changed(result: D1Result): number {
	return Number(result.meta?.changes ?? 0);
}

function text(value: unknown, field: string, max = 512): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	return value;
}

function nullableText(value: unknown, field: string, max = 512): string | null {
	return value === null ? null : text(value, field, max);
}

function bytes(value: unknown, field: string, exactLength?: number): ArrayBuffer {
	let result: ArrayBuffer;
	if (value instanceof ArrayBuffer) {
		result = value.slice(0);
	} else if (ArrayBuffer.isView(value)) {
		const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		result = Uint8Array.from(view).buffer;
	} else {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	if (exactLength !== undefined && result.byteLength !== exactLength) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	return result;
}

function timestamp(value: unknown, field: string): string {
	const parsed = text(value, field, 40);
	if (new Date(parsed).toISOString() !== parsed) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	return parsed;
}

function nullableTimestamp(value: unknown, field: string): string | null {
	return value === null ? null : timestamp(value, field);
}

function positiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	return Number(value);
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
	return value === null ? null : positiveInteger(value, field);
}

function fingerprint(value: unknown): string {
	const normalized = text(value, 'request fingerprint', 64).toUpperCase();
	if (!HASH.test(normalized)) {
		throw new Ap4mPurchaseStoreError('Invalid request fingerprint', 'INVALID_DATA');
	}
	return normalized;
}

function hash(value: unknown): string {
	const normalized = text(value, 'transaction hash', 64).toUpperCase();
	if (!HASH.test(normalized)) throw new Ap4mPurchaseStoreError('Invalid transaction hash', 'INVALID_DATA');
	return normalized;
}

function signingToken(value: unknown): string {
	const parsed = text(value, 'signing lease token', 64);
	if (!SIGNING_TOKEN.test(parsed)) {
		throw new Ap4mPurchaseStoreError('Invalid signing lease token', 'INVALID_DATA');
	}
	return parsed;
}

function expiredAbsentRange(input: {
	lookupCode: string;
	validatedLedgerIndex: number;
	inclusionLedgersChecked: readonly number[];
}, firstEligibleLedgerIndex: number, lastLedgerSequence: number): { checkedFrom: number; checkedThrough: number } | null {
	if (
		input.lookupCode !== 'txnNotFound' ||
		!Number.isSafeInteger(input.validatedLedgerIndex) || input.validatedLedgerIndex <= lastLedgerSequence ||
		firstEligibleLedgerIndex > lastLedgerSequence ||
		!Array.isArray(input.inclusionLedgersChecked) || input.inclusionLedgersChecked.length > 64 ||
		input.inclusionLedgersChecked.some((ledger) => !Number.isSafeInteger(ledger) || ledger < 1)
	) {
		return null;
	}
	const checked = [...new Set(input.inclusionLedgersChecked)].sort((left, right) => left - right);
	if (
		checked.length !== lastLedgerSequence - firstEligibleLedgerIndex + 1 ||
		checked.some((ledger, index) => ledger !== firstEligibleLedgerIndex + index)
	) {
		return null;
	}
	return { checkedFrom: firstEligibleLedgerIndex, checkedThrough: lastLedgerSequence };
}

function microusd(value: unknown, field: string, allowZero = false): number {
	const parsed = text(value, field, 40);
	if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(parsed)) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	const [whole, fraction = ''] = parsed.split('.');
	if (fraction.length > 6) throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
	if ((!allowZero && result < 1n) || result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	return Number(result);
}

function assertJson(value: unknown, depth = 0): void {
	if (depth > 8) throw new Ap4mPurchaseStoreError('Stored result is too deeply nested', 'INVALID_DATA');
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Ap4mPurchaseStoreError('Stored result contains a non-finite number', 'INVALID_DATA');
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 256) throw new Ap4mPurchaseStoreError('Stored result array is too large', 'INVALID_DATA');
		for (const item of value) assertJson(item, depth + 1);
		return;
	}
	if (typeof value !== 'object') throw new Ap4mPurchaseStoreError('Stored result is not JSON', 'INVALID_DATA');
	const entries = Object.entries(value as JsonObject);
	if (entries.length > 64) throw new Ap4mPurchaseStoreError('Stored result object is too large', 'INVALID_DATA');
	for (const [key, item] of entries) {
		if (key.length === 0 || key.length > 128 || SENSITIVE_KEY.test(key)) {
			throw new Ap4mPurchaseStoreError('Stored result contains a forbidden key', 'INVALID_DATA');
		}
		assertJson(item, depth + 1);
	}
}

function serializeObject(value: unknown, field: string, maxBytes = MAX_RESULT_BYTES): string {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	assertJson(value);
	const encoded = JSON.stringify(value);
	if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
		throw new Ap4mPurchaseStoreError(`${field} is too large`, 'INVALID_DATA');
	}
	return encoded;
}

function exactKeys(value: JsonObject, expected: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value as JsonObject).sort().map((key) =>
			`${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function boundedBytes(value: unknown, field: string, max: number): string {
	const parsed = text(value, field, max);
	if (new TextEncoder().encode(parsed).byteLength > max || /[\r\n\0]/.test(parsed)) {
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA');
	}
	return parsed;
}

function base64urlUtf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 4_096) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 4_096));
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function parseMerchantSnapshot(value: unknown): Merchant {
	let parsed: Merchant;
	try {
		parsed = MerchantSchema.parse(value);
	} catch (cause) {
		throw new Ap4mPurchaseStoreError('Invalid prepared merchant snapshot', 'INVALID_DATA', cause);
	}
	if (parsed.network !== 'testnet' || parsed.products.length !== 1 || !parsed.schemes.includes('exact') ||
		parsed.schemes.length > 2 || new Set(parsed.schemes).size !== parsed.schemes.length ||
		parsed.settle_asset.kind !== 'iou') {
		throw new Ap4mPurchaseStoreError('Invalid prepared merchant snapshot', 'INVALID_DATA');
	}
	const product = parsed.products[0]!;
	if (product.price.asset.kind !== 'iou') {
		throw new Ap4mPurchaseStoreError('Invalid prepared merchant product', 'INVALID_DATA');
	}
	return {
		id: boundedBytes(parsed.id, 'merchant id', 200),
		name: boundedBytes(parsed.name, 'merchant name', 500),
		network: 'testnet',
		base_url: boundedBytes(parsed.base_url, 'merchant base URL', 2_048),
		xrpl_address: boundedBytes(parsed.xrpl_address, 'merchant XRPL address', 200),
		src_dpa_id: boundedBytes(parsed.src_dpa_id, 'merchant srcDpaId', 500),
		schemes: [...parsed.schemes],
		settle_asset: {
			kind: 'iou',
			currency: boundedBytes(parsed.settle_asset.currency, 'merchant settlement currency', 80),
			issuer: boundedBytes(parsed.settle_asset.issuer, 'merchant settlement issuer', 200),
		},
		required_credential: {
			issuer: boundedBytes(parsed.required_credential.issuer, 'merchant credential issuer', 500),
			credential_type_hex: boundedBytes(
				parsed.required_credential.credential_type_hex, 'merchant credential type', 500,
			),
		},
		products: [{
			sku: boundedBytes(product.sku, 'merchant product SKU', 200),
			name: boundedBytes(product.name, 'merchant product name', 500),
			description: boundedBytes(product.description, 'merchant product description', 4_096),
			price: {
				asset: {
					kind: 'iou',
					currency: boundedBytes(product.price.asset.currency, 'merchant product currency', 80),
					issuer: boundedBytes(product.price.asset.issuer, 'merchant product issuer', 200),
				},
				value: boundedBytes(product.price.value, 'merchant product price', 80),
			},
			response_schema_id: boundedBytes(product.response_schema_id, 'merchant response schema', 200),
		}],
		wba_required: parsed.wba_required,
	};
}

function parsePreparedContext(value: unknown): Ap4mPreparedExecutionContext | null {
	if (value === null) return null;
	const parsed = parseObject(value, 'prepared recovery context', MAX_PREPARED_CONTEXT_BYTES);
	if (parsed === null) return null;
	exactKeys(parsed, [
		'intent', 'vi', 'challenge', 'challengeState', 'receiptAmount', 'acceptedRequirement',
		'resourceUrl', 'receiptId', 'payer', 'merchantSnapshot', 'retryHeaders',
	], 'prepared context');
	let intent: McIntent;
	try {
		intent = McIntentSchema.parse(parsed.intent);
	} catch (cause) {
		throw new Ap4mPurchaseStoreError('Invalid prepared intent', 'INVALID_DATA', cause);
	}
	if (parsed.vi === null || typeof parsed.vi !== 'object' || Array.isArray(parsed.vi)) {
		throw new Ap4mPurchaseStoreError('Invalid prepared VI', 'INVALID_DATA');
	}
	const vi = parsed.vi as JsonObject;
	exactKeys(vi, ['l1', 'l2', 'l3a', 'l3b', 'l3aDigest', 'l3bDigest'], 'prepared VI');
	const l1 = boundedBytes(vi.l1, 'L1 presentation', PRESENTATION_MAX_BYTES);
	const l2 = boundedBytes(vi.l2, 'L2 presentation', PRESENTATION_MAX_BYTES);
	const l3a = boundedBytes(vi.l3a, 'L3a presentation', PRESENTATION_MAX_BYTES);
	const l3b = boundedBytes(vi.l3b, 'L3b presentation', PRESENTATION_MAX_BYTES);
	const l3aDigest = text(vi.l3aDigest, 'L3a digest', 64);
	const l3bDigest = text(vi.l3bDigest, 'L3b digest', 64);
	if (!DIGEST.test(l3aDigest) || !DIGEST.test(l3bDigest)) {
		throw new Ap4mPurchaseStoreError('Invalid prepared VI digest', 'INVALID_DATA');
	}
	if (parsed.challenge === null || typeof parsed.challenge !== 'object' || Array.isArray(parsed.challenge) ||
		parsed.acceptedRequirement === null || typeof parsed.acceptedRequirement !== 'object' ||
		Array.isArray(parsed.acceptedRequirement)) {
		throw new Ap4mPurchaseStoreError('Invalid prepared challenge', 'INVALID_DATA');
	}
	const challenge = parsed.challenge as JsonObject;
	const challengeState = boundedBytes(parsed.challengeState, 'AP4M challenge state', 16 * 1_024);
	const payer = boundedBytes(parsed.payer, 'prepared payer', 200);
	const merchantSnapshot = parseMerchantSnapshot(parsed.merchantSnapshot);
	if (parsed.receiptAmount === null || typeof parsed.receiptAmount !== 'object' ||
		Array.isArray(parsed.receiptAmount)) {
		throw new Ap4mPurchaseStoreError('Invalid prepared receipt amount', 'INVALID_DATA');
	}
	const receiptAmountValue = parsed.receiptAmount as JsonObject;
	exactKeys(receiptAmountValue, ['asset', 'value'], 'prepared receipt amount');
	if (receiptAmountValue.asset === null || typeof receiptAmountValue.asset !== 'object' ||
		Array.isArray(receiptAmountValue.asset)) {
		throw new Ap4mPurchaseStoreError('Invalid prepared receipt asset', 'INVALID_DATA');
	}
	const receiptAssetValue = receiptAmountValue.asset as JsonObject;
	exactKeys(receiptAssetValue, ['kind', 'currency', 'issuer'], 'prepared receipt asset');
	if (receiptAssetValue.kind !== 'iou') {
		throw new Ap4mPurchaseStoreError('Invalid prepared receipt asset', 'INVALID_DATA');
	}
	const receiptAmount = {
		asset: {
			kind: 'iou' as const,
			currency: text(receiptAssetValue.currency, 'receipt currency', 80),
			issuer: text(receiptAssetValue.issuer, 'receipt issuer', 200),
		},
		value: text(receiptAmountValue.value, 'receipt amount', 80),
	};
	if (typeof challenge.amount !== 'string' || typeof challenge.currency !== 'string' ||
		typeof challenge.issuer !== 'string' || receiptAmount.value !== challenge.amount ||
		receiptAmount.asset.issuer !== challenge.issuer ||
		xrplCurrencyCodeForAp4m(receiptAmount.asset.currency) !== challenge.currency) {
		throw new Ap4mPurchaseStoreError('Prepared receipt amount does not match challenge', 'INVALID_DATA');
	}
	const merchantProduct = merchantSnapshot.products[0]!;
	const intentOrder = intent.orders[0];
	const intentMerchant = intentOrder?.merchants[0];
	const intentItem = intentOrder?.items[0];
	if (merchantSnapshot.xrpl_address !== challenge.payTo ||
		canonicalJson(merchantSnapshot.settle_asset) !== canonicalJson(receiptAmount.asset) ||
		canonicalJson(merchantProduct.price.asset) !== canonicalJson(receiptAmount.asset) ||
		intent.orders.length !== 1 || intentOrder?.merchants.length !== 1 || intentOrder.items.length !== 1 ||
		intentMerchant?.merchantName !== merchantSnapshot.name ||
		intentMerchant.srcDpaId !== merchantSnapshot.src_dpa_id ||
		intentItem?.itemId !== merchantProduct.sku || intentItem.itemName !== merchantProduct.name ||
		intentItem.itemUnitPrice.amount !== merchantProduct.price.value ||
		microusd(merchantProduct.price.value, 'merchant product price') <
			microusd(receiptAmount.value, 'prepared receipt amount')) {
		throw new Ap4mPurchaseStoreError('Prepared merchant snapshot does not match challenge', 'INVALID_DATA');
	}
	const acceptedRequirement = parsed.acceptedRequirement as JsonObject;
	if (canonicalJson(challenge.accepted) !== canonicalJson(acceptedRequirement)) {
		throw new Ap4mPurchaseStoreError('Prepared accepted requirement does not match challenge', 'INVALID_DATA');
	}
	const resourceUrl = boundedBytes(parsed.resourceUrl, 'resource URL', 2_048);
	let url: URL;
	try {
		url = new URL(resourceUrl);
	} catch (cause) {
		throw new Ap4mPurchaseStoreError('Invalid resource URL', 'INVALID_DATA', cause);
	}
	const loopbackHttp = url.protocol === 'http:' &&
		(url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost');
	if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.hash) {
		throw new Ap4mPurchaseStoreError('Invalid resource URL', 'INVALID_DATA');
	}
	if (new URL(merchantSnapshot.base_url).origin !== url.origin) {
		throw new Ap4mPurchaseStoreError('Prepared merchant base URL does not match resource', 'INVALID_DATA');
	}
	const challengeResource = challenge.resource;
	if (challengeResource === null || typeof challengeResource !== 'object' || Array.isArray(challengeResource) ||
		(challengeResource as JsonObject).url !== resourceUrl) {
		throw new Ap4mPurchaseStoreError('Prepared resource URL does not match challenge', 'INVALID_DATA');
	}
	const receiptId = boundedBytes(parsed.receiptId, 'receipt ID', 200);
	if (parsed.retryHeaders === null || typeof parsed.retryHeaders !== 'object' || Array.isArray(parsed.retryHeaders)) {
		throw new Ap4mPurchaseStoreError('Invalid prepared retry headers', 'INVALID_DATA');
	}
	const retryHeaders = parsed.retryHeaders as JsonObject;
	exactKeys(retryHeaders, ['x-mastercard-intent', 'x-vi-l1', 'x-vi-l2', 'x-vi-l3b'], 'prepared retry headers');
	const mastercardIntent = boundedBytes(retryHeaders['x-mastercard-intent'], 'Mastercard intent header', 24 * 1_024);
	const viL1 = boundedBytes(retryHeaders['x-vi-l1'], 'VI L1 header', PRESENTATION_MAX_BYTES);
	const viL2 = boundedBytes(retryHeaders['x-vi-l2'], 'VI L2 header', PRESENTATION_MAX_BYTES);
	const viL3b = boundedBytes(retryHeaders['x-vi-l3b'], 'VI L3b header', PRESENTATION_MAX_BYTES);
	if (mastercardIntent !== base64urlUtf8(JSON.stringify(intent)) || viL1 !== l1 || viL2 !== l2 || viL3b !== l3b) {
		throw new Ap4mPurchaseStoreError('Prepared retry headers do not match their public artifacts', 'INVALID_DATA');
	}
	return {
		intent,
		vi: { l1, l2, l3a, l3b, l3aDigest, l3bDigest },
		challenge,
		challengeState,
		payer,
		merchantSnapshot,
		receiptAmount,
		acceptedRequirement,
		resourceUrl,
		receiptId,
		retryHeaders: {
			'x-mastercard-intent': mastercardIntent,
			'x-vi-l1': viL1,
			'x-vi-l2': viL2,
			'x-vi-l3b': viL3b,
		},
	};
}

function serializePreparedContext(value: Ap4mPreparedExecutionContext): string {
	const parsed = parsePreparedContext(serializeObject(value, 'prepared context', MAX_PREPARED_CONTEXT_BYTES));
	if (parsed === null) throw new Ap4mPurchaseStoreError('Invalid prepared context', 'INVALID_DATA');
	const encoded = canonicalJson(parsed);
	if (new TextEncoder().encode(encoded).byteLength > MAX_PREPARED_CONTEXT_BYTES) {
		throw new Ap4mPurchaseStoreError('Prepared context is too large', 'INVALID_DATA');
	}
	return encoded;
}

function recoveryAad(identity: Ap4mRecoveryIdentity): Uint8Array {
	text(identity.principal, 'recovery principal', 256);
	text(identity.mandateId, 'recovery mandate id', 200);
	text(identity.idempotencyKey, 'recovery idempotency key', 200);
	return new TextEncoder().encode(JSON.stringify([
		identity.principal,
		identity.mandateId,
		identity.idempotencyKey,
		RECOVERY_VERSION,
	]));
}

function validateRecoveryKey(key: CryptoKey, usage: 'encrypt' | 'decrypt'): void {
	const algorithm = key?.algorithm as { name?: unknown; length?: unknown } | undefined;
	if (key?.type !== 'secret' || key.extractable || algorithm?.name !== 'AES-GCM' ||
		algorithm.length !== KEK_BYTES * 8 || !key.usages.includes(usage)) {
		throw new Ap4mPurchaseStoreError(`Invalid recovery ${usage} key`, 'INVALID_DATA');
	}
}

function decodeLegacyKek(value: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
		throw new Ap4mPurchaseStoreError('Invalid legacy recovery KEK', 'INVALID_DATA');
	}
	try {
		const raw = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
		if (raw.byteLength !== KEK_BYTES) throw new TypeError('invalid length');
		return raw;
	} catch (cause) {
		throw new Ap4mPurchaseStoreError('Invalid legacy recovery KEK', 'INVALID_DATA', cause);
	}
}

async function recoveryKey(
	kek: CryptoKey | string,
	usage: 'encrypt' | 'decrypt',
	cryptoImpl: Crypto,
): Promise<CryptoKey> {
	if (typeof kek !== 'string') {
		validateRecoveryKey(kek, usage);
		return kek;
	}
	const raw = decodeLegacyKek(kek);
	try {
		return await cryptoImpl.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
	} finally {
		raw.fill(0);
	}
}

async function sha256Hex(value: ArrayBuffer, cryptoImpl: Crypto): Promise<string> {
	const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', value));
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function wrapAp4mPreparedContext(
	identity: Ap4mRecoveryIdentity,
	context: Ap4mPreparedExecutionContext,
	kek: CryptoKey | string,
	cryptoImpl: Crypto = crypto,
): Promise<WrappedAp4mPreparedContext> {
	const canonical = serializePreparedContext(context);
	const plaintext = new TextEncoder().encode(canonical);
	const iv = cryptoImpl.getRandomValues(new Uint8Array(IV_BYTES));
	try {
		const key = await recoveryKey(kek, 'encrypt', cryptoImpl);
		const ciphertext = await cryptoImpl.subtle.encrypt({
			name: 'AES-GCM',
			iv,
			additionalData: recoveryAad(identity),
		}, key, plaintext);
		return {
			ciphertext,
			iv: Uint8Array.from(iv).buffer,
			digest: await sha256Hex(ciphertext, cryptoImpl),
		};
	} catch (cause) {
		if (cause instanceof Ap4mPurchaseStoreError) throw cause;
		throw new Ap4mPurchaseStoreError('Could not wrap AP4M recovery context', 'INVALID_DATA', cause);
	} finally {
		plaintext.fill(0);
		iv.fill(0);
	}
}

export async function unwrapAp4mPreparedContext(
	identity: Ap4mRecoveryIdentity,
	wrapped: WrappedAp4mPreparedContext,
	kek: CryptoKey | string,
	cryptoImpl: Crypto = crypto,
): Promise<Ap4mPreparedExecutionContext> {
	const ciphertext = bytes(wrapped.ciphertext, 'recovery ciphertext');
	const iv = bytes(wrapped.iv, 'recovery IV', IV_BYTES);
	if (!DIGEST.test(wrapped.digest) || await sha256Hex(ciphertext, cryptoImpl) !== wrapped.digest) {
		throw new Ap4mPurchaseStoreError('Recovery ciphertext digest mismatch', 'INVALID_DATA');
	}
	let plaintext: ArrayBuffer;
	try {
		const key = await recoveryKey(kek, 'decrypt', cryptoImpl);
		plaintext = await cryptoImpl.subtle.decrypt({
			name: 'AES-GCM',
			iv: new Uint8Array(iv),
			additionalData: recoveryAad(identity),
		}, key, ciphertext);
	} catch (cause) {
		if (cause instanceof Ap4mPurchaseStoreError) throw cause;
		throw new Ap4mPurchaseStoreError('Could not unwrap AP4M recovery context', 'INVALID_DATA', cause);
	}
	const plaintextBytes = new Uint8Array(plaintext);
	try {
		const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintextBytes);
		const context = parsePreparedContext(decoded);
		if (context === null || serializePreparedContext(context) !== decoded) {
			throw new Ap4mPurchaseStoreError('Recovery context is not canonical', 'INVALID_DATA');
		}
		return context;
	} catch (cause) {
		if (cause instanceof Ap4mPurchaseStoreError) throw cause;
		throw new Ap4mPurchaseStoreError('Invalid wrapped AP4M recovery context', 'INVALID_DATA', cause);
	} finally {
		plaintextBytes.fill(0);
	}
}

function bindingFor(
	context: Ap4mPreparedExecutionContext,
	ciphertextDigest: string,
): Ap4mPreparedContextBinding {
	const challenge = context.challenge;
	const resource = challenge.resource;
	if (challenge.scheme !== 'exact' || challenge.network !== 'xrpl:1' ||
		typeof challenge.currency !== 'string' || typeof challenge.issuer !== 'string' ||
		typeof challenge.amount !== 'string' || typeof challenge.payTo !== 'string' ||
		resource === null || typeof resource !== 'object' || Array.isArray(resource) ||
		(resource as JsonObject).url !== context.resourceUrl || !DIGEST.test(ciphertextDigest)) {
		throw new Ap4mPurchaseStoreError('Invalid public recovery binding', 'INVALID_DATA');
	}
	return {
		version: RECOVERY_VERSION,
		intentId: context.intent.intentId,
		l3aDigest: context.vi.l3aDigest,
		l3bDigest: context.vi.l3bDigest,
		receiptId: context.receiptId,
		challenge: {
			scheme: 'exact',
			network: 'xrpl:1',
			asset: {
				currency: text(challenge.currency, 'challenge currency', 80),
				issuer: text(challenge.issuer, 'challenge issuer', 200),
			},
			amount: text(challenge.amount, 'challenge amount', 80),
			payTo: text(challenge.payTo, 'challenge payTo', 200),
			resourceUrl: context.resourceUrl,
		},
		receiptAmount: context.receiptAmount,
		ciphertextDigest,
	};
}

function parseBinding(value: unknown): Ap4mPreparedContextBinding | null {
	const parsed = parseObject(value, 'prepared_context_public_json', 16 * 1024);
	if (parsed === null) return null;
	exactKeys(parsed, [
		'version', 'intentId', 'l3aDigest', 'l3bDigest', 'receiptId', 'challenge', 'receiptAmount', 'ciphertextDigest',
	], 'public recovery binding');
	if (parsed.version !== RECOVERY_VERSION || parsed.challenge === null ||
		typeof parsed.challenge !== 'object' || Array.isArray(parsed.challenge)) {
		throw new Ap4mPurchaseStoreError('Invalid public recovery binding', 'INVALID_DATA');
	}
	const challenge = parsed.challenge as JsonObject;
	exactKeys(challenge, ['scheme', 'network', 'asset', 'amount', 'payTo', 'resourceUrl'], 'public challenge binding');
	if (challenge.scheme !== 'exact' || challenge.network !== 'xrpl:1' || challenge.asset === null ||
		typeof challenge.asset !== 'object' || Array.isArray(challenge.asset)) {
		throw new Ap4mPurchaseStoreError('Invalid public challenge binding', 'INVALID_DATA');
	}
	const asset = challenge.asset as JsonObject;
	exactKeys(asset, ['currency', 'issuer'], 'public challenge asset');
	if (parsed.receiptAmount === null || typeof parsed.receiptAmount !== 'object' ||
		Array.isArray(parsed.receiptAmount)) {
		throw new Ap4mPurchaseStoreError('Invalid public receipt amount binding', 'INVALID_DATA');
	}
	const receiptAmount = parsed.receiptAmount as JsonObject;
	exactKeys(receiptAmount, ['asset', 'value'], 'public receipt amount binding');
	if (receiptAmount.asset === null || typeof receiptAmount.asset !== 'object' || Array.isArray(receiptAmount.asset)) {
		throw new Ap4mPurchaseStoreError('Invalid public receipt asset binding', 'INVALID_DATA');
	}
	const receiptAsset = receiptAmount.asset as JsonObject;
	exactKeys(receiptAsset, ['kind', 'currency', 'issuer'], 'public receipt asset binding');
	if (receiptAsset.kind !== 'iou') {
		throw new Ap4mPurchaseStoreError('Invalid public receipt asset binding', 'INVALID_DATA');
	}
	const ciphertextDigest = text(parsed.ciphertextDigest, 'ciphertext digest', 64);
	const l3aDigest = text(parsed.l3aDigest, 'L3a digest', 64);
	const l3bDigest = text(parsed.l3bDigest, 'L3b digest', 64);
	const challengeCurrency = text(asset.currency, 'challenge currency', 80);
	const challengeIssuer = text(asset.issuer, 'challenge issuer', 200);
	const challengeAmount = text(challenge.amount, 'challenge amount', 80);
	const receiptCurrency = text(receiptAsset.currency, 'receipt currency', 80);
	const receiptIssuer = text(receiptAsset.issuer, 'receipt issuer', 200);
	const receiptValue = text(receiptAmount.value, 'receipt amount', 80);
	if (!DIGEST.test(ciphertextDigest) || !DIGEST.test(l3aDigest) || !DIGEST.test(l3bDigest)) {
		throw new Ap4mPurchaseStoreError('Invalid public recovery digest', 'INVALID_DATA');
	}
	if (receiptValue !== challengeAmount || receiptIssuer !== challengeIssuer ||
		xrplCurrencyCodeForAp4m(receiptCurrency) !== challengeCurrency) {
		throw new Ap4mPurchaseStoreError('Public receipt amount does not match challenge', 'INVALID_DATA');
	}
	return {
		version: RECOVERY_VERSION,
		intentId: text(parsed.intentId, 'intent id', 200),
		l3aDigest,
		l3bDigest,
		receiptId: text(parsed.receiptId, 'receipt id', 200),
		challenge: {
			scheme: 'exact',
			network: 'xrpl:1',
			asset: {
				currency: challengeCurrency,
				issuer: challengeIssuer,
			},
			amount: challengeAmount,
			payTo: text(challenge.payTo, 'challenge payTo', 200),
			resourceUrl: text(challenge.resourceUrl, 'challenge resource URL', 2_048),
		},
		receiptAmount: {
			asset: {
				kind: 'iou',
				currency: receiptCurrency,
				issuer: receiptIssuer,
			},
			value: receiptValue,
		},
		ciphertextDigest,
	};
}

function parseMerchantResponse(value: unknown): Ap4mValidatedMerchantResponse | null {
	const parsed = parseObject(value, 'merchant_response_json');
	if (parsed === null) return null;
	try {
		return Ap4mMerchantSuccessSchema.parse(parsed) as Ap4mValidatedMerchantResponse;
	} catch (cause) {
		throw new Ap4mPurchaseStoreError('Invalid cached merchant response', 'INVALID_DATA', cause);
	}
}

function serializeMerchantResponse(value: Ap4mValidatedMerchantResponse): string {
	let parsed: unknown;
	try {
		parsed = Ap4mMerchantSuccessSchema.parse(value);
	} catch (cause) {
		throw new Ap4mPurchaseStoreError('Invalid merchant response', 'INVALID_DATA', cause);
	}
	return serializeObject(parsed, 'merchant response');
}

function parseObject(value: unknown, field: string, maxBytes = MAX_RESULT_BYTES): JsonObject | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(text(value, field, maxBytes));
		serializeObject(parsed, field, maxBytes);
		return parsed as JsonObject;
	} catch (cause) {
		if (cause instanceof Ap4mPurchaseStoreError) throw cause;
		throw new Ap4mPurchaseStoreError(`Invalid ${field}`, 'INVALID_DATA', cause);
	}
}

function parseResult(value: unknown): Ap4mStoredResult | null {
	const parsed = parseObject(value, 'result_json');
	if (parsed === null) return null;
	if (Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'receipt') || !Object.hasOwn(parsed, 'data')) {
		throw new Ap4mPurchaseStoreError('Invalid result_json', 'INVALID_DATA');
	}
	const receipt = Ap4mReceiptSchema.parse(parsed.receipt);
	if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
		throw new Ap4mPurchaseStoreError('Invalid result data', 'INVALID_DATA');
	}
	return { receipt, data: parsed.data as JsonObject };
}

function decode(row: RawAttempt): Ap4mPurchaseAttempt {
	const status = text(row.status, 'status') as Ap4mPurchaseStatus;
	if (!STATUSES.has(status)) throw new Ap4mPurchaseStoreError('Invalid status', 'INVALID_DATA');
	const preparedContextBinding = parseBinding(row.prepared_context_public_json);
	let preparedContextWrapped: WrappedAp4mPreparedContext | null = null;
	if (row.prepared_context_enc !== null || row.prepared_context_iv !== null || row.prepared_context_digest !== null) {
		if (row.prepared_context_enc === null || row.prepared_context_iv === null || row.prepared_context_digest === null) {
			throw new Ap4mPurchaseStoreError('Incomplete wrapped recovery context', 'INVALID_DATA');
		}
		const digest = text(row.prepared_context_digest, 'recovery ciphertext digest', 64);
		if (!DIGEST.test(digest) || preparedContextBinding?.ciphertextDigest !== digest) {
			throw new Ap4mPurchaseStoreError('Invalid wrapped recovery context binding', 'INVALID_DATA');
		}
		preparedContextWrapped = {
			ciphertext: bytes(row.prepared_context_enc, 'recovery ciphertext'),
			iv: bytes(row.prepared_context_iv, 'recovery IV', IV_BYTES),
			digest,
		};
	} else if (preparedContextBinding !== null) {
		throw new Ap4mPurchaseStoreError('Missing wrapped recovery context', 'INVALID_DATA');
	}
	return {
		id: text(row.id, 'id', 200),
		principal: text(row.principal, 'principal', 256),
		mandateId: text(row.mandate_id, 'mandate id', 200),
		idempotencyKey: text(row.idempotency_key, 'idempotency key', 200),
		requestFingerprint: fingerprint(row.request_fingerprint),
		merchantId: text(row.merchant_id, 'merchant id', 200),
		sku: text(row.sku, 'sku', 200),
		status,
		spendId: nullableText(row.spend_id, 'spend id', 200),
		spendDay: nullableText(row.spend_day, 'spend day', 10),
		amountUsd: nullableText(row.amount_usd, 'amount USD', 40),
		preparedContextWrapped,
		preparedContextBinding,
		leaseAcquiredAt: timestamp(row.lease_acquired_at, 'lease acquired at'),
		signingStartedAt: nullableTimestamp(row.signing_started_at, 'signing started at'),
		firstEligibleLedgerIndex: nullablePositiveInteger(row.first_eligible_ledger_index, 'first eligible ledger index'),
		signedBlob: nullableText(row.signed_blob, 'signed blob', 200_000),
		txHash: row.tx_hash === null ? null : hash(row.tx_hash),
		lastLedgerSequence: nullablePositiveInteger(row.last_ledger_sequence, 'last ledger sequence'),
		settlementUnknownAt: nullableTimestamp(row.settlement_unknown_at, 'settlement unknown at'),
		settledAt: nullableTimestamp(row.settled_at, 'settled at'),
		deliveredAt: nullableTimestamp(row.delivered_at, 'delivered at'),
		failedAt: nullableTimestamp(row.failed_at, 'failed at'),
		ledgerIndex: nullablePositiveInteger(row.ledger_index, 'ledger index'),
		deliveredAmount: nullableText(row.delivered_amount, 'delivered amount', 80),
		receiptId: nullableText(row.receipt_id, 'receipt id', 200),
		merchantResponse: parseMerchantResponse(row.merchant_response_json),
		merchantResponseAt: nullableTimestamp(row.merchant_response_at, 'merchant response at'),
		result: parseResult(row.result_json),
		failure: parseObject(row.failure_json, 'failure_json'),
		createdAt: timestamp(row.created_at, 'created at'),
		updatedAt: timestamp(row.updated_at, 'updated at'),
	};
}

const SELECT_ATTEMPT = `SELECT id, principal, mandate_id, idempotency_key, request_fingerprint,
	merchant_id, sku, status, spend_id, spend_day, amount_usd,
	prepared_context_enc, prepared_context_iv, prepared_context_public_json, prepared_context_digest, lease_acquired_at,
	signing_started_at, first_eligible_ledger_index, signed_blob, tx_hash, last_ledger_sequence,
	settlement_unknown_at, settled_at, delivered_at, failed_at, ledger_index,
	delivered_amount, receipt_id, merchant_response_json, merchant_response_at,
	result_json, failure_json, created_at, updated_at
	FROM ap4m_purchase_attempts`;

function sameClaim(row: Ap4mPurchaseAttempt, input: ClaimAp4mPurchaseInput, fp: string): boolean {
	return row.mandateId === input.mandateId && row.requestFingerprint === fp &&
		row.merchantId === input.merchantId && row.sku === input.sku;
}

export class Ap4mPurchaseStore {
	constructor(
		private readonly db: D1Database,
		private readonly principal: string,
		private readonly now: () => Date = () => new Date(),
	) {
		text(principal, 'principal', 256);
	}

	async get(mandateId: string, idempotencyKey: string): Promise<Ap4mPurchaseAttempt | null> {
		text(mandateId, 'mandate id', 200);
		text(idempotencyKey, 'idempotency key', 200);
		const row = await this.db.prepare(`${SELECT_ATTEMPT} WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?`)
			.bind(this.principal, mandateId, idempotencyKey).first<RawAttempt>();
		return row === null ? null : decode(row);
	}

	async readPreparedContext(
		mandateId: string,
		idempotencyKey: string,
		recoveryKek: CryptoKey | string,
		cryptoImpl: Crypto = crypto,
	): Promise<Ap4mPreparedExecutionContext> {
		const row = await this.required(mandateId, idempotencyKey);
		if (row.preparedContextWrapped === null) {
			throw new Ap4mPurchaseStoreError('Wrapped AP4M recovery context not found', 'NOT_FOUND');
		}
		return unwrapAp4mPreparedContext({
			principal: this.principal,
			mandateId,
			idempotencyKey,
		}, row.preparedContextWrapped, recoveryKek, cryptoImpl);
	}

	async claim(input: ClaimAp4mPurchaseInput): Promise<ClaimAp4mPurchaseResult> {
		text(input.id, 'id', 200);
		text(input.mandateId, 'mandate id', 200);
		text(input.idempotencyKey, 'idempotency key', 200);
		const fp = fingerprint(input.requestFingerprint);
		text(input.merchantId, 'merchant id', 200);
		text(input.sku, 'sku', 200);
		timestamp(input.createdAt, 'created at');
		try {
			const result = await this.db.prepare(`INSERT INTO ap4m_purchase_attempts (
				id, principal, mandate_id, idempotency_key, request_fingerprint,
				merchant_id, sku, status, lease_acquired_at, created_at, updated_at
			) SELECT ?, ?, id, ?, ?, ?, ?, 'claimed', ?, ?, ?
			FROM ap4m_mandates WHERE id = ? AND principal = ? AND status = 'ACTIVE'
			ON CONFLICT(principal, mandate_id, idempotency_key) DO NOTHING`)
				.bind(input.id, this.principal, input.idempotencyKey, fp, input.merchantId, input.sku,
					input.createdAt, input.createdAt, input.createdAt, input.mandateId, this.principal).run();
			const row = await this.get(input.mandateId, input.idempotencyKey);
			if (row === null) throw new Ap4mPurchaseStoreError('Active mandate not found', 'NOT_FOUND');
			return { outcome: changed(result) ? 'claimed' : sameClaim(row, input, fp) ? 'replay' : 'mismatch', row };
		} catch (cause) {
			const row = await this.get(input.mandateId, input.idempotencyKey);
			if (row !== null) return { outcome: sameClaim(row, input, fp) ? 'replay' : 'mismatch', row };
			if (cause instanceof Ap4mPurchaseStoreError) throw cause;
			throw new Ap4mPurchaseStoreError('Could not claim AP4M purchase', 'STORE_CONFLICT', cause);
		}
	}

	async acquireClaimRecovery(
		mandateId: string,
		idempotencyKey: string,
		expectedLeaseAcquiredAt: string,
		staleBefore: string,
		acquiredAt: string,
	): Promise<Ap4mTransitionResult> {
		timestamp(expectedLeaseAcquiredAt, 'expected lease acquired at');
		timestamp(staleBefore, 'stale before');
		timestamp(acquiredAt, 'acquired at');
		const result = await this.db.prepare(`UPDATE ap4m_purchase_attempts
			SET lease_acquired_at = ?, updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'claimed'
			AND lease_acquired_at = ? AND lease_acquired_at <= ?`)
			.bind(acquiredAt, acquiredAt, this.principal, mandateId, idempotencyKey,
				expectedLeaseAcquiredAt, staleBefore).run();
		const row = await this.required(mandateId, idempotencyKey);
		return { outcome: changed(result) ? 'transitioned' : 'invalid-state', row };
	}

	async reserve(
		input: ReserveAp4mPurchaseInput,
		recoveryKek: CryptoKey | string,
		cryptoImpl: Crypto = crypto,
	): Promise<ReserveAp4mPurchaseResult> {
		text(input.spendId, 'spend id', 200);
		if (!DAY.test(text(input.spendDay, 'spend day', 10))) {
			throw new Ap4mPurchaseStoreError('Invalid spend day', 'INVALID_DATA');
		}
		const fp = fingerprint(input.requestFingerprint);
		const amountMicros = microusd(input.amountUsd, 'amount USD');
		const preparedContextCanonical = serializePreparedContext(input.preparedContext);
		timestamp(input.leaseAcquiredAt, 'lease acquired at');
		timestamp(input.preparedAt, 'prepared at');
		let transactionAt: string;
		try {
			transactionAt = this.now().toISOString();
		} catch (cause) {
			throw new Ap4mPurchaseStoreError('Invalid reservation clock', 'INVALID_DATA', cause);
		}
		if (Math.abs(Date.parse(transactionAt) - Date.parse(input.preparedAt)) > RESERVATION_FRESHNESS_MS ||
			input.spendDay !== input.preparedAt.slice(0, 10) || input.spendDay !== transactionAt.slice(0, 10)) {
			throw new Ap4mPurchaseStoreError('Spend day does not match prepared time', 'INVALID_DATA');
		}
		const dayStartedAt = `${input.spendDay}T00:00:00.000Z`;
		const existing = await this.required(input.mandateId, input.idempotencyKey);
		if (existing.requestFingerprint !== fp) return { outcome: 'mismatch', row: existing };
		if (input.preparedContext.merchantSnapshot.id !== existing.merchantId ||
			input.preparedContext.merchantSnapshot.products[0]?.sku !== existing.sku) {
			throw new Ap4mPurchaseStoreError('Prepared merchant snapshot does not match purchase claim', 'INVALID_DATA');
		}
		if (existing.status !== 'claimed') {
			const storedContext = existing.preparedContextWrapped === null ? null :
				await unwrapAp4mPreparedContext({
					principal: this.principal,
					mandateId: input.mandateId,
					idempotencyKey: input.idempotencyKey,
				}, existing.preparedContextWrapped, recoveryKek, cryptoImpl);
			const same = existing.spendId === input.spendId && existing.spendDay === input.spendDay &&
				existing.amountUsd === input.amountUsd && storedContext !== null &&
				serializePreparedContext(storedContext) === preparedContextCanonical;
			return { outcome: same ? 'replay' : 'mismatch', row: existing };
		}
		const wrappedContext = await wrapAp4mPreparedContext({
			principal: this.principal,
			mandateId: input.mandateId,
			idempotencyKey: input.idempotencyKey,
		}, input.preparedContext, recoveryKek, cryptoImpl);
		const publicBinding = bindingFor(input.preparedContext, wrappedContext.digest);
		if (publicBinding.challenge.amount !== input.amountUsd) {
			throw new Ap4mPurchaseStoreError('Prepared challenge amount does not match reservation', 'INVALID_DATA');
		}
		const publicBindingJson = canonicalJson(publicBinding);

		const constraintRow = await this.db.prepare(`SELECT constraints_json FROM ap4m_mandates
			WHERE id = ? AND principal = ? AND status = 'ACTIVE'`)
			.bind(input.mandateId, this.principal).first<{ constraints_json: string }>();
		if (constraintRow === null) return { outcome: 'invalid-state', row: existing };
		let constraints: JsonObject;
		try {
			constraints = JSON.parse(constraintRow.constraints_json) as JsonObject;
		} catch (cause) {
			throw new Ap4mPurchaseStoreError('Invalid mandate constraints', 'INVALID_DATA', cause);
		}
		const perPaymentMicros = microusd(constraints.per_payment_max, 'mandate per-payment max', true);
		const dailyMaxMicros = microusd(constraints.daily_max, 'mandate daily max', true);
		const totalMaxMicros = microusd(constraints.total_max, 'mandate total max', true);
		if (amountMicros > perPaymentMicros) return { outcome: 'spend-limit', row: existing };

		try {
			await this.db.batch([
				this.db.prepare(`INSERT INTO ap4m_spend (
					id, principal, mandate_id, spend_day, idempotency_key,
					amount_usd, amount_microusd, status, created_at, updated_at
				) SELECT ?, ?, mandate.id, ?, ?, ?, ?, 'reserved', ?, ?
				FROM ap4m_mandates mandate
				JOIN ap4m_purchase_attempts attempt ON attempt.mandate_id = mandate.id
					AND attempt.principal = mandate.principal
				JOIN policies policy ON policy.principal = mandate.principal
					AND policy.owner = mandate.owner AND policy.network = mandate.network
				WHERE mandate.id = ? AND mandate.principal = ? AND mandate.status = 'ACTIVE'
					AND mandate.network = 'testnet'
					AND mandate.not_before <= ? AND ? < mandate.expires_at
					AND attempt.idempotency_key = ? AND attempt.request_fingerprint = ?
					AND attempt.status = 'claimed' AND attempt.lease_acquired_at = ?
					AND json_valid(policy.json)
					AND json_type(policy.json, '$.ap4m_enabled') = 'true'
					AND EXISTS (SELECT 1 FROM json_each(policy.json, '$.networks') network
						WHERE network.type = 'text' AND network.value = 'testnet')
					AND EXISTS (SELECT 1 FROM json_each(policy.json, '$.issuer_allowlist') issuer
						WHERE issuer.type = 'text' AND issuer.value = ?)
					AND json_type(policy.json, '$.max_per_tx_usd') IN ('integer', 'real')
					AND json_extract(policy.json, '$.max_per_tx_usd') >= 0
					AND ? <= CAST(ROUND(json_extract(policy.json, '$.max_per_tx_usd') * 1000000) AS INTEGER)
					AND json_type(policy.json, '$.daily_cap_usd') IN ('integer', 'real')
					AND json_extract(policy.json, '$.daily_cap_usd') >= 0
					AND mandate.spent_microusd + ? <= ?
					AND (SELECT COALESCE(SUM(amount_microusd), 0) FROM ap4m_spend daily
						WHERE daily.principal = mandate.principal AND daily.mandate_id = mandate.id
						AND daily.spend_day = ? AND daily.status IN ('reserved', 'committed')) + ? <= ?
					AND COALESCE((SELECT SUM(owner_spend.amount_microusd)
						FROM ap4m_spend owner_spend
						JOIN ap4m_mandates owner_mandate ON owner_mandate.id = owner_spend.mandate_id
							AND owner_mandate.principal = owner_spend.principal
						WHERE owner_spend.principal = mandate.principal
							AND owner_mandate.owner = mandate.owner AND owner_mandate.network = mandate.network
							AND owner_spend.spend_day = ?
							AND owner_spend.status IN ('reserved', 'committed')), 0)
						+ COALESCE((SELECT SUM(CAST(ROUND(execution.usd_value * 1000000) AS INTEGER))
							FROM executions execution
							LEFT JOIN execution_snapshots snapshot ON snapshot.principal = execution.principal
								AND snapshot.execution_id = execution.id
							LEFT JOIN builds build ON build.id = execution.build_id AND build.principal = execution.principal
							WHERE execution.principal = mandate.principal
								AND execution.status IN ('pending', 'submitted', 'executed', 'needs_approval')
								AND execution.usd_value > 0
								AND COALESCE(snapshot.snapshot_owner, build.owner) = mandate.owner
								AND COALESCE(snapshot.snapshot_network, build.network) = mandate.network
								AND execution.created_at >= ?
								AND execution.created_at <= ?), 0)
						+ ? <= CAST(ROUND(json_extract(policy.json, '$.daily_cap_usd') * 1000000) AS INTEGER)`)
					.bind(input.spendId, this.principal, input.spendDay, input.idempotencyKey,
						input.amountUsd, amountMicros, transactionAt, transactionAt,
						input.mandateId, this.principal, transactionAt, transactionAt,
						input.idempotencyKey, fp, input.leaseAcquiredAt,
						publicBinding.receiptAmount.asset.currency, amountMicros,
						amountMicros, totalMaxMicros, input.spendDay, amountMicros, dailyMaxMicros,
						input.spendDay, dayStartedAt, transactionAt, amountMicros),
				this.db.prepare(`UPDATE ap4m_mandates
					SET spent_microusd = spent_microusd + ?,
						spent_usd = printf('%.6f', (spent_microusd + ?) / 1000000.0), updated_at = ?
					WHERE id = ? AND principal = ? AND changes() = 1`)
					.bind(amountMicros, amountMicros, transactionAt, input.mandateId, this.principal),
				this.db.prepare(`UPDATE ap4m_purchase_attempts
					SET status = 'prepared', spend_id = ?, spend_day = ?, amount_usd = ?,
						amount_microusd = ?, prepared_context_enc = ?, prepared_context_iv = ?,
						prepared_context_public_json = ?, prepared_context_digest = ?, receipt_id = ?, updated_at = ?
					WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
						AND status = 'claimed' AND lease_acquired_at = ? AND changes() = 1`)
					.bind(input.spendId, input.spendDay, input.amountUsd, amountMicros,
						wrappedContext.ciphertext, wrappedContext.iv, publicBindingJson, wrappedContext.digest,
						input.preparedContext.receiptId, transactionAt,
						this.principal, input.mandateId, input.idempotencyKey, input.leaseAcquiredAt),
			]);
		} catch (cause) {
			const row = await this.required(input.mandateId, input.idempotencyKey);
			if (row.status !== 'claimed') {
				const storedContext = row.preparedContextWrapped === null ? null :
					await unwrapAp4mPreparedContext({
						principal: this.principal,
						mandateId: input.mandateId,
						idempotencyKey: input.idempotencyKey,
					}, row.preparedContextWrapped, recoveryKek, cryptoImpl);
				const same = row.spendId === input.spendId && row.amountUsd === input.amountUsd &&
					storedContext !== null && serializePreparedContext(storedContext) === preparedContextCanonical;
				return { outcome: same ? 'replay' : 'mismatch', row };
			}
			throw new Ap4mPurchaseStoreError('Could not reserve AP4M spend', 'STORE_CONFLICT', cause);
		}
		const row = await this.required(input.mandateId, input.idempotencyKey);
		if (row.status === 'prepared' && row.spendId === input.spendId && row.amountUsd === input.amountUsd &&
			row.preparedContextWrapped !== null && row.preparedContextBinding?.ciphertextDigest === wrappedContext.digest) {
			return { outcome: 'reserved', row };
		}
		return { outcome: row.status === 'claimed' ? 'spend-limit' : 'invalid-state', row };
	}

	async acquireSigningLease(
		mandateId: string,
		idempotencyKey: string,
		value: { token: string; firstEligibleLedgerIndex: number; staleBefore: string; at: string },
	): Promise<AcquireAp4mSigningLeaseResult> {
		const token = signingToken(value.token);
		positiveInteger(value.firstEligibleLedgerIndex, 'first eligible ledger index');
		timestamp(value.staleBefore, 'signing stale before');
		timestamp(value.at, 'signing started at');
		if (value.staleBefore >= value.at) {
			throw new Ap4mPurchaseStoreError('Invalid signing stale threshold', 'INVALID_DATA');
		}
		const result = await this.db.prepare(`UPDATE ap4m_purchase_attempts
			SET signing_started_at = ?, signing_lease_token = ?, first_eligible_ledger_index = ?, updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
				AND status = 'prepared' AND prepared_context_enc IS NOT NULL
				AND prepared_context_public_json IS NOT NULL AND signing_started_at IS NULL
				AND signing_lease_token IS NULL AND first_eligible_ledger_index IS NULL`)
			.bind(value.at, token, value.firstEligibleLedgerIndex, value.at,
				this.principal, mandateId, idempotencyKey).run();
		const row = await this.required(mandateId, idempotencyKey);
		if (changed(result)) return { outcome: 'acquired', row };
		if (row.status !== 'prepared') return { outcome: 'invalid-state', row };
		const lease = await this.signingLease(mandateId, idempotencyKey);
		if (lease.token === token && lease.firstEligibleLedgerIndex === value.firstEligibleLedgerIndex) {
			return { outcome: 'owner', row };
		}
		// Once signing_started_at exists without a durable hash, the signer may
		// already have produced a valid transaction. Time cannot prove otherwise,
		// so a different token must never take over and reuse the sequence.
		return { outcome: 'busy', row };
	}

	async markSigned(
		mandateId: string,
		idempotencyKey: string,
		leaseToken: string,
		value: { hash: string; signedBlob: string; lastLedgerSequence: number; at: string },
	): Promise<Ap4mTransitionResult> {
		const token = signingToken(leaseToken);
		const txHash = hash(value.hash);
		const signedBlob = text(value.signedBlob, 'signed blob', 200_000).toUpperCase();
		if (!HEX.test(signedBlob) || signedBlob.length % 2 !== 0) {
			throw new Ap4mPurchaseStoreError('Invalid signed blob', 'INVALID_DATA');
		}
		positiveInteger(value.lastLedgerSequence, 'last ledger sequence');
		timestamp(value.at, 'signed at');
		const result = await this.db.prepare(`UPDATE ap4m_purchase_attempts
			SET status = 'signed', signed_blob = ?, tx_hash = ?, last_ledger_sequence = ?, updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
				AND status = 'prepared' AND prepared_context_enc IS NOT NULL
				AND prepared_context_public_json IS NOT NULL AND signing_started_at IS NOT NULL
				AND signing_lease_token = ? AND first_eligible_ledger_index IS NOT NULL
				AND first_eligible_ledger_index <= ?`)
			.bind(signedBlob, txHash, value.lastLedgerSequence, value.at,
				this.principal, mandateId, idempotencyKey, token, value.lastLedgerSequence).run();
		const row = await this.required(mandateId, idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		const lease = await this.signingLease(mandateId, idempotencyKey);
		if (lease.token !== token) return { outcome: 'not-owner', row };
		if (row.status === 'signed' && row.txHash === txHash && row.signedBlob === signedBlob &&
			row.lastLedgerSequence === value.lastLedgerSequence) return { outcome: 'replay', row };
		return { outcome: row.status === 'signed' ? 'mismatch' : 'invalid-state', row };
	}

	async markSettlementUnknown(
		mandateId: string,
		idempotencyKey: string,
		at: string,
	): Promise<Ap4mTransitionResult> {
		timestamp(at, 'settlement unknown at');
		const result = await this.db.prepare(`UPDATE ap4m_purchase_attempts
			SET status = 'settlement_unknown', settlement_unknown_at = COALESCE(settlement_unknown_at, ?), updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'signed' AND tx_hash IS NOT NULL`)
			.bind(at, at, this.principal, mandateId, idempotencyKey).run();
		const row = await this.required(mandateId, idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		return { outcome: row.status === 'settlement_unknown' ? 'replay' : 'invalid-state', row };
	}

	async cacheMerchantResponse(
		mandateId: string,
		idempotencyKey: string,
		value: { response: Ap4mValidatedMerchantResponse; at: string },
	): Promise<Ap4mTransitionResult> {
		timestamp(value.at, 'merchant response at');
		const responseJson = serializeMerchantResponse(value.response);
		const result = await this.db.prepare(`UPDATE ap4m_purchase_attempts
			SET merchant_response_json = ?, merchant_response_at = ?, updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
				AND status IN ('signed', 'settlement_unknown', 'settled') AND merchant_response_json IS NULL
				AND tx_hash IS NOT NULL`)
			.bind(responseJson, value.at, value.at, this.principal, mandateId, idempotencyKey).run();
		const row = await this.required(mandateId, idempotencyKey);
		if (changed(result)) return { outcome: 'transitioned', row };
		if (row.merchantResponse !== null) {
			return {
				outcome: JSON.stringify(row.merchantResponse) === responseJson ? 'replay' : 'mismatch',
				row,
			};
		}
		return { outcome: 'invalid-state', row };
	}

	async markSettled(
		mandateId: string,
		idempotencyKey: string,
		value: { hash: string; ledgerIndex: number; deliveredAmount: string; at: string },
	): Promise<Ap4mTransitionResult> {
		const txHash = hash(value.hash);
		positiveInteger(value.ledgerIndex, 'ledger index');
		text(value.deliveredAmount, 'delivered amount', 80);
		timestamp(value.at, 'settled at');
		const results = await this.db.batch([
			this.db.prepare(`UPDATE ap4m_purchase_attempts
				SET status = 'settled', ledger_index = ?, delivered_amount = ?, settled_at = ?, updated_at = ?
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
					AND status IN ('signed', 'settlement_unknown') AND tx_hash = ?`)
				.bind(value.ledgerIndex, value.deliveredAmount, value.at, value.at,
					this.principal, mandateId, idempotencyKey, txHash),
			this.db.prepare(`UPDATE ap4m_spend SET status = 'committed', updated_at = ?
				WHERE principal = ? AND mandate_id = ? AND id = (
					SELECT spend_id FROM ap4m_purchase_attempts
					WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'settled'
				) AND status = 'reserved' AND changes() = 1`)
				.bind(value.at, this.principal, mandateId, this.principal, mandateId, idempotencyKey),
		]);
		const row = await this.required(mandateId, idempotencyKey);
		if (changed(results[0] ?? { success: false }) === 1) return { outcome: 'transitioned', row };
		if (row.status === 'settled' && row.txHash === txHash && row.ledgerIndex === value.ledgerIndex &&
			row.deliveredAmount === value.deliveredAmount) return { outcome: 'replay', row };
		return { outcome: row.status === 'settled' ? 'mismatch' : 'invalid-state', row };
	}

	async markDelivered(
		mandateId: string,
		idempotencyKey: string,
		value: { result: Ap4mStoredResult; at: string },
	): Promise<Ap4mTransitionResult> {
		timestamp(value.at, 'delivered at');
		const receipt = Ap4mReceiptSchema.parse(value.result.receipt);
		if (receipt.mandate_id !== mandateId) {
			throw new Ap4mPurchaseStoreError('Receipt mandate does not match attempt', 'INVALID_DATA');
		}
		const resultJson = serializeObject({ receipt, data: value.result.data }, 'result');
		const existing = await this.required(mandateId, idempotencyKey);
		const binding = existing.preparedContextBinding;
		const receiptAsset = receipt.amount.asset;
		if (binding === null || existing.merchantResponse === null ||
			receipt.receipt_id !== existing.receiptId || receipt.receipt_id !== binding.receiptId ||
			receipt.intent_id !== binding.intentId ||
			receipt.l3a_digest !== binding.l3aDigest ||
			receipt.l3b_digest !== binding.l3bDigest ||
			receipt.merchant_id !== existing.merchantId || receipt.sku !== existing.sku ||
			receipt.scheme !== 'exact' || receipt.settlement !== 'validated' ||
			receiptAsset.kind !== 'iou' ||
			receiptAsset.currency !== binding.receiptAmount.asset.currency ||
			receiptAsset.issuer !== binding.receiptAmount.asset.issuer ||
			receipt.amount.value !== binding.receiptAmount.value ||
			receipt.amount.value !== existing.amountUsd ||
			receipt.proof.tx_hash?.toUpperCase() !== existing.txHash) {
			throw new Ap4mPurchaseStoreError('Receipt does not match attempt', 'INVALID_DATA');
		}
		if (
			canonicalJson(existing.merchantResponse.data) !== canonicalJson(value.result.data) ||
			canonicalJson(existing.merchantResponse.intent_validation) !== canonicalJson(receipt.merchant_validation)
		) {
			throw new Ap4mPurchaseStoreError('Result does not match cached merchant response', 'INVALID_DATA');
		}
		try {
			const results = await this.db.batch([
				this.db.prepare(`INSERT INTO ap4m_receipts (
					id, principal, mandate_id, merchant_id, idempotency_key, json, created_at
				) SELECT ?, principal, mandate_id, merchant_id, idempotency_key, ?, ?
				FROM ap4m_purchase_attempts
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'settled'
				ON CONFLICT(principal, mandate_id, idempotency_key) DO NOTHING`)
					.bind(receipt.receipt_id, JSON.stringify(receipt), value.at,
						this.principal, mandateId, idempotencyKey),
				this.db.prepare(`UPDATE ap4m_spend SET receipt_id = ?, updated_at = ?
					WHERE principal = ? AND mandate_id = ? AND id = (
						SELECT spend_id FROM ap4m_purchase_attempts
						WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'settled'
					) AND status = 'committed'`)
					.bind(receipt.receipt_id, value.at, this.principal, mandateId,
						this.principal, mandateId, idempotencyKey),
				this.db.prepare(`UPDATE ap4m_purchase_attempts
					SET status = 'delivered', receipt_id = ?, result_json = ?, delivered_at = ?, updated_at = ?
					WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'settled'`)
					.bind(receipt.receipt_id, resultJson, value.at, value.at,
						this.principal, mandateId, idempotencyKey),
			]);
			const row = await this.required(mandateId, idempotencyKey);
			if (changed(results[2] ?? { success: false })) return { outcome: 'transitioned', row };
			if (row.status === 'delivered' && JSON.stringify(row.result) === resultJson) {
				return { outcome: 'replay', row };
			}
			return { outcome: row.status === 'delivered' ? 'mismatch' : 'invalid-state', row };
		} catch (cause) {
			const row = await this.required(mandateId, idempotencyKey);
			if (row.status === 'delivered' && JSON.stringify(row.result) === resultJson) return { outcome: 'replay', row };
			throw new Ap4mPurchaseStoreError('Could not persist AP4M result', 'STORE_CONFLICT', cause);
		}
	}

	async markSigningFailed(
		mandateId: string,
		idempotencyKey: string,
		leaseToken: string,
		failure: JsonObject,
		at: string,
	): Promise<Ap4mTransitionResult> {
		const token = signingToken(leaseToken);
		const row = await this.required(mandateId, idempotencyKey);
		const lease = await this.signingLease(mandateId, idempotencyKey);
		if (row.status === 'prepared' && lease.token !== token) return { outcome: 'not-owner', row };
		return this.failAndRelease(mandateId, idempotencyKey, failure, at,
			`status = 'prepared' AND signing_started_at IS NOT NULL AND signing_lease_token = ?
				AND tx_hash IS NULL AND signed_blob IS NULL`, [token]);
	}

	async markFailed(
		mandateId: string,
		idempotencyKey: string,
		failure: JsonObject,
		at: string,
	): Promise<Ap4mTransitionResult> {
		return this.failAndRelease(mandateId, idempotencyKey, failure, at,
			`(status = 'claimed' OR (status = 'prepared' AND signing_started_at IS NULL))`);
	}

	async markExpiredAbsentFailed(
		mandateId: string,
		idempotencyKey: string,
		value: {
			hash: string;
			lookupCode: string;
			validatedLedgerIndex: number;
			inclusionLedgersChecked: readonly number[];
			at: string;
		},
	): Promise<Ap4mTransitionResult> {
		const txHash = hash(value.hash);
		timestamp(value.at, 'failed at');
		const row = await this.required(mandateId, idempotencyKey);
		if (row.txHash !== txHash || row.firstEligibleLedgerIndex === null || row.lastLedgerSequence === null) {
			return { outcome: 'invalid-evidence', row };
		}
		const range = expiredAbsentRange(value, row.firstEligibleLedgerIndex, row.lastLedgerSequence);
		if (range === null) return { outcome: 'invalid-evidence', row };
		return this.failAndRelease(mandateId, idempotencyKey, {
			code: 'expired_absent', lookup_code: 'txnNotFound', validated: true,
			transaction_found: false, validated_ledger_index: value.validatedLedgerIndex,
			checked_from: range.checkedFrom, checked_through: range.checkedThrough, hash: txHash,
		}, value.at, `status IN ('signed', 'settlement_unknown') AND tx_hash = ? AND last_ledger_sequence < ?`,
			[txHash, value.validatedLedgerIndex]);
	}

	async markValidatedFailed(
		mandateId: string,
		idempotencyKey: string,
		value: {
			hash: string;
			validated: true;
			transactionFound: true;
			validatedLedgerIndex: number;
			transactionResult: string;
			at: string;
		},
	): Promise<Ap4mTransitionResult> {
		const txHash = hash(value.hash);
		const ledgerIndex = positiveInteger(value.validatedLedgerIndex, 'validated ledger index');
		const transactionResult = text(value.transactionResult, 'transaction result', 80);
		timestamp(value.at, 'failed at');
		const row = await this.required(mandateId, idempotencyKey);
		if (value.validated !== true || value.transactionFound !== true ||
			!VALIDATED_TERMINAL_RESULT.test(transactionResult) || row.txHash !== txHash ||
			row.firstEligibleLedgerIndex === null || row.lastLedgerSequence === null ||
			ledgerIndex < row.firstEligibleLedgerIndex || ledgerIndex > row.lastLedgerSequence) {
			return { outcome: 'invalid-evidence', row };
		}
		return this.failAndRelease(mandateId, idempotencyKey, {
			code: 'validated_transaction_failure', validated: true, transaction_found: true,
			transaction_result: transactionResult, validated_ledger_index: ledgerIndex, hash: txHash,
		}, value.at, `status IN ('signed', 'settlement_unknown') AND tx_hash = ?
			AND first_eligible_ledger_index <= ? AND last_ledger_sequence >= ?`,
			[txHash, ledgerIndex, ledgerIndex]);
	}

	private async failAndRelease(
		mandateId: string,
		idempotencyKey: string,
		failure: JsonObject,
		at: string,
		condition: string,
		conditionArgs: unknown[] = [],
	): Promise<Ap4mTransitionResult> {
		timestamp(at, 'failed at');
		const failureJson = serializeObject(failure, 'failure', 16 * 1024);
		const results = await this.db.batch([
			this.db.prepare(`UPDATE ap4m_purchase_attempts
			SET status = 'failed', signing_lease_token = NULL, failed_at = ?, failure_json = ?, updated_at = ?
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND ${condition}`)
				.bind(at, failureJson, at, this.principal, mandateId, idempotencyKey, ...conditionArgs),
			this.db.prepare(`UPDATE ap4m_spend SET status = 'released', updated_at = ?
				WHERE principal = ? AND mandate_id = ? AND status = 'reserved'
					AND id = (SELECT spend_id FROM ap4m_purchase_attempts
						WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'failed')
					AND (SELECT changes()) = 1`)
				.bind(at, this.principal, mandateId, this.principal, mandateId, idempotencyKey),
			this.db.prepare(`UPDATE ap4m_mandates
				SET spent_microusd = MAX(0, spent_microusd - COALESCE((
					SELECT amount_microusd FROM ap4m_purchase_attempts
					WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
				), 0)),
				spent_usd = printf('%.6f', MAX(0, spent_microusd - COALESCE((
					SELECT amount_microusd FROM ap4m_purchase_attempts
					WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
				), 0)) / 1000000.0), updated_at = ?
				WHERE id = ? AND principal = ? AND changes() = 1`)
				.bind(this.principal, mandateId, idempotencyKey,
					this.principal, mandateId, idempotencyKey,
					at, mandateId, this.principal),
		]);
		const row = await this.required(mandateId, idempotencyKey);
		if (changed(results[0] ?? { success: false })) return { outcome: 'transitioned', row };
		if (row.status === 'failed' && JSON.stringify(row.failure) === failureJson) return { outcome: 'replay', row };
		return { outcome: row.status === 'failed' ? 'mismatch' : 'invalid-state', row };
	}

	private async required(mandateId: string, idempotencyKey: string): Promise<Ap4mPurchaseAttempt> {
		const row = await this.get(mandateId, idempotencyKey);
		if (row === null) throw new Ap4mPurchaseStoreError('AP4M purchase attempt not found', 'NOT_FOUND');
		return row;
	}

	private async signingLease(
		mandateId: string,
		idempotencyKey: string,
	): Promise<{ token: string | null; firstEligibleLedgerIndex: number | null }> {
		const row = await this.db.prepare(`SELECT signing_lease_token, first_eligible_ledger_index
			FROM ap4m_purchase_attempts WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?`)
			.bind(this.principal, mandateId, idempotencyKey)
			.first<{ signing_lease_token: unknown; first_eligible_ledger_index: unknown }>();
		if (row === null) throw new Ap4mPurchaseStoreError('AP4M purchase attempt not found', 'NOT_FOUND');
		return {
			token: row.signing_lease_token === null ? null : signingToken(row.signing_lease_token),
			firstEligibleLedgerIndex: nullablePositiveInteger(
				row.first_eligible_ledger_index, 'first eligible ledger index',
			),
		};
	}
}
