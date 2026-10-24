import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { Store, StoreDataError } from '../src/exec/store';

type SqlValue = string | number | bigint | null | Uint8Array;

function sqlValue(value: unknown): SqlValue {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return value as SqlValue;
}

class SqliteStatement {
	private values: SqlValue[] = [];

	constructor(private readonly statement: StatementSync) {}

	bind(...values: unknown[]): this {
		this.values = values.map(sqlValue);
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
	constructor(readonly database: DatabaseSync) {}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.database.prepare(sql));
	}
}

function migration(name: string): string {
	return readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

function migratedDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(migration('0001_init.sql'));
	database.exec(migration('0002_quicknode.sql'));
	database.prepare(`INSERT INTO links (
		id, principal, owner, network, delegate, delegate_seed_enc, iv,
		permissions, status, last_ledger, revoke_tx, created_at, frozen_at, frozen_reason
	) VALUES (?, ?, ?, 'testnet', ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`).run(
		'legacy-link',
		'principal',
		'rLegacyOwner',
		'rLegacyDelegate',
		new Uint8Array([1, 2, 3]),
		new Uint8Array([4, 5]),
		'["OfferCreate"]',
		'2026-10-21T10:00:00.000Z',
		'2026-10-21T10:01:00.000Z',
		'quicknode:fixture',
	);
	database.exec(migration('0009_aws_kms_delegate_keys.sql'));
	return database;
}

describe('AWS-4 link key backend migration', () => {
	it('backfills legacy links as local without losing QuickNode freeze state', async () => {
		const database = migratedDatabase();
		try {
			const raw = database.prepare(`SELECT key_backend, kms_key_id, kms_alias,
				frozen_at, frozen_reason FROM links WHERE id = 'legacy-link'`).get();
			expect(raw).toEqual({
				key_backend: 'local',
				kms_key_id: null,
				kms_alias: null,
				frozen_at: '2026-10-21T10:01:00.000Z',
				frozen_reason: 'quicknode:fixture',
			});

			const row = await new Store(new SqliteD1(database) as unknown as D1Database, 'principal')
				.getLink('rLegacyOwner', 'testnet');
			expect(row).toMatchObject({
				keyBackend: 'local',
				kmsKeyId: null,
				kmsAlias: null,
			});
			expect(Array.from(new Uint8Array(row?.delegateSeedEnc ?? new ArrayBuffer(0))))
				.toEqual([1, 2, 3]);
		} finally {
			database.close();
		}
	});

	it('stores KMS links without wrapped local key material and rejects mixed states', async () => {
		const database = migratedDatabase();
		try {
			const store = new Store(new SqliteD1(database) as unknown as D1Database, 'principal');
			const row = await store.insertLink({
				id: 'kms-link',
				owner: 'rKmsOwner',
				network: 'testnet',
				delegate: 'rKmsDelegate',
				keyBackend: 'kms',
				delegateSeedEnc: null,
				iv: null,
				kmsKeyId: 'standin-key-id',
				kmsAlias: 'alias/harbor/testnet/kms-link',
				permissions: ['OfferCreate'],
				status: 'pending',
				lastLedger: null,
				revokeTx: null,
				createdAt: '2026-10-21T11:00:00.000Z',
			});
			expect(row).toEqual({
				id: 'kms-link',
				principal: 'principal',
				owner: 'rKmsOwner',
				network: 'testnet',
				delegate: 'rKmsDelegate',
				keyBackend: 'kms',
				delegateSeedEnc: null,
				iv: null,
				kmsKeyId: 'standin-key-id',
				kmsAlias: 'alias/harbor/testnet/kms-link',
				permissions: ['OfferCreate'],
				status: 'pending',
				lastLedger: null,
				revokeTx: null,
				createdAt: '2026-10-21T11:00:00.000Z',
			});

			expect(() => database.prepare(`INSERT INTO links (
				id, principal, owner, network, delegate, delegate_seed_enc, iv,
				key_backend, kms_key_id, kms_alias, permissions, status, created_at
			) VALUES ('mixed', 'principal', 'rMixedOwner', 'testnet', 'rMixedDelegate',
				x'01', x'02', 'kms', 'key', 'alias/harbor/testnet/mixed', '[]', 'pending',
				'2026-10-21T11:00:00.000Z')`).run()).toThrow();

			expect(() => database.prepare(`INSERT INTO links (
				id, principal, owner, network, delegate, delegate_seed_enc, iv,
				key_backend, kms_key_id, kms_alias, permissions, status, created_at
			) VALUES ('missing-kms', 'principal', 'rMissingOwner', 'testnet', 'rMissingDelegate',
				NULL, NULL, 'kms', NULL, NULL, '[]', 'pending',
				'2026-10-21T11:00:00.000Z')`).run()).toThrow();

			expect(() => database.prepare(`INSERT INTO links (
				id, principal, owner, network, delegate, delegate_seed_enc, iv,
				key_backend, kms_key_id, kms_alias, permissions, status, created_at
			) VALUES ('wrong-alias', 'principal', 'rAliasOwner', 'testnet', 'rAliasDelegate',
				NULL, NULL, 'kms', 'key', 'alias/harbor/devnet/wrong-alias', '[]', 'pending',
				'2026-10-21T11:00:00.000Z')`).run()).toThrow();
		} finally {
			database.close();
		}
	});

	it('fails closed when malformed backend metadata bypasses database checks', async () => {
		const database = migratedDatabase();
		try {
			database.exec('PRAGMA ignore_check_constraints = ON');
			database.prepare(`INSERT INTO links (
				id, principal, owner, network, delegate, delegate_seed_enc, iv,
				key_backend, kms_key_id, kms_alias, permissions, status, created_at
			) VALUES ('invalid-kms', 'principal', 'rInvalidOwner', 'testnet', 'rInvalidDelegate',
				NULL, NULL, 'kms', NULL, 'alias/harbor/testnet/invalid-kms', '[]', 'pending',
				'2026-10-21T12:00:00.000Z')`).run();

			await expect(new Store(new SqliteD1(database) as unknown as D1Database, 'principal')
				.getLink('rInvalidOwner', 'testnet')).rejects.toBeInstanceOf(StoreDataError);
		} finally {
			database.close();
		}
	});
});
