import { isValidClassicAddress } from 'xrpl';

import {
	Ap4mReceiptSchema,
	McIntentSchema,
	MerchantSchema,
	type McIntent,
	type Merchant,
} from '../contracts';
import { canonicalAp4mJson } from './ap4m-intent';
import {
	Ap4mMerchantSuccessSchema,
	Ap4mTypedDataSchema,
	validateAp4mMerchantResponse,
	validateAp4mMerchantResponseBinding,
	type ValidatedAp4mResponse,
} from './ap4m-response';
import {
	channelPaymentHeader,
	issueChannelClaim,
	nextChannelClaim,
	type IssueChannelClaimDependencies,
	type IssuedChannelClaim,
} from './channel-claims';
import type {
	ChannelClaimProof,
	ChannelClaimStore,
} from './channel-claim-store';
import type { WrappedMandateClaimKeys } from './channel-keys';
import type { MandateKeyIdentity } from './mandate-keys';

type JsonObject = Record<string, unknown>;

const HEX_64 = /^[A-F0-9]{64}$/;
const LOWER_HEX_64 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CHANNEL_ID = /^[A-F0-9]{64}$/;
const PUBLIC_KEY = /^(?:ED|02|03)[A-F0-9]{64}$/;
const SIGNATURE = /^[A-F0-9]+$/;
const UINT = /^(?:0|[1-9]\d*)$/;
const POSITIVE_UINT = /^[1-9]\d*$/;
const USD = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const IV_BYTES = 12;
const KEK_BYTES = 32;
const MAX_DROPS = 100_000_000_000_000_000n;
const MAX_TEXT = 64 * 1024;
const RETRY_PURPOSE = 'xrpl-paychan-retry-v1';

export type ChannelPurchaseStatus =
	| 'reserved'
	| 'claim_signed'
	| 'merchant_accepted'
	| 'delivered';

export interface ChannelPurchaseRetryMaterial {
	intent: McIntent;
	viL1: string;
	viL2: string;
	viL3b: string;
	/** Opaque, bounded state owned by the injected merchant exchange. */
	exchangeState: JsonObject;
}

export interface WrappedChannelPurchaseRetryMaterial {
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
	digest: string;
}

export interface ChannelPurchaseAttempt {
	id: string;
	principal: string;
	mandateId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	network: 'testnet';
	rail: 'xrpl-paychan';
	merchantId: string;
	sku: string;
	merchantSnapshot: Merchant;
	payer: string;
	channelId: string;
	channelAmountDrops: string;
	priceDrops: string;
	previousDrops: string;
	cumulativeDrops: string;
	claimToken: string;
	publicKey: string;
	signature: string | null;
	spendId: string;
	spendDay: string;
	amountUsd: string;
	intentId: string;
	l3aDigest: string;
	l3bDigest: string;
	receiptId: string;
	retryMaterialWrapped: WrappedChannelPurchaseRetryMaterial;
	merchantResponse: ReturnType<typeof Ap4mMerchantSuccessSchema.parse> | null;
	result: ValidatedAp4mResponse | null;
	status: ChannelPurchaseStatus;
	acceptedAt: string | null;
	deliveredAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ReserveChannelPurchaseInput {
	id: string;
	mandateId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	merchant: Merchant;
	sku: string;
	payer: string;
	channel: {
		merchant_id: string;
		channel_id: string;
		amount_drops: string;
	};
	priceDrops: string;
	previousDrops: string;
	cumulativeDrops: string;
	claimToken: string;
	publicKey: string;
	spendId: string;
	spendDay: string;
	amountUsd: string;
	receiptId: string;
	retryMaterial: ChannelPurchaseRetryMaterial;
	l3aDigest: string;
	l3bDigest: string;
	at: string;
}

export type ReserveChannelPurchaseResult = {
	outcome: 'reserved' | 'replay' | 'mismatch' | 'spend-limit' | 'blocked';
	attempt: ChannelPurchaseAttempt;
};

export type ChannelPurchaseTransitionResult = {
	outcome: 'transitioned' | 'replay' | 'mismatch' | 'invalid-state';
	attempt: ChannelPurchaseAttempt;
};

export type ChannelPurchaseRead =
	| { outcome: 'absent' }
	| { outcome: 'pending'; attempt: ChannelPurchaseAttempt }
	| { outcome: 'delivered'; attempt: ChannelPurchaseAttempt; result: ValidatedAp4mResponse };

export class ChannelPurchaseStoreError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_INPUT'
			| 'INVALID_DATA'
			| 'STORE_CONFLICT'
			| 'SPEND_LIMIT'
			| 'NOT_FOUND'
			| 'SCHEMA_UNAVAILABLE',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'ChannelPurchaseStoreError';
	}
}

type RawAttempt = Record<string, unknown>;

function text(value: string, field: string, max = 256): string {
	if (
		typeof value !== 'string' || value.length === 0 || value.length > max ||
		value.includes('\0') || new TextEncoder().encode(value).byteLength > max
	) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	return value;
}

function identifier(value: string, field: string): string {
	text(value, field, 128);
	if (!IDENTIFIER.test(value)) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	return value;
}

function timestamp(value: string, field: string): string {
	text(value, field, 40);
	if (new Date(value).toISOString() !== value) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	return value;
}

function hex64(value: string, field: string): string {
	if (typeof value !== 'string' || !HEX_64.test(value)) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	return value;
}

function lowerHex64(value: string, field: string): string {
	if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	return value;
}

function drops(value: string, field: string, allowZero = false): string {
	if (
		typeof value !== 'string' || value.length > 18 ||
		!(allowZero ? UINT : POSITIVE_UINT).test(value)
	) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	const parsed = BigInt(value);
	if (parsed > MAX_DROPS) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT');
	}
	return value;
}

function microusd(value: string): number {
	if (typeof value !== 'string' || value.length > 17 || !USD.test(value)) {
		throw new ChannelPurchaseStoreError('amount USD is invalid', 'INVALID_INPUT');
	}
	const [whole, fraction = ''] = value.split('.');
	if (whole!.length > 10) {
		throw new ChannelPurchaseStoreError('amount USD is invalid', 'INVALID_INPUT');
	}
	const result = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
	if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new ChannelPurchaseStoreError('amount USD is invalid', 'INVALID_INPUT');
	}
	return Number(result);
}

function canonical(value: unknown, field: string): string {
	let result: string;
	try {
		result = canonicalAp4mJson(value);
	} catch (cause) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_INPUT', cause);
	}
	if (new TextEncoder().encode(result).byteLength > MAX_TEXT) {
		throw new ChannelPurchaseStoreError(`${field} is too large`, 'INVALID_INPUT');
	}
	return result;
}

function parseJson(value: unknown, field: string): unknown {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_DATA');
	}
	try {
		return JSON.parse(value) as unknown;
	} catch (cause) {
		throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_DATA', cause);
	}
}

function buffer(value: unknown, field: string): ArrayBuffer {
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (ArrayBuffer.isView(value)) {
		return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
	}
	throw new ChannelPurchaseStoreError(`${field} is invalid`, 'INVALID_DATA');
}

function retryAad(principal: string, mandateId: string, idempotencyKey: string): Uint8Array {
	return new TextEncoder().encode(canonical([
		text(principal, 'principal', 256),
		identifier(mandateId, 'mandate id'),
		identifier(idempotencyKey, 'idempotency key'),
		RETRY_PURPOSE,
	], 'retry AAD'));
}

