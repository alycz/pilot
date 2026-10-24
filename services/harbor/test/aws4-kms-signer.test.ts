import { decode, deriveAddress, encodeForSigning, hashes, type Transaction } from 'xrpl';
import { describe, expect, it, vi } from 'vitest';

import { MemoryKeyStore } from '../tools/aws-local/src/key-store';
import { handleKms } from '../tools/aws-local/src/kms';
import {
	createKmsDelegateClient,
	createKmsDelegateKey,
	KmsDelegateSigner,
	KmsDelegateSignerError,
	kmsDelegateIdentityFromSpki,
	readKmsDelegatePublicIdentity,
	scheduleKmsDelegateKeyDeletion,
	type KmsKeyLifecycleClient,
	type KmsSignRequest,
	type KmsSigningClient,
} from '../src/exec/kms-signer';

const SPKI_PREFIX = '302A300506032B6570032100';
const PUBLIC_KEY = 'ED5FECF30EB0A0D79F4DE01D42E43FBF2375A07E03A29F6C5079A5575BAF2A9054';
const ADDRESS = 'rD4gs512CwAsi1Z6JP7xJnt8DDutSiaQJm';
const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ALIAS = 'alias/harbor/testnet/link-1';

function spki(publicKey = PUBLIC_KEY): string {
	return Buffer.from(`${SPKI_PREFIX}${publicKey.slice(2)}`, 'hex').toString('base64');
}

function transaction(extra: Partial<Transaction> = {}): Transaction {
	return {
		TransactionType: 'OfferCancel',
		Account: OWNER,
		Delegate: ADDRESS,
		OfferSequence: 1,
		Fee: '12',
		Sequence: 7,
		LastLedgerSequence: 200,
		...extra,
	} as Transaction;
}

function localClient(store: MemoryKeyStore): KmsKeyLifecycleClient & KmsSigningClient {
	return {
		createKey: (input) => handleKms('TrentService.CreateKey', input, store),
		createAlias: (input) => handleKms('TrentService.CreateAlias', input, store),
		tagResource: (input) => handleKms('TrentService.TagResource', input, store),
		getPublicKey: (input) => handleKms('TrentService.GetPublicKey', input, store),
		scheduleKeyDeletion: (input) => handleKms('TrentService.ScheduleKeyDeletion', input, store),
		sign: (input: KmsSignRequest) => handleKms('TrentService.Sign', input, store),
	};
}

