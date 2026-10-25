import { encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { AP4M_PAYMENT_LEDGER_ABI } from '../src/ap4m-evm/abi';
import { AP4M_EVM_EVENT_PROFILE, validateAp4mEvmEventProfile } from '../src/ap4m-evm/event-config';
import { validateChannelRoles, validatePreparedVoucherRedemption } from '../src/ap4m-evm/prepare-validation';
import {
	AP4M_TYPED_DATA_DOMAIN,
	AP4M_VOUCHER_TYPES,
	rejectUnsupportedCloseChannelPurpose,
	validateVoucherTypedData,
} from '../src/ap4m-evm/typed-data-validation';

const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const FUNDING = '0x2222222222222222222222222222222222222222' as Address;
const PAYOUT = '0x3333333333333333333333333333333333333333' as Address;
const CHANNEL = `0x${'ab'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'44'.repeat(65)}` as Hex;

function transaction(overrides: Record<string, unknown> = {}) {
	return {
		chainId: AP4M_EVM_EVENT_PROFILE.chainId,
		from: AGENT,
		to: AP4M_EVM_EVENT_PROFILE.paymentLedger,
		data: encodeFunctionData({
			abi: AP4M_PAYMENT_LEDGER_ABI,
			functionName: 'redeemVoucher',
			args: [CHANNEL, 20n, SIGNATURE],
		}),
		value: '0',
		gasLimit: '250000',
		...overrides,
	};
}

function expectation(overrides: Record<string, unknown> = {}) {
	return {
		from: AGENT,
		maxGasLimit: 300_000n,
		channelId: CHANNEL,
		cumulativeAmount: '20',
		signature: SIGNATURE,
		...overrides,
	} as const;
}

function voucher(overrides: Record<string, unknown> = {}) {
	return {
		domain: AP4M_TYPED_DATA_DOMAIN,
		primaryType: 'Voucher',
		types: AP4M_VOUCHER_TYPES,
		message: { channelId: CHANNEL, cumulativeAmount: '20' },
		...overrides,
	};
}

describe('AP4M EVM protocol validation', () => {
	it('accepts only the exact compiled Testnet profile', () => {
		expect(validateAp4mEvmEventProfile({ ...AP4M_EVM_EVENT_PROFILE })).toBe(AP4M_EVM_EVENT_PROFILE);
		for (const patch of [
			{ chainId: 1 }, { rpcUrl: 'https://example.invalid' }, { paymentLedger: PAYOUT },
			{ rlusdDecimals: 6 }, { extra: true },
		]) {
			expect(() => validateAp4mEvmEventProfile({ ...AP4M_EVM_EVENT_PROFILE, ...patch }))
				.toThrowError(expect.objectContaining({ code: 'INVALID_PROFILE' }));
		}
	});

	it('decodes and matches every prepared-call binding', () => {
		expect(validatePreparedVoucherRedemption(transaction(), expectation()).args)
			.toEqual([CHANNEL, 20n, SIGNATURE]);
		for (const altered of [
			transaction({ chainId: 1 }), transaction({ from: FUNDING }), transaction({ to: PAYOUT }),
			transaction({ value: '1' }), transaction({ gasLimit: '300001' }), transaction({ data: '0x' }),
			transaction({ gasLimit: '0' }),
			transaction({ data: encodeFunctionData({
				abi: AP4M_PAYMENT_LEDGER_ABI,
				functionName: 'redeemVoucher',
				args: [CHANNEL, 21n, SIGNATURE],
			}) }),
		]) {
			expect(() => validatePreparedVoucherRedemption(altered, expectation()))
				.toThrowError(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }));
		}
		for (const signature of [
			`0x${'44'.repeat(64)}`,
			`0x${'44'.repeat(66)}`,
			`0x${'00'.repeat(65)}`,
		]) {
			expect(() => validatePreparedVoucherRedemption(
				transaction(), expectation({ signature }),
			)).toThrowError(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }));
		}
	});

	it('requires distinct wallet roles, the pinned token and a bounded channel', () => {
		const channel = {
			channelId: CHANNEL, agent: AGENT, fundingWallet: FUNDING, merchantPayout: PAYOUT,
			token: AP4M_EVM_EVENT_PROFILE.rlusdToken, cap: '100', cumulativeAmount: '20',
			generation: 1, status: 'open',
		};
		expect(validateChannelRoles(channel)).toEqual(channel);
		expect(() => validateChannelRoles({ ...channel, merchantPayout: AGENT }))
			.toThrowError(expect.objectContaining({ code: 'ROLE_COLLISION' }));
		expect(() => validateChannelRoles({ ...channel, merchantPayout: FUNDING }))
			.toThrowError(expect.objectContaining({ code: 'ROLE_COLLISION' }));
		expect(() => validateChannelRoles({ ...channel, cumulativeAmount: '101' }))
			.toThrowError(expect.objectContaining({ code: 'VOUCHER_OVER_CAP' }));
		expect(() => validateChannelRoles({ ...channel, cap: '0' }))
			.toThrowError(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }));
		expect(() => validateChannelRoles({ ...channel, agent: `0x${'0'.repeat(40)}` }))
			.toThrowError(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }));
		expect(() => validateChannelRoles({ ...channel, fundingWallet: AGENT })).not.toThrow();
	});

	it('binds vouchers to the local domain, channel and monotonic channel cap', async () => {
		const valid = await validateVoucherTypedData({
			envelope: voucher(), expectedChannelId: CHANNEL,
			previousCumulativeAmount: '10', channelCap: '100',
		});
		expect(valid.cumulativeAmount).toBe(20n);
		expect(valid.digest).toMatch(/^0x[0-9a-f]{64}$/);
		await expect(validateVoucherTypedData({
			envelope: voucher(), expectedChannelId: CHANNEL,
			previousCumulativeAmount: '20', channelCap: '100',
		})).rejects.toMatchObject({ code: 'VOUCHER_REPLAY' });
		await expect(validateVoucherTypedData({
			envelope: voucher(), expectedChannelId: CHANNEL,
			previousCumulativeAmount: '10', channelCap: '19',
		})).rejects.toMatchObject({ code: 'VOUCHER_OVER_CAP' });
		await expect(validateVoucherTypedData({
			envelope: voucher({ domain: { ...AP4M_TYPED_DATA_DOMAIN, chainId: 1 } }),
			expectedChannelId: CHANNEL, previousCumulativeAmount: '10', channelCap: '100',
		})).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
		await expect(validateVoucherTypedData({
			envelope: voucher({ domain: { ...AP4M_TYPED_DATA_DOMAIN, verifyingContract: 'not-an-address' } }),
			expectedChannelId: CHANNEL, previousCumulativeAmount: '10', channelCap: '100',
		})).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
		await expect(validateVoucherTypedData({
			envelope: voucher({ message: { channelId: CHANNEL, cumulativeAmount: (2n ** 256n).toString() } }),
			expectedChannelId: CHANNEL, previousCumulativeAmount: '10', channelCap: (2n ** 256n - 1n).toString(),
		})).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
		await expect(validateVoucherTypedData({
			envelope: voucher(), expectedChannelId: CHANNEL,
			previousCumulativeAmount: '10', channelCap: '100',
			expectedSigner: AGENT, signature: `0x${'44'.repeat(64)}`,
		})).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
	});

	it('fails closed for undocumented close-channel typed data', () => {
		expect(() => rejectUnsupportedCloseChannelPurpose({
			domain: AP4M_TYPED_DATA_DOMAIN,
			message: { channelId: CHANNEL },
		})).toThrowError(expect.objectContaining({
			code: 'INVALID_TYPED_DATA',
			message: expect.stringContaining('unsupported'),
		}));
	});
});
