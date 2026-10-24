import { getAddress, type Address, type Hex } from 'viem';

import { decodeVoucherRedeemedEvent } from './abi';
import {
	Ap4mEvmValidationError,
	EvmReceiptEvidenceSchema,
	EvmAddressSchema,
	Hex32Schema,
	canonicalUint,
	type EvmReceiptEvidence,
} from './contracts';
import { AP4M_EVM_EVENT_PROFILE } from './event-config';

export type ReceiptEventExpectation = Readonly<{
	transactionHash: Hex;
	blockHash: Hex;
	channelId: Hex;
	claimId: Hex;
	agent: Address;
	fundingWallet: Address;
	merchantPayout: Address;
	token: Address;
	cumulativeAmount: string;
	incrementalAmount: string;
	minimumConfirmations: number;
	latestBlockNumber: number;
}>;

function sameAddress(left: string, right: string): boolean {
	try {
		const normalized = getAddress(left);
		const body = left.slice(2);
		if (/[a-f]/.test(body) && /[A-F]/.test(body) && normalized !== left) return false;
		return normalized === getAddress(right);
	} catch {
		return false;
	}
}

function checkedAddress(value: string, field: string): Address {
	try {
		const normalized = getAddress(value);
		const body = value.slice(2);
		if (/[a-f]/.test(body) && /[A-F]/.test(body) && normalized !== value) {
			throw new Error('invalid checksum');
		}
		return normalized;
	} catch {
		throw new Ap4mEvmValidationError(`${field} is invalid`, 'INVALID_RECEIPT');
	}
}

function normalize(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'string' && /^0x[0-9A-Fa-f]{40}$/.test(value)) return getAddress(value);
	if (typeof value === 'string' && /^0x[0-9A-Fa-f]+$/.test(value)) return value.toLowerCase();
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

/** Decode the complete event and require every field to match local intent. */
export function validateFinalizedReceipt(
	value: unknown,
	expected: ReceiptEventExpectation,
): Readonly<{ receipt: EvmReceiptEvidence; eventArgs: Record<string, unknown> }> {
	let receipt: EvmReceiptEvidence;
	try {
		receipt = EvmReceiptEvidenceSchema.parse(value);
	} catch {
		throw new Ap4mEvmValidationError('AP4M EVM receipt is invalid', 'INVALID_RECEIPT');
	}
	if (
		!Hex32Schema.safeParse(expected.transactionHash).success ||
		!Hex32Schema.safeParse(expected.blockHash).success ||
		!Hex32Schema.safeParse(expected.channelId).success ||
		!Hex32Schema.safeParse(expected.claimId).success ||
		!EvmAddressSchema.safeParse(expected.agent).success ||
		!EvmAddressSchema.safeParse(expected.fundingWallet).success ||
		!EvmAddressSchema.safeParse(expected.merchantPayout).success ||
		!EvmAddressSchema.safeParse(expected.token).success ||
		!Number.isSafeInteger(expected.minimumConfirmations) || expected.minimumConfirmations < 1 ||
		!Number.isSafeInteger(expected.latestBlockNumber) || expected.latestBlockNumber < receipt.blockNumber ||
		receipt.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase() ||
		receipt.blockHash.toLowerCase() !== expected.blockHash.toLowerCase()
	) {
		throw new Ap4mEvmValidationError('Receipt does not match persisted chain evidence', 'INVALID_RECEIPT');
	}
	const confirmations = expected.latestBlockNumber - receipt.blockNumber + 1;
	if (confirmations < expected.minimumConfirmations) {
		throw new Ap4mEvmValidationError('AP4M EVM receipt is not final', 'RECEIPT_PENDING');
	}
	const agent = checkedAddress(expected.agent, 'expected agent');
	const fundingWallet = checkedAddress(expected.fundingWallet, 'expected funding wallet');
	const merchantPayout = checkedAddress(expected.merchantPayout, 'expected merchant payout');
	const token = checkedAddress(expected.token, 'expected token');
	if (
		merchantPayout === agent || merchantPayout === fundingWallet ||
		token !== getAddress(AP4M_EVM_EVENT_PROFILE.rlusdToken)
	) {
		throw new Ap4mEvmValidationError('Receipt role or token binding is invalid', 'INVALID_RECEIPT');
	}
	const candidateLogs = receipt.logs.filter((log) =>
		!log.removed && sameAddress(log.address, AP4M_EVM_EVENT_PROFILE.paymentLedger),
	);
	const decoded: Array<Record<string, unknown>> = [];
	for (const log of candidateLogs) {
		try {
			const event = decodeVoucherRedeemedEvent({
				address: log.address as Address,
				topics: log.topics as Hex[],
				data: log.data as Hex,
			});
			decoded.push(event.args);
		} catch (error) {
			if (!(error instanceof Ap4mEvmValidationError)) throw error;
		}
	}
	const cumulativeAmount = canonicalUint(expected.cumulativeAmount, 'expected cumulative amount', 'INVALID_RECEIPT');
	const incrementalAmount = canonicalUint(expected.incrementalAmount, 'expected incremental amount', 'INVALID_RECEIPT');
	if (incrementalAmount < 1n || cumulativeAmount < incrementalAmount) {
		throw new Ap4mEvmValidationError('Receipt amount binding is invalid', 'INVALID_RECEIPT');
	}
	const expectedArgs = {
		channelId: expected.channelId,
		claimId: expected.claimId,
		agent,
		payout: merchantPayout,
		token,
		cumulativeAmount,
		incrementalAmount,
	};
	if (decoded.length !== 1 || !equal(decoded[0], expectedArgs)) {
		throw new Ap4mEvmValidationError(
			'AP4M EVM receipt does not contain exactly one authorized event',
			'RECEIPT_MISMATCH',
		);
	}
	return { receipt, eventArgs: decoded[0]! };
}
