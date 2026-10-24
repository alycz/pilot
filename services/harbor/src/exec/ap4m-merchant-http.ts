import {
	buildAp4mRetryHeaders,
	encodeAp4mT54PaymentSignature,
	type ValidatedAp4mX402Challenge,
	type ValidateAp4mX402ChallengeOptions,
	validateAp4mX402Challenge,
} from './ap4m-x402';
import { Ap4mMerchantSuccessSchema } from './ap4m-response';
import { validateAp4mSignedPayment } from './ap4m-purchase';
import type { SignedTransaction } from './keys';
import type { Payment } from 'xrpl';

const PAYMENT_REQUIRED_HEADER = 'payment-required';
export const AP4M_CHALLENGE_STATE_HEADER = 'x-ap4m-challenge-state';
const AP4M_CHALLENGE_STATE = /^[A-Za-z0-9_-]{43}$/;
const MAX_URL_BYTES = 2_048;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_BYTES = 64 * 1_024;
const MAX_BODY_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const WBA_CLOCK_SKEW_SECONDS = 5;
const encoder = new TextEncoder();

export type Ap4mMerchantSuccess = ReturnType<
	typeof Ap4mMerchantSuccessSchema.parse
>;

export interface Ap4mPaidRequestMaterial {
	signedPayment: SignedTransaction;
	expectedPayment: Payment;
	mastercardIntent: unknown;
	viL1: string;
	viL2: string;
	viL3b: string;
}

export interface Ap4mMerchantExchangeInput {
	/** A product URL derived from the trusted merchant registry, never request args. */
	trustedRegistryUrl: string;
	challenge: Omit<ValidateAp4mX402ChallengeOptions, 'requestUrl'>;
	preparePaidRequest(
		challenge: ValidatedAp4mX402Challenge,
		challengeState: string,
	): Promise<Ap4mPaidRequestMaterial>;
	timeoutMs?: number;
}

export interface Ap4mMerchantHttpDependencies {
	fetch: typeof fetch;
	/** Must return a fresh WBA-signed copy of the exact supplied request. */
	signWba(request: Request, phase: 'initial' | 'paid'): Promise<Request>;
	/** Injectable only for deterministic tests; defaults to the runtime clock. */
	now?: () => number;
}

export interface Ap4mMerchantExchangeResult {
	challenge: ValidatedAp4mX402Challenge;
	challengeState: string;
	merchantResponse: Ap4mMerchantSuccess;
	txHash: string;
}

export interface Ap4mMerchantRecoveryInput {
	/** The same trusted registry URL used for the original 402 exchange. */
	trustedRegistryUrl: string;
	/** The validated challenge persisted from the original exchange. */
	challenge: ValidatedAp4mX402Challenge;
	/** The exact opaque merchant state returned with that challenge. */
	challengeState: string;
	/** The exact signed material persisted before the ambiguous request. */
	paidRequest: Ap4mPaidRequestMaterial;
	/** The persisted transaction hash; must match the signed transaction. */
	txHash: string;
	timeoutMs?: number;
}

export class Ap4mMerchantHttpError extends Error {
	constructor(
		readonly code:
			| 'INVALID_CONFIGURATION'
			| 'WBA_SIGNING_FAILED'
			| 'MERCHANT_TIMEOUT'
			| 'MERCHANT_UNAVAILABLE'
			| 'INVALID_CHALLENGE_RESPONSE'
			| 'INVALID_PAYMENT_MATERIAL'
			| 'INVALID_MERCHANT_RESPONSE'
			| 'SETTLEMENT_UNKNOWN',
		readonly phase: 'pre-payment' | 'post-payment',
	) {
		super(code);
		this.name = 'Ap4mMerchantHttpError';
	}

	get settlementUnknown(): boolean {
		return this.phase === 'post-payment';
	}
}

function fail(
	code: Ap4mMerchantHttpError['code'],
	phase: Ap4mMerchantHttpError['phase'],
): never {
	throw new Ap4mMerchantHttpError(code, phase);
}

function challengeState(
	value: string | null,
	phase: Ap4mMerchantHttpError['phase'],
): string {
	if (value === null || !AP4M_CHALLENGE_STATE.test(value)) {
		fail(
			phase === 'pre-payment' ? 'INVALID_CHALLENGE_RESPONSE' : 'SETTLEMENT_UNKNOWN',
			phase,
		);
	}
	return value;
}

function trustedUrl(value: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		encoder.encode(value).byteLength > MAX_URL_BYTES
	) {
		fail('INVALID_CONFIGURATION', 'pre-payment');
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail('INVALID_CONFIGURATION', 'pre-payment');
	}
	const loopback =
		url.hostname === '127.0.0.1' ||
		url.hostname === '[::1]' ||
		url.hostname === 'localhost';
	if (
		(url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
		url.username ||
		url.password ||
		url.hash ||
		url.href !== value
	) {
		fail('INVALID_CONFIGURATION', 'pre-payment');
	}
	return value;
}

