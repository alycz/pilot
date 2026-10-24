import {
	deriveAddress,
	encode,
	encodeForSigning,
	hashes,
	type Transaction,
} from 'xrpl';
import { verify as verifyKeypairSignature } from 'ripple-keypairs';

import { readKmsMode, type KmsEnv, type KmsFetch } from '../aws/kms';
import { awsFetch, type AwsFetchEnv } from '../aws/sigv4';
import type { DelegateSigner, SignedTransaction } from './keys';

const ED25519_SPKI_PREFIX = '302A300506032B6570032100';
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const KMS_RAW_MESSAGE_MAX_BYTES = 4_096;
const LOCAL_STANDIN_ACCESS_KEY_ID = 'LOCAL_STANDIN_ONLY_NOT_A_CREDENTIAL';
const LOCAL_STANDIN_SECRET_ACCESS_KEY = 'local-standin-only-not-a-secret-credential';

export interface KmsSignRequest {
	KeyId: string;
	Message: string;
	MessageType: 'RAW';
	SigningAlgorithm: 'ED25519_SHA_512';
}

/** Narrow KMS seam used by the signer; implementations may bind SigV4 or the local stand-in. */
export interface KmsSigningClient {
	sign(input: KmsSignRequest): Promise<unknown>;
}

export interface KmsPublicKeyClient {
	getPublicKey(input: { KeyId: string }): Promise<unknown>;
}

export interface KmsKeyLifecycleClient extends KmsPublicKeyClient {
	createKey(input: {
		KeySpec: 'ECC_NIST_EDWARDS25519';
		KeyUsage: 'SIGN_VERIFY';
		Tags: Array<{ TagKey: string; TagValue: string }>;
	}): Promise<unknown>;
	createAlias(input: { AliasName: string; TargetKeyId: string }): Promise<unknown>;
	tagResource(input: {
		KeyId: string;
		Tags: Array<{ TagKey: string; TagValue: string }>;
	}): Promise<unknown>;
	scheduleKeyDeletion(input: { KeyId: string; PendingWindowInDays: 7 }): Promise<unknown>;
}

export interface CreateKmsDelegateKeyInput {
	principal: string;
	owner: string;
	network: 'testnet' | 'devnet';
	linkId: string;
	client: KmsKeyLifecycleClient;
}

export interface KmsDelegateKey extends KmsDelegatePublicIdentity {
	keyId: string;
	keyAlias: string;
}

export interface KmsDelegateClientDependencies {
	fetch?: KmsFetch;
}

export interface KmsDelegatePublicIdentity {
	address: string;
	publicKey: string;
}

export type KmsDelegateSignerErrorCode =
	| 'KMS_KEY_REFERENCE_INVALID'
	| 'KMS_PUBLIC_KEY_INVALID'
	| 'KMS_MULTISIGN_UNSUPPORTED'
	| 'KMS_SIGNING_MESSAGE_TOO_LARGE'
	| 'KMS_SIGN_FAILED'
	| 'KMS_SIGN_RESPONSE_INVALID'
	| 'KMS_SIGNATURE_INVALID'
	| 'KMS_KEY_CREATE_FAILED'
	| 'KMS_KEY_DELETE_FAILED'
	| 'KMS_SIGN_MODE_REQUIRED'
	| 'KMS_PUBLIC_KEY_READ_FAILED';

/** Fixed, secret-safe errors for the owner-delegation KMS signing boundary. */
export class KmsDelegateSignerError extends Error {
	constructor(readonly code: KmsDelegateSignerErrorCode) {
		super(messageFor(code));
		this.name = 'KmsDelegateSignerError';
	}
}

export interface KmsDelegateSignerInput {
	keyId: string;
	keyAlias: string;
	publicKey: string;
	client: KmsSigningClient;
	verify?: typeof verifyKeypairSignature;
}

