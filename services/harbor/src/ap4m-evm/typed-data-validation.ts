import {
	getAddress,
	hashTypedData,
	recoverTypedDataAddress,
	type Address,
	type Hex,
	type TypedData,
} from 'viem';

import {
	Ap4mEvmValidationError,
	EcdsaSignatureSchema,
	Hex32Schema,
	canonicalUint,
} from './contracts';
import { AP4M_EVM_EVENT_PROFILE } from './event-config';

export const AP4M_VOUCHER_TYPES = Object.freeze({
	Voucher: [
		{ name: 'channelId', type: 'bytes32' },
		{ name: 'cumulativeAmount', type: 'uint256' },
	],
} as const);

export const AP4M_TYPED_DATA_DOMAIN = Object.freeze({
	name: 'AP4M Payment Ledger',
	version: '1',
	chainId: AP4M_EVM_EVENT_PROFILE.chainId,
	verifyingContract: AP4M_EVM_EVENT_PROFILE.paymentLedger,
} as const);

export type VoucherEnvelope = Readonly<{
	domain: {
		name: string;
		version: string;
		chainId: number;
		verifyingContract: Address;
	};
	primaryType: 'Voucher';
	types: typeof AP4M_VOUCHER_TYPES;
	message: { channelId: Hex; cumulativeAmount: string };
}>;

function exactLedgerAddress(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	try {
		const normalized = getAddress(value);
		const body = value.slice(2);
		if (/[a-f]/.test(body) && /[A-F]/.test(body) && normalized !== value) return false;
		return normalized === getAddress(AP4M_TYPED_DATA_DOMAIN.verifyingContract);
	} catch {
		return false;
	}
}

function exactVoucherEnvelope(value: unknown): VoucherEnvelope {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Ap4mEvmValidationError('Voucher typed data is invalid', 'INVALID_TYPED_DATA');
	}
	const envelope = value as Record<string, unknown>;
	const domain = envelope.domain as Record<string, unknown> | undefined;
	const message = envelope.message as Record<string, unknown> | undefined;
	if (
		Object.keys(envelope).length !== 4 || envelope.primaryType !== 'Voucher' ||
		JSON.stringify(envelope.types) !== JSON.stringify(AP4M_VOUCHER_TYPES) ||
		!domain || Object.keys(domain).length !== 4 ||
		domain.name !== AP4M_TYPED_DATA_DOMAIN.name ||
		domain.version !== AP4M_TYPED_DATA_DOMAIN.version ||
		domain.chainId !== AP4M_TYPED_DATA_DOMAIN.chainId ||
		!exactLedgerAddress(domain.verifyingContract) ||
		!message || Object.keys(message).length !== 2 ||
		typeof message.channelId !== 'string' || !Hex32Schema.safeParse(message.channelId).success ||
		typeof message.cumulativeAmount !== 'string'
	) {
		throw new Ap4mEvmValidationError('Voucher typed data does not match the event domain', 'INVALID_TYPED_DATA');
	}
	canonicalUint(message.cumulativeAmount, 'voucher cumulative amount', 'INVALID_TYPED_DATA');
	return value as VoucherEnvelope;
}

export async function validateVoucherTypedData(input: Readonly<{
	envelope: unknown;
	expectedChannelId: Hex;
	previousCumulativeAmount: string;
	channelCap: string;
	expectedSigner?: Address;
	signature?: Hex;
}>): Promise<Readonly<{ digest: Hex; cumulativeAmount: bigint; signer?: Address }>> {
	const envelope = exactVoucherEnvelope(input.envelope);
	if (envelope.message.channelId.toLowerCase() !== input.expectedChannelId.toLowerCase()) {
		throw new Ap4mEvmValidationError('Voucher channel does not match', 'INVALID_TYPED_DATA');
	}
	const cumulative = canonicalUint(envelope.message.cumulativeAmount, 'voucher cumulative amount', 'INVALID_TYPED_DATA');
	const previous = canonicalUint(input.previousCumulativeAmount, 'previous voucher cumulative amount', 'INVALID_TYPED_DATA');
	const cap = canonicalUint(input.channelCap, 'channel cap', 'INVALID_TYPED_DATA');
	if (cumulative <= previous) {
		throw new Ap4mEvmValidationError('Voucher cumulative amount is not monotonic', 'VOUCHER_REPLAY');
	}
	if (cumulative > cap) {
		throw new Ap4mEvmValidationError('Voucher cumulative amount exceeds channel cap', 'VOUCHER_OVER_CAP');
	}
	if ((input.signature === undefined) !== (input.expectedSigner === undefined)) {
		throw new Ap4mEvmValidationError('Voucher signature and signer must be supplied together', 'INVALID_TYPED_DATA');
	}
	if (input.signature !== undefined && !EcdsaSignatureSchema.safeParse(input.signature).success) {
		throw new Ap4mEvmValidationError('Voucher signature must be 65 bytes', 'INVALID_TYPED_DATA');
	}
	const typedData = {
		domain: AP4M_TYPED_DATA_DOMAIN,
		types: AP4M_VOUCHER_TYPES as unknown as TypedData,
		primaryType: 'Voucher',
		message: { channelId: envelope.message.channelId, cumulativeAmount: cumulative },
	} as const;
	let digest: Hex;
	try {
		digest = hashTypedData(typedData);
	} catch {
		throw new Ap4mEvmValidationError('Voucher typed data cannot be hashed', 'INVALID_TYPED_DATA');
	}
	if (!input.signature || !input.expectedSigner) return { digest, cumulativeAmount: cumulative };
	let signer: Address;
	try {
		signer = await recoverTypedDataAddress({ ...typedData, signature: input.signature });
	} catch {
		throw new Ap4mEvmValidationError('Voucher signature is invalid', 'INVALID_TYPED_DATA');
	}
	let signerMatches = false;
	try {
		signerMatches = getAddress(signer) === getAddress(input.expectedSigner);
	} catch {
		throw new Ap4mEvmValidationError('Voucher expected signer is invalid', 'INVALID_TYPED_DATA');
	}
	if (!signerMatches) {
		throw new Ap4mEvmValidationError('Voucher signer does not match the channel agent', 'INVALID_TYPED_DATA');
	}
	return { digest, cumulativeAmount: cumulative, signer };
}

/**
 * The official public material does not specify a close-channel EIP-712 type.
 * This slice therefore rejects every close purpose instead of inventing one.
 */
export function rejectUnsupportedCloseChannelPurpose(_value: unknown): never {
	throw new Ap4mEvmValidationError(
		'Close-channel typed data is unsupported until an official schema is reviewed',
		'INVALID_TYPED_DATA',
	);
}
