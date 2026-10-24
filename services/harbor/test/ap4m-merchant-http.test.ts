import { describe, expect, it, vi } from 'vitest';
import { Wallet } from 'xrpl';

import {
	Ap4mMerchantHttpError,
	AP4M_CHALLENGE_STATE_HEADER,
	exchangeAp4mMerchant,
	recoverAp4mMerchant,
	type Ap4mMerchantHttpDependencies,
} from '../src/exec/ap4m-merchant-http';
import { buildAp4mExactPayment } from '../src/exec/ap4m-purchase';
import type { ValidatedAp4mX402Challenge } from '../src/exec/ap4m-x402';

const URL = 'https://merchant.example/resource/yield-report';
const MERCHANT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const CURRENCY = '524C555344000000000000000000000000000000';
const CREDENTIAL = 'B'.repeat(64);
const CHALLENGE_STATE = 'A'.repeat(43);
const payer = Wallet.generate();

function base64Json(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return btoa(String.fromCharCode(...bytes));
}

function challengeHeader(amount = '1'): string {
	return base64Json({
		x402Version: 2,
		resource: { url: URL },
		accepts: [{
			scheme: 'exact',
			network: 'xrpl:1',
			asset: CURRENCY,
			payTo: MERCHANT,
			amount,
			maxTimeoutSeconds: 60,
			extra: {
				areFeesSponsored: false,
				assetTransferMethod: 'sequence',
				invoiceId: 'invoice-1',
				issuer: ISSUER,
				sourceTag: 2_610_240,
			},
		}],
	});
}

const SUCCESS = {
	data: {
		schema_id: 'yield_report_v1' as const,
		venue: 'xrpl-amm',
		apr_percent: '4.25',
		tvl_usd: '2500000',
		risk: 'medium',
	},
	intent_validation: {
		intentId: 'demo-intent-00000000-0000-4000-8000-000000000004',
		validated: true,
		checks: {
			agent_identity: 'pass' as const,
			intent: 'pass' as const,
			payment: 'pass' as const,
			credential: 'pass' as const,
		},
		validation_errors: [],
	},
};

function input() {
	return {
		trustedRegistryUrl: URL,
		challenge: {
			network: 'testnet' as const,
			merchantPayTo: MERCHANT,
			expectedAsset: { currency: 'RLUSD', issuer: ISSUER },
			maxAmount: '1',
			expectedSourceTag: 2_610_240,
		},
		preparePaidRequest: vi.fn(async (challenge: ValidatedAp4mX402Challenge) => {
			const expectedPayment = await buildAp4mExactPayment({
				payer: payer.classicAddress,
				challenge,
				credentialIds: [CREDENTIAL],
				intentId: SUCCESS.intent_validation.intentId,
				l3aDigest: 'A'.repeat(64),
				preparation: {
					sequence: 7,
					validatedLedgerIndex: 1_000,
					feeDrops: '12',
				},
			});
			return {
				signedPayment: payer.sign(expectedPayment),
				expectedPayment,
				mastercardIntent: { intentId: SUCCESS.intent_validation.intentId },
				viL1: 'a.b.c',
				viL2: 'd.e.f~g',
				viL3b: 'h.i.j~k',
			};
		}),
	};
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

function addWba(headers: Headers, nonceIndex: number): void {
	const nonce = base64url(new Uint8Array(64).fill(nonceIndex));
	const keyid = base64url(new Uint8Array(32).fill(7));
	const signature = btoa(String.fromCharCode(...new Uint8Array(64).fill(nonceIndex + 10)));
	const created = 1_795_000_000 + nonceIndex;
	headers.set('signature-agent', 'sig1="https://agent.example"');
	headers.set(
		'signature-input',
		`sig1=("@authority" "@method" "@path" "signature-agent";key="sig1");created=${created};expires=${created + 60};nonce="${nonce}";keyid="${keyid}";alg="ed25519";tag="web-bot-auth"`,
	);
	headers.set('signature', `sig1=:${signature}:`);
}

function response(status: number, body?: unknown): Response {
	if (status === 402) {
		return new Response('', {
			status,
			headers: {
				'payment-required': challengeHeader(),
				'x-ap4m-challenge-state': CHALLENGE_STATE,
			},
		});
	}
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function dependencies(
	responses: Response[] = [response(402), response(200, SUCCESS)],
): Ap4mMerchantHttpDependencies & { seen: Request[] } {
	const seen: Request[] = [];
	let nonce = 0;
	return {
		seen,
		now: () => 1_795_000_001_000,
		signWba: vi.fn(async (request, phase) => {
			nonce += 1;
			const headers = new Headers(request.headers);
			addWba(headers, nonce);
			return new Request(request, { headers, redirect: 'manual' });
		}),
		fetch: vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
			const actual = new Request(request, init);
			seen.push(actual);
			const next = responses.shift();
			if (!next) throw new Error('unexpected fetch');
			return next;
		}) as typeof fetch,
	};
}