function messageFor(code: KmsDelegateSignerErrorCode): string {
	switch (code) {
		case 'KMS_KEY_REFERENCE_INVALID':
			return 'The KMS delegate key reference is invalid';
		case 'KMS_PUBLIC_KEY_INVALID':
			return 'KMS returned an invalid Ed25519 public key';
		case 'KMS_MULTISIGN_UNSUPPORTED':
			return 'KMS delegate signing does not support multisigning';
		case 'KMS_SIGNING_MESSAGE_TOO_LARGE':
			return 'The KMS signing message exceeds 4096 bytes';
		case 'KMS_SIGN_FAILED':
			return 'KMS could not sign the delegated transaction';
		case 'KMS_SIGN_RESPONSE_INVALID':
			return 'KMS returned an invalid signing response';
		case 'KMS_SIGNATURE_INVALID':
			return 'KMS returned a signature that failed local verification';
		case 'KMS_KEY_CREATE_FAILED':
			return 'KMS could not create the delegate key';
		case 'KMS_KEY_DELETE_FAILED':
			return 'KMS could not schedule delegate key deletion';
		case 'KMS_SIGN_MODE_REQUIRED':
			return 'KMS delegate signing mode is not enabled';
		case 'KMS_PUBLIC_KEY_READ_FAILED':
			return 'KMS could not read the delegate public key';
	}
}

function bytesFromBase64(value: unknown, code: KmsDelegateSignerErrorCode): Uint8Array {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw new KmsDelegateSignerError(code);
	}
	try {
		const decoded = atob(value);
		if (btoa(decoded) !== value) throw new TypeError('non-canonical base64');
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch (error) {
		if (error instanceof KmsDelegateSignerError) throw error;
		throw new KmsDelegateSignerError(code);
	}
}

function base64FromHex(hex: string): string {
	let binary = '';
	for (let offset = 0; offset < hex.length; offset += 2) {
		binary += String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 2), 16));
	}
	return btoa(binary);
}

function uppercaseHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function validatedPublicKey(publicKey: string): string {
	const normalized = publicKey.toUpperCase();
	if (!/^ED[A-F0-9]{64}$/.test(normalized)) {
		throw new KmsDelegateSignerError('KMS_PUBLIC_KEY_INVALID');
	}
	try {
		deriveAddress(normalized);
		return normalized;
	} catch {
		throw new KmsDelegateSignerError('KMS_PUBLIC_KEY_INVALID');
	}
}

