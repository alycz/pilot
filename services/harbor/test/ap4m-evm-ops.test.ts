import { encodeFunctionData, hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { AP4M_PAYMENT_LEDGER_ABI } from '../src/ap4m-evm/abi';
import { AP4M_EVM_EVENT_PROFILE } from '../src/ap4m-evm/event-config';
import type { Ap4mEvmAttemptRow, Ap4mEvmChannelRow } from '../src/ap4m-evm/store';
import {
	Ap4mEvmPrepareApprovalArgsSchema,
	createAp4mEvmEventOps,
	type Ap4mEvmOperationServices,
	type Ap4mEvmPrepareApprovalArgs,
} from '../src/ops/ap4m-evm-event';

const CHANNEL = `0x${'11'.repeat(32)}`;
const TX_HASH = `0x${'22'.repeat(32)}`;
const CLAIM = `0x${'33'.repeat(32)}`;
const PAYOUT_TX = `0x${'44'.repeat(32)}`;
const AGENT_ACCOUNT = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const AGENT = AGENT_ACCOUNT.address;
const FUNDING = `0x${'66'.repeat(20)}`;
const PAYOUT = `0x${'77'.repeat(20)}`;
const NOW = '2026-10-25T10:00:00.000Z';
const EXPIRY = '2026-10-25T10:04:00.000Z';
const VALID_AFTER = '2026-10-25T09:00:00.000Z';
const VALID_BEFORE = '2026-10-25T11:00:00.000Z';
const REQUEST_FINGERPRINT = 'a'.repeat(64);
const ATTEMPT_TOKEN = 'b'.repeat(64);
const VOUCHER_TYPED_DATA = {
	domain: {
		name: 'AP4M Payment Ledger' as const, version: '1' as const,
		chainId: AP4M_EVM_EVENT_PROFILE.chainId,
		verifyingContract: AP4M_EVM_EVENT_PROFILE.paymentLedger,
	},
	primaryType: 'Voucher' as const,
	types: { Voucher: [
		{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' },
	] } as const,
	message: { channelId: CHANNEL as `0x${string}`, cumulativeAmount: 1000000000000000000n },
};
const TYPED_DATA_DIGEST = hashTypedData(VOUCHER_TYPED_DATA);
const SIGNATURE = await AGENT_ACCOUNT.signTypedData(VOUCHER_TYPED_DATA);

function prepareArgs(overrides: Record<string, unknown> = {}): Ap4mEvmPrepareApprovalArgs {
	return Ap4mEvmPrepareApprovalArgsSchema.parse({
		profile: {
			network: AP4M_EVM_EVENT_PROFILE.network,
			chain_id: AP4M_EVM_EVENT_PROFILE.chainId,
			payment_ledger: AP4M_EVM_EVENT_PROFILE.paymentLedger,
			pooled_escrow_vault: AP4M_EVM_EVENT_PROFILE.pooledEscrowVault,
			token: AP4M_EVM_EVENT_PROFILE.rlusdToken,
			token_decimals: AP4M_EVM_EVENT_PROFILE.rlusdDecimals,
		},
		channel_id: CHANNEL,
		roles: { merchant_id: 'merchant-one', agent_wallet: AGENT, funding_wallet: FUNDING, merchant_payout: PAYOUT },
		generation: 1,
		cap_base_units: '2000000000000000000', previous_cumulative: '0', next_cumulative: '1000000000000000000',
		idempotency_key: 'voucher-one', channel_valid_after: VALID_AFTER,
		channel_valid_before: VALID_BEFORE, approval_expires_at: EXPIRY,
		fee_model: 'legacy', max_gas_price: '10000000000', max_gas_limit: '300000',
		voucher_typed_data: {
			domain: {
				name: 'AP4M Payment Ledger', version: '1', chainId: AP4M_EVM_EVENT_PROFILE.chainId,
				verifyingContract: AP4M_EVM_EVENT_PROFILE.paymentLedger,
			},
			primaryType: 'Voucher',
			types: { Voucher: [
				{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' },
			] },
			message: { channelId: CHANNEL, cumulativeAmount: '1000000000000000000' },
		},
		...overrides,
	});
}

function channel(overrides: Partial<Ap4mEvmChannelRow> = {}): Ap4mEvmChannelRow {
	return {
		principal: 'principal-one', channelId: CHANNEL.toLowerCase(), merchantId: 'merchant-one',
		agentWallet: AGENT.toLowerCase(), fundingWallet: FUNDING.toLowerCase(), payoutWallet: PAYOUT.toLowerCase(),
		tokenAddress: AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase(), generation: 1,
		capBaseUnits: '2000000000000000000', cumulativeBaseUnits: '0', status: 'open',
		pendingIdempotencyKey: 'voucher-one', pendingRequestFingerprint: REQUEST_FINGERPRINT,
		pendingNextCumulative: '1000000000000000000', pendingAttemptToken: ATTEMPT_TOKEN,
		createdAt: NOW, updatedAt: NOW,
		...overrides,
	};
}

function attempt(status: Ap4mEvmAttemptRow['status'] = 'submission_unknown'): Ap4mEvmAttemptRow {
	return {
		principal: 'principal-one', channelId: CHANNEL.toLowerCase(), idempotencyKey: 'voucher-one',
		requestFingerprint: REQUEST_FINGERPRINT, merchantId: 'merchant-one', previousCumulative: '0',
		nextCumulative: '1000000000000000000', attemptToken: ATTEMPT_TOKEN, status,
		txHash: status === 'prepared' ? null : TX_HASH.toLowerCase(),
		receiptFingerprint: status === 'confirmed' ? 'c'.repeat(64) : null,
		blockNumber: status === 'confirmed' ? 100 : null, confirmations: status === 'confirmed' ? 6 : null,
		absenceFingerprint: status === 'failed_absent' ? 'd'.repeat(64) : null,
		createdAt: NOW, updatedAt: NOW,
	};
}

type MockServices = Ap4mEvmOperationServices & {
	prepareApproval: ReturnType<typeof vi.fn>;
	bindVoucher: ReturnType<typeof vi.fn>;
	recordSubmission: ReturnType<typeof vi.fn>;
	reconcile: ReturnType<typeof vi.fn>;
	status: ReturnType<typeof vi.fn>;
};

function mockServices(): MockServices {
	return {
		acceptance: 'reviewed-testnet-v1',
		now: () => new Date(NOW),
		prepareApproval: vi.fn(async ({ principal, args, requestFingerprint }: {
			principal: string; args: Ap4mEvmPrepareApprovalArgs; requestFingerprint: string;
		}) => ({
			approvalId: 'approval-one', expiresAt: args.approval_expires_at,
			channelValidAfter: args.channel_valid_after, channelValidBefore: args.channel_valid_before,
			requestFingerprint, attemptToken: ATTEMPT_TOKEN,
			typedDataDigest: TYPED_DATA_DIGEST,
			reservation: {
				principal, channelId: args.channel_id.toLowerCase(), merchantId: args.roles.merchant_id,
				agentWallet: args.roles.agent_wallet.toLowerCase(), fundingWallet: args.roles.funding_wallet.toLowerCase(),
				payoutWallet: args.roles.merchant_payout.toLowerCase(), tokenAddress: AP4M_EVM_EVENT_PROFILE.rlusdToken.toLowerCase(),
				generation: args.generation, capBaseUnits: args.cap_base_units, nextCumulative: args.next_cumulative,
				idempotencyKey: args.idempotency_key, requestFingerprint,
				attemptToken: ATTEMPT_TOKEN, at: NOW,
			},
			channel: channel({ pendingRequestFingerprint: requestFingerprint }),
			transactionExpectation: {
				chainId: AP4M_EVM_EVENT_PROFILE.chainId, from: args.roles.agent_wallet,
				to: AP4M_EVM_EVENT_PROFILE.paymentLedger, value: '0' as const,
				feeModel: 'legacy' as const, maxGasPrice: args.max_gas_price,
				maxGasLimit: args.max_gas_limit, functionName: 'redeemVoucher' as const,
				channelId: args.channel_id, cumulativeAmount: args.next_cumulative,
			},
		})),
		bindVoucher: vi.fn(async () => ({
			approvalId: 'approval-one', expiresAt: EXPIRY,
			typedDataDigest: TYPED_DATA_DIGEST,
			recoveredSigner: AGENT, requestFingerprint: REQUEST_FINGERPRINT, attemptToken: ATTEMPT_TOKEN,
			channel: channel(), attempt: attempt('prepared'),
			transaction: {
				chainId: AP4M_EVM_EVENT_PROFILE.chainId, from: AGENT, to: AP4M_EVM_EVENT_PROFILE.paymentLedger,
				data: encodeFunctionData({
					abi: AP4M_PAYMENT_LEDGER_ABI, functionName: 'redeemVoucher',
					args: [{ channelId: CHANNEL, cumulativeAmount: 1000000000000000000n }, SIGNATURE],
				}),
				value: '0', gasLimit: '250000', feeModel: 'legacy' as const, gasPrice: '1000000000',
			},
			feeModel: 'legacy' as const, gasPrice: '1000000000', maxGasPrice: '10000000000', maxGasLimit: '300000',
		})),
		recordSubmission: vi.fn(async () => ({ status: 'reconciliation_required' as const, txHash: TX_HASH, attempt: attempt() })),
		reconcile: vi.fn(async () => ({ status: 'pending' as const, txHash: TX_HASH, attempt: attempt(), channel: channel() })),
		status: vi.fn(async () => ({ channel: channel(), attempt: null })),
	};
}

function findOp(services: Ap4mEvmOperationServices | undefined, name: string) {
	const selected = createAp4mEvmEventOps(services).find((candidate) => candidate.name === name);
	if (!selected) throw new Error(`missing operation ${name}`);
	return selected;
}

async function invoke(services: Ap4mEvmOperationServices | undefined, name: string, args: unknown) {
	const selected = findOp(services, name);
	return selected.handler({ principal: 'principal-one' }, selected.args.parse(args));
}

describe('AP4M EVM event operations', () => {
	it('remain disabled unless a reviewed service is injected into the factory', async () => {
		await expect(invoke(undefined, 'ap4m.evmPrepareApproval', prepareArgs())).rejects.toMatchObject({ code: 'AP4M_EVM_DISABLED' });
		await expect(invoke(undefined, 'ap4m.evmStatus', { channel_id: CHANNEL })).rejects.toMatchObject({ code: 'AP4M_EVM_DISABLED' });
	});

	it('rejects unreviewed targets, role collisions, fee-shape changes, and mismatched voucher values before effects', () => {
		for (const args of [
			{ ...prepareArgs(), profile: { ...prepareArgs().profile, chain_id: 1 } },
			{ ...prepareArgs(), roles: { ...prepareArgs().roles, merchant_payout: AGENT } },
			{ ...prepareArgs(), fee_model: 'eip1559' },
			{ ...prepareArgs(), next_cumulative: '0' },
			{ ...prepareArgs(), voucher_typed_data: { ...prepareArgs().voucher_typed_data,
				message: { channelId: CHANNEL, cumulativeAmount: '2' } } },
		]) expect(() => findOp(mockServices(), 'ap4m.evmPrepareApproval').args.parse(args)).toThrow();
	});

	it('returns a short-lived exact approval with server-generated tokens and no signature authority', async () => {
		const services = mockServices();
		await expect(invoke(services, 'ap4m.evmPrepareApproval', prepareArgs())).resolves.toMatchObject({
			approvalId: 'approval-one', expiresAt: EXPIRY, attemptToken: ATTEMPT_TOKEN,
			requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(services.prepareApproval).toHaveBeenCalledWith({
			principal: 'principal-one', args: prepareArgs(), requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(prepareArgs()).not.toHaveProperty('requestFingerprint');
		expect(prepareArgs()).not.toHaveProperty('attemptToken');
		expect(await services.prepareApproval.mock.results[0]?.value).not.toHaveProperty('recoveredSigner');
	});

	it('rejects unbounded windows and widened preparation targets', async () => {
		const services = mockServices();
		await expect(invoke(services, 'ap4m.evmPrepareApproval', prepareArgs({
			approval_expires_at: '2026-10-25T10:05:00.001Z',
		}))).rejects.toMatchObject({ code: 'AP4M_EVM_APPROVAL_EXPIRED' });
		await expect(invoke(services, 'ap4m.evmPrepareApproval', prepareArgs({
			channel_valid_before: '2026-10-25T10:03:00.000Z',
		}))).rejects.toMatchObject({ code: 'AP4M_EVM_APPROVAL_EXPIRED' });
		expect(services.prepareApproval).not.toHaveBeenCalled();

		const baseline = mockServices();
		services.prepareApproval.mockImplementationOnce(async (input: {
			principal: string; args: Ap4mEvmPrepareApprovalArgs; requestFingerprint: string;
		}) => {
			const safe = await baseline.prepareApproval(input);
			return { ...safe, transactionExpectation: { ...safe.transactionExpectation, to: PAYOUT } };
		});
		await expect(invoke(services, 'ap4m.evmPrepareApproval', prepareArgs())).rejects.toMatchObject({ code: 'AP4M_EVM_INVALID_BINDING' });
	});

	it('recovers the exact agent only after explicit voucher signing and validates the decoded call and fee ceiling', async () => {
		const services = mockServices();
		const args = {
			approval_id: 'approval-one', channel_id: CHANNEL,
			idempotency_key: 'voucher-one', voucher_signature: SIGNATURE,
		};
		await expect(invoke(services, 'ap4m.evmBindVoucher', args)).resolves.toMatchObject({
			recoveredSigner: AGENT, feeModel: 'legacy', gasPrice: '1000000000',
		});
		expect(services.bindVoucher).toHaveBeenCalledWith({ principal: 'principal-one', args });

		const safe = await mockServices().bindVoucher({ principal: 'principal-one', args });
		services.bindVoucher.mockResolvedValueOnce({ ...safe, recoveredSigner: FUNDING });
		await expect(invoke(services, 'ap4m.evmBindVoucher', args)).rejects.toMatchObject({ code: 'AP4M_EVM_INVALID_BINDING' });
		services.bindVoucher.mockResolvedValueOnce({ ...safe, gasPrice: '10000000001' });
		await expect(invoke(services, 'ap4m.evmBindVoucher', args)).rejects.toMatchObject({ code: 'AP4M_EVM_INVALID_BINDING' });
	});

	it('records a wallet-returned hash only as reconciliation-required', async () => {
		const services = mockServices();
		const args = { approval_id: 'approval-one', channel_id: CHANNEL, idempotency_key: 'voucher-one', tx_hash: TX_HASH };
		await expect(invoke(services, 'ap4m.evmRecordSubmission', args)).resolves.toMatchObject({ status: 'reconciliation_required' });
		expect(services.recordSubmission).toHaveBeenCalledWith({ principal: 'principal-one', args });
		services.recordSubmission.mockResolvedValueOnce({ status: 'already_recorded', txHash: `0x${'99'.repeat(32)}`, attempt: attempt() });
		await expect(invoke(services, 'ap4m.evmRecordSubmission', args)).rejects.toMatchObject({ code: 'AP4M_EVM_INVALID_BINDING' });
		expect(services).not.toHaveProperty('markAbsent');
	});

	it('requires exact merchant payout evidence before confirmed settlement', async () => {
		const services = mockServices();
		const args = { approval_id: 'approval-one', channel_id: CHANNEL, idempotency_key: 'voucher-one', tx_hash: TX_HASH };
		await expect(invoke(services, 'ap4m.evmReconcile', args)).resolves.toMatchObject({ status: 'pending' });
		services.reconcile.mockResolvedValueOnce({ status: 'confirmed', txHash: TX_HASH, attempt: attempt('confirmed'), channel: channel() });
		await expect(invoke(services, 'ap4m.evmReconcile', args)).rejects.toMatchObject({ code: 'AP4M_EVM_UNSUPPORTED_EVIDENCE' });
		services.reconcile.mockResolvedValueOnce({
			status: 'confirmed', txHash: TX_HASH, attempt: attempt('confirmed'), channel: channel(),
			settlementEvidence: {
				source: 'verified-on-chain',
				claimId: CLAIM, payoutTransactionHash: PAYOUT_TX, recipient: PAYOUT,
				payoutBlockHash: `0x${'99'.repeat(32)}`, payoutBlockNumber: 120, confirmations: 6,
				token: AP4M_EVM_EVENT_PROFILE.rlusdToken, amountBaseUnits: '1000000000000000000',
			},
		});
		await expect(invoke(services, 'ap4m.evmReconcile', args)).resolves.toMatchObject({
			status: 'confirmed', settlementEvidence: { recipient: PAYOUT },
		});
	});

	it('keeps status principal-scoped and excludes sign, channel-open, close and settlement-trigger operations', async () => {
		const services = mockServices();
		await expect(invoke(services, 'ap4m.evmStatus', { channel_id: CHANNEL, idempotency_key: 'voucher-one' }))
			.resolves.toMatchObject({ channel: { principal: 'principal-one' }, attempt: null });
		expect(services.status).toHaveBeenCalledWith({ principal: 'principal-one', args: {
			channel_id: CHANNEL, idempotency_key: 'voucher-one',
		} });
		expect(createAp4mEvmEventOps(services).map(({ name }) => name)).toEqual([
			'ap4m.evmPrepareApproval', 'ap4m.evmBindVoucher', 'ap4m.evmRecordSubmission',
			'ap4m.evmReconcile', 'ap4m.evmStatus',
		]);
	});
});
