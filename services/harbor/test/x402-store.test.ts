import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
	X402Store,
	X402StoreDataError,
	type ClaimX402Input,
	type ReserveX402Input,
	type X402SettlementProof,
	type X402SigningAbandonedProof,
	type X402ValidatedFailureProof,
} from '../src/exec/x402-store';

const PRINCIPAL = 'x402-tests';
const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const DELEGATE = 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn';
const DELEGATE_B = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const PAY_TO = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59';
const NOW = '2026-10-19T10:00:00.000Z';
const LATER = '2026-10-19T10:01:00.000Z';
const HASH = 'A'.repeat(64);
const SOURCE_TAG = 2_610_240;
const SIGNING_ABANDONED: X402SigningAbandonedProof = {
	code: 'signing_abandoned',
	signed_blob_persisted: false,
	hash_persisted: false,
};
const MIGRATION = [
	'0001_init.sql',
	'0002_x402_payments.sql',
	'0003_x402_payers.sql',
	'0004_x402_sequence_safety.sql',
	'0005_x402_durable_lease.sql',
	'0006_x402_budget_accounting.sql',
].map((file) => readFileSync(new URL(`../migrations-local-x402/${file}`, import.meta.url), 'utf8')).join('\n');

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
		if (row === undefined) return null;
		return (column === undefined ? row : row[column]) as T;
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	constructor() { this.sqlite.exec(MIGRATION); }
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	close(): void { this.sqlite.close(); }
}

function asD1(db: SqliteD1): D1Database {
	return db as unknown as D1Database;
}

function claimInput(key: string, overrides: Partial<ClaimX402Input> = {}): ClaimX402Input {
	return {
		id: `payment-${key}`,
		idempotencyKey: key,
		requestFingerprint: '1'.repeat(64),
		owner: OWNER,
		network: 'testnet',
		delegate: DELEGATE,
		url: 'https://merchant.example/resource',
		createdAt: NOW,
		...overrides,
	};
}

function reserveInput(key: string, amountDrops: string, overrides: Partial<ReserveX402Input> = {}): ReserveX402Input {
	const invoiceId = overrides.invoiceId ?? `invoice-${key}`;
	const payTo = overrides.payTo ?? PAY_TO;
	const lastLedgerSeq = overrides.lastLedgerSeq ?? 500;
	return {
		idempotencyKey: key,
		requestFingerprint: '1'.repeat(64),
		leaseAcquiredAt: NOW,
		invoiceId,
		amountDrops,
		feeCapDrops: '12',
		callerMaxDrops: '1000',
		policyPerCallCapDrops: '1000',
		dailyCapDrops: '1000',
		payTo,
		requirements: { scheme: 'exact', asset: 'XRP' },
		transaction: {
			TransactionType: 'Payment',
			Account: DELEGATE,
			Destination: payTo,
			Amount: amountDrops,
			InvoiceID: createHash('sha256').update(invoiceId).digest('hex').toUpperCase(),
			SourceTag: SOURCE_TAG,
			DestinationTag: 7,
			Fee: '12',
			Sequence: 9,
			LastLedgerSequence: lastLedgerSeq,
			Flags: 0x8000_0000,
		},
		lastLedgerSeq,
		expiresAt: '2026-10-19T10:05:00.000Z',
		reservedAt: NOW,
		...overrides,
	};
}

function reserveForDelegate(
	key: string,
	amountDrops: string,
	delegate: string,
	overrides: Partial<ReserveX402Input> = {},
): ReserveX402Input {
	const base = reserveInput(key, amountDrops, overrides);
	return { ...base, transaction: { ...base.transaction, Account: delegate } };
}

function settlementProof(key: string, amountDrops: string, transactionOverrides: JsonObject = {}): X402SettlementProof {
	return {
		validated: true,
		hash: HASH,
		ledger_index: 499,
		engine_result: 'tesSUCCESS',
		transaction: {
			...reserveInput(key, amountDrops).transaction,
			SigningPubKey: '02AB',
			TxnSignature: 'ABCD',
			...transactionOverrides,
		},
	};
}

function validatedFailureProof(
	key: string,
	amountDrops: string,
	transactionOverrides: JsonObject = {},
): X402ValidatedFailureProof {
	return {
		validated: true,
		hash: HASH,
		ledger_index: 499,
		engine_result: 'tecPATH_DRY',
		transaction: {
			...reserveInput(key, amountDrops).transaction,
			SigningPubKey: '02AB',
			TxnSignature: 'ABCD',
			...transactionOverrides,
		},
	};
}