function timeout(value: number | undefined): number {
	const parsed = value ?? DEFAULT_TIMEOUT_MS;
	if (
		!Number.isInteger(parsed) ||
		parsed < MIN_TIMEOUT_MS ||
		parsed > MAX_TIMEOUT_MS
	) {
		fail('INVALID_CONFIGURATION', 'pre-payment');
	}
	return parsed;
}

function headerBytes(headers: Headers): number {
	let count = 0;
	let bytes = 0;
	for (const [name, value] of headers) {
		count += 1;
		bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
		if (
			count > MAX_HEADER_COUNT ||
			bytes > MAX_HEADER_BYTES ||
			/[\r\n\0]/.test(name) ||
			/[\r\n\0]/.test(value)
		) {
			return -1;
		}
	}
	return bytes;
}

interface ValidatedWbaHeaders {
	tuple: string;
	nonce: string;
	signature: string;
}

function decodeCanonicalBase64(value: string, bytes: number): boolean {
	try {
		const decoded = atob(value);
		return decoded.length === bytes && btoa(decoded) === value;
	} catch {
		return false;
	}
}

function decodeCanonicalBase64Url(value: string, bytes: number): boolean {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
	try {
		const decoded = atob(padded);
		const canonical = btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
		return decoded.length === bytes && canonical === value;
	} catch {
		return false;
	}
}

function wbaTuple(
	request: Request,
	phase: 'initial' | 'paid',
	nowMs: number,
): ValidatedWbaHeaders {
	const fields = ['signature-agent', 'signature-input', 'signature'];
	const values = fields.map((name) => request.headers.get(name));
	if (
		values.some(
			(value) =>
				typeof value !== 'string' ||
				value.length === 0 ||
				value.includes(',') ||
				/[\r\n\0]/.test(value),
		)
	) {
		fail(
			phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN',
			phase === 'initial' ? 'pre-payment' : 'post-payment',
		);
	}
	const [agent, input, signatureHeader] = values as [string, string, string];
	const agentMatch = /^sig1="(https:\/\/[^"\\]+)"$/.exec(agent);
	const inputMatch = /^sig1=\("@authority" "@method" "@path" "signature-agent";key="sig1"\);created=(0|[1-9]\d{0,15});expires=(0|[1-9]\d{0,15});nonce="([A-Za-z0-9_-]+)";keyid="([A-Za-z0-9_-]+)";alg="ed25519";tag="web-bot-auth"$/.exec(input);
	const signatureMatch = /^sig1=:((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?):$/.exec(signatureHeader);
	let directory: URL | undefined;
	try {
		directory = agentMatch ? new URL(agentMatch[1]!) : undefined;
	} catch {
		directory = undefined;
	}
	const created = Number(inputMatch?.[1]);
	const expires = Number(inputMatch?.[2]);
	const nowSeconds = Math.floor(nowMs / 1_000);
	if (
		!directory ||
		directory.origin !== agentMatch?.[1] ||
		directory.pathname !== '/' ||
		directory.search ||
		directory.hash ||
		!inputMatch ||
		!Number.isSafeInteger(created) ||
		!Number.isSafeInteger(expires) ||
		!Number.isFinite(nowMs) ||
		nowMs < 0 ||
		created < nowSeconds - WBA_CLOCK_SKEW_SECONDS ||
		created > nowSeconds + WBA_CLOCK_SKEW_SECONDS ||
		expires - created !== 60 ||
		!decodeCanonicalBase64Url(inputMatch[3]!, 64) ||
		!decodeCanonicalBase64Url(inputMatch[4]!, 32) ||
		!signatureMatch ||
		!decodeCanonicalBase64(signatureMatch[1]!, 64)
	) {
		fail(
			phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN',
			phase === 'initial' ? 'pre-payment' : 'post-payment',
		);
	}
	return {
		tuple: values.join('\n'),
		nonce: inputMatch[3]!,
		signature: signatureMatch[1]!,
	};
}

