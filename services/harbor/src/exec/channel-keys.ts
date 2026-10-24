import { signPaymentChannelClaim, Wallet } from 'xrpl';

import type { MandateKeyIdentity } from './mandate-keys';

const KEK_BYTES = 32;
const IV_BYTES = 12;
const CHANNEL_ID = /^[A-F0-9]{64}$/;
const POSITIVE_DROPS = /^[1-9]\d*$/;
const PUBLIC_KEY = /^(?:ED|02|03)[A-F0-9]{64}$/;
const MAX_DROPS = 100_000_000_000_000_000n;

export interface WrappedMandateClaimKeys {
	ciphertext: ArrayBuffer;
	iv: ArrayBuffer;
	publicKeys: readonly { merchant_id: string; public_key: string }[];
}

export interface MandateClaimSigner {
	readonly publicKey: string;
	sign(channelId: string, cumulativeDrops: string): string;
}

export class ChannelKeyError extends Error {
	constructor(
		message: string,
		readonly code: 'INVALID_IDENTITY' | 'INVALID_KEK' | 'INVALID_WRAPPED_KEY' | 'CLAIM_KEY_NOT_FOUND' | 'SIGN_FAILED',
	) {
		super(message);
		this.name = 'ChannelKeyError';
	}
}

function decodeKek(value: string): Uint8Array {
	try {
		if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new TypeError('invalid base64');
		const decoded = atob(value);
		if (decoded.length !== KEK_BYTES) throw new TypeError('invalid length');
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		throw new ChannelKeyError('HARBOR_KEK must be a 32-byte base64 value', 'INVALID_KEK');
	}
}

function validateKekCryptoKey(key: CryptoKey): void {
	const algorithm = key?.algorithm as { name?: unknown; length?: unknown } | undefined;
	if (
		key?.type !== 'secret' || algorithm?.name !== 'AES-GCM' ||
		algorithm.length !== KEK_BYTES * 8 || key.extractable || !key.usages.includes('decrypt')
	) {
		throw new ChannelKeyError(
			'KMS KEK must be a non-extractable 256-bit AES-GCM decryption key',
			'INVALID_KEK',
		);
	}
}

/** Match the frozen MH2 `claims` wrapping AAD exactly. */
function claimsAad(identity: MandateKeyIdentity): Uint8Array {
	if (
		!identity.principal || identity.principal.length > 256 || identity.principal.includes('\0') ||
		!identity.owner || identity.owner.length > 64 || identity.owner.includes('\0') ||
		!identity.mandateId || identity.mandateId.length > 128 || identity.mandateId.includes('\0') ||
		identity.network !== 'testnet'
	) {
		throw new ChannelKeyError('Mandate claim-key identity is invalid', 'INVALID_IDENTITY');
	}
	return new TextEncoder().encode(JSON.stringify([
		identity.principal,
		identity.owner,
		identity.network,
		identity.mandateId,
		'claims',
	]));
}

function canonicalMerchantId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new ChannelKeyError('Merchant claim-key identity is invalid', 'INVALID_IDENTITY');
	}
	return value;
}

function parseClaimSecrets(value: unknown): Array<{ merchant_id: string; seed: string }> {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
		throw new ChannelKeyError('Wrapped claim keys are invalid', 'INVALID_WRAPPED_KEY');
	}
	const merchants = new Set<string>();
	return value.map((entry) => {
		if (
			!entry || typeof entry !== 'object' || Array.isArray(entry) ||
			Object.keys(entry).some((key) => key !== 'merchant_id' && key !== 'seed')
		) {
			throw new ChannelKeyError('Wrapped claim keys are invalid', 'INVALID_WRAPPED_KEY');
		}
		const item = entry as Record<string, unknown>;
		if (typeof item.merchant_id !== 'string' || typeof item.seed !== 'string' || item.seed.length > 128) {
			throw new ChannelKeyError('Wrapped claim keys are invalid', 'INVALID_WRAPPED_KEY');
		}
		const merchantId = canonicalMerchantId(item.merchant_id);
		if (merchants.has(merchantId)) {
			throw new ChannelKeyError('Wrapped claim keys contain duplicate merchants', 'INVALID_WRAPPED_KEY');
		}
		merchants.add(merchantId);
		return { merchant_id: merchantId, seed: item.seed };
	});
}

function validateClaimInput(channelId: string, cumulativeDrops: string): void {
	if (!CHANNEL_ID.test(channelId) || cumulativeDrops.length > 18 || !POSITIVE_DROPS.test(cumulativeDrops)) {
		throw new ChannelKeyError('Payment-channel claim is invalid', 'SIGN_FAILED');
	}
	const drops = BigInt(cumulativeDrops);
	if (drops > MAX_DROPS) throw new ChannelKeyError('Payment-channel claim is invalid', 'SIGN_FAILED');
}

