import { describe, expect, it } from 'vitest';

import { createWrappedMandateKeys, MandateKeyError, unwrapMandateViChain, wrapMandateViChain } from '../src/exec/mandate-keys';

const kek = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const identity = { principal: 'principal', owner: 'rOwner', network: 'testnet' as const, mandateId: 'mandate-1' };

describe('mandate keys', () => {
	it('returns only public material and independently wrapped ciphertexts', async () => {
		let index = 0;
		const result = await createWrappedMandateKeys(identity, ['a', 'b'], kek, {
			generateClaimWallet: () => ({ publicKey: `EDPUBLIC${index}`, seed: `s-secret-${index++}` }),
		});
		expect(result.agentPublicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
		expect(result.agentPublicJwk).not.toHaveProperty('d');
		expect(result.claimPublicKeys).toEqual([
			{ merchant_id: 'a', public_key: 'EDPUBLIC0' }, { merchant_id: 'b', public_key: 'EDPUBLIC1' },
		]);
		expect(result.agentKeyIv.byteLength).toBe(12);
		expect(result.claimKeysIv.byteLength).toBe(12);
		expect(new Uint8Array(result.agentKeyIv)).not.toEqual(new Uint8Array(result.claimKeysIv));
		expect(JSON.stringify(result)).not.toContain('s-secret');
	});

	it('rejects a malformed KEK and duplicate merchants', async () => {
		await expect(createWrappedMandateKeys(identity, ['a'], 'bad')).rejects.toMatchObject({ code: 'INVALID_KEK' });
		await expect(createWrappedMandateKeys(identity, ['a', 'a'], kek)).rejects.toBeInstanceOf(MandateKeyError);
	});

	it('wraps the public signed VI chain with mandate-bound AAD', async () => {
		const wrapped = await wrapMandateViChain(identity, { l1: 'public-l1', l2: 'public-l2' }, kek);
		expect(wrapped.iv.byteLength).toBe(12);
		expect(new TextDecoder().decode(wrapped.ciphertext)).not.toContain('public-l1');
		expect(await unwrapMandateViChain(identity, wrapped, kek)).toEqual({ l1: 'public-l1', l2: 'public-l2' });
		await expect(unwrapMandateViChain({ ...identity, mandateId: 'other' }, wrapped, kek)).rejects.toMatchObject({ code: 'WRAP_FAILED' });
	});
});