function exactRequest(
	actual: Request,
	expected: Request,
	phase: 'initial' | 'paid',
	nowMs: number,
): ValidatedWbaHeaders {
	const errorPhase = phase === 'initial' ? 'pre-payment' : 'post-payment';
	if (
		actual.url !== expected.url ||
		actual.method !== 'GET' ||
		actual.redirect !== 'manual' ||
		actual.body !== null ||
		headerBytes(actual.headers) < 0
	) {
		fail(phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN', errorPhase);
	}
	for (const [name, value] of expected.headers) {
		if (actual.headers.get(name) !== value) {
			fail(phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN', errorPhase);
		}
	}
	const allowed = new Set([
		...expected.headers.keys(),
		'signature-agent',
		'signature-input',
		'signature',
	]);
	if ([...actual.headers.keys()].some((name) => !allowed.has(name))) {
		fail(phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN', errorPhase);
	}
	return wbaTuple(actual, phase, nowMs);
}

async function signedRequest(
	request: Request,
	phase: 'initial' | 'paid',
	signWba: Ap4mMerchantHttpDependencies['signWba'],
	now: () => number,
): Promise<{ request: Request; wba: ValidatedWbaHeaders }> {
	let signed: Request;
	try {
		signed = await signWba(request.clone(), phase);
	} catch {
		fail(
			phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN',
			phase === 'initial' ? 'pre-payment' : 'post-payment',
		);
	}
	let nowMs: number;
	try {
		nowMs = now();
	} catch {
		fail(
			phase === 'initial' ? 'WBA_SIGNING_FAILED' : 'SETTLEMENT_UNKNOWN',
			phase === 'initial' ? 'pre-payment' : 'post-payment',
		);
	}
	return {
		request: signed,
		wba: exactRequest(signed, request, phase, nowMs),
	};
}

async function fetchBounded(
	request: Request,
	deps: Ap4mMerchantHttpDependencies,
	timeoutMs: number,
	phase: 'pre-payment' | 'post-payment',
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await deps.fetch(
			new Request(request, { signal: controller.signal, redirect: 'manual' }),
		);
		if (headerBytes(response.headers) < 0) {
			fail(
				phase === 'pre-payment' ? 'INVALID_CHALLENGE_RESPONSE' : 'SETTLEMENT_UNKNOWN',
				phase,
			);
		}
		return response;
	} catch (error) {
		if (error instanceof Ap4mMerchantHttpError) throw error;
		if (phase === 'post-payment') fail('SETTLEMENT_UNKNOWN', phase);
		fail(controller.signal.aborted ? 'MERCHANT_TIMEOUT' : 'MERCHANT_UNAVAILABLE', phase);
	} finally {
		clearTimeout(timer);
	}
}

async function boundedJson(response: Response, timeoutMs: number): Promise<unknown> {
	const contentLength = response.headers.get('content-length');
	if (
		contentLength !== null &&
		(!/^(?:0|[1-9]\d*)$/.test(contentLength) || BigInt(contentLength) > MAX_BODY_BYTES)
	) {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
	if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
	if (response.body === null) fail('SETTLEMENT_UNKNOWN', 'post-payment');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		void reader.cancel();
	}, timeoutMs);
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel();
				fail('SETTLEMENT_UNKNOWN', 'post-payment');
			}
			chunks.push(value);
		}
		if (expired) fail('SETTLEMENT_UNKNOWN', 'post-payment');
	} catch (error) {
		if (error instanceof Ap4mMerchantHttpError) throw error;
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	} finally {
		clearTimeout(timer);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
		return JSON.parse(text) as unknown;
	} catch {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
}

/**
 * Execute exactly one WBA-authenticated 402 challenge followed by one freshly
 * WBA-authenticated paid retry. Any ambiguity after a persisted transaction
 * hash is returned is conservatively classified as settlement-unknown.
 */
