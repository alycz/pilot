import { describe, expect, it, vi } from 'vitest';
import type { DelegateSet, Transaction } from 'xrpl';

import {
	DEFAULT_DELEGATED_PERMISSIONS,
	DelegationDataError,
	DelegationValidationError,
	NEVER_DELEGATED_PERMISSIONS,
	NON_DELEGABLE_PERMISSION_NAMES,
	buildDelegateRevoke,
	buildDelegateSet,
	normalizeDelegatePermissions,
	prepareDelegateRevoke,
	prepareDelegateSet,
	readDelegatePermissions,
	validatePermissions,
	type DelegationLedgerAdapter,
} from '../src/exec/delegation';
import { signDelegatedTransaction } from '../src/exec/sign';

const owner = 'rOwner';
const delegate = 'rDelegate';

function ledgerEntry(permissions: unknown = [{ Permission: { PermissionValue: 'OfferCreate' } }]): Record<string, unknown> {
	return {
		LedgerEntryType: 'Delegate',
		Account: owner,
		Authorize: delegate,
		Permissions: permissions,
		Flags: 0,
		OwnerNode: '0',
	};
}

function adapter(entry: unknown | null = ledgerEntry()): DelegationLedgerAdapter & {
	prepareTransaction: ReturnType<typeof vi.fn>;
	readDelegate: ReturnType<typeof vi.fn>;
} {
	return {
		prepareTransaction: vi.fn(async (_network: string, transaction: DelegateSet) => ({
			...transaction,
			Fee: '12',
			Sequence: 7,
			LastLedgerSequence: 99,
		})),
		readDelegate: vi.fn(async () => entry),
		isAccountFunded: vi.fn(async () => true),
	};
}

describe('DelegateSet construction', () => {
	it('uses exactly the seven blueprint defaults and produces the XRPL nested permission shape', () => {
		expect(DEFAULT_DELEGATED_PERMISSIONS).toEqual([
			'OfferCreate',
			'OfferCancel',
			'TrustSet',
			'AMMDeposit',
			'AMMWithdraw',
			'EscrowFinish',
			'CheckCash',
		]);
		expect(buildDelegateSet(owner, delegate)).toEqual({
			TransactionType: 'DelegateSet',
			Account: owner,
			Authorize: delegate,
			Permissions: DEFAULT_DELEGATED_PERMISSIONS.map((PermissionValue) => ({ Permission: { PermissionValue } })),
		});
	});

	it('accepts custom safe permissions without mutating the caller input', () => {
		const permissions = ['CheckCancel', 'PaymentChannelClaim'];
		expect(buildDelegateSet(owner, delegate, permissions)).toEqual({
			TransactionType: 'DelegateSet',
			Account: owner,
			Authorize: delegate,
			Permissions: [
				{ Permission: { PermissionValue: 'CheckCancel' } },
				{ Permission: { PermissionValue: 'PaymentChannelClaim' } },
			],
		});
		expect(permissions).toEqual(['CheckCancel', 'PaymentChannelClaim']);
	});

	it('builds revocation as an otherwise identical DelegateSet with empty Permissions', () => {
		expect(buildDelegateRevoke(owner, delegate)).toEqual({
			TransactionType: 'DelegateSet',
			Account: owner,
			Authorize: delegate,
			Permissions: [],
		});
	});

	it('prepares grants and revocations through the injected adapter', async () => {
		const ledger = adapter();
		await expect(prepareDelegateSet(ledger, 'testnet', owner, delegate, ['OfferCancel'])).resolves.toMatchObject({
			TransactionType: 'DelegateSet',
			Permissions: [{ Permission: { PermissionValue: 'OfferCancel' } }],
			Fee: '12',
		});
		await expect(prepareDelegateRevoke(ledger, 'testnet', owner, delegate)).resolves.toMatchObject({ Permissions: [], Fee: '12' });
		expect(ledger.prepareTransaction).toHaveBeenNthCalledWith(1, 'testnet', buildDelegateSet(owner, delegate, ['OfferCancel']));
		expect(ledger.prepareTransaction).toHaveBeenNthCalledWith(2, 'testnet', buildDelegateRevoke(owner, delegate));
	});

	it.each([
		{ Authorize: 'rChanged' },
		{ Permissions: [{ Permission: { PermissionValue: 'TrustSet' } }] },
		{ TxnSignature: 'ABC' },
		{ Signers: [] },
		{ SigningPubKey: 'EDABC' },
	])('rejects a prepared transaction that is mutated or signed: %j', async (mutation) => {
		const ledger = adapter();
		ledger.prepareTransaction.mockImplementation(async (_network: string, transaction: DelegateSet) => ({
			...transaction,
			...mutation,
		}));
		await expect(prepareDelegateSet(ledger, 'testnet', owner, delegate)).rejects.toThrow(DelegationDataError);
	});
});