function validateKek(key: CryptoKey, usage: 'encrypt' | 'decrypt'): void {
	const algorithm = key?.algorithm as { name?: unknown; length?: unknown } | undefined;
	if (
		key?.type !== 'secret' || algorithm?.name !== 'AES-GCM' || algorithm.length !== 256 ||
		key.extractable || !key.usages.includes(usage)
	) {
		throw new ChannelPurchaseStoreError('AP4M recovery key is invalid', 'INVALID_INPUT');
	}
}

async function kekKey(value: CryptoKey | string, usage: 'encrypt' | 'decrypt'): Promise<{
	key: CryptoKey;
	raw?: Uint8Array;
}> {
	if (typeof value !== 'string') {
		validateKek(value, usage);
		return { key: value };
	}
	let raw: Uint8Array | undefined;
	try {
		if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new TypeError('invalid base64');
		const decoded = atob(value);
		if (decoded.length !== KEK_BYTES) throw new TypeError('invalid length');
		raw = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
		const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
		return { key, raw };
	} catch (cause) {
		raw?.fill(0);
		throw new ChannelPurchaseStoreError('AP4M recovery key is invalid', 'INVALID_INPUT', cause);
	}
}

async function digest(value: ArrayBuffer): Promise<string> {
	const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
	return Array.from(hashed, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function wrapRetryMaterial(
	principal: string,
	mandateId: string,
	idempotencyKey: string,
	material: ChannelPurchaseRetryMaterial,
	kek: CryptoKey | string,
): Promise<WrappedChannelPurchaseRetryMaterial> {
	const parsed: ChannelPurchaseRetryMaterial = {
		intent: McIntentSchema.parse(material.intent),
		viL1: text(material.viL1, 'VI L1', MAX_TEXT),
		viL2: text(material.viL2, 'VI L2', MAX_TEXT),
		viL3b: text(material.viL3b, 'VI L3b', MAX_TEXT),
		exchangeState: parseJson(canonical(material.exchangeState, 'exchange state'), 'exchange state') as JsonObject,
	};
	const plaintext = new TextEncoder().encode(canonical(parsed, 'retry material'));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const imported = await kekKey(kek, 'encrypt');
	try {
		const ciphertext = await crypto.subtle.encrypt({
			name: 'AES-GCM',
			iv,
			additionalData: retryAad(principal, mandateId, idempotencyKey),
		}, imported.key, plaintext);
		return { ciphertext, iv: Uint8Array.from(iv).buffer, digest: await digest(ciphertext) };
	} catch (cause) {
		if (cause instanceof ChannelPurchaseStoreError) throw cause;
		throw new ChannelPurchaseStoreError('Retry material could not be encrypted', 'INVALID_INPUT', cause);
	} finally {
		plaintext.fill(0);
		imported.raw?.fill(0);
	}
}

async function unwrapRetryMaterial(
	principal: string,
	mandateId: string,
	idempotencyKey: string,
	wrapped: WrappedChannelPurchaseRetryMaterial,
	kek: CryptoKey | string,
): Promise<ChannelPurchaseRetryMaterial> {
	if (
		!(wrapped.ciphertext instanceof ArrayBuffer) || wrapped.ciphertext.byteLength < 17 ||
		!(wrapped.iv instanceof ArrayBuffer) || wrapped.iv.byteLength !== IV_BYTES ||
		await digest(wrapped.ciphertext) !== wrapped.digest
	) {
		throw new ChannelPurchaseStoreError('Retry material binding is invalid', 'INVALID_DATA');
	}
	const imported = await kekKey(kek, 'decrypt');
	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt({
			name: 'AES-GCM',
			iv: new Uint8Array(wrapped.iv),
			additionalData: retryAad(principal, mandateId, idempotencyKey),
		}, imported.key, wrapped.ciphertext);
	} catch (cause) {
		throw new ChannelPurchaseStoreError('Retry material could not be decrypted', 'INVALID_DATA', cause);
	} finally {
		imported.raw?.fill(0);
	}
	const bytes = new Uint8Array(plaintext);
	try {
		const parsed = parseJson(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
			'retry material',
		);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new TypeError('invalid object');
		}
		const value = parsed as Record<string, unknown>;
		if (Object.keys(value).sort().join(',') !== 'exchangeState,intent,viL1,viL2,viL3b') {
			throw new TypeError('invalid fields');
		}
		const exchangeState = value.exchangeState;
		if (!exchangeState || typeof exchangeState !== 'object' || Array.isArray(exchangeState)) {
			throw new TypeError('invalid exchange state');
		}
		return {
			intent: McIntentSchema.parse(value.intent),
			viL1: text(value.viL1 as string, 'VI L1', MAX_TEXT),
			viL2: text(value.viL2 as string, 'VI L2', MAX_TEXT),
			viL3b: text(value.viL3b as string, 'VI L3b', MAX_TEXT),
			exchangeState: exchangeState as JsonObject,
		};
	} catch (cause) {
		if (cause instanceof ChannelPurchaseStoreError) throw cause;
		throw new ChannelPurchaseStoreError('Retry material is invalid', 'INVALID_DATA', cause);
	} finally {
		bytes.fill(0);
	}
}

function changed(result: D1Result<unknown> | undefined): boolean {
	return result?.success === true && Number(result.meta?.changes ?? 0) === 1;
}

