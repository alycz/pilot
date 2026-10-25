import { getAddress } from 'viem';

import { Ap4mEvmValidationError } from './contracts';

export const AP4M_EVM_EVENT_PROFILE = Object.freeze({
	network: 'XRPL EVM Testnet',
	chainId: 1_449_000,
	rpcUrl: 'https://rpc.testnet.xrplevm.org',
	explorerUrl: 'https://explorer.testnet.xrplevm.org',
	paymentLedger: '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91',
	pooledEscrowVault: '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0',
	rlusdToken: '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3',
	rlusdDecimals: 18,
} as const);

export type Ap4mEvmEventProfile = typeof AP4M_EVM_EVENT_PROFILE;

function exactUrl(value: unknown, expected: string, field: string): void {
	if (value !== expected) {
		throw new Ap4mEvmValidationError(`${field} does not match the event allowlist`, 'INVALID_PROFILE');
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Ap4mEvmValidationError(`${field} is not a URL`, 'INVALID_PROFILE');
	}
	if (
		parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' ||
		parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/' || parsed.origin !== value
	) {
		throw new Ap4mEvmValidationError(`${field} is not a canonical HTTPS URL`, 'INVALID_PROFILE');
	}
}

function exactAddress(value: unknown, expected: string, field: string): void {
	if (typeof value !== 'string') {
		throw new Ap4mEvmValidationError(`${field} is missing`, 'INVALID_PROFILE');
	}
	try {
		if (value !== expected || getAddress(value) !== getAddress(expected)) throw new Error('mismatch');
	} catch {
		throw new Ap4mEvmValidationError(`${field} does not match the event allowlist`, 'INVALID_PROFILE');
	}
}

/** Remote configuration is reference data only and cannot widen this profile. */
export function validateAp4mEvmEventProfile(value: unknown): Ap4mEvmEventProfile {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Ap4mEvmValidationError('AP4M EVM profile is invalid', 'INVALID_PROFILE');
	}
	const profile = value as Record<string, unknown>;
	const expectedKeys = [
		'network', 'chainId', 'rpcUrl', 'explorerUrl', 'paymentLedger',
		'pooledEscrowVault', 'rlusdToken', 'rlusdDecimals',
	];
	if (
		Object.keys(profile).length !== expectedKeys.length ||
		expectedKeys.some((key) => !Object.hasOwn(profile, key))
	) {
		throw new Ap4mEvmValidationError('AP4M EVM profile has unexpected fields', 'INVALID_PROFILE');
	}
	if (
		profile.network !== AP4M_EVM_EVENT_PROFILE.network ||
		profile.chainId !== AP4M_EVM_EVENT_PROFILE.chainId ||
		profile.rlusdDecimals !== AP4M_EVM_EVENT_PROFILE.rlusdDecimals
	) {
		throw new Ap4mEvmValidationError('AP4M EVM profile does not match the event allowlist', 'INVALID_PROFILE');
	}
	exactUrl(profile.rpcUrl, AP4M_EVM_EVENT_PROFILE.rpcUrl, 'RPC URL');
	exactUrl(profile.explorerUrl, AP4M_EVM_EVENT_PROFILE.explorerUrl, 'explorer URL');
	exactAddress(profile.paymentLedger, AP4M_EVM_EVENT_PROFILE.paymentLedger, 'PaymentLedger');
	exactAddress(profile.pooledEscrowVault, AP4M_EVM_EVENT_PROFILE.pooledEscrowVault, 'pooled vault');
	exactAddress(profile.rlusdToken, AP4M_EVM_EVENT_PROFILE.rlusdToken, 'RLUSD token');
	return AP4M_EVM_EVENT_PROFILE;
}
