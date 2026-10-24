import { verify } from 'ripple-keypairs';
import { describe, expect, it } from 'vitest';

import { MemoryKeyStore } from '../tools/aws-local/src/key-store';
import { handleKms } from '../tools/aws-local/src/kms';

type AwsResponse = Record<string, unknown>;

function nestedString(response: AwsResponse, key: string): string {
	const value = response[key];
	expect(typeof value).toBe('string');
	return value as string;
}

function keyId(response: AwsResponse): string {
	const metadata = response.KeyMetadata as Record<string, unknown>;
	expect(metadata).toBeTypeOf('object');
	return nestedString(metadata, 'KeyId');
}

describe('aws-local KMS', () => {
	it('creates an Ed25519 key and produces a ripple-keypairs-verifiable signature', async () => {
		const store = new MemoryKeyStore();
		const created = await handleKms(
			'TrentService.CreateKey',
			{ KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY' },
			store,
		);
		const id = keyId(created);
		await handleKms(
			'TrentService.CreateAlias',
			{ AliasName: 'alias/harbor/testnet/example', TargetKeyId: id },
			store,
		);

		const publicKeyResponse = await handleKms(
			'TrentService.GetPublicKey',
			{ KeyId: 'alias/harbor/testnet/example' },
			store,
		);
		const spki = Buffer.from(nestedString(publicKeyResponse, 'PublicKey'), 'base64');
		const publicKey = `ED${spki.subarray(-32).toString('hex').toUpperCase()}`;
		const message = Buffer.from('stand-in signing round trip', 'utf8');
		const signed = await handleKms(
			'TrentService.Sign',
			{
				KeyId: 'alias/harbor/testnet/example',
				Message: message.toString('base64'),
				MessageType: 'RAW',
				SigningAlgorithm: 'ED25519_SHA_512',
			},
			store,
		);
		const signature = Buffer.from(nestedString(signed, 'Signature'), 'base64');

		expect(spki.subarray(0, 12).toString('hex')).toBe('302a300506032b6570032100');
		expect(
			verify(message.toString('hex').toUpperCase(), signature.toString('hex').toUpperCase(), publicKey),
		).toBe(true);
	});

	it('encrypts and decrypts with a symmetric key without returning its material', async () => {
		const store = new MemoryKeyStore();
		const created = await handleKms(
			'TrentService.CreateKey',
			{ KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' },
			store,
		);
		const id = keyId(created);
		const plaintext = Buffer.from(new Uint8Array(32).fill(7));
		const encrypted = await handleKms(
			'TrentService.Encrypt',
			{ KeyId: id, Plaintext: plaintext.toString('base64'), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' },
			store,
		);
		const decrypted = await handleKms(
			'TrentService.Decrypt',
			{
				CiphertextBlob: nestedString(encrypted, 'CiphertextBlob'),
				EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
			},
			store,
		);

		expect(Buffer.from(nestedString(decrypted, 'Plaintext'), 'base64')).toEqual(plaintext);
		expect(JSON.stringify(created)).not.toContain('material');
	});

	it('enforces the RAW message size and signing algorithm', async () => {
		const store = new MemoryKeyStore();
		const id = keyId(
			await handleKms(
				'TrentService.CreateKey',
				{ KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY' },
				store,
			),
		);

		await expect(
			handleKms(
				'TrentService.Sign',
				{
					KeyId: id,
					Message: Buffer.alloc(4_097).toString('base64'),
					MessageType: 'RAW',
					SigningAlgorithm: 'ED25519_SHA_512',
				},
				store,
			),
		).rejects.toMatchObject({ code: 'ValidationException' });

		await expect(
			handleKms(
				'TrentService.Sign',
				{
					KeyId: id,
					Message: Buffer.from('small').toString('base64'),
					MessageType: 'RAW',
					SigningAlgorithm: 'ECDSA_SHA_256',
				},
				store,
			),
		).rejects.toMatchObject({ code: 'ValidationException' });
	});

	it('tags, describes and schedules a key for seven-day deletion', async () => {
		const store = new MemoryKeyStore();
		const id = keyId(
			await handleKms(
				'TrentService.CreateKey',
				{ KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY' },
				store,
			),
		);
		await handleKms(
			'TrentService.TagResource',
			{ KeyId: id, Tags: [{ TagKey: 'harbor:network', TagValue: 'testnet' }] },
			store,
		);
		const before = await handleKms('TrentService.DescribeKey', { KeyId: id }, store);
		expect((before.KeyMetadata as Record<string, unknown>).KeyState).toBe('Enabled');

		const deletion = await handleKms(
			'TrentService.ScheduleKeyDeletion',
			{ KeyId: id, PendingWindowInDays: 7 },
			store,
		);
		expect(deletion).toMatchObject({ KeyId: id, KeyState: 'PendingDeletion', PendingWindowInDays: 7 });
		const after = await handleKms('TrentService.DescribeKey', { KeyId: id }, store);
		expect((after.KeyMetadata as Record<string, unknown>).KeyState).toBe('PendingDeletion');
	});
});
