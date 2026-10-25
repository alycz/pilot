import {
	decodeEventLog,
	getAddress,
	keccak256,
	parseAbi,
	stringToHex,
	type Address,
	type Hex,
} from 'viem';

import { Hex32Schema, type EvmReceiptEvidence, type PreparedEvmTransaction } from './contracts';
import { AP4M_EVM_EVENT_PROFILE } from './event-config';
import type { Ap4mEvmJsonRpcClient } from './json-rpc';
import { validateFinalizedReceipt, type ReceiptEventExpectation } from './receipt-validation';
import type {
	Ap4mEvmAttemptRow,
	Ap4mEvmChannelRow,
	Ap4mEvmStore,
} from './store';

const ERC20_TRANSFER_ABI = parseAbi([
	'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const FINGERPRINT = /^[0-9a-f]{64}$/;

export class Ap4mEvmReconciliationError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'RECONCILIATION_INVALID_INPUT'
			| 'RECONCILIATION_STATE_MISMATCH'
			| 'RECONCILIATION_PAYOUT_MISMATCH'
			| 'RECONCILIATION_STORE_REJECTED',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'Ap4mEvmReconciliationError';
	}
}

export type Ap4mSettlementEvidence = Readonly<{
	status: 'pending' | 'reported';
	channelId: Hex;
	claimId: Hex;
	payoutTransactionHash: Hex;
	recipient: Address;
}>;

/** Read-only source backed by already-recorded settlement state; it must not trigger settlement. */
export interface Ap4mSettlementEvidenceSource {
	read(input: Readonly<{
		channelId: Hex;
		claimId: Hex;
		redemptionTransactionHash: Hex;
	}>): Promise<Ap4mSettlementEvidence | null>;
}

/**
	* Optional reviewed validity oracle. It must bind on-chain channel validity
	* (including validBefore) and pinned validated-head absence. Without it the
	* reconciler keeps an absent hash pending forever rather than guessing.
	*/
export interface Ap4mSubmissionAbsenceVerifier {
	verifyFinalAbsence(input: Readonly<{
		attempt: Ap4mEvmAttemptRow;
		channel: Ap4mEvmChannelRow;
		transaction: PreparedEvmTransaction;
		latestBlockNumber: number;
	}>): Promise<Readonly<{ absenceFingerprint: string }> | null>;
}

export type Ap4mEvmReconcilerDependencies = Readonly<{
	rpc: Pick<Ap4mEvmJsonRpcClient,
		'blockNumber' | 'transactionByHash' | 'receiptByHash' | 'assertExactTransaction'>;
	store: Ap4mEvmStore;
	settlements: Ap4mSettlementEvidenceSource;
	absenceVerifier?: Ap4mSubmissionAbsenceVerifier;
	now(): string;
}>;

export type ReconcileAp4mEvmInput = Readonly<{
	channelId: Hex;
	idempotencyKey: string;
	attemptToken: string;
	transaction: PreparedEvmTransaction;
	receipt: Omit<ReceiptEventExpectation,
		'transactionHash' | 'blockHash' | 'minimumConfirmations' | 'latestBlockNumber'>;
	minimumConfirmations: number;
}>;

export type ReconcileAp4mEvmResult =
	| Readonly<{ status: 'not_found' | 'pending' | 'blocked' }>
	| Readonly<{
		status: 'confirmed';
		redemptionTransactionHash: Hex;
		payoutTransactionHash: Hex;
		confirmations: number;
	}>
	| Readonly<{ status: 'failed_absent'; transactionHash: Hex }>;

function sameAddress(left: string, right: string): boolean {
	try {
		return getAddress(left) === getAddress(right);
	} catch {
		return false;
	}
}

function assertHash(value: string | null, field: string): asserts value is Hex {
	if (!Hex32Schema.safeParse(value).success) {
		throw new Ap4mEvmReconciliationError(`${field} is invalid`, 'RECONCILIATION_INVALID_INPUT');
	}
}

