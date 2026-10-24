import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isValidClassicAddress } from 'xrpl';
import {
	assertMacAcl,
	assertMacPrivateParentChain,
	type MacAclPolicy,
} from './trading-local-secret-file.ts';
import { assertMacAclFd } from '../../scripts/macos-acl.mjs';
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from '../local-x402-isolated-v1.ts';

export const LOCAL_X402_ISOLATED_SECRET_FILE =
	'/absolute/private/pilot/harbor-secrets/harbor-local-x402-isolated-v1.env.local';
export const PILOT_X402_ISOLATED_CAPABILITY_FILE =
	'/absolute/private/pilot/pilot-secrets/pilot-isolated-x402-capability-v1.env.local';
export const LOCAL_X402_ISOLATED_SECRET_MAX_BYTES = 16_384;
export const LOCAL_X402_ISOLATED_SIGNING_PROFILE = 'reviewed-testnet-isolated-v1';

const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const HARBOR_KEYS = new Set([
	'EXEC_NETWORK',
	'HARBOR_API_KEYS',
	'HARBOR_KEK',
	'HARBOR_LOCAL_AUTH_REQUIRED',
	'HARBOR_LOCAL_CRON_DISABLED',
	'HARBOR_LOCAL_READ_ONLY',
	'HARBOR_LOCAL_X402',
	'HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED',
	'HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE',
	'HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT',
	'HARBOR_LOCAL_X402_MERCHANT_PAY_TO',
	'HARBOR_LOCAL_X402_RUNTIME_ENABLED',
	'HARBOR_LOCAL_X402_SIGNING_PROFILE',
	'MAINNET_EXECUTION',
]);

export interface IsolatedX402Secrets {
	apiCredential: string;
	kek: string;
	merchantPayTo: string;
	stateRoot: string;
}

export interface IsolatedX402SecretInspection {
	secrets: IsolatedX402Secrets;
	pilotCapabilityPresent: boolean;
}

export class IsolatedX402SecretFileError extends Error {
	constructor(readonly code:
		| 'INVALID_PRINCIPAL'
		| 'UNSAFE_PATH'
		| 'INVALID_FILE'
		| 'PRINCIPAL_MISMATCH'
		| 'MERCHANT_MISMATCH'
		| 'STATE_ROOT_MISMATCH'
		| 'CAPABILITY_MISMATCH') {
		super('Local isolated x402 credentials are unavailable');
		this.name = 'IsolatedX402SecretFileError';
	}
}

type SecretDependencies = {
	randomBytes: (size: number) => Uint8Array;
	assertAcl?: (path: string, policy: MacAclPolicy) => void;
	assertAclFd?: (descriptor: number, policy: MacAclPolicy) => void;
};

type SecretInspectionDependencies = Pick<SecretDependencies, 'assertAcl'>;

function fail(code: IsolatedX402SecretFileError['code']): never {
	throw new IsolatedX402SecretFileError(code);
}

function sameFile(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function safeDirectory(
	path: string,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
): number {
	let descriptor: number | undefined;
	try {
		if (typeof process.getuid !== 'function') fail('UNSAFE_PATH');
		assertMacPrivateParentChain(path, checkAcl);
		const metadata = lstatSync(path);
		if (
			metadata.isSymbolicLink() || !metadata.isDirectory() ||
			realpathSync(path) !== path || (metadata.mode & 0o077) !== 0 ||
			metadata.uid !== process.getuid() ||
			typeof constants.O_DIRECTORY !== 'number' ||
			typeof constants.O_NOFOLLOW !== 'number'
		) fail('UNSAFE_PATH');
		descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = fstatSync(descriptor);
		if (!opened.isDirectory() || !sameFile(metadata, opened)) fail('UNSAFE_PATH');
		return descriptor;
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (error instanceof IsolatedX402SecretFileError) throw error;
		fail('UNSAFE_PATH');
	}
}

function values(contents: string, expected: ReadonlySet<string>): Map<string, string> {
	const parsed = new Map<string, string>();
	for (const rawLine of contents.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator <= 0) fail('INVALID_FILE');
		const name = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (
			!expected.has(name) || parsed.has(name) || !value ||
			value.trim() !== value || /[\r\n\0]/u.test(value)
		) fail('INVALID_FILE');
		parsed.set(name, value);
	}
	if (parsed.size !== expected.size || [...expected].some((name) => !parsed.has(name))) {
		fail('INVALID_FILE');
	}
	return parsed;
}

