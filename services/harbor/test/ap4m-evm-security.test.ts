import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import { createAp4mEvmEventAdapter } from '../src/ap4m-evm/adapter';
import { AP4M_EVM_EVENT_PROFILE, validateAp4mEvmEventProfile } from '../src/ap4m-evm/event-config';
import { validateChannelRoles, validatePreparedVoucherRedemption } from '../src/ap4m-evm/prepare-validation';
import { validateFinalizedReceipt } from '../src/ap4m-evm/receipt-validation';
import {
	D1Ap4mEvmStore,
	type ReserveAp4mEvmVoucherInput,
} from '../src/ap4m-evm/store';
import {
	AP4M_TYPED_DATA_DOMAIN,
	AP4M_VOUCHER_TYPES,
	rejectUnsupportedCloseChannelPurpose,
	validateVoucherTypedData,
} from '../src/ap4m-evm/typed-data-validation';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	private values: SqlValue[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]): this {
		this.values = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue);
		return this;
	}
	async run(): Promise<D1Result> {
		const result = this.statement.run(...this.values);
		return { success: true, meta: { changes: Number(result.changes) } as D1Result['meta'] };
	}
	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
		return row === undefined ? null : (column === undefined ? row : row[column]) as T;
	}
	async all<T>(): Promise<D1Result<T>> {
		return { success: true, results: this.statement.all(...this.values) as T[] };
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	constructor() {
		this.sqlite.exec('PRAGMA foreign_keys = ON');
		const migration = fileURLToPath(new URL('../migrations/0016_ap4m_evm_event.sql', import.meta.url));
		this.sqlite.exec(readFileSync(migration, 'utf8'));
	}
	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.sqlite.prepare(sql));
	}
	close(): void { this.sqlite.close(); }
}

const CHANNEL = `0x${'ab'.repeat(32)}` as Hex;
const TX_HASH = `0x${'11'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'22'.repeat(32)}` as Hex;
const CLAIM_ID = `0x${'33'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'44'.repeat(65)}` as Hex;
const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const FUNDING = '0x2222222222222222222222222222222222222222' as Address;
const PAYOUT = '0x3333333333333333333333333333333333333333' as Address;
const NOW = '2026-10-25T00:00:00.000Z';

function voucher(cumulativeAmount = '20'): Record<string, unknown> {
	return {
		domain: { ...AP4M_TYPED_DATA_DOMAIN },
		primaryType: 'Voucher',
		types: AP4M_VOUCHER_TYPES,
		message: { channelId: CHANNEL, cumulativeAmount },
	};
}

function prepared(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		chainId: AP4M_EVM_EVENT_PROFILE.chainId,
		from: AGENT,
		to: AP4M_EVM_EVENT_PROFILE.paymentLedger,
		data: '0x12345678',
		value: '0',
		gasLimit: '250000',
		feeModel: 'legacy',
		gasPrice: '1000000000',
		...overrides,
	};
}

const preparedExpectation = {
	from: AGENT,
	maxGasLimit: 300_000n,
	maxGasPrice: 10_000_000_000n,
	channelId: CHANNEL,
	cumulativeAmount: '20',
	signature: SIGNATURE,
} as const;

function channel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		channelId: CHANNEL,
		agent: AGENT,
		fundingWallet: FUNDING,
		merchantPayout: PAYOUT,
		token: AP4M_EVM_EVENT_PROFILE.rlusdToken,
		cap: '100',
		cumulativeAmount: '20',
		generation: 1,
		status: 'open',
		...overrides,
	};
}

function reservation(overrides: Partial<ReserveAp4mEvmVoucherInput> = {}): ReserveAp4mEvmVoucherInput {
	return {
		principal: 'security-principal',
		channelId: CHANNEL,
		merchantId: 'merchant-1',
		agentWallet: AGENT,
		fundingWallet: FUNDING,
		payoutWallet: PAYOUT,
		tokenAddress: AP4M_EVM_EVENT_PROFILE.rlusdToken,
		generation: 1,
		capBaseUnits: '100',
		nextCumulative: '20',
		idempotencyKey: 'security-voucher-1',
		requestFingerprint: 'a'.repeat(64),
		attemptToken: 'b'.repeat(64),
		at: NOW,
		...overrides,
	};
}

