import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
	D1ChannelClaimStore,
	type ChannelClaimStore,
	type ReserveChannelClaimInput,
} from '../src/exec/channel-claim-store';
import {
	channelPaymentHeader,
	ChannelClaimError,
	issueChannelClaim,
	nextChannelClaim,
} from '../src/exec/channel-claims';

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
	private values: SqlValue[] = [];
	constructor(private readonly statement: StatementSync) {}
	bind(...values: unknown[]): this {
		this.values = values.map((value) => value instanceof ArrayBuffer
			? new Uint8Array(value)
			: value as SqlValue);
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
	async all<T>(): Promise<D1Result<T>> {
		return { success: true, results: this.statement.all(...this.values) as T[] };
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	private batchTail: Promise<void> = Promise.resolve();
	constructor(installMigrations = true) {
		if (!installMigrations) return;
		this.sqlite.exec('PRAGMA foreign_keys = ON');
		const directory = fileURLToPath(new URL('../migrations-local-x402/', import.meta.url));
		for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
			this.sqlite.exec(readFileSync(`${directory}/${filename}`, 'utf8'));
		}
		this.sqlite.prepare(`INSERT INTO ap4m_mandates (
			id, principal, owner, network, status, execution_type, not_before, expires_at,
			constraints_json, agent_public_jwk, agent_key_enc, agent_key_iv,
			claim_keys_enc, claim_keys_iv, claim_public_keys_json, prepared_json,
			created_at, updated_at
		) VALUES (?, ?, ?, 'testnet', 'ACTIVE', 'DEFERRED', ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				'mandate-mh5', 'mh5-test-principal', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
				'2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z',
				JSON.stringify({ currency: 'USD', per_payment_max: '1', total_max: '2', daily_max: '2',
					payees: ['venue-yield-desk'] }),
				new Uint8Array([1]), new Uint8Array(12), new Uint8Array([1]), new Uint8Array(12),
				JSON.stringify([{ merchant_id: 'venue-yield-desk', public_key: `ED${'B'.repeat(64)}` }]),
				JSON.stringify({ unsigned_batch: {} }),
				'2026-10-21T20:30:00.000Z', '2026-10-21T20:30:00.000Z',
			);
	}
	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.sqlite.prepare(sql));
	}
	async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
		const before = this.batchTail;
		let release!: () => void;
		this.batchTail = new Promise<void>((resolve) => { release = resolve; });
		await before;
		try {
			this.sqlite.exec('BEGIN IMMEDIATE');
			const results: D1Result[] = [];
			for (const statement of statements) results.push(await statement.run());
			this.sqlite.exec('COMMIT');
			return results;
		} catch (error) {
			this.sqlite.exec('ROLLBACK');
			throw error;
		} finally {
			release();
		}
	}
	close(): void { this.sqlite.close(); }
}

const PRINCIPAL = 'mh5-test-principal';
const PAYER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const CHANNEL_ID = 'A'.repeat(64);
const PUBLIC_KEY = `ED${'B'.repeat(64)}`;
const TOKEN_A = 'C'.repeat(64);
const TOKEN_B = 'D'.repeat(64);
const NOW = '2026-10-21T20:30:00.000Z';

function input(overrides: Partial<ReserveChannelClaimInput> = {}): ReserveChannelClaimInput {
	return {
		principal: PRINCIPAL,
		mandateId: 'mandate-mh5',
		merchantId: 'venue-yield-desk',
		channelId: CHANNEL_ID,
		payer: PAYER,
		channelAmountDrops: '100000',
		publicKey: PUBLIC_KEY,
		priceDrops: '50000',
		idempotencyKey: 'purchase-one',
		token: TOKEN_A,
		at: NOW,
		...overrides,
	};
}

describe('MH5 cumulative claim math', () => {
	it.each([
		['0', '50000', '100000', '50000'],
		['50000', '50000', '100000', '100000'],
		['99999', '1', '100000', '100000'],
	])('computes previous + exact price monotonically', (previous, price, amount, expected) => {
		expect(nextChannelClaim(previous, price, amount)).toBe(expected);
	});

	it.each([
		['100000', '1', '100000', 'CHANNEL_AMOUNT_EXCEEDED'],
		['1', '0', '100000', 'INVALID_CLAIM_AMOUNT'],
		['01', '1', '100000', 'INVALID_CLAIM_AMOUNT'],
		['0', '1.1', '100000', 'INVALID_CLAIM_AMOUNT'],
		['100001', '1', '100000', 'INVALID_CLAIM_AMOUNT'],
	])('fails closed for invalid/capped math', (previous, price, amount, expectedCode) => {
		expect(() => nextChannelClaim(previous, price, amount))
			.toThrowError(expect.objectContaining({ code: expectedCode }));
	});

	it('rejects oversized decimal strings before bigint conversion', async () => {
		const huge = '9'.repeat(100_000);
		expect(() => nextChannelClaim('0', huge, '100000'))
			.toThrowError(expect.objectContaining({ code: 'INVALID_CLAIM_AMOUNT' }));
		const db = new SqliteD1();
		try {
			const store = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
			await expect(store.reserve(input({ priceDrops: huge })))
				.rejects.toMatchObject({ code: 'INVALID_INPUT' });
		} finally {
			db.close();
		}
	});
});

describe('MH5 durable channel claim store', () => {
	it('fails closed without the versioned channel-claim schema and creates no tables', async () => {
		const db = new SqliteD1(false);
		try {
			const store = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
			await expect(store.get(CHANNEL_ID)).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' });
			const tables = db.sqlite.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
			).all();
			expect(tables).toEqual([]);
		} finally {
			db.close();
		}
	});

	it.each([
		['duplicate merchant keys', [
			{ merchant_id: 'venue-yield-desk', public_key: PUBLIC_KEY },
			{ merchant_id: 'venue-yield-desk', public_key: `ED${'C'.repeat(64)}` },
		]],
		['malformed first merchant key', [
			{ merchant_id: 'venue-yield-desk', public_key: PUBLIC_KEY.toLowerCase() },
			{ merchant_id: 'venue-risk-oracle', public_key: `ED${'C'.repeat(64)}` },
		]],
	] as const)('rejects %s before durable reservation', async (_label, publicKeys) => {
		const reserve = vi.fn<ChannelClaimStore['reserve']>();
		const store: ChannelClaimStore = {
			reserve,
			complete: vi.fn<ChannelClaimStore['complete']>(),
			get: vi.fn<ChannelClaimStore['get']>(),
			list: vi.fn<ChannelClaimStore['list']>(),
		};
		await expect(issueChannelClaim({
			identity: {
				principal: PRINCIPAL,
				owner: PAYER,
				network: 'testnet',
				mandateId: 'mandate-mh5',
			},
			merchantId: 'venue-yield-desk',
			channelId: CHANNEL_ID,
			payer: PAYER,
			channelAmountDrops: '100000',
			priceDrops: '50000',
			idempotencyKey: 'purchase-one',
			token: TOKEN_A,
			at: NOW,
			wrappedKeys: {
				ciphertext: new ArrayBuffer(17),
				iv: new ArrayBuffer(12),
				publicKeys,
			},
			kek: 'not-reached',
		}, { store })).rejects.toMatchObject({ code: 'CLAIM_KEY_MISMATCH' });
		expect(reserve).not.toHaveBeenCalled();
	});

	it('serializes two different idempotency keys in both orderings', async () => {
		for (const [first, second] of [
			[input(), input({ idempotencyKey: 'purchase-two', token: TOKEN_B })],
			[input({ idempotencyKey: 'purchase-two', token: TOKEN_B }), input()],
		] as const) {
			const db = new SqliteD1();
			try {
				const a = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
				const b = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
				const outcomes = await Promise.all([a.reserve(first), b.reserve(second)]);
				expect(outcomes.map((result) => result.outcome).sort()).toEqual(['blocked', 'reserved']);
			} finally {
				db.close();
			}
		}
	});

	it('replays one in-flight owner, completes once, advances exactly, and enforces cap', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
			const first = await store.reserve(input());
			expect(first.outcome).toBe('reserved');
			if (first.outcome !== 'reserved') throw new Error('expected reservation');
			const differentToken = await store.reserve(input({ token: TOKEN_B }));
			expect(differentToken.outcome).toBe('blocked');
			const owner = await store.reserve(input());
			expect(owner.outcome).toBe('owner');
			if (owner.outcome !== 'owner') throw new Error('expected owner');
			expect(owner.reservation.token).toBe(TOKEN_A);
			const completed = await store.complete({ ...first.reservation, signature: '30', at: NOW });
			expect(completed.outcome).toBe('completed');
			const replay = await store.reserve(input({ token: TOKEN_B }));
			expect(replay.outcome).toBe('replay');
			if (replay.outcome !== 'replay') throw new Error('expected replay');
			expect(replay.proof).toEqual({
				scheme: 'xrpl-paychan',
				channel_id: CHANNEL_ID,
				cumulative_drops: '50000',
				signature: '30',
				public_key: PUBLIC_KEY,
			});

			const second = await store.reserve(input({ idempotencyKey: 'purchase-two', token: TOKEN_B }));
			expect(second.outcome).toBe('reserved');
			if (second.outcome !== 'reserved') throw new Error('expected second reservation');
			expect(second.reservation.cumulativeDrops).toBe('100000');
			await store.complete({ ...second.reservation, signature: '32', at: NOW });
			const historicalReplay = await store.reserve(input({ token: TOKEN_B }));
			expect(historicalReplay.outcome).toBe('replay');
			if (historicalReplay.outcome !== 'replay') throw new Error('expected historical replay');
			expect(historicalReplay.proof).toEqual({
				scheme: 'xrpl-paychan',
				channel_id: CHANNEL_ID,
				cumulative_drops: '50000',
				signature: '30',
				public_key: PUBLIC_KEY,
			});
			expect((await store.get(CHANNEL_ID))?.cumulativeDrops).toBe('100000');
			await expect(store.reserve(input({
				idempotencyKey: 'purchase-three',
				token: 'E'.repeat(64),
			}))).rejects.toMatchObject({ code: 'CLAIM_CAP_EXCEEDED' });
			expect((await store.list('mandate-mh5')).map((row) => row.cumulativeDrops))
				.toEqual(['100000']);
		} finally {
			db.close();
		}
	});

	it('issues an exact header without exposing signer material and replays byte-identically', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
			let signCalls = 0;
			const issue = () => issueChannelClaim({
				identity: {
					principal: PRINCIPAL,
					owner: PAYER,
					network: 'testnet',
					mandateId: 'mandate-mh5',
				},
				merchantId: 'venue-yield-desk',
				channelId: CHANNEL_ID,
				payer: PAYER,
				channelAmountDrops: '100000',
				priceDrops: '50000',
				idempotencyKey: 'purchase-one',
				token: TOKEN_A,
				at: NOW,
				wrappedKeys: {
					ciphertext: new ArrayBuffer(17),
					iv: new ArrayBuffer(12),
					publicKeys: [{ merchant_id: 'venue-yield-desk', public_key: PUBLIC_KEY }],
				},
				kek: 'unused-by-injected-signer',
			}, {
				store,
				withSigner: async (_identity, _wrapped, _merchant, _kek, callback) => {
					signCalls += 1;
					return callback({ publicKey: PUBLIC_KEY, sign: () => '30' });
				},
			});
			const first = await issue();
			const replay = await issue();
			expect(first).toEqual({
				scheme: 'xrpl-paychan',
				channel_id: CHANNEL_ID,
				cumulative_drops: '50000',
				signature: '30',
				public_key: PUBLIC_KEY,
				replayed: false,
			});
			expect(replay).toEqual({ ...first, replayed: true });
			expect(signCalls).toBe(1);
			expect(Object.keys(first).sort()).toEqual([
				'channel_id', 'cumulative_drops', 'public_key', 'replayed', 'scheme', 'signature',
			]);
			const merchantHeader = channelPaymentHeader(replay);
			expect(merchantHeader).toEqual({
				scheme: 'xrpl-paychan',
				channel_id: CHANNEL_ID,
				cumulative_drops: '50000',
				signature: '30',
				public_key: PUBLIC_KEY,
			});
			expect(Object.keys(merchantHeader).sort()).toEqual([
				'channel_id', 'cumulative_drops', 'public_key', 'scheme', 'signature',
			]);
		} finally {
			db.close();
		}
	});

	it('repairs a completed attempt after a crash before the main row finalized', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
			const first = await store.reserve(input());
			expect(first.outcome).toBe('reserved');
			db.sqlite.prepare(`UPDATE ap4m_channel_claim_attempts
				SET signature = ?, status = 'completed', updated_at = ?
				WHERE principal = ? AND channel_id = ? AND idempotency_key = ?`).run(
				'30', NOW, PRINCIPAL, CHANNEL_ID, 'purchase-one',
			);
			const replay = await store.reserve(input());
			expect(replay.outcome).toBe('replay');
			if (replay.outcome !== 'replay') throw new Error('expected repaired replay');
			expect(replay.proof.cumulative_drops).toBe('50000');
			expect(await store.get(CHANNEL_ID)).toMatchObject({
				cumulativeDrops: '50000',
				lastPriceDrops: '50000',
				lastIdempotencyKey: 'purchase-one',
				signature: '30',
				pendingIdempotencyKey: null,
				pendingPriceDrops: null,
				pendingCumulativeDrops: null,
				pendingToken: null,
			});

			const second = await store.reserve(input({
				idempotencyKey: 'purchase-two',
				token: TOKEN_B,
			}));
			expect(second.outcome).toBe('reserved');
			if (second.outcome !== 'reserved') throw new Error('expected second reservation');
			expect(second.reservation.cumulativeDrops).toBe('100000');
			await expect(store.complete({ ...second.reservation, signature: '32', at: NOW }))
				.resolves.toMatchObject({ outcome: 'completed' });
			expect((await store.get(CHANNEL_ID))?.cumulativeDrops).toBe('100000');
		} finally {
			db.close();
		}
	});

	it('fails before completion when the injected signer public key diverges', async () => {
		const db = new SqliteD1();
		try {
			const store = new D1ChannelClaimStore(db as unknown as D1Database, PRINCIPAL);
			await expect(issueChannelClaim({
				identity: { principal: PRINCIPAL, owner: PAYER, network: 'testnet', mandateId: 'mandate-mh5' },
				merchantId: 'venue-yield-desk', channelId: CHANNEL_ID, payer: PAYER,
				channelAmountDrops: '100000', priceDrops: '50000', idempotencyKey: 'purchase-one',
				token: TOKEN_A, at: NOW,
				wrappedKeys: { ciphertext: new ArrayBuffer(17), iv: new ArrayBuffer(12),
					publicKeys: [{ merchant_id: 'venue-yield-desk', public_key: PUBLIC_KEY }] },
				kek: 'unused',
			}, {
				store,
				withSigner: async (_identity, _wrapped, _merchant, _kek, callback) => callback({
					publicKey: `ED${'F'.repeat(64)}`,
					sign: () => '30',
				}),
			})).rejects.toBeInstanceOf(ChannelClaimError);
			expect((await store.get(CHANNEL_ID))?.cumulativeDrops).toBe('0');
		} finally {
			db.close();
		}
	});
});
