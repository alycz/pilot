import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	Ap4mEvmStoreError,
	D1Ap4mEvmStore,
	type ReserveAp4mEvmVoucherInput,
} from '../src/ap4m-evm/store';

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
	constructor(install = true) {
		if (!install) return;
		this.sqlite.exec('PRAGMA foreign_keys = ON');
		const migration = fileURLToPath(new URL('../migrations/0016_ap4m_evm_event.sql', import.meta.url));
		this.sqlite.exec(readFileSync(migration, 'utf8'));
	}
	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.sqlite.prepare(sql));
	}
	close(): void { this.sqlite.close(); }
}

const PRINCIPAL = 'event-test-principal';
const CHANNEL = `0x${'1'.repeat(64)}`;
const AGENT = `0x${'2'.repeat(40)}`;
const FUNDING = `0x${'3'.repeat(40)}`;
const PAYOUT = `0x${'4'.repeat(40)}`;
const TOKEN = '0x27b57a9d0b8d24eb97259c4e2279e45255e016f3';
const FINGERPRINT = 'a'.repeat(64);
const ATTEMPT_A = 'b'.repeat(64);
const ATTEMPT_B = 'c'.repeat(64);
const TX_HASH = `0x${'d'.repeat(64)}`;
const NOW = '2026-10-24T20:00:00.000Z';

function input(overrides: Partial<ReserveAp4mEvmVoucherInput> = {}): ReserveAp4mEvmVoucherInput {
	return {
		principal: PRINCIPAL,
		channelId: CHANNEL,
		merchantId: 'event-merchant',
		agentWallet: AGENT,
		fundingWallet: FUNDING,
		payoutWallet: PAYOUT,
		tokenAddress: TOKEN,
		generation: 0,
		capBaseUnits: '2000000000000000000',
		nextCumulative: '1000000000000000000',
		idempotencyKey: 'voucher-1',
		requestFingerprint: FINGERPRINT,
		attemptToken: ATTEMPT_A,
		at: NOW,
		...overrides,
	};
}

