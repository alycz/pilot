import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLICY, type Merchant } from '../src/contracts';
import {
	handleAp4mPurchase,
	type Ap4mPurchaseServices,
} from '../src/ops/ap4m';
import { getCatalogMerchant } from '../src/ops/merchants';

const NOW = new Date('2026-10-21T21:00:00.000Z');
const PRINCIPAL = 'mh5-ap4m-seam';
const MANDATE_ID = 'mandate-mh5-seam';
const IDEMPOTENCY_KEY = 'purchase-mh5-seam';
const MERCHANT_ID = 'venue-yield-desk';
const SKU = 'yield-report';
const OWNER = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const PAYER = OWNER;
const CHANNEL_ID = 'A'.repeat(64);
const TX_HASH = 'B'.repeat(64);
const merchant = getCatalogMerchant(MERCHANT_ID)!;
const args = {
	mandate_id: MANDATE_ID,
	merchant_id: MERCHANT_ID,
	sku: SKU,
	idempotency_key: IDEMPOTENCY_KEY,
};

function mandate(status: 'ACTIVE' | 'REVOKED' = 'ACTIVE', spentUsd = '0') {
	return {
		mandate: {
			id: MANDATE_ID,
			owner: OWNER,
			network: 'testnet' as const,
			status,
			execution_type: 'DEFERRED' as const,
			not_before: '2026-10-21T00:00:00.000Z',
			expires_at: '2026-10-22T00:00:00.000Z',
			constraints: {
				currency: 'USD' as const,
				per_payment_max: '5',
				daily_max: '10',
				total_max: '25',
				payees: [MERCHANT_ID],
				skus: [SKU],
			},
			agent_public_jwk: {},
			l1_digest: 'C'.repeat(64),
			l2_digest: 'D'.repeat(64),
			channels: [{ merchant_id: MERCHANT_ID, channel_id: CHANNEL_ID, amount_drops: '100000' }],
			spent_usd: spentUsd,
		},
		agentKeyCiphertext: new ArrayBuffer(17),
		agentKeyIv: new ArrayBuffer(12),
		claimKeysCiphertext: new ArrayBuffer(17),
		claimKeysIv: new ArrayBuffer(12),
		claimPublicKeys: [{ merchant_id: MERCHANT_ID, public_key: `ED${'E'.repeat(64)}` }],
		prepared: { unsigned_batch: {} },
		closeRequested: false,
		createdAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
	};
}

function typedData() {
	return {
		schema_id: 'yield_report_v1' as const,
		venue: MERCHANT_ID,
		apr_percent: '4.2',
		tvl_usd: '1000000',
		risk: 'low',
	};
}

function merchantValidation() {
	return {
		intentId: 'intent-mh5-seam',
		validated: true,
		checks: {
			agent_identity: 'pass' as const,
			intent: 'pass' as const,
			payment: 'pass' as const,
			credential: 'pass' as const,
		},
		validation_errors: [],
	};
}

function channelResult() {
	return {
		result: {
			receipt: {
				receipt_id: 'receipt-mh5-seam',
				mandate_id: MANDATE_ID,
				merchant_id: MERCHANT_ID,
				sku: SKU,
				intent_id: 'intent-mh5-seam',
				l3a_digest: 'f'.repeat(64),
				l3b_digest: '1'.repeat(64),
				scheme: 'xrpl-paychan' as const,
				amount: merchant.products[0]!.price,
				proof: { channel_id: CHANNEL_ID, cumulative_drops: '50000' },
				merchant_validation: merchantValidation(),
				settlement: 'claim_accepted' as const,
				at: NOW.toISOString(),
			},
			data: typedData(),
		},
		proof: {
			scheme: 'xrpl-paychan' as const,
			channel_id: CHANNEL_ID,
			cumulative_drops: '50000',
			signature: '30',
			public_key: `ED${'E'.repeat(64)}`,
		},
		replayed: false,
	};
}

function exactResult() {
	return {
		receipt: {
			receipt_id: 'receipt-exact-seam',
			mandate_id: MANDATE_ID,
			merchant_id: MERCHANT_ID,
			sku: SKU,
			intent_id: 'intent-exact-seam',
			l3a_digest: '2'.repeat(64),
			l3b_digest: '3'.repeat(64),
			scheme: 'exact' as const,
			amount: merchant.products[0]!.price,
			proof: { tx_hash: TX_HASH },
			merchant_validation: { ...merchantValidation(), intentId: 'intent-exact-seam' },
			settlement: 'validated' as const,
			at: NOW.toISOString(),
		},
		data: typedData(),
	};
}

