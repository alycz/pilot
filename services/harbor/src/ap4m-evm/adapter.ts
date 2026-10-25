import type { Hex } from 'viem';

import { AP4M_EVM_EVENT_PROFILE } from './event-config';
import {
	validateChannelRoles,
	validatePreparedVoucherRedemption,
	type PreparedVoucherRedemptionExpectation,
} from './prepare-validation';
import {
	validateFinalizedReceipt,
	type ReceiptEventExpectation,
} from './receipt-validation';
import type {
	Ap4mEvmAttemptRow,
	Ap4mEvmStore,
	ReserveAp4mEvmVoucherInput,
	ReserveAp4mEvmVoucherResult,
} from './store';
import {
	rejectUnsupportedCloseChannelPurpose,
	validateVoucherTypedData,
} from './typed-data-validation';

export type Ap4mEvmEventEnv = Readonly<{
	AP4M_EVM_EVENT_ENABLED?: string;
	AP4M_EVM_EVENT_MODE?: string;
	HARBOR_MOCK?: string;
	LIVE?: string;
	MAINNET_EXECUTION?: string;
}>;

export class Ap4mEvmEventConfigurationError extends Error {
	constructor(
		message: string,
		readonly code: 'CONFIGURATION_INVALID' | 'RAIL_NOT_CONNECTED',
	) {
		super(message);
		this.name = 'Ap4mEvmEventConfigurationError';
	}
}

export type Ap4mEvmMockAdapter = Readonly<{
	mode: 'mock';
	profile: typeof AP4M_EVM_EVENT_PROFILE;
	prepareVoucher(input: ReserveAp4mEvmVoucherInput, voucherEnvelope: unknown): Promise<Readonly<{
		status: 'approval_required' | 'pending' | 'replay' | 'blocked';
		digest: Hex;
		result: ReserveAp4mEvmVoucherResult;
	}>>;
	validatePreparedRedemption(
		transaction: unknown,
		expected: PreparedVoucherRedemptionExpectation,
	): ReturnType<typeof validatePreparedVoucherRedemption>;
	validateReceipt(
		receipt: unknown,
		expected: ReceiptEventExpectation,
	): ReturnType<typeof validateFinalizedReceipt>;
	rejectClosePurpose(value: unknown): never;
	reconcileByHash(txHash: string): Promise<Readonly<{
		status: 'not_found' | 'pending' | 'confirmed' | 'failed_absent';
		attempt: Ap4mEvmAttemptRow | null;
	}>>;
}>;

function canonicalBoolean(value: string | undefined, field: string, defaultValue = false): boolean {
	if (value === undefined || value === '') return defaultValue;
	if (value === '0' || value === 'false') return false;
	if (value === '1' || value === 'true') return true;
	throw new Ap4mEvmEventConfigurationError(
		`${field} must be a canonical boolean`,
		'CONFIGURATION_INVALID',
	);
}

/**
 * The first event adapter intentionally exposes only no-I/O validation and
 * durable mock-state seams. It has no signer, transport, scheduler, or
 * fallback and cannot submit transactions.
 */
export function createAp4mEvmEventAdapter(
	env: Ap4mEvmEventEnv,
	store: Ap4mEvmStore,
): Ap4mEvmMockAdapter | null {
	if (!canonicalBoolean(env.AP4M_EVM_EVENT_ENABLED, 'AP4M_EVM_EVENT_ENABLED')) return null;
	if (canonicalBoolean(env.MAINNET_EXECUTION, 'MAINNET_EXECUTION')) {
		throw new Ap4mEvmEventConfigurationError(
			'AP4M EVM event rail refuses mainnet execution',
			'CONFIGURATION_INVALID',
		);
	}
	if (env.AP4M_EVM_EVENT_MODE === 'live') {
		throw new Ap4mEvmEventConfigurationError(
			'AP4M EVM event live signer and submission rail are not connected',
			'RAIL_NOT_CONNECTED',
		);
	}
	if (
		env.AP4M_EVM_EVENT_MODE !== 'mock' ||
		!canonicalBoolean(env.HARBOR_MOCK, 'HARBOR_MOCK') ||
		canonicalBoolean(env.LIVE, 'LIVE')
	) {
		throw new Ap4mEvmEventConfigurationError(
			'AP4M EVM event mock mode requires HARBOR_MOCK=1 and LIVE disabled',
			'CONFIGURATION_INVALID',
		);
	}

	return Object.freeze({
		mode: 'mock' as const,
		profile: AP4M_EVM_EVENT_PROFILE,
		async prepareVoucher(input: ReserveAp4mEvmVoucherInput, voucherEnvelope: unknown) {
			validateChannelRoles({
				channelId: input.channelId,
				agent: input.agentWallet,
				fundingWallet: input.fundingWallet,
				merchantPayout: input.payoutWallet,
				token: input.tokenAddress,
				cap: input.capBaseUnits,
				cumulativeAmount: input.nextCumulative,
				generation: input.generation,
				status: 'open',
			});
			const existingChannel = await store.getChannel(input.channelId);
			const voucher = await validateVoucherTypedData({
				envelope: voucherEnvelope,
				expectedChannelId: input.channelId as Hex,
				previousCumulativeAmount: existingChannel?.cumulativeBaseUnits ?? '0',
				channelCap: input.capBaseUnits,
			});
			if (voucher.cumulativeAmount.toString() !== input.nextCumulative) {
				throw new Ap4mEvmEventConfigurationError(
					'Voucher cumulative amount does not match the durable reservation',
					'CONFIGURATION_INVALID',
				);
			}
			const result = await store.reserve(input);
			const status = result.outcome === 'reserved' || result.outcome === 'owner'
				? 'approval_required'
				: result.outcome === 'pending'
					? 'pending'
					: result.outcome === 'replay'
						? 'replay'
						: 'blocked';
			return { status, digest: voucher.digest, result };
		},
		validatePreparedRedemption: validatePreparedVoucherRedemption,
		validateReceipt: validateFinalizedReceipt,
		rejectClosePurpose: rejectUnsupportedCloseChannelPurpose,
		async reconcileByHash(txHash: string) {
			const attempt = await store.getAttemptByHash(txHash);
			if (attempt === null) return { status: 'not_found' as const, attempt };
			return {
				status: attempt.status === 'confirmed'
					? 'confirmed' as const
					: attempt.status === 'failed_absent'
						? 'failed_absent' as const
						: 'pending' as const,
				attempt,
			};
		},
	});
}
