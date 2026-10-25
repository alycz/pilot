import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { AP4M_EVM_EVENT_PROFILE } from '../src/ap4m-evm/event-config';
import {
	Ap4mEvmReconciler,
	verifyRlusdPayoutReceipt,
	type Ap4mEvmReconcilerDependencies,
} from '../src/ap4m-evm/reconciler';
import type { Ap4mEvmAttemptRow, Ap4mEvmChannelRow, Ap4mEvmStore } from '../src/ap4m-evm/store';

const CHANNEL = `0x${'1'.repeat(64)}` as Hex;
const CLAIM = `0x${'2'.repeat(64)}` as Hex;
const REDEMPTION_TX = `0x${'3'.repeat(64)}` as Hex;
const PAYOUT_TX = `0x${'4'.repeat(64)}` as Hex;
const BLOCK_HASH = `0x${'5'.repeat(64)}` as Hex;
const AGENT = `0x${'1'.repeat(40)}` as Address;
const FUNDING = `0x${'2'.repeat(40)}` as Address;
const PAYOUT = `0x${'3'.repeat(40)}` as Address;
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

function transferLog(overrides: { from?: Address; to?: Address; amount?: bigint; logIndex?: number } = {}) {
	const from = overrides.from ?? AP4M_EVM_EVENT_PROFILE.pooledEscrowVault;
	const to = overrides.to ?? PAYOUT;
	return {
		address: AP4M_EVM_EVENT_PROFILE.rlusdToken,
		topics: encodeEventTopics({ abi: TRANSFER_ABI, eventName: 'Transfer', args: { from, to } }),
		data: encodeAbiParameters(parseAbiParameters('uint256 value'), [overrides.amount ?? 10n]),
		logIndex: overrides.logIndex ?? 0,
		removed: false,
	};
}

function payoutReceipt(logs = [transferLog()]) {
	return {
		transactionHash: PAYOUT_TX,
		blockHash: BLOCK_HASH,
		blockNumber: 100,
		status: 'success' as const,
		logs,
	};
}

const attempt: Ap4mEvmAttemptRow = {
	principal: 'principal', channelId: CHANNEL, idempotencyKey: 'voucher-1',
	requestFingerprint: 'a'.repeat(64), merchantId: 'merchant', previousCumulative: '0', nextCumulative: '10',
	attemptToken: 'b'.repeat(64), status: 'submission_unknown', txHash: REDEMPTION_TX,
	receiptFingerprint: null, blockNumber: null, confirmations: null, absenceFingerprint: null,
	createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
};

const channel: Ap4mEvmChannelRow = {
	principal: 'principal', channelId: CHANNEL, merchantId: 'merchant', agentWallet: AGENT,
	fundingWallet: FUNDING, payoutWallet: PAYOUT, tokenAddress: AP4M_EVM_EVENT_PROFILE.rlusdToken,
	generation: 1, capBaseUnits: '100', cumulativeBaseUnits: '0', status: 'open',
	pendingIdempotencyKey: 'voucher-1', pendingRequestFingerprint: 'a'.repeat(64), pendingNextCumulative: '10',
	pendingAttemptToken: 'b'.repeat(64), createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
};

function store() {
	return {
		reserve: vi.fn(),
		markSubmissionUnknown: vi.fn(),
		confirm: vi.fn(),
		markAbsent: vi.fn(async () => ({ outcome: 'transitioned' as const, channel, attempt: { ...attempt, status: 'failed_absent' as const } })),
		getChannel: vi.fn(async () => channel),
		getAttempt: vi.fn(async () => attempt),
		getAttemptByHash: vi.fn(async () => attempt),
	} satisfies Ap4mEvmStore;
}

const transaction = {
	chainId: AP4M_EVM_EVENT_PROFILE.chainId,
	from: AGENT,
	to: AP4M_EVM_EVENT_PROFILE.paymentLedger,
	data: '0x1234',
	value: '0',
	gasLimit: '250000',
	feeModel: 'legacy' as const,
	gasPrice: '1000000000',
};

