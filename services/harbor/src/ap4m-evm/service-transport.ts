import { getAddress, type Address, type Hex } from 'viem';

import { Hex32Schema } from './contracts';

export const AP4M_EVENT_SERVICE_ORIGIN = 'https://hackathon.ap4m.build' as const;

const MAX_RESPONSE_BYTES = 128 * 1024;
const DECIMAL_RLUSD = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;

export class Ap4mEvmServiceError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'SERVICE_UNAVAILABLE'
			| 'SERVICE_REJECTED'
			| 'SERVICE_INVALID_RESPONSE'
			| 'SERVICE_BINDING_MISMATCH',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'Ap4mEvmServiceError';
	}
}

type JsonRecord = Record<string, unknown>;

export type Ap4mRedemptionRecord = Readonly<{ claimId: Hex }>;

export type Ap4mSettlementReceiptReference = Readonly<{
	claimId: Hex;
	receiptPath: string | null;
}>;

export type Ap4mSettlementEvidenceReference = Readonly<{
	status: 'pending' | 'reported';
	channelId: Hex;
	claimId: Hex;
	settlementTransactionHash: Hex | null;
	payoutTransactionHash: Hex;
	recipient: Address;
	amountRlusd: string;
	claimsSettled: number;
	receipts: readonly Ap4mSettlementReceiptReference[];
}>;

export type Ap4mServiceTransportDependencies = Readonly<{
	fetch: typeof fetch;
	timeoutMs?: number;
}>;

function record(value: unknown, field: string): JsonRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Ap4mEvmServiceError(`${field} is invalid`, 'SERVICE_INVALID_RESPONSE');
	}
	return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], required: readonly string[], field: string): void {
	if (
		Object.keys(value).some((key) => !allowed.includes(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	) {
		throw new Ap4mEvmServiceError(`${field} has an unsupported shape`, 'SERVICE_INVALID_RESPONSE');
	}
}

function hash(value: unknown, field: string): Hex {
	if (!Hex32Schema.safeParse(value).success) {
		throw new Ap4mEvmServiceError(`${field} is invalid`, 'SERVICE_INVALID_RESPONSE');
	}
	return value as Hex;
}

function address(value: unknown, field: string): Address {
	if (typeof value !== 'string') {
		throw new Ap4mEvmServiceError(`${field} is invalid`, 'SERVICE_INVALID_RESPONSE');
	}
	try {
		return getAddress(value);
	} catch {
		throw new Ap4mEvmServiceError(`${field} is invalid`, 'SERVICE_INVALID_RESPONSE');
	}
}

function positiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Ap4mEvmServiceError(`${field} is invalid`, 'SERVICE_INVALID_RESPONSE');
	}
	return Number(value);
}

function receiptPath(value: unknown, field: string): string | null {
	if (value === null) return null;
	if (
		typeof value !== 'string' || value.length < 1 || value.length > 512 ||
		!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\0')
	) {
		throw new Ap4mEvmServiceError(`${field} is invalid`, 'SERVICE_INVALID_RESPONSE');
	}
	const parsed = new URL(value, AP4M_EVENT_SERVICE_ORIGIN);
	if (parsed.origin !== AP4M_EVENT_SERVICE_ORIGIN || `${parsed.pathname}${parsed.search}${parsed.hash}` !== value) {
		throw new Ap4mEvmServiceError(`${field} leaves the AP4M service origin`, 'SERVICE_INVALID_RESPONSE');
	}
	return value;
}

function bearer(value: string): string {
	if (value.length < 16 || value.length > 4_096 || /[\u0000-\u001f\u007f\s]/.test(value)) {
		throw new Ap4mEvmServiceError('AP4M bearer token is invalid', 'SERVICE_REJECTED');
	}
	return value;
}

function sameAddress(left: string, right: string): boolean {
	try {
		return getAddress(left) === getAddress(right);
	} catch {
		return false;
	}
}

export class Ap4mEvmServiceTransport {
	constructor(private readonly dependencies: Ap4mServiceTransportDependencies) {
		if (!Number.isSafeInteger(dependencies.timeoutMs ?? 8_000) || (dependencies.timeoutMs ?? 8_000) < 1) {
			throw new Ap4mEvmServiceError('AP4M service timeout is invalid', 'SERVICE_UNAVAILABLE');
		}
	}

	private async post(path: string, token: string, body: JsonRecord): Promise<Readonly<{ status: number; value: unknown }>> {
		if (!path.startsWith('/public/participant/') || path.includes('?') || path.includes('#')) {
			throw new Ap4mEvmServiceError('AP4M service path is not allowlisted', 'SERVICE_REJECTED');
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.dependencies.timeoutMs ?? 8_000);
		let response: Response;
		try {
			response = await this.dependencies.fetch(`${AP4M_EVENT_SERVICE_ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					authorization: `Bearer ${bearer(token)}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			throw new Ap4mEvmServiceError('AP4M service request failed', 'SERVICE_UNAVAILABLE', error);
		} finally {
			clearTimeout(timer);
		}
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
			throw new Ap4mEvmServiceError('AP4M service response is too large', 'SERVICE_INVALID_RESPONSE');
		}
		let value: unknown;
		try {
			value = JSON.parse(text) as unknown;
		} catch (error) {
			throw new Ap4mEvmServiceError('AP4M service response is not JSON', 'SERVICE_INVALID_RESPONSE', error);
		}
		if (!response.ok) {
			throw new Ap4mEvmServiceError(`AP4M service rejected the request with HTTP ${response.status}`, 'SERVICE_REJECTED');
		}
		return { status: response.status, value };
	}