/** Convert the KMS Ed25519 SPKI response into the XRPL public identity. */
export function kmsDelegateIdentityFromSpki(spkiBase64: string): KmsDelegatePublicIdentity {
	const spki = bytesFromBase64(spkiBase64, 'KMS_PUBLIC_KEY_INVALID');
	const expectedLength = ED25519_SPKI_PREFIX.length / 2 + ED25519_PUBLIC_KEY_BYTES;
	if (spki.byteLength !== expectedLength) {
		throw new KmsDelegateSignerError('KMS_PUBLIC_KEY_INVALID');
	}
	const prefix = uppercaseHex(spki.subarray(0, ED25519_SPKI_PREFIX.length / 2));
	if (prefix !== ED25519_SPKI_PREFIX) {
		throw new KmsDelegateSignerError('KMS_PUBLIC_KEY_INVALID');
	}
	const publicKey = validatedPublicKey(`ED${uppercaseHex(spki.subarray(-ED25519_PUBLIC_KEY_BYTES))}`);
	return { publicKey, address: deriveAddress(publicKey) };
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function createdKeyId(response: unknown): string | null {
	const metadata = record(record(response)?.KeyMetadata);
	const keyId = metadata?.KeyId;
	return typeof keyId === 'string' && keyId.trim().length > 0 ? keyId : null;
}

function publicKeySpki(response: unknown): string | null {
	const value = record(response)?.PublicKey;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read and strictly validate public identity without exposing provider detail. */
export async function readKmsDelegatePublicIdentity(
	client: KmsPublicKeyClient,
	keyRef: string,
): Promise<KmsDelegatePublicIdentity> {
	if (!keyRef.trim()) throw new KmsDelegateSignerError('KMS_KEY_REFERENCE_INVALID');
	try {
		const response = await client.getPublicKey({ KeyId: keyRef });
		const spki = publicKeySpki(response);
		if (spki === null) throw new Error('invalid public key response');
		return kmsDelegateIdentityFromSpki(spki);
	} catch {
		throw new KmsDelegateSignerError('KMS_PUBLIC_KEY_READ_FAILED');
	}
}

function validIdentitySegment(value: string, max: number): boolean {
	return value.length > 0 && value.length <= max && !value.includes('\0');
}

function kmsSigningEnv(env: KmsEnv): AwsFetchEnv {
	const common: AwsFetchEnv = {
		AWS_REGION: env.AWS_REGION,
		AWS_ENDPOINT_OVERRIDE: env.AWS_ENDPOINT_OVERRIDE,
		EXEC_NETWORK: env.EXEC_NETWORK,
		HARBOR_LOCAL_DEV: env.HARBOR_LOCAL_DEV,
	};
	if (env.AWS_ENDPOINT_OVERRIDE) {
		return {
			...common,
			AWS_ACCESS_KEY_ID: LOCAL_STANDIN_ACCESS_KEY_ID,
			AWS_SECRET_ACCESS_KEY: LOCAL_STANDIN_SECRET_ACCESS_KEY,
		};
	}
	return {
		...common,
		AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
		AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
	};
}

/**
 * Bind the shared SigV4 transport to the KMS operations AWS-4 needs. The
 * adapter reads only the explicitly supplied environment object; it never
 * discovers credentials or falls back to a local signer.
 */
export function createKmsDelegateClient(
	env: KmsEnv,
	dependencies: KmsDelegateClientDependencies = {},
): KmsKeyLifecycleClient & KmsSigningClient {
	if (readKmsMode(env) !== 'sign') {
		throw new KmsDelegateSignerError('KMS_SIGN_MODE_REQUIRED');
	}
	const fetchKms = dependencies.fetch ?? awsFetch;
	const request = (target: string, body: Record<string, unknown>) =>
		fetchKms('kms', target, body, { env: kmsSigningEnv(env) });
	const client: KmsKeyLifecycleClient & KmsSigningClient = {
		createKey: (input) => request('TrentService.CreateKey', input),
		createAlias: (input) => request('TrentService.CreateAlias', input),
		tagResource: (input) => request('TrentService.TagResource', input),
		getPublicKey: (input) => request('TrentService.GetPublicKey', input),
		scheduleKeyDeletion: (input) => request('TrentService.ScheduleKeyDeletion', input),
		sign: (input) => request('TrentService.Sign', { ...input }),
	};
	return Object.freeze(client);
}

/** Create and alias one tagged KMS delegate key, returning public material only. */
export async function createKmsDelegateKey(input: CreateKmsDelegateKeyInput): Promise<KmsDelegateKey> {
	if (
		!validIdentitySegment(input.principal, 256) ||
		!validIdentitySegment(input.owner, 128) ||
		!/^[A-Za-z0-9._-]{1,128}$/.test(input.linkId)
	) {
		throw new KmsDelegateSignerError('KMS_KEY_REFERENCE_INVALID');
	}
	let keyId: string | null = null;
	try {
		const created = await input.client.createKey({
			KeySpec: 'ECC_NIST_EDWARDS25519',
			KeyUsage: 'SIGN_VERIFY',
			Tags: [
				{ TagKey: 'harbor:principal', TagValue: input.principal },
				{ TagKey: 'harbor:owner', TagValue: input.owner },
				{ TagKey: 'harbor:network', TagValue: input.network },
			],
		});
		keyId = createdKeyId(created);
		if (keyId === null) throw new Error('invalid create response');
		const keyAlias = `alias/harbor/${input.network}/${input.linkId}`;
		await input.client.createAlias({ AliasName: keyAlias, TargetKeyId: keyId });
		return { ...await readKmsDelegatePublicIdentity(input.client, keyAlias), keyId, keyAlias };
	} catch {
		if (keyId !== null) {
			try {
				await input.client.scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 });
			} catch {
				// Preserve the fixed creation failure and never surface provider detail.
			}
		}
		throw new KmsDelegateSignerError('KMS_KEY_CREATE_FAILED');
	}
}

