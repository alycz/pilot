import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { hashes, Wallet, type Transaction } from 'xrpl';
import { describe, expect, it, vi } from 'vitest';

import { D1WorkAgreementStore, WorkAgreementStoreDataError } from '../src/exec/work-agreement-d1';
import {
	WorkAgreementRuntime,
	type WorkAgreementApproval,
	type WorkAgreementEffects,
	type WorkAgreementRecord,
	type WorkAgreementTerms,
} from '../src/exec/work-agreement-runtime';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	#values: SqlValue[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]): this {
		this.#values = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue); return this;
	}
	async run(): Promise<D1Result> {
		const result = this.statement.run(...this.#values); return { success: true, meta: { changes: Number(result.changes) } as D1Result['meta'] };
	}
	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.#values) as Record<string, unknown> | undefined;
		if (row === undefined) return null; return (column === undefined ? row : row[column]) as T;
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	async exec(sql: string): Promise<D1ExecResult> { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
	close(): void { this.sqlite.close(); }
}

function asD1(db: SqliteD1): D1Database { return db as unknown as D1Database; }

const PRINCIPAL = 'd1-owner-session';
const NOW = new Date('2026-10-24T10:00:00.000Z');
const owner = Wallet.generate();
const counterparty = Wallet.generate();

function terms(agreementId: string): WorkAgreementTerms {
	return { agreementId, owner: owner.classicAddress, counterparty: counterparty.classicAddress,
		network: 'testnet', amountDrops: '2000', finishAfter: 800_000_000, cancelAfter: 800_000_100 };
}

function approval(suffix: string): WorkAgreementApproval {
	return {
		action: 'create', approvalId: `approval-${suffix}`, expiresAt: '2026-10-24T10:05:00.000Z',
		execution: { build_id: `build-${suffix}`, idempotency_key: `idem-${suffix}`, require_owner_approval: true },
		validatedLedgerIndex: 100, validatedAccountSequence: 5, maxFeeDrops: '20',
		txJson: { TransactionType: 'EscrowCreate', Account: owner.classicAddress, Destination: counterparty.classicAddress,
			Amount: '2000', FinishAfter: 800_000_000, CancelAfter: 800_000_100, Fee: '12', Sequence: 5, LastLedgerSequence: 120 },
	};
}

function effects(overrides: Partial<WorkAgreementEffects> = {}): WorkAgreementEffects {
	return {
		async dispatch() {},
		async lookup(input) { return { status: 'pending', hash: input.hash }; },
		...overrides,
	};
}

function runtime(store: D1WorkAgreementStore, injected = effects()): WorkAgreementRuntime {
	return new WorkAgreementRuntime({ store, effects: injected, enabled: true, now: () => new Date(NOW) });
}

describe('D1WorkAgreementStore', () => {
	it('persists immutable CAS revisions and replay tombstones across store restarts', async () => {
		const db = new SqliteD1(); const first = new D1WorkAgreementStore(asD1(db)); const app = runtime(first);
		await app.prepare({ principal: PRINCIPAL, terms: terms('agreement-a'), approval: approval('shared') });
		await app.reject({ principal: PRINCIPAL, agreementId: 'agreement-a', owner: owner.classicAddress,
			network: 'testnet', approvalId: 'approval-shared', idempotencyKey: 'idem-shared' });
		const restarted = new D1WorkAgreementStore(asD1(db));
		expect(await restarted.get(PRINCIPAL, 'agreement-a')).toMatchObject({ status: 'rejected', revision: 1,
			history: { approvalIds: ['approval-shared'], idempotencyKeys: ['idem-shared'] } });
		await expect(runtime(restarted).prepare({ principal: PRINCIPAL, terms: terms('agreement-b'), approval: approval('shared') }))
			.rejects.toMatchObject({ code: 'REPLAY_DETECTED' });
		expect(await restarted.get(PRINCIPAL, 'agreement-b')).toBeNull();
		db.close();
	});

	it('allows only one CAS winner and therefore dispatches a double click once', async () => {
		const db = new SqliteD1(); const storeA = new D1WorkAgreementStore(asD1(db)); const storeB = new D1WorkAgreementStore(asD1(db));
		const dispatch = vi.fn(async () => undefined); const injected = effects({ dispatch });
		const first = runtime(storeA, injected); const second = runtime(storeB, injected);
		const prepared = approval('once'); await first.prepare({ principal: PRINCIPAL, terms: terms('agreement-once'), approval: prepared });
		const blob = owner.sign(prepared.txJson as Transaction).tx_blob;
		const input = { principal: PRINCIPAL, agreementId: 'agreement-once', owner: owner.classicAddress, network: 'testnet' as const,
			approvalId: 'approval-once', idempotencyKey: 'idem-once', attemptId: 'attempt-once', signedBlob: blob };
		const result = await Promise.all([first.submit(input), second.submit(input)]);
		expect(result.map((item) => item.outcome).sort()).toEqual(['replay', 'submitted']);
		expect(dispatch).toHaveBeenCalledTimes(1);
		const rows = db.sqlite.prepare('SELECT record_json FROM local_work_agreement_events').all() as Array<{ record_json: string }>;
		expect(rows.every((row) => !row.record_json.includes(blob))).toBe(true);
		db.close();
	});

	it('recovers a persisted pre-dispatch claim read-only after restart', async () => {
		const db = new SqliteD1(); const store = new D1WorkAgreementStore(asD1(db)); const app = runtime(store);
		const prepared = approval('restart'); await app.prepare({ principal: PRINCIPAL, terms: terms('agreement-restart'), approval: prepared });
		const blob = owner.sign(prepared.txJson as Transaction).tx_blob; const hash = hashes.hashSignedTx(blob).toUpperCase();
		const current = (await store.get(PRINCIPAL, 'agreement-restart'))!;
		const interrupted: WorkAgreementRecord = { ...current, revision: 1, status: 'submitting', attemptId: 'attempt-restart', expectedHash: hash,
			history: { ...current.history, attemptIds: ['attempt-restart'] }, updatedAt: '2026-10-24T10:00:01.000Z' };
		expect(await store.compareAndSwap(PRINCIPAL, 'agreement-restart', 0, interrupted)).toBe(true);
		const dispatch = vi.fn(async () => undefined); const restarted = runtime(new D1WorkAgreementStore(asD1(db)), effects({ dispatch }));
		const recovered = await restarted.recover({ principal: PRINCIPAL, agreementId: 'agreement-restart', owner: owner.classicAddress,
			network: 'testnet', approvalId: 'approval-restart', idempotencyKey: 'idem-restart' });
		expect(recovered).toMatchObject({ outcome: 'pending', record: { status: 'unknown', dispatchError: 'recovered after interrupted dispatch' } });
		expect(dispatch).not.toHaveBeenCalled();
		db.close();
	});

	it('rejects history rewrites and any attempted signed-blob persistence', async () => {
		const db = new SqliteD1(); const store = new D1WorkAgreementStore(asD1(db)); const app = runtime(store);
		await app.prepare({ principal: PRINCIPAL, terms: terms('agreement-safe'), approval: approval('safe') });
		const current = (await store.get(PRINCIPAL, 'agreement-safe'))!;
		await expect(store.compareAndSwap(PRINCIPAL, 'agreement-safe', 0, { ...current, revision: 1,
			history: { ...current.history, approvalIds: [] }, updatedAt: '2026-10-24T10:00:01.000Z' }))
			.rejects.toBeInstanceOf(WorkAgreementStoreDataError);
		await expect(store.compareAndSwap(PRINCIPAL, 'agreement-safe', 0, { ...current, revision: 1,
			updatedAt: '2026-10-24T10:00:01.000Z', signedBlob: 'DEADBEEF' } as WorkAgreementRecord))
			.rejects.toMatchObject({ code: 'CORRUPT_STATE' });
		db.close();
	});
});
