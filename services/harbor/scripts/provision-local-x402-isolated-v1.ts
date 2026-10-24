#!/usr/bin/env -S node --experimental-transform-types

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isValidClassicAddress } from 'xrpl';

import { XrplRpcError, createXrplRpc } from '../src/adapters/xrpl-rpc.ts';
import { createWrappedDelegateKey, fundDelegateAccount } from '../src/exec/keys.ts';
import {
	inspectExistingIsolatedX402Secrets,
	IsolatedX402SecretFileError,
	materializeIsolatedX402Secrets,
	type IsolatedX402SecretInspection,
	type IsolatedX402Secrets,
} from '../src/exec/x402-isolated-secret-file.ts';
import { X402PayerStore } from '../src/exec/x402-payer-store.ts';
import { readTradingDelegateEvidence } from '../src/exec/x402-trading-delegate-evidence.ts';
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from '../src/local-x402-isolated-v1.ts';
import {
	X402ProvisioningError,
	provisionLocalX402Payer,
	type X402FundingObservation,
	type X402ProvisioningDependencies,
	type X402ProvisioningResult,
} from '../src/exec/x402-provisioner.ts';
import { runCommand } from './dev-local.mjs';
import { validateIsolatedTradingSecretFile } from './dev-local-trading-isolated-v1.mjs';
import {
	isolatedX402ChildEnvironment,
	isolatedX402MigrationCommand,
	validateIsolatedX402ConfigurationFile,
	validateIsolatedX402MigrationCommand,
} from './dev-local-x402-isolated-v1.mjs';
import {
	acquireIsolatedX402StateLease,
	initializeIsolatedX402StateDirectory,
	validateConfiguredIsolatedX402StateRoot,
	validateExistingIsolatedX402State,
	validateIsolatedX402StateLayout,
	writeIsolatedX402StateMarker,
} from './local-x402-isolated-state.mjs';
import { fundingObservation } from './provision-local-x402.ts';
import { validateIsolatedMigrationProfile } from './isolated-migration-profiles.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ISOLATED_X402_MIN_FUNDING_DROPS = 2_100_100n;
export const ISOLATED_X402_MAX_FUNDING_DROPS = 1_000_000_000n;
const PRINCIPAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export type IsolatedX402StateMode = 'initialize' | 'resume';

export function parseIsolatedProvisionerArguments(args: readonly string[]): {
	principal: string;
	tradingPrincipal: string;
	owner: string;
	merchantPayTo: string;
	tradingDelegate: string;
	stateMode: IsolatedX402StateMode;
	stateRoot: string;
} {
	if (args.length !== 15 || args[0] !== '--provision-testnet-payer') {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
	const allowed = new Set([
		'--principal', '--trading-principal', '--owner', '--merchant-pay-to',
		'--trading-delegate', '--state-mode', '--state-root',
	]);
	const fields = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!allowed.has(name) || fields.has(name) || value === undefined) {
			throw new X402ProvisioningError('INVALID_INPUT');
		}
		fields.set(name, value);
	}
	const principal = fields.get('--principal');
	const tradingPrincipal = fields.get('--trading-principal');
	const owner = fields.get('--owner');
	const merchantPayTo = fields.get('--merchant-pay-to');
	const tradingDelegate = fields.get('--trading-delegate');
	const stateMode = fields.get('--state-mode');
	const stateRoot = fields.get('--state-root');
	if (
		principal === undefined || !PRINCIPAL_NAME.test(principal) || principal === 'local-dev' ||
		tradingPrincipal === undefined || !PRINCIPAL_NAME.test(tradingPrincipal) ||
		tradingPrincipal === 'local-dev' || tradingPrincipal === principal ||
		owner === undefined || !isValidClassicAddress(owner) ||
		merchantPayTo === undefined || !isValidClassicAddress(merchantPayTo) ||
		merchantPayTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO ||
		tradingDelegate === undefined || !isValidClassicAddress(tradingDelegate) ||
		tradingDelegate === owner || tradingDelegate === merchantPayTo ||
		(stateMode !== 'initialize' && stateMode !== 'resume') ||
		stateRoot === undefined || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot ||
		stateRoot.trim() !== stateRoot ||
		/[\r\n\0]/u.test(stateRoot)
	) throw new X402ProvisioningError('INVALID_INPUT');
	return {
		principal,
		tradingPrincipal,
		owner,
		merchantPayTo,
		tradingDelegate,
		stateMode,
		stateRoot,
	};
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

export function isolatedFundingObservation(
	result: Record<string, unknown>,
	payer: string,
): X402FundingObservation {
	const observation = fundingObservation(result, payer);
	const balance = BigInt(observation.balanceDrops);
	if (
		balance < ISOLATED_X402_MIN_FUNDING_DROPS ||
		balance > ISOLATED_X402_MAX_FUNDING_DROPS
	) throw new X402ProvisioningError('FUNDING_READ_FAILED');
	return observation;
}

