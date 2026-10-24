import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
	X402PayerStore,
	X402PayerStoreDataError,
	type X402PayerInsert,
} from '../src/exec/x402-payer-store';

const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const PUBLIC_KEY = `ED${'A'.repeat(64)}`;
const PAYER = 'rDNPy1xcB9PJoNZyG1u36Whd1rboH6Go9D';
const OTHER_PUBLIC_KEY = `ED${'B'.repeat(64)}`;
const OTHER_PAYER = 'rNusjd3RRHjMjXHB3NY6xw4FLawn9xcL2B';
const NOW = '2026-10-19T10:00:00.000Z';
const LATER = '2026-10-19T10:01:00.000Z';

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
	async first<T>(): Promise<T | null> {
		return (this.statement.get(...this.values) as T | undefined) ?? null;
	}
}

class SqliteD1 {
	readonly sqlite = new DatabaseSync(':memory:');
	constructor() {
		for (const migration of [
			'0001_init.sql', '0002_x402_payments.sql', '0003_x402_payers.sql', '0004_x402_sequence_safety.sql',
			'0005_x402_durable_lease.sql',
			'0006_x402_budget_accounting.sql', '0007_x402_payer_provisioning.sql',
		]) {
			this.sqlite.exec(readFileSync(new URL(`../migrations-local-x402/${migration}`, import.meta.url), 'utf8'));
		}
	}
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	close(): void { this.sqlite.close(); }
}

function asD1(db: SqliteD1): D1Database {
	return db as unknown as D1Database;
}

function fixture(overrides: Partial<X402PayerInsert> = {}): X402PayerInsert {
	return {
		owner: OWNER,
		network: 'testnet',
		payer: PAYER,
		publicKey: PUBLIC_KEY,
		ciphertext: Uint8Array.from({ length: 33 }, (_, index) => index + 1).buffer,
		iv: Uint8Array.from({ length: 12 }, (_, index) => 200 + index).buffer,
		status: 'disabled',
		fundedLedgerIndex: null,
		fundedBalanceDrops: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function bytes(value: ArrayBuffer): number[] {
	return [...new Uint8Array(value)];
}

describe('x402 payer migration', () => {
	it('adds payer storage and accepted-cap columns without a plaintext seed column', () => {
		const db = new SqliteD1();
		const payerColumns = db.sqlite.prepare('PRAGMA table_info(x402_payers)').all() as Array<{ name: string }>;
		const paymentColumns = db.sqlite.prepare('PRAGMA table_info(x402_payments)').all() as Array<{ name: string }>;
		const names = payerColumns.map(({ name }) => name);
		expect(names).toContain('ciphertext');
		expect(names).toContain('iv');
		expect(names).toEqual(expect.arrayContaining(['faucet_requested_at', 'funding_checked_at']));
		expect(names.some((name) => /(^|_)seed($|_)/i.test(name))).toBe(false);
		expect(paymentColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
			'fee_cap_drops', 'reserved_total_drops',
		]));
		db.close();
	});
});