function credential(value: string, principal: string): string {
	if (value.includes(',')) fail('INVALID_FILE');
	const separator = value.indexOf(':');
	if (
		separator <= 0 || value.indexOf(':', separator + 1) !== -1 ||
		value.slice(0, separator) !== principal || !TOKEN.test(value.slice(separator + 1))
	) fail('PRINCIPAL_MISMATCH');
	return value;
}

function parseHarbor(
	contents: string,
	principal: string,
	merchantPayTo: string,
	stateRoot: string,
): IsolatedX402Secrets {
	const parsed = values(contents, HARBOR_KEYS);
	const expected = {
		EXEC_NETWORK: 'testnet',
		MAINNET_EXECUTION: 'false',
		HARBOR_LOCAL_READ_ONLY: 'true',
		HARBOR_LOCAL_AUTH_REQUIRED: 'true',
		HARBOR_LOCAL_CRON_DISABLED: 'true',
		HARBOR_LOCAL_X402: 'true',
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: 'true',
		HARBOR_LOCAL_X402_SIGNING_PROFILE: LOCAL_X402_ISOLATED_SIGNING_PROFILE,
		HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: 'true',
		HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE: LOCAL_X402_ISOLATED_SIGNING_PROFILE,
	};
	for (const [name, value] of Object.entries(expected)) {
		if (parsed.get(name) !== value) fail('INVALID_FILE');
	}
	const configuredMerchant = parsed.get('HARBOR_LOCAL_X402_MERCHANT_PAY_TO')!;
	if (!isValidClassicAddress(configuredMerchant)) fail('INVALID_FILE');
	if (configuredMerchant !== merchantPayTo) fail('MERCHANT_MISMATCH');
	const configuredStateRoot = parsed.get('HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT')!;
	if (configuredStateRoot !== stateRoot) fail('STATE_ROOT_MISMATCH');
	const kek = parsed.get('HARBOR_KEK')!;
	if (!/^[A-Za-z0-9+/]{43}=$/u.test(kek) || Buffer.from(kek, 'base64').length !== 32) {
		fail('INVALID_FILE');
	}
	return {
		apiCredential: credential(parsed.get('HARBOR_API_KEYS')!, principal),
		kek,
		merchantPayTo: configuredMerchant,
		stateRoot: configuredStateRoot,
	};
}

function parsePilot(contents: string, expectedCredential: string): void {
	const parsed = values(contents, new Set(['HARBOR_X402_API_KEY']));
	if (parsed.get('HARBOR_X402_API_KEY') !== expectedCredential) fail('CAPABILITY_MISMATCH');
}

function readExisting(
	path: string,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
): string | null {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = fstatSync(descriptor);
		const mode = before.mode & 0o777;
		if (
			!before.isFile() || before.nlink !== 1 || before.size > LOCAL_X402_ISOLATED_SECRET_MAX_BYTES ||
			(mode !== 0o400 && mode !== 0o600) ||
			(typeof process.getuid === 'function' && before.uid !== process.getuid())
		) fail('INVALID_FILE');
		const named = lstatSync(path);
		if (named.isSymbolicLink() || !sameFile(before, named)) fail('INVALID_FILE');
		checkAcl(path, 'private');
		const contents = readFileSync(descriptor, 'utf8');
		const after = fstatSync(descriptor);
		if (
			!sameFile(before, after) || after.nlink !== 1 || after.size !== before.size ||
			Buffer.byteLength(contents, 'utf8') > LOCAL_X402_ISOLATED_SECRET_MAX_BYTES
		) fail('INVALID_FILE');
		return contents;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		if (error instanceof IsolatedX402SecretFileError) throw error;
		fail('INVALID_FILE');
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	return fail('INVALID_FILE');
}

function safeOwnedUnlink(path: string, expected: ReturnType<typeof fstatSync>): void {
	try {
		const actual = lstatSync(path);
		if (
			actual.isSymbolicLink() || !actual.isFile() || actual.nlink !== 1 ||
			!sameFile(actual, expected) ||
			(typeof process.getuid === 'function' && actual.uid !== process.getuid())
		) return;
		unlinkSync(path);
	} catch {
		// The original publication failure remains authoritative.
	}
}

