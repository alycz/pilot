import {
	chmodSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as readMigration } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	ensureLocalX402SecretFileAt,
	LOCAL_X402_SECRET_MAX_BYTES,
	LocalX402SecretFileError,
} from '../src/exec/x402-local-secret-file';
import { X402PayerStore } from '../src/exec/x402-payer-store';
import {
	provisionLocalX402Payer,
	X402ProvisioningError,
} from '../src/exec/x402-provisioner';
import {
	assertOwnerOnlyPath,
	findLocalX402Database,
	fundingObservation,
	LOCAL_X402_STATE_ROOT,
	parseProvisionerArguments,
	runProvisioner,
} from '../scripts/provision-local-x402';

const PRINCIPAL = 'local-principal';
const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const MERCHANT_PAY_TO = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59';
const PUBLIC_KEY = `ED${'A'.repeat(64)}`;
const PAYER = 'rDNPy1xcB9PJoNZyG1u36Whd1rboH6Go9D';
const NOW = new Date('2026-10-19T10:00:00.000Z');
const REPO_ROOT = realpathSync(process.cwd());

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
			'0001_init.sql', '0002_x402_payments.sql', '0003_x402_payers.sql',
			'0004_x402_sequence_safety.sql', '0005_x402_durable_lease.sql',
			'0006_x402_budget_accounting.sql', '0007_x402_payer_provisioning.sql',
		]) this.sqlite.exec(readMigration(new URL(`../migrations-local-x402/${migration}`, import.meta.url), 'utf8'));
	}
	prepare(sql: string): SqliteD1Statement { return new SqliteD1Statement(this.sqlite.prepare(sql)); }
	close(): void { this.sqlite.close(); }
}

function store(db: SqliteD1): X402PayerStore {
	return new X402PayerStore(db as unknown as D1Database, PRINCIPAL);
}

function wrapped() {
	return {
		address: PAYER,
		publicKey: PUBLIC_KEY,
		ciphertext: Uint8Array.from({ length: 33 }, (_, index) => index + 1).buffer,
		iv: Uint8Array.from({ length: 12 }, (_, index) => index + 80).buffer,
	};
}