function canonical(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'string' && value.startsWith('0x')) return value.toLowerCase();
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonical(nested)]),
		);
	}
	return value;
}

function fingerprint(value: unknown): string {
	return keccak256(stringToHex(JSON.stringify(canonical(value)))).slice(2);
}

export function verifyRlusdPayoutReceipt(input: Readonly<{
	receipt: EvmReceiptEvidence;
	transactionHash: Hex;
	merchantPayout: Address;
	expectedAmountBaseUnits: bigint;
	minimumConfirmations: number;
	latestBlockNumber: number;
}>): Readonly<{ confirmations: number; transferLogIndex: number }> {
	if (
		input.receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase() ||
		input.expectedAmountBaseUnits < 1n || !Number.isSafeInteger(input.minimumConfirmations) ||
		input.minimumConfirmations < 1 || !Number.isSafeInteger(input.latestBlockNumber) ||
		input.latestBlockNumber < input.receipt.blockNumber
	) {
		throw new Ap4mEvmReconciliationError('Payout receipt input is invalid', 'RECONCILIATION_INVALID_INPUT');
	}
	const confirmations = input.latestBlockNumber - input.receipt.blockNumber + 1;
	if (confirmations < input.minimumConfirmations) {
		throw new Ap4mEvmReconciliationError('RLUSD payout is not final', 'RECONCILIATION_PAYOUT_MISMATCH');
	}
	const matches: number[] = [];
	for (const log of input.receipt.logs) {
		if (log.removed || !sameAddress(log.address, AP4M_EVM_EVENT_PROFILE.rlusdToken)) continue;
		try {
			const decoded = decodeEventLog({
				abi: ERC20_TRANSFER_ABI,
				eventName: 'Transfer',
				data: log.data as Hex,
				topics: log.topics as [Hex, ...Hex[]],
				strict: true,
			});
			const args = decoded.args;
			if (
				sameAddress(args.from, AP4M_EVM_EVENT_PROFILE.pooledEscrowVault) &&
				sameAddress(args.to, input.merchantPayout) && args.value === input.expectedAmountBaseUnits
			) matches.push(log.logIndex);
		} catch {
			// Non-Transfer RLUSD logs do not prove payout.
		}
	}
	if (matches.length !== 1) {
		throw new Ap4mEvmReconciliationError(
			'Payout receipt does not contain exactly one bound RLUSD transfer',
			'RECONCILIATION_PAYOUT_MISMATCH',
		);
	}
	return { confirmations, transferLogIndex: matches[0]! };
}

export class Ap4mEvmReconciler {
	constructor(private readonly dependencies: Ap4mEvmReconcilerDependencies) {}