type JsonObject = Record<string, unknown>;

async function claimed(store: X402Store, key: string): Promise<void> {
	expect((await store.claim(claimInput(key))).outcome).toBe('claimed');
}

describe('X402Store', () => {
	it('backfills conservative amount-plus-fee reservations when upgrading 0002 data', () => {
		const sqlite = new DatabaseSync(':memory:');
		sqlite.exec(readFileSync(new URL('../migrations-local-x402/0001_init.sql', import.meta.url), 'utf8'));
		sqlite.exec(readFileSync(new URL('../migrations-local-x402/0002_x402_payments.sql', import.meta.url), 'utf8'));
		sqlite.prepare(`INSERT INTO x402_payments
			(id, principal, idempotency_key, request_fingerprint, owner, network, delegate, url, status,
			 amount_drops, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'testnet', ?, ?, 'prepared', 80, ?, ?)`)
			.run('legacy', PRINCIPAL, 'legacy-key', '1'.repeat(64), OWNER, DELEGATE,
				'https://merchant.example/resource', NOW, NOW);
		sqlite.prepare(`INSERT INTO x402_payments
			(id, principal, idempotency_key, request_fingerprint, owner, network, delegate, url, status,
			 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'testnet', ?, ?, 'claimed', ?, ?)`)
			.run('legacy-duplicate', PRINCIPAL, 'legacy-key-duplicate', '2'.repeat(64), OWNER, DELEGATE,
				'https://merchant.example/resource', NOW, NOW);
		sqlite.prepare(`INSERT INTO x402_payments
			(id, principal, idempotency_key, request_fingerprint, owner, network, delegate, url, status,
			 amount_drops, settled_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'testnet', ?, ?, 'settled', 80, ?, ?, ?)`).run(
			'legacy-settled', PRINCIPAL, 'legacy-settled-key', '3'.repeat(64), OWNER, DELEGATE_B,
			'https://merchant.example/resource', NOW, NOW, NOW,
		);
		sqlite.exec(readFileSync(new URL('../migrations-local-x402/0003_x402_payers.sql', import.meta.url), 'utf8'));
		sqlite.exec(readFileSync(new URL('../migrations-local-x402/0004_x402_sequence_safety.sql', import.meta.url), 'utf8'));
		sqlite.exec(readFileSync(new URL('../migrations-local-x402/0005_x402_durable_lease.sql', import.meta.url), 'utf8'));
		sqlite.exec(readFileSync(new URL('../migrations-local-x402/0006_x402_budget_accounting.sql', import.meta.url), 'utf8'));
		expect(sqlite.prepare(`SELECT fee_cap_drops, reserved_total_drops, signing_started_at,
			lease_acquired_at FROM x402_payments WHERE id = ?`).get('legacy')).toMatchObject({
			fee_cap_drops: 100,
			reserved_total_drops: 180,
			signing_started_at: NOW,
			lease_acquired_at: null,
		});
		expect(sqlite.prepare('SELECT reason FROM x402_payer_quarantine WHERE network = ? AND payer = ?')
			.get('testnet', DELEGATE)).toMatchObject({ reason: 'pre_lease_active_row' });
		expect(sqlite.prepare(`SELECT budget_consumed_drops, budget_consumed_at
			FROM x402_payments WHERE id = ?`).get('legacy-settled')).toMatchObject({
			budget_consumed_drops: 180,
			budget_consumed_at: NOW,
		});
		sqlite.close();
	});

	it('atomically claims by principal and detects replay and mismatched requests', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		const [first, second] = await Promise.all([
			store.claim(claimInput('same')),
			store.claim(claimInput('same')),
		]);
		expect([first.outcome, second.outcome].sort()).toEqual(['claimed', 'replay']);
		expect((await store.claim(claimInput('same', { requestFingerprint: '2'.repeat(64) }))).outcome).toBe('mismatch');
		expect(await new X402Store(asD1(db), 'another-principal').getByIdempotencyKey('same')).toBeNull();
		db.close();
	});

	it('durably leases one active payment to a payer across principals until terminal state', async () => {
		const db = new SqliteD1();
		const first = new X402Store(asD1(db), PRINCIPAL);
		const second = new X402Store(asD1(db), 'another-principal');
		expect((await first.claim(claimInput('lease-a'))).outcome).toBe('claimed');
		await expect(second.claim(claimInput('lease-b', { id: 'payment-lease-b' })))
			.rejects.toBeInstanceOf(X402StoreDataError);
		expect((await first.markFailed('lease-a', { code: 'before_signing' }, LATER)).outcome).toBe('transitioned');
		expect((await second.claim(claimInput('lease-b', { id: 'payment-lease-b' }))).outcome).toBe('claimed');
		db.close();
	});

	it('a replaying isolate cannot fail another isolate after its durable reserve CAS wins', async () => {
		const db = new SqliteD1();
		const first = new X402Store(asD1(db), PRINCIPAL);
		const second = new X402Store(asD1(db), PRINCIPAL);
		expect((await first.claim(claimInput('same-isolate-race'))).outcome).toBe('claimed');
		expect((await second.claim(claimInput('same-isolate-race'))).outcome).toBe('replay');
		expect((await first.reserve(reserveInput('same-isolate-race', '10'))).outcome).toBe('reserved');
		expect((await second.markClaimFailed(
			'same-isolate-race', { code: 'losing_isolate' }, LATER, NOW,
		)).outcome).toBe('invalid-state');
		expect((await first.getByIdempotencyKey('same-isolate-race'))).toMatchObject({
			status: 'prepared', failure: null,
		});
		db.close();
	});

	it('reclaims only a stale claimed lease and fences the previous owner with CAS tokens', async () => {
		const db = new SqliteD1();
		const first = new X402Store(asD1(db), PRINCIPAL);
		const recovery = new X402Store(asD1(db), PRINCIPAL);
		expect((await first.claim(claimInput('claim-recovery'))).outcome).toBe('claimed');
		expect((await recovery.acquireClaimRecovery(
			'claim-recovery', NOW, '2026-10-19T09:59:59.999Z', LATER,
		)).outcome).toBe('invalid-state');

		const contenders = await Promise.all([
			first.acquireClaimRecovery('claim-recovery', NOW, NOW, LATER),
			recovery.acquireClaimRecovery('claim-recovery', NOW, NOW, LATER),
		]);
		expect(contenders.map(({ outcome }) => outcome).sort()).toEqual([
			'invalid-state',
			'transitioned',
		]);
		expect((await first.reserve(reserveInput('claim-recovery', '10'))).outcome).toBe('invalid-state');
		expect((await first.markClaimFailed(
			'claim-recovery', { code: 'stale_owner' }, LATER, NOW,
		)).outcome).toBe('invalid-state');
		expect((await recovery.reserve(reserveInput('claim-recovery', '10', {
			leaseAcquiredAt: LATER,
		}))).outcome).toBe('reserved');
		expect((await recovery.getByIdempotencyKey('claim-recovery'))).toMatchObject({
			status: 'prepared', leaseAcquiredAt: LATER, failure: null,
		});
		db.close();
	});

	it('recovers an abandoned pre-persistence signing attempt after restart and releases its lease', async () => {
		const db = new SqliteD1();
		const firstProcess = new X402Store(asD1(db), PRINCIPAL);
		await claimed(firstProcess, 'abandoned-restart');
		await firstProcess.reserve(reserveInput('abandoned-restart', '10'));
		await firstProcess.markSigningStarted('abandoned-restart', LATER);

		const restarted = new X402Store(asD1(db), PRINCIPAL);
		expect((await restarted.markSigningAbandoned('abandoned-restart', {
			...SIGNING_ABANDONED, extra: true,
		} as X402SigningAbandonedProof, LATER)).outcome).toBe('invalid-evidence');
		expect((await restarted.getByIdempotencyKey('abandoned-restart'))?.status).toBe('prepared');
		const recovered = await restarted.markSigningAbandoned('abandoned-restart', SIGNING_ABANDONED, LATER);
		expect(recovered).toMatchObject({
			outcome: 'transitioned',
			row: {
				status: 'failed', hash: null, signedBlob: null,
				budgetConsumedDrops: '0', budgetConsumedAt: LATER,
			},
		});
		expect((await new X402Store(asD1(db), 'another-principal').claim(claimInput('lease-after-abandon', {
			id: 'payment-lease-after-abandon',
		}))).outcome).toBe('claimed');
		db.close();
	});

	it('uses a CAS so competing abandonment calls converge without double transition', async () => {
		const db = new SqliteD1();
		const first = new X402Store(asD1(db), PRINCIPAL);
		const second = new X402Store(asD1(db), PRINCIPAL);
		await claimed(first, 'abandoned-race');
		await first.reserve(reserveInput('abandoned-race', '10'));
		await first.markSigningStarted('abandoned-race', LATER);
		const results = await Promise.all([
			first.markSigningAbandoned('abandoned-race', SIGNING_ABANDONED, LATER),
			second.markSigningAbandoned('abandoned-race', SIGNING_ABANDONED, LATER),
		]);
		expect(results.map(({ outcome }) => outcome).sort()).toEqual(['replay', 'transitioned']);
		expect((await first.getByIdempotencyKey('abandoned-race'))).toMatchObject({
			status: 'failed', hash: null, signedBlob: null, budgetConsumedDrops: '0',
		});
		db.close();
	});

	it('cannot abandon after a competing isolate persists the signed blob and hash', async () => {
		const db = new SqliteD1();
		const signer = new X402Store(asD1(db), PRINCIPAL);
		const recovery = new X402Store(asD1(db), PRINCIPAL);
		await claimed(signer, 'abandoned-versus-signed');
		await signer.reserve(reserveInput('abandoned-versus-signed', '10'));
		await signer.markSigningStarted('abandoned-versus-signed', LATER);
		const [signed, abandoned] = await Promise.all([
			signer.markSigned('abandoned-versus-signed', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER }),
			recovery.markSigningAbandoned('abandoned-versus-signed', SIGNING_ABANDONED, LATER),
		]);
		expect(signed.outcome).toBe('transitioned');
		expect(abandoned.outcome).toBe('invalid-state');
		expect(await signer.getByIdempotencyKey('abandoned-versus-signed')).toMatchObject({
			status: 'signed', hash: HASH, signedBlob: 'ABCD', budgetConsumedDrops: null,
		});
		db.close();
	});

	it('allows only one permissive concurrent reservation under the daily cap', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await Promise.all([
			claimed(store, 'race-a'),
			store.claim(claimInput('race-b', { delegate: DELEGATE_B })).then((value) => expect(value.outcome).toBe('claimed')),
		]);
		const results = await Promise.all([
			store.reserve(reserveInput('race-a', '60', { dailyCapDrops: '100' })),
			store.reserve(reserveForDelegate('race-b', '60', DELEGATE_B, { dailyCapDrops: '100' })),
		]);
		expect(results.map((result) => result.outcome).sort()).toEqual(['daily-cap', 'reserved']);
		db.close();
	});

	it('atomically reserves amount plus fee cap and rejects fees above the hard cap', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'fee-total');
		const reserved = await store.reserve(reserveInput('fee-total', '80', {
			feeCapDrops: '20', dailyCapDrops: '100',
		}));
		expect(reserved.outcome).toBe('reserved');
		expect(reserved.row).toMatchObject({ feeCapDrops: '20', reservedTotalDrops: '100' });
		expect((await store.markFailed('fee-total', { code: 'test-complete' }, LATER)).outcome).toBe('transitioned');
		await claimed(store, 'fee-overflow');
		expect((await store.reserve(reserveInput('fee-overflow', '50', {
			feeCapDrops: '60', dailyCapDrops: '100',
		}))).outcome).toBe('daily-cap');
		expect((await store.markFailed('fee-overflow', { code: 'test-complete' }, LATER)).outcome).toBe('transitioned');
		await claimed(store, 'fee-transaction');
		await expect(store.reserve(reserveInput('fee-transaction', '1', {
			feeCapDrops: '11', dailyCapDrops: '1000',
		}))).rejects.toBeInstanceOf(X402StoreDataError);
		expect((await store.markFailed('fee-transaction', { code: 'test-complete' }, LATER)).outcome).toBe('transitioned');
		await claimed(store, 'fee-hard-cap');
		await expect(store.reserve(reserveInput('fee-hard-cap', '1', {
			feeCapDrops: '101', dailyCapDrops: '1000',
		}))).rejects.toBeInstanceOf(X402StoreDataError);
		db.close();
	});

	it('carries an outstanding pre-midnight reservation into the next UTC day across restart', async () => {
		const db = new SqliteD1();
		const beforeMidnight = '2026-10-19T23:59:59.000Z';
		const afterMidnight = '2026-10-20T00:00:01.000Z';
		const firstProcess = new X402Store(asD1(db), PRINCIPAL);
		await claimed(firstProcess, 'midnight-outstanding');
		expect((await firstProcess.reserve(reserveInput('midnight-outstanding', '88', {
			reservedAt: beforeMidnight,
			expiresAt: '2026-10-20T00:05:00.000Z',
			dailyCapDrops: '100',
		}))).outcome).toBe('reserved');

		const restarted = new X402Store(asD1(db), PRINCIPAL);
		expect((await restarted.claim(claimInput('midnight-next', {
			delegate: DELEGATE_B, createdAt: afterMidnight,
		}))).outcome).toBe('claimed');
		expect((await restarted.reserve(reserveForDelegate('midnight-next', '1', DELEGATE_B, {
			reservedAt: afterMidnight,
			expiresAt: '2026-10-20T00:05:00.000Z',
			dailyCapDrops: '100',
		}))).outcome).toBe('daily-cap');
		db.close();
	});

	it('moves a cross-midnight settlement to actual-day consumption without a restart gap', async () => {
		const db = new SqliteD1();
		const beforeMidnight = '2026-10-19T23:59:59.000Z';
		const afterMidnight = '2026-10-20T00:00:01.000Z';
		const firstProcess = new X402Store(asD1(db), PRINCIPAL);
		await claimed(firstProcess, 'midnight-settlement');
		await firstProcess.reserve(reserveInput('midnight-settlement', '80', {
			feeCapDrops: '20', reservedAt: beforeMidnight,
			expiresAt: '2026-10-20T00:05:00.000Z', dailyCapDrops: '100',
		}));
		await firstProcess.markSigningStarted('midnight-settlement', beforeMidnight);
		await firstProcess.markSigned('midnight-settlement', {
			hash: HASH, signedBlob: 'ABCD', signedAt: beforeMidnight,
		});
		await firstProcess.markSettlementUnknown('midnight-settlement', afterMidnight);
		const settled = await firstProcess.markSettled(
			'midnight-settlement', settlementProof('midnight-settlement', '80'), afterMidnight,
		);
		expect(settled).toMatchObject({
			outcome: 'transitioned',
			row: { budgetConsumedDrops: '92', budgetConsumedAt: afterMidnight },
		});

		const restarted = new X402Store(asD1(db), PRINCIPAL);
		expect((await restarted.claim(claimInput('after-midnight', {
			delegate: DELEGATE_B, createdAt: afterMidnight,
		}))).outcome).toBe('claimed');
		expect((await restarted.reserve(reserveForDelegate('after-midnight', '1', DELEGATE_B, {
			reservedAt: afterMidnight,
			expiresAt: '2026-10-20T00:05:00.000Z', dailyCapDrops: '100',
		}))).outcome).toBe('daily-cap');
		db.close();
	});

	it('charges only the validated transaction fee for a tec failure', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'validated-tec');
		await store.reserve(reserveInput('validated-tec', '80', { feeCapDrops: '20', dailyCapDrops: '100' }));
		await store.markSigningStarted('validated-tec', LATER);
		await store.markSigned('validated-tec', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER });
		await store.markSettlementUnknown('validated-tec', LATER);
		expect((await store.markValidatedFailure('validated-tec', {
			...validatedFailureProof('validated-tec', '80'), engine_result: 'terQUEUED',
		}, LATER)).outcome).toBe('invalid-evidence');
		expect((await store.markValidatedFailure('validated-tec', {
			...validatedFailureProof('validated-tec', '80'), extra: true,
		} as X402ValidatedFailureProof, LATER)).outcome).toBe('invalid-evidence');
		expect((await store.markValidatedFailure(
			'validated-tec', validatedFailureProof('validated-tec', '80', { Fee: '13' }), LATER,
		)).outcome).toBe('invalid-evidence');
		expect((await store.getByIdempotencyKey('validated-tec'))?.status).toBe('settlement_unknown');
		const failed = await store.markValidatedFailure(
			'validated-tec', validatedFailureProof('validated-tec', '80'), LATER,
		);
		expect(failed).toMatchObject({
			outcome: 'transitioned',
			row: { status: 'failed', budgetConsumedDrops: '12', budgetConsumedAt: LATER },
		});
		expect((await store.markValidatedFailure(
			'validated-tec', validatedFailureProof('validated-tec', '80'), '2026-10-19T10:02:00.000Z',
		)).outcome).toBe('replay');
		expect((await store.claim(claimInput('after-tec', { delegate: DELEGATE_B }))).outcome).toBe('claimed');
		expect((await store.reserve(reserveForDelegate('after-tec', '70', DELEGATE_B, {
			dailyCapDrops: '100',
		}))).outcome).toBe('reserved');
		db.close();
	});

	it('enforces caller and policy limits before reserving and replays exact reservations', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'limits');
		expect((await store.reserve(reserveInput('limits', '11', { callerMaxDrops: '10' }))).outcome).toBe('caller-max');
		expect((await store.reserve(reserveInput('limits', '11', { policyPerCallCapDrops: '10' }))).outcome).toBe('policy-per-call-cap');
		const request = reserveInput('limits', '11');
		expect((await store.reserve(request)).outcome).toBe('reserved');
		expect((await store.reserve(request)).outcome).toBe('replay');
		expect((await store.reserve({ ...request, requestFingerprint: '2'.repeat(64) })).outcome).toBe('mismatch');
		db.close();
	});

	it('atomically honors a stricter policy written after the caller resolved its caps', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'policy-race');
		db.sqlite.prepare('INSERT INTO policies (principal, owner, network, json, updated_at) VALUES (?, ?, ?, ?, ?)')
			.run(PRINCIPAL, OWNER, 'testnet', JSON.stringify({
				x402_max_per_call_drops: '4', x402_daily_cap_drops: '1000',
			}), NOW);
		expect((await store.reserve(reserveInput('policy-race', '5'))).outcome).toBe('invalid-state');
		expect((await store.getByIdempotencyKey('policy-race'))?.status).toBe('claimed');
		db.sqlite.prepare('UPDATE policies SET json = ? WHERE principal = ? AND owner = ? AND network = ?')
			.run(JSON.stringify({ x402_max_per_call_drops: '1000', x402_daily_cap_drops: '10' }),
				PRINCIPAL, OWNER, 'testnet');
		expect((await store.reserve(reserveInput('policy-race', '5'))).outcome).toBe('invalid-state');
		expect((await store.getByIdempotencyKey('policy-race'))?.status).toBe('claimed');
		db.close();
	});

	it('keeps invoice ids unique per principal and network', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'invoice-a');
		expect((await store.claim(claimInput('invoice-b', { delegate: DELEGATE_B }))).outcome).toBe('claimed');
		expect((await store.reserve(reserveInput('invoice-a', '5', { invoiceId: 'shared' }))).outcome).toBe('reserved');
		expect((await store.reserve(reserveForDelegate('invoice-b', '5', DELEGATE_B, { invoiceId: 'shared' }))).outcome).toBe('invoice-conflict');
		db.close();
	});

	it('releases reserved capacity only when a payment reaches failed', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'cap-a');
		expect((await store.claim(claimInput('cap-b', { delegate: DELEGATE_B }))).outcome).toBe('claimed');
		expect((await store.reserve(reserveInput('cap-a', '80', { dailyCapDrops: '100' }))).outcome).toBe('reserved');
		expect((await store.reserve(reserveForDelegate('cap-b', '30', DELEGATE_B, { dailyCapDrops: '100' }))).outcome).toBe('daily-cap');
		expect((await store.markFailed('cap-a', { code: 'pre_submit_failure' }, LATER)).outcome).toBe('transitioned');
		expect((await store.reserve(reserveForDelegate('cap-b', '30', DELEGATE_B, { dailyCapDrops: '100' }))).outcome).toBe('reserved');
		db.close();
	});

	it('cannot fabricate settled or delivered states and supports recovery by hash', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'lifecycle');
		await store.reserve(reserveInput('lifecycle', '10'));
		expect((await store.markSettled('lifecycle', settlementProof('lifecycle', '10'), LATER)).outcome).toBe('invalid-state');
		expect((await store.markDelivered('lifecycle', { http_status: 200 }, LATER)).outcome).toBe('invalid-evidence');
		expect((await store.markSigningStarted('lifecycle', LATER)).outcome).toBe('transitioned');
		expect((await store.markSigned('lifecycle', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER })).outcome).toBe('transitioned');
		expect((await store.markSettlementUnknown('lifecycle', LATER)).outcome).toBe('transitioned');
		expect((await store.markSettled('lifecycle', {
			...settlementProof('lifecycle', '10'), hash: 'B'.repeat(64),
		}, LATER)).outcome).toBe('invalid-evidence');
		expect((await store.markSettled('lifecycle', settlementProof('lifecycle', '10'), LATER)).outcome).toBe('transitioned');
		expect((await store.markDelivered('lifecycle', {
			http_status: 200, content_type: 'application/json', body: { comparison: ['dex', 'amm'] },
		}, LATER)).outcome).toBe('transitioned');
		expect((await store.findByHash(HASH))?.status).toBe('delivered');
		expect((await store.getByIdempotencyKey('lifecycle'))?.status).toBe('delivered');
		db.close();
	});

	it('drops malformed optional delivery evidence while preserving settlement recovery', async () => {
		const oversized = { value: 'x'.repeat(64 * 1024) };
		const invalidDeliveries = [
			{ http_status: 201, content_type: 'application/json', body: {} },
			{ http_status: 200, content_type: 'application/problem+json', body: {} },
			{ http_status: 200, content_type: 'application/json' },
			{ http_status: 200, content_type: 'application/json', body: [] },
			{ http_status: 200, content_type: 'application/json', body: oversized },
			{ http_status: 200, content_type: 'application/json', body: {}, extra: true },
		];

		for (const [index, delivery] of invalidDeliveries.entries()) {
			const db = new SqliteD1();
			const store = new X402Store(asD1(db), PRINCIPAL);
			const key = `invalid-delivery-${index}`;
			await claimed(store, key);
			await store.reserve(reserveInput(key, '10'));
			await store.markSigningStarted(key, LATER);
			await store.markSigned(key, { hash: HASH, signedBlob: 'ABCD', signedAt: LATER });
			expect((await store.markSettlementUnknown(key, LATER, delivery as never)).outcome).toBe('transitioned');
			expect(await store.getByIdempotencyKey(key)).toMatchObject({
				status: 'settlement_unknown', delivery: null,
			});
			await store.markSettled(key, settlementProof(key, '10'), LATER);
			expect((await store.markDelivered(key, delivery as never, LATER)).outcome).toBe('invalid-evidence');
			expect((await store.getByIdempotencyKey(key))?.status).toBe('settled');
			db.close();
		}
	});

	it('persists a bounded merchant delivery atomically with settlement uncertainty', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'pending-delivery');
		await store.reserve(reserveInput('pending-delivery', '10'));
		await store.markSigningStarted('pending-delivery', LATER);
		await store.markSigned('pending-delivery', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER });
		const pending = {
			http_status: 200 as const,
			content_type: 'application/json' as const,
			body: { note: 'private market', secretary: 'available' },
		};
		const uncertain = await store.markSettlementUnknown('pending-delivery', LATER, pending);
		expect(uncertain).toMatchObject({ outcome: 'transitioned', row: { status: 'settlement_unknown', delivery: pending } });
		expect((await store.markSettlementUnknown('pending-delivery', LATER, pending)).outcome).toBe('replay');
		expect((await store.markSettlementUnknown('pending-delivery', LATER, {
			...pending, body: { comparison: ['different'] },
		})).outcome).toBe('mismatch');
		db.close();
	});

	it('does not settle or mutate for ledger Payment mismatches and dangerous controls', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'ledger-match');
		await store.reserve(reserveInput('ledger-match', '10'));
		await store.markSigningStarted('ledger-match', LATER);
		await store.markSigned('ledger-match', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER });
		await store.markSettlementUnknown('ledger-match', LATER);
		const mismatches: JsonObject[] = [
			{ TransactionType: 'OfferCreate' },
			{ Account: OWNER },
			{ Destination: OWNER },
			{ Amount: '11' },
			{ InvoiceID: 'B'.repeat(64) },
			{ SourceTag: SOURCE_TAG + 1 },
			{ DestinationTag: 8 },
			{ Fee: '0' },
			{ Fee: '101' },
			{ Delegate: OWNER },
			{ SendMax: '10' },
			{ Paths: [] },
			{ DeliverMin: '1' },
			{ Flags: 0x8002_0000 },
		];
		for (const mismatch of mismatches) {
			expect((await store.markSettled('ledger-match', settlementProof('ledger-match', '10', mismatch), LATER)).outcome)
				.toBe('invalid-evidence');
			const unchanged = await store.getByIdempotencyKey('ledger-match');
			expect(unchanged?.status).toBe('settlement_unknown');
			expect(unchanged?.settlement).toBeNull();
		}
		db.close();
	});

	it('rejects unsafe reserved Payment shapes before consuming budget', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'unsafe-payment');
		const base = reserveInput('unsafe-payment', '10');
		const unsafeTransactions: JsonObject[] = [
			{ ...base.transaction, Account: OWNER },
			{ ...base.transaction, Destination: OWNER },
			{ ...base.transaction, Amount: '11' },
			{ ...base.transaction, InvoiceID: 'B'.repeat(64) },
			{ ...base.transaction, SourceTag: undefined },
			{ ...base.transaction, Delegate: OWNER },
			{ ...base.transaction, SendMax: '10' },
			{ ...base.transaction, Paths: [] },
			{ ...base.transaction, DeliverMin: '1' },
			{ ...base.transaction, Flags: 0x8002_0000 },
		];
		for (const transaction of unsafeTransactions) {
			await expect(store.reserve({ ...base, transaction })).rejects.toBeInstanceOf(X402StoreDataError);
			expect((await store.getByIdempotencyKey('unsafe-payment'))?.status).toBe('claimed');
		}
		db.close();
	});

	it('requires ledger-expiry evidence before releasing a signed reservation', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'ambiguous');
		await store.reserve(reserveInput('ambiguous', '10'));
		await store.markSigningStarted('ambiguous', LATER);
		await store.markSigned('ambiguous', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER });
		expect((await store.markFailed('ambiguous', { code: 'unknown' }, LATER)).outcome).toBe('invalid-state');
		expect((await store.markExpiredAbsentFailed('ambiguous', {
			code: 'expired_absent', validated: true, transaction_found: false,
			validated_ledger_index: 501, inclusion_ledgers_checked: [500], hash: 'B'.repeat(64),
		}, LATER)).outcome).toBe('invalid-evidence');
		expect((await store.markExpiredAbsentFailed('ambiguous', {
			code: 'expired_absent', validated: true, transaction_found: false,
			validated_ledger_index: 500, inclusion_ledgers_checked: [500], hash: HASH,
		}, LATER)).outcome).toBe('invalid-evidence');
		expect((await store.markExpiredAbsentFailed('ambiguous', {
			code: 'expired_absent', validated: true, transaction_found: false,
			validated_ledger_index: 501, inclusion_ledgers_checked: [500], hash: HASH,
		}, LATER)).outcome).toBe('transitioned');
		expect(await store.getByIdempotencyKey('ambiguous')).toMatchObject({
			failure: {
				code: 'expired_absent', validated: true, transaction_found: false,
				validated_ledger_index: 501, inclusion_ledgers_checked: [500], hash: HASH,
			},
			budgetConsumedDrops: '0', budgetConsumedAt: LATER,
		});
		db.close();
	});

	it('never releases or reopens a reservation after signing has started ambiguously', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'signing-ambiguous');
		await store.reserve(reserveInput('signing-ambiguous', '10'));
		expect((await store.markSigningStarted('signing-ambiguous', LATER)).outcome).toBe('transitioned');
		expect((await store.markSigningStarted('signing-ambiguous', LATER)).outcome).toBe('replay');
		expect((await store.markFailed('signing-ambiguous', { code: 'ambiguous' }, LATER)).outcome).toBe('invalid-state');
		expect((await store.getByIdempotencyKey('signing-ambiguous'))).toMatchObject({
			status: 'prepared', signingStartedAt: LATER,
		});
		db.close();
	});

	it('rejects incomplete absence evidence without releasing capacity', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'missing-proof');
		await store.reserve(reserveInput('missing-proof', '10'));
		await store.markSigningStarted('missing-proof', LATER);
		await store.markSigned('missing-proof', { hash: HASH, signedBlob: 'ABCD', signedAt: LATER });
		const incomplete = { code: 'expired_absent', validated: true, validated_ledger_index: 501, hash: HASH };
		expect((await store.markExpiredAbsentFailed(
			'missing-proof', incomplete as never, LATER,
		)).outcome).toBe('invalid-evidence');
		expect((await store.getByIdempotencyKey('missing-proof'))?.status).toBe('signed');
		expect((await store.claim(claimInput('still-charged', { delegate: DELEGATE_B }))).outcome).toBe('claimed');
		expect((await store.reserve(reserveForDelegate('still-charged', '1', DELEGATE_B, { dailyCapDrops: '10' }))).outcome).toBe('daily-cap');
		db.close();
	});

	it('rejects unsafe integers and sensitive or non-JSON persistence', async () => {
		const db = new SqliteD1();
		const store = new X402Store(asD1(db), PRINCIPAL);
		await claimed(store, 'validation');
		await expect(store.reserve(reserveInput('validation', '9007199254740992'))).rejects.toBeInstanceOf(X402StoreDataError);
		await expect(store.reserve(reserveInput('validation', '1', {
			requirements: { private_key: 'not-allowed' },
		}))).rejects.toBeInstanceOf(X402StoreDataError);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(store.reserve(reserveInput('validation', '1', { transaction: cyclic }))).rejects.toBeInstanceOf(X402StoreDataError);
		db.close();
	});
});