describe('X402PayerStore', () => {
	it('scopes reads and writes to the principal', async () => {
		const db = new SqliteD1();
		const first = new X402PayerStore(asD1(db), 'first-principal');
		const second = new X402PayerStore(asD1(db), 'second-principal');
		await first.insert(fixture());
		expect(await second.get(OWNER)).toBeNull();
		await second.insert(fixture({ payer: OTHER_PAYER, publicKey: OTHER_PUBLIC_KEY }));
		expect((await first.get(OWNER))?.payer).toBe(PAYER);
		expect((await second.get(OWNER))?.payer).not.toBe(PAYER);
		db.close();
	});

	it('enforces uniqueness per principal, owner, and network', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		await store.insert(fixture());
		await expect(store.insert(fixture())).rejects.toMatchObject({ code: 'CONFLICT' });
		db.close();
	});

	it('forbids reusing one payer address across principal-owner bindings', async () => {
		const db = new SqliteD1();
		await new X402PayerStore(asD1(db), 'first-principal').insert(fixture());
		await expect(new X402PayerStore(asD1(db), 'second-principal').insert(fixture({
			owner: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
		}))).rejects.toMatchObject({ code: 'CONFLICT' });
		db.close();
	});

	it('rejects invalid network, public material, wrapped material, and funding metadata', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		const invalid: Array<Partial<X402PayerInsert>> = [
			{ network: 'devnet' as 'testnet' },
			{ owner: 'not-an-address' },
			{ payer: 'not-an-address' },
			{ publicKey: 'ED00' },
			{ publicKey: OTHER_PUBLIC_KEY },
			{ ciphertext: new Uint8Array(16).buffer },
			{ iv: new Uint8Array(11).buffer },
			{ status: 'active' as 'disabled' },
			{ fundedLedgerIndex: 100, fundedBalanceDrops: null },
			{ fundedLedgerIndex: null, fundedBalanceDrops: '1' },
			{ fundedLedgerIndex: 100, fundedBalanceDrops: '-1' },
			{ createdAt: 'not-a-timestamp' },
			{ extra: 'not accepted' } as Partial<X402PayerInsert>,
		];
		for (const overrides of invalid) {
			await expect(store.insert(fixture(overrides))).rejects.toBeInstanceOf(X402PayerStoreDataError);
		}
		db.close();
	});

	it('round-trips fixture AES-GCM ciphertext and IV byte-for-byte', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		const input = fixture();
		await store.insert(input);
		const stored = await store.get(OWNER);
		expect(stored).not.toBeNull();
		expect(bytes(stored!.ciphertext)).toEqual(bytes(input.ciphertext));
		expect(bytes(stored!.iv)).toEqual(bytes(input.iv));
		expect(JSON.stringify(stored)).not.toMatch(/seed|secret|private|mnemonic/i);
		db.close();
	});

	it('records a faucet intent once and preserves it across store restarts', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		await store.insert(fixture());
		const first = await store.markFaucetRequested(OWNER, 'testnet', LATER);
		expect(first).toMatchObject({ requested: true, row: { faucetRequestedAt: LATER } });
		const restarted = new X402PayerStore(asD1(db), 'principal');
		const second = await restarted.markFaucetRequested(OWNER, 'testnet', LATER);
		expect(second).toMatchObject({ requested: false, row: { faucetRequestedAt: LATER } });
		db.close();
	});

	it('activates only a marked payer after a positive validated funding observation', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		await store.insert(fixture());
		await expect(store.markReadyFromFunding(OWNER, 'testnet', {
			ledgerIndex: 1234, balanceDrops: '5000000', checkedAt: LATER,
		})).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
		await store.markFaucetRequested(OWNER, 'testnet', LATER);
		await expect(store.markReadyFromFunding(OWNER, 'testnet', {
			ledgerIndex: 1234, balanceDrops: '0', checkedAt: LATER,
		})).rejects.toMatchObject({ code: 'INVALID_DATA' });
		const ready = await store.markReadyFromFunding(OWNER, 'testnet', {
			ledgerIndex: 1234, balanceDrops: '5000000', checkedAt: LATER,
		});
		expect(ready).toMatchObject({
			status: 'ready', fundedLedgerIndex: 1234, fundedBalanceDrops: '5000000',
			fundingCheckedAt: LATER,
		});
		db.close();
	});

	it('supports validated status transitions and optional funding metadata', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		await store.insert(fixture());
		const ready = await store.update(OWNER, 'testnet', {
			status: 'ready', fundedLedgerIndex: 1234, fundedBalanceDrops: '5000000', updatedAt: LATER,
		});
		expect(ready).toMatchObject({ status: 'ready', fundedLedgerIndex: 1234, fundedBalanceDrops: '5000000' });
		const suspended = await store.update(OWNER, 'testnet', { status: 'suspended', updatedAt: LATER });
		expect(suspended.status).toBe('suspended');
		await expect(store.update(OWNER, 'testnet', { status: 'suspended', updatedAt: LATER }))
			.resolves.toMatchObject({ status: 'suspended' });
		db.close();
	});

	it('rejects impossible status values before issuing an update', async () => {
		const db = new SqliteD1();
		const store = new X402PayerStore(asD1(db), 'principal');
		await store.insert(fixture({ status: 'ready' }));
		await expect(store.update(OWNER, 'testnet', {
			status: 'unknown' as 'ready', updatedAt: LATER,
		})).rejects.toBeInstanceOf(X402PayerStoreDataError);
		db.close();
	});
});
