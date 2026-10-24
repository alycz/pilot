import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';
import { verifyPaymentChannelClaim, Wallet } from 'xrpl';

import {
	ChannelKeyError,
	withMandateClaimSigner,
	type MandateClaimSigner,
	type WrappedMandateClaimKeys,
} from '../src/exec/channel-keys';
import type { MandateKeyIdentity } from '../src/exec/mandate-keys';

const CHANNEL_ID = 'A'.repeat(64);
const MERCHANT_ID = 'venue-yield-desk';
const IDENTITY: MandateKeyIdentity = {
	principal: 'mh5-test-principal',
	owner: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
	network: 'testnet',
	mandateId: 'mandate-mh5',
};

async function wrappedClaimKey(): Promise<{
	wallet: Wallet;
	wrapped: WrappedMandateClaimKeys;
	kekBase64: string;
}> {
	const wallet = Wallet.generate();
	const rawKek = crypto.getRandomValues(new Uint8Array(32));
	const key = await crypto.subtle.importKey('raw', rawKek, 'AES-GCM', false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify([{
		merchant_id: MERCHANT_ID,
		seed: wallet.seed,
	}]));
	const aad = new TextEncoder().encode(JSON.stringify([
		IDENTITY.principal,
		IDENTITY.owner,
		IDENTITY.network,
		IDENTITY.mandateId,
		'claims',
	]));
	const ciphertext = await crypto.subtle.encrypt({
		name: 'AES-GCM',
		iv,
		additionalData: aad,
	}, key, plaintext);
	plaintext.fill(0);
	return {
		wallet,
		wrapped: {
			ciphertext,
			iv: Uint8Array.from(iv).buffer,
			publicKeys: [{ merchant_id: MERCHANT_ID, public_key: wallet.publicKey }],
		},
		kekBase64: Buffer.from(rawKek).toString('base64'),
	};
}

async function wrappedClaimKeyWithCryptoKey(): Promise<{
	wallet: Wallet;
	wrapped: WrappedMandateClaimKeys;
	kek: CryptoKey;
}> {
	const wallet = Wallet.generate();
	const kek = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify([{
		merchant_id: MERCHANT_ID,
		seed: wallet.seed,
	}]));
	const aad = new TextEncoder().encode(JSON.stringify([
		IDENTITY.principal,
		IDENTITY.owner,
		IDENTITY.network,
		IDENTITY.mandateId,
		'claims',
	]));
	const ciphertext = await crypto.subtle.encrypt({
		name: 'AES-GCM',
		iv,
		additionalData: aad,
	}, kek, plaintext);
	plaintext.fill(0);
	return {
		wallet,
		wrapped: {
			ciphertext,
			iv: Uint8Array.from(iv).buffer,
			publicKeys: [{ merchant_id: MERCHANT_ID, public_key: wallet.publicKey }],
		},
		kek,
	};
}

describe('MH5 KEK-wrapped claim signer', () => {
	it('exposes only the public signer boundary and emits a valid cumulative claim', async () => {
		const fixture = await wrappedClaimKey();
		const observed = await withMandateClaimSigner(
			IDENTITY,
			fixture.wrapped,
			MERCHANT_ID,
			fixture.kekBase64,
			async (signer) => ({
				keys: Object.keys(signer).sort(),
				publicKey: signer.publicKey,
				signature: signer.sign(CHANNEL_ID, '50000'),
			}),
		);
		expect(observed.keys).toEqual(['publicKey', 'sign']);
		expect(observed.publicKey).toBe(fixture.wallet.publicKey);
		expect(observed.signature).toMatch(/^[A-F0-9]+$/);
		expect(verifyPaymentChannelClaim(
			CHANNEL_ID,
			'0.05',
			observed.signature,
			observed.publicKey,
		)).toBe(true);
		expect(JSON.stringify(observed)).not.toContain(fixture.wallet.seed);
	});

	it('decrypts AWS-compatible ciphertext with a non-extractable AES-GCM CryptoKey', async () => {
		const fixture = await wrappedClaimKeyWithCryptoKey();
		expect(fixture.kek.extractable).toBe(false);
		expect(fixture.kek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
		expect(fixture.kek.usages).toContain('decrypt');
		const signature = await withMandateClaimSigner(
			IDENTITY,
			fixture.wrapped,
			MERCHANT_ID,
			fixture.kek,
			async (signer) => signer.sign(CHANNEL_ID, '50000'),
		);
		expect(verifyPaymentChannelClaim(
			CHANNEL_ID,
			'0.05',
			signature,
			fixture.wallet.publicKey,
		)).toBe(true);
	});

	it('binds ciphertext to the exact mandate identity and merchant', async () => {
		const fixture = await wrappedClaimKey();
		await expect(withMandateClaimSigner(
			{ ...IDENTITY, mandateId: 'mandate-other' },
			fixture.wrapped,
			MERCHANT_ID,
			fixture.kekBase64,
			async () => undefined,
		)).rejects.toMatchObject({ code: 'INVALID_WRAPPED_KEY' });
		await expect(withMandateClaimSigner(
			IDENTITY,
			fixture.wrapped,
			'venue-risk-oracle',
			fixture.kekBase64,
			async () => undefined,
		)).rejects.toMatchObject({ code: 'CLAIM_KEY_NOT_FOUND' });
	});

	it.each(['0', '01', '1.1', '1e6', '-1'])(
		'rejects malformed cumulative drops %s before signing',
		async (cumulativeDrops) => {
			const fixture = await wrappedClaimKey();
			await expect(withMandateClaimSigner(
				IDENTITY,
				fixture.wrapped,
				MERCHANT_ID,
				fixture.kekBase64,
				async (signer) => signer.sign(CHANNEL_ID, cumulativeDrops),
			)).rejects.toMatchObject({ code: 'SIGN_FAILED' });
		},
	);

	it('rejects an invalid KEK without exposing decryption details', async () => {
		const fixture = await wrappedClaimKey();
		await expect(withMandateClaimSigner(
			IDENTITY,
			fixture.wrapped,
			MERCHANT_ID,
			'not-a-kek',
			async () => undefined,
		)).rejects.toBeInstanceOf(ChannelKeyError);
	});

	it('retires a signer retained beyond its bounded callback', async () => {
		const fixture = await wrappedClaimKey();
		let retained: MandateClaimSigner | undefined;
		await withMandateClaimSigner(
			IDENTITY,
			fixture.wrapped,
			MERCHANT_ID,
			fixture.kekBase64,
			async (signer) => { retained = signer; },
		);
		expect(() => retained?.sign(CHANNEL_ID, '50000')).toThrowError(
			expect.objectContaining({ code: 'SIGN_FAILED' }),
		);
	});

	it('rejects an oversized decimal string before signing', async () => {
		const fixture = await wrappedClaimKey();
		await expect(withMandateClaimSigner(
			IDENTITY,
			fixture.wrapped,
			MERCHANT_ID,
			fixture.kekBase64,
			async (signer) => signer.sign(CHANNEL_ID, '9'.repeat(100_000)),
		)).rejects.toMatchObject({ code: 'SIGN_FAILED' });
	});
});
