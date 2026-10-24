import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isValidClassicAddress } from 'xrpl';

export const LOCAL_X402_SECRET_FILE =
	(process.env.HARBOR_PRIVATE_SECRETS_ROOT ? `${process.env.HARBOR_PRIVATE_SECRETS_ROOT}/harbor-local-x402.env.local` : "/dev/null/pilot-disabled/harbor-local-x402.env.local");
export const LOCAL_X402_SECRET_MAX_BYTES = 16_384;

const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXPECTED_KEYS = new Set([
	'EXEC_NETWORK',
	'HARBOR_API_KEYS',
	'HARBOR_KEK',
	'HARBOR_LOCAL_READ_ONLY',
	'HARBOR_LOCAL_X402',
	'HARBOR_LOCAL_X402_MERCHANT_PAY_TO',
	'HARBOR_LOCAL_X402_RUNTIME_ENABLED',
	'HARBOR_LOCAL_X402_SIGNING_PROFILE',
	'MAINNET_EXECUTION',
]);

export interface LocalX402Secrets {
	apiKeys: string;
	kek: string;
	merchantPayTo: string;
}

export class LocalX402SecretFileError extends Error {
	constructor(readonly code:
		| 'INVALID_PRINCIPAL'
		| 'UNSAFE_PATH'
		| 'INVALID_FILE'
		| 'PRINCIPAL_MISMATCH'
		| 'MERCHANT_MISMATCH') {
		super('Local x402 secret file is unavailable');
		this.name = 'LocalX402SecretFileError';
	}
}

type SecretFileDependencies = {
	randomBytes: (size: number) => Uint8Array;
	fsyncSync?: typeof fsyncSync;
	linkSync?: typeof linkSync;
	unlinkSync?: typeof unlinkSync;
};

function fail(code: LocalX402SecretFileError['code']): never {
	throw new LocalX402SecretFileError(code);
}