describe('AP4M EVM durable state', () => {
	it('fails closed when its versioned schema is unavailable', async () => {
		const db = new SqliteD1(false);
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await expect(store.getChannel(CHANNEL)).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' });
			expect(db.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it('reserves exactly one voucher, rejects collisions, and enforces role/cap boundaries', async () => {
		const db = new SqliteD1();
		try {
			const first = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			const second = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			const outcomes = await Promise.all([
				first.reserve(input()),
				second.reserve(input({ idempotencyKey: 'voucher-2', requestFingerprint: 'e'.repeat(64), attemptToken: ATTEMPT_B })),
			]);
			expect(outcomes.map((value) => value.outcome).sort()).toEqual(['blocked', 'reserved']);
			const mismatch = await first.reserve(input({ nextCumulative: '2' }));
			expect(mismatch.outcome).toBe('mismatch');
			await expect(first.reserve(input({ payoutWallet: AGENT }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
			await expect(first.reserve(input({ idempotencyKey: 'over', requestFingerprint: 'f'.repeat(64), nextCumulative: '2000000000000000001' })))
				.rejects.toMatchObject({ code: 'CAP_EXCEEDED' });
		} finally {
			db.close();
		}
	});

	it('allows the documented agent-funded role while keeping payout separate', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			expect((await store.reserve(input({ fundingWallet: AGENT }))).outcome).toBe('reserved');
		} finally {
			db.close();
		}
	});

	it('keeps an uncertain submission pending by hash and never opens a second attempt', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			const reserved = await store.reserve(input());
			expect(reserved.outcome).toBe('reserved');
			const unknown = await store.markSubmissionUnknown({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A,
				txHash: TX_HASH, at: NOW,
			});
			expect(unknown.outcome).toBe('transitioned');
			expect((await store.getAttemptByHash(TX_HASH))?.status).toBe('submission_unknown');
			expect((await store.reserve(input({ attemptToken: ATTEMPT_B }))).outcome).toBe('pending');
			expect((await store.reserve(input({ idempotencyKey: 'voucher-2', requestFingerprint: 'e'.repeat(64), attemptToken: ATTEMPT_B }))).outcome).toBe('blocked');
		} finally {
			db.close();
		}
	});

	it('rejects transaction-hash replay across principals', async () => {
		const db = new SqliteD1();
		try {
			const first = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await first.reserve(input());
			await first.markSubmissionUnknown({ channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH, at: NOW });

			const otherPrincipal = 'other-principal';
			const second = new D1Ap4mEvmStore(db as unknown as D1Database, otherPrincipal);
			await second.reserve(input({ principal: otherPrincipal }));
			await expect(second.markSubmissionUnknown({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH, at: NOW,
			})).rejects.toMatchObject({ code: 'STORE_CONFLICT' });
		} finally {
			db.close();
		}
	});

	it('blocks a corrupted cross-row pending binding', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await store.reserve(input());
			db.sqlite.prepare(`UPDATE ap4m_evm_channels SET pending_request_fingerprint = ?
				WHERE principal = ? AND channel_id = ?`).run('e'.repeat(64), PRINCIPAL, CHANNEL);
			expect((await store.reserve(input())).outcome).toBe('blocked');
			const transition = await store.markSubmissionUnknown({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A,
				txHash: TX_HASH, at: NOW,
			});
			expect(transition.outcome).toBe('blocked');
		} finally {
			db.close();
		}
	});

	it('repairs a confirmed crash boundary, advances monotonically, and replays exactly', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await store.reserve(input());
			await store.markSubmissionUnknown({ channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH, at: NOW });
			const confirmed = await store.confirm({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH,
				receiptFingerprint: 'f'.repeat(64), blockNumber: 12, confirmations: 6, at: NOW,
			});
			expect(confirmed.outcome).toBe('transitioned');
			expect(confirmed.channel.cumulativeBaseUnits).toBe('1000000000000000000');
			expect((await store.reserve(input())).outcome).toBe('replay');
			const journal = db.sqlite.prepare(`SELECT event FROM ap4m_evm_journal ORDER BY sequence`).all();
			expect(journal).toEqual([{ event: 'reserved' }, { event: 'submission_unknown' }, { event: 'confirmed' }]);

			const next = await store.reserve(input({
				idempotencyKey: 'voucher-2', requestFingerprint: 'e'.repeat(64), attemptToken: ATTEMPT_B,
				nextCumulative: '2000000000000000000',
			}));
			expect(next.outcome).toBe('reserved');
		} finally {
			db.close();
		}
	});

	it('clears a pending attempt only with explicit validated-absence evidence', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await store.reserve(input());
			await store.markSubmissionUnknown({ channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH, at: NOW });
			const wrong = await store.markAbsent({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_B,
				txHash: TX_HASH, absenceFingerprint: '9'.repeat(64), at: NOW,
			});
			expect(wrong.outcome).toBe('mismatch');
			const absent = await store.markAbsent({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A,
				txHash: TX_HASH, absenceFingerprint: '9'.repeat(64), at: NOW,
			});
			expect(absent.outcome).toBe('transitioned');
			expect(absent.channel.cumulativeBaseUnits).toBe('0');
			expect(absent.channel.pendingIdempotencyKey).toBeNull();
		} finally {
			db.close();
		}
	});

	it('repairs missing journal rows and a confirmed-but-unadvanced channel', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await store.reserve(input());
			db.sqlite.prepare(`DELETE FROM ap4m_evm_journal`).run();
			expect((await store.reserve(input())).outcome).toBe('owner');
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_evm_journal`).get()).toEqual({ count: 1 });

			await store.markSubmissionUnknown({ channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH, at: NOW });
			db.sqlite.prepare(`DELETE FROM ap4m_evm_journal WHERE event = 'submission_unknown'`).run();
			expect((await store.reserve(input())).outcome).toBe('pending');
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_evm_journal WHERE event = 'submission_unknown'`).get()).toEqual({ count: 1 });

			await store.confirm({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH,
				receiptFingerprint: 'f'.repeat(64), blockNumber: 12, confirmations: 6, at: NOW,
			});
			db.sqlite.prepare(`DELETE FROM ap4m_evm_journal WHERE event = 'confirmed'`).run();
			db.sqlite.prepare(`UPDATE ap4m_evm_channels SET cumulative_base_units = '0',
				pending_idempotency_key = ?, pending_request_fingerprint = ?, pending_next_cumulative = ?,
				pending_attempt_token = ? WHERE principal = ? AND channel_id = ?`).run(
				'voucher-1', FINGERPRINT, '1000000000000000000', ATTEMPT_A, PRINCIPAL, CHANNEL,
			);
		const repaired = await store.reserve(input());
		expect(repaired.outcome).toBe('replay');
		expect(repaired.channel.cumulativeBaseUnits).toBe('1000000000000000000');
		expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_evm_journal WHERE event = 'confirmed'`).get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it('repairs a failed-absent crash before the channel pending fields clear', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1Ap4mEvmStore(db as unknown as D1Database, PRINCIPAL);
			await store.reserve(input());
			await store.markSubmissionUnknown({ channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH, at: NOW });
			await store.markAbsent({
				channelId: CHANNEL, idempotencyKey: 'voucher-1', attemptToken: ATTEMPT_A, txHash: TX_HASH,
				absenceFingerprint: '9'.repeat(64), at: NOW,
			});
			db.sqlite.prepare(`DELETE FROM ap4m_evm_journal WHERE event = 'failed_absent'`).run();
			db.sqlite.prepare(`UPDATE ap4m_evm_channels SET
				pending_idempotency_key = ?, pending_request_fingerprint = ?, pending_next_cumulative = ?,
				pending_attempt_token = ? WHERE principal = ? AND channel_id = ?`).run(
				'voucher-1', FINGERPRINT, '1000000000000000000', ATTEMPT_A, PRINCIPAL, CHANNEL,
			);
			const replay = await store.reserve(input());
			expect(replay.outcome).toBe('replay');
			expect(replay.channel.pendingIdempotencyKey).toBeNull();
			expect(db.sqlite.prepare(`SELECT count(*) AS count FROM ap4m_evm_journal WHERE event = 'failed_absent'`).get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it('rejects malformed principals before touching the database', () => {
		const db = new SqliteD1();
		try {
			expect(() => new D1Ap4mEvmStore(db as unknown as D1Database, '')).toThrow(Ap4mEvmStoreError);
		} finally {
			db.close();
		}
	});
});
