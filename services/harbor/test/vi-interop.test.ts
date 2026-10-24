import { beforeAll, describe, expect, it } from 'vitest';

import referenceFixture from './fixtures/vi-reference-v0.1.json';
import ap4mFixture from './fixtures/vi-ap4m-reference-v0.1.json';
import { assertAp4mReferenceProjection, ViVerificationError, verifyAp4mReferenceViChain, verifyLegacyDirectViChain, verifyReferenceViChain, viDigest } from '../src/exec/mandate-vi';

type JsonObject = Record<string, unknown>;

const now = new Date('2026-10-21T12:00:00.000Z');
const constraints = {
	currency: 'USD' as const,
	per_payment_max: '5',
	total_max: '25',
	daily_max: '10',
	payees: ['venue-yield-desk', 'risk-oracle'],
	skus: ['yield-report', 'risk-score'],
};

function encodeBase64Url(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeJson(value: JsonObject): string {
	return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateKey(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
	const keyPair = (await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	return {
		privateKey: keyPair.privateKey,
		publicJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
	};
}

async function signJwt(privateKey: CryptoKey, claims: JsonObject): Promise<string> {
	const protectedSegment = encodeJson({ alg: 'ES256', typ: 'JWT' });
	const payloadSegment = encodeJson(claims);
	const signingInput = `${protectedSegment}.${payloadSegment}`;
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

describe('Verifiable Intent L1/L2 interoperability', () => {
	let issuer: Awaited<ReturnType<typeof generateKey>>;
	let device: Awaited<ReturnType<typeof generateKey>>;
	let agent: Awaited<ReturnType<typeof generateKey>>;
	let l1: string;
	let l2: string;

	beforeAll(async () => {
		[issuer, device, agent] = await Promise.all([generateKey(), generateKey(), generateKey()]);
		l1 = await signJwt(issuer.privateKey, {
			iss: 'https://pilot.test/api/demo-network',
			sub: 'owner-hash',
			cnf: { jwk: device.publicJwk },
			of_verified: true,
			budget_account: 'rBudget11111111111111111111111111111',
			exp: Math.floor(Date.parse('2026-10-28T12:00:00.000Z') / 1_000),
		});
		l2 = await signJwt(device.privateKey, {
			iss: 'rBudget11111111111111111111111111111',
			execution_type: 'DEFERRED',
			cnf: { jwk: agent.publicJwk },
			constraints,
			exp: Math.floor(Date.parse('2026-10-22T12:00:00.000Z') / 1_000),
		});
	});

	it('verifies the reference-shaped ES256 L1 to L2 holder chain with Worker WebCrypto', async () => {
		const verified = await verifyLegacyDirectViChain({
			l1,
			l2,
			trustedIssuerJwk: issuer.publicJwk,
			expectedIssuer: 'https://pilot.test/api/demo-network',
			expectedAgentPublicJwk: agent.publicJwk as JsonObject,
			expectedConstraints: constraints,
			now,
		});

		expect(verified.l1Claims.of_verified).toBe(true);
		expect(verified.l2Claims.execution_type).toBe('DEFERRED');
		expect(verified.agentPublicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
		expect(verified.l1Digest).toBe(await viDigest(l1));
		expect(verified.l2Digest).toBe(await viDigest(l2));
	});

	it('rejects an altered L2 constraint even when the device signs it', async () => {
		const altered = await signJwt(device.privateKey, {
			iss: 'rBudget11111111111111111111111111111',
			execution_type: 'DEFERRED',
			cnf: { jwk: agent.publicJwk },
			constraints: { ...constraints, total_max: '2500' },
			exp: Math.floor(Date.parse('2026-10-22T12:00:00.000Z') / 1_000),
		});

		await expect(
			verifyLegacyDirectViChain({
				l1,
				l2: altered,
				trustedIssuerJwk: issuer.publicJwk,
				expectedAgentPublicJwk: agent.publicJwk as JsonObject,
				expectedConstraints: constraints,
				now,
			}),
		).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'CONSTRAINT_MISMATCH' });
	});

	it('rejects a payload changed after signing', async () => {
		const [header, payload, signature] = l2.split('.');
		const tamperedPayload = encodeJson({
			iss: 'attacker',
			cnf: { jwk: agent.publicJwk },
			constraints,
		});

		await expect(
			verifyLegacyDirectViChain({
				l1,
				l2: `${header}.${tamperedPayload}.${signature}`,
				trustedIssuerJwk: issuer.publicJwk,
				expectedAgentPublicJwk: agent.publicJwk as JsonObject,
				expectedConstraints: constraints,
				now,
			}),
		).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'INVALID_SIGNATURE' });
		expect(payload).toBeTruthy();
	});

	it('rejects an issuer outside the configured Demo Network trust root', async () => {
		await expect(
			verifyLegacyDirectViChain({
				l1,
				l2,
				trustedIssuerJwk: issuer.publicJwk,
				expectedIssuer: 'https://different-issuer.test',
				expectedAgentPublicJwk: agent.publicJwk as JsonObject,
				expectedConstraints: constraints,
				now,
			}),
		).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'ISSUER_MISMATCH' });
	});
});

