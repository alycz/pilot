import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { MandateStore, MandateStoreError } from '../src/exec/mandate-store';

function sqliteValue(value: unknown): unknown {
	return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

class Statement {
	private values: unknown[] = [];
	constructor(readonly database: DatabaseSync, readonly sql: string) {}
	bind(...values: unknown[]) { this.values = values.map(sqliteValue); return this; }
	async run() {
		const result = this.database.prepare(this.sql).run(...this.values as never[]);
		return { success: true, meta: { changes: Number(result.changes) } };
	}
	async first<T>() { return (this.database.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null; }
}

class SqliteD1 {
	readonly database = new DatabaseSync(':memory:');
	constructor() {
		this.database.exec('PRAGMA foreign_keys = ON');
		this.database.exec(readFileSync(new URL('../migrations/0007_ap4m_mandates.sql', import.meta.url), 'utf8'));
	}
	prepare(sql: string) { return new Statement(this.database, sql); }
	async batch(statements: Statement[]) {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.run());
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

describe('MandateStore atomic spend reservation', () => {
	it('derives exact caps from the stored mandate and keeps idempotency fail-closed', async () => {
		const db = new SqliteD1();
		const store = new MandateStore(db as unknown as D1Database, 'principal');
		await store.insertPrepared({
			id: 'm1', owner: 'rOwner', notBefore: '2026-10-21T00:00:00.000Z', expiresAt: '2026-10-22T00:00:00.000Z',
			constraints: { currency: 'USD', per_payment_max: '6', daily_max: '10', total_max: '12', payees: ['merchant-a'] },
			agentPublicJwk: {}, agentKeyCiphertext: new Uint8Array([1]).buffer, agentKeyIv: new Uint8Array(12).buffer,
			claimKeysCiphertext: new Uint8Array([2]).buffer, claimKeysIv: new Uint8Array(12).buffer,
			claimPublicKeys: [{ merchant_id: 'merchant-a', public_key: 'EDPUBLIC' }],
			prepared: { unsigned_batch: { TransactionType: 'Batch' } }, createdAt: '2026-10-21T00:00:00.000Z',
		});
		const viChainCiphertext = new Uint8Array([3, 4]).buffer;
		const viChainIv = new Uint8Array(12).fill(5).buffer;
		await store.activate('m1', { l1Digest: 'l1', l2Digest: 'l2', viChainCiphertext, viChainIv, setupBatchHash: 'hash', channels: [], updatedAt: '2026-10-21T00:01:00.000Z' });
		expect(await store.getWrappedViChain('m1')).toEqual({ owner: 'rOwner', ciphertext: viChainCiphertext, iv: viChainIv });

		const first = await store.reserveSpend({ id: 's1', mandateId: 'm1', day: '2026-10-21', idempotencyKey: 'one', amountUsd: '6', now: '2026-10-21T01:00:00.000Z' });
		expect(first.amountUsd).toBe('6');
		expect(await store.reserveSpend({ id: 'ignored', mandateId: 'm1', day: '2026-10-21', idempotencyKey: 'one', amountUsd: '6', now: '2026-10-21T01:01:00.000Z' })).toEqual(first);
		await expect(store.reserveSpend({ id: 'conflict', mandateId: 'm1', day: '2026-10-21', idempotencyKey: 'one', amountUsd: '5', now: '2026-10-21T01:02:00.000Z' })).rejects.toMatchObject<Partial<MandateStoreError>>({ code: 'SPEND_CONFLICT' });
		await expect(store.reserveSpend({ id: 's2', mandateId: 'm1', day: '2026-10-21', idempotencyKey: 'two', amountUsd: '5', now: '2026-10-21T02:00:00.000Z' })).rejects.toMatchObject<Partial<MandateStoreError>>({ code: 'SPEND_LIMIT' });
		await store.reserveSpend({ id: 's3', mandateId: 'm1', day: '2026-10-22', idempotencyKey: 'three', amountUsd: '6', now: '2026-10-22T01:00:00.000Z' });
		await expect(store.reserveSpend({ id: 's4', mandateId: 'm1', day: '2026-10-23', idempotencyKey: 'four', amountUsd: '0.000001', now: '2026-10-23T01:00:00.000Z' })).rejects.toMatchObject<Partial<MandateStoreError>>({ code: 'SPEND_LIMIT' });
	});
});