function retireWallet(wallet: Wallet): void {
	try {
		const mutable = wallet as unknown as { privateKey?: string; seed?: string };
		mutable.privateKey = '';
		mutable.seed = undefined;
	} catch {
		// The narrow signer is retired separately, so a frozen wallet cannot escape.
	}
}

function dropsToExactXrp(drops: string): string {
	const padded = drops.padStart(7, '0');
	const whole = padded.slice(0, -6);
	const fraction = padded.slice(-6).replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Decrypt one mandate claim key only for the duration of a callback.
 *
 * The key keeps MH2's legacy HARBOR_KEK AES-GCM wrapping and is never returned
 * as a seed or private key. Payment-channel signing semantics:
 * https://xrpl.org/docs/concepts/payment-types/payment-channels#claiming-xrp-from-a-payment-channel
 */
export async function withMandateClaimSigner<T>(
	identity: MandateKeyIdentity,
	wrapped: WrappedMandateClaimKeys,
	merchantId: string,
	kek: CryptoKey | string,
	callback: (signer: MandateClaimSigner) => Promise<T>,
	cryptoImpl: Crypto = crypto,
): Promise<T> {
	const selectedMerchant = canonicalMerchantId(merchantId);
	if (
		!(wrapped.ciphertext instanceof ArrayBuffer) || wrapped.ciphertext.byteLength < 17 ||
		!(wrapped.iv instanceof ArrayBuffer) || wrapped.iv.byteLength !== IV_BYTES ||
		!Array.isArray(wrapped.publicKeys)
	) {
		throw new ChannelKeyError('Wrapped claim keys are invalid', 'INVALID_WRAPPED_KEY');
	}
	const publicMatches = wrapped.publicKeys.filter((entry) =>
		entry.merchant_id === selectedMerchant && PUBLIC_KEY.test(entry.public_key));
	if (publicMatches.length !== 1) {
		throw new ChannelKeyError('Merchant claim key was not found', 'CLAIM_KEY_NOT_FOUND');
	}

	let rawKek: Uint8Array | undefined;
	let plaintext: ArrayBuffer;
	try {
		let key: CryptoKey;
		if (typeof kek === 'string') {
			rawKek = decodeKek(kek);
			key = await cryptoImpl.subtle.importKey('raw', rawKek, 'AES-GCM', false, ['decrypt']);
		} else {
			validateKekCryptoKey(kek);
			key = kek;
		}
		plaintext = await cryptoImpl.subtle.decrypt({
			name: 'AES-GCM',
			iv: new Uint8Array(wrapped.iv),
			additionalData: claimsAad(identity),
		}, key, wrapped.ciphertext);
	} catch (error) {
		if (error instanceof ChannelKeyError) throw error;
		throw new ChannelKeyError('Wrapped claim keys could not be decrypted', 'INVALID_WRAPPED_KEY');
	} finally {
		rawKek?.fill(0);
	}

	const bytes = new Uint8Array(plaintext);
	let secrets: Array<{ merchant_id: string; seed: string }> = [];
	try {
		try {
			secrets = parseClaimSecrets(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
		} catch (error) {
			if (error instanceof ChannelKeyError) throw error;
			throw new ChannelKeyError('Wrapped claim keys are invalid', 'INVALID_WRAPPED_KEY');
		}
		const matches = secrets.filter((entry) => entry.merchant_id === selectedMerchant);
		if (matches.length !== 1) {
			throw new ChannelKeyError('Merchant claim key was not found', 'CLAIM_KEY_NOT_FOUND');
		}
		let wallet: Wallet;
		try {
			wallet = Wallet.fromSeed(matches[0]!.seed);
		} catch {
			throw new ChannelKeyError('Wrapped claim key is invalid', 'INVALID_WRAPPED_KEY');
		}
		if (wallet.publicKey !== publicMatches[0]!.public_key) {
			throw new ChannelKeyError('Wrapped claim key does not match its public key', 'INVALID_WRAPPED_KEY');
		}
		let active = true;
		const signer: MandateClaimSigner = Object.freeze({
			publicKey: wallet.publicKey,
			sign(channelId: string, cumulativeDrops: string) {
				if (!active) {
					throw new ChannelKeyError('Payment-channel claim signer is no longer available', 'SIGN_FAILED');
				}
				validateClaimInput(channelId, cumulativeDrops);
				try {
					return signPaymentChannelClaim(
						channelId,
						dropsToExactXrp(cumulativeDrops),
						wallet.privateKey,
					).toUpperCase();
				} catch {
					throw new ChannelKeyError('Payment-channel claim signing failed', 'SIGN_FAILED');
				}
			},
		});
		try {
			return await callback(signer);
		} finally {
			active = false;
			retireWallet(wallet);
		}
	} finally {
		bytes.fill(0);
		for (const secret of secrets) secret.seed = '';
	}
}