function parseAttempt(raw: RawAttempt | null): ChannelPurchaseAttempt | null {
	if (raw === null) return null;
	try {
		const status = raw.status as ChannelPurchaseStatus;
		if (!['reserved', 'claim_signed', 'merchant_accepted', 'delivered'].includes(status)) {
			throw new TypeError('invalid status');
		}
		const merchant = MerchantSchema.parse(parseJson(raw.merchant_snapshot_json, 'merchant snapshot'));
		const response = raw.merchant_response_json === null
			? null
			: Ap4mMerchantSuccessSchema.parse(parseJson(raw.merchant_response_json, 'merchant response'));
		const parsedResult = raw.result_json === null ? null : parseJson(raw.result_json, 'purchase result');
		const result = parsedResult === null ? null : {
			receipt: Ap4mReceiptSchema.parse((parsedResult as JsonObject).receipt),
			data: Ap4mTypedDataSchema.parse((parsedResult as JsonObject).data),
		};
		const signature = raw.signature === null ? null : String(raw.signature);
		if (signature !== null && (!SIGNATURE.test(signature) || signature.length % 2 !== 0)) {
			throw new TypeError('invalid signature');
		}
		const attempt: ChannelPurchaseAttempt = {
			id: identifier(String(raw.id), 'attempt id'),
			principal: text(String(raw.principal), 'principal', 256),
			mandateId: identifier(String(raw.mandate_id), 'mandate id'),
			idempotencyKey: identifier(String(raw.idempotency_key), 'idempotency key'),
			requestFingerprint: hex64(String(raw.request_fingerprint), 'request fingerprint'),
			network: raw.network === 'testnet' ? 'testnet' : (() => { throw new TypeError('network'); })(),
			rail: raw.rail === 'xrpl-paychan' ? 'xrpl-paychan' : (() => { throw new TypeError('rail'); })(),
			merchantId: identifier(String(raw.merchant_id), 'merchant id'),
			sku: identifier(String(raw.sku), 'sku'),
			merchantSnapshot: merchant,
			payer: isValidClassicAddress(String(raw.payer)) ? String(raw.payer) : (() => { throw new TypeError('payer'); })(),
			channelId: CHANNEL_ID.test(String(raw.channel_id)) ? String(raw.channel_id) : (() => { throw new TypeError('channel'); })(),
			channelAmountDrops: drops(String(raw.channel_amount_drops), 'channel amount'),
			priceDrops: drops(String(raw.price_drops), 'price drops'),
			previousDrops: drops(String(raw.previous_drops), 'previous drops', true),
			cumulativeDrops: drops(String(raw.cumulative_drops), 'cumulative drops'),
			claimToken: hex64(String(raw.claim_token), 'claim token'),
			publicKey: PUBLIC_KEY.test(String(raw.public_key)) ? String(raw.public_key) : (() => { throw new TypeError('key'); })(),
			signature,
			spendId: identifier(String(raw.spend_id), 'spend id'),
			spendDay: text(String(raw.spend_day), 'spend day', 10),
			amountUsd: String(raw.amount_usd),
			intentId: text(String(raw.intent_id), 'intent id', 128),
			l3aDigest: lowerHex64(String(raw.l3a_digest), 'L3a digest'),
			l3bDigest: lowerHex64(String(raw.l3b_digest), 'L3b digest'),
			receiptId: identifier(String(raw.receipt_id), 'receipt id'),
			retryMaterialWrapped: {
				ciphertext: buffer(raw.retry_material_enc, 'retry ciphertext'),
				iv: buffer(raw.retry_material_iv, 'retry IV'),
				digest: hex64(String(raw.retry_material_digest), 'retry digest'),
			},
			merchantResponse: response,
			result,
			status,
			acceptedAt: raw.accepted_at === null ? null : timestamp(String(raw.accepted_at), 'accepted at'),
			deliveredAt: raw.delivered_at === null ? null : timestamp(String(raw.delivered_at), 'delivered at'),
			createdAt: timestamp(String(raw.created_at), 'created at'),
			updatedAt: timestamp(String(raw.updated_at), 'updated at'),
		};
		if (
			attempt.merchantId !== merchant.id ||
			merchant.products.length !== 1 || merchant.products[0]?.sku !== attempt.sku ||
			attempt.amountUsd !== merchant.products[0]?.price.value || microusd(attempt.amountUsd) <= 0 ||
			attempt.cumulativeDrops !== nextChannelClaim(
				attempt.previousDrops, attempt.priceDrops, attempt.channelAmountDrops,
			) ||
			(status === 'reserved' && (signature !== null || response !== null || result !== null)) ||
			(status === 'claim_signed' && (signature === null || response !== null || result !== null)) ||
			(status === 'merchant_accepted' && (signature === null || response === null || result !== null)) ||
			(status === 'delivered' && (signature === null || response === null || result === null))
		) {
			throw new TypeError('invalid state shape');
		}
		if (result !== null) assertDeliveredResult(attempt, result);
		return attempt;
	} catch (cause) {
		if (cause instanceof ChannelPurchaseStoreError && cause.code === 'INVALID_DATA') throw cause;
		throw new ChannelPurchaseStoreError('Stored channel purchase is invalid', 'INVALID_DATA', cause);
	}
}

function assertDeliveredResult(attempt: ChannelPurchaseAttempt, result: ValidatedAp4mResponse): void {
	const receipt = Ap4mReceiptSchema.parse(result.receipt);
	const product = attempt.merchantSnapshot.products[0]!;
	if (
		receipt.receipt_id !== attempt.receiptId || receipt.mandate_id !== attempt.mandateId ||
		receipt.merchant_id !== attempt.merchantId || receipt.sku !== attempt.sku ||
		receipt.intent_id !== attempt.intentId || receipt.l3a_digest !== attempt.l3aDigest ||
		receipt.l3b_digest !== attempt.l3bDigest || receipt.scheme !== 'xrpl-paychan' ||
		receipt.settlement !== 'claim_accepted' || receipt.proof.channel_id !== attempt.channelId ||
		receipt.proof.cumulative_drops !== attempt.cumulativeDrops ||
		canonical(receipt.amount, 'receipt amount') !== canonical(product.price, 'product price') ||
		attempt.merchantResponse === null ||
		canonical(result.data, 'result data') !== canonical(attempt.merchantResponse.data, 'merchant data') ||
		canonical(receipt.merchant_validation, 'merchant validation') !==
			canonical(attempt.merchantResponse.intent_validation, 'merchant validation')
	) {
		throw new ChannelPurchaseStoreError('Delivered result does not match channel purchase', 'INVALID_DATA');
	}
}

function assertIntentBinding(intent: McIntent, merchant: Merchant, sku: string): void {
	const product = merchant.products.find((entry) => entry.sku === sku);
	const order = intent.orders[0];
	const item = order?.items[0];
	const boundMerchant = order?.merchants[0];
	if (
		!product || intent.intentStatus !== 'ACTIVE' || intent.orders.length !== 1 ||
		!order || order.orderExecutionType !== 'DEFERRED' || order.items.length !== 1 ||
		order.merchants.length !== 1 || order.orderTotalAmount.currency !== 'USD' ||
		order.orderTotalAmount.amount !== product.price.value || !item ||
		item.itemId !== product.sku || item.itemName !== product.name ||
		item.itemUnitPrice.currency !== 'USD' || item.itemUnitPrice.amount !== product.price.value ||
		item.itemQuantity !== 1 || !boundMerchant || boundMerchant.srcDpaId !== merchant.src_dpa_id ||
		boundMerchant.merchantName !== merchant.name
	) {
		throw new ChannelPurchaseStoreError('Mastercard intent does not match the registry purchase', 'INVALID_INPUT');
	}
}

function sameReplayIdentity(row: ChannelPurchaseAttempt, input: {
	requestFingerprint: string;
	merchantId: string;
	sku: string;
	payer: string;
	channelId: string;
}): boolean {
	return row.requestFingerprint === input.requestFingerprint &&
		row.merchantId === input.merchantId && row.sku === input.sku &&
		row.payer === input.payer && row.channelId === input.channelId;
}

export class D1ChannelPurchaseStore {
	#schemaReady?: Promise<void>;

	constructor(
		private readonly db: D1Database,
		private readonly principal: string,
	) {
		text(principal, 'principal', 256);
	}

