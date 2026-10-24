import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';

import type {
	LocalKmsKeySpec,
	LocalKmsKeyUsage,
	LocalKmsState,
	LocalKmsStore,
	LocalKmsTag,
	StoredLocalKmsKey,
} from './key-store.ts';

type JsonObject = Record<string, unknown>;

const LOCAL_ACCOUNT = '000000000000';
const LOCAL_REGION = 'us-east-1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_RAW_BYTES = 4_096;

export class LocalKmsError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
		this.name = 'LocalKmsError';
	}
}

function requireObject(value: unknown): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new LocalKmsError('ValidationException', 'Request body must be an object');
	}
	return value as JsonObject;
}

function requireString(body: JsonObject, key: string): string {
	const value = body[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new LocalKmsError('ValidationException', `${key} is required`);
	}
	return value;
}

function decodeBase64(body: JsonObject, key: string): Buffer {
	const encoded = requireString(body, key);
	const decoded = Buffer.from(encoded, 'base64');
	if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
		throw new LocalKmsError('ValidationException', `${key} must be base64`);
	}
	return decoded;
}

function targetOperation(target: string): string {
	const operation = target.includes('.') ? target.slice(target.lastIndexOf('.') + 1) : target;
	if (!operation) {
		throw new LocalKmsError('UnknownOperationException', 'KMS operation is required');
	}
	return operation;
}

function arnFor(keyId: string): string {
	return `arn:aws:kms:${LOCAL_REGION}:${LOCAL_ACCOUNT}:key/${keyId}`;
}

function keyMetadata(key: StoredLocalKmsKey): JsonObject {
	return {
		AWSAccountId: LOCAL_ACCOUNT,
		KeyId: key.keyId,
		Arn: key.arn,
		CreationDate: Date.parse(key.createdAt) / 1_000,
		Enabled: !key.deletionDate,
		KeyState: key.deletionDate ? 'PendingDeletion' : 'Enabled',
		KeyUsage: key.keyUsage,
		KeySpec: key.keySpec,
		Origin: 'AWS_KMS',
		MultiRegion: false,
		...(key.deletionDate ? { DeletionDate: Date.parse(key.deletionDate) / 1_000 } : {}),
	};
}

function resolveKey(
	state: LocalKmsState,
	keyReference: string,
	options: { allowPendingDeletion?: boolean } = {},
): StoredLocalKmsKey {
	let keyId = keyReference;
	if (keyReference.startsWith('alias/')) {
		keyId = state.aliases[keyReference] ?? '';
	} else if (keyReference.includes(':key/')) {
		keyId = keyReference.slice(keyReference.lastIndexOf('/') + 1);
	}
	const key = state.keys[keyId];
	if (!key) {
		throw new LocalKmsError('NotFoundException', 'Key was not found', 404);
	}
	if (key.deletionDate && !options.allowPendingDeletion) {
		throw new LocalKmsError('KMSInvalidStateException', 'Key is pending deletion');
	}
	return key;
}

function parseTags(value: unknown): LocalKmsTag[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new LocalKmsError('ValidationException', 'Tags must be an array');
	}
	return value.map((tag) => {
		const object = requireObject(tag);
		return {
			TagKey: requireString(object, 'TagKey'),
			TagValue: requireString(object, 'TagValue'),
		};
	});
}

function privateMaterial(key: StoredLocalKmsKey): Uint8Array {
	return Buffer.from(key.material, 'base64');
}

function assertKeyType(
	key: StoredLocalKmsKey,
	keySpec: LocalKmsKeySpec,
	keyUsage: LocalKmsKeyUsage,
): void {
	if (key.keySpec !== keySpec || key.keyUsage !== keyUsage) {
		throw new LocalKmsError('InvalidKeyUsageException', 'Key is not valid for this operation');
	}
}

type CiphertextEnvelope = {
	v: 1;
	keyId: string;
	iv: string;
	ciphertext: string;
	tag: string;
};

function parseCiphertextBlob(encoded: string): CiphertextEnvelope {
	try {
		const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<CiphertextEnvelope>;
		if (
			value.v !== 1 ||
			typeof value.keyId !== 'string' ||
			typeof value.iv !== 'string' ||
			typeof value.ciphertext !== 'string' ||
			typeof value.tag !== 'string'
		) {
			throw new Error('invalid envelope');
		}
		return value as CiphertextEnvelope;
	} catch {
		throw new LocalKmsError('InvalidCiphertextException', 'Ciphertext could not be decoded');
	}
}

