import { describe, expect, it, vi } from 'vitest';

import {
	Ap4mEvmEventConfigurationError,
	createAp4mEvmEventAdapter,
} from '../src/ap4m-evm/adapter';
import type {
	Ap4mEvmAttemptRow,
	Ap4mEvmStore,
	ReserveAp4mEvmVoucherInput,
} from '../src/ap4m-evm/store';
import {
	AP4M_TYPED_DATA_DOMAIN,
	AP4M_VOUCHER_TYPES,
} from '../src/ap4m-evm/typed-data-validation';

const CHANNEL = `0x${'1'.repeat(64)}`;
const TX_HASH = `0x${'2'.repeat(64)}`;
const NOW = '2026-10-24T20:00:00.000Z';

function request(): ReserveAp4mEvmVoucherInput {
	return {
		principal: 'principal', channelId: CHANNEL, merchantId: 'merchant',
		agentWallet: `0x${'3'.repeat(40)}`, fundingWallet: `0x${'4'.repeat(40)}`,
		payoutWallet: `0x${'5'.repeat(40)}`,
		tokenAddress: '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3',
		generation: 0,
		capBaseUnits: '2000000000000000000', nextCumulative: '1000000000000000000',
		idempotencyKey: 'voucher-1', requestFingerprint: 'a'.repeat(64), attemptToken: 'b'.repeat(64), at: NOW,
	};
}

function voucher(cumulativeAmount = request().nextCumulative) {
	return {
		domain: AP4M_TYPED_DATA_DOMAIN,
		primaryType: 'Voucher' as const,
		types: AP4M_VOUCHER_TYPES,
		message: { channelId: CHANNEL, cumulativeAmount },
	};
}

function mockStore(): Ap4mEvmStore {
	return {
		reserve: vi.fn(async (input) => ({
			outcome: 'reserved' as const,
			channel: {
				principal: input.principal, channelId: input.channelId, merchantId: input.merchantId,
				agentWallet: input.agentWallet, fundingWallet: input.fundingWallet, payoutWallet: input.payoutWallet,
				tokenAddress: input.tokenAddress, generation: input.generation,
				capBaseUnits: input.capBaseUnits, cumulativeBaseUnits: '0',
				status: 'open' as const, pendingIdempotencyKey: input.idempotencyKey,
				pendingRequestFingerprint: input.requestFingerprint, pendingNextCumulative: input.nextCumulative,
				pendingAttemptToken: input.attemptToken, createdAt: input.at, updatedAt: input.at,
			},
			attempt: {
				principal: input.principal, channelId: input.channelId, idempotencyKey: input.idempotencyKey,
				requestFingerprint: input.requestFingerprint, merchantId: input.merchantId,
				previousCumulative: '0', nextCumulative: input.nextCumulative, attemptToken: input.attemptToken,
				status: 'prepared' as const, txHash: null, receiptFingerprint: null, blockNumber: null,
				confirmations: null, absenceFingerprint: null, createdAt: input.at, updatedAt: input.at,
			},
		})),
		markSubmissionUnknown: vi.fn(), confirm: vi.fn(), markAbsent: vi.fn(),
		getChannel: vi.fn(async () => null), getAttempt: vi.fn(), getAttemptByHash: vi.fn(async () => null),
	};
}

