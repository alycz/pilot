import { ECDSA, Wallet } from 'xrpl';

const IV_BYTES = 12;
const KEK_BYTES = 32;

type JsonObject = Record<string, unknown>;

export interface MandateKeyIdentity {
	principal: string;
	owner: string;
	network: 'testnet';
	mandateId: string;
}

export interface WrappedMandateKeys {
	agentPublicJwk: JsonObject;
	agentKeyCiphertext: ArrayBuffer;
	agentKeyIv: ArrayBuffer;
	claimPublicKeys: Array<{ merchant_id: string; public_key: string }>;
	claimKeysCiphertext: ArrayBuffer;
	claimKeysIv: ArrayBuffer;
}

export interface WrappedMandateViChain {
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
}

export interface MandateViChainPresentation {
	l1: string;
	l2: string;
}

export interface MandateClaimWallet {
	readonly publicKey: string;
	readonly seed?: string;
}

export interface MandateKeyDependencies {
	crypto: Crypto;
	generateClaimWallet(): MandateClaimWallet;
}

export class MandateKeyError extends Error {
	constructor(message: string, readonly code: 'INVALID_IDENTITY' | 'INVALID_KEK' | 'GENERATION_FAILED' | 'WRAP_FAILED') {
		super(message);
		this.name = 'MandateKeyError';
	}
}

function decodeKek(value: string): Uint8Array {
	try {
		if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new TypeError('invalid base64');
		const decoded = atob(value);
		if (decoded.length !== KEK_BYTES) throw new TypeError('invalid length');
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		throw new MandateKeyError('HARBOR_KEK must be a 32-byte base64 value', 'INVALID_KEK');
	}
}

type WrappedPurpose = 'agent' | 'claims' | 'vi-chain';
type KekUsage = 'encrypt' | 'decrypt';

function validateKekCryptoKey(key: CryptoKey, requiredUsage: KekUsage): void {
	const algorithm = key?.algorithm as { name?: unknown; length?: unknown } | undefined;
	if (
		key?.type !== 'secret' ||
		algorithm?.name !== 'AES-GCM' ||
		algorithm.length !== KEK_BYTES * 8 ||
		key.extractable ||
		!key.usages.includes(requiredUsage)
	) {
		throw new MandateKeyError(
			`KMS KEK must be a non-extractable 256-bit AES-GCM key with ${requiredUsage} usage`,
			'INVALID_KEK',
		);
	}
}

function aad(identity: MandateKeyIdentity, purpose: WrappedPurpose): Uint8Array {
	if (!identity.principal || !identity.owner || !identity.mandateId || identity.network !== 'testnet') {
		throw new MandateKeyError('Mandate key identity is invalid', 'INVALID_IDENTITY');
	}
	return new TextEncoder().encode(JSON.stringify([
		identity.principal, identity.owner, identity.network, identity.mandateId, purpose,
	]));
}

async function wrap(
	cryptoImpl: Crypto,
	kekBase64: string,
	identity: MandateKeyIdentity,
	purpose: WrappedPurpose,
	plaintext: Uint8Array,
): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
	const rawKek = decodeKek(kekBase64);
	try {
		const key = await cryptoImpl.subtle.importKey('raw', rawKek, 'AES-GCM', false, ['encrypt']);
		return wrapWithCryptoKey(cryptoImpl, key, identity, purpose, plaintext, false);
	} finally {
		rawKek.fill(0);
	}
}

async function wrapWithCryptoKey(
	cryptoImpl: Crypto,
	key: CryptoKey,
	identity: MandateKeyIdentity,
	purpose: WrappedPurpose,
	plaintext: Uint8Array,
	validate = true,
): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
	if (validate) validateKekCryptoKey(key, 'encrypt');
	const iv = cryptoImpl.getRandomValues(new Uint8Array(IV_BYTES));
	try {
		const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(identity, purpose) }, key, plaintext);
		return { ciphertext, iv: Uint8Array.from(iv).buffer };
	} catch {
		throw new MandateKeyError('Mandate key wrapping failed', 'WRAP_FAILED');
	}
}