	/** Report an already reviewed and submitted redemption. This method never submits a transaction. */
	async reportRedemption(token: string, txHash: Hex): Promise<Ap4mRedemptionRecord> {
		const transactionHash = hash(txHash, 'redemption transaction hash');
		const response = await this.post('/public/participant/record-redemption', token, {
			tx_hash: transactionHash,
		});
		if (response.status !== 200) {
			throw new Ap4mEvmServiceError('Redemption report returned an unsupported status', 'SERVICE_INVALID_RESPONSE');
		}
		const value = record(response.value, 'redemption report');
		exactKeys(value, ['claim_id'], ['claim_id'], 'redemption report');
		return { claimId: hash(value.claim_id, 'redemption claim id') };
	}

	/**
	 * Request settlement for one already-bound channel. A 202 response is returned
	 * as pending; this transport deliberately does not poll or retry mutations.
	 */
	async requestSettlement(input: Readonly<{
		token: string;
		channelId: Hex;
		claimId: Hex;
		expectedRecipient: Address;
	}>): Promise<Ap4mSettlementEvidenceReference> {
		const channelId = hash(input.channelId, 'settlement channel id');
		const claimId = hash(input.claimId, 'settlement claim id');
		const expectedRecipient = address(input.expectedRecipient, 'expected settlement recipient');
		const response = await this.post('/public/participant/settle', input.token, {
			channel_id: channelId,
		});
		const value = record(response.value, 'settlement response');
		if (response.status === 202) {
			exactKeys(value, ['payout_tx', 'channel_id', 'claim_id'], ['payout_tx', 'channel_id', 'claim_id'], 'pending settlement response');
			const returnedChannel = hash(value.channel_id, 'pending settlement channel id');
			const returnedClaim = hash(value.claim_id, 'pending settlement claim id');
			if (returnedChannel.toLowerCase() !== channelId.toLowerCase() || returnedClaim.toLowerCase() !== claimId.toLowerCase()) {
				throw new Ap4mEvmServiceError('Pending settlement is not bound to the reviewed claim', 'SERVICE_BINDING_MISMATCH');
			}
			return {
				status: 'pending', channelId, claimId,
				settlementTransactionHash: null,
				payoutTransactionHash: hash(value.payout_tx, 'pending payout transaction hash'),
				recipient: expectedRecipient,
				amountRlusd: '0', claimsSettled: 0, receipts: [],
			};
		}
		if (response.status !== 200) {
			throw new Ap4mEvmServiceError('Settlement returned an unsupported status', 'SERVICE_INVALID_RESPONSE');
		}
		exactKeys(
			value,
			['settlement_tx', 'payout_tx', 'amount_rlusd', 'recipient', 'claim_id', 'channel_id', 'claims_settled', 'receipt_url', 'receipts'],
			['settlement_tx', 'payout_tx', 'amount_rlusd', 'recipient', 'claim_id', 'channel_id', 'claims_settled', 'receipt_url', 'receipts'],
			'settlement response',
		);
		const returnedChannel = hash(value.channel_id, 'settlement channel id');
		const returnedClaim = hash(value.claim_id, 'settlement claim id');
		const recipient = address(value.recipient, 'settlement recipient');
		if (
			returnedChannel.toLowerCase() !== channelId.toLowerCase() ||
			returnedClaim.toLowerCase() !== claimId.toLowerCase() ||
			!sameAddress(recipient, expectedRecipient)
		) {
			throw new Ap4mEvmServiceError('Settlement is not bound to the reviewed channel, claim, and payout', 'SERVICE_BINDING_MISMATCH');
		}
		if (typeof value.amount_rlusd !== 'string' || !DECIMAL_RLUSD.test(value.amount_rlusd)) {
			throw new Ap4mEvmServiceError('Settlement RLUSD amount is invalid', 'SERVICE_INVALID_RESPONSE');
		}
		if (!Array.isArray(value.receipts)) {
			throw new Ap4mEvmServiceError('Settlement receipts are invalid', 'SERVICE_INVALID_RESPONSE');
		}
		const receipts = value.receipts.map((entry, index): Ap4mSettlementReceiptReference => {
			const item = record(entry, `settlement receipt ${index}`);
			exactKeys(item, ['claim_id', 'amount_rlusd', 'receipt_url'], ['claim_id', 'amount_rlusd', 'receipt_url'], `settlement receipt ${index}`);
			if (typeof item.amount_rlusd !== 'string' || !DECIMAL_RLUSD.test(item.amount_rlusd)) {
				throw new Ap4mEvmServiceError(`settlement receipt ${index} amount is invalid`, 'SERVICE_INVALID_RESPONSE');
			}
			return {
				claimId: hash(item.claim_id, `settlement receipt ${index} claim id`),
				receiptPath: receiptPath(item.receipt_url, `settlement receipt ${index} URL`),
			};
		});
		if (receipts.filter((entry) => entry.claimId.toLowerCase() === claimId.toLowerCase()).length !== 1) {
			throw new Ap4mEvmServiceError('Settlement receipts do not identify exactly one reviewed claim', 'SERVICE_BINDING_MISMATCH');
		}
		receiptPath(value.receipt_url, 'settlement receipt URL');
		return {
			status: 'reported', channelId, claimId,
			settlementTransactionHash: hash(value.settlement_tx, 'settlement transaction hash'),
			payoutTransactionHash: hash(value.payout_tx, 'payout transaction hash'),
			recipient,
			amountRlusd: value.amount_rlusd,
			claimsSettled: positiveInteger(value.claims_settled, 'settlement claim count'),
			receipts,
		};
	}
}
