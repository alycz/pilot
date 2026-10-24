import { ECDSA, Wallet, isValidClassicAddress, type Transaction } from 'xrpl';

import type { Network } from '../contracts';

const AES_GCM_IV_BYTES = 12;
const KEK_BYTES = 32;

const FAUCET_URLS = {
	testnet: 'https://faucet.altnet.rippletest.net/accounts',
	devnet: 'https://faucet.devnet.rippletest.net/accounts',
} as const;

export interface DelegateIdentity {
	principal: string;
	owner: string;
	network: Network;
}

/** The encrypted fields persisted by the links table. */
export interface StoredDelegateKey {
	address: string;
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
	/** Present on freshly generated keys; derivable after an in-memory unwrap. */
	publicKey?: string;
}

/** Fresh-key result, including all safe public material. */
export interface WrappedDelegateKey extends StoredDelegateKey {
	publicKey: string;
}

export interface SignedTransaction {
	tx_blob: string;
	hash: string;
}

/**
 * The callback gets only the operations needed by the execution layer. In
 * particular, it never gets the Wallet, seed, or private key.
 */
export interface DelegateSigner {
	readonly address: string;
	readonly publicKey: string;
	sign(transaction: Transaction, multisign?: boolean | string): Promise<SignedTransaction>;
}

export interface DelegateWallet {
	readonly classicAddress: string;
	readonly publicKey: string;
	readonly privateKey: string;
	readonly seed?: string;
	sign(transaction: Transaction, multisign?: boolean | string): SignedTransaction;
}

export interface WalletProvider {
	generate(algorithm: ECDSA): DelegateWallet;
	fromSeed(seed: string, options: { algorithm: ECDSA }): DelegateWallet;
}

export interface KeyDependencies {
	crypto: Crypto;
	fetch: typeof fetch;
	wallet: WalletProvider;
}

export interface FaucetFundingResult {
	address: string;
	network: 'testnet' | 'devnet';
}

export class DelegateKeyError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_IDENTITY'
			| 'INVALID_KEK'
			| 'KEY_GENERATION_FAILED'
			| 'KEY_WRAP_FAILED'
			| 'KEY_UNWRAP_FAILED'
			| 'KEY_MISMATCH',
	) {
		super(message);
		this.name = 'DelegateKeyError';
	}
}

export class FaucetFundingError extends Error {
	constructor(
		message: string,
		readonly code: 'UNSUPPORTED_NETWORK' | 'INVALID_ADDRESS' | 'REQUEST_FAILED',
	) {
		super(message);
		this.name = 'FaucetFundingError';
	}
}

const defaultWalletProvider: WalletProvider = {
	generate: (algorithm) => Wallet.generate(algorithm),
	fromSeed: (seed, options) => Wallet.fromSeed(seed, options),
};

function dependencies(overrides: Partial<KeyDependencies> = {}): KeyDependencies {
	return {
		crypto: overrides.crypto ?? crypto,
		fetch: overrides.fetch ?? globalThis.fetch,
		wallet: overrides.wallet ?? defaultWalletProvider,
	};
}

function validateIdentity(identity: DelegateIdentity): void {
	if (identity.principal.length === 0 || identity.owner.length === 0) {
		throw new DelegateKeyError('Delegate key identity is invalid', 'INVALID_IDENTITY');
	}
}

