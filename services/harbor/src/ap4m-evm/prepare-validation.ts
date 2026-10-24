import { getAddress, type Address, type Hex } from 'viem';

import { decodeVoucherRedemptionCall } from './abi';
import {
	Ap4mEvmChannelSchema,
	Ap4mEvmValidationError,
	EcdsaSignatureSchema,
	Hex32Schema,
	PreparedEvmTransactionSchema,
	canonicalUint,
} from './contracts';
import { AP4M_EVM_EVENT_PROFILE } from './event-config';

export type PreparedVoucherRedemptionExpectation = Readonly<{
	from: Address;
	maxGasLimit: bigint;
	channelId: Hex;
	cumulativeAmount: string;
	signature: Hex;
}>;

function normalize(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'string' && /^0x[0-9A-Fa-f]{40}$/.test(value)) return getAddress(value);
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, normalize(nested)]),
		);
	}
	return value;
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function address(value: string, field: string): Address {
	try {
		const normalized = getAddress(value);
		const body = value.slice(2);
		if (/[a-f]/.test(body) && /[A-F]/.test(body) && normalized !== value) {
			throw new Error('invalid checksum');
		}
		if (/^0x0{40}$/i.test(normalized)) throw new Error('zero address');
		return normalized;
	} catch {
		throw new Ap4mEvmValidationError(`${field} is invalid`, 'INVALID_PREPARED_CALL');
	}
}

export function validateChannelRoles(value: unknown): ReturnType<typeof Ap4mEvmChannelSchema.parse> {
	let channel: ReturnType<typeof Ap4mEvmChannelSchema.parse>;
	try {
		channel = Ap4mEvmChannelSchema.parse(value);
	} catch {
		throw new Ap4mEvmValidationError('AP4M EVM channel is invalid', 'INVALID_PREPARED_CALL');
	}
	const agent = address(channel.agent, 'channel agent');
	const funding = address(channel.fundingWallet, 'funding wallet');
	const payout = address(channel.merchantPayout, 'merchant payout');
	if (payout === agent || payout === funding) {
		throw new Ap4mEvmValidationError(
			'Merchant payout must differ from agent and funding wallets',
			'ROLE_COLLISION',
		);
	}
	if (address(channel.token, 'channel token') !== getAddress(AP4M_EVM_EVENT_PROFILE.rlusdToken)) {
		throw new Ap4mEvmValidationError('Channel token is not event RLUSD', 'INVALID_PREPARED_CALL');
	}
	if (canonicalUint(channel.cumulativeAmount, 'channel cumulative amount') > canonicalUint(channel.cap, 'channel cap')) {
		throw new Ap4mEvmValidationError('Channel cumulative amount exceeds its cap', 'VOUCHER_OVER_CAP');
	}
	return channel;
}

/** Validate a service-prepared transaction against a code-owned ABI and exact intent. */
export function validatePreparedVoucherRedemption(
	value: unknown,
	expected: PreparedVoucherRedemptionExpectation,
): Readonly<{ transaction: ReturnType<typeof PreparedEvmTransactionSchema.parse>; args: readonly unknown[] }> {
	let transaction: ReturnType<typeof PreparedEvmTransactionSchema.parse>;
	try {
		transaction = PreparedEvmTransactionSchema.parse(value);
	} catch {
		throw new Ap4mEvmValidationError('Prepared AP4M transaction is invalid', 'INVALID_PREPARED_CALL');
	}
	const expectedFrom = address(expected.from, 'expected sender');
	const expectedTo = getAddress(AP4M_EVM_EVENT_PROFILE.paymentLedger);
	const cumulativeAmount = canonicalUint(expected.cumulativeAmount, 'authorized cumulative amount');
	if (
		!Hex32Schema.safeParse(expected.channelId).success ||
		!EcdsaSignatureSchema.safeParse(expected.signature).success ||
		expected.maxGasLimit < 1n ||
		transaction.chainId !== AP4M_EVM_EVENT_PROFILE.chainId ||
		address(transaction.from, 'transaction sender') !== expectedFrom ||
		address(transaction.to, 'transaction target') !== expectedTo ||
		canonicalUint(transaction.value, 'transaction value') !== 0n ||
		canonicalUint(transaction.gasLimit, 'transaction gas limit') > expected.maxGasLimit
	) {
		throw new Ap4mEvmValidationError(
			'Prepared AP4M transaction does not match the authorized operation',
			'INVALID_PREPARED_CALL',
		);
	}
	const decoded = decodeVoucherRedemptionCall(transaction.data as Hex);
	const expectedArgs = [expected.channelId, cumulativeAmount, expected.signature];
	if (!equal(decoded.args, expectedArgs)) {
		throw new Ap4mEvmValidationError(
			'Prepared AP4M transaction arguments do not match the authorized operation',
			'INVALID_PREPARED_CALL',
		);
	}
	return { transaction, args: decoded.args };
}