export async function exchangeAp4mMerchant(
	input: Ap4mMerchantExchangeInput,
	deps: Ap4mMerchantHttpDependencies,
): Promise<Ap4mMerchantExchangeResult> {
	const url = trustedUrl(input.trustedRegistryUrl);
	const timeoutMs = timeout(input.timeoutMs);
	const now = deps.now ?? Date.now;
	const initial = new Request(url, {
		method: 'GET',
		headers: { accept: 'application/json' },
		redirect: 'manual',
	});
	const signedInitial = await signedRequest(initial, 'initial', deps.signWba, now);
	const challengeResponse = await fetchBounded(
		signedInitial.request,
		deps,
		timeoutMs,
		'pre-payment',
	);
	if (challengeResponse.status !== 402) {
		await challengeResponse.body?.cancel().catch(() => undefined);
		fail('INVALID_CHALLENGE_RESPONSE', 'pre-payment');
	}
	const paymentRequired = challengeResponse.headers.get(PAYMENT_REQUIRED_HEADER);
	const state = challengeState(
		challengeResponse.headers.get(AP4M_CHALLENGE_STATE_HEADER),
		'pre-payment',
	);
	await challengeResponse.body?.cancel().catch(() => undefined);
	if (paymentRequired === null || paymentRequired.includes(',')) {
		fail('INVALID_CHALLENGE_RESPONSE', 'pre-payment');
	}
	let challenge: ValidatedAp4mX402Challenge;
	try {
		challenge = validateAp4mX402Challenge(paymentRequired, {
			...input.challenge,
			requestUrl: url,
		});
	} catch {
		fail('INVALID_CHALLENGE_RESPONSE', 'pre-payment');
	}

	let paid: Ap4mPaidRequestMaterial;
	try {
		paid = await input.preparePaidRequest(challenge, state);
	} catch {
		fail('INVALID_PAYMENT_MATERIAL', 'pre-payment');
	}
	let signedPayment: SignedTransaction;
	try {
		signedPayment = validateAp4mSignedPayment(
			paid.signedPayment,
			paid.expectedPayment,
		);
	} catch {
		fail('INVALID_PAYMENT_MATERIAL', 'pre-payment');
	}

	let paidHeaders: Headers;
	try {
		const paymentSignature = encodeAp4mT54PaymentSignature({
			challenge,
			signedTxBlob: signedPayment.tx_blob,
		});
		paidHeaders = buildAp4mRetryHeaders(
			{ accept: 'application/json' },
			{
				paymentSignature,
				mastercardIntent: paid.mastercardIntent,
				viL1: paid.viL1,
				viL2: paid.viL2,
				viL3b: paid.viL3b,
			},
		);
		paidHeaders.set(AP4M_CHALLENGE_STATE_HEADER, state);
	} catch {
		fail('INVALID_PAYMENT_MATERIAL', 'pre-payment');
	}
	const retry = new Request(url, {
		method: 'GET',
		headers: paidHeaders,
		redirect: 'manual',
	});
	const signedPaid = await signedRequest(retry, 'paid', deps.signWba, now);
	if (
		signedPaid.wba.nonce === signedInitial.wba.nonce ||
		signedPaid.wba.signature === signedInitial.wba.signature ||
		signedPaid.wba.tuple === signedInitial.wba.tuple
	) {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
	const paidResponse = await fetchBounded(
		signedPaid.request,
		deps,
		timeoutMs,
		'post-payment',
	);
	if (paidResponse.status !== 200) {
		await paidResponse.body?.cancel().catch(() => undefined);
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
	const raw = await boundedJson(paidResponse, timeoutMs);
	let merchantResponse: Ap4mMerchantSuccess;
	try {
		merchantResponse = Ap4mMerchantSuccessSchema.parse(raw);
	} catch {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
	return {
		challenge,
		challengeState: state,
		merchantResponse,
		txHash: signedPayment.hash,
	};
}

/**
 * Retry the exact paid request persisted after an ambiguous response. This is
 * deliberately not a second exchange: it never requests or accepts a fresh
 * 402 challenge, and it sends exactly one request carrying the original opaque
 * merchant state and signed transaction.
 */
export async function recoverAp4mMerchant(
	input: Ap4mMerchantRecoveryInput,
	deps: Ap4mMerchantHttpDependencies,
): Promise<Ap4mMerchantSuccess> {
	const url = trustedUrl(input.trustedRegistryUrl);
	const timeoutMs = timeout(input.timeoutMs);
	const now = deps.now ?? Date.now;
	const state = challengeState(input.challengeState, 'post-payment');
	if (
		input.challenge.resource.url !== url ||
		typeof input.txHash !== 'string' ||
		!/^[A-F0-9]{64}$/.test(input.txHash)
	) {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}

	let signedPayment: SignedTransaction;
	let paidHeaders: Headers;
	try {
		signedPayment = validateAp4mSignedPayment(
			input.paidRequest.signedPayment,
			input.paidRequest.expectedPayment,
		);
		if (signedPayment.hash !== input.txHash) {
			fail('SETTLEMENT_UNKNOWN', 'post-payment');
		}
		paidHeaders = buildAp4mRetryHeaders(
			{ accept: 'application/json' },
			{
				paymentSignature: encodeAp4mT54PaymentSignature({
					challenge: input.challenge,
					signedTxBlob: signedPayment.tx_blob,
				}),
				mastercardIntent: input.paidRequest.mastercardIntent,
				viL1: input.paidRequest.viL1,
				viL2: input.paidRequest.viL2,
				viL3b: input.paidRequest.viL3b,
			},
		);
		paidHeaders.set(AP4M_CHALLENGE_STATE_HEADER, state);
	} catch (error) {
		if (error instanceof Ap4mMerchantHttpError) throw error;
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}

	const retry = new Request(url, {
		method: 'GET',
		headers: paidHeaders,
		redirect: 'manual',
	});
	const signedPaid = await signedRequest(retry, 'paid', deps.signWba, now);
	const paidResponse = await fetchBounded(
		signedPaid.request,
		deps,
		timeoutMs,
		'post-payment',
	);
	if (paidResponse.status !== 200) {
		await paidResponse.body?.cancel().catch(() => undefined);
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
	const raw = await boundedJson(paidResponse, timeoutMs);
	try {
		return Ap4mMerchantSuccessSchema.parse(raw);
	} catch {
		fail('SETTLEMENT_UNKNOWN', 'post-payment');
	}
}
