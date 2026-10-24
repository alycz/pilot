import {
	constants,
	lstatSync,
	mkdirSync,
	openSync,
	closeSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const LOCAL_X402_STATE_MODE = 0o700;

export class LocalX402StateError extends Error {
	constructor() {
		super("Local x402 state is missing ownership or permission isolation");
		this.name = "LocalX402StateError";
	}
}

function fail() {
	throw new LocalX402StateError();
}

function currentUid() {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function metadata(path) {
	try {
		return lstatSync(path);
	} catch {
		fail();
	}
}

function assertCanonicalDirectory(path, { privateDirectory = false } = {}) {
	const value = metadata(path);
	const uid = currentUid();
	const permissions = value.mode & 0o777;
	if (
		value.isSymbolicLink() ||
		!value.isDirectory() ||
		realpathSync(path) !== path ||
		(permissions & 0o022) !== 0 ||
		(privateDirectory && permissions !== LOCAL_X402_STATE_MODE) ||
		(uid !== undefined && value.uid !== uid && value.uid !== 0) ||
		(privateDirectory && uid !== undefined && value.uid !== uid)
	) {
		fail();
	}
	return value;
}

function ancestors(path) {
	const paths = [];
	let current = path;
	while (true) {
		paths.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return paths.reverse();
}

function assertPrivateStateEntry(path) {
	const value = metadata(path);
	const uid = currentUid();
	if (
		value.isSymbolicLink() ||
		(uid !== undefined && value.uid !== uid) ||
		(value.mode & 0o077) !== 0
	) {
		fail();
	}
	if (value.isDirectory()) {
		if (realpathSync(path) !== path) fail();
		return "directory";
	}
	if (!value.isFile() || value.nlink !== 1 || realpathSync(path) !== path) fail();
	return "file";
}

function assertPrivateStateTree(path) {
	if (assertPrivateStateEntry(path) !== "directory") fail();
	for (const entry of readdirSync(path)) {
		const child = resolve(path, entry);
		if (assertPrivateStateEntry(child) === "directory") assertPrivateStateTree(child);
	}
}

/**
 * Create and validate the fixed local x402 persistence tree before a process
 * that may write to it starts. Missing path components are made owner-only;
 * existing components are never chmodded, replaced, or redirected.
 */
export function ensureLocalX402StateDirectory(path) {
	if (!isAbsolute(path) || resolve(path) !== path) fail();
	const chain = ancestors(path);
	let missing = false;
	for (let index = 0; index < chain.length; index += 1) {
		const component = chain[index];
		if (!missing) {
			try {
				assertCanonicalDirectory(component, {
					privateDirectory: component === path,
				});
				continue;
			} catch (error) {
				if (!(error instanceof LocalX402StateError)) throw error;
				try {
					lstatSync(component);
				} catch (cause) {
					if (cause?.code === "ENOENT") {
						missing = true;
					} else {
						fail();
					}
				}
				if (!missing) throw error;
			}
		}
		try {
			mkdirSync(component, { mode: LOCAL_X402_STATE_MODE });
			assertCanonicalDirectory(component, { privateDirectory: true });
		} catch {
			fail();
		}
	}
	assertPrivateStateTree(path);
	return path;
}

/** Validate one already-existing state entry without following links. */
export function assertLocalX402StatePath(path, kind) {
	try {
		const actual = assertPrivateStateEntry(path);
		if (actual !== kind) fail();
		if (kind === "file") {
			if (typeof constants.O_NOFOLLOW !== "number") fail();
			const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			closeSync(descriptor);
		}
	} catch {
		fail();
	}
}

/** Validate an existing state root, its canonical ancestors, and every entry. */
export function validateLocalX402StateTree(path) {
	if (!isAbsolute(path) || resolve(path) !== path) fail();
	for (const component of ancestors(path)) {
		assertCanonicalDirectory(component, { privateDirectory: component === path });
	}
	assertPrivateStateTree(path);
}