	private async ensureSchema(): Promise<void> {
		this.#schemaReady ??= (async () => {
			try {
				await this.db.prepare(
					`SELECT 1 AS ready
					FROM ap4m_paychan_purchase_attempts purchase
					LEFT JOIN ap4m_channel_claim_attempts claim ON 1 = 0
					LEFT JOIN ap4m_spend spend ON 1 = 0
					LEFT JOIN ap4m_receipts receipt ON 1 = 0
					LEFT JOIN ap4m_purchase_attempts exact_attempt ON 1 = 0
					LEFT JOIN ap4m_mandates mandate ON 1 = 0
					LEFT JOIN policies policy ON 1 = 0
					LEFT JOIN executions execution ON 1 = 0
					LEFT JOIN execution_snapshots snapshot ON 1 = 0
					LEFT JOIN builds build ON 1 = 0
					LIMIT 1`,
				).first<{ ready: number }>();
			} catch (cause) {
				throw new ChannelPurchaseStoreError(
					'AP4M paychan purchase schema is unavailable',
					'SCHEMA_UNAVAILABLE',
					cause,
				);
			}
		})();
		return this.#schemaReady;
	}

	private async hasReservationConflict(input: ReserveChannelPurchaseInput): Promise<boolean> {
		const [claim, exact, spend] = await Promise.all([
			this.db.prepare(`SELECT 1 AS found FROM ap4m_channel_claim_attempts
				WHERE principal = ? AND channel_id = ? AND idempotency_key <> ? AND status = 'pending'
				LIMIT 1`).bind(this.principal, input.channel.channel_id, input.idempotencyKey)
				.first<{ found: number }>(),
			this.db.prepare(`SELECT 1 AS found FROM ap4m_purchase_attempts
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? LIMIT 1`)
				.bind(this.principal, input.mandateId, input.idempotencyKey).first<{ found: number }>(),
			this.db.prepare(`SELECT 1 AS found FROM ap4m_spend
				WHERE principal = ? AND (id = ? OR (mandate_id = ? AND idempotency_key = ?)) LIMIT 1`)
				.bind(this.principal, input.spendId, input.mandateId, input.idempotencyKey)
				.first<{ found: number }>(),
		]);
		return claim !== null || exact !== null || spend !== null;
	}

	async get(mandateId: string, idempotencyKey: string): Promise<ChannelPurchaseAttempt | null> {
		await this.ensureSchema();
		try {
			const row = await this.db.prepare(`SELECT * FROM ap4m_paychan_purchase_attempts
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?`)
				.bind(this.principal, identifier(mandateId, 'mandate id'), identifier(idempotencyKey, 'idempotency key'))
				.first<RawAttempt>();
			return parseAttempt(row);
		} catch (cause) {
			if (cause instanceof ChannelPurchaseStoreError) throw cause;
			throw new ChannelPurchaseStoreError('Channel purchase could not be read', 'STORE_CONFLICT', cause);
		}
	}

	async read(mandateId: string, idempotencyKey: string): Promise<ChannelPurchaseRead> {
		const attempt = await this.get(mandateId, idempotencyKey);
		if (attempt === null) return { outcome: 'absent' };
		if (attempt.status !== 'delivered') return { outcome: 'pending', attempt };
		if (attempt.result === null) {
			throw new ChannelPurchaseStoreError('Delivered purchase has no result', 'INVALID_DATA');
		}
		assertDeliveredResult(attempt, attempt.result);
		return { outcome: 'delivered', attempt, result: attempt.result };
	}

	async readRetryMaterial(
		mandateId: string,
		idempotencyKey: string,
		recoveryKek: CryptoKey | string,
	): Promise<ChannelPurchaseRetryMaterial> {
		const attempt = await this.get(mandateId, idempotencyKey);
		if (attempt === null) throw new ChannelPurchaseStoreError('Channel purchase was not found', 'NOT_FOUND');
		const material = await unwrapRetryMaterial(
			this.principal, attempt.mandateId, attempt.idempotencyKey,
			attempt.retryMaterialWrapped, recoveryKek,
		);
		if (material.intent.intentId !== attempt.intentId) {
			throw new ChannelPurchaseStoreError('Retry intent does not match purchase', 'INVALID_DATA');
		}
		return material;
	}

	async reserve(
		input: ReserveChannelPurchaseInput,
		recoveryKek: CryptoKey | string,
	): Promise<ReserveChannelPurchaseResult> {
		const fingerprint = hex64(input.requestFingerprint, 'request fingerprint');
		const merchantId = identifier(input.merchant.id, 'merchant id');
		const sku = identifier(input.sku, 'sku');
		const existing = await this.get(input.mandateId, input.idempotencyKey);
		if (existing !== null) {
			return {
				outcome: sameReplayIdentity(existing, {
					requestFingerprint: fingerprint,
					merchantId,
					sku,
					payer: input.payer,
					channelId: input.channel.channel_id,
				})
					? 'replay'
					: 'mismatch',
				attempt: existing,
			};
		}
		const merchant = MerchantSchema.parse(input.merchant);
		if (merchant.network !== 'testnet' || !merchant.schemes.includes('xrpl-paychan')) {
			throw new ChannelPurchaseStoreError('Merchant is not configured for Testnet paychan', 'INVALID_INPUT');
		}
		const products = merchant.products.filter((product) => product.sku === input.sku);
		if (products.length !== 1 || input.channel.merchant_id !== merchant.id) {
			throw new ChannelPurchaseStoreError('Merchant purchase binding is invalid', 'INVALID_INPUT');
		}
		const snapshot = MerchantSchema.parse({ ...merchant, products });
		if (input.amountUsd !== products[0]!.price.value) {
			throw new ChannelPurchaseStoreError('Purchase amount does not match the registry product', 'INVALID_INPUT');
		}
		const payer = input.payer;
		if (!isValidClassicAddress(payer)) throw new ChannelPurchaseStoreError('Payer is invalid', 'INVALID_INPUT');
		const channelId = input.channel.channel_id;
		if (!CHANNEL_ID.test(channelId)) throw new ChannelPurchaseStoreError('Channel id is invalid', 'INVALID_INPUT');
		const channelAmount = drops(input.channel.amount_drops, 'channel amount');
		const price = drops(input.priceDrops, 'price drops');
		const previous = drops(input.previousDrops, 'previous drops', true);
		const cumulative = drops(input.cumulativeDrops, 'cumulative drops');
		if (cumulative !== nextChannelClaim(previous, price, channelAmount)) {
			throw new ChannelPurchaseStoreError('Cumulative claim is invalid', 'INVALID_INPUT');
		}
		const publicKey = input.publicKey;
		if (!PUBLIC_KEY.test(publicKey)) throw new ChannelPurchaseStoreError('Claim public key is invalid', 'INVALID_INPUT');
		const at = timestamp(input.at, 'reservation time');
		if (input.spendDay !== at.slice(0, 10)) throw new ChannelPurchaseStoreError('Spend day is invalid', 'INVALID_INPUT');
		const amountMicros = microusd(input.amountUsd);
		const token = hex64(input.claimToken, 'claim token');
		const intent = McIntentSchema.parse(input.retryMaterial.intent);
		assertIntentBinding(intent, snapshot, input.sku);
		const retryMaterial = {
			...input.retryMaterial,
			intent,
		};
		const wrapped = await wrapRetryMaterial(
			this.principal, input.mandateId, input.idempotencyKey, retryMaterial, recoveryKek,
		);
		const merchantJson = canonical(snapshot, 'merchant snapshot');
		const asset = products[0]!.price.asset;
		const issuerName = asset.kind === 'iou' ? asset.currency : '';
		const dayStartedAt = `${input.spendDay}T00:00:00.000Z`;

		try {
			await this.db.batch([
				this.db.prepare(`INSERT INTO ap4m_spend (
					id, principal, mandate_id, spend_day, idempotency_key,
					amount_usd, amount_microusd, status, created_at, updated_at
				) SELECT ?, ?, mandate.id, ?, ?, ?, ?, 'reserved', ?, ?
				FROM ap4m_mandates mandate
				JOIN policies policy ON policy.principal = mandate.principal
					AND policy.owner = mandate.owner AND policy.network = mandate.network
				WHERE mandate.id = ? AND mandate.principal = ? AND mandate.network = 'testnet'
					AND mandate.status = 'ACTIVE' AND mandate.not_before <= ? AND ? < mandate.expires_at
					AND json_valid(policy.json) AND json_type(policy.json, '$.ap4m_enabled') = 'true'
					AND EXISTS (SELECT 1 FROM json_each(policy.json, '$.networks') network
						WHERE network.type = 'text' AND network.value = 'testnet')
					AND (? = 'xrp' OR EXISTS (SELECT 1 FROM json_each(policy.json, '$.issuer_allowlist') issuer
						WHERE issuer.type = 'text' AND issuer.value = ?))
					AND json_type(policy.json, '$.max_per_tx_usd') IN ('integer', 'real')
					AND ? <= CAST(ROUND(json_extract(policy.json, '$.max_per_tx_usd') * 1000000) AS INTEGER)
					AND mandate.spent_microusd + ? <= CAST(ROUND(json_extract(mandate.constraints_json, '$.total_max') * 1000000) AS INTEGER)
					AND (SELECT COALESCE(SUM(amount_microusd), 0) FROM ap4m_spend daily
						WHERE daily.principal = mandate.principal AND daily.mandate_id = mandate.id
						AND daily.spend_day = ? AND daily.status IN ('reserved', 'committed')) + ?
						<= CAST(ROUND(json_extract(mandate.constraints_json, '$.daily_max') * 1000000) AS INTEGER)
					AND COALESCE((SELECT SUM(owner_spend.amount_microusd)
						FROM ap4m_spend owner_spend JOIN ap4m_mandates owner_mandate
							ON owner_mandate.id = owner_spend.mandate_id AND owner_mandate.principal = owner_spend.principal
						WHERE owner_spend.principal = mandate.principal AND owner_mandate.owner = mandate.owner
							AND owner_mandate.network = mandate.network AND owner_spend.spend_day = ?
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
								AND execution.created_at >= ? AND execution.created_at <= ?), 0)
						+ ? <= CAST(ROUND(json_extract(policy.json, '$.daily_cap_usd') * 1000000) AS INTEGER)`)
					.bind(
						input.spendId, this.principal, input.spendDay, input.idempotencyKey,
						input.amountUsd, amountMicros, at, at, input.mandateId, this.principal,
						at, at, asset.kind, issuerName, amountMicros, amountMicros,
						input.spendDay, amountMicros, input.spendDay, dayStartedAt, at, amountMicros,
					),
				this.db.prepare(`UPDATE ap4m_mandates SET
					spent_microusd = spent_microusd + ?,
					spent_usd = printf('%.6f', (spent_microusd + ?) / 1000000.0), updated_at = ?
				WHERE id = ? AND principal = ? AND EXISTS (
					SELECT 1 FROM ap4m_spend WHERE id = ? AND principal = ? AND status = 'reserved'
				)`).bind(amountMicros, amountMicros, at, input.mandateId, this.principal, input.spendId, this.principal),
				this.db.prepare(`INSERT OR IGNORE INTO ap4m_channel_claims (
					principal, mandate_id, merchant_id, channel_id, payer, channel_amount_drops,
					public_key, cumulative_drops, created_at, updated_at
				) SELECT ?, ?, ?, ?, ?, ?, ?, '0', ?, ? WHERE EXISTS (
					SELECT 1 FROM ap4m_spend WHERE id = ? AND principal = ? AND status = 'reserved'
				)`).bind(this.principal, input.mandateId, merchant.id, channelId, payer,
					channelAmount, publicKey, at, at, input.spendId, this.principal),
				this.db.prepare(`UPDATE ap4m_channel_claims SET
					pending_idempotency_key = ?, pending_price_drops = ?, pending_cumulative_drops = ?,
					pending_token = ?, updated_at = ?
				WHERE principal = ? AND mandate_id = ? AND merchant_id = ? AND channel_id = ?
					AND payer = ? AND channel_amount_drops = ? AND public_key = ?
					AND cumulative_drops = ? AND pending_idempotency_key IS NULL
					AND EXISTS (SELECT 1 FROM ap4m_spend WHERE id = ? AND principal = ? AND status = 'reserved')`)
					.bind(input.idempotencyKey, price, cumulative, token, at,
						this.principal, input.mandateId, merchant.id, channelId, payer, channelAmount,
						publicKey, previous, input.spendId, this.principal),
				this.db.prepare(`INSERT INTO ap4m_channel_claim_attempts (
					principal, channel_id, idempotency_key, merchant_id, price_drops,
					cumulative_drops, claim_token, public_key, signature, status, created_at, updated_at
				) SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?
				WHERE EXISTS (SELECT 1 FROM ap4m_channel_claims claim
					WHERE claim.principal = ? AND claim.channel_id = ? AND claim.pending_idempotency_key = ?
						AND claim.pending_price_drops = ? AND claim.pending_cumulative_drops = ?
						AND claim.pending_token = ?)`)
					.bind(this.principal, channelId, input.idempotencyKey, merchant.id, price,
						cumulative, token, publicKey, at, at,
						this.principal, channelId, input.idempotencyKey, price, cumulative, token),
				this.db.prepare(`INSERT INTO ap4m_paychan_purchase_attempts (
					id, principal, mandate_id, idempotency_key, request_fingerprint, network, rail,
					merchant_id, sku, merchant_snapshot_json, payer, channel_id, channel_amount_drops,
					price_drops, previous_drops, cumulative_drops, claim_token, public_key, signature,
					spend_id, spend_day, amount_usd, intent_id, l3a_digest, l3b_digest, receipt_id,
					retry_material_enc, retry_material_iv, retry_material_digest,
					merchant_response_json, result_json, status, accepted_at, delivered_at, created_at, updated_at
				) SELECT ?, ?, ?, ?, ?, 'testnet', 'xrpl-paychan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
					NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'reserved', NULL, NULL, ?, ?
				WHERE EXISTS (SELECT 1 FROM ap4m_spend spend WHERE spend.id = ? AND spend.principal = ?
					AND spend.mandate_id = ? AND spend.idempotency_key = ? AND spend.status = 'reserved')
				AND EXISTS (SELECT 1 FROM ap4m_channel_claim_attempts claim
					WHERE claim.principal = ? AND claim.channel_id = ? AND claim.idempotency_key = ?
						AND claim.claim_token = ? AND claim.status = 'pending')`)
					.bind(input.id, this.principal, input.mandateId, input.idempotencyKey, fingerprint,
						merchant.id, input.sku, merchantJson, payer, channelId, channelAmount, price,
						previous, cumulative, token, publicKey, input.spendId, input.spendDay,
						input.amountUsd, retryMaterial.intent.intentId, input.l3aDigest, input.l3bDigest,
						input.receiptId, wrapped.ciphertext, wrapped.iv, wrapped.digest, at, at,
						input.spendId, this.principal, input.mandateId, input.idempotencyKey,
						this.principal, channelId, input.idempotencyKey, token),
				this.db.prepare(`INSERT INTO ap4m_spend (
					id, principal, mandate_id, spend_day, idempotency_key,
					amount_usd, amount_microusd, status, created_at, updated_at
				) SELECT '', NULL, '', '', '', '', 0, 'reserved', '', ''
				WHERE NOT EXISTS (
					SELECT 1 FROM ap4m_paychan_purchase_attempts purchase
					WHERE purchase.principal = ? AND purchase.mandate_id = ?
						AND purchase.idempotency_key = ? AND purchase.status = 'reserved'
				)`)
					.bind(this.principal, input.mandateId, input.idempotencyKey),
			]);
		} catch (cause) {
			const raced = await this.get(input.mandateId, input.idempotencyKey);
			if (raced !== null) {
				return {
					outcome: sameReplayIdentity(raced, {
						requestFingerprint: fingerprint,
						merchantId,
						sku,
						payer: input.payer,
						channelId: input.channel.channel_id,
					})
						? 'replay'
						: 'mismatch',
					attempt: raced,
				};
			}
			if (
				cause instanceof Error &&
				(/binding mismatch/.test(cause.message) || /idempotency key already belongs/.test(cause.message))
			) {
				throw new ChannelPurchaseStoreError('Channel purchase reservation conflicted', 'STORE_CONFLICT', cause);
			}
			if (!await this.hasReservationConflict(input)) {
				throw new ChannelPurchaseStoreError('AP4M spend limit was exceeded', 'SPEND_LIMIT', cause);
			}
			throw new ChannelPurchaseStoreError('Channel purchase reservation conflicted', 'STORE_CONFLICT', cause);
		}
		const stored = await this.get(input.mandateId, input.idempotencyKey);
		if (stored !== null) return { outcome: 'reserved', attempt: stored };
		const spend = await this.db.prepare(`SELECT status FROM ap4m_spend WHERE id = ? AND principal = ?`)
			.bind(input.spendId, this.principal).first<{ status: string }>();
		if (spend === null) {
			const placeholder = parseAttempt(await this.db.prepare(`SELECT * FROM ap4m_paychan_purchase_attempts
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?`)
				.bind(this.principal, input.mandateId, input.idempotencyKey).first<RawAttempt>());
			if (placeholder !== null) return { outcome: 'blocked', attempt: placeholder };
			throw new ChannelPurchaseStoreError('AP4M spend limit was exceeded', 'SPEND_LIMIT');
		}
		throw new ChannelPurchaseStoreError('Atomic channel reservation was not stored', 'STORE_CONFLICT');
	}

	async markClaimSigned(input: {
		mandateId: string;
		idempotencyKey: string;
		proof: ChannelClaimProof;
		at: string;
	}): Promise<ChannelPurchaseTransitionResult> {
		const at = timestamp(input.at, 'claim signed at');
		const proof = input.proof;
		if (
			proof.scheme !== 'xrpl-paychan' || !CHANNEL_ID.test(proof.channel_id) ||
			!POSITIVE_UINT.test(proof.cumulative_drops) || !SIGNATURE.test(proof.signature) ||
			proof.signature.length % 2 !== 0 || !PUBLIC_KEY.test(proof.public_key)
		) throw new ChannelPurchaseStoreError('Claim proof is invalid', 'INVALID_INPUT');
		const update = await this.db.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
			signature = ?, status = 'claim_signed', updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ? AND status = 'reserved'
				AND channel_id = ? AND cumulative_drops = ? AND public_key = ?
				AND EXISTS (SELECT 1 FROM ap4m_channel_claim_attempts claim
					WHERE claim.principal = ? AND claim.channel_id = ? AND claim.idempotency_key = ?
						AND claim.cumulative_drops = ? AND claim.public_key = ? AND claim.signature = ?
						AND claim.status = 'completed')`)
			.bind(proof.signature, at, this.principal, input.mandateId, input.idempotencyKey,
				proof.channel_id, proof.cumulative_drops, proof.public_key,
				this.principal, proof.channel_id, input.idempotencyKey, proof.cumulative_drops,
				proof.public_key, proof.signature).run();
		const attempt = await this.get(input.mandateId, input.idempotencyKey);
		if (attempt === null) throw new ChannelPurchaseStoreError('Channel purchase was not found', 'NOT_FOUND');
		if (changed(update)) return { outcome: 'transitioned', attempt };
		if (attempt.signature === proof.signature && ['claim_signed', 'merchant_accepted', 'delivered'].includes(attempt.status)) {
			return { outcome: 'replay', attempt };
		}
		return { outcome: attempt.status === 'reserved' ? 'mismatch' : 'invalid-state', attempt };
	}

	async markMerchantAccepted(input: {
		mandateId: string;
		idempotencyKey: string;
		merchantResponse: unknown;
		at: string;
	}): Promise<ChannelPurchaseTransitionResult> {
		const at = timestamp(input.at, 'merchant accepted at');
		const current = await this.get(input.mandateId, input.idempotencyKey);
		if (current === null) throw new ChannelPurchaseStoreError('Channel purchase was not found', 'NOT_FOUND');
		let response;
		try {
			response = validateAp4mMerchantResponseBinding(input.merchantResponse, {
				merchant: current.merchantSnapshot,
				sku: current.sku,
				intentId: current.intentId,
			});
		} catch (cause) {
			throw new ChannelPurchaseStoreError('Merchant acceptance is invalid', 'INVALID_INPUT', cause);
		}
		const responseJson = canonical(response, 'merchant response');
		const update = await this.db.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
			merchant_response_json = ?, status = 'merchant_accepted', accepted_at = ?, updated_at = ?
			WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
				AND status = 'claim_signed' AND signature IS NOT NULL`)
			.bind(responseJson, at, at, this.principal, input.mandateId, input.idempotencyKey).run();
		const attempt = await this.get(input.mandateId, input.idempotencyKey);
		if (attempt === null) throw new ChannelPurchaseStoreError('Channel purchase was not found', 'NOT_FOUND');
		if (changed(update)) return { outcome: 'transitioned', attempt };
		if (attempt.merchantResponse !== null) {
			return {
				outcome: canonical(attempt.merchantResponse, 'stored response') === responseJson ? 'replay' : 'mismatch',
				attempt,
			};
		}
		return { outcome: 'invalid-state', attempt };
	}

	async markDelivered(input: {
		mandateId: string;
		idempotencyKey: string;
		at: string;
	}): Promise<ChannelPurchaseTransitionResult> {
		const at = timestamp(input.at, 'delivered at');
		const current = await this.get(input.mandateId, input.idempotencyKey);
		if (current === null) throw new ChannelPurchaseStoreError('Channel purchase was not found', 'NOT_FOUND');
		if (current.status === 'delivered' && current.result !== null) return { outcome: 'replay', attempt: current };
		if (current.status !== 'merchant_accepted' || current.merchantResponse === null) {
			return { outcome: 'invalid-state', attempt: current };
		}
		const result = validateAp4mMerchantResponse(current.merchantResponse, {
			receiptId: current.receiptId,
			mandateId: current.mandateId,
			merchant: current.merchantSnapshot,
			sku: current.sku,
			intentId: current.intentId,
			l3aDigest: current.l3aDigest,
			l3bDigest: current.l3bDigest,
			paidAmount: current.merchantSnapshot.products[0]!.price,
			settlement: {
				scheme: 'xrpl-paychan',
				settlement: 'claim_accepted',
				proof: { channel_id: current.channelId, cumulative_drops: current.cumulativeDrops },
			},
			at,
		});
		assertDeliveredResult(current, result);
		const resultJson = canonical(result, 'purchase result');
		try {
			await this.db.batch([
				this.db.prepare(`INSERT INTO ap4m_receipts (
					id, principal, mandate_id, merchant_id, idempotency_key, json, created_at
				) SELECT ?, principal, mandate_id, merchant_id, idempotency_key, ?, ?
				FROM ap4m_paychan_purchase_attempts
				WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
					AND status = 'merchant_accepted' AND merchant_response_json IS NOT NULL`)
					.bind(current.receiptId, canonical(result.receipt, 'receipt'), at,
						this.principal, current.mandateId, current.idempotencyKey),
				this.db.prepare(`UPDATE ap4m_spend SET status = 'committed', receipt_id = ?, updated_at = ?
					WHERE id = ? AND principal = ? AND mandate_id = ? AND idempotency_key = ?
						AND status = 'reserved' AND EXISTS (
							SELECT 1 FROM ap4m_receipts receipt WHERE receipt.id = ? AND receipt.principal = ?
						)`).bind(current.receiptId, at, current.spendId, this.principal,
					current.mandateId, current.idempotencyKey, current.receiptId, this.principal),
				this.db.prepare(`UPDATE ap4m_paychan_purchase_attempts SET
					result_json = ?, status = 'delivered', delivered_at = ?, updated_at = ?
					WHERE principal = ? AND mandate_id = ? AND idempotency_key = ?
						AND status = 'merchant_accepted' AND merchant_response_json IS NOT NULL
						AND EXISTS (SELECT 1 FROM ap4m_spend spend WHERE spend.id = spend_id
							AND spend.principal = ? AND spend.status = 'committed' AND spend.receipt_id = ?)`)
					.bind(resultJson, at, at, this.principal, current.mandateId, current.idempotencyKey,
						this.principal, current.receiptId),
				this.db.prepare(`INSERT INTO ap4m_receipts (
					id, principal, mandate_id, merchant_id, idempotency_key, json, created_at
				) SELECT '', NULL, '', '', '', '{}', ''
				WHERE NOT EXISTS (
					SELECT 1 FROM ap4m_paychan_purchase_attempts purchase
					WHERE purchase.principal = ? AND purchase.mandate_id = ?
						AND purchase.idempotency_key = ? AND purchase.status = 'delivered'
				)`)
					.bind(this.principal, current.mandateId, current.idempotencyKey),
			]);
		} catch (cause) {
			const reread = await this.get(current.mandateId, current.idempotencyKey);
			if (reread?.status === 'delivered' && reread.result !== null && canonical(reread.result, 'result') === resultJson) {
				return { outcome: 'replay', attempt: reread };
			}
			throw new ChannelPurchaseStoreError('Channel purchase delivery conflicted', 'STORE_CONFLICT', cause);
		}
		const delivered = await this.get(current.mandateId, current.idempotencyKey);
		if (delivered?.status !== 'delivered' || delivered.result === null) {
			throw new ChannelPurchaseStoreError('Delivered channel purchase was not stored', 'STORE_CONFLICT');
		}
		return { outcome: 'transitioned', attempt: delivered };
	}
}

