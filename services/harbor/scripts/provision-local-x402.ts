#!/usr/bin/env -S node --experimental-transform-types

import { readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { XrplRpcError, createXrplRpc } from '../src/adapters/xrpl-rpc.ts';
import { createWrappedDelegateKey, fundDelegateAccount } from '../src/exec/keys.ts';
import {
	ensureLocalX402SecretFile,
	readLocalX402SecretFile,
} from '../src/exec/x402-local-secret-file.ts';
import { X402PayerStore } from '../src/exec/x402-payer-store.ts';
import {
	X402ProvisioningError,
	provisionLocalX402Payer,
	type X402FundingObservation,
} from '../src/exec/x402-provisioner.ts';
import {
	assertLocalX402StatePath,
	ensureLocalX402StateDirectory,
	validateLocalX402StateTree,
} from './local-x402-state.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_X402_STATE_ROOT = join(REPO_ROOT, '.wrangler', 'harbor-local-x402');
const REQUIRED_COLUMNS = new Set([
	'principal', 'owner', 'network', 'payer', 'public_key', 'ciphertext', 'iv', 'status',
	'funded_ledger_index', 'funded_balance_drops', 'faucet_requested_at', 'funding_checked_at',
	'created_at', 'updated_at',
]);

export function assertOwnerOnlyPath(path: string, kind: 'directory' | 'file'): void {
	try {
		assertLocalX402StatePath(path, kind);
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
}

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
	async first<T>(): Promise<T | null> {
		return (this.statement.get(...this.values) as T | undefined) ?? null;
	}
}

class LocalD1 {
	constructor(readonly sqlite: DatabaseSync) {}
	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.sqlite.prepare(sql));
	}
}

function candidates(directory: string): string[] {
	assertOwnerOnlyPath(directory, 'directory');
	const paths: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...candidates(path));
		} else if (entry.isFile()) {
			assertOwnerOnlyPath(path, 'file');
			if (extname(entry.name) === '.sqlite') paths.push(path);
		} else {
			throw new X402ProvisioningError('PERSISTENCE_FAILED');
		}
	}
	return paths;
}

function hasProvisioningSchema(
	path: string,
	openReadOnlyDatabase = (databasePath: string) => new DatabaseSync(databasePath, { readOnly: true }),
): boolean {
	let database: DatabaseSync | undefined;
	try {
		assertOwnerOnlyPath(path, 'file');
		database = openReadOnlyDatabase(path);
		const rows = database.prepare('PRAGMA table_info(x402_payers)').all() as Array<{ name: string }>;
		const names = new Set(rows.map(({ name }) => name));
		return REQUIRED_COLUMNS.size === names.size && [...REQUIRED_COLUMNS].every((name) => names.has(name));
	} catch {
		return false;
	} finally {
		database?.close();
	}
}

/** Internal test seam; production callers always use the fixed local state root. */
export function findLocalX402Database(
	stateRoot = LOCAL_X402_STATE_ROOT,
	{
		openReadOnlyDatabase = (path: string) => new DatabaseSync(path, { readOnly: true }),
	} = {},
): string {
	let matches: string[];
	try {
		validateLocalX402StateTree(stateRoot);
		matches = candidates(stateRoot).filter((path) => hasProvisioningSchema(path, openReadOnlyDatabase));
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
	if (matches.length !== 1) throw new X402ProvisioningError('PERSISTENCE_FAILED');
	return matches[0];
}

export function parseProvisionerArguments(args: readonly string[]): {
	principal: string;
	owner: string;
	merchantPayTo: string;
} {
	if (args.length !== 7 || args[0] !== '--provision-testnet-payer') {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
	const fields = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (
			(name !== '--principal' && name !== '--owner' && name !== '--merchant-pay-to') ||
			fields.has(name) || value === undefined
		) {
			throw new X402ProvisioningError('INVALID_INPUT');
		}
		fields.set(name, value);
	}
	const principal = fields.get('--principal');
	const owner = fields.get('--owner');
	const merchantPayTo = fields.get('--merchant-pay-to');
	if (
		principal === undefined || principal === 'local-dev' ||
		owner === undefined || merchantPayTo === undefined
	) {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
	return { principal, owner, merchantPayTo };
}

export function fundingObservation(result: Record<string, unknown>, payer: string): X402FundingObservation {
	const account = result.account_data;
	if (typeof account !== 'object' || account === null || Array.isArray(account)) {
		throw new X402ProvisioningError('FUNDING_READ_FAILED');
	}
	const data = account as Record<string, unknown>;
	if (
		result.validated !== true || data.Account !== payer ||
		typeof data.Balance !== 'string' || !/^(0|[1-9][0-9]*)$/.test(data.Balance) ||
		typeof result.ledger_index !== 'number' || !Number.isSafeInteger(result.ledger_index) || result.ledger_index < 1
	) throw new X402ProvisioningError('FUNDING_READ_FAILED');
	return { ledgerIndex: result.ledger_index, balanceDrops: data.Balance };
}

export async function runProvisioner(
	args: readonly string[],
	{
		ensureState = ensureLocalX402StateDirectory,
		findDatabase = findLocalX402Database,
		openDatabase = (path: string) => new DatabaseSync(path),
	} = {},
): Promise<void> {
	const { principal, owner, merchantPayTo } = parseProvisionerArguments(args);
	try {
		ensureState(LOCAL_X402_STATE_ROOT);
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
	const database = openDatabase(findDatabase());
	try {
		const localD1 = new LocalD1(database);
		const store = new X402PayerStore(localD1 as unknown as D1Database, principal);
		// Check the durable binding before creating any credentials or key material.
		const existing = await store.get(owner, 'testnet');
		// A missing KEK must never be replaced underneath an existing ciphertext.
		const secrets = existing === null
			? ensureLocalX402SecretFile(principal, merchantPayTo)
			: readLocalX402SecretFile(principal, merchantPayTo);
		const rpc = createXrplRpc({ retries: 0 });
		const result = await provisionLocalX402Payer(principal, owner, merchantPayTo, {
			store,
			createWrappedKey: () => createWrappedDelegateKey({ principal, owner, network: 'testnet' }, secrets.kek),
			requestTestnetFaucet: async (payer) => { await fundDelegateAccount(payer, 'testnet'); },
			readValidatedFunding: async (payer) => {
				try {
					return fundingObservation(await rpc.request('testnet', 'account_info', {
						account: payer,
						ledger_index: 'validated',
						strict: true,
					}), payer);
				} catch (error) {
					if (error instanceof XrplRpcError && error.kind === 'soft-empty') return null;
					throw error;
				}
			},
			now: () => new Date(),
		});
		// Result fields are deliberately public identity and ledger metadata only.
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} finally {
		database.close();
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runProvisioner(process.argv.slice(2)).catch((error: unknown) => {
		const code = error instanceof X402ProvisioningError ? error.code : 'LOCAL_PROVISIONING_FAILED';
		process.stderr.write(`Local x402 payer provisioning failed (${code}).\n`);
		process.exitCode = 1;
	});
}
