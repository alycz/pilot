import { validate, type Batch, type CredentialAccept, type PaymentChannelCreate, type Transaction } from 'xrpl';

const TF_ALL_OR_NOTHING = 0x00010000;
const TF_INNER_BATCH_TXN = 0x40000000;
const RIPPLE_EPOCH_OFFSET = 946684800;

export interface MandateBatchMerchant {
	id: string;
	address: string;
	claimPublicKey: string;
}

export interface MandateBatchInput {
	owner: string;
	sequence: number;
	feeDrops: string;
	lastLedgerSequence: number;
	credential: { issuer: string; credentialTypeHex: string };
	merchants: readonly MandateBatchMerchant[];
	channelAmountDrops: string;
	expiresAt: string;
	l2Digest?: string;
	validateTransaction?: (transaction: Transaction) => void;
}

export interface PreparedMandateTransactions {
	unsigned_batch: Batch;
	unsigned_sequential?: Transaction[];
}

export class MandateBatchError extends Error {
	constructor(message: string, readonly code: 'INVALID_INPUT' | 'INVALID_BATCH') {
		super(message);
		this.name = 'MandateBatchError';
	}
}

function memo(digest: string) {
	if (!/^[A-Fa-f0-9]{64}$/.test(digest)) throw new MandateBatchError('L2 digest must be SHA-256 hex', 'INVALID_INPUT');
	return { Memo: {
		MemoType: Array.from(new TextEncoder().encode('ap4m/l2'), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase(),
		MemoData: digest.toUpperCase(),
	} };
}

function cancelAfter(expiresAt: string): number {
	const millis = Date.parse(expiresAt);
	if (!Number.isFinite(millis)) throw new MandateBatchError('expiresAt must be an ISO date', 'INVALID_INPUT');
	return Math.floor(millis / 1000) - RIPPLE_EPOCH_OFFSET + 86_400;
}

/**
 * Build the unsigned AP4M setup transaction. Fields follow the canonical XRPL
 * references: https://xrpl.org/docs/references/protocol/transactions/types/batch,
 * https://xrpl.org/docs/references/protocol/transactions/types/credentialaccept,
 * and https://xrpl.org/docs/references/protocol/transactions/types/paymentchannelcreate.
 */
export function buildMandateTransactions(input: MandateBatchInput): PreparedMandateTransactions {
	if (input.merchants.length === 0 || new Set(input.merchants.map((item) => item.id)).size !== input.merchants.length) {
		throw new MandateBatchError('At least one unique merchant is required', 'INVALID_INPUT');
	}
	if (!/^[1-9]\d*$/.test(input.channelAmountDrops) || !/^\d+$/.test(input.feeDrops)) {
		throw new MandateBatchError('Amounts and fees must be drops strings', 'INVALID_INPUT');
	}
	const credential: CredentialAccept = {
		TransactionType: 'CredentialAccept', Account: input.owner,
		Issuer: input.credential.issuer, CredentialType: input.credential.credentialTypeHex,
		Sequence: input.sequence + 1,
	};
	const channels: PaymentChannelCreate[] = input.merchants.map((merchant, index) => ({
		TransactionType: 'PaymentChannelCreate', Account: input.owner,
		Destination: merchant.address, Amount: input.channelAmountDrops, SettleDelay: 3_600,
		PublicKey: merchant.claimPublicKey, CancelAfter: cancelAfter(input.expiresAt),
		Sequence: input.sequence + index + 2,
	}));
	const sequential: Transaction[] = [credential, ...channels].map((tx, index) => ({
		...tx,
		Sequence: input.sequence + index,
		Fee: input.feeDrops,
		LastLedgerSequence: input.lastLedgerSequence + index,
		Memos: [memo(input.l2Digest ?? '0'.repeat(64))],
	}));
	const inner = [credential, ...channels].map((tx) => ({
		RawTransaction: { ...tx, Flags: TF_INNER_BATCH_TXN, Fee: '0', SigningPubKey: '' },
	}));
	const batch: Batch = {
		TransactionType: 'Batch', Account: input.owner, Sequence: input.sequence,
		Fee: (BigInt(input.feeDrops) * BigInt(inner.length + 1)).toString(), LastLedgerSequence: input.lastLedgerSequence,
		Flags: TF_ALL_OR_NOTHING, RawTransactions: inner,
		Memos: [memo(input.l2Digest ?? '0'.repeat(64))],
	};
	try {
		(input.validateTransaction ?? validate)(batch);
		// Expose both before signing so MP3 can choose based on wallet Batch
		// capability. Never auto-fallback after a cancelled or uncertain submit.
		return { unsigned_batch: batch, unsigned_sequential: sequential };
	} catch {
		return { unsigned_batch: batch, unsigned_sequential: sequential };
	}
}