function reconciliationInput() {
	return {
		channelId: CHANNEL,
		idempotencyKey: 'voucher-1',
		attemptToken: 'b'.repeat(64),
		transaction,
		receipt: {
			channelId: CHANNEL, claimId: CLAIM,
			evidence0: `0x${'6'.repeat(64)}` as Hex,
			evidence1: `0x${'7'.repeat(64)}` as Hex,
			evidence2: `0x${'8'.repeat(64)}` as Hex,
			evidence3: '1',
			agent: AGENT, fundingWallet: FUNDING,
			merchantPayout: PAYOUT, token: AP4M_EVM_EVENT_PROFILE.rlusdToken,
			cumulativeAmount: '10', incrementalAmount: '10',
		},
		minimumConfirmations: 3,
	};
}

describe('AP4M EVM reconciliation', () => {
	it('requires exactly one finalized RLUSD Transfer from the pinned vault to the bound payout', () => {
		expect(verifyRlusdPayoutReceipt({
			receipt: payoutReceipt(), transactionHash: PAYOUT_TX, merchantPayout: PAYOUT,
			expectedAmountBaseUnits: 10n, minimumConfirmations: 3, latestBlockNumber: 102,
		})).toEqual({ confirmations: 3, transferLogIndex: 0 });

		for (const logs of [
			[transferLog({ from: AGENT })],
			[transferLog({ to: AGENT })],
			[transferLog({ amount: 11n })],
			[transferLog(), transferLog({ logIndex: 1 })],
		]) {
			expect(() => verifyRlusdPayoutReceipt({
				receipt: payoutReceipt(logs), transactionHash: PAYOUT_TX, merchantPayout: PAYOUT,
				expectedAmountBaseUnits: 10n, minimumConfirmations: 3, latestBlockNumber: 102,
			})).toThrowError(expect.objectContaining({ code: 'RECONCILIATION_PAYOUT_MISMATCH' }));
		}
	});

	it('keeps an unknown hash pending without a reviewed channel-validity absence verifier', async () => {
		const state = store();
		const dependencies: Ap4mEvmReconcilerDependencies = {
			store: state,
			rpc: {
				blockNumber: vi.fn(async () => 200),
				transactionByHash: vi.fn(async () => null),
				receiptByHash: vi.fn(async () => null),
				assertExactTransaction: vi.fn(),
			},
			settlements: { read: vi.fn(async () => null) },
			now: () => '2026-10-25T00:01:00.000Z',
		};
		await expect(new Ap4mEvmReconciler(dependencies).reconcile(reconciliationInput()))
			.resolves.toEqual({ status: 'pending' });
		expect(state.markAbsent).not.toHaveBeenCalled();
		expect(state.confirm).not.toHaveBeenCalled();
	});

	it('marks absence only when the injected validity verifier supplies bound final evidence', async () => {
		const state = store();
		const absenceVerifier = { verifyFinalAbsence: vi.fn(async () => ({ absenceFingerprint: 'c'.repeat(64) })) };
		const dependencies: Ap4mEvmReconcilerDependencies = {
			store: state,
			rpc: {
				blockNumber: vi.fn(async () => 200),
				transactionByHash: vi.fn(async () => null),
				receiptByHash: vi.fn(async () => null),
				assertExactTransaction: vi.fn(),
			},
			settlements: { read: vi.fn(async () => null) },
			absenceVerifier,
			now: () => '2026-10-25T00:01:00.000Z',
		};
		await expect(new Ap4mEvmReconciler(dependencies).reconcile(reconciliationInput()))
			.resolves.toEqual({ status: 'failed_absent', transactionHash: REDEMPTION_TX });
		expect(absenceVerifier.verifyFinalAbsence).toHaveBeenCalledWith(expect.objectContaining({
			attempt, channel, transaction, latestBlockNumber: 200,
		}));
		expect(state.markAbsent).toHaveBeenCalledWith({
			channelId: CHANNEL,
			idempotencyKey: 'voucher-1',
			attemptToken: 'b'.repeat(64),
			txHash: REDEMPTION_TX,
			absenceFingerprint: 'c'.repeat(64),
			at: '2026-10-25T00:01:00.000Z',
		});
	});
});
