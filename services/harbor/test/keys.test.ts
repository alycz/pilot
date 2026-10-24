import { isValidClassicAddress } from 'xrpl';
import { describe, expect, it, vi } from 'vitest';

import type { Network } from '../src/contracts';
import {
	createWrappedDelegateKey,
	DelegateKeyError,
	FaucetFundingError,
	fundDelegateAccount,
	type DelegateIdentity,
	withDelegateSigner,
} from '../src/exec/keys';

const identity: DelegateIdentity = {
	principal: 'api-key-owner',
	owner: 'rBudgetAccount',
	network: 'testnet',
};

const VALID_DELEGATE_ADDRESS = 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn';

function base64Key(fill: number): string {
	return Buffer.from(new Uint8Array(32).fill(fill)).toString('base64');
}

describe('delegate key wrapping', () => {
	it('round-trips only through a callback signer facade', async () => {
		const wrapped = await createWrappedDelegateKey(identity, base64Key(7));
		// The D1 links row stores the address, ciphertext, and IV. The public key
		// is derived again only while the delegate is unwrapped for signing.
		const stored = {
			address: wrapped.address,
			ciphertext: wrapped.ciphertext,
			iv: wrapped.iv,
		};

		const result = await withDelegateSigner(identity, stored, base64Key(7), (signer) => {
			expect(Object.keys(signer).sort()).toEqual(['address', 'publicKey', 'sign']);
			expect('seed' in signer).toBe(false);
			expect('privateKey' in signer).toBe(false);

			const signed = signer.sign({
				TransactionType: 'OfferCancel',
				Account: signer.address,
				OfferSequence: 1,
				Sequence: 1,
				Fee: '12',
				LastLedgerSequence: 100,
			});
			return { address: signer.address, publicKey: signer.publicKey, signed };
		});

		expect(result.address).toBe(wrapped.address);
		expect(result.publicKey).toBe(wrapped.publicKey);
		expect(result.signed.tx_blob).toMatch(/^[A-F0-9]+$/);
		expect(result.signed.hash).toMatch(/^[A-F0-9]{64}$/);
	});

	it('creates a valid Ed25519 XRPL public key and classic address', async () => {
		const wrapped = await createWrappedDelegateKey(identity, base64Key(8));

		expect(wrapped.publicKey).toMatch(/^ED[A-F0-9]{64}$/);
		expect(isValidClassicAddress(wrapped.address)).toBe(true);
		expect(wrapped.iv.byteLength).toBe(12);
		expect(wrapped.ciphertext.byteLength).toBeGreaterThan(0);
	});

	it('uses a unique IV and ciphertext for each generated delegate', async () => {
		const first = await createWrappedDelegateKey(identity, base64Key(9));
		const second = await createWrappedDelegateKey(identity, base64Key(9));

		expect([...new Uint8Array(first.iv)]).not.toEqual([...new Uint8Array(second.iv)]);
		expect([...new Uint8Array(first.ciphertext)]).not.toEqual([...new Uint8Array(second.ciphertext)]);
	});

	it('rejects a wrong KEK without leaking cryptographic material', async () => {
		const wrapped = await createWrappedDelegateKey(identity, base64Key(10));

		let caught: unknown;
		try {
			await withDelegateSigner(identity, wrapped, base64Key(11), () => 'not reached');
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(DelegateKeyError);
		expect(caught).toMatchObject({ code: 'KEY_UNWRAP_FAILED' });
		expect(String(caught)).toBe('DelegateKeyError: Delegate key could not be unwrapped');
	});

	it('requires HARBOR_KEK to decode to exactly 32 bytes', async () => {
		await expect(createWrappedDelegateKey(identity, Buffer.from('too short').toString('base64'))).rejects.toMatchObject({
			code: 'INVALID_KEK',
		});
	});

	it('binds ciphertext to principal, owner, and network', async () => {
		const wrapped = await createWrappedDelegateKey(identity, base64Key(12));
		const otherIdentities: DelegateIdentity[] = [
			{ ...identity, principal: 'another-principal' },
			{ ...identity, owner: 'rAnotherBudgetAccount' },
			{ ...identity, network: 'devnet' },
		];

		for (const otherIdentity of otherIdentities) {
			await expect(withDelegateSigner(otherIdentity, wrapped, base64Key(12), () => 'not reached')).rejects.toMatchObject({
				code: 'KEY_UNWRAP_FAILED',
			});
		}
	});
});

describe('delegate faucet funding', () => {
	it.each([
		['testnet', 'https://faucet.altnet.rippletest.net/accounts'],
		['devnet', 'https://faucet.devnet.rippletest.net/accounts'],
	] as const)('posts only the public address to the %s faucet', async (network, expectedUrl) => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ ignored: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);

		const result = await fundDelegateAccount(VALID_DELEGATE_ADDRESS, network, { fetch: fetchMock });

		expect(result).toEqual({ address: VALID_DELEGATE_ADDRESS, network });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(expectedUrl);
		expect(init).toMatchObject({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
		});
		expect(JSON.parse(String(init?.body))).toEqual({ destination: VALID_DELEGATE_ADDRESS });
	});

	it.each(['mainnet', 'lending-devnet'] satisfies Network[])('rejects funding on %s before making a request', async (network) => {
		const fetchMock = vi.fn<typeof fetch>();

		await expect(fundDelegateAccount(VALID_DELEGATE_ADDRESS, network, { fetch: fetchMock })).rejects.toMatchObject({
			code: 'UNSUPPORTED_NETWORK',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a malformed faucet destination before making a request', async () => {
		const fetchMock = vi.fn<typeof fetch>();
		await expect(fundDelegateAccount('not-an-xrpl-address', 'testnet', { fetch: fetchMock })).rejects.toMatchObject({
			code: 'INVALID_ADDRESS',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not copy fetch error details into its error', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('credential-shaped upstream detail'));

		let caught: unknown;
		try {
			await fundDelegateAccount(VALID_DELEGATE_ADDRESS, 'testnet', { fetch: fetchMock });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(FaucetFundingError);
		expect(String(caught)).toBe('FaucetFundingError: Delegate faucet request failed');
		expect(caught).toMatchObject({ code: 'REQUEST_FAILED' });
	});
});