describe('pinned Python VI v0.1.0 reference interoperability', () => {
	it('verifies a public-only fixture emitted by reference commit 1dc3d418', async () => {
		expect(referenceFixture.generated_by).toContain('Python 3.13');
		const verified = await verifyReferenceViChain({
			l1: referenceFixture.l1,
			l2: referenceFixture.l2,
			trustedIssuerJwk: referenceFixture.issuer_public_jwk,
			expectedAgentPublicJwk: referenceFixture.agent_public_jwk,
			now: new Date(referenceFixture.now),
		});
		expect(verified.l1Claims.vct).toBe('https://credentials.mastercard.com/card');
		expect(verified.l2Claims.delegate_payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ vct: 'mandate.checkout.open' }),
			expect.objectContaining({ vct: 'mandate.payment.open' }),
		]));
	});

	it('rejects an altered Python-reference disclosure', async () => {
		const parts = referenceFixture.l2.split('~');
		const disclosureIndex = parts.findIndex((part, index) => index > 0 && part.length > 2);
		parts[disclosureIndex] = `${parts[disclosureIndex]?.slice(0, -1)}${parts[disclosureIndex]?.endsWith('A') ? 'B' : 'A'}`;
		await expect(verifyReferenceViChain({
			l1: referenceFixture.l1,
			l2: parts.join('~'),
			trustedIssuerJwk: referenceFixture.issuer_public_jwk,
			expectedAgentPublicJwk: referenceFixture.agent_public_jwk,
			now: new Date(referenceFixture.now),
		})).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'INVALID_DISCLOSURE' });
	});
});