function exactAttempt(status: 'claimed' | 'delivered' = 'claimed') {
	return {
		id: 'attempt-exact-seam', principal: PRINCIPAL, mandateId: MANDATE_ID,
		idempotencyKey: IDEMPOTENCY_KEY, requestFingerprint: '4'.repeat(64),
		merchantId: MERCHANT_ID, sku: SKU, status, spendId: null, spendDay: null,
		amountUsd: null, preparedContextWrapped: null, preparedContextBinding: null,
		leaseAcquiredAt: NOW.toISOString(), signingStartedAt: null,
		firstEligibleLedgerIndex: null, signedBlob: null, txHash: status === 'delivered' ? TX_HASH : null,
		lastLedgerSequence: null, settlementUnknownAt: null, settledAt: null,
		deliveredAt: status === 'delivered' ? NOW.toISOString() : null, failedAt: null,
		ledgerIndex: null, deliveredAmount: null,
		receiptId: status === 'delivered' ? 'receipt-exact-seam' : null,
		merchantResponse: null, merchantResponseAt: null,
		result: status === 'delivered' ? exactResult() : null, failure: null,
		createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
	};
}

function channelAttempt(
	snapshot: Merchant = structuredClone(merchant),
	status: 'reserved' | 'claim_signed' | 'merchant_accepted' | 'delivered' = 'reserved',
) {
	return {
		id: 'attempt-channel-seam', principal: PRINCIPAL, mandateId: MANDATE_ID,
		idempotencyKey: IDEMPOTENCY_KEY, requestFingerprint: '5'.repeat(64),
		network: 'testnet' as const, rail: 'xrpl-paychan' as const,
		merchantId: MERCHANT_ID, sku: SKU, payer: PAYER, channelId: CHANNEL_ID,
		channelAmountDrops: '100000', priceDrops: '50000', previousDrops: '0',
		cumulativeDrops: '50000', claimToken: '6'.repeat(64),
		publicKey: `ED${'E'.repeat(64)}`,
		signature: status === 'reserved' ? null : '30',
		spendId: 'spend-channel-seam', spendDay: '2026-10-21',
		amountUsd: merchant.products[0]!.price.value,
		intentId: 'intent-mh5-seam', l3aDigest: 'f'.repeat(64), l3bDigest: '1'.repeat(64),
		receiptId: 'receipt-mh5-seam',
		retryMaterialWrapped: { ciphertext: new ArrayBuffer(17), iv: new ArrayBuffer(12), digest: '7'.repeat(64) },
		merchantResponse: status === 'merchant_accepted' || status === 'delivered' ? {} : null,
		result: status === 'delivered' ? channelResult().result : null,
		status, acceptedAt: status === 'merchant_accepted' || status === 'delivered' ? NOW.toISOString() : null,
		deliveredAt: status === 'delivered' ? NOW.toISOString() : null,
		createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), merchantSnapshot: snapshot,
	};
}

function exactStore(row: ReturnType<typeof exactAttempt> | null = null) {
	return {
		get: vi.fn(async () => row),
		claim: vi.fn(),
		acquireClaimRecovery: vi.fn(),
		readPreparedContext: vi.fn(),
		reserve: vi.fn(),
		acquireSigningLease: vi.fn(),
		markSigned: vi.fn(),
		markSettlementUnknown: vi.fn(),
		cacheMerchantResponse: vi.fn(),
		markSettled: vi.fn(),
		markDelivered: vi.fn(),
		markSigningFailed: vi.fn(),
		markFailed: vi.fn(),
		markExpiredAbsentFailed: vi.fn(),
		markValidatedFailed: vi.fn(),
	};
}

function services(overrides: Partial<Ap4mPurchaseServices> = {}) {
	const store = exactStore();
	const executeChannelPurchase = vi.fn(async () => channelResult());
	const value: Ap4mPurchaseServices = {
		store: store as never,
		channelStore: { read: vi.fn(async () => ({ outcome: 'absent' as const })) },
		getMerchant: vi.fn(() => merchant),
		getMandate: vi.fn(async () => mandate()),
		getPolicy: vi.fn(async () => ({ ...DEFAULT_POLICY, ap4m_enabled: true })),
		getDailySpentUsd: vi.fn(async () => '0'),
		getBaseDailySpentUsd: vi.fn(async () => 0),
		resolvePayer: vi.fn(async () => ({ status: 'ready' as const, payer: PAYER })),
		executeChannelPurchase,
		now: () => NOW,
		...overrides,
	};
	return { value, store, executeChannelPurchase };
}

