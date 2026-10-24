import {
	encodeAbiParameters,
	encodeEventTopics,
	parseAbiParameters,
	type Address,
	type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { AP4M_PAYMENT_LEDGER_ABI } from '../src/ap4m-evm/abi';
import { AP4M_EVM_EVENT_PROFILE } from '../src/ap4m-evm/event-config';
import { validateFinalizedReceipt } from '../src/ap4m-evm/receipt-validation';

const CHANNEL = `0x${'ab'.repeat(32)}` as Hex;
const CLAIM = `0x${'cd'.repeat(32)}` as Hex;
const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const FUNDING = '0x2222222222222222222222222222222222222222' as Address;
const PAYOUT = '0x3333333333333333333333333333333333333333' as Address;
const TX_HASH = `0x${'11'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'22'.repeat(32)}` as Hex;
const EXPECTED_ARGS = {
	channelId: CHANNEL,
	claimId: CLAIM,
	agent: AGENT,
	payout: PAYOUT,
	token: AP4M_EVM_EVENT_PROFILE.rlusdToken,
	cumulativeAmount: 20n,
	incrementalAmount: 5n,
} as const;

function eventLog(overrides: Record<string, unknown> = {}) {
	return {
		address: AP4M_EVM_EVENT_PROFILE.paymentLedger,
		topics: encodeEventTopics({
			abi: AP4M_PAYMENT_LEDGER_ABI,
			eventName: 'VoucherRedeemed',
			args: { channelId: CHANNEL, claimId: CLAIM, agent: AGENT },
		}),
		data: encodeAbiParameters(
			parseAbiParameters('address payout, address token, uint256 cumulativeAmount, uint256 incrementalAmount'),
			[PAYOUT, AP4M_EVM_EVENT_PROFILE.rlusdToken, 20n, 5n],
		),
		logIndex: 0,
		removed: false,
		...overrides,
	};
}

function receipt(logs: unknown[] = [eventLog()]) {
	return {
		transactionHash: TX_HASH,
		blockHash: BLOCK_HASH,
		blockNumber: 100,
		status: 'success',
		logs,
	};
}

function expectation(overrides: Record<string, unknown> = {}) {
	return {
		transactionHash: TX_HASH,
		blockHash: BLOCK_HASH,
		channelId: CHANNEL,
		claimId: CLAIM,
		agent: AGENT,
		fundingWallet: FUNDING,
		merchantPayout: PAYOUT,
		token: AP4M_EVM_EVENT_PROFILE.rlusdToken,
		cumulativeAmount: '20',
		incrementalAmount: '5',
		minimumConfirmations: 3,
		latestBlockNumber: 102,
		...overrides,
	};
}

describe('AP4M EVM receipt validation', () => {
	it('decodes every event field and requires finality', () => {
		expect(validateFinalizedReceipt(receipt(), expectation()).eventArgs).toEqual(EXPECTED_ARGS);
		expect(() => validateFinalizedReceipt(receipt(), expectation({ latestBlockNumber: 101 })))
			.toThrowError(expect.objectContaining({ code: 'RECEIPT_PENDING' }));
	});

	it('rejects duplicate, removed, wrong-contract and altered-value events', () => {
		for (const logs of [
			[eventLog(), eventLog({ logIndex: 1 })],
			[eventLog({ removed: true })],
			[eventLog({ address: PAYOUT })],
			[eventLog({ data: encodeAbiParameters(
				parseAbiParameters('address payout, address token, uint256 cumulativeAmount, uint256 incrementalAmount'),
				[PAYOUT, AP4M_EVM_EVENT_PROFILE.rlusdToken, 21n, 6n],
			) })],
		]) {
			expect(() => validateFinalizedReceipt(receipt(logs), expectation()))
				.toThrowError(expect.objectContaining({ code: 'RECEIPT_MISMATCH' }));
		}
	});

	it('rejects malformed and failed receipt envelopes', () => {
		expect(() => validateFinalizedReceipt({ ...receipt(), status: 'failed' }, expectation()))
			.toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
		expect(() => validateFinalizedReceipt({ ...receipt(), transactionHash: '0x01' }, expectation()))
			.toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
		expect(() => validateFinalizedReceipt(
			{ ...receipt(), transactionHash: `0x${'33'.repeat(32)}` }, expectation(),
		)).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
		expect(() => validateFinalizedReceipt(
			receipt(), expectation({ merchantPayout: '0xCAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91' }),
		)).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
	});
});