/** Schedule the exact stored KMS key for the minimum supported deletion window. */
export async function scheduleKmsDelegateKeyDeletion(
	client: KmsKeyLifecycleClient,
	keyId: string,
): Promise<void> {
	if (!keyId.trim()) throw new KmsDelegateSignerError('KMS_KEY_REFERENCE_INVALID');
	try {
		await client.scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 });
	} catch {
		throw new KmsDelegateSignerError('KMS_KEY_DELETE_FAILED');
	}
}

function signatureFrom(response: unknown): string {
	if (typeof response !== 'object' || response === null || Array.isArray(response)) {
		throw new KmsDelegateSignerError('KMS_SIGN_RESPONSE_INVALID');
	}
	const signature = bytesFromBase64(
		(response as Record<string, unknown>).Signature,
		'KMS_SIGN_RESPONSE_INVALID',
	);
	if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
		throw new KmsDelegateSignerError('KMS_SIGN_RESPONSE_INVALID');
	}
	return uppercaseHex(signature);
}

/**
 * Async owner-delegation signer backed by one non-exportable KMS Ed25519 key.
 * The implementation never receives private key material and never falls back
 * to a local key when the KMS request or verification fails.
 */
export class KmsDelegateSigner implements DelegateSigner {
	readonly address: string;
	readonly publicKey: string;
	readonly keyId: string;
	readonly keyAlias: string;

	private readonly client: KmsSigningClient;
	private readonly verifySignature: typeof verifyKeypairSignature;

	constructor(input: KmsDelegateSignerInput) {
		if (!input.keyId.trim() || !/^alias\/harbor\/(?:testnet|devnet)\/[A-Za-z0-9._-]+$/.test(input.keyAlias)) {
			throw new KmsDelegateSignerError('KMS_KEY_REFERENCE_INVALID');
		}
		this.publicKey = validatedPublicKey(input.publicKey);
		this.address = deriveAddress(this.publicKey);
		this.keyId = input.keyId;
		this.keyAlias = input.keyAlias;
		this.client = input.client;
		this.verifySignature = input.verify ?? verifyKeypairSignature;
	}

	async sign(
		transaction: Transaction,
		multisign?: boolean | string,
	): Promise<SignedTransaction> {
		if (multisign !== undefined && multisign !== false) {
			throw new KmsDelegateSignerError('KMS_MULTISIGN_UNSUPPORTED');
		}
		const signedTransaction = structuredClone(transaction) as Transaction & {
			SigningPubKey: string;
			TxnSignature?: string;
		};
		signedTransaction.SigningPubKey = this.publicKey;
		delete signedTransaction.TxnSignature;

		let signingHex: string;
		try {
			signingHex = encodeForSigning(signedTransaction);
		} catch {
			throw new KmsDelegateSignerError('KMS_SIGN_FAILED');
		}
		if (signingHex.length / 2 > KMS_RAW_MESSAGE_MAX_BYTES) {
			throw new KmsDelegateSignerError('KMS_SIGNING_MESSAGE_TOO_LARGE');
		}

		let response: unknown;
		try {
			response = await this.client.sign({
				KeyId: this.keyId,
				Message: base64FromHex(signingHex),
				MessageType: 'RAW',
				SigningAlgorithm: 'ED25519_SHA_512',
			});
		} catch {
			throw new KmsDelegateSignerError('KMS_SIGN_FAILED');
		}
		const signature = signatureFrom(response);
		let verified = false;
		try {
			verified = this.verifySignature(signingHex, signature, this.publicKey);
		} catch {
			verified = false;
		}
		if (!verified) {
			throw new KmsDelegateSignerError('KMS_SIGNATURE_INVALID');
		}

		signedTransaction.TxnSignature = signature;
		const tx_blob = encode(signedTransaction);
		return { tx_blob, hash: hashes.hashSignedTx(tx_blob) };
	}
}