type StatePreparationDependencies = {
	validateConfigurationFile: (repoRoot: string) => Promise<void>;
	validateMigrationProfile: (repoRoot: string) => Promise<unknown>;
	validateConfiguredRoot: (stateRoot: string, options: { repoRoot: string }) => Promise<string>;
	initializeStateDirectory: (stateRoot: string) => Promise<string>;
	migrationCommand: (repoRoot: string, stateRoot: string) => ReturnType<typeof isolatedX402MigrationCommand>;
	validateMigrationCommand: typeof validateIsolatedX402MigrationCommand;
	acquireStateLease: typeof acquireIsolatedX402StateLease;
	childEnvironment: (
		source: NodeJS.ProcessEnv,
		stateRoot: string,
	) => ReturnType<typeof isolatedX402ChildEnvironment>;
	runMigration: typeof runCommand;
	validateStateLayout: (stateRoot: string) => Promise<{ databasePath: string }>;
	writeStateMarker: (stateRoot: string) => Promise<string>;
	validateExistingState: (stateRoot: string) => Promise<{ databasePath: string }>;
};

const statePreparationDependencies: StatePreparationDependencies = {
	validateConfigurationFile: validateIsolatedX402ConfigurationFile,
	validateMigrationProfile: (repoRoot) =>
		validateIsolatedMigrationProfile(repoRoot, 'x402-isolated-v1'),
	validateConfiguredRoot: validateConfiguredIsolatedX402StateRoot,
	initializeStateDirectory: initializeIsolatedX402StateDirectory,
	migrationCommand: isolatedX402MigrationCommand,
	validateMigrationCommand: validateIsolatedX402MigrationCommand,
	acquireStateLease: acquireIsolatedX402StateLease,
	childEnvironment: isolatedX402ChildEnvironment,
	runMigration: runCommand,
	validateStateLayout: validateIsolatedX402StateLayout,
	writeStateMarker: writeIsolatedX402StateMarker,
	validateExistingState: validateExistingIsolatedX402State,
};