/** Create one final file directly with O_EXCL; no rename, hard link, or overwrite. */
function publishExclusive(
	path: string,
	contents: string | (() => string),
	directoryDescriptor: number,
	checkAcl: (path: string, policy: MacAclPolicy) => void,
	checkAclFd: (descriptor: number, policy: MacAclPolicy) => void,
): boolean {
	let descriptor: number | undefined;
	let created: ReturnType<typeof fstatSync> | undefined;
	try {
		// Publish the final name with no permissions first. Other same-user
		// readers cannot observe a partially written credential; chmod is the
		// single availability transition after the bytes are durable.
		descriptor = openSync(
			path,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o000,
		);
		created = fstatSync(descriptor);
		if (
			!created.isFile() || created.nlink !== 1 || (created.mode & 0o077) !== 0 ||
			(typeof process.getuid === 'function' && created.uid !== process.getuid())
		) fail('INVALID_FILE');
		const named = lstatSync(path);
		if (named.isSymbolicLink() || !sameFile(created, named)) fail('INVALID_FILE');
		checkAclFd(descriptor, 'private');
		const verified = fstatSync(descriptor);
		if (!sameFile(created, verified) || verified.nlink !== 1) fail('INVALID_FILE');
		const resolvedContents = typeof contents === 'function' ? contents() : contents;
		writeFileSync(descriptor, resolvedContents, 'utf8');
		fsyncSync(descriptor);
		fchmodSync(descriptor, 0o600);
		fsyncSync(descriptor);
		checkAcl(path, 'private');
		const final = fstatSync(descriptor);
		if (!sameFile(created, final) || final.nlink !== 1) fail('INVALID_FILE');
		const parent = fstatSync(directoryDescriptor);
		if (!parent.isDirectory() || !sameFile(lstatSync(dirname(path)), parent)) fail('UNSAFE_PATH');
		fsyncSync(directoryDescriptor);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST' && created === undefined) return false;
		if (created !== undefined) safeOwnedUnlink(path, created);
		if (error instanceof IsolatedX402SecretFileError) throw error;
		fail('INVALID_FILE');
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	return fail('INVALID_FILE');
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function harborContents(
	principal: string,
	token: string,
	kek: string,
	merchantPayTo: string,
	stateRoot: string,
): string {
	return [
		`HARBOR_API_KEYS=${principal}:${token}`,
		`HARBOR_KEK=${kek}`,
		'EXEC_NETWORK=testnet',
		'MAINNET_EXECUTION=false',
		'HARBOR_LOCAL_READ_ONLY=true',
		'HARBOR_LOCAL_AUTH_REQUIRED=true',
		'HARBOR_LOCAL_CRON_DISABLED=true',
		'HARBOR_LOCAL_X402=true',
		`HARBOR_LOCAL_X402_MERCHANT_PAY_TO=${merchantPayTo}`,
		'HARBOR_LOCAL_X402_RUNTIME_ENABLED=true',
		`HARBOR_LOCAL_X402_SIGNING_PROFILE=${LOCAL_X402_ISOLATED_SIGNING_PROFILE}`,
		'HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED=true',
		`HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE=${LOCAL_X402_ISOLATED_SIGNING_PROFILE}`,
		`HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT=${stateRoot}`,
		'',
	].join('\n');
}

function validateStateRoot(stateRoot: string): void {
	if (
		!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || stateRoot.trim() !== stateRoot ||
		/[\r\n\0]/u.test(stateRoot)
	) fail('STATE_ROOT_MISMATCH');
}

/** Read-only test seam for binding validation before any state mutation. */
export function inspectExistingIsolatedX402SecretsAt(
	harborPath: string,
	pilotPath: string,
	principal: string,
	merchantPayTo: string,
	stateRoot: string,
	dependencies: SecretInspectionDependencies = {},
): IsolatedX402SecretInspection | null {
	if (!PRINCIPAL.test(principal) || principal === 'local-dev') fail('INVALID_PRINCIPAL');
	if (
		!isValidClassicAddress(merchantPayTo) ||
		merchantPayTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO
	) fail('MERCHANT_MISMATCH');
	validateStateRoot(stateRoot);
	if (harborPath === pilotPath || dirname(harborPath) !== dirname(pilotPath)) fail('UNSAFE_PATH');
	const checkAcl = dependencies.assertAcl ?? assertMacAcl;
	const directoryDescriptor = safeDirectory(dirname(harborPath), checkAcl);
	try {
		const harbor = readExisting(harborPath, checkAcl);
		const pilot = readExisting(pilotPath, checkAcl);
		if (harbor === null && pilot === null) return null;
		if (harbor === null) fail('INVALID_FILE');
		const secrets = parseHarbor(harbor, principal, merchantPayTo, stateRoot);
		if (pilot !== null) parsePilot(pilot, secrets.apiCredential);
		return { secrets, pilotCapabilityPresent: pilot !== null };
	} finally {
		closeSync(directoryDescriptor);
	}
}

/** Internal test seam. Production callers must use the fixed-path wrapper. */
export function materializeIsolatedX402SecretsAt(
	harborPath: string,
	pilotPath: string,
	principal: string,
	merchantPayTo: string,
	stateRoot: string,
	dependencies: SecretDependencies = { randomBytes },
): IsolatedX402Secrets {
	if (!PRINCIPAL.test(principal) || principal === 'local-dev') fail('INVALID_PRINCIPAL');
	if (
		!isValidClassicAddress(merchantPayTo) ||
		merchantPayTo !== LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO
	) fail('MERCHANT_MISMATCH');
	validateStateRoot(stateRoot);
	if (harborPath === pilotPath || dirname(harborPath) !== dirname(pilotPath)) fail('UNSAFE_PATH');
	const directory = dirname(harborPath);
	const checkAcl = dependencies.assertAcl ?? assertMacAcl;
	const checkAclFd = dependencies.assertAclFd ?? assertMacAclFd;
	const directoryDescriptor = safeDirectory(directory, checkAcl);
	try {
		let existing = readExisting(harborPath, checkAcl);
		if (existing === null && readExisting(pilotPath, checkAcl) !== null) fail('INVALID_FILE');
		if (existing === null) {
			publishExclusive(
				harborPath,
				() => {
					const token = base64(dependencies.randomBytes(32))
						.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
					const kek = base64(dependencies.randomBytes(32));
					if (!TOKEN.test(token) || !/^[A-Za-z0-9+/]{43}=$/u.test(kek)) fail('INVALID_FILE');
					return harborContents(principal, token, kek, merchantPayTo, stateRoot);
				},
				directoryDescriptor,
				checkAcl,
				checkAclFd,
			);
			existing = readExisting(harborPath, checkAcl);
			if (existing === null) fail('INVALID_FILE');
		}
		const secrets = parseHarbor(existing, principal, merchantPayTo, stateRoot);
		const pilotContents = `HARBOR_X402_API_KEY=${secrets.apiCredential}\n`;
		if (readExisting(pilotPath, checkAcl) === null) {
			publishExclusive(
				pilotPath,
				pilotContents,
				directoryDescriptor,
				checkAcl,
				checkAclFd,
			);
		}
		const pilot = readExisting(pilotPath, checkAcl);
		if (pilot === null) fail('INVALID_FILE');
		parsePilot(pilot, secrets.apiCredential);
		return secrets;
	} finally {
		closeSync(directoryDescriptor);
	}
}

export function materializeIsolatedX402Secrets(
	principal: string,
	merchantPayTo: string,
	stateRoot: string,
): IsolatedX402Secrets {
	return materializeIsolatedX402SecretsAt(
		LOCAL_X402_ISOLATED_SECRET_FILE,
		PILOT_X402_ISOLATED_CAPABILITY_FILE,
		principal,
		merchantPayTo,
		stateRoot,
	);
}

export function inspectExistingIsolatedX402Secrets(
	principal: string,
	merchantPayTo: string,
	stateRoot: string,
): IsolatedX402SecretInspection | null {
	return inspectExistingIsolatedX402SecretsAt(
		LOCAL_X402_ISOLATED_SECRET_FILE,
		PILOT_X402_ISOLATED_CAPABILITY_FILE,
		principal,
		merchantPayTo,
		stateRoot,
	);
}
