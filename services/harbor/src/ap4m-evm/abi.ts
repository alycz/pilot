import {
	decodeEventLog,
	decodeFunctionData,
	parseAbi,
	type Abi,
	type Address,
	type Hex,
} from 'viem';

import { Ap4mEvmValidationError } from './contracts';

/**
 * The only contract surface supported by this initial, signerless slice.
 * Opening and closing channels stay unsupported until their published ABI is
 * independently reviewed. Callers cannot replace this ABI at runtime.
 */
export const AP4M_PAYMENT_LEDGER_ABI = parseAbi([
	'function redeemVoucher(bytes32 channelId, uint256 cumulativeAmount, bytes signature)',
	'event VoucherRedeemed(bytes32 indexed channelId, bytes32 indexed claimId, address indexed agent, address payout, address token, uint256 cumulativeAmount, uint256 incrementalAmount)',
]);

export const AP4M_REDEEM_VOUCHER_FUNCTION = 'redeemVoucher' as const;
export const AP4M_VOUCHER_REDEEMED_EVENT = 'VoucherRedeemed' as const;

type TrustedPreparedCallSpec = Readonly<{
	abi: Abi;
	functionName: string;
}>;

type TrustedEventSpec = Readonly<{
	abi: Abi;
	eventName: string;
}>;

function decodeTrustedPreparedCall(
	data: Hex,
	spec: TrustedPreparedCallSpec,
): Readonly<{ functionName: string; args: readonly unknown[] }> {
	try {
		const decoded = decodeFunctionData({ abi: spec.abi, data });
		if (decoded.functionName !== spec.functionName || !Array.isArray(decoded.args)) {
			throw new Error('unexpected function');
		}
		return { functionName: decoded.functionName, args: decoded.args };
	} catch {
		throw new Ap4mEvmValidationError(
			'Prepared AP4M call does not match the trusted ABI operation',
			'INVALID_PREPARED_CALL',
		);
	}
}

function decodeTrustedEvent(
	log: Readonly<{ address: Address; topics: readonly Hex[]; data: Hex }>,
	spec: TrustedEventSpec,
): Readonly<{ eventName: string; args: Record<string, unknown> }> {
	try {
		const decoded = decodeEventLog({
			abi: spec.abi,
			data: log.data,
			topics: log.topics as [Hex, ...Hex[]],
			strict: true,
		});
		if (decoded.eventName !== spec.eventName || typeof decoded.args !== 'object' || decoded.args === null) {
			throw new Error('unexpected event');
		}
		return { eventName: decoded.eventName, args: decoded.args as unknown as Record<string, unknown> };
	} catch {
		throw new Ap4mEvmValidationError(
			'AP4M receipt log does not match the trusted event ABI',
			'RECEIPT_MISMATCH',
		);
	}
}

export function decodeVoucherRedemptionCall(
	data: Hex,
): Readonly<{ functionName: typeof AP4M_REDEEM_VOUCHER_FUNCTION; args: readonly unknown[] }> {
	return decodeTrustedPreparedCall(data, {
		abi: AP4M_PAYMENT_LEDGER_ABI,
		functionName: AP4M_REDEEM_VOUCHER_FUNCTION,
	}) as Readonly<{ functionName: typeof AP4M_REDEEM_VOUCHER_FUNCTION; args: readonly unknown[] }>;
}

export function decodeVoucherRedeemedEvent(
	log: Readonly<{ address: Address; topics: readonly Hex[]; data: Hex }>,
): Readonly<{ eventName: typeof AP4M_VOUCHER_REDEEMED_EVENT; args: Record<string, unknown> }> {
	return decodeTrustedEvent(log, {
		abi: AP4M_PAYMENT_LEDGER_ABI,
		eventName: AP4M_VOUCHER_REDEEMED_EVENT,
	}) as Readonly<{
		eventName: typeof AP4M_VOUCHER_REDEEMED_EVENT;
		args: Record<string, unknown>;
	}>;
}
