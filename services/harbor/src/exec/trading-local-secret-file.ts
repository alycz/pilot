import { randomBytes } from 'node:crypto';
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import {
	assertMacAcl as sharedAssertMacAcl,
	validateMacAclResult as sharedValidateMacAclResult,
} from '../../scripts/macos-acl.mjs';

export const LOCAL_TRADING_SECRET_FILE =
	(process.env.HARBOR_PRIVATE_SECRETS_ROOT ? `${process.env.HARBOR_PRIVATE_SECRETS_ROOT}/harbor-local-trading.env.local` : "/dev/null/pilot-disabled/harbor-local-trading.env.local");

const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ProvisionDependencies = {
	randomBytes: (size: number) => Uint8Array;
	assertAcl?: (path: string, policy: MacAclPolicy) => void;
	fsyncSync?: typeof fsyncSync;
	linkSync?: typeof linkSync;
	unlinkSync?: typeof unlinkSync;
};

export class LocalTradingSecretProvisionError extends Error {
	constructor(readonly code:
		| 'INVALID_PRINCIPAL'
		| 'UNSAFE_PATH'
		| 'UNSAFE_ACL'
		| 'UNSUPPORTED_PLATFORM'
		| 'ALREADY_EXISTS'
		| 'PUBLISH_FAILED') {
		super('Local trading credentials could not be provisioned');
		this.name = 'LocalTradingSecretProvisionError';
	}
}

export type MacAclPolicy = 'ancestor' | 'private';

export function validateMacAclResult(result: string, policy: MacAclPolicy): void {
	try {
		sharedValidateMacAclResult(result, policy);
	} catch {
		fail('UNSAFE_ACL');
	}
}

export function assertMacAcl(path: string, policy: MacAclPolicy): void {
	try {
		sharedAssertMacAcl(path, policy);
	} catch (error) {
		if (error instanceof LocalTradingSecretProvisionError) throw error;
		if (error instanceof Error && error.message === 'UNSUPPORTED_PLATFORM') {
			fail('UNSUPPORTED_PLATFORM');
		}
		fail('UNSAFE_ACL');
	}
}

function fail(code: LocalTradingSecretProvisionError['code']): never {
	throw new LocalTradingSecretProvisionError(code);
}