function caught(error: unknown): Ap4mMerchantHttpError {
	expect(error).toBeInstanceOf(Ap4mMerchantHttpError);
	return error as Ap4mMerchantHttpError;
}

describe('MH4 merchant HTTP exchange', () => {
	it('performs exactly one 402 request and one fresh WBA-signed paid retry', async () => {
		const deps = dependencies();
		const request = input();
		const result = await exchangeAp4mMerchant(request, deps);

		expect(result).toEqual({
			challenge: expect.objectContaining({ amount: '1', payTo: MERCHANT }),
			challengeState: CHALLENGE_STATE,
			merchantResponse: SUCCESS,
			txHash: expect.stringMatching(/^[A-F0-9]{64}$/),
		});
		expect(request.preparePaidRequest).toHaveBeenCalledTimes(1);
		expect(deps.signWba).toHaveBeenCalledTimes(2);
		expect(deps.seen).toHaveLength(2);
		expect(deps.seen.map((item) => [item.method, item.url, item.body])).toEqual([
			['GET', URL, null],
			['GET', URL, null],
		]);
		expect(deps.seen[0]?.headers.has('payment-signature')).toBe(false);
		expect(deps.seen[1]?.headers.get('payment-signature')).toMatch(/^[A-Za-z0-9+/]+=*$/);
		const paidEnvelope = JSON.parse(
			atob(deps.seen[1]?.headers.get('payment-signature') ?? ''),
		) as {
			accepted: { amount: string };
			payload: { signedTxBlob: string };
		};
		const material = await request.preparePaidRequest.mock.results[0]!.value;
		expect(paidEnvelope.accepted.amount).toBe('1');
		expect(paidEnvelope.payload.signedTxBlob).toBe(material.signedPayment.tx_blob);
		expect(deps.seen[1]?.headers.get('x-mastercard-intent')).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(deps.seen[1]?.headers.get(AP4M_CHALLENGE_STATE_HEADER)).toBe(CHALLENGE_STATE);
		expect(deps.seen[1]?.headers.get('x-vi-l1')).toBe('a.b.c');
		expect(deps.seen[1]?.headers.get('signature-input')).toContain('created=1795000002');
	});

	it('rejects non-registry-safe URLs and malformed challenges before payment preparation', async () => {
		const deps = dependencies([new Response('', { status: 402 })]);
		const invalid = input();
		invalid.trustedRegistryUrl = 'http://merchant.example/resource';
		await expect(exchangeAp4mMerchant(invalid, deps)).rejects.toMatchObject({
			code: 'INVALID_CONFIGURATION',
			phase: 'pre-payment',
			settlementUnknown: false,
		});

		const missing = input();
		await expect(exchangeAp4mMerchant(missing, deps)).rejects.toMatchObject({
			code: 'INVALID_CHALLENGE_RESPONSE',
			phase: 'pre-payment',
			settlementUnknown: false,
		});
		expect(missing.preparePaidRequest).not.toHaveBeenCalled();

	});

	it('requires one canonical bounded merchant challenge-state handle', async () => {
		for (const state of [null, 'short', `${'A'.repeat(42)}=`, 'A'.repeat(44)]) {
			const headers = new Headers({ 'payment-required': challengeHeader() });
			if (state !== null) headers.set(AP4M_CHALLENGE_STATE_HEADER, state);
			const request = input();
			await expect(
				exchangeAp4mMerchant(
					request,
					dependencies([new Response('', { status: 402, headers })]),
				),
			).rejects.toMatchObject({
				code: 'INVALID_CHALLENGE_RESPONSE',
				phase: 'pre-payment',
			});
			expect(request.preparePaidRequest).not.toHaveBeenCalled();
		}

		const duplicateHeaders = new Headers({
			'payment-required': challengeHeader(),
		});
		duplicateHeaders.append(AP4M_CHALLENGE_STATE_HEADER, CHALLENGE_STATE);
		duplicateHeaders.append(AP4M_CHALLENGE_STATE_HEADER, 'B'.repeat(43));
		await expect(
			exchangeAp4mMerchant(
				input(),
				dependencies([new Response('', { status: 402, headers: duplicateHeaders })]),
			),
		).rejects.toMatchObject({
			code: 'INVALID_CHALLENGE_RESPONSE',
			phase: 'pre-payment',
		});
	});

	it('accepts a challenge amount below the registry price and binds that exact amount', async () => {
		const discounted = input();
		const discountedDeps = dependencies([
			new Response('', {
				status: 402,
				headers: {
					'payment-required': challengeHeader('0.5'),
					'x-ap4m-challenge-state': CHALLENGE_STATE,
				},
			}),
			response(200, SUCCESS),
		]);
		const result = await exchangeAp4mMerchant(discounted, discountedDeps);
		expect(result.challenge.amount).toBe('0.5');
		expect(discounted.preparePaidRequest).toHaveBeenCalledWith(
			expect.objectContaining({ amount: '0.5' }),
			CHALLENGE_STATE,
		);
		const envelope = JSON.parse(
			atob(discountedDeps.seen[1]?.headers.get('payment-signature') ?? ''),
		) as { accepted: { amount: string } };
		expect(envelope.accepted.amount).toBe('0.5');
	});

	it('fails closed if WBA changes method, URL, body, or protected headers', async () => {
		const deps = dependencies();
		deps.signWba = vi.fn(async (request) => {
			const headers = new Headers(request.headers);
			addWba(headers, 1);
			return new Request('https://other.example/', {
				method: 'GET', headers, redirect: 'manual',
			});
		});
		await expect(exchangeAp4mMerchant(input(), deps)).rejects.toMatchObject({
			code: 'WBA_SIGNING_FAILED',
			phase: 'pre-payment',
		});

		const injected = dependencies();
		injected.signWba = vi.fn(async (request) => {
			const headers = new Headers(request.headers);
			addWba(headers, 1);
			headers.set('payment-signature', 'smuggled');
			return new Request(request, { headers, redirect: 'manual' });
		});
		await expect(exchangeAp4mMerchant(input(), injected)).rejects.toMatchObject({
			code: 'WBA_SIGNING_FAILED',
			phase: 'pre-payment',
		});
	});

	it('classifies transport and response ambiguity after a tx hash as settlement unknown', async () => {
		const deps = dependencies([response(402)]);
		deps.fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
			const actual = new Request(request, init);
			deps.seen.push(actual);
			if (deps.seen.length === 1) return response(402);
			throw new TypeError('private upstream detail');
		}) as typeof fetch;
		let error: unknown;
		try {
			await exchangeAp4mMerchant(input(), deps);
		} catch (caughtError) {
			error = caughtError;
		}
		const parsed = caught(error);
		expect(parsed).toMatchObject({
			message: 'SETTLEMENT_UNKNOWN',
			code: 'SETTLEMENT_UNKNOWN',
			phase: 'post-payment',
			settlementUnknown: true,
		});
		expect(parsed.message).not.toContain('private upstream detail');

		await expect(
			exchangeAp4mMerchant(input(), dependencies([response(402), response(200, { data: 'bad' })])),
		).rejects.toMatchObject({
			code: 'SETTLEMENT_UNKNOWN',
			phase: 'post-payment',
		});
	});

	it('recovers with exactly one paid request and never acquires a fresh challenge', async () => {
		const originalInput = input();
		const original = await exchangeAp4mMerchant(originalInput, dependencies());
		const paidRequest = await originalInput.preparePaidRequest.mock.results[0]!.value;
		const recoveryDeps = dependencies([response(200, SUCCESS)]);

		await expect(recoverAp4mMerchant({
			trustedRegistryUrl: URL,
			challenge: original.challenge,
			challengeState: original.challengeState,
			paidRequest,
			txHash: original.txHash,
		}, recoveryDeps)).resolves.toEqual(SUCCESS);

		expect(recoveryDeps.seen).toHaveLength(1);
		expect(recoveryDeps.signWba).toHaveBeenCalledTimes(1);
		expect(recoveryDeps.seen[0]?.headers.get(AP4M_CHALLENGE_STATE_HEADER)).toBe(
			CHALLENGE_STATE,
		);
		expect(recoveryDeps.seen[0]?.headers.has('payment-signature')).toBe(true);
	});

	it('fails recovery closed when persisted state or transaction binding changes', async () => {
		const originalInput = input();
		const original = await exchangeAp4mMerchant(originalInput, dependencies());
		const paidRequest = await originalInput.preparePaidRequest.mock.results[0]!.value;
		for (const changed of [
			{ challengeState: 'bad' },
			{ txHash: 'F'.repeat(64) },
			{ trustedRegistryUrl: 'https://merchant.example/resource/other' },
		]) {
			const recoveryDeps = dependencies([response(200, SUCCESS)]);
			await expect(recoverAp4mMerchant({
				trustedRegistryUrl: URL,
				challenge: original.challenge,
				challengeState: original.challengeState,
				paidRequest,
				txHash: original.txHash,
				...changed,
			}, recoveryDeps)).rejects.toMatchObject({
				code: 'SETTLEMENT_UNKNOWN',
				phase: 'post-payment',
			});
			expect(recoveryDeps.seen).toHaveLength(0);
		}
	});

	it('requires a fresh WBA signature for the paid retry', async () => {
		const deps = dependencies();
		deps.signWba = vi.fn(async (request) => {
			const headers = new Headers(request.headers);
			addWba(headers, 1);
			return new Request(request, { headers, redirect: 'manual' });
		});
		await expect(exchangeAp4mMerchant(input(), deps)).rejects.toMatchObject({
			code: 'SETTLEMENT_UNKNOWN',
			phase: 'post-payment',
		});
	});

	it('requires the exact MH6 WBA coverage and bounded signature parameters', async () => {
		const deps = dependencies();
		deps.signWba = vi.fn(async (request) => {
			const headers = new Headers(request.headers);
			addWba(headers, 1);
			headers.set(
				'signature-input',
				(headers.get('signature-input') ?? '').replace('"@path" ', ''),
			);
			return new Request(request, { headers, redirect: 'manual' });
		});
		await expect(exchangeAp4mMerchant(input(), deps)).rejects.toMatchObject({
			code: 'WBA_SIGNING_FAILED',
			phase: 'pre-payment',
		});

		const stale = dependencies();
		stale.now = () => 1_795_000_100_000;
		await expect(exchangeAp4mMerchant(input(), stale)).rejects.toMatchObject({
			code: 'WBA_SIGNING_FAILED',
			phase: 'pre-payment',
		});
	});

	it('derives the payment envelope and hash only from the exact signed Payment', async () => {
		const request = input();
		const original = request.preparePaidRequest;
		request.preparePaidRequest = vi.fn(async (challenge) => {
			const material = await original(challenge);
			return {
				...material,
				expectedPayment: {
					...material.expectedPayment,
					Destination: payer.classicAddress,
				},
			};
		});
		await expect(exchangeAp4mMerchant(request, dependencies())).rejects.toMatchObject({
			code: 'INVALID_PAYMENT_MATERIAL',
			phase: 'pre-payment',
		});
	});

	it('allows HTTP only on the local store profile, excluding 127.0.0.2', async () => {
		const request = input();
		request.trustedRegistryUrl = 'http://127.0.0.2:8794/resource/yield-report';
		await expect(exchangeAp4mMerchant(request, dependencies())).rejects.toMatchObject({
			code: 'INVALID_CONFIGURATION',
			phase: 'pre-payment',
		});

		for (const localUrl of [
			'http://127.0.0.1:8794/resource/yield-report',
			'http://[::1]:8794/resource/yield-report',
			'http://localhost:8794/resource/yield-report',
		]) {
			const local = input();
			local.trustedRegistryUrl = localUrl;
			await expect(
				exchangeAp4mMerchant(
					local,
					dependencies([new Response('', { status: 500 })]),
				),
			).rejects.toMatchObject({
				code: 'INVALID_CHALLENGE_RESPONSE',
				phase: 'pre-payment',
			});
		}
	});

	it('bounds paid response bodies before parsing', async () => {
		const huge = new Response(`{"padding":"${'x'.repeat(70 * 1_024)}"}`, {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
		await expect(
			exchangeAp4mMerchant(input(), dependencies([response(402), huge])),
		).rejects.toMatchObject({
			code: 'SETTLEMENT_UNKNOWN',
			phase: 'post-payment',
		});

		const stalled = new Response(new ReadableStream<Uint8Array>({
			start() {},
		}), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
		await expect(
			exchangeAp4mMerchant(
				{ ...input(), timeoutMs: 100 },
				dependencies([response(402), stalled]),
			),
		).rejects.toMatchObject({
			code: 'SETTLEMENT_UNKNOWN',
			phase: 'post-payment',
		});
	});
});