describe('one-shot local x402 payer workflow', () => {
	it('creates one durable identity, calls the faucet once, validates funding, and exposes only public fields', async () => {
		const db = new SqliteD1();
		const createWrappedKey = vi.fn(async () => wrapped());
		const requestTestnetFaucet = vi.fn(async () => undefined);
		const readValidatedFunding = vi.fn(async () => ({ ledgerIndex: 88, balanceDrops: '10000000' }));
		const result = await provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT_PAY_TO, {
			store: store(db), createWrappedKey, requestTestnetFaucet, readValidatedFunding, now: () => NOW,
		});
		expect(result).toEqual({
			principal: PRINCIPAL,
			owner: OWNER,
			merchantPayTo: MERCHANT_PAY_TO,
			network: 'testnet',
			payer: PAYER,
			publicKey: PUBLIC_KEY,
			state: 'ready',
			fundedLedgerIndex: 88,
			fundedBalanceDrops: '10000000',
		});
		expect(JSON.stringify(result)).not.toMatch(/cipher|seed|secret|private|token|kek|\biv\b/i);
		expect(createWrappedKey).toHaveBeenCalledOnce();
		expect(requestTestnetFaucet).toHaveBeenCalledOnce();
		expect(readValidatedFunding).toHaveBeenCalledWith(PAYER);
		db.close();
	});

	it('fails closed after an uncertain faucet outcome and never automatically retries it after restart', async () => {
		const db = new SqliteD1();
		const firstFaucet = vi.fn(async () => { throw new Error('fixture upstream detail'); });
		await expect(provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT_PAY_TO, {
			store: store(db), createWrappedKey: async () => wrapped(), requestTestnetFaucet: firstFaucet,
			readValidatedFunding: async () => null, now: () => NOW,
		})).rejects.toMatchObject({ code: 'FAUCET_REQUEST_FAILED' });
		expect(firstFaucet).toHaveBeenCalledOnce();
		expect(await store(db).get(OWNER)).toMatchObject({ status: 'disabled', faucetRequestedAt: NOW.toISOString() });

		const forbiddenGenerator = vi.fn(async () => { throw new Error('must not generate'); });
		const forbiddenFaucet = vi.fn(async () => { throw new Error('must not retry'); });
		const resumed = await provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT_PAY_TO, {
			store: store(db), createWrappedKey: forbiddenGenerator, requestTestnetFaucet: forbiddenFaucet,
			readValidatedFunding: async () => null, now: () => NOW,
		});
		expect(resumed).toMatchObject({ payer: PAYER, state: 'funding-pending' });
		expect(forbiddenGenerator).not.toHaveBeenCalled();
		expect(forbiddenFaucet).not.toHaveBeenCalled();
		db.close();
	});

	it('is idempotent for a ready binding and does not invoke key, faucet, or ledger dependencies', async () => {
		const db = new SqliteD1();
		const payerStore = store(db);
		await payerStore.insert({
			owner: OWNER, network: 'testnet', payer: PAYER, publicKey: PUBLIC_KEY,
			ciphertext: wrapped().ciphertext, iv: wrapped().iv, status: 'ready',
			fundedLedgerIndex: 77, fundedBalanceDrops: '5',
			createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
		});
		const blocked = vi.fn(async () => { throw new Error('not called'); });
		const result = await provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT_PAY_TO, {
			store: store(db), createWrappedKey: blocked, requestTestnetFaucet: blocked,
			readValidatedFunding: blocked, now: () => NOW,
		});
		expect(result).toMatchObject({ state: 'ready', merchantPayTo: MERCHANT_PAY_TO, payer: PAYER });
		expect(blocked).not.toHaveBeenCalled();
		db.close();
	});

	it('rejects invalid input and suspended bindings before generating a key', async () => {
		const db = new SqliteD1();
		const blocked = vi.fn(async () => wrapped());
		await expect(provisionLocalX402Payer('bad principal', OWNER, MERCHANT_PAY_TO, {
			store: store(db), createWrappedKey: blocked, requestTestnetFaucet: async () => undefined,
			readValidatedFunding: async () => null, now: () => NOW,
		})).rejects.toBeInstanceOf(X402ProvisioningError);
		await store(db).insert({
			owner: OWNER, network: 'testnet', payer: PAYER, publicKey: PUBLIC_KEY,
			ciphertext: wrapped().ciphertext, iv: wrapped().iv, status: 'suspended',
			fundedLedgerIndex: null, fundedBalanceDrops: null,
			createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
		});
		await expect(provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT_PAY_TO, {
			store: store(db), createWrappedKey: blocked, requestTestnetFaucet: async () => undefined,
			readValidatedFunding: async () => null, now: () => NOW,
		})).rejects.toMatchObject({ code: 'BINDING_SUSPENDED' });
		expect(blocked).not.toHaveBeenCalled();
		db.close();
	});

	it('rejects the reserved local-dev principal before durable or external dependencies', async () => {
		const blocked = vi.fn(async () => { throw new Error('must not be called'); });
		await expect(provisionLocalX402Payer('local-dev', OWNER, MERCHANT_PAY_TO, {
			store: {
				get: blocked, insert: blocked, markFaucetRequested: blocked,
				markFundingPending: blocked, markReadyFromFunding: blocked,
			},
			createWrappedKey: blocked,
			requestTestnetFaucet: blocked,
			readValidatedFunding: blocked,
			now: () => NOW,
		})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(blocked).not.toHaveBeenCalled();
	});
});