function sameFile(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function validateParentChain(path: string): void {
	if (typeof process.getuid !== 'function') fail('UNSAFE_PATH');
	const uid = process.getuid();
	let current = path;
	while (true) {
		const metadata = lstatSync(current);
		if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(current) !== current) {
			fail('UNSAFE_PATH');
		}
		// Every traversed directory must be controlled by this user (or root) and
		// immutable to other users. The immediate secrets directory is checked
		// more strictly as 0700 below; ancestors may remain readable/traversable.
		if ((metadata.uid !== uid && metadata.uid !== 0) || (metadata.mode & 0o022) !== 0) {
			fail('UNSAFE_PATH');
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function safeDirectory(path: string): number {
	let descriptor: number | undefined;
	try {
		if (typeof process.getuid !== 'function') fail('UNSAFE_PATH');
		const uid = process.getuid();
		validateParentChain(path);
		const metadata = lstatSync(path);
		if (
			metadata.isSymbolicLink() ||
			!metadata.isDirectory() ||
			realpathSync(path) !== path ||
			(metadata.mode & 0o077) !== 0 || metadata.uid !== uid
		) fail('UNSAFE_PATH');
		if (typeof constants.O_DIRECTORY !== 'number' || typeof constants.O_NOFOLLOW !== 'number') fail('UNSAFE_PATH');
		descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = fstatSync(descriptor);
		if (!opened.isDirectory() || !sameFile(metadata, opened)) fail('UNSAFE_PATH');
		return descriptor;
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (error instanceof LocalX402SecretFileError) throw error;
		fail('UNSAFE_PATH');
	}
}

function safeOwnedUnlink(
	path: string,
	expected: { dev: number | bigint; ino: number | bigint; uid: number | bigint },
	remove: typeof unlinkSync,
): void {
	try {
		const metadata = lstatSync(path);
		if (
			metadata.isSymbolicLink() || !metadata.isFile() || !sameFile(metadata, expected) ||
			Number(metadata.uid) !== Number(expected.uid) ||
			(typeof process.getuid === 'function' && metadata.uid !== process.getuid())
		) return;
		remove(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

function parse(contents: string, principal: string, merchantPayTo: string): LocalX402Secrets {
	const values = new Map<string, string>();
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator <= 0) fail('INVALID_FILE');
		const name = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (
			!EXPECTED_KEYS.has(name) || values.has(name) || value.length === 0 ||
			value.trim() !== value || /[\r\n\0]/.test(value)
		) fail('INVALID_FILE');
		values.set(name, value);
	}
	if (values.size !== EXPECTED_KEYS.size || [...EXPECTED_KEYS].some((name) => !values.has(name))) {
		fail('INVALID_FILE');
	}
	if (
		values.get('EXEC_NETWORK') !== 'testnet' ||
		values.get('MAINNET_EXECUTION') !== 'false' ||
		values.get('HARBOR_LOCAL_READ_ONLY') !== 'true' ||
		values.get('HARBOR_LOCAL_X402') !== 'true' ||
		values.get('HARBOR_LOCAL_X402_RUNTIME_ENABLED') !== 'true' ||
		values.get('HARBOR_LOCAL_X402_SIGNING_PROFILE') !== 'reviewed-testnet-local-v1'
	) fail('INVALID_FILE');

	const apiKeys = values.get('HARBOR_API_KEYS')!;
	const matching = apiKeys.split(',').filter((pair) => pair.startsWith(`${principal}:`));
	if (matching.length !== 1) fail('PRINCIPAL_MISMATCH');
	for (const pair of apiKeys.split(',')) {
		const separator = pair.indexOf(':');
		if (
			separator <= 0 || !PRINCIPAL.test(pair.slice(0, separator)) ||
			!/^[A-Za-z0-9_-]{32,128}$/.test(pair.slice(separator + 1))
		) fail('INVALID_FILE');
	}
	const kek = values.get('HARBOR_KEK')!;
	if (!/^[A-Za-z0-9+/]{43}=$/.test(kek) || Buffer.from(kek, 'base64').length !== 32) {
		fail('INVALID_FILE');
	}
	const configuredMerchantPayTo = values.get('HARBOR_LOCAL_X402_MERCHANT_PAY_TO')!;
	if (!isValidClassicAddress(configuredMerchantPayTo)) fail('INVALID_FILE');
	if (configuredMerchantPayTo !== merchantPayTo) fail('MERCHANT_MISMATCH');
	return { apiKeys, kek, merchantPayTo: configuredMerchantPayTo };
}

function stagingNamePattern(path: string): RegExp {
	const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(`^${escaped}\\.[A-Za-z0-9_-]{24}\\.tmp$`, 'u');
}

function assertNoOrphanedStagingEntries(path: string): void {
	const pattern = stagingNamePattern(path);
	if (readdirSync(dirname(path)).some((name) => pattern.test(name))) {
		fail('INVALID_FILE');
	}
}

function recoverDurableStagingLink(
	path: string,
	directoryDescriptor: number,
	target: ReturnType<typeof fstatSync>,
): void {
	if (target.nlink !== 2 || typeof process.getuid !== 'function') fail('INVALID_FILE');
	const directory = dirname(path);
	const matches = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && stagingNamePattern(path).test(entry.name));
	if (matches.length !== 1) fail('INVALID_FILE');
	const stagingPath = join(directory, matches[0]!.name);
	const staged = lstatSync(stagingPath);
	if (
		staged.isSymbolicLink() || !staged.isFile() || staged.nlink !== 2 ||
		(Number(staged.mode) & 0o777) !== (Number(target.mode) & 0o777) ||
		(Number(staged.mode) & 0o077) !== 0 || Number(staged.uid) !== process.getuid() ||
		Number(staged.size) !== Number(target.size) || !sameFile(staged, target)
	) fail('INVALID_FILE');
	safeOwnedUnlink(stagingPath, target, unlinkSync);
	fsyncSync(directoryDescriptor);
}

function readExisting(
	path: string,
	principal: string,
	merchantPayTo: string,
	directoryDescriptor: number,
): LocalX402Secrets {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const beforeRead = fstatSync(descriptor);
		const permissions = beforeRead.mode & 0o777;
		if (
			!beforeRead.isFile() || (beforeRead.nlink !== 1 && beforeRead.nlink !== 2) ||
			beforeRead.size > LOCAL_X402_SECRET_MAX_BYTES ||
			(permissions !== 0o400 && permissions !== 0o600) ||
			(typeof process.getuid === 'function' && beforeRead.uid !== process.getuid())
		) fail('INVALID_FILE');
		const contents = readFileSync(descriptor, 'utf8');
		const afterRead = fstatSync(descriptor);
		const permissionsAfterRead = afterRead.mode & 0o777;
		if (
			!afterRead.isFile() || afterRead.nlink !== beforeRead.nlink ||
			afterRead.size > LOCAL_X402_SECRET_MAX_BYTES ||
			(permissionsAfterRead !== 0o400 && permissionsAfterRead !== 0o600) ||
			(typeof process.getuid === 'function' && afterRead.uid !== process.getuid()) ||
			Buffer.byteLength(contents, 'utf8') > LOCAL_X402_SECRET_MAX_BYTES
		) fail('INVALID_FILE');
		const parsed = parse(contents, principal, merchantPayTo);
		if (afterRead.nlink === 2) {
			recoverDurableStagingLink(path, directoryDescriptor, afterRead);
			const recovered = fstatSync(descriptor);
			if (recovered.nlink !== 1 || !sameFile(recovered, afterRead)) fail('INVALID_FILE');
		}
		return parsed;
	} catch (error) {
		if (error instanceof LocalX402SecretFileError) throw error;
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
		return fail('INVALID_FILE');
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

/** Internal test seam; production callers must use ensureLocalX402SecretFile. */
export function ensureLocalX402SecretFileAt(
	path: string,
	principal: string,
	merchantPayTo: string,
	dependencies: SecretFileDependencies = { randomBytes },
): LocalX402Secrets {
	if (!PRINCIPAL.test(principal)) fail('INVALID_PRINCIPAL');
	if (!isValidClassicAddress(merchantPayTo)) fail('MERCHANT_MISMATCH');
	const directory = dirname(path);
	const directoryDescriptor = safeDirectory(directory);
	try {
		try {
			return readExisting(path, principal, merchantPayTo, directoryDescriptor);
		} catch (error) {
			if (error instanceof LocalX402SecretFileError) throw error;
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('INVALID_FILE');
		}
		assertNoOrphanedStagingEntries(path);

		const token = base64(dependencies.randomBytes(32)).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
		const kek = base64(dependencies.randomBytes(32));
		const apiKeys = `${principal}:${token}`;
		const contents = [
			`HARBOR_API_KEYS=${apiKeys}`,
			`HARBOR_KEK=${kek}`,
			'EXEC_NETWORK=testnet',
			'MAINNET_EXECUTION=false',
			'HARBOR_LOCAL_READ_ONLY=true',
			'HARBOR_LOCAL_X402=true',
			`HARBOR_LOCAL_X402_MERCHANT_PAY_TO=${merchantPayTo}`,
			'HARBOR_LOCAL_X402_SIGNING_PROFILE=reviewed-testnet-local-v1',
			'HARBOR_LOCAL_X402_RUNTIME_ENABLED=true',
			'',
		].join('\n');
		const stagingToken = base64(dependencies.randomBytes(18))
			.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
		const stagingPath = `${path}.${stagingToken}.tmp`;
		const sync = dependencies.fsyncSync ?? fsyncSync;
		const publish = dependencies.linkSync ?? linkSync;
		const remove = dependencies.unlinkSync ?? unlinkSync;
		let descriptor: number | undefined;
		let staged: ReturnType<typeof fstatSync> | undefined;
		let published = false;
		let durable = false;
		try {
			descriptor = openSync(
				stagingPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600,
			);
			staged = fstatSync(descriptor);
			fchmodSync(descriptor, 0o600);
			if (
				!staged.isFile() || (staged.mode & 0o077) !== 0 ||
				(typeof process.getuid === 'function' && staged.uid !== process.getuid())
			) fail('INVALID_FILE');
			writeFileSync(descriptor, contents, { encoding: 'utf8' });
			sync(descriptor);
			const openedDirectory = fstatSync(directoryDescriptor);
			if (
				realpathSync(directory) !== directory ||
				!sameFile(lstatSync(directory), openedDirectory) ||
				(openedDirectory.mode & 0o077) !== 0 ||
				(typeof process.getuid === 'function' && openedDirectory.uid !== process.getuid())
			) {
				fail('UNSAFE_PATH');
			}
			publish(stagingPath, path);
			published = true;
			sync(directoryDescriptor);
			durable = true;
			safeOwnedUnlink(stagingPath, staged, remove);
			sync(directoryDescriptor);
			return { apiKeys, kek, merchantPayTo };
		} catch {
			if (staged !== undefined) {
				if (published && !durable) safeOwnedUnlink(path, staged, remove);
				safeOwnedUnlink(stagingPath, staged, remove);
				try {
					sync(directoryDescriptor);
				} catch {
					// The original publication failure remains authoritative.
				}
			}
			fail('INVALID_FILE');
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	} catch (error) {
		if (error instanceof LocalX402SecretFileError) throw error;
		fail('INVALID_FILE');
	} finally {
		closeSync(directoryDescriptor);
	}
	return fail('INVALID_FILE');
}

export function ensureLocalX402SecretFile(principal: string, merchantPayTo: string): LocalX402Secrets {
	return ensureLocalX402SecretFileAt(LOCAL_X402_SECRET_FILE, principal, merchantPayTo);
}

export function readLocalX402SecretFile(principal: string, merchantPayTo: string): LocalX402Secrets {
	if (!PRINCIPAL.test(principal)) fail('INVALID_PRINCIPAL');
	if (!isValidClassicAddress(merchantPayTo)) fail('MERCHANT_MISMATCH');
	const descriptor = safeDirectory(dirname(LOCAL_X402_SECRET_FILE));
	try {
		return readExisting(LOCAL_X402_SECRET_FILE, principal, merchantPayTo, descriptor);
	} finally {
		closeSync(descriptor);
	}
}
