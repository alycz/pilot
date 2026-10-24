import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';

import { DEFAULT_POLICY, type TxBuild } from '../src/contracts';
import { Store, StoreDataError } from '../src/exec/store';

type TableName =
	| 'links'
	| 'policies'
	| 'builds'
	| 'build_revisions'
	| 'executions'
	| 'execution_snapshots'
	| 'relay_claims'
	| 'approvals'
	| 'events';

type RawRow = Record<string, unknown>;

class MemoryD1 {
	readonly tables: Record<TableName, RawRow[]> = {
		links: [],
		policies: [],
		builds: [],
		build_revisions: [],
		executions: [],
		execution_snapshots: [],
		relay_claims: [],
		approvals: [],
		events: [],
	};

	prepare(sql: string): MemoryStatement {
		return new MemoryStatement(this, sql);
	}

	seed(table: TableName, row: RawRow): void {
		this.tables[table].push(row);
	}

	run(sql: string, values: unknown[]): void {
		const normalized = normalize(sql);
		const insert = normalized.match(/^insert into (\w+) \(([^)]+)\) values \(([^)]+)\)$/);
		if (insert !== null) {
			const table = asTable(insert[1]);
			const columns = insert[2].split(',').map((column) => column.trim());
			this.tables[table].push(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
			return;
		}

		const update = normalized.match(/^update (\w+) set (.+) where (.+)$/);
		if (update !== null) {
			const table = asTable(update[1]);
			const setColumns = update[2].split(',').map((assignment) => assignment.trim().split(' = ')[0]);
			const whereColumns = update[3].split(' and ').map((condition) => condition.trim().split(' = ')[0]);
			const whereValues = values.slice(setColumns.length);
			const row = this.tables[table].find((candidate) => whereColumns.every((column, index) => candidate[column] === whereValues[index]));
			if (row !== undefined) {
				setColumns.forEach((column, index) => {
					row[column] = values[index];
				});
			}
			return;
		}
		throw new Error(`Unsupported run SQL: ${normalized}`);
	}

	first(sql: string, values: unknown[]): RawRow | null {
		const normalized = normalize(sql).replace(
			'select *, hex(delegate_seed_enc) as delegate_seed_enc_hex, hex(iv) as iv_hex from ',
			'select * from ',
		);
		if (normalized.startsWith('select coalesce(sum(e.usd_value), 0) as total')) {
			const [executionPrincipal, buildPrincipal, owner, network, status, since] = values;
			let total = 0;
			for (const execution of this.tables.executions) {
				const build = this.tables.builds.find(
					(candidate) => candidate.id === execution.build_id && candidate.principal === execution.principal,
				);
				if (
					execution.principal === executionPrincipal &&
					build !== undefined &&
					build.principal === buildPrincipal &&
					build.owner === owner &&
					build.network === network &&
					execution.status === status &&
					typeof execution.created_at === 'string' &&
					execution.created_at >= String(since)
				) {
					total += Number(execution.usd_value ?? 0);
				}
			}
			return { total };
		}

		const match = normalized.match(/^select \* from (\w+) where (.+)$/);
		if (match === null) throw new Error(`Unsupported first SQL: ${normalized}`);
		const table = asTable(match[1]);
		const where = match[2].replace(/ order by .+$/, '');
		const columns = where.split(' and ').map((condition) => condition.trim().split(' = ')[0]);
		const row = this.tables[table].find((candidate) => columns.every((column, index) => candidate[column] === values[index]));
		return row === undefined ? null : project(sql, row);
	}

	all(sql: string, values: unknown[]): RawRow[] {
		const normalized = normalize(sql).replace(
			'select *, hex(delegate_seed_enc) as delegate_seed_enc_hex, hex(iv) as iv_hex from ',
			'select * from ',
		);
		const match = normalized.match(/^select \* from (\w+) where (.+) order by .+$/);
		if (match === null) throw new Error(`Unsupported all SQL: ${normalized}`);
		const table = asTable(match[1]);
		const columns = match[2].split(' and ').map((condition) => condition.trim().split(' = ')[0]);
		return this.tables[table]
			.filter((row) => columns.every((column, index) => row[column] === values[index]))
			.sort((left, right) => `${left.created_at ?? ''}:${left.id ?? ''}`.localeCompare(`${right.created_at ?? ''}:${right.id ?? ''}`))
			.map((row) => project(sql, row));
	}
}