describe('local provisioning command boundary', () => {
	it('requires the exact opt-in and accepts only nonsecret principal, owner, and merchant arguments', () => {
		expect(LOCAL_X402_STATE_ROOT).toMatch(/\/\.wrangler\/harbor-local-x402$/);
		expect(LOCAL_X402_STATE_ROOT).not.toMatch(/\/\.wrangler\/harbor-local$/);
		expect(parseProvisionerArguments([
			'--provision-testnet-payer', '--principal', PRINCIPAL, '--owner', OWNER,
			'--merchant-pay-to', MERCHANT_PAY_TO,
		])).toEqual({ principal: PRINCIPAL, owner: OWNER, merchantPayTo: MERCHANT_PAY_TO });
		expect(() => parseProvisionerArguments(['--principal', PRINCIPAL, '--owner', OWNER]))
			.toThrowError(X402ProvisioningError);
		expect(() => parseProvisionerArguments([
			'--provision-testnet-payer', '--principal', PRINCIPAL, '--kek', 'fixture-secret',
		])).toThrowError(X402ProvisioningError);
		expect(() => parseProvisionerArguments([
			'--provision-testnet-payer', '--principal', 'local-dev', '--owner', OWNER,
			'--merchant-pay-to', MERCHANT_PAY_TO,
		])).toThrowError(X402ProvisioningError);
	});

	it('rejects unsafe state before opening SQLite', async () => {
		const ensureState = vi.fn(() => { throw new Error('unsafe state'); });
		const findDatabase = vi.fn(() => '/must/not/be/read.sqlite');
		const openDatabase = vi.fn(() => { throw new Error('must not open'); });
		await expect(runProvisioner([
			'--provision-testnet-payer', '--principal', PRINCIPAL, '--owner', OWNER,
			'--merchant-pay-to', MERCHANT_PAY_TO,
		], { ensureState, findDatabase, openDatabase })).rejects.toMatchObject({
			code: 'PERSISTENCE_FAILED',
		});
		expect(ensureState).toHaveBeenCalledExactlyOnceWith(LOCAL_X402_STATE_ROOT);
		expect(findDatabase).not.toHaveBeenCalled();
		expect(openDatabase).not.toHaveBeenCalled();
	});

	it('accepts only a validated public account_info observation for the payer', () => {
		expect(fundingObservation({
			validated: true, account_data: { Account: PAYER, Balance: '12' }, ledger_index: 99,
		}, PAYER)).toEqual({ ledgerIndex: 99, balanceDrops: '12' });
		expect(() => fundingObservation({
			validated: true, account_data: { Account: OWNER, Balance: '12' }, ledger_index: 99,
		}, PAYER)).toThrowError(X402ProvisioningError);
		expect(() => fundingObservation({
			account_data: { Account: PAYER, Balance: '12' }, ledger_index: 99,
		}, PAYER)).toThrowError(X402ProvisioningError);
	});

	it('rejects non-owner-only local state and database files without changing their modes', () => {
		const directory = mkdtempSync(join(tmpdir(), 'harbor-x402-state-'));
		temporaryDirectories.push(directory);
		const database = join(directory, 'state.sqlite');
		writeFileSync(database, 'fixture', { mode: 0o600 });
		chmodSync(directory, 0o755);
		expect(() => assertOwnerOnlyPath(directory, 'directory')).toThrowError(X402ProvisioningError);
		expect(lstatSync(directory).mode & 0o777).toBe(0o755);
		chmodSync(directory, 0o700);
		chmodSync(database, 0o644);
		expect(() => assertOwnerOnlyPath(database, 'file')).toThrowError(X402ProvisioningError);
		expect(lstatSync(database).mode & 0o777).toBe(0o644);
	});

	it('rejects an unsafe nested state directory without changing its mode', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		writeFileSync(join(directory, 'candidate.sqlite'), 'not opened', { mode: 0o600 });
		const nested = join(directory, 'nested');
		mkdirSync(nested, { mode: 0o755 });
		chmodSync(nested, 0o755);
		const openReadOnlyDatabase = vi.fn(() => { throw new Error('must not open'); });

		expect(() => findLocalX402Database(directory, { openReadOnlyDatabase }))
			.toThrowError(X402ProvisioningError);
		expect(openReadOnlyDatabase).not.toHaveBeenCalled();
		expect(lstatSync(nested).mode & 0o777).toBe(0o755);
	});
});

