import {
	chmodSync,
	existsSync,
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
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	ISOLATED_X402_MAX_FUNDING_DROPS,
	ISOLATED_X402_MIN_FUNDING_DROPS,
	assertFreshIsolatedX402CredentialState,
	isolatedFundingObservation,
	isolatedProvisioningErrorMessage,
	parseIsolatedProvisionerArguments,
	prepareIsolatedX402ProvisioningState,
	runIsolatedX402Provisioner,
} from '../scripts/provision-local-x402-isolated-v1';
import {
	LOCAL_X402_ISOLATED_SECRET_FILE,
	PILOT_X402_ISOLATED_CAPABILITY_FILE,
	IsolatedX402SecretFileError,
	inspectExistingIsolatedX402SecretsAt,
	materializeIsolatedX402SecretsAt,
} from '../src/exec/x402-isolated-secret-file';
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from '../src/local-x402-isolated-v1';
import {
	provisionLocalX402Payer,
	X402ProvisioningError,
} from '../src/exec/x402-provisioner';
import { validateMacAclResult } from '../src/exec/trading-local-secret-file';
import { validateTradingDelegateEvidence } from '../src/exec/x402-trading-delegate-evidence';

const PRINCIPAL = 'isolated-x402';
const TRADING_PRINCIPAL = 'isolated-trading';
const OWNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const MERCHANT = LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
const OTHER_VALID_MERCHANT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59';
const PAYER = 'rDNPy1xcB9PJoNZyG1u36Whd1rboH6Go9D';
const TRADING_DELEGATE = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const REPO_ROOT = realpathSync(process.cwd());
const temporaryDirectories: string[] = [];
type MaterializeDependencies = NonNullable<
	Parameters<typeof materializeIsolatedX402SecretsAt>[5]
>;

/**
 * Portable filesystem fixtures exercise path and publication invariants with
 * explicit empty-ACL results. Production callers retain the native Darwin
 * inspectors, which remain fail-closed on unsupported platforms.
 */
function materializePortable(
	harbor: string,
	pilot: string,
	principal = PRINCIPAL,
	merchant = MERCHANT,
	stateRoot = join(dirname(harbor), 'isolated-state'),
	dependencies: MaterializeDependencies = {
		randomBytes: (size) => new Uint8Array(size).fill(7),
	},
) {
	return materializeIsolatedX402SecretsAt(
		harbor,
		pilot,
		principal,
		merchant,
		stateRoot,
		{
			assertAcl: () => undefined,
			assertAclFd: () => undefined,
			...dependencies,
		},
	);
}

function inspectPortable(
	harbor: string,
	pilot: string,
	stateRoot: string,
) {
	return inspectExistingIsolatedX402SecretsAt(
		harbor,
		pilot,
		PRINCIPAL,
		MERCHANT,
		stateRoot,
		{ assertAcl: () => undefined },
	);
}

function provisionerArguments(
	stateRoot: string,
	stateMode: 'initialize' | 'resume' = 'initialize',
): string[] {
	return [
		'--provision-testnet-payer', '--principal', PRINCIPAL,
		'--trading-principal', TRADING_PRINCIPAL,
		'--owner', OWNER, '--merchant-pay-to', MERCHANT,
		'--trading-delegate', TRADING_DELEGATE,
		'--state-mode', stateMode, '--state-root', stateRoot,
	];
}

function reviewedTradingEvidence(
	owner = OWNER,
	delegate = TRADING_DELEGATE,
): Record<string, unknown> {
	return {
		account_status: {
			owner,
			network: 'testnet',
			delegate,
			permissions: [
				'OfferCreate', 'OfferCancel', 'TrustSet', 'AMMDeposit',
				'AMMWithdraw', 'EscrowFinish', 'CheckCash',
			],
			status: 'active',
		},
		onboarding_readiness: {
			ready: true,
			scope: { owner, network: 'testnet' },
			checks: {
				reviewed_runtime: true,
				exact_active_link: true,
				exact_persisted_policy: true,
				usable_encrypted_delegate: true,
				validated_trust_set: true,
				usable_trust_line: true,
			},
			evidence: {
				delegate,
				link_ledger_index: 801,
				trust_set_hash: 'A'.repeat(64),
				trust_set_ledger_index: 802,
				trust_line_ledger_index: 803,
			},
		},
	};
}