function blobHex(value: unknown): string {
	const local = structuredClone(value);
	if (local instanceof ArrayBuffer) return Array.from(new Uint8Array(local), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
	if (ArrayBuffer.isView(local)) {
		return Array.from(new Uint8Array(local.buffer, local.byteOffset, local.byteLength), (byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase();
	}
	throw new Error('MemoryD1 expected a binary value');
}

function project(sql: string, row: RawRow): RawRow {
	if (!sql.toLowerCase().includes('hex(delegate_seed_enc)')) return row;
	return {
		...row,
		delegate_seed_enc_hex: blobHex(row.delegate_seed_enc),
		iv_hex: blobHex(row.iv),
	};
}

class MemoryStatement {
	private values: unknown[] = [];

	constructor(
		private readonly db: MemoryD1,
		private readonly sql: string,
	) {}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	async run(): Promise<unknown> {
		this.db.run(this.sql, this.values);
		return { success: true };
	}

	async first<T>(): Promise<T | null> {
		return this.db.first(this.sql, this.values) as T | null;
	}

	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.db.all(this.sql, this.values) as T[] };
	}
}

function normalize(sql: string): string {
	return sql.trim().replace(/\s+/g, ' ').toLowerCase();
}

function asTable(value: string | undefined): TableName {
	if (
		value === 'links' ||
		value === 'policies' ||
		value === 'builds' ||
		value === 'build_revisions' ||
		value === 'executions' ||
		value === 'execution_snapshots' ||
		value === 'relay_claims' ||
		value === 'approvals' ||
		value === 'events'
	) {
		return value;
	}
	throw new Error(`Unknown table: ${value}`);
}

const now = '2026-10-18T10:00:00.000Z';
const summary: TxBuild['summary'] = {
	action: 'offer',
	account: 'rOwner',
	amounts: ['10 RLUSD', '5 XRP'],
	fee_drops: '12',
	reserve_delta_drops: '0',
};

function store(db: MemoryD1, principal: string): Store {
	return new Store(db as unknown as D1Database, principal);
}

type SqlValue = string | number | bigint | null | Uint8Array;

class SqliteStatement {
	private values: SqlValue[] = [];

	constructor(private readonly statement: StatementSync) {}

	bind(...values: unknown[]): this {
		this.values = values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SqlValue)));
		return this;
	}

	execute(): D1Result {
		const result = this.statement.run(...this.values);
		return { success: true, meta: { changes: Number(result.changes) } as D1Result['meta'] };
	}

	async run(): Promise<D1Result> {
		return this.execute();
	}

	async first<T>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		return (column === undefined ? row : row[column]) as T;
	}

	async all<T>(): Promise<D1Result<T>> {
		return { success: true, results: this.statement.all(...this.values) as T[], meta: {} as D1Result<T>['meta'] };
	}
}

class MigrationD1 {
	readonly sqlite = new DatabaseSync(':memory:');

	constructor() {
		for (const migration of [
			'migrations/0001_init.sql',
			'migrations/0002_build_capability_isolation.sql',
			'migrations/0003_execution_lifetime_v2.sql',
			'migrations/0004_v2_preflight_rejections.sql',
			'migrations/0005_v2_approval_recovery.sql',
		]) {
			this.sqlite.exec(readFileSync(migration, 'utf8'));
		}
		this.sqlite.exec('PRAGMA foreign_keys = ON');
	}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.sqlite.prepare(sql));
	}

	async batch(statements: SqliteStatement[]): Promise<D1Result[]> {
		this.sqlite.exec('BEGIN IMMEDIATE');
		try {
			const results = statements.map((statement) => statement.execute());
			this.sqlite.exec('COMMIT');
			return results;
		} catch (error) {
			this.sqlite.exec('ROLLBACK');
			throw error;
		}
	}

	close(): void {
		this.sqlite.close();
	}
}

function migratedStore(db: MigrationD1, principal = 'alpha'): Store {
	return new Store(db as unknown as D1Database, principal);
}

const digestA = 'A'.repeat(64);
const digestB = 'B'.repeat(64);

const v2Fields = {
	executionContract: 'xrpl_execution_v2',
	buildRevision: 1,
	unsignedTxDigest: digestA,
	unsignedTxDigestAlg: 'sha256-jcs-v1',
	economicFingerprint: digestB,
	economicFingerprintAlg: 'sha256-jcs-economic-v1',
	buildLedger: 100,
	firstInclusionLedger: 101,
	lastLedgerSequence: 164,
	minimumRemainingLedgers: 8,
	approvalExpiresInSeconds: 90,
	quoteLedger: 99,
	quoteValidThroughLedger: 100,
	acquisitionBalanceInvariant: {
		kind: 'issued_balance_unchanged',
		currency: '524C555344000000000000000000000000000000',
		issuer: 'rIssuer',
		balance: '0',
		ledgerIndex: 100,
	},
} as const;