describe('permission validation', () => {
	it.each(NEVER_DELEGATED_PERMISSIONS)('rejects blueprint never-delegated permission %s', (permission) => {
		expect(() => validatePermissions([permission])).toThrow(DelegationValidationError);
	});

	it.each(NON_DELEGABLE_PERMISSION_NAMES)('rejects blueprint exact non-delegable permission %s', (permission) => {
		expect(() => validatePermissions([permission])).toThrow(DelegationValidationError);
	});

	it.each([
		'VaultCreate',
		'VaultDeposit',
		'VaultFutureType',
		'LoanSet',
		'LoanPay',
		'LoanFutureType',
		'LoanBrokerSet',
		'LoanBrokerCoverDeposit',
		'LoanBrokerFutureType',
	])('rejects blueprint non-delegable pattern match %s', (permission) => {
		expect(() => validatePermissions([permission])).toThrow(DelegationValidationError);
	});

	it('rejects duplicates', () => {
		expect(() => validatePermissions(['OfferCreate', 'OfferCreate'])).toThrow(/Duplicate permission/);
	});

	it('rejects more than ten permissions', () => {
		expect(() => validatePermissions(Array.from({ length: 11 }, (_, index) => `SafeType${index}`))).toThrow(
			/more than 10/,
		);
	});

	it('rejects an empty permission list', () => {
		expect(() => validatePermissions([])).toThrow(DelegationValidationError);
	});

	it.each([
		[''],
		[' OfferCreate'],
		['OfferCreate '],
		['Offer Create'],
		[1] as unknown as string[],
	])('rejects empty or non-exact permission values: %j', (permissions) => {
		expect(() => validatePermissions(permissions)).toThrow(DelegationValidationError);
	});
});

describe('Delegate ledger-entry normalization', () => {
	it('copies exact string permissions and canonicalizes valid numeric server fallbacks', () => {
		const entry = ledgerEntry([
			{ Permission: { PermissionValue: 'OfferCreate' } },
			{ Permission: { PermissionValue: 65537 } },
		]);
		expect(normalizeDelegatePermissions(entry, { owner, delegate })).toEqual(['OfferCreate', '65537']);
	});

	it('reads the matching Delegate entry through the adapter and treats a missing entry as revoked', async () => {
		const active = adapter(ledgerEntry([{ Permission: { PermissionValue: 'TrustSet' } }]));
		await expect(readDelegatePermissions(active, 'testnet', owner, delegate)).resolves.toEqual(['TrustSet']);
		expect(active.readDelegate).toHaveBeenCalledWith('testnet', owner, delegate);

		const missing = adapter(null);
		await expect(readDelegatePermissions(missing, 'testnet', owner, delegate)).resolves.toBeNull();
	});

	it.each([
		null,
		{},
		ledgerEntry([]),
		ledgerEntry(Array.from({ length: 11 }, () => ({ Permission: { PermissionValue: 'OfferCreate' } }))),
		ledgerEntry([null]),
		ledgerEntry([{ Wrong: { PermissionValue: 'OfferCreate' } }]),
		ledgerEntry([{ Permission: { Wrong: 'OfferCreate' } }]),
		ledgerEntry([{ Permission: { PermissionValue: '' } }]),
		ledgerEntry([{ Permission: { PermissionValue: ' OfferCreate' } }]),
		ledgerEntry([{ Permission: { PermissionValue: 0 } }]),
		ledgerEntry([{ Permission: { PermissionValue: -1 } }]),
		ledgerEntry([{ Permission: { PermissionValue: 1.5 } }]),
		ledgerEntry([{ Permission: { PermissionValue: 0x1_0000_0000 } }]),
		ledgerEntry([{ Permission: { PermissionValue: 'OfferCreate', Extra: true } }]),
		ledgerEntry([{ Permission: { PermissionValue: 'OfferCreate' }, Extra: true }]),
	])('rejects malformed ledger data: %j', (entry) => {
		expect(() => normalizeDelegatePermissions(entry)).toThrow(DelegationDataError);
	});

	it('rejects duplicate normalized permission values', () => {
		expect(() =>
			normalizeDelegatePermissions(
				ledgerEntry([
					{ Permission: { PermissionValue: 'OfferCreate' } },
					{ Permission: { PermissionValue: 'OfferCreate' } },
				]),
			),
		).toThrow(/duplicate permission/);
	});

	it('rejects an entry for the wrong owner or delegate', () => {
		expect(() => normalizeDelegatePermissions(ledgerEntry(), { owner: 'rSomeoneElse', delegate })).toThrow(
			/does not match/,
		);
		expect(() => normalizeDelegatePermissions(ledgerEntry(), { owner, delegate: 'rSomeoneElse' })).toThrow(
			/does not match/,
		);
	});
});