function identityAdditionalData(identity: DelegateIdentity): Uint8Array {
	validateIdentity(identity);
	// Authenticated additional data binds a wrapped key to its D1 uniqueness
	// tuple so ciphertext cannot be copied between principals or account links.
	return new TextEncoder().encode(JSON.stringify([identity.principal, identity.owner, identity.network]));
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function decodeKek(kekBase64: string): Uint8Array {
	try {
		// A 32-byte value has exactly 43 base64 data characters and one padding
		// character. Requiring the canonical form also rejects accidental text.
		if (!/^[A-Za-z0-9+/]{43}=$/.test(kekBase64)) {
			throw new TypeError('invalid base64');
		}
		const decoded = atob(kekBase64);
		if (decoded.length !== KEK_BYTES) throw new TypeError('invalid key length');
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		throw new DelegateKeyError('HARBOR_KEK must be a 32-byte base64 value', 'INVALID_KEK');
	}
}

async function importKek(cryptoImpl: Crypto, kekBase64: string, usages: Array<'encrypt' | 'decrypt'>): Promise<CryptoKey> {
	const raw = decodeKek(kekBase64);
	try {
		return await cryptoImpl.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
	} catch {
		throw new DelegateKeyError('HARBOR_KEK could not be imported', 'INVALID_KEK');
	} finally {
		raw.fill(0);
	}
}

type KekUsage = 'encrypt' | 'decrypt';
type KekLoader = (deps: KeyDependencies) => CryptoKey | Promise<CryptoKey>;

function validateKekCryptoKey(key: CryptoKey, requiredUsage: KekUsage): void {
	const algorithm = key?.algorithm as { name?: unknown; length?: unknown } | undefined;
	if (
		key?.type !== 'secret' ||
		algorithm?.name !== 'AES-GCM' ||
		algorithm.length !== KEK_BYTES * 8 ||
		key.extractable ||
		!key.usages.includes(requiredUsage)
	) {
		throw new DelegateKeyError(
			`KMS KEK must be a non-extractable 256-bit AES-GCM key with ${requiredUsage} usage`,
			'INVALID_KEK',
		);
	}
}

function retireWallet(wallet: DelegateWallet): void {
	// JavaScript strings cannot be reliably zeroized. Remove our references as
	// soon as possible and wipe mutable test/provider implementations where the
	// runtime permits it.
	try {
		const mutable = wallet as unknown as { privateKey?: string; seed?: string };
		mutable.privateKey = '';
		mutable.seed = undefined;
	} catch {
		// A frozen injected implementation is still safe because it never escapes.
	}
}

/**
 * Generate one Ed25519 XRPL delegate and wrap its seed using non-extractable
 * AES-GCM key material. AES-GCM requires a unique IV for every encryption with
 * a given key; a fresh 96-bit IV is generated for every call.
 *
 * AES-GCM: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt#aes-gcm
 * XRPL Wallet: https://js.xrpl.org/classes/Wallet.html
 */
async function createWrappedDelegateKeyUsingKek(
	identity: DelegateIdentity,
	loadKek: KekLoader,
	overrides: Partial<KeyDependencies> = {},
): Promise<WrappedDelegateKey> {
	const deps = dependencies(overrides);
	const additionalData = identityAdditionalData(identity);
	let wallet: DelegateWallet;
	try {
		wallet = deps.wallet.generate(ECDSA.ed25519);
	} catch {
		throw new DelegateKeyError('Delegate key generation failed', 'KEY_GENERATION_FAILED');
	}

	try {
		if (wallet.seed === undefined || wallet.seed.length === 0) {
			throw new DelegateKeyError('Delegate key generation failed', 'KEY_GENERATION_FAILED');
		}
		const seedBytes = new TextEncoder().encode(wallet.seed);
		try {
			const key = await loadKek(deps);
			validateKekCryptoKey(key, 'encrypt');
			const iv = deps.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
			let ciphertext: ArrayBuffer;
			try {
				// The seed is encrypted at rest and is never part of this function's result.
				ciphertext = await deps.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, seedBytes);
			} catch {
				throw new DelegateKeyError('Delegate key wrapping failed', 'KEY_WRAP_FAILED');
			}
			return {
				address: wallet.classicAddress,
				publicKey: wallet.publicKey,
				ciphertext,
				iv: copyBuffer(iv),
			};
		} finally {
			seedBytes.fill(0);
		}
	} finally {
		retireWallet(wallet);
	}
}

export async function createWrappedDelegateKey(
	identity: DelegateIdentity,
	kekBase64: string,
	overrides: Partial<KeyDependencies> = {},
): Promise<WrappedDelegateKey> {
	return createWrappedDelegateKeyUsingKek(
		identity,
		(deps) => importKek(deps.crypto, kekBase64, ['encrypt']),
		overrides,
	);
}

/**
 * Internal integration seam for a KEK imported from a KMS Decrypt result.
 * The key must already be non-extractable; this module never exports it.
 */
export async function createWrappedDelegateKeyWithCryptoKey(
	identity: DelegateIdentity,
	kek: CryptoKey,
	overrides: Partial<KeyDependencies> = {},
): Promise<WrappedDelegateKey> {
	return createWrappedDelegateKeyUsingKek(identity, () => kek, overrides);
}

/**
 * Decrypt a delegate only for the duration of a callback. The callback gets a
 * narrow signer facade, not an xrpl Wallet, so it cannot inspect or export the
 * delegate seed or private key.
 */