export interface PrepareChannelPurchaseResult {
	priceDrops: string;
	intent: McIntent;
	viL1: string;
	viL2: string;
	viL3b: string;
	l3aDigest: string;
	l3bDigest: string;
	exchangeState: JsonObject;
}

export interface ExecuteChannelPurchaseInput {
	principal: string;
	mandateId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	merchant: Merchant;
	sku: string;
	payer: string;
	channel: { merchant_id: string; channel_id: string; amount_drops: string };
	identity: MandateKeyIdentity;
	wrappedKeys: WrappedMandateClaimKeys;
	recoveryKek: CryptoKey | string;
	amountUsd: string;
	prepare(): Promise<PrepareChannelPurchaseResult>;
	exchange(input: {
		trustedRegistryUrl: string;
		exchangeState: JsonObject;
		paymentHeader: ChannelClaimProof;
		mastercardIntent: McIntent;
		viL1: string;
		viL2: string;
		viL3b: string;
	}): Promise<unknown>;
}

export interface ExecuteChannelPurchaseDependencies {
	purchaseStore: D1ChannelPurchaseStore;
	claimStore: ChannelClaimStore;
	withSigner?: IssueChannelClaimDependencies['withSigner'];
	now(): Date;
}

export interface ExecuteChannelPurchaseResult {
	result: ValidatedAp4mResponse;
	proof: ChannelClaimProof;
	replayed: boolean;
}