const temporaryDirectories: string[] = [];

function privateWorkspaceDirectory(): string {
	const directory = realpathSync(mkdtempSync(join(REPO_ROOT, '.harbor-x402-provision-')));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local provisioning secret file', () => {
	it('creates an exclusive 0600 file, then reuses it without replacing credentials', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		let calls = 0;
		const first = ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: (size) => new Uint8Array(size).fill(++calls),
		});
		const original = readFileSync(path, 'utf8');
		const second = ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: () => { throw new Error('must not regenerate'); },
		});
		expect(second).toEqual(first);
		expect(readFileSync(path, 'utf8')).toBe(original);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(original).toContain('HARBOR_LOCAL_X402_RUNTIME_ENABLED=true');
		expect(original).toContain(`HARBOR_LOCAL_X402_MERCHANT_PAY_TO=${MERCHANT_PAY_TO}`);
		expect(first.merchantPayTo).toBe(MERCHANT_PAY_TO);
	});

	it('rejects a symlink and an existing file for another principal', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const target = join(directory, 'target');
		const linked = join(directory, 'linked');
		writeFileSync(target, 'fixture', { mode: 0o600 });
		symlinkSync(target, linked);
		expect(() => ensureLocalX402SecretFileAt(linked, PRINCIPAL, MERCHANT_PAY_TO))
			.toThrowError(LocalX402SecretFileError);

		const path = join(directory, 'harbor-local-x402.env.local');
		ensureLocalX402SecretFileAt(path, 'other-principal', MERCHANT_PAY_TO, {
			randomBytes: (size) => new Uint8Array(size).fill(7),
		});
		expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO))
			.toThrowError(LocalX402SecretFileError);
	});

	it('refuses to reuse an existing secret file for another merchant receiver', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: (size) => new Uint8Array(size).fill(9),
		});
		try {
			ensureLocalX402SecretFileAt(path, PRINCIPAL, OWNER);
			throw new Error('expected merchant mismatch');
		} catch (error) {
			expect(error).toMatchObject({ code: 'MERCHANT_MISMATCH' });
		}
	});

	it('rejects hard-linked and oversized existing secret files', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: (size) => new Uint8Array(size).fill(8),
		});
		const alias = join(directory, 'credential-alias');
		linkSync(path, alias);
		expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO))
			.toThrowError(LocalX402SecretFileError);
		rmSync(alias);

		writeFileSync(path, 'x'.repeat(LOCAL_X402_SECRET_MAX_BYTES + 1), { mode: 0o600 });
		expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO))
			.toThrowError(LocalX402SecretFileError);
	});

	it('recovers only the durable final file from a verified leftover staging link', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		const expected = ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: (size) => new Uint8Array(size).fill(6),
		});
		const staging = `${path}.${'A'.repeat(24)}.tmp`;
		linkSync(path, staging);
		expect(lstatSync(path).nlink).toBe(2);

		expect(ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO)).toEqual(expected);
		expect(existsSync(staging)).toBe(false);
		expect(lstatSync(path).nlink).toBe(1);
	});

	it.each([
		['one', ['A']],
		['multiple', ['A', 'B']],
	] as const)('rejects %s orphaned staging entries before generating or changing credentials', (_case, suffixes) => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		const unrelated = join(directory, 'unrelated');
		writeFileSync(unrelated, 'unrelated', { mode: 0o600 });
		const staged = suffixes.map((suffix) => {
			const stagingPath = `${path}.${suffix.repeat(24)}.tmp`;
			writeFileSync(stagingPath, `staged-${suffix}`, { mode: 0o600 });
			return stagingPath;
		});
		const generate = vi.fn(() => { throw new Error('must not generate'); });

		expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: generate,
		})).toThrowError(LocalX402SecretFileError);
		expect(generate).not.toHaveBeenCalled();
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(unrelated, 'utf8')).toBe('unrelated');
		for (const [index, stagingPath] of staged.entries()) {
			expect(readFileSync(stagingPath, 'utf8')).toBe(`staged-${suffixes[index]}`);
			expect(lstatSync(stagingPath).nlink).toBe(1);
		}
	});

	it('does not recover or unlink when a second staging-shaped entry is present', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: (size) => new Uint8Array(size).fill(5),
		});
		const original = readFileSync(path, 'utf8');
		const linkedStage = `${path}.${'A'.repeat(24)}.tmp`;
		const unrelatedStage = `${path}.${'B'.repeat(24)}.tmp`;
		linkSync(path, linkedStage);
		writeFileSync(unrelatedStage, 'unrelated', { mode: 0o600 });

		expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO))
			.toThrowError(LocalX402SecretFileError);
		expect(readFileSync(path, 'utf8')).toBe(original);
		expect(readFileSync(linkedStage, 'utf8')).toBe(original);
		expect(readFileSync(unrelatedStage, 'utf8')).toBe('unrelated');
		expect(lstatSync(path).nlink).toBe(2);
	});

	it.each(['file', 'parent'] as const)(
		'never leaves a permanent or staged secret after a %s fsync failure',
		(stage) => {
			const directory = privateWorkspaceDirectory();
			chmodSync(directory, 0o700);
			const path = join(directory, 'harbor-local-x402.env.local');
			let calls = 0;
			expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
				randomBytes: (size) => new Uint8Array(size).fill(4),
				fsyncSync: (descriptor) => {
					calls += 1;
					if ((stage === 'file' && calls === 1) || (stage === 'parent' && calls === 2)) {
						throw new Error('simulated fsync failure');
					}
					fsyncSync(descriptor);
				},
			})).toThrowError(LocalX402SecretFileError);
			expect(existsSync(path)).toBe(false);
			expect(readdirSync(directory)).toEqual([]);
		},
	);

	it('does not follow a pre-created staging symlink or a symlinked parent', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const path = join(directory, 'harbor-local-x402.env.local');
		const target = join(directory, 'target');
		writeFileSync(target, 'unchanged', { mode: 0o600 });
		let calls = 0;
		expect(() => ensureLocalX402SecretFileAt(path, PRINCIPAL, MERCHANT_PAY_TO, {
			randomBytes: (size) => {
				calls += 1;
				const bytes = new Uint8Array(size).fill(calls);
				if (calls === 3) {
					const suffix = Buffer.from(bytes).toString('base64')
						.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
					symlinkSync(target, `${path}.${suffix}.tmp`);
				}
				return bytes;
			},
		})).toThrowError(LocalX402SecretFileError);
		expect(readFileSync(target, 'utf8')).toBe('unchanged');
		expect(existsSync(path)).toBe(false);

		const realParent = join(directory, 'real-parent');
		const linkedParent = join(directory, 'linked-parent');
		mkdirSync(realParent, { mode: 0o700 });
		symlinkSync(realParent, linkedParent);
		expect(() => ensureLocalX402SecretFileAt(
			join(linkedParent, 'secret'), PRINCIPAL, MERCHANT_PAY_TO,
		)).toThrowError(LocalX402SecretFileError);
		expect(existsSync(join(realParent, 'secret'))).toBe(false);
	});

	it('rejects a directory writable by another user anywhere in the canonical parent chain', () => {
		const directory = privateWorkspaceDirectory();
		chmodSync(directory, 0o700);
		const ancestor = join(directory, 'ancestor');
		const parent = join(ancestor, 'secrets');
		mkdirSync(ancestor, { mode: 0o700 });
		mkdirSync(parent, { mode: 0o700 });
		chmodSync(ancestor, 0o770);

		expect(() => ensureLocalX402SecretFileAt(
			join(parent, 'harbor-local-x402.env.local'), PRINCIPAL, MERCHANT_PAY_TO,
		)).toThrowError(LocalX402SecretFileError);
		expect(readdirSync(parent)).toEqual([]);
	});
});