describe('operational AP4M projection from pinned VI v0.1.0', () => {
	const input = {
		l1: ap4mFixture.l1,
		l2: ap4mFixture.l2,
		trustedIssuerJwk: ap4mFixture.issuer_public_jwk,
		expectedAgentPublicJwk: ap4mFixture.agent_public_jwk,
		expectedConstraints: ap4mFixture.constraints,
		expectedOwner: ap4mFixture.owner,
		expectedIssuer: "Demo Network (Mastercard's role in production)",
		expectedIssuerKid: ap4mFixture.issuer_kid,
		expectedMandateId: ap4mFixture.mandate_id,
		expectedAudience: ap4mFixture.audience,
		notBefore: ap4mFixture.not_before,
		expiresAt: ap4mFixture.expires_at,
		now: new Date(ap4mFixture.now),
	};

	it('projects exact cents, daily pilot cap, payees, SKUs, recurrence, and payment reference', async () => {
		const verified = await verifyAp4mReferenceViChain(input);
		expect(verified.agentPublicJwk).toMatchObject(ap4mFixture.agent_public_jwk);
		expect(verified.l1Digest).toBe(await viDigest(ap4mFixture.l1));
	});

	it('rejects a valid alternate L1 when L2 sd_hash binds the original L1', async () => {
		await expect(verifyAp4mReferenceViChain({ ...input, l1: ap4mFixture.alternate_l1 })).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'INVALID_CLAIMS' });
	});

	it('rejects a nonce or audience outside the prepared Harbor registration', async () => {
		await expect(verifyAp4mReferenceViChain({ ...input, expectedMandateId: 'different-mandate' }))
			.rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'INVALID_CLAIMS' });
		await expect(verifyAp4mReferenceViChain({ ...input, expectedAudience: 'https://different-harbor.test' }))
			.rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'INVALID_CLAIMS' });
	});

	it('rejects an untrusted key id or private issuer key material', async () => {
		await expect(verifyAp4mReferenceViChain({ ...input, expectedIssuerKid: 'rotated-without-configuration' }))
			.rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'ISSUER_MISMATCH' });
		await expect(verifyAp4mReferenceViChain({
			...input,
			trustedIssuerJwk: { ...input.trustedIssuerJwk, d: 'must-not-be-accepted' },
		})).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'MALFORMED_TOKEN' });
	});

	async function claims() {
		return (await verifyReferenceViChain(input)).l2Claims;
	}

	async function expectProjectionFailure(mutate: (copy: JsonObject) => void, expected = input.expectedConstraints) {
		const copy = structuredClone(await claims());
		mutate(copy);
		await expect(assertAp4mReferenceProjection(input.l2, copy, { ...input, expectedConstraints: expected })).rejects.toMatchObject<Partial<ViVerificationError>>({ code: 'CONSTRAINT_MISMATCH' });
	}

	it('rejects unknown, duplicate, and missing constraints', async () => {
		await expectProjectionFailure((copy) => ((copy.delegate_payload as JsonObject[])[1]?.constraints as JsonObject[]).push({ type: 'payment.unknown' }));
		await expectProjectionFailure((copy) => {
			const list = (copy.delegate_payload as JsonObject[])[1]?.constraints as JsonObject[];
			list.push(structuredClone(list[0]));
		});
		await expectProjectionFailure((copy) => {
			const payment = (copy.delegate_payload as JsonObject[])[1] as JsonObject;
			payment.constraints = (payment.constraints as JsonObject[]).filter((item) => item.type !== 'payment.budget');
		});
	});

	it('rejects non-cent constraints and altered amount/daily values', async () => {
		await expectProjectionFailure(() => {}, { ...input.expectedConstraints, per_payment_max: '5.001' });
		await expectProjectionFailure((copy) => {
			const amount = ((copy.delegate_payload as JsonObject[])[1]?.constraints as JsonObject[]).find((item) => item.type === 'payment.amount');
			if (amount) amount.max = 501;
		});
		await expectProjectionFailure((copy) => {
			const budget = ((copy.delegate_payload as JsonObject[])[1]?.constraints as JsonObject[]).find((item) => item.type === 'payment.budget');
			if (budget) budget.pilot_daily_max = 1001;
		});
	});

	it('rejects altered payee, SKU, recurrence, instrument, and reference bindings', async () => {
		await expectProjectionFailure(() => {}, { ...input.expectedConstraints, payees: ['merchant-b'] });
		await expectProjectionFailure(() => {}, { ...input.expectedConstraints, skus: ['sku-b'] });
		await expectProjectionFailure((copy) => {
			const recurrence = ((copy.delegate_payload as JsonObject[])[1]?.constraints as JsonObject[]).find((item) => item.type === 'payment.agent_recurrence');
			if (recurrence) recurrence.end_date = '2026-10-23';
		});
		await expectProjectionFailure((copy) => { ((copy.delegate_payload as JsonObject[])[1] as JsonObject).payment_instrument = { type: 'card', id: 'secret' }; });
		await expectProjectionFailure((copy) => {
			const reference = ((copy.delegate_payload as JsonObject[])[1]?.constraints as JsonObject[]).find((item) => item.type === 'payment.reference');
			if (reference) reference.conditional_transaction_id = 'altered';
		});
	});
});