async function deterministicHex(value: unknown): Promise<string> {
	const encoded = new TextEncoder().encode(canonical(value, 'deterministic identifier'));
	const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
	return Array.from(hashed, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function proofFromAttempt(attempt: ChannelPurchaseAttempt): ChannelClaimProof {
	if (attempt.signature === null) throw new ChannelPurchaseStoreError('Signed claim is missing', 'INVALID_DATA');
	return {
		scheme: 'xrpl-paychan',
		channel_id: attempt.channelId,
		cumulative_drops: attempt.cumulativeDrops,
		signature: attempt.signature,
		public_key: attempt.publicKey,
	};
}

function validatedClaimKeys(
	wrapped: WrappedMandateClaimKeys,
	merchantId: string,
): { wrapped: WrappedMandateClaimKeys; publicKey: string } {
	if (
		!(wrapped.ciphertext instanceof ArrayBuffer) || wrapped.ciphertext.byteLength < 17 ||
		!(wrapped.iv instanceof ArrayBuffer) || wrapped.iv.byteLength !== IV_BYTES ||
		!Array.isArray(wrapped.publicKeys) || wrapped.publicKeys.length === 0 ||
		wrapped.publicKeys.length > 32
	) {
		throw new ChannelPurchaseStoreError('Wrapped claim keys are invalid', 'INVALID_INPUT');
	}
	const merchants = new Set<string>();
	const publicKeys = wrapped.publicKeys.map((entry) => {
		if (
			!entry || typeof entry !== 'object' ||
			typeof entry.merchant_id !== 'string' || typeof entry.public_key !== 'string'
		) {
			throw new ChannelPurchaseStoreError('Wrapped claim keys are invalid', 'INVALID_INPUT');
		}
		const entryMerchantId = identifier(entry.merchant_id, 'claim-key merchant id');
		if (merchants.has(entryMerchantId) || !PUBLIC_KEY.test(entry.public_key)) {
			throw new ChannelPurchaseStoreError('Wrapped claim keys are invalid', 'INVALID_INPUT');
		}
		merchants.add(entryMerchantId);
		return Object.freeze({ merchant_id: entryMerchantId, public_key: entry.public_key });
	});
	const matches = publicKeys.filter((entry) => entry.merchant_id === merchantId);
	if (matches.length !== 1) {
		throw new ChannelPurchaseStoreError('Merchant claim key is missing', 'INVALID_INPUT');
	}
	return {
		wrapped: Object.freeze({
			ciphertext: wrapped.ciphertext.slice(0),
			iv: wrapped.iv.slice(0),
			publicKeys: Object.freeze(publicKeys),
		}),
		publicKey: matches[0]!.public_key,
	};
}

function nowIso(dependencies: Pick<ExecuteChannelPurchaseDependencies, 'now'>): string {
	const now = dependencies.now();
	if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
		throw new ChannelPurchaseStoreError('Channel purchase clock is invalid', 'INVALID_INPUT');
	}
	return now.toISOString();
}

/**
 * Execute the channel branch only after the caller has completed its trusted
 * merchant, active-mandate, policy and payer gates. There are intentionally no
 * default network or merchant callbacks at this boundary.
 */
export async function executeChannelPurchase(
	input: ExecuteChannelPurchaseInput,
	dependencies: ExecuteChannelPurchaseDependencies,
): Promise<ExecuteChannelPurchaseResult> {
	if (input.principal !== input.identity.principal || input.mandateId !== input.identity.mandateId) {
		throw new ChannelPurchaseStoreError('Channel purchase identity is invalid', 'INVALID_INPUT');
	}
	const requestIdentity = {
		requestFingerprint: hex64(input.requestFingerprint, 'request fingerprint'),
		merchantId: identifier(input.merchant.id, 'merchant id'),
		sku: identifier(input.sku, 'sku'),
		payer: input.payer,
		channelId: input.channel.channel_id,
	};
	let read = await dependencies.purchaseStore.read(input.mandateId, input.idempotencyKey);
	if (read.outcome === 'delivered') {
		if (!sameReplayIdentity(read.attempt, requestIdentity)) {
			throw new ChannelPurchaseStoreError('Idempotency key belongs to another purchase', 'STORE_CONFLICT');
		}
		return { result: read.result, proof: proofFromAttempt(read.attempt), replayed: true };
	}

	let attempt = read.outcome === 'pending' ? read.attempt : undefined;
	let wrappedKeys = input.wrappedKeys;
	let material: ChannelPurchaseRetryMaterial | undefined;
	if (attempt === undefined) {
		const claimKeys = validatedClaimKeys(wrappedKeys, requestIdentity.merchantId);
		wrappedKeys = claimKeys.wrapped;
		const prepared = await input.prepare();
		const at = nowIso(dependencies);
		const current = await dependencies.claimStore.get(input.channel.channel_id);
		const previous = current?.cumulativeDrops ?? '0';
		const cumulative = nextChannelClaim(previous, prepared.priceDrops, input.channel.amount_drops);
		const root = await deterministicHex({
			purpose: 'ap4m/paychan-purchase/v1',
			principal: input.principal,
			mandate_id: input.mandateId,
			idempotency_key: input.idempotencyKey,
			request_fingerprint: input.requestFingerprint,
			merchant_id: input.merchant.id,
			sku: input.sku,
			channel_id: input.channel.channel_id,
		});
		material = {
			intent: McIntentSchema.parse(prepared.intent),
			viL1: prepared.viL1,
			viL2: prepared.viL2,
			viL3b: prepared.viL3b,
			exchangeState: prepared.exchangeState,
		};
		const reserved = await dependencies.purchaseStore.reserve({
			id: `ap4m-paychan-${root.slice(0, 48)}`,
			mandateId: input.mandateId,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint: input.requestFingerprint,
			merchant: input.merchant,
			sku: input.sku,
			payer: input.payer,
			channel: input.channel,
			priceDrops: prepared.priceDrops,
			previousDrops: previous,
			cumulativeDrops: cumulative,
			claimToken: await deterministicHex({ purpose: 'ap4m/paychan-claim-token/v1', root }),
			publicKey: claimKeys.publicKey,
			spendId: `ap4m-paychan-spend-${root.slice(0, 42)}`,
			spendDay: at.slice(0, 10),
			amountUsd: input.amountUsd,
			receiptId: `ap4m-paychan-receipt-${root.slice(0, 40)}`,
			retryMaterial: material,
			l3aDigest: lowerHex64(prepared.l3aDigest, 'L3a digest'),
			l3bDigest: lowerHex64(prepared.l3bDigest, 'L3b digest'),
			at,
		}, input.recoveryKek);
		if (reserved.outcome === 'mismatch') {
			throw new ChannelPurchaseStoreError('Idempotency key belongs to another purchase', 'STORE_CONFLICT');
		}
		if (reserved.outcome !== 'reserved' && reserved.outcome !== 'replay') {
			throw new ChannelPurchaseStoreError(
				reserved.outcome === 'spend-limit' ? 'AP4M spend limit was exceeded' : 'Channel purchase is in progress',
				reserved.outcome === 'spend-limit' ? 'SPEND_LIMIT' : 'STORE_CONFLICT',
			);
		}
		attempt = reserved.attempt;
	} else {
		if (!sameReplayIdentity(attempt, requestIdentity)) {
			throw new ChannelPurchaseStoreError('Idempotency key belongs to another purchase', 'STORE_CONFLICT');
		}
		if (attempt.status !== 'merchant_accepted') {
			material = await dependencies.purchaseStore.readRetryMaterial(
				input.mandateId, input.idempotencyKey, input.recoveryKek,
			);
		}
	}

	let proof: ChannelClaimProof;
	let replayed = true;
	if (attempt.status === 'reserved') {
		const claimKeys = validatedClaimKeys(wrappedKeys, attempt.merchantId);
		if (claimKeys.publicKey !== attempt.publicKey) {
			throw new ChannelPurchaseStoreError('Merchant claim key changed after reservation', 'STORE_CONFLICT');
		}
		const issued: IssuedChannelClaim = await issueChannelClaim({
			identity: input.identity,
			merchantId: attempt.merchantId,
			channelId: attempt.channelId,
			payer: attempt.payer,
			channelAmountDrops: attempt.channelAmountDrops,
			priceDrops: attempt.priceDrops,
			idempotencyKey: attempt.idempotencyKey,
			token: attempt.claimToken,
			at: nowIso(dependencies),
			wrappedKeys: claimKeys.wrapped,
			kek: input.recoveryKek,
		}, { store: dependencies.claimStore, withSigner: dependencies.withSigner });
		proof = channelPaymentHeader(issued);
		replayed = issued.replayed;
		const signed = await dependencies.purchaseStore.markClaimSigned({
			mandateId: attempt.mandateId,
			idempotencyKey: attempt.idempotencyKey,
			proof,
			at: nowIso(dependencies),
		});
		if (signed.outcome !== 'transitioned' && signed.outcome !== 'replay') {
			throw new ChannelPurchaseStoreError('Signed claim could not be persisted', 'STORE_CONFLICT');
		}
		attempt = signed.attempt;
	} else {
		proof = proofFromAttempt(attempt);
	}

	if (attempt.status === 'claim_signed') {
		if (material === undefined) {
			throw new ChannelPurchaseStoreError('Channel retry material is missing', 'INVALID_DATA');
		}
		const merchantResponse = await input.exchange({
			trustedRegistryUrl: `${attempt.merchantSnapshot.base_url.replace(/\/+$/, '')}/resource/${encodeURIComponent(attempt.sku)}`,
			exchangeState: material.exchangeState,
			paymentHeader: proof,
			mastercardIntent: material.intent,
			viL1: material.viL1,
			viL2: material.viL2,
			viL3b: material.viL3b,
		});
		const accepted = await dependencies.purchaseStore.markMerchantAccepted({
			mandateId: attempt.mandateId,
			idempotencyKey: attempt.idempotencyKey,
			merchantResponse,
			at: nowIso(dependencies),
		});
		if (accepted.outcome !== 'transitioned' && accepted.outcome !== 'replay') {
			throw new ChannelPurchaseStoreError('Merchant acceptance could not be persisted', 'STORE_CONFLICT');
		}
		attempt = accepted.attempt;
	}
	const delivered = await dependencies.purchaseStore.markDelivered({
		mandateId: attempt.mandateId,
		idempotencyKey: attempt.idempotencyKey,
		at: nowIso(dependencies),
	});
	if (delivered.outcome !== 'transitioned' && delivered.outcome !== 'replay') {
		throw new ChannelPurchaseStoreError('Channel purchase could not be delivered', 'STORE_CONFLICT');
	}
	if (delivered.attempt.result === null) {
		throw new ChannelPurchaseStoreError('Delivered channel purchase has no result', 'INVALID_DATA');
	}
	return { result: delivered.attempt.result, proof, replayed };
}