async function withDelegateSignerUsingKek<T>(
	identity: DelegateIdentity,
	wrapped: StoredDelegateKey,
	loadKek: KekLoader,
	callback: (signer: DelegateSigner) => T | Promise<T>,
	overrides: Partial<KeyDependencies> = {},
): Promise<T> {
	const deps = dependencies(overrides);
	const additionalData = identityAdditionalData(identity);
	const key = await loadKek(deps);
	validateKekCryptoKey(key, 'decrypt');
	let plaintext: ArrayBuffer;
	try {
		// MDN: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/decrypt
		plaintext = await deps.crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: new Uint8Array(wrapped.iv), additionalData },
			key,
			wrapped.ciphertext,
		);
	} catch {
		throw new DelegateKeyError('Delegate key could not be unwrapped', 'KEY_UNWRAP_FAILED');
	}

	const plaintextBytes = new Uint8Array(plaintext);
	let wallet: DelegateWallet;
	try {
		try {
			wallet = deps.wallet.fromSeed(new TextDecoder().decode(plaintextBytes), { algorithm: ECDSA.ed25519 });
		} catch {
			throw new DelegateKeyError('Delegate key could not be unwrapped', 'KEY_UNWRAP_FAILED');
		}
	} finally {
		plaintextBytes.fill(0);
	}

	try {
		if (
			wallet.classicAddress !== wrapped.address ||
			(wrapped.publicKey !== undefined && wallet.publicKey !== wrapped.publicKey)
		) {
			throw new DelegateKeyError('Wrapped delegate does not match its public identity', 'KEY_MISMATCH');
		}
		const signer: DelegateSigner = Object.freeze({
			address: wallet.classicAddress,
			publicKey: wallet.publicKey,
			sign: async (transaction: Transaction, multisign?: boolean | string) => wallet.sign(transaction, multisign),
		});
		return await callback(signer);
	} finally {
		retireWallet(wallet);
	}
}

export async function withDelegateSigner<T>(
	identity: DelegateIdentity,
	wrapped: StoredDelegateKey,
	kekBase64: string,
	callback: (signer: DelegateSigner) => T | Promise<T>,
	overrides: Partial<KeyDependencies> = {},
): Promise<T> {
	return withDelegateSignerUsingKek(
		identity,
		wrapped,
		(deps) => importKek(deps.crypto, kekBase64, ['decrypt']),
		callback,
		overrides,
	);
}

/**
 * Internal integration seam for signing with a KEK imported from KMS. The
 * plaintext seed exists only during the callback setup and is zeroed exactly
 * as it is on the legacy HARBOR_KEK path.
 */
export async function withDelegateSignerWithCryptoKey<T>(
	identity: DelegateIdentity,
	wrapped: StoredDelegateKey,
	kek: CryptoKey,
	callback: (signer: DelegateSigner) => T | Promise<T>,
	overrides: Partial<KeyDependencies> = {},
): Promise<T> {
	return withDelegateSignerUsingKek(identity, wrapped, () => kek, callback, overrides);
}

/**
 * Fund an existing delegate address using only the official testnet/devnet
 * faucets. The response body is deliberately ignored because faucet responses
 * must never become another route for secret material.
 *
 * Faucet request shape: https://xrpl.org/resources/dev-tools/xrp-faucets
 */
export async function fundDelegateAccount(
	address: string,
	network: Network,
	overrides: Pick<Partial<KeyDependencies>, 'fetch'> = {},
): Promise<FaucetFundingResult> {
	if (network !== 'testnet' && network !== 'devnet') {
		throw new FaucetFundingError('Delegate faucet funding is allowed only on testnet or devnet', 'UNSUPPORTED_NETWORK');
	}
	if (!isValidClassicAddress(address)) {
		throw new FaucetFundingError('Delegate address is invalid', 'INVALID_ADDRESS');
	}

	const fetchImpl = overrides.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await fetchImpl(FAUCET_URLS[network], {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ destination: address }),
		});
	} catch {
		throw new FaucetFundingError('Delegate faucet request failed', 'REQUEST_FAILED');
	}
	if (!response.ok) {
		throw new FaucetFundingError(`Delegate faucet request failed with HTTP ${response.status}`, 'REQUEST_FAILED');
	}

	return { address, network };
}