async function createKey(body: JsonObject, state: LocalKmsState): Promise<JsonObject> {
	const keySpec = requireString(body, 'KeySpec') as LocalKmsKeySpec;
	const keyUsage = requireString(body, 'KeyUsage') as LocalKmsKeyUsage;
	const validPair =
		(keySpec === 'ECC_NIST_EDWARDS25519' && keyUsage === 'SIGN_VERIFY') ||
		(keySpec === 'SYMMETRIC_DEFAULT' && keyUsage === 'ENCRYPT_DECRYPT');
	if (!validPair) {
		throw new LocalKmsError('ValidationException', 'Unsupported KeySpec and KeyUsage combination');
	}

	const keyId = randomUUID();
	const key: StoredLocalKmsKey = {
		keyId,
		arn: arnFor(keyId),
		keySpec,
		keyUsage,
		material: randomBytes(32).toString('base64'),
		createdAt: new Date().toISOString(),
		tags: parseTags(body.Tags),
	};
	state.keys[keyId] = key;
	return { KeyMetadata: keyMetadata(key) };
}

function createAlias(body: JsonObject, state: LocalKmsState): JsonObject {
	const aliasName = requireString(body, 'AliasName');
	if (!aliasName.startsWith('alias/')) {
		throw new LocalKmsError('ValidationException', 'AliasName must begin with alias/');
	}
	const key = resolveKey(state, requireString(body, 'TargetKeyId'));
	if (state.aliases[aliasName]) {
		throw new LocalKmsError('AlreadyExistsException', 'Alias already exists');
	}
	state.aliases[aliasName] = key.keyId;
	return {};
}

function tagResource(body: JsonObject, state: LocalKmsState): JsonObject {
	const key = resolveKey(state, requireString(body, 'KeyId'));
	const tags = parseTags(body.Tags);
	const merged = new Map(key.tags.map((tag) => [tag.TagKey, tag.TagValue]));
	for (const tag of tags) merged.set(tag.TagKey, tag.TagValue);
	key.tags = [...merged].map(([TagKey, TagValue]) => ({ TagKey, TagValue }));
	return {};
}

function describeKey(body: JsonObject, state: LocalKmsState): JsonObject {
	return {
		KeyMetadata: keyMetadata(
			resolveKey(state, requireString(body, 'KeyId'), { allowPendingDeletion: true }),
		),
	};
}

function getPublicKey(body: JsonObject, state: LocalKmsState): JsonObject {
	const key = resolveKey(state, requireString(body, 'KeyId'));
	assertKeyType(key, 'ECC_NIST_EDWARDS25519', 'SIGN_VERIFY');
	const rawPublicKey = Buffer.from(ed25519.getPublicKey(privateMaterial(key)));
	return {
		KeyId: key.keyId,
		PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]).toString('base64'),
		KeySpec: key.keySpec,
		KeyUsage: key.keyUsage,
		SigningAlgorithms: ['ED25519_SHA_512'],
	};
}

function sign(body: JsonObject, state: LocalKmsState): JsonObject {
	const key = resolveKey(state, requireString(body, 'KeyId'));
	assertKeyType(key, 'ECC_NIST_EDWARDS25519', 'SIGN_VERIFY');
	if (body.SigningAlgorithm !== 'ED25519_SHA_512' || body.MessageType !== 'RAW') {
		throw new LocalKmsError('ValidationException', 'Only ED25519_SHA_512 with RAW messages is supported');
	}
	const message = decodeBase64(body, 'Message');
	if (message.byteLength > MAX_RAW_BYTES) {
		throw new LocalKmsError('ValidationException', 'Message exceeds the 4096-byte RAW limit');
	}
	return {
		KeyId: key.keyId,
		Signature: Buffer.from(ed25519.sign(message, privateMaterial(key))).toString('base64'),
		SigningAlgorithm: 'ED25519_SHA_512',
	};
}