/**
 * Encrypt the signed public VI presentations for internal merchant-chain
 * transport. The plaintext must never be exposed by an operation response.
 */
export async function wrapMandateViChain(
	identity: MandateKeyIdentity,
	presentation: MandateViChainPresentation,
	kekBase64: string,
	cryptoImpl: Crypto = crypto,
): Promise<WrappedMandateViChain> {
	if (!presentation.l1 || !presentation.l2) throw new MandateKeyError('VI chain presentation is invalid', 'WRAP_FAILED');
	const plaintext = new TextEncoder().encode(JSON.stringify(presentation));
	try {
		return await wrap(cryptoImpl, kekBase64, identity, 'vi-chain', plaintext);
	} finally {
		plaintext.fill(0);
	}
}

/** Encrypt a VI chain with an already imported, non-extractable KMS KEK. */
export async function wrapMandateViChainWithCryptoKey(
	identity: MandateKeyIdentity,
	presentation: MandateViChainPresentation,
	kek: CryptoKey,
	cryptoImpl: Crypto = crypto,
): Promise<WrappedMandateViChain> {
	if (!presentation.l1 || !presentation.l2) throw new MandateKeyError('VI chain presentation is invalid', 'WRAP_FAILED');
	const plaintext = new TextEncoder().encode(JSON.stringify(presentation));
	try {
		return await wrapWithCryptoKey(cryptoImpl, kek, identity, 'vi-chain', plaintext);
	} finally {
		plaintext.fill(0);
	}
}

/** Decrypt an internal VI chain presentation for MH4 transport only. */
export async function unwrapMandateViChain(
	identity: MandateKeyIdentity,
	wrapped: WrappedMandateViChain,
	kekBase64: string,
	cryptoImpl: Crypto = crypto,
): Promise<MandateViChainPresentation> {
	const rawKek = decodeKek(kekBase64);
	let plaintext: ArrayBuffer;
	try {
		const key = await cryptoImpl.subtle.importKey('raw', rawKek, 'AES-GCM', false, ['decrypt']);
		plaintext = await cryptoImpl.subtle.decrypt(
			{ name: 'AES-GCM', iv: new Uint8Array(wrapped.iv), additionalData: aad(identity, 'vi-chain') },
			key,
			wrapped.ciphertext,
		);
	} catch {
		throw new MandateKeyError('VI chain unwrapping failed', 'WRAP_FAILED');
	} finally {
		rawKek.fill(0);
	}
	const bytes = new Uint8Array(plaintext);
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid chain');
		const chain = value as Record<string, unknown>;
		if (typeof chain.l1 !== 'string' || !chain.l1 || typeof chain.l2 !== 'string' || !chain.l2) {
			throw new TypeError('invalid chain');
		}
		return { l1: chain.l1, l2: chain.l2 };
	} catch {
		throw new MandateKeyError('VI chain unwrapping failed', 'WRAP_FAILED');
	} finally {
		bytes.fill(0);
	}
}

/** Decrypt a VI chain with an already imported, non-extractable KMS KEK. */
export async function unwrapMandateViChainWithCryptoKey(
	identity: MandateKeyIdentity,
	wrapped: WrappedMandateViChain,
	kek: CryptoKey,
	cryptoImpl: Crypto = crypto,
): Promise<MandateViChainPresentation> {
	validateKekCryptoKey(kek, 'decrypt');
	let plaintext: ArrayBuffer;
	try {
		plaintext = await cryptoImpl.subtle.decrypt(
			{ name: 'AES-GCM', iv: new Uint8Array(wrapped.iv), additionalData: aad(identity, 'vi-chain') },
			kek,
			wrapped.ciphertext,
		);
	} catch {
		throw new MandateKeyError('VI chain unwrapping failed', 'WRAP_FAILED');
	}
	const bytes = new Uint8Array(plaintext);
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid chain');
		const chain = value as Record<string, unknown>;
		if (typeof chain.l1 !== 'string' || !chain.l1 || typeof chain.l2 !== 'string' || !chain.l2) {
			throw new TypeError('invalid chain');
		}
		return { l1: chain.l1, l2: chain.l2 };
	} catch {
		throw new MandateKeyError('VI chain unwrapping failed', 'WRAP_FAILED');
	} finally {
		bytes.fill(0);
	}
}

