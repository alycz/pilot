import { execFileSync } from 'node:child_process';
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
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	assertMacAcl,
	LocalTradingSecretProvisionError,
	provisionLocalTradingSecretFileAt as provisionWithAclSeam,
	validateMacAclResult,
} from '../src/exec/trading-local-secret-file';
import { parseTradingProvisionerArguments } from '../scripts/provision-local-trading';

const REPO_ROOT = realpathSync(process.cwd());
const PRINCIPAL = 'pilot-trading';
const temporaryDirectories: string[] = [];

function provisionLocalTradingSecretFileAt(
	path: string,
	principal: string,
	dependencies: NonNullable<Parameters<typeof provisionWithAclSeam>[2]> = { randomBytes: (size) => new Uint8Array(size) },
) {
	return provisionWithAclSeam(path, principal, {
		assertAcl: () => undefined,
		...dependencies,
	});
}

function privateDirectory(): string {
	const directory = realpathSync(mkdtempSync(join(REPO_ROOT, '.harbor-trading-secret-')));
	chmodSync(directory, 0o700);
	temporaryDirectories.push(directory);
	return directory;
}

function secretPath(directory: string): string {
	return join(directory, 'harbor-local-trading.env.local');
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('local trading secret provisioner', () => {
	it('accepts only direct native ACL classifications allowed by each path policy', () => {
		expect(() => validateMacAclResult('EMPTY\n', 'private')).not.toThrow();
		expect(() => validateMacAclResult('EMPTY\n', 'ancestor')).not.toThrow();
		expect(() => validateMacAclResult('DENY_ONLY\n', 'ancestor')).not.toThrow();
		for (const [result, policy] of [
			['DENY_ONLY\n', 'private'],
			['ACCESS_GRANTING\n', 'private'],
			['ACCESS_GRANTING\n', 'ancestor'],
			['', 'private'],
			['EMPTY\ntrailing', 'private'],
		] as const) {
			expect(() => validateMacAclResult(result, policy))
				.toThrowError(LocalTradingSecretProvisionError);
		}
	});

	it.runIf(process.platform === 'darwin')(
		'uses the native fd-based inspector for empty, inherited-deny, allow, missing, and symlink cases',
		() => {
			const directory = privateDirectory();
			expect(() => assertMacAcl(directory, 'private')).not.toThrow();
			try {
				const aclParent = join(directory, 'acl-parent');
				mkdirSync(aclParent, { mode: 0o700 });
				execFileSync('/bin/chmod', [
					'+a', 'everyone deny delete,file_inherit,directory_inherit', aclParent,
				]);
				expect(() => assertMacAcl(aclParent, 'ancestor')).not.toThrow();
				const inheritedChild = join(aclParent, 'inherited-child');
				mkdirSync(inheritedChild, { mode: 0o700 });
				expect(() => assertMacAcl(inheritedChild, 'ancestor')).not.toThrow();
				expect(() => assertMacAcl(inheritedChild, 'private'))
					.toThrowError(LocalTradingSecretProvisionError);
				const allowPath = join(directory, 'allow');
				mkdirSync(allowPath, { mode: 0o700 });
				execFileSync('/bin/chmod', ['+a', 'everyone allow read', allowPath]);
				expect(() => assertMacAcl(allowPath, 'ancestor'))
					.toThrowError(LocalTradingSecretProvisionError);
			} finally {
				execFileSync('/bin/chmod', ['-RN', directory]);
			}
			expect(() => assertMacAcl(join(directory, 'missing'), 'private'))
				.toThrowError(LocalTradingSecretProvisionError);
			const symlink = join(directory, 'link');
			symlinkSync(directory, symlink);
			expect(() => assertMacAcl(symlink, 'private'))
				.toThrowError(LocalTradingSecretProvisionError);
		},
	);

	it('fails on ACL retrieval error before generating random bytes or writing', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		const generate = vi.fn(() => new Uint8Array(32));
		expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			assertAcl: () => { throw new Error('ACL retrieval failed'); },
			randomBytes: generate,
		})).toThrow();
		expect(generate).not.toHaveBeenCalled();
		expect(readdirSync(directory)).toEqual([]);
	});

	it('verifies the new staging inode ACL before generating token or KEK bytes', () => {
		const path = secretPath(privateDirectory());
		const events: string[] = [];
		provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			assertAcl: (candidate, policy) => events.push(`acl:${policy}:${candidate}`),
			randomBytes: (size) => {
				events.push(`random:${size}`);
				return new Uint8Array(size).fill(15);
			},
		});
		const stageAcl = events.findIndex((event) => event.startsWith('acl:private:') && event.endsWith('.tmp'));
		const firstSecretRandom = events.indexOf('random:32');
		expect(stageAcl).toBeGreaterThan(-1);
		expect(firstSecretRandom).toBeGreaterThan(stageAcl);
	});
	it('creates exactly one owner-only API credential and KEK without returning either secret', () => {
		const path = secretPath(privateDirectory());
		let call = 0;
		const result = provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			randomBytes: (size) => new Uint8Array(size).fill(++call),
		});

		expect(result).toEqual({ path, principal: PRINCIPAL });
		expect(Object.keys(result)).toEqual(['path', 'principal']);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(lstatSync(path).nlink).toBe(1);
		expect(readdirSync(join(path, '..')).sort()).toEqual(['harbor-local-trading.env.local']);

		const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^HARBOR_API_KEYS=pilot-trading:[A-Za-z0-9_-]{43}$/u);
		expect(lines[1]).toMatch(/^HARBOR_KEK=[A-Za-z0-9+/]{43}=$/u);
		expect(Buffer.from(lines[1]!.slice('HARBOR_KEK='.length), 'base64')).toHaveLength(32);
	});

	it.each(['local-dev', '', '-leading', 'white space', 'x'.repeat(65)])(
		'rejects invalid principal %j before generating credentials',
		(principal) => {
			const path = secretPath(privateDirectory());
			const generate = vi.fn(() => new Uint8Array(32));
			expect(() => provisionLocalTradingSecretFileAt(path, principal, { randomBytes: generate }))
				.toThrowError(LocalTradingSecretProvisionError);
			expect(generate).not.toHaveBeenCalled();
			expect(existsSync(path)).toBe(false);
		},
	);

	it('fails closed without reading, replacing, or regenerating an existing file', () => {
		const path = secretPath(privateDirectory());
		writeFileSync(path, 'existing-secret-material', { mode: 0o600 });
		const generate = vi.fn(() => { throw new Error('must not generate'); });

		try {
			provisionLocalTradingSecretFileAt(path, PRINCIPAL, { randomBytes: generate });
			throw new Error('expected existing-file rejection');
		} catch (error) {
			expect(error).toMatchObject({ code: 'ALREADY_EXISTS' });
		}
		expect(generate).not.toHaveBeenCalled();
		expect(readFileSync(path, 'utf8')).toBe('existing-secret-material');
	});

	it('does not follow a target symlink or a symlinked parent', () => {
		const directory = privateDirectory();
		const target = join(directory, 'target');
		const path = secretPath(directory);
		writeFileSync(target, 'unchanged', { mode: 0o600 });
		symlinkSync(target, path);
		expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL))
			.toThrowError(LocalTradingSecretProvisionError);
		expect(readFileSync(target, 'utf8')).toBe('unchanged');

		const realParent = join(directory, 'real-parent');
		const linkedParent = join(directory, 'linked-parent');
		mkdirSync(realParent, { mode: 0o700 });
		symlinkSync(realParent, linkedParent);
		expect(() => provisionLocalTradingSecretFileAt(secretPath(linkedParent), PRINCIPAL))
			.toThrowError(LocalTradingSecretProvisionError);
		expect(readdirSync(realParent)).toEqual([]);
	});

	it('rejects unsafe immediate and ancestor directory permissions', () => {
		const directory = privateDirectory();
		chmodSync(directory, 0o750);
		expect(() => provisionLocalTradingSecretFileAt(secretPath(directory), PRINCIPAL))
			.toThrowError(LocalTradingSecretProvisionError);
		chmodSync(directory, 0o700);

		const ancestor = join(directory, 'ancestor');
		const secrets = join(ancestor, 'secrets');
		mkdirSync(ancestor, { mode: 0o700 });
		mkdirSync(secrets, { mode: 0o700 });
		chmodSync(ancestor, 0o770);
		expect(() => provisionLocalTradingSecretFileAt(secretPath(secrets), PRINCIPAL))
			.toThrowError(LocalTradingSecretProvisionError);
		expect(readdirSync(secrets)).toEqual([]);
	});

	it('refuses an orphaned staging entry without deleting it or generating credentials', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		const staging = `${path}.${'A'.repeat(24)}.tmp`;
		writeFileSync(staging, 'orphan', { mode: 0o600 });
		const generate = vi.fn(() => { throw new Error('must not generate'); });

		expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL, { randomBytes: generate }))
			.toThrowError(LocalTradingSecretProvisionError);
		expect(generate).not.toHaveBeenCalled();
		expect(readFileSync(staging, 'utf8')).toBe('orphan');
		expect(existsSync(path)).toBe(false);
	});

	it('refuses a pre-existing crash lock before generating credentials', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		const lock = `${path}.provision.lock`;
		writeFileSync(lock, '', { mode: 0o600 });
		const generate = vi.fn(() => { throw new Error('must not generate'); });

		try {
			provisionLocalTradingSecretFileAt(path, PRINCIPAL, { randomBytes: generate });
			throw new Error('expected lock rejection');
		} catch (error) {
			expect(error).toMatchObject({ code: 'ALREADY_EXISTS' });
		}
		expect(generate).not.toHaveBeenCalled();
		expect(existsSync(path)).toBe(false);
		expect(existsSync(lock)).toBe(true);
	});

	it('serializes a concurrent provisioner before it can generate another credential', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		let calls = 0;
		let nestedError: unknown;
		const result = provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			randomBytes: (size) => {
				calls += 1;
				if (calls === 1) {
					try {
						provisionLocalTradingSecretFileAt(path, 'concurrent-principal', {
							randomBytes: () => { throw new Error('concurrent generator must not run'); },
						});
					} catch (error) {
						nestedError = error;
					}
				}
				return new Uint8Array(size).fill(14);
			},
		});
		expect(result).toEqual({ path, principal: PRINCIPAL });
		expect(nestedError).toMatchObject({ code: 'ALREADY_EXISTS' });
		expect(readdirSync(directory)).toEqual(['harbor-local-trading.env.local']);
	});

	it('rejects a staging orphan created after preflight and rolls back its own publication', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		const orphan = `${path}.${'A'.repeat(24)}.tmp`;
		let calls = 0;
		expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			randomBytes: (size) => {
				calls += 1;
				if (calls === 3) writeFileSync(orphan, 'late-orphan', { mode: 0o600 });
				return new Uint8Array(size).fill(13);
			},
		})).toThrowError(LocalTradingSecretProvisionError);
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(directory)).toEqual([orphan.slice(directory.length + 1)]);
		expect(readFileSync(orphan, 'utf8')).toBe('late-orphan');
	});

	it.each(['file', 'directory'] as const)(
		'leaves no credential or staging file after a %s fsync failure',
		(stage) => {
			const directory = privateDirectory();
			const path = secretPath(directory);
			let calls = 0;
			expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
				randomBytes: (size) => new Uint8Array(size).fill(7),
				fsyncSync: (descriptor) => {
					calls += 1;
					if ((stage === 'file' && calls === 3) || (stage === 'directory' && calls === 4)) {
						throw new Error('simulated durability failure');
					}
					fsyncSync(descriptor);
				},
			})).toThrowError(LocalTradingSecretProvisionError);
			expect(existsSync(path)).toBe(false);
			expect(readdirSync(directory)).toEqual([]);
		},
	);

	it('rejects a staging-path replacement instead of publishing unverified content', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			randomBytes: (size) => new Uint8Array(size).fill(11),
			linkSync: (staging, target) => {
				unlinkSync(staging);
				writeFileSync(staging, 'INVALID', { mode: 0o600 });
				linkSync(staging, target);
			},
		})).toThrowError(LocalTradingSecretProvisionError);
		expect(readFileSync(path, 'utf8')).toBe('INVALID');
		expect(readdirSync(directory)).toHaveLength(2);
	});

	it('rolls back both verified links after a transient staging-unlink failure', () => {
		const directory = privateDirectory();
		const path = secretPath(directory);
		let calls = 0;
		expect(() => provisionLocalTradingSecretFileAt(path, PRINCIPAL, {
			randomBytes: (size) => new Uint8Array(size).fill(12),
			unlinkSync: (candidate) => {
				calls += 1;
				if (calls === 1) throw new Error('simulated unlink failure');
				unlinkSync(candidate);
			},
		})).toThrowError(LocalTradingSecretProvisionError);
		expect(readdirSync(directory)).toEqual([]);
	});

	it('accepts only one named-principal argument and never accepts secret arguments', () => {
		expect(parseTradingProvisionerArguments(['--principal', PRINCIPAL])).toBe(PRINCIPAL);
		for (const args of [
			[],
			['--principal'],
			['--token', 'secret'],
			['--principal', PRINCIPAL, '--kek', 'secret'],
		]) {
			expect(() => parseTradingProvisionerArguments(args))
				.toThrowError(LocalTradingSecretProvisionError);
		}
	});
});
