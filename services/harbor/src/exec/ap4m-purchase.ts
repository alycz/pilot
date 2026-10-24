import {
	decode,
	deriveAddress,
	encodeForSigning,
	hashes,
	isValidClassicAddress,
	verifyKeypairSignature,
	type IssuedCurrencyAmount,
	type Payment,
	type Transaction,
} from 'xrpl';

import type { SignedTransaction } from './keys';
import type { ValidatedAp4mX402Challenge } from './ap4m-x402';
import type {
	Ap4mCompactJwtSigner,
	Ap4mL2Disclosures,
} from './ap4m-intent';

const UINT32_MAX = 0xffff_ffff;
const HASH = /^[A-F0-9]{64}$/;
const HEX = /^[A-F0-9]+$/;
const DROPS = /^(?:0|[1-9]\d*)$/;
const IOU_VALUE = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const CURRENCY = /^(?:[A-Za-z0-9?!@#$%&*<>(){}[\]|]{3}|[A-F0-9]{40})$/;
const MAX_LEDGER_WINDOW = 20;
const MAX_FEE_DROPS = 100n;
const KEK_BYTES = 32;
const MAX_WRAPPED_AGENT_KEY_BYTES = 8 * 1_024;

export interface Ap4mLedgerPreparation {
	sequence: number;
	validatedLedgerIndex: number;
	feeDrops: string;
}

export interface BuildAp4mPaymentInput {
	payer: string;
	challenge: ValidatedAp4mX402Challenge;
	credentialIds: readonly string[];
	intentId: string;
	l3aDigest: string;
	preparation: Ap4mLedgerPreparation;
}

export interface MandateAgentKeyIdentity {
	principal: string;
	owner: string;
	network: 'testnet';
	mandateId: string;
}

export interface WrappedMandateAgentKey {
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
	publicJwk: JsonWebKey;
}

export interface SelectAp4mL2Input {
	l2: string;
	merchantId: string;
	sku: string;
}

export class Ap4mPaymentError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_PAYMENT_CONTEXT'
			| 'CREDENTIAL_REQUIRED'
			| 'INVALID_LEDGER_PREPARATION'
			| 'INVALID_SIGNED_PAYMENT',
	) {
		super(message);
		this.name = 'Ap4mPaymentError';
	}
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 4_096) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 4_096));
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Ap4mPaymentError('The L2 presentation is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	const encoded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
	try {
		return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
	} catch {
		throw new Ap4mPaymentError('The L2 presentation is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
}

function disclosureValue(value: string): unknown {
	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
	} catch (error) {
		if (error instanceof Ap4mPaymentError) throw error;
		throw new Ap4mPaymentError('The L2 presentation is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	if (
		!Array.isArray(decoded) ||
		![2, 3].includes(decoded.length) ||
		typeof decoded[0] !== 'string'
	) {
		throw new Ap4mPaymentError('The L2 presentation is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	return decoded.at(-1);
}

/** Select only the four pinned public L2 disclosures required for split L3 minting. */
export function selectAp4mL2Disclosures(input: SelectAp4mL2Input): Ap4mL2Disclosures {
	if (
		new TextEncoder().encode(input.l2).byteLength > 16 * 1_024 ||
		!input.merchantId ||
		!input.sku
	) {
		throw new Ap4mPaymentError('The L2 presentation is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	const segments = input.l2.split('~');
	if (segments.at(-1) === '') segments.pop();
	const [baseJwt, ...disclosures] = segments;
	if (
		!baseJwt ||
		baseJwt.split('.').length !== 3 ||
		disclosures.length === 0 ||
		disclosures.length > 32
	) {
		throw new Ap4mPaymentError('The L2 presentation is invalid', 'INVALID_PAYMENT_CONTEXT');
	}

	const matches = {
		payment: [] as string[],
		merchant: [] as string[],
		checkout: [] as string[],
		item: [] as string[],
	};
	for (const disclosure of disclosures) {
		const value = disclosureValue(disclosure);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
		const record = value as Record<string, unknown>;
		if (record.vct === 'mandate.payment.open') matches.payment.push(disclosure);
		if (record.vct === 'mandate.checkout.open') matches.checkout.push(disclosure);
		if (record.id === input.merchantId) matches.merchant.push(disclosure);
		if (record.id === input.sku || record.sku === input.sku) matches.item.push(disclosure);
	}
	if (Object.values(matches).some((values) => values.length !== 1)) {
		throw new Ap4mPaymentError(
			'The L2 presentation does not contain the exact AP4M disclosure set',
			'INVALID_PAYMENT_CONTEXT',
		);
	}
	return {
		baseJwt,
		payment: matches.payment[0]!,
		merchant: matches.merchant[0]!,
		checkout: matches.checkout[0]!,
		item: matches.item[0]!,
	};
}

function publicAgentJwk(value: unknown): Readonly<{ kty: 'EC'; crv: 'P-256'; x: string; y: string }> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value)
	) {
		throw new Ap4mPaymentError('The mandate agent key is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	const jwk = value as JsonWebKey & Record<string, unknown>;
	if (
		jwk.kty !== 'EC' ||
		jwk.crv !== 'P-256' ||
		typeof jwk.x !== 'string' ||
		typeof jwk.y !== 'string' ||
		jwk.d !== undefined
	) {
		throw new Ap4mPaymentError('The mandate agent public key is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

function keyAdditionalData(identity: MandateAgentKeyIdentity): Uint8Array {
	if (
		!identity.principal ||
		!isValidClassicAddress(identity.owner) ||
		identity.network !== 'testnet' ||
		!identity.mandateId
	) {
		throw new Ap4mPaymentError('The mandate agent identity is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	return new TextEncoder().encode(
		JSON.stringify([
			identity.principal,
			identity.owner,
			identity.network,
			identity.mandateId,
			'agent',
		]),
	);
}

function validKek(key: CryptoKey): void {
	const algorithm = key.algorithm as { name?: unknown; length?: unknown };
	if (
		key.type !== 'secret' ||
		key.extractable ||
		algorithm.name !== 'AES-GCM' ||
		algorithm.length !== 256 ||
		!key.usages.includes('decrypt')
	) {
		throw new Ap4mPaymentError('The mandate KEK is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
}

async function importLegacyKek(value: string): Promise<CryptoKey> {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
		throw new Ap4mPaymentError('The mandate KEK is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	let raw: Uint8Array;
	try {
		raw = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
	} catch {
		throw new Ap4mPaymentError('The mandate KEK is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	if (raw.byteLength !== KEK_BYTES) {
		raw.fill(0);
		throw new Ap4mPaymentError('The mandate KEK is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	try {
		return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
	} finally {
		raw.fill(0);
	}
}

/**
 * Unwrap the mandate's ES256 agent key only for a narrow signing callback.
 * This matches the frozen MH2 AES-GCM AAD/ciphertext shape and accepts AWS-3's
 * cached non-extractable CryptoKey without changing any legacy public API.
 */
export async function withMandateAgentSigner<T>(
	identity: MandateAgentKeyIdentity,
	wrapped: WrappedMandateAgentKey,
	kek: CryptoKey | string,
	callback: (signer: Ap4mCompactJwtSigner) => Promise<T>,
): Promise<T> {
	const expectedPublic = publicAgentJwk(wrapped.publicJwk);
	const key = typeof kek === 'string' ? await importLegacyKek(kek) : kek;
	validKek(key);
	if (!(wrapped.iv instanceof ArrayBuffer) || wrapped.iv.byteLength !== 12) {
		throw new Ap4mPaymentError('The wrapped mandate key is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	if (
		!(wrapped.ciphertext instanceof ArrayBuffer) ||
		wrapped.ciphertext.byteLength < 17 ||
		wrapped.ciphertext.byteLength > MAX_WRAPPED_AGENT_KEY_BYTES
	) {
		throw new Ap4mPaymentError('The wrapped mandate key is invalid', 'INVALID_PAYMENT_CONTEXT');
	}
	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: new Uint8Array(wrapped.iv),
				additionalData: keyAdditionalData(identity),
			},
			key,
			wrapped.ciphertext,
		);
	} catch {
		throw new Ap4mPaymentError('The mandate agent key could not be unwrapped', 'INVALID_PAYMENT_CONTEXT');
	}
	const bytes = new Uint8Array(plaintext);
	let privateJwk: JsonWebKey;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new TypeError('invalid JWK');
		}
		privateJwk = parsed as JsonWebKey;
		if (
			privateJwk.kty !== expectedPublic.kty ||
			privateJwk.crv !== expectedPublic.crv ||
			privateJwk.x !== expectedPublic.x ||
			privateJwk.y !== expectedPublic.y ||
			typeof privateJwk.d !== 'string'
		) {
			throw new TypeError('public key mismatch');
		}
	} catch {
		throw new Ap4mPaymentError('The mandate agent key could not be unwrapped', 'INVALID_PAYMENT_CONTEXT');
	} finally {
		bytes.fill(0);
	}

	let privateKey: CryptoKey;
	try {
		privateKey = await crypto.subtle.importKey(
			'jwk',
			privateJwk,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign'],
		);
	} catch {
		throw new Ap4mPaymentError('The mandate agent key could not be imported', 'INVALID_PAYMENT_CONTEXT');
	}
	privateJwk.d = '';

	let active = true;
	const signer: Ap4mCompactJwtSigner = async (header, payload) => {
		if (!active) {
			throw new Ap4mPaymentError(
				'The mandate agent signer is no longer available',
				'INVALID_PAYMENT_CONTEXT',
			);
		}
		const protectedSegment = base64Url(
			new TextEncoder().encode(JSON.stringify(header)),
		);
		const payloadSegment = base64Url(
			new TextEncoder().encode(JSON.stringify(payload)),
		);
		const signingInput = `${protectedSegment}.${payloadSegment}`;
		const signature = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			privateKey,
			new TextEncoder().encode(signingInput),
		);
		return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
	};
	try {
		return await callback(signer);
	} finally {
		active = false;
	}
}

function uint32(value: number, field: string, positive = false): number {
	if (
		!Number.isInteger(value) ||
		value < (positive ? 1 : 0) ||
		value > UINT32_MAX
	) {
		throw new Ap4mPaymentError(`${field} is invalid`, 'INVALID_LEDGER_PREPARATION');
	}
	return value;
}

function encodeHex(value: string): string {
	return Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('').toUpperCase();
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('').toUpperCase();
}

function credentials(values: readonly string[]): string[] {
	if (
		values.length === 0 ||
		values.length > 8 ||
		new Set(values.map((value) => value.toUpperCase())).size !== values.length ||
		values.some((value) => !/^[A-Fa-f0-9]{64}$/.test(value))
	) {
		throw new Ap4mPaymentError(
			'An accepted, unexpired AP4M-Agent credential is required',
			'CREDENTIAL_REQUIRED',
		);
	}
	return values.map((value) => value.toUpperCase());
}

function issuedAmount(challenge: ValidatedAp4mX402Challenge): IssuedCurrencyAmount {
	if (
		!CURRENCY.test(challenge.currency) ||
		challenge.currency === 'XRP' ||
		!isValidClassicAddress(challenge.issuer) ||
		!IOU_VALUE.test(challenge.amount)
	) {
		throw new Ap4mPaymentError(
			'The AP4M issued-currency requirement is invalid',
			'INVALID_PAYMENT_CONTEXT',
		);
	}
	return {
		currency: challenge.currency,
		issuer: challenge.issuer,
		value: challenge.amount,
	};
}

/**
 * Build the only owner-independent payment MH4 may sign: a dedicated
 * Harbor-self Testnet payer paying one registry-bound stablecoin challenge.
 * Payment remains outside XRPL Permission Delegation.
 *
 * Field semantics: https://xrpl.org/docs/references/protocol/transactions/types/payment
 */
export async function buildAp4mExactPayment(
	input: BuildAp4mPaymentInput,
): Promise<Payment> {
	if (
		!isValidClassicAddress(input.payer) ||
		!isValidClassicAddress(input.challenge.payTo) ||
		input.challenge.network !== 'xrpl:1' ||
		input.challenge.scheme !== 'exact' ||
		!/^demo-intent-[0-9a-f-]{36}$/.test(input.intentId) ||
		!HASH.test(input.l3aDigest.toUpperCase())
	) {
		throw new Ap4mPaymentError(
			'The AP4M payment context is invalid',
			'INVALID_PAYMENT_CONTEXT',
		);
	}
	const sequence = uint32(input.preparation.sequence, 'sequence', true);
	const validatedLedger = uint32(
		input.preparation.validatedLedgerIndex,
		'validated ledger index',
		true,
	);
	if (
		!DROPS.test(input.preparation.feeDrops) ||
		BigInt(input.preparation.feeDrops) === 0n ||
		BigInt(input.preparation.feeDrops) > MAX_FEE_DROPS
	) {
		throw new Ap4mPaymentError(
			'The AP4M payment fee is invalid',
			'INVALID_LEDGER_PREPARATION',
		);
	}
	const lastLedgerSequence = validatedLedger + MAX_LEDGER_WINDOW;
	uint32(lastLedgerSequence, 'last ledger sequence', true);
	const memo = `ap4m/${input.intentId}/${input.l3aDigest.toLowerCase()}`;
	if (new TextEncoder().encode(memo).byteLength > 1_024) {
		throw new Ap4mPaymentError('The AP4M memo is invalid', 'INVALID_PAYMENT_CONTEXT');
	}

	return {
		TransactionType: 'Payment',
		Account: input.payer,
		Destination: input.challenge.payTo,
		Amount: issuedAmount(input.challenge),
		CredentialIDs: credentials(input.credentialIds),
		InvoiceID: await sha256Hex(input.challenge.invoiceId),
		...(input.challenge.sourceTag === undefined
			? {}
			: { SourceTag: uint32(input.challenge.sourceTag, 'source tag') }),
		...(input.challenge.destinationTag === undefined
			? {}
			: { DestinationTag: uint32(input.challenge.destinationTag, 'destination tag') }),
		Memos: [
			{
				Memo: {
					MemoType: encodeHex('ap4m'),
					MemoData: encodeHex(memo),
				},
			},
		],
		Fee: input.preparation.feeDrops,
		Sequence: sequence,
		LastLedgerSequence: lastLedgerSequence,
	};
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value !== 'object' || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, canonical(nested)]),
	);
}

function withoutSignatureFields(value: Record<string, unknown>): Record<string, unknown> {
	const { SigningPubKey: _publicKey, TxnSignature: _signature, ...unsigned } = value;
	return unsigned;
}

/**
 * Fail closed unless the signing adapter returns the exact expected Payment,
 * signed by the expected payer, with a locally-derived transaction hash.
 */
export function validateAp4mSignedPayment(
	value: SignedTransaction,
	expected: Payment,
): SignedTransaction {
	const hash = value.hash.toUpperCase();
	const txBlob = value.tx_blob.toUpperCase();
	if (
		!HASH.test(hash) ||
		!HEX.test(txBlob) ||
		txBlob.length === 0 ||
		txBlob.length % 2 !== 0 ||
		txBlob.length > 16 * 1_024
	) {
		throw new Ap4mPaymentError(
			'The AP4M signer returned invalid wire material',
			'INVALID_SIGNED_PAYMENT',
		);
	}
	let decoded: Record<string, unknown>;
	let derivedHash: string;
	try {
		decoded = decode(txBlob) as Record<string, unknown>;
		derivedHash = hashes.hashSignedTx(txBlob).toUpperCase();
	} catch {
		throw new Ap4mPaymentError(
			'The AP4M signer returned invalid wire material',
			'INVALID_SIGNED_PAYMENT',
		);
	}
	const signingPublicKey = decoded.SigningPubKey;
	const transactionSignature = decoded.TxnSignature;
	let signatureIsValid = false;
	if (
		typeof signingPublicKey === 'string' &&
		HEX.test(signingPublicKey) &&
		typeof transactionSignature === 'string' &&
		HEX.test(transactionSignature)
	) {
		try {
			signatureIsValid =
				deriveAddress(signingPublicKey) === expected.Account &&
				verifyKeypairSignature(
					encodeForSigning(decoded as Transaction),
					transactionSignature,
					signingPublicKey,
				);
		} catch {
			signatureIsValid = false;
		}
	}
	if (
		derivedHash !== hash ||
		!signatureIsValid ||
		JSON.stringify(canonical(withoutSignatureFields(decoded))) !==
			JSON.stringify(canonical(expected))
	) {
		throw new Ap4mPaymentError(
			'The AP4M signed transaction does not match the reserved payment',
			'INVALID_SIGNED_PAYMENT',
		);
	}
	return { hash, tx_blob: txBlob };
}