function privateDirectory(): string {
	const directory = realpathSync(mkdtempSync(join(REPO_ROOT, '.isolated-x402-secrets-')));
	chmodSync(directory, 0o700);
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('isolated x402 credential materialization', () => {
	it('uses the accepted native ACL classifications for safe and granting fixtures', () => {
		expect(() => validateMacAclResult('EMPTY\n', 'private')).not.toThrow();
		expect(() => validateMacAclResult('DENY_ONLY\n', 'ancestor')).not.toThrow();
		expect(() => validateMacAclResult('ACCESS_GRANTING\n', 'private')).toThrow();
		expect(() => validateMacAclResult('ACCESS_GRANTING\n', 'ancestor')).toThrow();
	});

	it('rejects granting parent or inode ACL fixtures before generating secrets', () => {
		for (const rejectAt of ['parent', 'inode'] as const) {
			const directory = privateDirectory();
			const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
			const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
			const randomBytes = vi.fn(() => new Uint8Array(32));
			expect(() => materializeIsolatedX402SecretsAt(
				harbor,
				pilot,
				PRINCIPAL,
				MERCHANT,
				join(directory, 'state'),
				{
					randomBytes,
					assertAcl: () => {
						if (rejectAt === 'parent') throw new Error('ACCESS_GRANTING');
					},
					assertAclFd: () => {
						if (rejectAt === 'inode') throw new Error('ACCESS_GRANTING');
					},
				},
			)).toThrowError(IsolatedX402SecretFileError);
			expect(randomBytes).not.toHaveBeenCalled();
			expect(existsSync(harbor)).toBe(false);
			expect(existsSync(pilot)).toBe(false);
		}
	});

	it('fails closed when native ACL inspection is unavailable before generating secrets', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		const randomBytes = vi.fn(() => new Uint8Array(32));
		try {
			materializeIsolatedX402SecretsAt(
				harbor,
				pilot,
				PRINCIPAL,
				MERCHANT,
				join(directory, 'state'),
				{
					randomBytes,
					assertAcl: () => { throw new Error('UNSUPPORTED_PLATFORM'); },
					assertAclFd: () => undefined,
				},
			);
			throw new Error('expected unsupported ACL inspection to fail closed');
		} catch (error) {
			expect(error).toBeInstanceOf(IsolatedX402SecretFileError);
			expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
		}
		expect(randomBytes).not.toHaveBeenCalled();
		expect(existsSync(harbor)).toBe(false);
		expect(existsSync(pilot)).toBe(false);
	});

	it.runIf(process.platform === 'darwin')(
		'rejects an inherited everyone-allow ACL without creating fixture secrets',
		() => {
			const root = privateDirectory();
			const parent = join(root, 'granting-parent');
			const directory = join(parent, 'secrets');
			mkdirSync(parent, { mode: 0o700 });
			try {
				execFileSync('/bin/chmod', [
					'+a', 'everyone allow read,file_inherit,directory_inherit', parent,
				]);
				mkdirSync(directory, { mode: 0o700 });
				const randomBytes = vi.fn(() => new Uint8Array(32));
				expect(() => materializeIsolatedX402SecretsAt(
					join(directory, 'harbor-local-x402-isolated-v1.env.local'),
					join(directory, 'pilot-isolated-x402-capability-v1.env.local'),
					PRINCIPAL,
					MERCHANT,
					join(root, 'state'),
					{ randomBytes },
				)).toThrowError(IsolatedX402SecretFileError);
				expect(randomBytes).not.toHaveBeenCalled();
				expect(readdirSync(directory)).toEqual([]);
			} finally {
				execFileSync('/bin/chmod', ['-RN', parent]);
			}
		},
	);

	it('creates fixed-shape Harbor and capability files without links or overwrite', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		let calls = 0;
		const first = materializePortable(
			harbor,
			pilot,
			PRINCIPAL,
			MERCHANT,
			join(directory, 'state'),
			{ randomBytes: (size) => new Uint8Array(size).fill(++calls) },
		);
		const harborContents = readFileSync(harbor, 'utf8');
		const pilotContents = readFileSync(pilot, 'utf8');
		const harborIdentity = lstatSync(harbor);
		const pilotIdentity = lstatSync(pilot);
		expect(harborIdentity.nlink).toBe(1);
		expect(pilotIdentity.nlink).toBe(1);
		expect(harborIdentity.mode & 0o777).toBe(0o600);
		expect(pilotIdentity.mode & 0o777).toBe(0o600);
		expect(harborContents).toContain('HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED=true');
		expect(harborContents).toContain('HARBOR_LOCAL_X402_SIGNING_PROFILE=reviewed-testnet-isolated-v1');
		expect(harborContents).toContain(
			`HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT=${join(directory, 'state')}`,
		);
		expect(first.stateRoot).toBe(join(directory, 'state'));
		expect(pilotContents).toBe(`HARBOR_X402_API_KEY=${first.apiCredential}\n`);
		expect(pilotContents).not.toMatch(/KEK|SESSION_SECRET|HARBOR_API_KEY=/u);

		const second = materializePortable(
			harbor,
			pilot,
			PRINCIPAL,
			MERCHANT,
			join(directory, 'state'),
			{ randomBytes: () => { throw new Error('must not regenerate'); } },
		);
		expect(second).toEqual(first);
		expect(readFileSync(harbor, 'utf8')).toBe(harborContents);
		expect(readFileSync(pilot, 'utf8')).toBe(pilotContents);
		expect(lstatSync(harbor).ino).toBe(harborIdentity.ino);
		expect(lstatSync(pilot).ino).toBe(pilotIdentity.ino);
	});

	it('rejects injected or non-canonical state roots before credential publication', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		for (const stateRoot of [
			'relative/state',
			`${join(directory, 'state')}/..`,
			`${join(directory, 'state')} `,
			`${join(directory, 'state')}\nHARBOR_KEK=attacker`,
			`${join(directory, 'state')}\0suffix`,
		]) {
			const randomBytes = vi.fn(() => new Uint8Array(32));
			try {
				materializePortable(
					harbor,
					pilot,
					PRINCIPAL,
					MERCHANT,
					stateRoot,
					{ randomBytes },
				);
				throw new Error('expected unsafe root rejection');
			} catch (error) {
				expect(error).toBeInstanceOf(IsolatedX402SecretFileError);
				expect(error).toMatchObject({ code: 'STATE_ROOT_MISMATCH' });
			}
			expect(randomBytes).not.toHaveBeenCalled();
			expect(existsSync(harbor)).toBe(false);
			expect(existsSync(pilot)).toBe(false);
		}
	});

	it('rejects a different valid merchant before credential publication', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		const randomBytes = vi.fn(() => new Uint8Array(32));
		try {
			materializePortable(
				harbor,
				pilot,
				PRINCIPAL,
				OTHER_VALID_MERCHANT,
				join(directory, 'state'),
				{ randomBytes },
			);
			throw new Error('expected merchant mismatch');
		} catch (error) {
			expect(error).toBeInstanceOf(IsolatedX402SecretFileError);
			expect(error).toMatchObject({ code: 'MERCHANT_MISMATCH' });
		}
		expect(randomBytes).not.toHaveBeenCalled();
		expect(existsSync(harbor)).toBe(false);
		expect(existsSync(pilot)).toBe(false);
	});

	it('preflights an exact credential pair and rejects a different bound root', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		const stateRoot = join(directory, 'state-a');
		expect(inspectPortable(harbor, pilot, stateRoot)).toBeNull();
		const created = materializePortable(harbor, pilot, PRINCIPAL, MERCHANT, stateRoot);
		expect(inspectPortable(harbor, pilot, stateRoot)).toEqual({
			secrets: created,
			pilotCapabilityPresent: true,
		});
		try {
			inspectPortable(harbor, pilot, join(directory, 'state-b'));
			throw new Error('expected root mismatch');
		} catch (error) {
			expect(error).toBeInstanceOf(IsolatedX402SecretFileError);
			expect(error).toMatchObject({ code: 'STATE_ROOT_MISMATCH' });
		}
	});

	it('fails closed on an existing credential bound to another valid merchant', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		const stateRoot = join(directory, 'state');
		materializePortable(harbor, pilot, PRINCIPAL, MERCHANT, stateRoot);
		const originalPilot = readFileSync(pilot, 'utf8');
		const harborIdentity = lstatSync(harbor);
		const pilotIdentity = lstatSync(pilot);
		const mismatchedHarbor = readFileSync(harbor, 'utf8').replace(
			`HARBOR_LOCAL_X402_MERCHANT_PAY_TO=${MERCHANT}`,
			`HARBOR_LOCAL_X402_MERCHANT_PAY_TO=${OTHER_VALID_MERCHANT}`,
		);
		writeFileSync(harbor, mismatchedHarbor, { mode: 0o600 });
		const randomBytes = vi.fn(() => new Uint8Array(32));

		try {
			materializePortable(
				harbor,
				pilot,
				PRINCIPAL,
				MERCHANT,
				stateRoot,
				{ randomBytes },
			);
			throw new Error('expected merchant mismatch');
		} catch (error) {
			expect(error).toBeInstanceOf(IsolatedX402SecretFileError);
			expect(error).toMatchObject({ code: 'MERCHANT_MISMATCH' });
		}
		expect(randomBytes).not.toHaveBeenCalled();
		expect(readFileSync(harbor, 'utf8')).toBe(mismatchedHarbor);
		expect(readFileSync(pilot, 'utf8')).toBe(originalPilot);
		expect(lstatSync(harbor).ino).toBe(harborIdentity.ino);
		expect(lstatSync(pilot).ino).toBe(pilotIdentity.ino);
	});

	it('recovers only a verified Harbor-present capability-absent publication', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		const stateRoot = join(directory, 'state');
		const created = materializePortable(harbor, pilot, PRINCIPAL, MERCHANT, stateRoot);
		rmSync(pilot);
		expect(inspectPortable(harbor, pilot, stateRoot)).toEqual({
			secrets: created,
			pilotCapabilityPresent: false,
		});
		const recovered = materializePortable(
			harbor,
			pilot,
			PRINCIPAL,
			MERCHANT,
			stateRoot,
			{ randomBytes: () => { throw new Error('must not regenerate Harbor credentials'); } },
		);
		expect(recovered).toEqual(created);
		expect(readFileSync(pilot, 'utf8')).toBe(
			`HARBOR_X402_API_KEY=${created.apiCredential}\n`,
		);

		rmSync(harbor);
		expect(() => inspectPortable(harbor, pilot, stateRoot))
			.toThrowError(IsolatedX402SecretFileError);
	});

	it('rejects symlinks, hard links, mismatched capabilities, and partial prepublication', () => {
		const directory = privateDirectory();
		const harbor = join(directory, 'harbor-local-x402-isolated-v1.env.local');
		const pilot = join(directory, 'pilot-isolated-x402-capability-v1.env.local');
		writeFileSync(pilot, 'HARBOR_X402_API_KEY=attacker\n', { mode: 0o600 });
		expect(() => materializePortable(
			harbor, pilot, PRINCIPAL, MERCHANT,
		)).toThrowError(IsolatedX402SecretFileError);
		expect(existsSync(harbor)).toBe(false);
		rmSync(pilot);

		const target = join(directory, 'target');
		writeFileSync(target, 'fixture', { mode: 0o600 });
		symlinkSync(target, harbor);
		expect(() => materializePortable(
			harbor, pilot, PRINCIPAL, MERCHANT,
		)).toThrowError(IsolatedX402SecretFileError);
		rmSync(harbor);

		materializePortable(harbor, pilot, PRINCIPAL, MERCHANT, join(directory, 'state'), {
			randomBytes: (size) => new Uint8Array(size).fill(9),
		});
		expect(() => materializePortable(
			harbor, pilot, 'other-principal', MERCHANT,
		)).toThrowError(IsolatedX402SecretFileError);
		expect(() => materializePortable(
			harbor, pilot, PRINCIPAL, OWNER,
		)).toThrowError(IsolatedX402SecretFileError);
		try {
			materializePortable(
				harbor,
				pilot,
				PRINCIPAL,
				MERCHANT,
				join(directory, 'different-state'),
			);
			throw new Error('expected root mismatch');
		} catch (error) {
			expect(error).toBeInstanceOf(IsolatedX402SecretFileError);
			expect(error).toMatchObject({ code: 'STATE_ROOT_MISMATCH' });
		}

		const alias = join(directory, 'capability-alias');
		linkSync(pilot, alias);
		expect(() => materializePortable(
			harbor, pilot, PRINCIPAL, MERCHANT,
		)).toThrowError(IsolatedX402SecretFileError);
	});

	it('rejects a non-private destination directory before publication', () => {
		const directory = privateDirectory();
		chmodSync(directory, 0o755);
		expect(() => materializePortable(
			join(directory, 'harbor-local-x402-isolated-v1.env.local'),
			join(directory, 'pilot-isolated-x402-capability-v1.env.local'),
			PRINCIPAL,
			MERCHANT,
		)).toThrowError(IsolatedX402SecretFileError);
	});

	it('uses only new isolated destinations and never the legacy credential names', () => {
		expect(LOCAL_X402_ISOLATED_SECRET_FILE).toBe(
			'/dev/null/pilot-disabled/harbor-local-x402-isolated-v1.env.local',
		);
		expect(PILOT_X402_ISOLATED_CAPABILITY_FILE).toBe(
			'/dev/null/pilot-disabled/pilot-isolated-x402-capability-v1.env.local',
		);
		expect(LOCAL_X402_ISOLATED_SECRET_FILE).not.toMatch(/harbor-local-x402\.env/u);
		expect(PILOT_X402_ISOLATED_CAPABILITY_FILE).not.toMatch(/pilot-isolated-v1\.env/u);
	});
});