/** Initialize once or validate an exact existing isolated state contract. */
export async function prepareIsolatedX402ProvisioningState(
	stateMode: IsolatedX402StateMode,
	stateRoot: string,
	dependencies: StatePreparationDependencies = statePreparationDependencies,
): Promise<{ databasePath: string; release: () => Promise<void> }> {
	let lease: Awaited<ReturnType<typeof acquireIsolatedX402StateLease>> | undefined;
	try {
		await dependencies.validateConfigurationFile(REPO_ROOT);
		await dependencies.validateMigrationProfile(REPO_ROOT);
		await dependencies.validateConfiguredRoot(stateRoot, { repoRoot: REPO_ROOT });
		if (stateMode === 'resume') {
			lease = await dependencies.acquireStateLease(stateRoot);
			const { databasePath } = await dependencies.validateExistingState(stateRoot);
			return { databasePath, release: () => lease!.release() };
		}
		const migration = dependencies.migrationCommand(REPO_ROOT, stateRoot);
		dependencies.validateMigrationCommand(migration, REPO_ROOT, stateRoot);
		const environment = dependencies.childEnvironment(process.env, stateRoot);
		await dependencies.initializeStateDirectory(stateRoot);
		lease = await dependencies.acquireStateLease(stateRoot);
		await dependencies.validateMigrationProfile(REPO_ROOT);
		await dependencies.runMigration(
			migration,
			environment,
		);
		await dependencies.validateStateLayout(stateRoot);
		await dependencies.writeStateMarker(stateRoot);
		const { databasePath } = await dependencies.validateExistingState(stateRoot);
		return { databasePath, release: () => lease!.release() };
	} catch {
		await lease?.release().catch(() => undefined);
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
}

type ProvisionDatabase = { close(): void };

export function assertFreshIsolatedX402CredentialState(database: DatabaseSync): void {
	try {
		const row = database.prepare(`SELECT
			(SELECT COUNT(*) FROM x402_payers) AS payer_count,
			(SELECT COUNT(*) FROM x402_payments) AS payment_count`).get() as
			| { payer_count: number | bigint; payment_count: number | bigint }
			| undefined;
		if (
			row === undefined || Number(row.payer_count) !== 0 || Number(row.payment_count) !== 0
		) throw new Error('persisted x402 authority exists');
	} catch {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
}

type IsolatedProvisionerOverrides = {
	prepareState?: (
		stateMode: IsolatedX402StateMode,
		stateRoot: string,
	) => Promise<{ databasePath: string; release: () => Promise<void> }>;
	openDatabase?: (path: string) => ProvisionDatabase;
	inspectExistingSecrets?: (
		principal: string,
		merchantPayTo: string,
		stateRoot: string,
	) => IsolatedX402SecretInspection | null;
	readTradingPrincipal?: () => Promise<string>;
	validateCredentialCreationState?: (database: ProvisionDatabase) => void;
	materializeSecrets?: (
		principal: string,
		merchantPayTo: string,
		stateRoot: string,
	) => IsolatedX402Secrets;
	createStore?: (database: ProvisionDatabase, principal: string) => X402ProvisioningDependencies['store'];
	provisionPayer?: typeof provisionLocalX402Payer;
	createWrappedKey?: X402ProvisioningDependencies['createWrappedKey'];
	requestTestnetFaucet?: X402ProvisioningDependencies['requestTestnetFaucet'];
	readValidatedFunding?: X402ProvisioningDependencies['readValidatedFunding'];
	now?: () => Date;
	writeResult?: (result: X402ProvisioningResult) => void;
	validateTradingDelegateEvidence?: (owner: string, delegate: string) => void | Promise<void>;
};

export async function runIsolatedX402Provisioner(
	args: readonly string[],
	overrides: IsolatedProvisionerOverrides = {},
): Promise<void> {
	const {
		principal, tradingPrincipal, owner, merchantPayTo, tradingDelegate, stateMode, stateRoot,
	} =
		parseIsolatedProvisionerArguments(args);
	let boundTradingPrincipal: string;
	try {
		const resolvedPrincipal = await (
			overrides.readTradingPrincipal ?? (async () => {
				const values = await validateIsolatedTradingSecretFile();
				return values.HARBOR_API_KEYS.slice(0, values.HARBOR_API_KEYS.indexOf(':'));
			})
		)();
		boundTradingPrincipal = resolvedPrincipal;
	} catch {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
	if (boundTradingPrincipal !== tradingPrincipal || boundTradingPrincipal === principal) {
		throw new X402ProvisioningError('INVALID_INPUT');
	}
	const existing = (overrides.inspectExistingSecrets ?? inspectExistingIsolatedX402Secrets)(
		principal,
		merchantPayTo,
		stateRoot,
	);
	if (stateMode === 'initialize' && existing !== null) {
		throw new X402ProvisioningError('PERSISTENCE_FAILED');
	}
	await (overrides.validateTradingDelegateEvidence ?? ((selectedOwner, selectedDelegate) =>
		readTradingDelegateEvidence({ owner: selectedOwner, delegate: selectedDelegate })))(
		owner,
		tradingDelegate,
	);
	const prepared = await (overrides.prepareState ?? prepareIsolatedX402ProvisioningState)(
		stateMode,
		stateRoot,
	);
	let result: X402ProvisioningResult;
	try {
		const database = (overrides.openDatabase ?? ((path) => new DatabaseSync(path)))(
			prepared.databasePath,
		);
		try {
			if (existing === null) {
				(overrides.validateCredentialCreationState ?? ((value) =>
					assertFreshIsolatedX402CredentialState(value as DatabaseSync)))(database);
			}
			const secrets = (overrides.materializeSecrets ?? materializeIsolatedX402Secrets)(
				principal,
				merchantPayTo,
				stateRoot,
			);
			if (existing !== null && (
				secrets.apiCredential !== existing.secrets.apiCredential ||
				secrets.kek !== existing.secrets.kek ||
				secrets.merchantPayTo !== existing.secrets.merchantPayTo ||
				secrets.stateRoot !== existing.secrets.stateRoot
			)) throw new X402ProvisioningError('PERSISTENCE_FAILED');
			const createStore = overrides.createStore ?? ((db, selectedPrincipal) =>
				new X402PayerStore(
					new LocalD1(db as DatabaseSync) as unknown as D1Database,
					selectedPrincipal,
				));
			result = await (overrides.provisionPayer ?? provisionLocalX402Payer)(
				principal,
				owner,
				merchantPayTo,
				{
					store: createStore(database, principal),
					createWrappedKey: overrides.createWrappedKey ?? (() =>
						createWrappedDelegateKey(
							{ principal, owner, network: 'testnet' },
							secrets.kek,
						)),
					requestTestnetFaucet: overrides.requestTestnetFaucet ?? (async (payer) => {
						await fundDelegateAccount(payer, 'testnet');
					}),
					readValidatedFunding: overrides.readValidatedFunding ?? (async (payer) => {
						const rpc = createXrplRpc({ retries: 0 });
						try {
							return isolatedFundingObservation(await rpc.request('testnet', 'account_info', {
								account: payer,
								ledger_index: 'validated',
								strict: true,
							}), payer);
						} catch (error) {
							if (error instanceof XrplRpcError && error.kind === 'soft-empty') return null;
							throw error;
						}
					}),
					now: overrides.now ?? (() => new Date()),
					forbiddenPayerAddresses: [tradingDelegate],
				},
			);
		} finally {
			database.close();
		}
	} finally {
		await prepared.release();
	}
	(overrides.writeResult ?? ((value) => {
		process.stdout.write(`${JSON.stringify(value)}\n`);
	}))(result);
}

export function isolatedProvisioningErrorMessage(error: unknown): string {
	const code = error instanceof X402ProvisioningError ||
		error instanceof IsolatedX402SecretFileError
		? error.code
		: 'LOCAL_ISOLATED_PROVISIONING_FAILED';
	return `Local isolated x402 payer provisioning failed (${code}).`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runIsolatedX402Provisioner(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`${isolatedProvisioningErrorMessage(error)}\n`);
		process.exitCode = 1;
	});
}