function receipt(logs: unknown[] = []): Record<string, unknown> {
	return {
		transactionHash: TX_HASH,
		blockHash: BLOCK_HASH,
		blockNumber: 100,
		status: 'success',
		logs,
	};
}

const receiptExpectation = {
	transactionHash: TX_HASH,
	blockHash: BLOCK_HASH,
	channelId: CHANNEL,
	claimId: CLAIM_ID,
	evidence0: `0x${'40'.repeat(32)}` as Hex,
	evidence1: `0x${'41'.repeat(32)}` as Hex,
	evidence2: `0x${'42'.repeat(32)}` as Hex,
	evidence3: '7',
	agent: AGENT,
	fundingWallet: FUNDING,
	merchantPayout: PAYOUT,
	token: AP4M_EVM_EVENT_PROFILE.rlusdToken,
	cumulativeAmount: '20',
	incrementalAmount: '5',
	minimumConfirmations: 3,
	latestBlockNumber: 102,
} as const;

describe('AP4M EVM adversarial boundaries', () => {
	it('rejects untrusted profiles instead of allowing remote target selection', () => {
		for (const patch of [
			{ chainId: 1 },
			{ rpcUrl: 'https://rpc.attacker.invalid' },
			{ explorerUrl: 'https://explorer.attacker.invalid' },
			{ paymentLedger: PAYOUT },
			{ pooledEscrowVault: PAYOUT },
			{ rlusdToken: PAYOUT },
			{ rlusdDecimals: 6 },
			{ attackerField: 'accepted' },
		]) {
			expect(() => validateAp4mEvmEventProfile({ ...AP4M_EVM_EVENT_PROFILE, ...patch }))
				.toThrowError(expect.objectContaining({ code: 'INVALID_PROFILE' }));
		}
	});

	it('rejects target, selector, calldata, native-value and gas tampering', () => {
		for (const transaction of [
			prepared(),
			prepared({ to: PAYOUT }),
			prepared({ from: FUNDING }),
			prepared({ chainId: 1 }),
			prepared({ data: '0xdeadbeef' }),
			prepared({ data: '0x' }),
			prepared({ value: '1' }),
			prepared({ gasLimit: '0' }),
			prepared({ gasLimit: '300001' }),
			prepared({ feeModel: 'eip1559' }),
			prepared({ gasPrice: '10000000001' }),
			prepared({ maxFeePerGas: '1' }),
		]) {
			expect(() => validatePreparedVoucherRedemption(transaction, preparedExpectation))
				.toThrowError(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }));
		}
	});

	it('rejects typed-data domain, purpose, field and value substitution', async () => {
		const attempts = [
			{ ...voucher(), purpose: 'close-channel' },
			{ ...voucher(), primaryType: 'CloseChannel' },
			{ ...voucher(), domain: { ...AP4M_TYPED_DATA_DOMAIN, chainId: 1 } },
			{ ...voucher(), domain: { ...AP4M_TYPED_DATA_DOMAIN, verifyingContract: PAYOUT } },
			{ ...voucher(), types: { Voucher: [{ name: 'cumulativeAmount', type: 'uint256' }] } },
			{ ...voucher(), message: { channelId: TX_HASH, cumulativeAmount: '20' } },
			{ ...voucher(), message: { channelId: CHANNEL, cumulativeAmount: '020' } },
			{ ...voucher(), message: { channelId: CHANNEL, cumulativeAmount: '20', payout: PAYOUT } },
		];
		for (const envelope of attempts) {
			await expect(validateVoucherTypedData({
				envelope,
				expectedChannelId: CHANNEL,
				previousCumulativeAmount: '10',
				channelCap: '100',
			})).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
		}
	});

	it('verifies locally generated signatures and rejects the wrong signer', async () => {
		const signer = privateKeyToAccount(`0x${'01'.repeat(32)}`);
		const other = privateKeyToAccount(`0x${'02'.repeat(32)}`);
		const signature = await signer.signTypedData({
			domain: AP4M_TYPED_DATA_DOMAIN,
			types: AP4M_VOUCHER_TYPES,
			primaryType: 'Voucher',
			message: { channelId: CHANNEL, cumulativeAmount: 20n },
		});
		await expect(validateVoucherTypedData({
			envelope: voucher(),
			expectedChannelId: CHANNEL,
			previousCumulativeAmount: '10',
			channelCap: '100',
			expectedSigner: other.address,
			signature,
		})).rejects.toMatchObject({ code: 'INVALID_TYPED_DATA' });
		expect(await validateVoucherTypedData({
			envelope: voucher(),
			expectedChannelId: CHANNEL,
			previousCumulativeAmount: '10',
			channelCap: '100',
			expectedSigner: signer.address,
			signature,
		})).toMatchObject({ signer: signer.address, cumulativeAmount: 20n });
	});

	it('enforces role separation, monotonic totals and the channel cap', async () => {
		for (const merchantPayout of [AGENT, FUNDING]) {
			expect(() => validateChannelRoles(channel({ merchantPayout })))
				.toThrowError(expect.objectContaining({ code: 'ROLE_COLLISION' }));
		}
		expect(() => validateChannelRoles(channel({ cumulativeAmount: '101' })))
			.toThrowError(expect.objectContaining({ code: 'VOUCHER_OVER_CAP' }));
		await expect(validateVoucherTypedData({
			envelope: voucher('20'), expectedChannelId: CHANNEL,
			previousCumulativeAmount: '20', channelCap: '100',
		})).rejects.toMatchObject({ code: 'VOUCHER_REPLAY' });
		await expect(validateVoucherTypedData({
			envelope: voucher('101'), expectedChannelId: CHANNEL,
			previousCumulativeAmount: '20', channelCap: '100',
		})).rejects.toMatchObject({ code: 'VOUCHER_OVER_CAP' });
	});

	it('keeps idempotency ownership durable and rejects altered replays', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, 'security-principal');
			expect((await store.reserve(reservation())).outcome).toBe('reserved');
			expect((await store.reserve(reservation())).outcome).toBe('owner');
			expect((await store.reserve(reservation({ nextCumulative: '21' }))).outcome).toBe('mismatch');
			expect(db.sqlite.prepare(
				`SELECT count(*) AS count FROM ap4m_evm_journal WHERE event = 'reserved'`,
			).get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it('rejects absent, removed, partial, duplicate-looking and unbounded receipt evidence', () => {
		const partialLog = {
			address: AP4M_EVM_EVENT_PROFILE.paymentLedger,
			topics: [`0x${'aa'.repeat(32)}`],
			data: '0x01',
			logIndex: 0,
			removed: false,
		};
		for (const evidence of [
			receipt(),
			receipt([{ ...partialLog, removed: true }]),
			receipt([partialLog]),
			receipt([partialLog, { ...partialLog, logIndex: 1 }]),
			receipt([{ ...partialLog, address: PAYOUT }]),
		]) {
			expect(() => validateFinalizedReceipt(evidence, receiptExpectation))
				.toThrowError(expect.objectContaining({ code: 'RECEIPT_MISMATCH' }));
		}
		expect(() => validateFinalizedReceipt(
			{ ...receipt(), unexpectedSettlement: TX_HASH }, receiptExpectation,
		)).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }));
		expect(() => validateFinalizedReceipt(
			receipt(), { ...receiptExpectation, latestBlockNumber: 101 },
		)).toThrowError(expect.objectContaining({ code: 'RECEIPT_PENDING' }));
	});

	it('exposes neither live effects nor close-channel compatibility by default', () => {
		const store = {
			reserve: async () => { throw new Error('unused'); },
			markSubmissionUnknown: async () => { throw new Error('unused'); },
			confirm: async () => { throw new Error('unused'); },
			markAbsent: async () => { throw new Error('unused'); },
			getChannel: async () => null,
			getAttempt: async () => null,
			getAttemptByHash: async () => null,
		};
		expect(createAp4mEvmEventAdapter({}, store)).toBeNull();
		expect(() => rejectUnsupportedCloseChannelPurpose({
			domain: AP4M_TYPED_DATA_DOMAIN,
			primaryType: 'CloseChannel',
			message: { channelId: CHANNEL },
		})).toThrowError(expect.objectContaining({ code: 'INVALID_TYPED_DATA' }));
	});
});