const context = (value: Ap4mPurchaseServices) => ({ principal: PRINCIPAL, ap4mServices: value });

describe('ap4m.purchase payment-channel seam', () => {
	it('fails closed when the idempotency key has both exact and channel durable state', async () => {
		const store = exactStore(exactAttempt());
		const executeChannelPurchase = vi.fn();
		const test = services({
			store: store as never,
			channelStore: { read: vi.fn(async () => ({ outcome: 'pending' as const, attempt: channelAttempt() as never })) },
			executeChannelPurchase,
		});

		await expect(handleAp4mPurchase(context(test.value), args)).rejects.toMatchObject({
			code: 'IDEMPOTENCY_MISMATCH',
		});
		expect(executeChannelPurchase).not.toHaveBeenCalled();
		expect(test.value.getMandate).not.toHaveBeenCalled();
	});

	it('lets a delivered exact attempt win over current paychan selection without channel dispatch', async () => {
		const store = exactStore(exactAttempt('delivered'));
		const executeChannelPurchase = vi.fn();
		const test = services({ store: store as never, executeChannelPurchase });

		const result = await handleAp4mPurchase(context(test.value), args);
		expect(result).toEqual(exactResult());
		expect(result.receipt).toMatchObject({
			scheme: 'exact', settlement: 'validated', proof: { tx_hash: TX_HASH },
		});
		expect(executeChannelPurchase).not.toHaveBeenCalled();
		expect(test.value.getMandate).not.toHaveBeenCalled();
	});

	it.each([
		['inactive mandate', { getMandate: vi.fn(async () => mandate('REVOKED')) }, 'MANDATE_NOT_ACTIVE'],
		['disabled policy', { getPolicy: vi.fn(async () => ({ ...DEFAULT_POLICY, ap4m_enabled: false })) }, 'POLICY_BLOCKED'],
		['daily cap', { getDailySpentUsd: vi.fn(async () => '10') }, 'POLICY_BLOCKED'],
		['frozen payer', { resolvePayer: vi.fn(async () => ({ status: 'disabled' as const, payer: PAYER })) }, 'PAYER_FROZEN'],
	] as const)('does not dispatch for %s', async (_label, override, code) => {
		const test = services(override);
		await expect(handleAp4mPurchase(context(test.value), args)).rejects.toMatchObject({ code });
		expect(test.executeChannelPurchase).not.toHaveBeenCalled();
		expect(test.store.claim).not.toHaveBeenCalled();
	});

	it('dispatches a fresh channel purchase only after mandate, policy, daily and payer-ready gates', async () => {
		const order: string[] = [];
		const executeChannelPurchase = vi.fn(async () => { order.push('execute'); return channelResult(); });
		const test = services({
			getMandate: vi.fn(async () => { order.push('mandate'); return mandate(); }),
			getPolicy: vi.fn(async () => { order.push('policy'); return { ...DEFAULT_POLICY, ap4m_enabled: true }; }),
			getDailySpentUsd: vi.fn(async () => { order.push('mandate-daily'); return '0'; }),
			getBaseDailySpentUsd: vi.fn(async () => { order.push('base-daily'); return 0; }),
			resolvePayer: vi.fn(async () => { order.push('payer'); return { status: 'ready', payer: PAYER }; }),
			executeChannelPurchase,
		});

		const result = await handleAp4mPurchase(context(test.value), args);
		expect(result.receipt.settlement).toBe('claim_accepted');
		expect(result.evidence).toBeUndefined();
		expect(order.at(-1)).toBe('execute');
		expect(order).toEqual(expect.arrayContaining(['mandate', 'policy', 'mandate-daily', 'base-daily', 'payer']));
		expect(test.store.claim).not.toHaveBeenCalled();
	});

	it('resumes a pending channel attempt from its durable merchant snapshot despite registry mutation', async () => {
		const durable = structuredClone(merchant);
		const mutated = structuredClone(merchant);
		mutated.base_url = 'https://attacker.invalid/redirect';
		mutated.schemes = ['exact'];
		mutated.products[0]!.description = 'mutated catalog prose';
		const executeChannelPurchase = vi.fn(async () => channelResult());
		const getMerchant = vi.fn(() => mutated);
		const test = services({
			channelStore: { read: vi.fn(async () => ({
				outcome: 'pending' as const,
				attempt: channelAttempt(durable) as never,
			})) },
			getMandate: vi.fn(async () => mandate('ACTIVE', merchant.products[0]!.price.value)),
			getDailySpentUsd: vi.fn(async () => merchant.products[0]!.price.value),
			getMerchant,
			executeChannelPurchase,
		});

		await handleAp4mPurchase(context(test.value), args);
		expect(getMerchant).not.toHaveBeenCalled();
		expect(executeChannelPurchase).toHaveBeenCalledWith(expect.objectContaining({
			merchant: durable,
			product: durable.products[0],
			payer: PAYER,
			channel: mandate().mandate.channels[0],
		}));
	});

	it('replays a delivered channel result without consulting mutable registry or gates', async () => {
		const executeChannelPurchase = vi.fn();
		const getMerchant = vi.fn(() => undefined);
		const getMandate = vi.fn(async () => mandate('REVOKED'));
		const test = services({
			channelStore: { read: vi.fn(async () => ({
				outcome: 'delivered' as const,
				attempt: channelAttempt(merchant, 'delivered') as never,
				result: channelResult().result,
			})) },
			getMerchant,
			getMandate,
			executeChannelPurchase,
		});

		const result = await handleAp4mPurchase(context(test.value), args);
		expect(result).toEqual(channelResult().result);
		expect(result.receipt.proof).toEqual({ channel_id: CHANNEL_ID, cumulative_drops: '50000' });
		expect(result.receipt.proof).not.toHaveProperty('tx_hash');
		expect(getMerchant).not.toHaveBeenCalled();
		expect(getMandate).not.toHaveBeenCalled();
		expect(executeChannelPurchase).not.toHaveBeenCalled();
	});

	it('strict-parses the channel executor result and does not reinterpret its claim proof as a tx hash', async () => {
		const invalid = channelResult();
		(invalid.result.receipt.proof as Record<string, unknown>).signature = 'internal-field';
		const test = services({ executeChannelPurchase: vi.fn(async () => invalid) as never });
		await expect(handleAp4mPurchase(context(test.value), args)).rejects.toThrow();

		const valid = services();
		const result = await handleAp4mPurchase(context(valid.value), args);
		expect(result.receipt).toMatchObject({
			scheme: 'xrpl-paychan', settlement: 'claim_accepted',
			proof: { channel_id: CHANNEL_ID, cumulative_drops: '50000' },
		});
		expect(Object.keys(result.receipt.proof).sort()).toEqual(['channel_id', 'cumulative_drops']);
	});

	it('rejects an executor proof that disagrees with the bound receipt proof', async () => {
		const invalid = channelResult();
		invalid.proof.channel_id = 'C'.repeat(64);
		const test = services({ executeChannelPurchase: vi.fn(async () => invalid) });
		await expect(handleAp4mPurchase(context(test.value), args)).rejects.toMatchObject({
			code: 'PURCHASE_FAILED',
		});
	});

	it('does not charge a durable reserved attempt twice when retrying at the exact cap', async () => {
		const amount = merchant.products[0]!.price.value;
		const capped = mandate('ACTIVE', amount);
		capped.mandate.constraints.daily_max = amount;
		capped.mandate.constraints.total_max = amount;
		const test = services({
			channelStore: { read: vi.fn(async () => ({
				outcome: 'pending' as const,
				attempt: channelAttempt() as never,
			})) },
			getMandate: vi.fn(async () => capped),
			getDailySpentUsd: vi.fn(async () => amount),
		});

		await expect(handleAp4mPurchase(context(test.value), args)).resolves.toEqual(channelResult().result);
		expect(test.executeChannelPurchase).toHaveBeenCalledOnce();
	});

	it('fails closed when the selected channel executor is absent', async () => {
		const test = services();
		delete test.value.executeChannelPurchase;
		await expect(handleAp4mPurchase(context(test.value), args)).rejects.toMatchObject({
			code: 'AP4M_NOT_CONFIGURED',
			message: 'AP4M payment-channel executor is not configured',
		});
		expect(test.store.claim).not.toHaveBeenCalled();
	});
});