describe('isolated x402 provisioner boundary', () => {
	it('loads the complete npm CLI graph before rejecting missing arguments safely', () => {
		const result = spawnSync(
			process.platform === 'win32' ? 'npm.cmd' : 'npm',
			['run', '--silent', 'provision:local:x402:isolated:v1'],
			{
				cwd: REPO_ROOT,
				encoding: 'utf8',
				env: { ...process.env, NODE_NO_WARNINGS: '1' },
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe(
			'Local isolated x402 payer provisioning failed (INVALID_INPUT).\n',
		);
		expect(`${result.stdout}${result.stderr}`).not.toMatch(
			/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find (?:module|package)/u,
		);
	});

	it('initializes in an exact order and binds every state operation to the selected root', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const databasePath = join(stateRoot, 'v3', 'd1.sqlite');
		const calls: string[] = [];
		const migration = {
			label: 'isolated x402 D1 migrations',
			command: process.execPath,
			args: ['migration-fixture'],
		};
		const release = vi.fn(async () => { calls.push('release'); });
		const result = await prepareIsolatedX402ProvisioningState('initialize', stateRoot, {
			validateConfigurationFile: async (repoRoot) => {
				expect(repoRoot).toBe(REPO_ROOT);
				calls.push('configuration');
			},
			validateMigrationProfile: async (repoRoot) => {
				expect(repoRoot).toBe(REPO_ROOT);
				calls.push('profile');
			},
			validateConfiguredRoot: async (selectedRoot, options) => {
				expect(selectedRoot).toBe(stateRoot);
				expect(options).toEqual({ repoRoot: REPO_ROOT });
				calls.push('root');
				return selectedRoot;
			},
			initializeStateDirectory: async (selectedRoot) => {
				expect(selectedRoot).toBe(stateRoot);
				calls.push('initialize');
				return selectedRoot;
			},
			migrationCommand: (repoRoot, selectedRoot) => {
				expect([repoRoot, selectedRoot]).toEqual([REPO_ROOT, stateRoot]);
				calls.push('command');
				return migration;
			},
			validateMigrationCommand: (command, repoRoot, selectedRoot) => {
				expect(command).toBe(migration);
				expect([repoRoot, selectedRoot]).toEqual([REPO_ROOT, stateRoot]);
				calls.push('validate-command');
				return command;
			},
			acquireStateLease: async (selectedRoot) => {
				expect(selectedRoot).toBe(stateRoot);
				calls.push('lease');
				return { path: join(stateRoot, 'lease'), release };
			},
			childEnvironment: (_source, selectedRoot) => {
				expect(selectedRoot).toBe(stateRoot);
				calls.push('environment');
				return { STATE_ROOT_FIXTURE: selectedRoot };
			},
			runMigration: async (command, environment) => {
				expect(command).toBe(migration);
				expect(environment).toEqual({ STATE_ROOT_FIXTURE: stateRoot });
				calls.push('migration');
			},
			validateStateLayout: async (selectedRoot) => {
				expect(selectedRoot).toBe(stateRoot);
				calls.push('layout');
				return { databasePath };
			},
			writeStateMarker: async (selectedRoot) => {
				expect(selectedRoot).toBe(stateRoot);
				calls.push('marker');
				return join(stateRoot, 'marker');
			},
			validateExistingState: async (selectedRoot) => {
				expect(selectedRoot).toBe(stateRoot);
				calls.push('existing');
				return { databasePath };
			},
		});
		expect(result.databasePath).toBe(databasePath);
		expect(calls).toEqual([
			'configuration', 'profile', 'root', 'command', 'validate-command', 'environment', 'initialize',
			'lease', 'profile', 'migration', 'layout', 'marker', 'existing',
		]);
		await result.release();
		expect(calls.at(-1)).toBe('release');
	});

	it('resumes only after validating an exact existing state and never initializes or migrates', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const databasePath = join(stateRoot, 'v3', 'd1.sqlite');
		const calls: string[] = [];
		const forbidden = vi.fn(() => { throw new Error('must not mutate resumed state'); });
		const release = vi.fn(async () => undefined);
		const result = await prepareIsolatedX402ProvisioningState('resume', stateRoot, {
			validateConfigurationFile: async () => { calls.push('configuration'); },
			validateMigrationProfile: async () => { calls.push('profile'); },
			validateConfiguredRoot: async (selectedRoot) => {
				calls.push('root');
				return selectedRoot;
			},
			initializeStateDirectory: forbidden,
			migrationCommand: forbidden,
			validateMigrationCommand: forbidden,
			acquireStateLease: async () => {
				calls.push('lease');
				return { path: join(stateRoot, 'lease'), release };
			},
			childEnvironment: forbidden,
			runMigration: forbidden,
			validateStateLayout: forbidden,
			writeStateMarker: forbidden,
			validateExistingState: async () => {
				calls.push('existing');
				return { databasePath };
			},
		});
		expect(result.databasePath).toBe(databasePath);
		expect(calls).toEqual(['configuration', 'profile', 'root', 'lease', 'existing']);
		expect(forbidden).not.toHaveBeenCalled();
		await result.release();
		expect(release).toHaveBeenCalledOnce();
	});

	it('performs no state side effects when configured-root validation fails', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const sideEffect = vi.fn();
		await expect(prepareIsolatedX402ProvisioningState('initialize', stateRoot, {
			validateConfigurationFile: async () => undefined,
			validateMigrationProfile: async () => undefined,
			validateConfiguredRoot: async () => { throw new Error('unsafe root fixture'); },
			initializeStateDirectory: sideEffect,
			migrationCommand: sideEffect,
			validateMigrationCommand: sideEffect,
			acquireStateLease: sideEffect,
			childEnvironment: sideEffect,
			runMigration: sideEffect,
			validateStateLayout: sideEffect,
			writeStateMarker: sideEffect,
			validateExistingState: sideEffect,
		})).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
		expect(sideEffect).not.toHaveBeenCalled();
	});

	it('performs no state side effects when migration profile validation fails', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const sideEffect = vi.fn();
		await expect(prepareIsolatedX402ProvisioningState('initialize', stateRoot, {
			validateConfigurationFile: async () => undefined,
			validateMigrationProfile: async () => { throw new Error('stale migration profile'); },
			validateConfiguredRoot: sideEffect,
			initializeStateDirectory: sideEffect,
			migrationCommand: sideEffect,
			validateMigrationCommand: sideEffect,
			acquireStateLease: sideEffect,
			childEnvironment: sideEffect,
			runMigration: sideEffect,
			validateStateLayout: sideEffect,
			writeStateMarker: sideEffect,
			validateExistingState: sideEffect,
		})).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
		expect(sideEffect).not.toHaveBeenCalled();
	});

	it('validates the exact migration command before creating the state leaf', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const initialize = vi.fn();
		const migration = {
			label: 'tampered migration',
			command: process.execPath,
			args: ['--remote'],
		};
		await expect(prepareIsolatedX402ProvisioningState('initialize', stateRoot, {
			validateConfigurationFile: async () => undefined,
			validateMigrationProfile: async () => undefined,
			validateConfiguredRoot: async (selectedRoot) => selectedRoot,
			initializeStateDirectory: initialize,
			migrationCommand: () => migration,
			validateMigrationCommand: () => { throw new Error('unsafe command fixture'); },
			acquireStateLease: vi.fn(),
			childEnvironment: vi.fn(),
			runMigration: vi.fn(),
			validateStateLayout: vi.fn(),
			writeStateMarker: vi.fn(),
			validateExistingState: vi.fn(),
		})).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
		expect(initialize).not.toHaveBeenCalled();
	});

	it('requires concordant reviewed account.status and onboarding.readiness evidence', () => {
		expect(() => validateTradingDelegateEvidence(
			reviewedTradingEvidence(),
			{ owner: OWNER, delegate: TRADING_DELEGATE },
		)).not.toThrow();
		for (const evidence of [
			reviewedTradingEvidence(OWNER, PAYER),
			{
				...reviewedTradingEvidence(),
				onboarding_readiness: {
					...(reviewedTradingEvidence().onboarding_readiness as object),
					ready: false,
				},
			},
		]) {
			expect(() => validateTradingDelegateEvidence(
				evidence,
				{ owner: OWNER, delegate: TRADING_DELEGATE },
			)).toThrowError(X402ProvisioningError);
		}
	});

	it('requires the evidence-bound active trading delegate as a public separation input', () => {
		const stateRoot = join(privateDirectory(), 'state');
		expect(parseIsolatedProvisionerArguments(
			provisionerArguments(stateRoot, 'resume'),
		)).toEqual({
			principal: PRINCIPAL,
			tradingPrincipal: TRADING_PRINCIPAL,
			owner: OWNER,
			merchantPayTo: MERCHANT,
			tradingDelegate: TRADING_DELEGATE,
			stateMode: 'resume',
			stateRoot,
		});
		expect(() => parseIsolatedProvisionerArguments([
			'--provision-testnet-payer', '--principal', PRINCIPAL,
			'--owner', OWNER, '--merchant-pay-to', MERCHANT,
		])).toThrowError(X402ProvisioningError);
		const otherMerchant = provisionerArguments(stateRoot);
		otherMerchant[otherMerchant.indexOf('--merchant-pay-to') + 1] = OTHER_VALID_MERCHANT;
		expect(() => parseIsolatedProvisionerArguments(otherMerchant))
			.toThrowError(X402ProvisioningError);
		expect(() => parseIsolatedProvisionerArguments([
			'--provision-testnet-payer', '--principal', PRINCIPAL,
			'--trading-principal', PRINCIPAL,
			'--owner', OWNER, '--merchant-pay-to', MERCHANT,
			'--trading-delegate', TRADING_DELEGATE,
			'--state-mode', 'initialize', '--state-root', stateRoot,
		])).toThrowError(X402ProvisioningError);
		for (const invalid of [
			provisionerArguments('relative/state'),
			provisionerArguments(`${stateRoot}/..`),
			provisionerArguments(`${stateRoot} `),
			provisionerArguments(`${stateRoot}\nINJECTED=value`),
			provisionerArguments(`${stateRoot}\0suffix`),
			provisionerArguments(stateRoot).map((value) =>
				value === 'initialize' ? 'replace' : value),
		]) {
			expect(() => parseIsolatedProvisionerArguments(invalid))
				.toThrowError(X402ProvisioningError);
		}
	});

	it.each([
		['invalid owner', 'rInvalid', MERCHANT, TRADING_DELEGATE],
		['invalid merchant', OWNER, 'rInvalid', TRADING_DELEGATE],
		['non-pinned merchant', OWNER, OTHER_VALID_MERCHANT, TRADING_DELEGATE],
		['invalid delegate', OWNER, MERCHANT, 'rInvalid'],
	] as const)('rejects %s before evidence, migrations, D1, or secrets', async (
		_label,
		owner,
		merchant,
		delegate,
	) => {
		const stateRoot = join(privateDirectory(), 'state');
		const validateDelegateEvidence = vi.fn();
		const prepareState = vi.fn();
		const openDatabase = vi.fn();
		const materializeSecrets = vi.fn();
		await expect(runIsolatedX402Provisioner([
			'--provision-testnet-payer', '--principal', PRINCIPAL,
			'--trading-principal', TRADING_PRINCIPAL,
			'--owner', owner, '--merchant-pay-to', merchant,
			'--trading-delegate', delegate,
			'--state-mode', 'initialize', '--state-root', stateRoot,
		], {
			validateTradingDelegateEvidence: validateDelegateEvidence,
			prepareState,
			openDatabase,
			materializeSecrets,
		})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(validateDelegateEvidence).not.toHaveBeenCalled();
		expect(prepareState).not.toHaveBeenCalled();
		expect(openDatabase).not.toHaveBeenCalled();
		expect(materializeSecrets).not.toHaveBeenCalled();
	});

	it('rejects mismatched delegate evidence before migrations, D1, or secrets', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const prepareState = vi.fn();
		const openDatabase = vi.fn();
		const materializeSecrets = vi.fn();
		await expect(runIsolatedX402Provisioner([
			'--provision-testnet-payer', '--principal', PRINCIPAL,
			'--trading-principal', TRADING_PRINCIPAL,
			'--owner', OWNER, '--merchant-pay-to', MERCHANT,
			'--trading-delegate', TRADING_DELEGATE,
			'--state-mode', 'initialize', '--state-root', stateRoot,
		], {
			readTradingPrincipal: async () => TRADING_PRINCIPAL,
			inspectExistingSecrets: () => null,
			validateTradingDelegateEvidence: () => validateTradingDelegateEvidence(
				reviewedTradingEvidence(OWNER, PAYER),
				{ owner: OWNER, delegate: TRADING_DELEGATE },
			),
			prepareState,
			openDatabase,
			materializeSecrets,
		})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(prepareState).not.toHaveBeenCalled();
		expect(openDatabase).not.toHaveBeenCalled();
		expect(materializeSecrets).not.toHaveBeenCalled();
	});

	it('rejects a decoy trading principal before x402 secrets, state, or faucet effects', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const readTradingPrincipal = vi.fn(async () => TRADING_PRINCIPAL);
		const inspectExistingSecrets = vi.fn();
		const validateTradingDelegateEvidence = vi.fn();
		const prepareState = vi.fn();
		const materializeSecrets = vi.fn();
		const requestTestnetFaucet = vi.fn();
		const args = provisionerArguments(stateRoot);
		args[args.indexOf('--trading-principal') + 1] = 'decoy-trading-principal';
		await expect(runIsolatedX402Provisioner(args, {
			readTradingPrincipal,
			inspectExistingSecrets,
			validateTradingDelegateEvidence,
			prepareState,
			materializeSecrets,
			requestTestnetFaucet,
		})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(readTradingPrincipal).toHaveBeenCalledOnce();
		expect(inspectExistingSecrets).not.toHaveBeenCalled();
		expect(validateTradingDelegateEvidence).not.toHaveBeenCalled();
		expect(prepareState).not.toHaveBeenCalled();
		expect(materializeSecrets).not.toHaveBeenCalled();
		expect(requestTestnetFaucet).not.toHaveBeenCalled();
	});

	it('rejects a fixed trading principal that collides with the requested x402 principal', async () => {
		const inspectExistingSecrets = vi.fn();
		const prepareState = vi.fn();
		await expect(runIsolatedX402Provisioner(
			provisionerArguments(join(privateDirectory(), 'state')),
			{
				readTradingPrincipal: async () => PRINCIPAL,
				inspectExistingSecrets,
				prepareState,
			},
		)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(inspectExistingSecrets).not.toHaveBeenCalled();
		expect(prepareState).not.toHaveBeenCalled();
	});

	it('rejects a pre-existing credential bound to another root before any state side effect', async () => {
		const stateRoot = join(privateDirectory(), 'state-b');
		const validateDelegateEvidence = vi.fn();
		const prepareState = vi.fn();
		const openDatabase = vi.fn();
		const materializeSecrets = vi.fn();
		const faucet = vi.fn();
		await expect(runIsolatedX402Provisioner(provisionerArguments(stateRoot), {
			readTradingPrincipal: async () => TRADING_PRINCIPAL,
			inspectExistingSecrets: () => {
				throw new IsolatedX402SecretFileError('STATE_ROOT_MISMATCH');
			},
			validateTradingDelegateEvidence: validateDelegateEvidence,
			prepareState,
			openDatabase,
			materializeSecrets,
			requestTestnetFaucet: faucet,
		})).rejects.toMatchObject({ code: 'STATE_ROOT_MISMATCH' });
		expect(validateDelegateEvidence).not.toHaveBeenCalled();
		expect(prepareState).not.toHaveBeenCalled();
		expect(openDatabase).not.toHaveBeenCalled();
		expect(materializeSecrets).not.toHaveBeenCalled();
		expect(faucet).not.toHaveBeenCalled();
	});

	it('rejects a pre-existing credential bound to another merchant before state effects', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const validateDelegateEvidence = vi.fn();
		const prepareState = vi.fn();
		const openDatabase = vi.fn();
		const materializeSecrets = vi.fn();
		const faucet = vi.fn();
		await expect(runIsolatedX402Provisioner(provisionerArguments(stateRoot), {
			readTradingPrincipal: async () => TRADING_PRINCIPAL,
			inspectExistingSecrets: () => {
				throw new IsolatedX402SecretFileError('MERCHANT_MISMATCH');
			},
			validateTradingDelegateEvidence: validateDelegateEvidence,
			prepareState,
			openDatabase,
			materializeSecrets,
			requestTestnetFaucet: faucet,
		})).rejects.toMatchObject({ code: 'MERCHANT_MISMATCH' });
		expect(validateDelegateEvidence).not.toHaveBeenCalled();
		expect(prepareState).not.toHaveBeenCalled();
		expect(openDatabase).not.toHaveBeenCalled();
		expect(materializeSecrets).not.toHaveBeenCalled();
		expect(faucet).not.toHaveBeenCalled();
	});

	it('allows Harbor-only capability recovery only through resume', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const validateDelegateEvidence = vi.fn();
		const prepareState = vi.fn();
		const inspection = {
			secrets: {
				apiCredential: `${PRINCIPAL}:${'T'.repeat(32)}`,
				kek: `${'A'.repeat(43)}=`,
				merchantPayTo: MERCHANT,
				stateRoot,
			},
			pilotCapabilityPresent: false,
		};
		await expect(runIsolatedX402Provisioner(provisionerArguments(stateRoot), {
			readTradingPrincipal: async () => TRADING_PRINCIPAL,
			inspectExistingSecrets: () => inspection,
			validateTradingDelegateEvidence: validateDelegateEvidence,
			prepareState,
		})).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
		expect(validateDelegateEvidence).not.toHaveBeenCalled();
		expect(prepareState).not.toHaveBeenCalled();
	});

	it('refuses credential creation when resumed state already contains payer or payment authority', async () => {
		for (const table of ['x402_payers', 'x402_payments'] as const) {
			const stateRoot = join(privateDirectory(), `state-${table}`);
			const database = new DatabaseSync(':memory:');
			database.exec('CREATE TABLE x402_payers(id TEXT); CREATE TABLE x402_payments(id TEXT)');
			database.prepare(`INSERT INTO ${table}(id) VALUES (?)`).run('persisted');
			const close = vi.spyOn(database, 'close');
			const release = vi.fn(async () => undefined);
			const materializeSecrets = vi.fn();
			await expect(runIsolatedX402Provisioner(provisionerArguments(stateRoot, 'resume'), {
				readTradingPrincipal: async () => TRADING_PRINCIPAL,
				inspectExistingSecrets: () => null,
				validateTradingDelegateEvidence: async () => undefined,
				prepareState: async () => ({ databasePath: ':memory:', release }),
				openDatabase: () => database,
				materializeSecrets,
			})).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
			expect(materializeSecrets).not.toHaveBeenCalled();
			expect(close).toHaveBeenCalledOnce();
			expect(release).toHaveBeenCalledOnce();
		}
	});

	it('accepts credential creation only when both isolated authority tables are empty', () => {
		const database = new DatabaseSync(':memory:');
		try {
			database.exec('CREATE TABLE x402_payers(id TEXT); CREATE TABLE x402_payments(id TEXT)');
			expect(() => assertFreshIsolatedX402CredentialState(database)).not.toThrow();
		} finally {
			database.close();
		}
	});

	it('uses mocked filesystem, crypto, faucet, and ledger seams and emits only public evidence', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const validateDelegateEvidence = vi.fn(async () => undefined);
		const release = vi.fn(async () => undefined);
		const prepareState = vi.fn(async () => ({
			databasePath: '/fixed/isolated/state.sqlite',
			release,
		}));
		const close = vi.fn();
		const openDatabase = vi.fn(() => ({ close }));
		const materializeSecrets = vi.fn(() => ({
			apiCredential: `${PRINCIPAL}:${'T'.repeat(32)}`,
			kek: `${'A'.repeat(43)}=`,
			merchantPayTo: MERCHANT,
			stateRoot,
		}));
		const createWrappedKey = vi.fn(async () => ({
			address: PAYER,
			publicKey: `ED${'A'.repeat(64)}`,
			ciphertext: new ArrayBuffer(33),
			iv: new ArrayBuffer(12),
		}));
		const requestTestnetFaucet = vi.fn(async () => undefined);
		const readValidatedFunding = vi.fn(async () => ({
			ledgerIndex: 99,
			balanceDrops: '100000000',
		}));
		const result = {
			principal: PRINCIPAL,
			owner: OWNER,
			merchantPayTo: MERCHANT,
			network: 'testnet' as const,
			payer: PAYER,
			publicKey: `ED${'A'.repeat(64)}`,
			state: 'ready' as const,
			fundedLedgerIndex: 99,
			fundedBalanceDrops: '100000000',
		};
		const provisionPayer = vi.fn(async (_principal, _owner, _merchant, dependencies) => {
			expect(dependencies.forbiddenPayerAddresses).toEqual([TRADING_DELEGATE]);
			await dependencies.createWrappedKey();
			await dependencies.requestTestnetFaucet(PAYER);
			await dependencies.readValidatedFunding(PAYER);
			return result;
		});
		const writeResult = vi.fn();

		await runIsolatedX402Provisioner(provisionerArguments(stateRoot), {
			readTradingPrincipal: async () => TRADING_PRINCIPAL,
			inspectExistingSecrets: () => null,
			validateCredentialCreationState: () => undefined,
			validateTradingDelegateEvidence: validateDelegateEvidence,
			prepareState,
			openDatabase,
			materializeSecrets,
			createStore: vi.fn(() => ({} as never)),
			provisionPayer,
			createWrappedKey,
			requestTestnetFaucet,
			readValidatedFunding,
			writeResult,
		});

		expect(prepareState).toHaveBeenCalledExactlyOnceWith('initialize', stateRoot);
		expect(validateDelegateEvidence).toHaveBeenCalledExactlyOnceWith(OWNER, TRADING_DELEGATE);
		expect(openDatabase).toHaveBeenCalledExactlyOnceWith('/fixed/isolated/state.sqlite');
		expect(materializeSecrets).toHaveBeenCalledExactlyOnceWith(PRINCIPAL, MERCHANT, stateRoot);
		expect(createWrappedKey).toHaveBeenCalledOnce();
		expect(requestTestnetFaucet).toHaveBeenCalledExactlyOnceWith(PAYER);
		expect(readValidatedFunding).toHaveBeenCalledExactlyOnceWith(PAYER);
		expect(writeResult).toHaveBeenCalledExactlyOnceWith(result);
		expect(JSON.stringify(writeResult.mock.calls)).not.toMatch(/kek|ciphertext|seed|private|token/i);
		expect(close).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(close.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
		expect(release.mock.invocationCallOrder[0]).toBeLessThan(
			writeResult.mock.invocationCallOrder[0]!,
		);
	});

	it('releases the state lease when credential materialization fails', async () => {
		const stateRoot = join(privateDirectory(), 'state');
		const close = vi.fn();
		const release = vi.fn(async () => undefined);
		const writeResult = vi.fn();
		await expect(runIsolatedX402Provisioner(provisionerArguments(stateRoot, 'resume'), {
			readTradingPrincipal: async () => TRADING_PRINCIPAL,
			inspectExistingSecrets: () => null,
			validateCredentialCreationState: () => undefined,
			validateTradingDelegateEvidence: async () => undefined,
			prepareState: async () => ({
				databasePath: '/fixed/isolated/state.sqlite',
				release,
			}),
			openDatabase: () => ({ close }),
			materializeSecrets: () => { throw new Error('credential fixture failure'); },
			writeResult,
		})).rejects.toThrow('credential fixture failure');
		expect(close).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(writeResult).not.toHaveBeenCalled();
	});

	it('durably records encrypted identity and faucet intent before an ambiguous call and never retries', async () => {
		let row: any = null;
		const store = {
			get: vi.fn(async () => row),
			insert: vi.fn(async (input: any) => {
				row = { principal: PRINCIPAL, ...input, faucetRequestedAt: null, fundingCheckedAt: null };
				return row;
			}),
			markFaucetRequested: vi.fn(async (_owner: string, _network: string, at: string) => {
				const requested = row.faucetRequestedAt === null;
				if (requested) row = { ...row, faucetRequestedAt: at, updatedAt: at };
				return { row, requested };
			}),
			markFundingPending: vi.fn(async (_owner: string, _network: string, at: string) => {
				row = { ...row, fundingCheckedAt: at, updatedAt: at };
				return row;
			}),
			markReadyFromFunding: vi.fn(),
		};
		const createWrappedKey = vi.fn(async () => ({
			address: PAYER,
			publicKey: `ED${'A'.repeat(64)}`,
			ciphertext: new Uint8Array(33).fill(7).buffer,
			iv: new Uint8Array(12).fill(8).buffer,
		}));
		const ambiguousFaucet = vi.fn(async () => {
			expect(row.ciphertext).toBeInstanceOf(ArrayBuffer);
			expect(row.faucetRequestedAt).toBe('2026-10-20T12:00:00.000Z');
			throw new Error('ambiguous fixture outcome');
		});
		await expect(provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT, {
			store: store as never,
			createWrappedKey,
			requestTestnetFaucet: ambiguousFaucet,
			readValidatedFunding: async () => null,
			now: () => new Date('2026-10-20T12:00:00.000Z'),
			forbiddenPayerAddresses: [TRADING_DELEGATE],
		})).rejects.toMatchObject({ code: 'FAUCET_REQUEST_FAILED' });

		const forbiddenFaucet = vi.fn(async () => { throw new Error('must not retry'); });
		const resumed = await provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT, {
			store: store as never,
			createWrappedKey: vi.fn(async () => { throw new Error('must not regenerate'); }),
			requestTestnetFaucet: forbiddenFaucet,
			readValidatedFunding: async () => null,
			now: () => new Date('2026-10-20T12:01:00.000Z'),
			forbiddenPayerAddresses: [TRADING_DELEGATE],
		});
		expect(resumed).toMatchObject({ state: 'funding-pending', payer: PAYER });
		expect(createWrappedKey).toHaveBeenCalledOnce();
		expect(ambiguousFaucet).toHaveBeenCalledOnce();
		expect(forbiddenFaucet).not.toHaveBeenCalled();
	});

	it.each([
		['owner', OWNER],
		['merchant', MERCHANT],
		['trading delegate', TRADING_DELEGATE],
	] as const)('rejects payer reuse of %s before faucet', async (_label, reusedAddress) => {
		const faucet = vi.fn();
		await expect(provisionLocalX402Payer(PRINCIPAL, OWNER, MERCHANT, {
			store: {
				get: async () => null,
				insert: vi.fn(), markFaucetRequested: vi.fn(),
				markFundingPending: vi.fn(), markReadyFromFunding: vi.fn(),
			} as never,
			createWrappedKey: async () => ({
				address: reusedAddress,
				publicKey: `ED${'A'.repeat(64)}`,
				ciphertext: new ArrayBuffer(33),
				iv: new ArrayBuffer(12),
			}),
			requestTestnetFaucet: faucet,
			readValidatedFunding: async () => null,
			now: () => new Date('2026-10-20T12:00:00.000Z'),
			forbiddenPayerAddresses: [TRADING_DELEGATE],
		})).rejects.toMatchObject({ code: 'BINDING_SUSPENDED' });
		expect(faucet).not.toHaveBeenCalled();
	});

	it('accepts only bounded validated Testnet funding', () => {
		for (const balance of [
			ISOLATED_X402_MIN_FUNDING_DROPS,
			ISOLATED_X402_MAX_FUNDING_DROPS,
		]) {
			expect(isolatedFundingObservation({
				validated: true,
				account_data: { Account: PAYER, Balance: balance.toString() },
				ledger_index: 99,
			}, PAYER).balanceDrops).toBe(balance.toString());
		}
		for (const balance of [
			ISOLATED_X402_MIN_FUNDING_DROPS - 1n,
			ISOLATED_X402_MAX_FUNDING_DROPS + 1n,
		]) {
			expect(() => isolatedFundingObservation({
				validated: true,
				account_data: { Account: PAYER, Balance: balance.toString() },
				ledger_index: 99,
			}, PAYER)).toThrowError(X402ProvisioningError);
		}
	});

	it('reports only stable error codes and never raw dependency details', () => {
		const known = isolatedProvisioningErrorMessage(
			new X402ProvisioningError('FAUCET_REQUEST_FAILED'),
		);
		const unknown = isolatedProvisioningErrorMessage(
			new Error('secret fixture upstream detail'),
		);
		const rootMismatch = isolatedProvisioningErrorMessage(
			new IsolatedX402SecretFileError('STATE_ROOT_MISMATCH'),
		);
		expect(known).toBe(
			'Local isolated x402 payer provisioning failed (FAUCET_REQUEST_FAILED).',
		);
		expect(unknown).toBe(
			'Local isolated x402 payer provisioning failed (LOCAL_ISOLATED_PROVISIONING_FAILED).',
		);
		expect(rootMismatch).toBe(
			'Local isolated x402 payer provisioning failed (STATE_ROOT_MISMATCH).',
		);
		expect(`${known}${unknown}`).not.toContain('secret fixture upstream detail');
	});
});