function encrypt(body: JsonObject, state: LocalKmsState): JsonObject {
	const key = resolveKey(state, requireString(body, 'KeyId'));
	assertKeyType(key, 'SYMMETRIC_DEFAULT', 'ENCRYPT_DECRYPT');
	if (body.EncryptionAlgorithm !== undefined && body.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT') {
		throw new LocalKmsError('ValidationException', 'Only SYMMETRIC_DEFAULT is supported');
	}
	const plaintext = decodeBase64(body, 'Plaintext');
	if (plaintext.byteLength > MAX_RAW_BYTES) {
		throw new LocalKmsError('ValidationException', 'Plaintext exceeds the 4096-byte limit');
	}
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', privateMaterial(key), iv);
	cipher.setAAD(Buffer.from(key.keyId, 'utf8'));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const envelope: CiphertextEnvelope = {
		v: 1,
		keyId: key.keyId,
		iv: iv.toString('base64'),
		ciphertext: ciphertext.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
	};
	return {
		CiphertextBlob: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
		KeyId: key.keyId,
		EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
	};
}

function decrypt(body: JsonObject, state: LocalKmsState): JsonObject {
	const envelope = parseCiphertextBlob(requireString(body, 'CiphertextBlob'));
	const key = resolveKey(state, envelope.keyId);
	assertKeyType(key, 'SYMMETRIC_DEFAULT', 'ENCRYPT_DECRYPT');
	if (body.KeyId !== undefined) {
		const requestedKey = resolveKey(state, requireString(body, 'KeyId'));
		if (requestedKey.keyId !== key.keyId) {
			throw new LocalKmsError('IncorrectKeyException', 'Ciphertext was encrypted with a different key');
		}
	}
	try {
		const decipher = createDecipheriv(
			'aes-256-gcm',
			privateMaterial(key),
			Buffer.from(envelope.iv, 'base64'),
		);
		decipher.setAAD(Buffer.from(key.keyId, 'utf8'));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
			decipher.final(),
		]);
		return {
			KeyId: key.keyId,
			Plaintext: plaintext.toString('base64'),
			EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
		};
	} catch {
		throw new LocalKmsError('InvalidCiphertextException', 'Ciphertext authentication failed');
	}
}

function scheduleKeyDeletion(body: JsonObject, state: LocalKmsState): JsonObject {
	const key = resolveKey(state, requireString(body, 'KeyId'));
	const pendingWindow = body.PendingWindowInDays;
	if (!Number.isInteger(pendingWindow) || Number(pendingWindow) < 7 || Number(pendingWindow) > 30) {
		throw new LocalKmsError('ValidationException', 'PendingWindowInDays must be an integer from 7 to 30');
	}
	const deletionDate = new Date(Date.now() + Number(pendingWindow) * 86_400_000);
	key.deletionDate = deletionDate.toISOString();
	return {
		KeyId: key.keyId,
		DeletionDate: deletionDate.getTime() / 1_000,
		KeyState: 'PendingDeletion',
		PendingWindowInDays: pendingWindow,
	};
}

const MUTATING_OPERATIONS = new Set(['CreateKey', 'CreateAlias', 'TagResource', 'ScheduleKeyDeletion']);

export async function handleKms(
	target: string,
	body: unknown,
	store: LocalKmsStore,
): Promise<JsonObject> {
	const operation = targetOperation(target);
	const request = requireObject(body);
	const state = await store.load();

	let response: JsonObject;
	switch (operation) {
		case 'CreateKey':
			response = await createKey(request, state);
			break;
		case 'CreateAlias':
			response = createAlias(request, state);
			break;
		case 'TagResource':
			response = tagResource(request, state);
			break;
		case 'DescribeKey':
			response = describeKey(request, state);
			break;
		case 'GetPublicKey':
			response = getPublicKey(request, state);
			break;
		case 'Sign':
			response = sign(request, state);
			break;
		case 'Encrypt':
			response = encrypt(request, state);
			break;
		case 'Decrypt':
			response = decrypt(request, state);
			break;
		case 'ScheduleKeyDeletion':
			response = scheduleKeyDeletion(request, state);
			break;
		default:
			throw new LocalKmsError('UnknownOperationException', 'Unsupported KMS operation', 404);
	}

	if (MUTATING_OPERATIONS.has(operation)) await store.save(state);
	return response;
}