	async reconcile(input: ReconcileAp4mEvmInput): Promise<ReconcileAp4mEvmResult> {
		const [attempt, channel] = await Promise.all([
			this.dependencies.store.getAttempt(input.channelId, input.idempotencyKey),
			this.dependencies.store.getChannel(input.channelId),
		]);
		if (attempt === null || channel === null) return { status: 'not_found' };
		if (
			attempt.status !== 'submission_unknown' || attempt.attemptToken !== input.attemptToken ||
			attempt.channelId.toLowerCase() !== input.channelId.toLowerCase() || attempt.txHash === null ||
			channel.pendingIdempotencyKey !== attempt.idempotencyKey ||
			channel.pendingAttemptToken !== attempt.attemptToken
		) return { status: 'blocked' };
		assertHash(attempt.txHash, 'attempt transaction hash');

		const latestBlockNumber = await this.dependencies.rpc.blockNumber();
		const [transaction, receipt] = await Promise.all([
			this.dependencies.rpc.transactionByHash(attempt.txHash),
			this.dependencies.rpc.receiptByHash(attempt.txHash),
		]);
		if ((transaction === null) !== (receipt === null)) return { status: 'pending' };
		if (transaction === null && receipt === null) {
			if (!this.dependencies.absenceVerifier) return { status: 'pending' };
			const absence = await this.dependencies.absenceVerifier.verifyFinalAbsence({
				attempt, channel, transaction: input.transaction, latestBlockNumber,
			});
			if (absence === null) return { status: 'pending' };
			if (!FINGERPRINT.test(absence.absenceFingerprint)) {
				throw new Ap4mEvmReconciliationError('Absence evidence is invalid', 'RECONCILIATION_INVALID_INPUT');
			}
			const transition = await this.dependencies.store.markAbsent({
				channelId: input.channelId,
				idempotencyKey: input.idempotencyKey,
				attemptToken: input.attemptToken,
				txHash: attempt.txHash,
				absenceFingerprint: absence.absenceFingerprint,
				at: this.dependencies.now(),
			});
			if (transition.outcome !== 'transitioned' && transition.outcome !== 'replay') {
				throw new Ap4mEvmReconciliationError('Store rejected final absence evidence', 'RECONCILIATION_STORE_REJECTED');
			}
			return { status: 'failed_absent', transactionHash: attempt.txHash };
		}
		if (transaction === null || receipt === null) return { status: 'pending' };
		this.dependencies.rpc.assertExactTransaction(transaction, input.transaction);
		if (
			transaction.blockHash === null || transaction.blockNumber === null ||
			transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
			transaction.blockNumber !== receipt.blockNumber
		) {
			throw new Ap4mEvmReconciliationError('Transaction and receipt block evidence disagree', 'RECONCILIATION_STATE_MISMATCH');
		}
		const redemption = validateFinalizedReceipt(receipt, {
			...input.receipt,
			transactionHash: attempt.txHash,
			blockHash: transaction.blockHash,
			minimumConfirmations: input.minimumConfirmations,
			latestBlockNumber,
		});

		const settlement = await this.dependencies.settlements.read({
			channelId: input.channelId,
			claimId: input.receipt.claimId,
			redemptionTransactionHash: attempt.txHash,
		});
		if (settlement === null || settlement.status === 'pending') return { status: 'pending' };
		if (
			settlement.channelId.toLowerCase() !== input.channelId.toLowerCase() ||
			settlement.claimId.toLowerCase() !== input.receipt.claimId.toLowerCase() ||
			!sameAddress(settlement.recipient, channel.payoutWallet)
		) {
			throw new Ap4mEvmReconciliationError('Settlement reference is not bound to the channel', 'RECONCILIATION_PAYOUT_MISMATCH');
		}
		const payoutReceipt = await this.dependencies.rpc.receiptByHash(settlement.payoutTransactionHash);
		if (payoutReceipt === null) return { status: 'pending' };
		const payout = verifyRlusdPayoutReceipt({
			receipt: payoutReceipt,
			transactionHash: settlement.payoutTransactionHash,
			merchantPayout: channel.payoutWallet as Address,
			expectedAmountBaseUnits: BigInt(attempt.nextCumulative) - BigInt(attempt.previousCumulative),
			minimumConfirmations: input.minimumConfirmations,
			latestBlockNumber,
		});
		const receiptFingerprint = fingerprint({
			redemption: redemption.receipt,
			redemptionEvent: redemption.eventArgs,
			payout: payoutReceipt,
			payoutTransferLogIndex: payout.transferLogIndex,
		});
		const transition = await this.dependencies.store.confirm({
			channelId: input.channelId,
			idempotencyKey: input.idempotencyKey,
			attemptToken: input.attemptToken,
			txHash: attempt.txHash,
			receiptFingerprint,
			blockNumber: receipt.blockNumber,
			confirmations: latestBlockNumber - receipt.blockNumber + 1,
			at: this.dependencies.now(),
		});
		if (transition.outcome !== 'transitioned' && transition.outcome !== 'replay') {
			throw new Ap4mEvmReconciliationError('Store rejected verified settlement evidence', 'RECONCILIATION_STORE_REJECTED');
		}
		return {
			status: 'confirmed',
			redemptionTransactionHash: attempt.txHash,
			payoutTransactionHash: settlement.payoutTransactionHash,
			confirmations: latestBlockNumber - receipt.blockNumber + 1,
		};
	}
}