describe('Store', () => {
	it('normalizes typed-array and cross-realm D1 BLOB values before signing reads', async () => {
		const db = new MemoryD1();
		const foreignBuffer = runInNewContext('new Uint8Array([1, 2, 3]).buffer') as ArrayBuffer;
		expect(foreignBuffer).not.toBeInstanceOf(ArrayBuffer);
		db.seed('links', {
			id: 'link-foreign-blob',
			principal: 'alpha',
			owner: 'rOwner',
			network: 'testnet',
			delegate: 'rDelegateA',
			delegate_seed_enc: foreignBuffer,
			iv: new Uint8Array([4, 5]),
			permissions: '["OfferCreate"]',
			status: 'active',
			last_ledger: null,
			revoke_tx: null,
			created_at: now,
		});

		const link = await store(db, 'alpha').getLink('rOwner', 'testnet');
		expect(link?.delegateSeedEnc).toBeInstanceOf(ArrayBuffer);
		expect(Array.from(new Uint8Array(link?.delegateSeedEnc))).toEqual([1, 2, 3]);
		expect(link?.iv).toBeInstanceOf(ArrayBuffer);
		expect(Array.from(new Uint8Array(link?.iv))).toEqual([4, 5]);
	});

	it('round-trips links and keeps reads, updates, and active lists principal-scoped', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');
		const beta = store(db, 'beta');
		const seed = new Uint8Array([1, 2, 3]).buffer;
		const iv = new Uint8Array([4, 5]).buffer;

		await alpha.insertLink({
			id: 'link-alpha',
			owner: 'rOwner',
			network: 'testnet',
			delegate: 'rDelegateA',
			delegateSeedEnc: seed,
			iv,
			permissions: ['OfferCreate'],
			status: 'active',
			lastLedger: null,
			revokeTx: null,
			createdAt: now,
		});
		await beta.insertLink({
			id: 'link-beta',
			owner: 'rOwner',
			network: 'testnet',
			delegate: 'rDelegateB',
			delegateSeedEnc: seed,
			iv,
			permissions: ['TrustSet'],
			status: 'active',
			lastLedger: 10,
			revokeTx: { TransactionType: 'DelegateSet' },
			createdAt: now,
		});

		expect(await alpha.getLink('rOwner', 'testnet')).toMatchObject({
			id: 'link-alpha',
			principal: 'alpha',
			permissions: ['OfferCreate'],
			revokeTx: null,
		});
		expect((await alpha.listActiveLinks()).map((link) => link.id)).toEqual(['link-alpha']);
		expect(await beta.updateLink('link-alpha', { status: 'revoked' })).toBeNull();
		expect((await alpha.getLink('rOwner', 'testnet'))?.status).toBe('active');

		await alpha.updateLink('link-alpha', {
			status: 'suspended',
			lastLedger: 20,
			revokeTx: { TransactionType: 'DelegateSet', Permissions: [] },
		});
		expect(await alpha.listActiveLinks()).toEqual([]);
		expect(await alpha.getLink('rOwner', 'testnet')).toMatchObject({
			status: 'suspended',
			lastLedger: 20,
			revokeTx: { TransactionType: 'DelegateSet', Permissions: [] },
		});
	});

	it('round-trips and isolates policies', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');
		const beta = store(db, 'beta');
		await alpha.insertPolicy({
			owner: 'rOwner',
			network: 'testnet',
			json: DEFAULT_POLICY,
			updatedAt: now,
		});
		await beta.insertPolicy({
			owner: 'rOwner',
			network: 'testnet',
			json: { ...DEFAULT_POLICY, daily_cap_usd: 1 },
			updatedAt: now,
		});

		expect((await alpha.getPolicy('rOwner', 'testnet'))?.json.daily_cap_usd).toBe(5000);
		await alpha.updatePolicy('rOwner', 'testnet', {
			json: { ...DEFAULT_POLICY, daily_cap_usd: 4000 },
			updatedAt: '2026-10-18T11:00:00.000Z',
		});
		expect((await alpha.getPolicy('rOwner', 'testnet'))?.json.daily_cap_usd).toBe(4000);
		expect((await beta.getPolicy('rOwner', 'testnet'))?.json.daily_cap_usd).toBe(1);
	});

	it('round-trips and isolates builds', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');
		const beta = store(db, 'beta');
		await alpha.insertBuild({
			id: 'build-alpha',
			owner: 'rOwner',
			network: 'testnet',
			txJson: { TransactionType: 'OfferCreate' },
			summary,
			lastLedgerSeq: 100,
			createdAt: now,
		});
		await beta.insertBuild({
			id: 'build-beta',
			owner: 'rOwner',
			network: 'testnet',
			txJson: { TransactionType: 'TrustSet' },
			summary,
			lastLedgerSeq: 101,
			createdAt: now,
			originProfile: 'local-trading-onboarding',
		});

		expect(await beta.getBuild('build-alpha')).toBeNull();
		expect((await alpha.getBuild('build-alpha'))?.originProfile).toBeNull();
		expect((await beta.getBuild('build-beta'))?.originProfile).toBe('local-trading-onboarding');
		expect(await beta.updateBuild('build-alpha', { lastLedgerSeq: 999 })).toBeNull();
		await alpha.updateBuild('build-alpha', {
			txJson: { TransactionType: 'OfferCancel', OfferSequence: 1 },
			lastLedgerSeq: 102,
		});
		expect(await alpha.getBuild('build-alpha')).toMatchObject({
			txJson: { TransactionType: 'OfferCancel', OfferSequence: 1 },
			summary,
			lastLedgerSeq: 102,
		});
	});

	it('scopes execution CRUD, lookup helpers, and daily USD totals', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');
		const beta = store(db, 'beta');
		const addBuild = async (target: Store, id: string, owner = 'rOwner', network: 'testnet' | 'devnet' = 'testnet') =>
			target.insertBuild({
				id,
				owner,
				network,
				txJson: { TransactionType: 'OfferCreate' },
				summary,
				lastLedgerSeq: 100,
				createdAt: now,
			});
		await addBuild(alpha, 'build-counted');
		await addBuild(alpha, 'build-pending');
		await addBuild(alpha, 'build-old');
		await addBuild(alpha, 'build-other-owner', 'rOther');
		await addBuild(beta, 'build-beta');

		await expect(
			alpha.insertExecution({
				id: 'exec-cross-principal',
				buildId: 'build-beta',
				idempotencyKey: 'key-cross-principal',
				status: 'executed',
				hash: 'hash-cross-principal',
				usdValue: 500,
				signedBy: 'delegate',
				createdAt: now,
			}),
		).rejects.toBeInstanceOf(StoreDataError);
		await expect(
			alpha.insertExecution({
				id: 'exec-missing-build',
				buildId: 'missing-build',
				idempotencyKey: 'key-missing-build',
				status: 'executed',
				hash: 'hash-missing-build',
				usdValue: 500,
				signedBy: 'delegate',
				createdAt: now,
			}),
		).rejects.toBeInstanceOf(StoreDataError);

		const addExecution = async (
			target: Store,
			id: string,
			buildId: string,
			status: 'executed' | 'pending',
			usdValue: number,
			createdAt = now,
		) =>
			target.insertExecution({
				id,
				buildId,
				idempotencyKey: `key-${id}`,
				status,
				hash: `hash-${id}`,
				usdValue,
				signedBy: 'delegate',
				createdAt,
			});
		await addExecution(alpha, 'exec-counted', 'build-counted', 'executed', 12.5);
		await addExecution(alpha, 'exec-pending', 'build-pending', 'pending', 99);
		await addExecution(alpha, 'exec-old', 'build-old', 'executed', 5, '2026-10-17T23:59:59.000Z');
		await addExecution(alpha, 'exec-other-owner', 'build-other-owner', 'executed', 7);
		await addExecution(beta, 'exec-beta', 'build-beta', 'executed', 100);

		expect(await beta.getExecution('exec-counted')).toBeNull();
		expect(await beta.findExecutionByHash('hash-exec-counted')).toBeNull();
		expect(await beta.findExecutionByIdempotencyKey('key-exec-counted')).toBeNull();
		expect((await alpha.findExecutionByHash('hash-exec-counted'))?.id).toBe('exec-counted');
		expect((await alpha.findExecutionByIdempotencyKey('key-exec-counted'))?.id).toBe('exec-counted');
		expect(await beta.updateExecution('exec-counted', { usdValue: 999 })).toBeNull();
		await alpha.updateExecution('exec-counted', { hash: 'new-hash', usdValue: 13.5 });
		expect((await alpha.getExecution('exec-counted'))?.hash).toBe('new-hash');
		expect(await alpha.getDailyExecutedUsdTotal('rOwner', 'testnet', '2026-10-18T00:00:00.000Z')).toBe(13.5);
	});

	it('round-trips and isolates approvals and events', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');
		const beta = store(db, 'beta');

		for (const [target, id] of [
			[alpha, 'build-alpha'],
			[beta, 'build-beta'],
		] as const) {
			await target.insertBuild({
				id,
				owner: 'rOwner',
				network: 'testnet',
				txJson: { TransactionType: 'Payment' },
				summary,
				lastLedgerSeq: 100,
				createdAt: now,
			});
		}

		await expect(
			alpha.insertApproval({
				id: 'approval-cross-principal',
				buildId: 'build-beta',
				txJson: { TransactionType: 'Payment', Amount: '500' },
				expiresAt: '2026-10-18T10:10:00.000Z',
				status: 'pending',
			}),
		).rejects.toBeInstanceOf(StoreDataError);

		await alpha.insertApproval({
			id: 'approval-alpha',
			buildId: 'build-alpha',
			txJson: { TransactionType: 'Payment', Amount: '1' },
			expiresAt: '2026-10-18T10:10:00.000Z',
			status: 'pending',
		});
		await beta.insertApproval({
			id: 'approval-beta',
			buildId: 'build-beta',
			txJson: { TransactionType: 'Payment', Amount: '2' },
			expiresAt: '2026-10-18T10:10:00.000Z',
			status: 'pending',
		});
		expect(await beta.getApproval('approval-alpha')).toBeNull();
		expect(await beta.updateApproval('approval-alpha', { status: 'approved' })).toBeNull();
		await alpha.updateApproval('approval-alpha', {
			status: 'submitted',
			txJson: { TransactionType: 'Payment', Amount: '3' },
		});
		expect(await alpha.getApproval('approval-alpha')).toMatchObject({
			status: 'submitted',
			txJson: { TransactionType: 'Payment', Amount: '3' },
		});

		await alpha.insertEvent({
			id: 'event-alpha',
			owner: 'rOwner',
			kind: 'foreign',
			detail: { hash: 'ABC' },
			createdAt: now,
		});
		await beta.insertEvent({
			id: 'event-beta',
			owner: 'rOwner',
			kind: 'foreign',
			detail: { hash: 'DEF' },
			createdAt: now,
		});
		expect(await beta.getEvent('event-alpha')).toBeNull();
		expect(await beta.updateEvent('event-alpha', { detail: { hash: 'BAD' } })).toBeNull();
		await alpha.updateEvent('event-alpha', {
			kind: 'foreign-reviewed',
			detail: { hash: 'ABC', reviewed: true },
		});
		expect(await alpha.getEvent('event-alpha')).toMatchObject({
			kind: 'foreign-reviewed',
			detail: { hash: 'ABC', reviewed: true },
		});
	});

	it('fails closed when persisted JSON has an invalid shape', async () => {
		const db = new MemoryD1();
		db.seed('events', {
			id: 'bad-event',
			principal: 'alpha',
			owner: 'rOwner',
			kind: 'foreign',
			detail: '[]',
			created_at: now,
		});

		await expect(store(db, 'alpha').getEvent('bad-event')).rejects.toBeInstanceOf(StoreDataError);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const invalidJsonValues: unknown[] = [
			1n,
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			() => undefined,
			Symbol('not-json'),
			new Date(now),
			cyclic,
		];
		for (const [index, invalid] of invalidJsonValues.entries()) {
			await expect(
				store(db, 'alpha').insertEvent({
					id: `unserializable-event-${index}`,
					owner: 'rOwner',
					kind: 'foreign',
					detail: { invalid },
					createdAt: now,
				}),
			).rejects.toBeInstanceOf(StoreDataError);
		}
		expect(db.tables.events).toHaveLength(1);
	});

	it('rejects sensitive material before persistence and when reading legacy rows', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');

		await expect(
			alpha.insertBuild({
				id: 'sensitive-build',
				owner: 'rOwner',
				network: 'testnet',
				txJson: { TransactionType: 'Payment', seed: 'never-store-this' },
				summary,
				lastLedgerSeq: 100,
				createdAt: now,
			}),
		).rejects.toBeInstanceOf(StoreDataError);
		await expect(
			alpha.insertEvent({
				id: 'sensitive-event',
				owner: 'rOwner',
				kind: 'foreign',
				detail: { note: 'contains a private key' },
				createdAt: now,
			}),
		).rejects.toBeInstanceOf(StoreDataError);
		expect(db.tables.builds).toHaveLength(0);
		expect(db.tables.events).toHaveLength(0);

		db.seed('events', {
			id: 'legacy-sensitive-event',
			principal: 'alpha',
			owner: 'rOwner',
			kind: 'foreign',
			detail: JSON.stringify({ mnemonic: 'never return this' }),
			created_at: now,
		});
		await expect(alpha.getEvent('legacy-sensitive-event')).rejects.toBeInstanceOf(StoreDataError);
	});

	it('accepts opaque public identifiers containing internal sensitive-label characters', async () => {
		const db = new MemoryD1();
		const alpha = store(db, 'alpha');
		await alpha.insertBuild({
			id: 'opaque-public-identifier',
			owner: 'rAlphaSeedPublicIdentifier',
			network: 'testnet',
			txJson: { TransactionType: 'AccountSet', Account: 'rAlphaSeedPublicIdentifier' },
			summary,
			lastLedgerSeq: 100,
			createdAt: now,
		});
		await expect(alpha.getBuild('opaque-public-identifier')).resolves.toMatchObject({
			owner: 'rAlphaSeedPublicIdentifier',
			txJson: { Account: 'rAlphaSeedPublicIdentifier' },
		});
	});

	it('migrates without backfilling legacy rows and preserves permanent v1 reads', async () => {
		const db = new MigrationD1();
		try {
			const alpha = migratedStore(db);
			await alpha.insertBuild({
				id: 'legacy-build',
				owner: 'rOwner',
				network: 'testnet',
				txJson: { TransactionType: 'OfferCreate', LastLedgerSequence: 104 },
				summary,
				lastLedgerSeq: 104,
				createdAt: now,
			});
			await alpha.insertApproval({
				id: 'legacy-approval',
				buildId: 'legacy-build',
				txJson: { TransactionType: 'OfferCreate', LastLedgerSequence: 104 },
				expiresAt: '2026-10-18T10:10:00.000Z',
				status: 'pending',
			});

			expect(await alpha.getBuildRevision('legacy-build', 1)).toBeNull();
			expect(await alpha.getExecutionSnapshot('missing')).toBeNull();
			expect(await alpha.getApproval('legacy-approval')).toMatchObject({
				executionId: null,
				executionContract: null,
				buildRevision: null,
			});
			await alpha.updateApproval('legacy-approval', {
				txJson: { TransactionType: 'OfferCreate', LastLedgerSequence: 103 },
				expiresAt: '2026-10-18T10:09:00.000Z',
				status: 'approved',
			});
			expect(await alpha.getApproval('legacy-approval')).toMatchObject({
				txJson: { TransactionType: 'OfferCreate', LastLedgerSequence: 103 },
				expiresAt: '2026-10-18T10:09:00.000Z',
				status: 'approved',
			});
			expect(() =>
				db.sqlite.exec(
					"UPDATE approvals SET execution_id = 'legacy-exec', execution_contract = 'xrpl_execution_v2', build_revision = 1 WHERE id = 'legacy-approval'",
				),
			).toThrow(/cannot be upgraded/);
			expect(() =>
				db.sqlite.exec(
					"UPDATE builds SET execution_contract = 'xrpl_execution_v2', build_revision = 1 WHERE id = 'legacy-build'",
				),
			).toThrow(/cannot be upgraded/);
			await expect(
				alpha.insertBuildRevision({
					buildId: 'legacy-build',
					owner: 'rOwner',
					network: 'testnet',
					txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
					summary,
					createdAt: now,
					...v2Fields,
				}),
			).rejects.toBeInstanceOf(StoreDataError);
		} finally {
			db.close();
		}
	});

	it('atomically persists and strictly round-trips a complete immutable v2 build revision', async () => {
		const db = new MigrationD1();
		try {
			const alpha = migratedStore(db);
			await alpha.insertBuild({
				id: 'v2-build',
				owner: 'rOwner',
				network: 'testnet',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				summary,
				lastLedgerSeq: 164,
				createdAt: now,
				...v2Fields,
			});

			expect(await alpha.getBuildRevision('v2-build', 1)).toEqual({
				principal: 'alpha',
				buildId: 'v2-build',
				owner: 'rOwner',
				network: 'testnet',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				summary,
				createdAt: now,
				...v2Fields,
			});
			expect(await alpha.getBuild('v2-build')).toMatchObject({
				executionContract: 'xrpl_execution_v2',
				buildRevision: 1,
			});

			await expect(
				alpha.insertBuild({
					id: 'partial-v2-build',
					owner: 'rOwner',
					network: 'testnet',
					txJson: { TransactionType: 'OfferCreate' },
					summary,
					lastLedgerSeq: 164,
					createdAt: now,
					executionContract: 'xrpl_execution_v2',
				}),
			).rejects.toBeInstanceOf(StoreDataError);
			expect(await alpha.getBuild('partial-v2-build')).toBeNull();

			await expect(
				alpha.insertBuildRevision({
					buildId: 'v2-build',
					owner: 'rOwner',
					network: 'testnet',
					txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
					summary,
					createdAt: now,
					...v2Fields,
				}),
			).rejects.toThrow();

			await expect(
				alpha.insertBuild({
					id: 'stale-invariant-build',
					owner: 'rOwner',
					network: 'testnet',
					txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
					summary,
					lastLedgerSeq: 164,
					createdAt: now,
					...v2Fields,
					acquisitionBalanceInvariant: {
						...v2Fields.acquisitionBalanceInvariant,
						ledgerIndex: 98,
					},
				}),
			).rejects.toBeInstanceOf(StoreDataError);
			expect(await alpha.getBuild('stale-invariant-build')).toBeNull();

			await expect(
				alpha.insertBuild({
					id: 'wrong-invariant-build',
					owner: 'rOwner',
					network: 'testnet',
					txJson: {
						TransactionType: 'OfferCreate',
						Account: 'rOwner',
						Sequence: 7,
						LastLedgerSequence: 164,
						TakerPays: {
							currency: '524C555344000000000000000000000000000000',
							issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
							value: '10',
						},
						TakerGets: '10000000',
					},
					summary,
					lastLedgerSeq: 164,
					createdAt: now,
					...v2Fields,
					acquisitionBalanceInvariant: {
						...v2Fields.acquisitionBalanceInvariant,
						issuer: 'rUnrelatedIssuer',
					},
				}),
			).rejects.toThrow(/exact balance invariant/);
			expect(await alpha.getBuild('wrong-invariant-build')).toBeNull();

			db.sqlite.exec(`
				INSERT INTO builds
				  (id, principal, owner, network, tx_json, summary, last_ledger_seq,
				   created_at, origin_profile, build_revision, execution_contract)
				VALUES
				  ('raw-wrong-invariant-build', 'alpha', 'rOwner', 'testnet',
				   '{"TransactionType":"OfferCreate","Account":"rOwner","Sequence":7,"LastLedgerSequence":164,"TakerPays":{"currency":"524C555344000000000000000000000000000000","issuer":"rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV","value":"10"},"TakerGets":"10000000"}',
				   '${JSON.stringify(summary).replaceAll("'", "''")}', 164,
				   '${now}', 'local-trading', 1, 'xrpl_execution_v2')
			`);
			expect(() => db.sqlite.exec(`
				INSERT INTO build_revisions
				  (principal, build_id, build_revision, execution_contract, owner, network,
				   tx_json, summary, unsigned_tx_digest, unsigned_tx_digest_alg,
				   economic_fingerprint, economic_fingerprint_alg, build_ledger,
				   first_inclusion_ledger, last_ledger_sequence,
				   minimum_remaining_ledgers, approval_expires_in_seconds,
				   quote_ledger, quote_valid_through_ledger,
				   acquisition_balance_invariant, created_at)
				VALUES
				  ('alpha', 'raw-wrong-invariant-build', 1, 'xrpl_execution_v2',
				   'rOwner', 'testnet',
				   '{"TransactionType":"OfferCreate","Account":"rOwner","Sequence":7,"LastLedgerSequence":164,"TakerPays":{"currency":"524C555344000000000000000000000000000000","issuer":"rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV","value":"10"},"TakerGets":"10000000"}',
				   '${JSON.stringify(summary).replaceAll("'", "''")}',
				   '${digestA}', 'sha256-jcs-v1', '${digestB}', 'sha256-jcs-economic-v1',
				   100, 101, 164, 8, 90, NULL, NULL,
				   '{"ledger_index":100}', '${now}')
			`)).toThrow();
		} finally {
			db.close();
		}
	});

	it('round-trips v2 approval linkage, immutable snapshots, and insert-only relay claims', async () => {
		const db = new MigrationD1();
		try {
			const alpha = migratedStore(db);
			await alpha.insertBuild({
				id: 'snapshot-build',
				owner: 'rOwner',
				network: 'testnet',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				summary,
				lastLedgerSeq: 164,
				createdAt: now,
				...v2Fields,
			});
			await alpha.insertExecution({
				id: 'v2-execution',
				buildId: 'snapshot-build',
				idempotencyKey: 'v2-key',
				status: 'needs_approval',
				hash: null,
				usdValue: 10,
				signedBy: null,
				createdAt: now,
			});
			await alpha.insertApproval({
				id: 'v2-approval',
				buildId: 'snapshot-build',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				expiresAt: '2026-10-18T10:01:30.000Z',
				status: 'preflighted',
				executionId: 'v2-execution',
				executionContract: 'xrpl_execution_v2',
				buildRevision: 1,
			});
			expect(await alpha.getApproval('v2-approval')).toMatchObject({
				status: 'preflighted',
				executionId: 'v2-execution',
				executionContract: 'xrpl_execution_v2',
				buildRevision: 1,
			});
			await alpha.updateApproval('v2-approval', { status: 'submitted' });
			expect((await alpha.getApproval('v2-approval'))?.status).toBe('submitted');
			for (const assignment of [
				"tx_json = '{}'",
				"expires_at = '2026-10-18T10:02:00.000Z'",
				"build_id = 'other-build'",
				"execution_id = 'other-execution'",
				'build_revision = 2',
				'execution_contract = NULL',
			]) {
				expect(() => db.sqlite.exec(`UPDATE approvals SET ${assignment} WHERE id = 'v2-approval'`)).toThrow(
					/immutable/,
				);
			}

			await alpha.insertExecutionSnapshot({
				executionId: 'v2-execution',
				buildId: 'snapshot-build',
				executionContract: 'xrpl_execution_v2',
				buildRevision: 1,
				policySnapshot: DEFAULT_POLICY,
				policyRevision: now,
				unsignedTxDigest: digestA,
				unsignedTxDigestAlg: 'sha256-jcs-v1',
				economicFingerprint: digestB,
				economicFingerprintAlg: 'sha256-jcs-economic-v1',
				snapshotOwner: 'rOwner',
				snapshotNetwork: 'testnet',
				snapshotSequence: 7,
				firstInclusionLedger: 101,
				lastLedgerSequence: 164,
				approvalId: 'v2-approval',
				approvalExpiresAt: '2026-10-18T10:01:30.000Z',
				acquisitionBalanceInvariant: v2Fields.acquisitionBalanceInvariant,
				createdAt: now,
			});
			expect(await alpha.getExecutionSnapshot('v2-execution')).toMatchObject({
				buildRevision: 1,
				policySnapshot: DEFAULT_POLICY,
				policyRevision: now,
				approvalId: 'v2-approval',
				acquisitionBalanceInvariant: v2Fields.acquisitionBalanceInvariant,
			});

			await alpha.updateExecution('v2-execution', { hash: digestA });
			await alpha.insertRelayClaim({ executionId: 'v2-execution', hash: digestA, attemptedAt: now });
			expect(await alpha.getRelayClaim('v2-execution')).toEqual({
				principal: 'alpha',
				executionId: 'v2-execution',
				hash: digestA,
				attemptedAt: now,
			});
			await expect(
				alpha.updateExecution('v2-execution', { hash: digestB }),
			).rejects.toThrow(/hash is immutable/);
			await expect(
				alpha.updateExecution('v2-execution', { hash: null }),
			).rejects.toThrow(/hash is immutable/);
			await expect(
				alpha.insertRelayClaim({ executionId: 'v2-execution', hash: digestB, attemptedAt: now }),
			).rejects.toThrow();
			await alpha.insertEvent({
				id: 'execution-claim:v2-execution',
				owner: 'rOwner',
				kind: 'execution_claim',
				detail: {
					build_id: 'snapshot-build',
					execution_mode: 'require_owner_approval',
					execution_contract: 'xrpl_execution_v2',
					build_revision: 1,
				},
				createdAt: now,
			});

			for (const sql of [
				"UPDATE build_revisions SET owner = 'rChanged' WHERE build_id = 'snapshot-build'",
				"DELETE FROM build_revisions WHERE build_id = 'snapshot-build'",
				"UPDATE execution_snapshots SET snapshot_owner = 'rChanged' WHERE execution_id = 'v2-execution'",
				"DELETE FROM execution_snapshots WHERE execution_id = 'v2-execution'",
				"UPDATE relay_claims SET hash = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' WHERE execution_id = 'v2-execution'",
				"DELETE FROM relay_claims WHERE execution_id = 'v2-execution'",
				"UPDATE events SET detail = '{\"build_id\":\"snapshot-build\",\"execution_mode\":\"require_owner_approval\"}' WHERE id = 'execution-claim:v2-execution'",
				"DELETE FROM events WHERE id = 'execution-claim:v2-execution'",
			]) {
				expect(() => db.sqlite.exec(sql)).toThrow(/immutable/);
			}
		} finally {
			db.close();
		}
	});

	it('makes migration-backed preflight rejection rows atomic, terminal, and immutable', async () => {
		const db = new MigrationD1();
		try {
			const alpha = migratedStore(db);
			await alpha.insertBuild({
				id: 'rejection-build', owner: 'rOwner', network: 'testnet',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				summary, lastLedgerSeq: 164, createdAt: now, ...v2Fields,
			});
			await alpha.insertExecution({
				id: 'rejection-execution', buildId: 'rejection-build',
				idempotencyKey: 'rejection-key', status: 'needs_approval', hash: null,
				usdValue: 10, signedBy: null, createdAt: now,
			});
			await alpha.insertApproval({
				id: 'rejection-approval', buildId: 'rejection-build',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				expiresAt: '2026-10-18T10:01:30.000Z', status: 'pending',
				executionId: 'rejection-execution', executionContract: 'xrpl_execution_v2', buildRevision: 1,
			});
			await alpha.insertExecutionSnapshot({
				executionId: 'rejection-execution', buildId: 'rejection-build',
				executionContract: 'xrpl_execution_v2', buildRevision: 1,
				policySnapshot: DEFAULT_POLICY, policyRevision: now,
				unsignedTxDigest: digestA, unsignedTxDigestAlg: 'sha256-jcs-v1',
				economicFingerprint: digestB, economicFingerprintAlg: 'sha256-jcs-economic-v1',
				snapshotOwner: 'rOwner', snapshotNetwork: 'testnet', snapshotSequence: 7,
				firstInclusionLedger: 101, lastLedgerSequence: 164,
				approvalId: 'rejection-approval', approvalExpiresAt: '2026-10-18T10:01:30.000Z',
				acquisitionBalanceInvariant: v2Fields.acquisitionBalanceInvariant, createdAt: now,
			});
			await alpha.insertEvent({
				id: 'execution-result:rejection-execution', owner: 'rOwner', kind: 'execution_result',
				detail: { result: { status: 'needs_approval' } }, createdAt: now,
			});

			db.sqlite.exec(`INSERT INTO approval_preflight_rejections
				(principal, approval_id, execution_id, error_code, rejected_at)
				VALUES ('alpha', 'rejection-approval', 'rejection-execution',
				'ACCOUNT_SEQUENCE_CHANGED', '${now}')`);
			const terminal = db.sqlite.prepare(`SELECT a.status AS approval_status,
				e.status AS execution_status, e.hash, e.signed_by, ev.detail
				FROM approvals a JOIN executions e ON e.id = a.execution_id
				JOIN events ev ON ev.id = 'execution-result:' || e.id
				WHERE a.id = 'rejection-approval'`).get() as Record<string, unknown>;
			expect(terminal).toMatchObject({
				approval_status: 'rejected', execution_status: 'failed', hash: null, signed_by: null,
			});
			expect(JSON.parse(terminal.detail as string)).toMatchObject({
				result: { status: 'failed', engine_result: 'ACCOUNT_SEQUENCE_CHANGED' },
			});
			for (const sql of [
				"UPDATE approval_preflight_rejections SET error_code = 'FEE_LOAD_UNSAFE' WHERE approval_id = 'rejection-approval'",
				"DELETE FROM approval_preflight_rejections WHERE approval_id = 'rejection-approval'",
			]) expect(() => db.sqlite.exec(sql)).toThrow(/immutable/);
			expect(() => db.sqlite.exec(`INSERT INTO approval_preflight_rejections
				(principal, approval_id, execution_id, error_code, rejected_at)
				VALUES ('alpha', 'missing', 'missing', 'ACCOUNT_SEQUENCE_CHANGED', '${now}')`))
				.toThrow(/not claimable/);
		} finally {
			db.close();
		}
	});

	it('atomically burns a migration-backed recovered approval and rejects reuse', async () => {
		const db = new MigrationD1();
		try {
			const alpha = migratedStore(db);
			await alpha.insertBuild({
				id: 'recovery-build', owner: 'rOwner', network: 'testnet',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				summary, lastLedgerSeq: 164, createdAt: now, ...v2Fields,
			});
			await alpha.insertExecution({
				id: 'recovery-execution', buildId: 'recovery-build', idempotencyKey: 'recovery-key',
				status: 'needs_approval', hash: null, usdValue: 10, signedBy: null, createdAt: now,
			});
			await alpha.insertApproval({
				id: 'recovery-approval', buildId: 'recovery-build',
				txJson: { TransactionType: 'OfferCreate', Account: 'rOwner', Sequence: 7, LastLedgerSequence: 164 },
				expiresAt: '2026-10-18T10:01:30.000Z', status: 'preflighted',
				executionId: 'recovery-execution', executionContract: 'xrpl_execution_v2', buildRevision: 1,
			});
			await alpha.insertExecutionSnapshot({
				executionId: 'recovery-execution', buildId: 'recovery-build',
				executionContract: 'xrpl_execution_v2', buildRevision: 1,
				policySnapshot: DEFAULT_POLICY, policyRevision: now,
				unsignedTxDigest: digestA, unsignedTxDigestAlg: 'sha256-jcs-v1',
				economicFingerprint: digestB, economicFingerprintAlg: 'sha256-jcs-economic-v1',
				snapshotOwner: 'rOwner', snapshotNetwork: 'testnet', snapshotSequence: 7,
				firstInclusionLedger: 101, lastLedgerSequence: 164,
				approvalId: 'recovery-approval', approvalExpiresAt: '2026-10-18T10:01:30.000Z',
				acquisitionBalanceInvariant: v2Fields.acquisitionBalanceInvariant, createdAt: now,
			});
			await alpha.insertEvent({
				id: 'execution-result:recovery-execution', owner: 'rOwner', kind: 'execution_result',
				detail: { result: { status: 'needs_approval' } }, createdAt: now,
			});
			db.sqlite.exec(`INSERT INTO approval_recoveries
				(principal, approval_id, execution_id, build_id, build_revision,
				 unsigned_tx_digest, economic_fingerprint, validated_ledger,
				 first_inclusion_ledger, last_ledger_sequence, recovered_at)
				VALUES ('alpha', 'recovery-approval', 'recovery-execution', 'recovery-build', 1,
				 '${digestA}', '${digestB}', 165, 101, 164, '${now}')`);
			const terminal = db.sqlite.prepare(`SELECT a.status AS approval_status,
				e.status AS execution_status, e.hash, e.signed_by, ev.detail
				FROM approvals a JOIN executions e ON e.id = a.execution_id
				JOIN events ev ON ev.id = 'execution-result:' || e.id
				WHERE a.id = 'recovery-approval'`).get() as Record<string, unknown>;
			expect(terminal).toMatchObject({
				approval_status: 'expired', execution_status: 'failed', hash: null, signed_by: null,
			});
			expect(JSON.parse(terminal.detail as string)).toMatchObject({
				result: { status: 'failed', engine_result: 'APPROVAL_RECOVERED_NONINCLUSION' },
			});
			for (const sql of [
				"UPDATE approval_recoveries SET validated_ledger = 166 WHERE approval_id = 'recovery-approval'",
				"DELETE FROM approval_recoveries WHERE approval_id = 'recovery-approval'",
			]) expect(() => db.sqlite.exec(sql)).toThrow(/immutable/);
			await expect(alpha.insertExecution({
				id: 'reused-execution', buildId: 'recovery-build', idempotencyKey: 'reused-key',
				status: 'claimed', hash: null, usdValue: 1, signedBy: null, createdAt: now,
			})).rejects.toThrow(/permanently burned/);
		} finally {
			db.close();
		}
	});

	it('fails closed on malformed persisted v2 rows instead of treating them as legacy', async () => {
		const db = new MemoryD1();
		db.seed('build_revisions', {
			principal: 'alpha',
			build_id: 'malformed-build',
			build_revision: 1,
			execution_contract: 'xrpl_execution_v2',
			owner: 'rOwner',
			network: 'testnet',
			tx_json: '{}',
			unsigned_tx_digest: 'a'.repeat(64),
			unsigned_tx_digest_alg: 'sha256-jcs-v1',
			economic_fingerprint: digestB,
			economic_fingerprint_alg: 'sha256-jcs-economic-v1',
			build_ledger: 100,
			first_inclusion_ledger: 101,
			last_ledger_sequence: 163,
			minimum_remaining_ledgers: 8,
			approval_expires_in_seconds: 90,
			quote_ledger: null,
			quote_valid_through_ledger: null,
			acquisition_balance_invariant: null,
			created_at: now,
		});
		await expect(store(db, 'alpha').getBuildRevision('malformed-build', 1)).rejects.toBeInstanceOf(StoreDataError);

		db.seed('execution_snapshots', {
			execution_id: 'partial-snapshot',
			principal: 'alpha',
			build_id: 'malformed-build',
			execution_contract: 'xrpl_execution_v2',
			build_revision: 1,
			policy_snapshot: JSON.stringify(DEFAULT_POLICY),
			policy_revision: now,
			unsigned_tx_digest: digestA,
			unsigned_tx_digest_alg: 'sha256-jcs-v1',
			economic_fingerprint: digestB,
			economic_fingerprint_alg: 'sha256-jcs-economic-v1',
			snapshot_owner: 'rOwner',
			snapshot_network: 'testnet',
			snapshot_sequence: 7,
			first_inclusion_ledger: 101,
			last_ledger_sequence: 164,
			approval_id: 'approval-only',
			approval_expires_at: null,
			acquisition_balance_invariant: null,
			created_at: now,
		});
		await expect(store(db, 'alpha').getExecutionSnapshot('partial-snapshot')).rejects.toBeInstanceOf(StoreDataError);
	});
});