describe('exact v2 delegated signing', () => {
	const prepared = {
		TransactionType: 'OfferCancel',
		Account: owner,
		OfferSequence: 3,
		Fee: '12',
		Sequence: 7,
		LastLedgerSequence: 99,
	} as const;

	function signingHarness(options: {
		sequence?: number;
		fee?: Record<string, unknown>;
	} = {}) {
		const sign = vi.fn((_transaction: Transaction) => ({
			tx_blob: 'AB',
			hash: 'B'.repeat(64),
		}));
		const link = {
			id: 'link-v2',
			owner,
			network: 'testnet' as const,
			delegate,
			delegateSeedEnc: new Uint8Array([1]).buffer,
			iv: new Uint8Array([2]).buffer,
			permissions: ['OfferCancel'],
			status: 'active' as const,
		};
		const fee = options.fee ?? {
			drops: { open_ledger_fee: '12' },
			current_queue_size: '0',
			max_queue_size: '10',
		};
		const request = vi.fn(async (_network: string, command: string) =>
			command === 'account_info'
				? { account_data: { Account: owner, Sequence: options.sequence ?? 7 } }
				: fee,
		);
		return {
			ctx: {
				principal: 'v2-signing-tests',
				env: { HARBOR_KEK: 'test-only-kek' },
				store: { getLink: async () => link },
				xrplRpc: { request },
				signingServices: {
					withDelegateSigner: (async (_identity, _wrapped, _kek, run) =>
						run({ address: delegate, publicKey: 'public', sign })) as never,
				},
			},
			sign,
			request,
		};
	}

	it.each(['10', '12'])('accepts a canonical open-ledger fee of %s without replacing the immutable fee', async (openFee) => {
		const harness = signingHarness({
			fee: {
				drops: { open_ledger_fee: openFee },
				current_queue_size: '9',
				max_queue_size: '10',
			},
		});
		const callerTx = { ...prepared };

		await expect(signDelegatedTransaction(harness.ctx, {
			network: 'testnet',
			owner,
			txJson: callerTx,
			executionContract: 'xrpl_execution_v2',
		})).resolves.toEqual({ tx_blob: 'AB', hash: 'B'.repeat(64) });

		expect(harness.sign).toHaveBeenCalledWith({ ...prepared, Delegate: delegate });
		expect(callerTx).toEqual(prepared);
	});

	it('fails closed when the live open-ledger fee exceeds the immutable fee', async () => {
		const harness = signingHarness({
			fee: {
				drops: { open_ledger_fee: '13' },
				current_queue_size: '0',
				max_queue_size: '10',
			},
		});

		await expect(signDelegatedTransaction(harness.ctx, {
			network: 'testnet', owner, txJson: prepared, executionContract: 'xrpl_execution_v2',
		})).rejects.toMatchObject({ code: 'FEE_LOAD_UNSAFE' });
		expect(harness.sign).not.toHaveBeenCalled();
	});

	it('rejects the full queue boundary', async () => {
		const harness = signingHarness({
			fee: {
				drops: { open_ledger_fee: '12' },
				current_queue_size: '10',
				max_queue_size: '10',
			},
		});

		await expect(signDelegatedTransaction(harness.ctx, {
			network: 'testnet', owner, txJson: prepared, executionContract: 'xrpl_execution_v2',
		})).rejects.toMatchObject({ code: 'FEE_LOAD_UNSAFE' });
		expect(harness.sign).not.toHaveBeenCalled();
	});

	it.each([
		{},
		{ drops: { open_ledger_fee: '12' }, max_queue_size: '10' },
		{ drops: { open_ledger_fee: '12' }, current_queue_size: '0' },
		{ drops: { open_ledger_fee: '012' }, current_queue_size: '0', max_queue_size: '10' },
		{ drops: { open_ledger_fee: '12' }, current_queue_size: '-1', max_queue_size: '10' },
		{ drops: { open_ledger_fee: '12' }, current_queue_size: '0', max_queue_size: '0' },
	])('rejects malformed or missing fee/load evidence: %j', async (fee) => {
		const harness = signingHarness({ fee });

		await expect(signDelegatedTransaction(harness.ctx, {
			network: 'testnet', owner, txJson: prepared, executionContract: 'xrpl_execution_v2',
		})).rejects.toMatchObject({ code: 'XRPL_MALFORMED_RESPONSE' });
		expect(harness.sign).not.toHaveBeenCalled();
	});

	it('rejects a live owner Sequence that differs from the immutable transaction', async () => {
		const harness = signingHarness({ sequence: 8 });

		await expect(signDelegatedTransaction(harness.ctx, {
			network: 'testnet', owner, txJson: prepared, executionContract: 'xrpl_execution_v2',
		})).rejects.toMatchObject({ code: 'ACCOUNT_SEQUENCE_CHANGED' });
		expect(harness.sign).not.toHaveBeenCalled();
	});
});
