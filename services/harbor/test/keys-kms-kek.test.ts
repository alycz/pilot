import { isValidClassicAddress } from 'xrpl';
import { describe, expect, it, vi } from 'vitest';

import {
	createWrappedDelegateKeyWithCryptoKey,
	DelegateKeyError,
	type DelegateIdentity,
	type DelegateWallet,
	withDelegateSignerWithCryptoKey,
} from '../src/exec/keys';

const identity: DelegateIdentity = {
	principal: 'kms-kek-owner',
	owner: 'rBudgetAccount',
	network: 'testnet',
};

async function aesGcmKey(
	usages: Array<'encrypt' | 'decrypt'>,
	extractable = false,
): Promise<CryptoKey> {
	return crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 },
		extractable,
		usages,
	) as Promise<CryptoKey>;
}

describe('KMS KEK CryptoKey integration seam', () => {
	it('round-trips with one non-extractable AES-GCM CryptoKey', async () => {
		const kek = await aesGcmKey(['encrypt', 'decrypt']);
		const exportKey = vi.spyOn(crypto.subtle, 'exportKey');

		try {
			const wrapped = await createWrappedDelegateKeyWithCryptoKey(identity, kek);
			const result = await withDelegateSignerWithCryptoKey(
				identity,
				wrapped,
				kek,
				(signer) => ({ address: signer.address, publicKey: signer.publicKey }),
			);

			expect(kek.extractable).toBe(false);
			expect(kek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
			expect(result).toEqual({
				address: wrapped.address,
				publicKey: wrapped.publicKey,
			});
			expect(isValidClassicAddress(result.address)).toBe(true);
			expect(exportKey).not.toHaveBeenCalled();
		} finally {
			exportKey.mockRestore();
		}
	});

	it('rejects extractable, wrong-algorithm, and missing-usage keys', async () => {
		const extractable = await aesGcmKey(['encrypt', 'decrypt'], true);
		const decryptOnly = await aesGcmKey(['decrypt']);
		const shortAesKey = await crypto.subtle.generateKey(
			{ name: 'AES-GCM', length: 128 },
			false,
			['encrypt'],
		) as CryptoKey;
		const hmac = await crypto.subtle.generateKey(
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			false,
			['sign'],
		) as CryptoKey;

		for (const key of [extractable, decryptOnly, shortAesKey, hmac]) {
			await expect(
				createWrappedDelegateKeyWithCryptoKey(identity, key),
			).rejects.toMatchObject<Partial<DelegateKeyError>>({ code: 'INVALID_KEK' });
		}

		const wrappingKey = await aesGcmKey(['encrypt', 'decrypt']);
		const wrapped = await createWrappedDelegateKeyWithCryptoKey(identity, wrappingKey);
		const encryptOnly = await aesGcmKey(['encrypt']);
		await expect(
			withDelegateSignerWithCryptoKey(
				identity,
				wrapped,
				encryptOnly,
				() => 'not reached',
			),
		).rejects.toMatchObject<Partial<DelegateKeyError>>({ code: 'INVALID_KEK' });
	});

	it('retires the generated wallet after wrapping', async () => {
		const kek = await aesGcmKey(['encrypt']);
		const wallet: DelegateWallet = {
			classicAddress: 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn',
			publicKey: `ED${'A'.repeat(64)}`,
			privateKey: 'private-test-material',
			seed: 'seed-test-material',
			sign: () => ({ tx_blob: '00', hash: 'B'.repeat(64) }),
		};

		await createWrappedDelegateKeyWithCryptoKey(identity, kek, {
			wallet: {
				generate: () => wallet,
				fromSeed: () => wallet,
			},
		});

		expect(wallet.privateKey).toBe('');
		expect(wallet.seed).toBeUndefined();
	});

	it('zeros decrypted seed bytes before exposing the signer callback', async () => {
		const kek = await aesGcmKey(['encrypt', 'decrypt']);
		const wrapped = await createWrappedDelegateKeyWithCryptoKey(identity, kek);
		let plaintext: ArrayBuffer | undefined;
		const subtle = new Proxy(crypto.subtle, {
			get(target, property) {
				if (property === 'decrypt') {
					return async (...args: Parameters<SubtleCrypto['decrypt']>) => {
						plaintext = await target.decrypt(...args);
						return plaintext;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const cryptoProxy = new Proxy(crypto, {
			get(target, property) {
				if (property === 'subtle') return subtle;
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});

		await withDelegateSignerWithCryptoKey(
			identity,
			wrapped,
			kek,
			() => undefined,
			{ crypto: cryptoProxy },
		);

		expect(plaintext).toBeDefined();
		expect([...new Uint8Array(plaintext!)]).toEqual(
			new Array(plaintext!.byteLength).fill(0),
		);
	});
});