describe('AWS-4 KMS delegate signer', () => {
	it('derives the XRPL public identity from a known Ed25519 SPKI', () => {
		expect(kmsDelegateIdentityFromSpki(spki())).toEqual({
			publicKey: PUBLIC_KEY,
			address: ADDRESS,
		});
		expect(deriveAddress(PUBLIC_KEY)).toBe(ADDRESS);
	});

	it('rejects malformed or non-Ed25519 SPKI input without retaining it', () => {
		for (const invalid of [
			Buffer.from(`${'00'.repeat(12)}${PUBLIC_KEY.slice(2)}`, 'hex').toString('base64'),
			Buffer.from(`${SPKI_PREFIX}${PUBLIC_KEY.slice(2, -2)}`, 'hex').toString('base64'),
			'not base64',
		]) {
			expect(() => kmsDelegateIdentityFromSpki(invalid)).toThrowError(
				expect.objectContaining({ code: 'KMS_PUBLIC_KEY_INVALID' }),
			);
		}
	});

	it('reads a stored alias public identity and rejects malformed provider output', async () => {
		const getPublicKey = vi.fn(async () => ({ PublicKey: spki() }));
		await expect(readKmsDelegatePublicIdentity({ getPublicKey }, ALIAS)).resolves.toEqual({
			publicKey: PUBLIC_KEY,
			address: ADDRESS,
		});
		expect(getPublicKey).toHaveBeenCalledWith({ KeyId: ALIAS });

		getPublicKey.mockResolvedValueOnce({ PublicKey: 'credential-shaped malformed response' });
		const failure = await readKmsDelegatePublicIdentity({ getPublicKey }, ALIAS)
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: 'KMS_PUBLIC_KEY_READ_FAILED' });
		expect(String(failure)).not.toContain('credential-shaped');
	});

	it('creates a tagged stand-in key, aliases it, and returns only public material', async () => {
		const store = new MemoryKeyStore();
		const client = localClient(store);
		const createKey = vi.spyOn(client, 'createKey');
		const created = await createKmsDelegateKey({
			principal: 'aws4-test-principal',
			owner: OWNER,
			network: 'testnet',
			linkId: 'link-1',
			client,
		});

		expect(created).toMatchObject({ keyAlias: ALIAS });
		expect(created.keyId).toMatch(/^[A-Za-z0-9-]+$/);
		expect(created.publicKey).toMatch(/^ED[A-F0-9]{64}$/);
		expect(created.address).toBe(deriveAddress(created.publicKey));
		expect(createKey).toHaveBeenCalledWith({
			KeySpec: 'ECC_NIST_EDWARDS25519',
			KeyUsage: 'SIGN_VERIFY',
			Tags: [
				{ TagKey: 'harbor:principal', TagValue: 'aws4-test-principal' },
				{ TagKey: 'harbor:owner', TagValue: OWNER },
				{ TagKey: 'harbor:network', TagValue: 'testnet' },
			],
		});
		expect(JSON.stringify(created)).not.toMatch(/private|secret|material/i);
	});

	it('binds only explicit sign-mode settings and strips configured credentials for the stand-in', async () => {
		const fetch = vi.fn(async () => ({ KeyMetadata: { KeyId: 'adapter-key' } }));
		const client = createKmsDelegateClient({
			KMS_MODE: 'sign',
			AWS_REGION: 'us-east-1',
			AWS_ENDPOINT_OVERRIDE: 'http://127.0.0.1:8790',
			EXEC_NETWORK: 'testnet',
			HARBOR_LOCAL_DEV: 'true',
			AWS_ACCESS_KEY_ID: 'configured-access-sentinel',
			AWS_SECRET_ACCESS_KEY: 'configured-secret-sentinel',
			AWS_SESSION_TOKEN: 'configured-session-sentinel',
		}, { fetch });
		await client.createKey({ KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY', Tags: [] });

		expect(fetch).toHaveBeenCalledWith(
			'kms',
			'TrentService.CreateKey',
			{ KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY', Tags: [] },
			expect.objectContaining({
				env: expect.objectContaining({
					AWS_ACCESS_KEY_ID: 'LOCAL_STANDIN_ONLY_NOT_A_CREDENTIAL',
					AWS_SECRET_ACCESS_KEY: 'local-standin-only-not-a-secret-credential',
				}),
			}),
		);
		const options = fetch.mock.calls[0]?.[3];
		expect(JSON.stringify(options)).not.toMatch(/configured-(?:access|secret|session)-sentinel/);
		expect(options?.env).not.toHaveProperty('AWS_SESSION_TOKEN');
		expect(options?.env).not.toHaveProperty('KMS_MODE');
	});

	it('refuses to build the KMS adapter outside sign mode', () => {
		expect(() => createKmsDelegateClient({ KMS_MODE: 'kek' })).toThrowError(
			expect.objectContaining({ code: 'KMS_SIGN_MODE_REQUIRED' }),
		);
	});

	it('signs through the stand-in with RAW ED25519_SHA_512 and verifies before returning', async () => {
		const store = new MemoryKeyStore();
		const client = localClient(store);
		const created = await createKmsDelegateKey({
			principal: 'aws4-sign-principal',
			owner: OWNER,
			network: 'testnet',
			linkId: 'sign-link',
			client,
		});
		const sign = vi.spyOn(client, 'sign');
		const signer = new KmsDelegateSigner({ ...created, client });
		const result = await signer.sign(transaction({ Delegate: created.address }));
		const decoded = decode(result.tx_blob) as Transaction;

		expect(result.hash).toBe(hashes.hashSignedTx(result.tx_blob));
		expect(decoded.SigningPubKey).toBe(created.publicKey);
		expect(decoded.TxnSignature).toMatch(/^[A-F0-9]{128}$/);
		expect(sign).toHaveBeenCalledOnce();
		expect(sign.mock.calls[0]?.[0]).toMatchObject({
			KeyId: created.keyId,
			MessageType: 'RAW',
			SigningAlgorithm: 'ED25519_SHA_512',
		});
		expect(Buffer.from(sign.mock.calls[0]![0].Message, 'base64').toString('hex').toUpperCase())
			.toBe(encodeForSigning({ ...transaction({ Delegate: created.address }), SigningPubKey: created.publicKey } as Transaction));
	});

	it('refuses a signing payload over 4096 bytes before calling KMS', async () => {
		const sign = vi.fn(async () => ({ Signature: Buffer.alloc(64).toString('base64') }));
		const signer = new KmsDelegateSigner({ keyId: 'key-1', keyAlias: ALIAS, publicKey: PUBLIC_KEY, client: { sign } });
		const oversized = transaction({
			Memos: [{ Memo: { MemoData: 'AB'.repeat(4_100) } }],
		} as Partial<Transaction>);

		await expect(signer.sign(oversized)).rejects.toMatchObject({
			code: 'KMS_SIGNING_MESSAGE_TOO_LARGE',
		});
		expect(sign).not.toHaveBeenCalled();
	});

	it('rejects a signature when local verification fails', async () => {
		const sign = vi.fn(async () => ({ Signature: Buffer.alloc(64, 7).toString('base64') }));
		const verify = vi.fn(() => false);
		const signer = new KmsDelegateSigner({
			keyId: 'key-1', keyAlias: ALIAS, publicKey: PUBLIC_KEY, client: { sign }, verify,
		});

		await expect(signer.sign(transaction())).rejects.toMatchObject({ code: 'KMS_SIGNATURE_INVALID' });
		expect(verify).toHaveBeenCalledOnce();
	});

	it('fails closed with a fixed error and never falls back on a KMS exception', async () => {
		const sign = vi.fn(async () => { throw new Error('credential-shaped provider detail'); });
		const signer = new KmsDelegateSigner({ keyId: 'key-1', keyAlias: ALIAS, publicKey: PUBLIC_KEY, client: { sign } });

		const failure = await signer.sign(transaction()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(KmsDelegateSignerError);
		expect(failure).toMatchObject({ code: 'KMS_SIGN_FAILED' });
		expect(String(failure)).not.toContain('credential-shaped');
		expect(sign).toHaveBeenCalledOnce();
	});

	it('best-effort schedules cleanup after a post-create failure and uses seven days on revoke', async () => {
		const createdResponse = { KeyMetadata: { KeyId: 'cleanup-key' } };
		const scheduleKeyDeletion = vi.fn(async () => ({ KeyState: 'PendingDeletion' }));
		const client: KmsKeyLifecycleClient = {
			createKey: vi.fn(async () => createdResponse),
			createAlias: vi.fn(async () => { throw new Error('synthetic alias failure'); }),
			tagResource: vi.fn(),
			getPublicKey: vi.fn(),
			scheduleKeyDeletion,
		};
		await expect(createKmsDelegateKey({
			principal: 'cleanup-test', owner: OWNER, network: 'testnet', linkId: 'cleanup', client,
		})).rejects.toMatchObject({ code: 'KMS_KEY_CREATE_FAILED' });
		expect(scheduleKeyDeletion).toHaveBeenCalledWith({ KeyId: 'cleanup-key', PendingWindowInDays: 7 });

		scheduleKeyDeletion.mockClear();
		await scheduleKmsDelegateKeyDeletion(client, 'cleanup-key');
		expect(scheduleKeyDeletion).toHaveBeenCalledWith({ KeyId: 'cleanup-key', PendingWindowInDays: 7 });
	});

	it('rejects multisigning without making a KMS call', async () => {
		const sign = vi.fn();
		const signer = new KmsDelegateSigner({ keyId: 'key-1', keyAlias: ALIAS, publicKey: PUBLIC_KEY, client: { sign } });
		await expect(signer.sign(transaction(), true)).rejects.toMatchObject({ code: 'KMS_MULTISIGN_UNSUPPORTED' });
		expect(sign).not.toHaveBeenCalled();
	});
});
