import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, type TxBuild } from '../src/contracts';
import { Store, StoreDataError } from '../src/exec/store';

type TableName = 'links' | 'policies' | 'builds' | 'executions' | 'approvals' | 'events';

type RawRow = Record<string, unknown>;

class MemoryD1 {
	readonly tables: Record<TableName, RawRow[]> = {
		links: [],
		policies: [],
		builds: [],
		executions: [],
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
		const normalized = normalize(sql);
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
		return this.tables[table].find((row) => columns.every((column, index) => row[column] === values[index])) ?? null;
	}

	all(sql: string, values: unknown[]): RawRow[] {
		const normalized = normalize(sql);
		const match = normalized.match(/^select \* from (\w+) where (.+) order by .+$/);
		if (match === null) throw new Error(`Unsupported all SQL: ${normalized}`);
		const table = asTable(match[1]);
		const columns = match[2].split(' and ').map((condition) => condition.trim().split(' = ')[0]);
		return this.tables[table]
			.filter((row) => columns.every((column, index) => row[column] === values[index]))
			.sort((left, right) => `${left.created_at ?? ''}:${left.id ?? ''}`.localeCompare(`${right.created_at ?? ''}:${right.id ?? ''}`));
	}
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
		value === 'executions' ||
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

describe('Store', () => {
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
		});

		expect(await beta.getBuild('build-alpha')).toBeNull();
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
});