describe('AP4M EVM event adapter gates', () => {
	it('is absent by default and does not touch the store', () => {
		const store = mockStore();
		expect(createAp4mEvmEventAdapter({}, store)).toBeNull();
		expect(store.reserve).not.toHaveBeenCalled();
	});

	it.each([
		[{ AP4M_EVM_EVENT_ENABLED: 'yes' }, 'CONFIGURATION_INVALID'],
		[{ AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '0' }, 'CONFIGURATION_INVALID'],
		[{ AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1', LIVE: '1' }, 'CONFIGURATION_INVALID'],
		[{ AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1', LIVE: 'true' }, 'CONFIGURATION_INVALID'],
		[{ AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1', MAINNET_EXECUTION: '1' }, 'CONFIGURATION_INVALID'],
		[{ AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'live', HARBOR_MOCK: '0', LIVE: '1' }, 'RAIL_NOT_CONNECTED'],
	] as const)('fails closed for %j', (env, code) => {
		expect(() => createAp4mEvmEventAdapter(env, mockStore()))
			.toThrowError(expect.objectContaining({ code }));
	});

	it('only prepares durable approval state and exposes no effect methods', async () => {
		const store = mockStore();
		const adapter = createAp4mEvmEventAdapter({
			AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1', LIVE: '0',
		}, store);
		expect(adapter).not.toBeNull();
		const result = await adapter!.prepareVoucher(request(), voucher());
		expect(result.status).toBe('approval_required');
		expect(result.digest).toMatch(/^0x[0-9a-f]{64}$/);
		expect(store.reserve).toHaveBeenCalledTimes(1);
		expect(Object.keys(adapter!).sort()).toEqual([
			'mode', 'prepareVoucher', 'profile', 'reconcileByHash', 'rejectClosePurpose',
			'validatePreparedRedemption', 'validateReceipt',
		]);
		expect(adapter).not.toHaveProperty('fetch');
		expect(adapter).not.toHaveProperty('sign');
		expect(adapter).not.toHaveProperty('send');
		expect(adapter).not.toHaveProperty('schedule');
	});

	it('rejects non-event tokens before durable reservation', async () => {
		const store = mockStore();
		const adapter = createAp4mEvmEventAdapter({
			AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1',
		}, store)!;
		await expect(adapter.prepareVoucher(
			{ ...request(), tokenAddress: `0x${'9'.repeat(40)}` },
			voucher(),
		))
			.rejects.toMatchObject({ code: 'INVALID_PREPARED_CALL' });
		expect(store.reserve).not.toHaveBeenCalled();
	});

	it('binds the voucher value before creating durable state', async () => {
		const store = mockStore();
		const adapter = createAp4mEvmEventAdapter({
			AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1',
		}, store)!;
		await expect(adapter.prepareVoucher(request(), voucher('2')))
			.rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
		expect(store.reserve).not.toHaveBeenCalled();
	});

	it('rejects the unsupported close purpose without touching durable state', () => {
		const store = mockStore();
		const adapter = createAp4mEvmEventAdapter({
			AP4M_EVM_EVENT_ENABLED: '1', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1',
		}, store)!;
		expect(() => adapter.rejectClosePurpose({})).toThrowError(
			expect.objectContaining({ code: 'INVALID_TYPED_DATA' }),
		);
		expect(store.reserve).not.toHaveBeenCalled();
	});

	it('reconciles only already-durable state by hash', async () => {
		const store = mockStore();
		const attempt: Ap4mEvmAttemptRow = {
			principal: 'principal', channelId: CHANNEL, idempotencyKey: 'voucher-1',
			requestFingerprint: 'a'.repeat(64), merchantId: 'merchant', previousCumulative: '0',
			nextCumulative: '1', attemptToken: 'b'.repeat(64), status: 'submission_unknown', txHash: TX_HASH,
			receiptFingerprint: null, blockNumber: null, confirmations: null, absenceFingerprint: null,
			createdAt: NOW, updatedAt: NOW,
		};
		vi.mocked(store.getAttemptByHash).mockResolvedValue(attempt);
		const adapter = createAp4mEvmEventAdapter({
			AP4M_EVM_EVENT_ENABLED: 'true', AP4M_EVM_EVENT_MODE: 'mock', HARBOR_MOCK: '1',
		}, store)!;
		expect(await adapter.reconcileByHash(TX_HASH)).toEqual({ status: 'pending', attempt });
		expect(store.markSubmissionUnknown).not.toHaveBeenCalled();
		expect(store.confirm).not.toHaveBeenCalled();
		expect(store.markAbsent).not.toHaveBeenCalled();
	});

	it('uses a typed configuration error', () => {
		expect(new Ap4mEvmEventConfigurationError('x', 'RAIL_NOT_CONNECTED')).toBeInstanceOf(Error);
	});
});