function publicAgentJwk(jwk: JsonWebKey): JsonObject {
	if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
		throw new MandateKeyError('Agent key generation failed', 'GENERATION_FAILED');
	}
	return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

type WrapSecret = (
	purpose: WrappedPurpose,
	plaintext: Uint8Array,
) => Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }>;

async function createWrappedMandateKeysUsingWrap(
	identity: MandateKeyIdentity,
	merchantIds: readonly string[],
	wrapSecret: WrapSecret,
	overrides: Partial<MandateKeyDependencies> = {},
): Promise<WrappedMandateKeys> {
	if (new Set(merchantIds).size !== merchantIds.length || merchantIds.some((id) => id.length === 0)) {
		throw new MandateKeyError('Merchant ids must be nonempty and unique', 'INVALID_IDENTITY');
	}
	const cryptoImpl = overrides.crypto ?? crypto;
	const generateClaimWallet = overrides.generateClaimWallet ?? (() => Wallet.generate(ECDSA.ed25519));
	let pair: CryptoKeyPair;
	try {
		pair = await cryptoImpl.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
	} catch {
		throw new MandateKeyError('Agent key generation failed', 'GENERATION_FAILED');
	}
	const publicJwk = publicAgentJwk(await cryptoImpl.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey);
	const privateJwkBytes = new TextEncoder().encode(JSON.stringify(await cryptoImpl.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey));
	const claimSecrets: Array<{ merchant_id: string; seed: string }> = [];
	const claimPublicKeys: Array<{ merchant_id: string; public_key: string }> = [];
	try {
		for (const merchantId of merchantIds) {
			const wallet = generateClaimWallet();
			if (!wallet.seed || !wallet.publicKey) throw new MandateKeyError('Claim key generation failed', 'GENERATION_FAILED');
			claimSecrets.push({ merchant_id: merchantId, seed: wallet.seed });
			claimPublicKeys.push({ merchant_id: merchantId, public_key: wallet.publicKey });
		}
		const claimBytes = new TextEncoder().encode(JSON.stringify(claimSecrets));
		try {
			const [agent, claims] = await Promise.all([
				wrapSecret('agent', privateJwkBytes),
				wrapSecret('claims', claimBytes),
			]);
			return {
				agentPublicJwk: publicJwk,
				agentKeyCiphertext: agent.ciphertext,
				agentKeyIv: agent.iv,
				claimPublicKeys,
				claimKeysCiphertext: claims.ciphertext,
				claimKeysIv: claims.iv,
			};
		} finally {
			claimBytes.fill(0);
		}
	} finally {
		privateJwkBytes.fill(0);
		for (const secret of claimSecrets) secret.seed = '';
	}
}

/** Generate and AES-GCM-wrap the VI agent key and one XRPL claim key per merchant. */
export async function createWrappedMandateKeys(
	identity: MandateKeyIdentity,
	merchantIds: readonly string[],
	kekBase64: string,
	overrides: Partial<MandateKeyDependencies> = {},
): Promise<WrappedMandateKeys> {
	const cryptoImpl = overrides.crypto ?? crypto;
	return createWrappedMandateKeysUsingWrap(
		identity,
		merchantIds,
		(purpose, plaintext) => wrap(cryptoImpl, kekBase64, identity, purpose, plaintext),
		overrides,
	);
}

/** Generate and wrap mandate keys with an already imported, non-extractable KMS KEK. */
export async function createWrappedMandateKeysWithCryptoKey(
	identity: MandateKeyIdentity,
	merchantIds: readonly string[],
	kek: CryptoKey,
	overrides: Partial<MandateKeyDependencies> = {},
): Promise<WrappedMandateKeys> {
	const cryptoImpl = overrides.crypto ?? crypto;
	validateKekCryptoKey(kek, 'encrypt');
	return createWrappedMandateKeysUsingWrap(
		identity,
		merchantIds,
		(purpose, plaintext) => wrapWithCryptoKey(cryptoImpl, kek, identity, purpose, plaintext, false),
		overrides,
	);
}