function sameFile(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function assertMacPrivateParentChain(
	path: string,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
): void {
	if (typeof process.getuid !== 'function') fail('UNSAFE_PATH');
	const uid = process.getuid();
	let current = path;
	let immediate = true;
	while (true) {
		const metadata = lstatSync(current);
		if (
			metadata.isSymbolicLink() || !metadata.isDirectory() ||
			realpathSync(current) !== current ||
			(metadata.uid !== uid && metadata.uid !== 0) ||
			(metadata.mode & 0o022) !== 0
		) fail('UNSAFE_PATH');
		checkAcl(current, immediate ? 'private' : 'ancestor');
		immediate = false;
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function openSafeDirectory(
	path: string,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
): number {
	let descriptor: number | undefined;
	try {
		if (
			typeof process.getuid !== 'function' ||
			typeof constants.O_DIRECTORY !== 'number' ||
			typeof constants.O_NOFOLLOW !== 'number'
		) fail('UNSAFE_PATH');
		assertMacPrivateParentChain(path, checkAcl);
		const metadata = lstatSync(path);
		if (
			metadata.isSymbolicLink() || !metadata.isDirectory() ||
			realpathSync(path) !== path || metadata.uid !== process.getuid() ||
			(metadata.mode & 0o777) !== 0o700
		) fail('UNSAFE_PATH');
		descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = fstatSync(descriptor);
		if (!opened.isDirectory() || !sameFile(metadata, opened)) fail('UNSAFE_PATH');
		return descriptor;
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (error instanceof LocalTradingSecretProvisionError) throw error;
		fail('UNSAFE_PATH');
	}
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function base64url(bytes: Uint8Array): string {
	return base64(bytes).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function stagingPattern(path: string): RegExp {
	const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(`^${escaped}\\.[A-Za-z0-9_-]{24}\\.tmp$`, 'u');
}

function stagingEntries(path: string): string[] {
	const pattern = stagingPattern(path);
	return readdirSync(dirname(path)).filter((name) => pattern.test(name));
}

function targetAbsent(path: string): void {
	try {
		lstatSync(path);
		fail('ALREADY_EXISTS');
	} catch (error) {
		if (error instanceof LocalTradingSecretProvisionError) throw error;
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('UNSAFE_PATH');
	}
	if (stagingEntries(path).length !== 0) {
		fail('ALREADY_EXISTS');
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
			metadata.isSymbolicLink() || !metadata.isFile() ||
			!sameFile(metadata, expected) || metadata.uid !== expected.uid ||
			(typeof process.getuid === 'function' && metadata.uid !== process.getuid())
		) return;
		remove(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

function revalidateDirectory(
	path: string,
	descriptor: number,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
): void {
	if (typeof process.getuid !== 'function') fail('UNSAFE_PATH');
	assertMacPrivateParentChain(path, checkAcl);
	const opened = fstatSync(descriptor);
	const current = lstatSync(path);
	if (
		!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink() ||
		realpathSync(path) !== path || !sameFile(opened, current) ||
		opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o700
	) fail('UNSAFE_PATH');
}

type ProvisionLock = {
	path: string;
	descriptor: number;
	metadata: ReturnType<typeof fstatSync>;
};

function acquireProvisionLock(
	path: string,
	directoryDescriptor: number,
	sync: typeof fsyncSync,
	remove: typeof unlinkSync,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
): ProvisionLock {
	const lockPath = `${path}.provision.lock`;
	let descriptor: number | undefined;
	let metadata: ReturnType<typeof fstatSync> | undefined;
	try {
		descriptor = openSync(
			lockPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		fchmodSync(descriptor, 0o600);
		metadata = fstatSync(descriptor);
		if (
			!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== 0 ||
			(metadata.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === 'function' && metadata.uid !== process.getuid())
		) fail('PUBLISH_FAILED');
		const namedLock = lstatSync(lockPath);
		if (!sameFile(metadata, namedLock) || namedLock.isSymbolicLink()) fail('PUBLISH_FAILED');
		checkAcl(lockPath, 'private');
		const verifiedLock = fstatSync(descriptor);
		if (!sameFile(metadata, verifiedLock) || verifiedLock.nlink !== 1) fail('PUBLISH_FAILED');
		sync(descriptor);
		sync(directoryDescriptor);
		return { path: lockPath, descriptor, metadata };
	} catch (error) {
		if (metadata !== undefined) {
			try {
				safeOwnedUnlink(lockPath, metadata, remove);
				sync(directoryDescriptor);
			} catch {
				// A verified lock residue deliberately blocks every future attempt.
			}
		}
		if (descriptor !== undefined) closeSync(descriptor);
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_EXISTS');
		if (error instanceof LocalTradingSecretProvisionError) throw error;
		fail('PUBLISH_FAILED');
	}
}

function releaseProvisionLock(
	lock: ProvisionLock,
	directoryDescriptor: number,
	sync: typeof fsyncSync,
	remove: typeof unlinkSync,
): void {
	try {
		safeOwnedUnlink(lock.path, lock.metadata, remove);
		sync(directoryDescriptor);
	} catch {
		fail('PUBLISH_FAILED');
	} finally {
		closeSync(lock.descriptor);
	}
}

/** Internal test seam. Production callers must use provisionLocalTradingSecretFile. */
export function provisionLocalTradingSecretFileAt(
	path: string,
	principal: string,
	dependencies: ProvisionDependencies = { randomBytes },
): { path: string; principal: string } {
	if (!PRINCIPAL.test(principal) || principal === 'local-dev') fail('INVALID_PRINCIPAL');
	const directory = dirname(path);
	const checkAcl = dependencies.assertAcl ?? assertMacAcl;
	const directoryDescriptor = openSafeDirectory(directory, checkAcl);
	const sync = dependencies.fsyncSync ?? fsyncSync;
	const publish = dependencies.linkSync ?? linkSync;
	const remove = dependencies.unlinkSync ?? unlinkSync;
	let lock: ProvisionLock | undefined;
	try {
		lock = acquireProvisionLock(path, directoryDescriptor, sync, remove, checkAcl);
		targetAbsent(path);
		const stagingPath = `${path}.${base64url(dependencies.randomBytes(18))}.tmp`;
		let descriptor: number | undefined;
		let staged: ReturnType<typeof fstatSync> | undefined;
		let published = false;
		try {
			descriptor = openSync(
				stagingPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600,
			);
			fchmodSync(descriptor, 0o600);
			staged = fstatSync(descriptor);
			if (
				!staged.isFile() || staged.nlink !== 1 || (staged.mode & 0o777) !== 0o600 ||
				(typeof process.getuid === 'function' && staged.uid !== process.getuid())
			) fail('PUBLISH_FAILED');
			const stagesAfterOpen = stagingEntries(path);
			if (stagesAfterOpen.length !== 1 || stagesAfterOpen[0] !== basename(stagingPath)) {
				fail('PUBLISH_FAILED');
			}
			revalidateDirectory(directory, directoryDescriptor, checkAcl);
			const namedStage = lstatSync(stagingPath);
			if (namedStage.isSymbolicLink() || !sameFile(staged, namedStage)) fail('PUBLISH_FAILED');
			checkAcl(stagingPath, 'private');
			const verifiedStage = fstatSync(descriptor);
			if (!sameFile(staged, verifiedStage) || verifiedStage.nlink !== 1) fail('PUBLISH_FAILED');

			const token = base64url(dependencies.randomBytes(32));
			const kek = base64(dependencies.randomBytes(32));
			if (
				!/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
				!/^[A-Za-z0-9+/]{43}=$/.test(kek) || Buffer.from(kek, 'base64').length !== 32
			) fail('PUBLISH_FAILED');
			const contents = `HARBOR_API_KEYS=${principal}:${token}\nHARBOR_KEK=${kek}\n`;
			const contentsBytes = Buffer.byteLength(contents, 'utf8');
			writeFileSync(descriptor, contents, { encoding: 'utf8' });
			sync(descriptor);
			revalidateDirectory(directory, directoryDescriptor, checkAcl);
			publish(stagingPath, path);
			published = true;
			const openedAfterLink = fstatSync(descriptor);
			const stagingAfterLink = lstatSync(stagingPath);
			const targetAfterLink = lstatSync(path);
			if (
				!openedAfterLink.isFile() || !stagingAfterLink.isFile() || !targetAfterLink.isFile() ||
				stagingAfterLink.isSymbolicLink() || targetAfterLink.isSymbolicLink() ||
				!sameFile(openedAfterLink, stagingAfterLink) ||
				!sameFile(openedAfterLink, targetAfterLink) ||
				openedAfterLink.nlink !== 2 || stagingAfterLink.nlink !== 2 || targetAfterLink.nlink !== 2 ||
				openedAfterLink.size !== contentsBytes || stagingAfterLink.size !== contentsBytes ||
				targetAfterLink.size !== contentsBytes ||
				(openedAfterLink.mode & 0o777) !== 0o600 ||
				(typeof process.getuid === 'function' && openedAfterLink.uid !== process.getuid())
			) fail('PUBLISH_FAILED');
			safeOwnedUnlink(stagingPath, openedAfterLink, remove);
			if (stagingEntries(path).length !== 0) fail('PUBLISH_FAILED');
			const openedFinal = fstatSync(descriptor);
			const targetFinal = lstatSync(path);
			if (
				!openedFinal.isFile() || !targetFinal.isFile() || targetFinal.isSymbolicLink() ||
				!sameFile(openedFinal, targetFinal) || openedFinal.nlink !== 1 || targetFinal.nlink !== 1 ||
				openedFinal.size !== contentsBytes || targetFinal.size !== contentsBytes ||
				(openedFinal.mode & 0o777) !== 0o600 ||
				(typeof process.getuid === 'function' && openedFinal.uid !== process.getuid())
			) fail('PUBLISH_FAILED');
			revalidateDirectory(directory, directoryDescriptor, checkAcl);
			sync(directoryDescriptor);
			return { path, principal };
		} catch (error) {
			if (staged !== undefined) {
				try {
					if (published) safeOwnedUnlink(path, staged, remove);
				} catch {
					// Continue attempting to remove only the verified staging inode.
				}
				try {
					safeOwnedUnlink(stagingPath, staged, remove);
				} catch {
					// A residue remains fail-closed for explicit operator recovery.
				}
				try {
					sync(directoryDescriptor);
				} catch {
					// The original failure remains authoritative.
				}
			}
			if (error instanceof LocalTradingSecretProvisionError) throw error;
			fail('PUBLISH_FAILED');
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	} finally {
		try {
			if (lock !== undefined) releaseProvisionLock(lock, directoryDescriptor, sync, remove);
		} finally {
			closeSync(directoryDescriptor);
		}
	}
	return fail('PUBLISH_FAILED');
}

export function provisionLocalTradingSecretFile(principal: string): { path: string; principal: string } {
	return provisionLocalTradingSecretFileAt(LOCAL_TRADING_SECRET_FILE, principal);
}
