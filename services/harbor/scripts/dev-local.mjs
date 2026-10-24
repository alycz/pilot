#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { isValidClassicAddress } from "xrpl";
import { ensureLocalX402StateDirectory } from "./local-x402-state.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LOCAL_PORT = 8791;
export const LOCAL_HOST = "127.0.0.1";
export const LOCAL_ORIGIN = `http://${LOCAL_HOST}:${LOCAL_PORT}`;
export const LOCAL_HEALTH_URL = `${LOCAL_ORIGIN}/health`;
const LOCAL_PROCESS_HEALTH_URLS = Object.freeze([
	LOCAL_HEALTH_URL,
	"http://127.0.0.2:8791/health",
	"http://127.0.0.2:8792/health",
]);
export const LOCAL_STATE_DIRECTORY = ".wrangler/harbor-local";
export const LOCAL_X402_STATE_DIRECTORY = ".wrangler/harbor-local-x402";
export const LOCAL_FILE_UMASK = 0o077;
export const LOCAL_X402_SECRET_FILE =
	(process.env.HARBOR_PRIVATE_SECRETS_ROOT ? resolve(process.env.HARBOR_PRIVATE_SECRETS_ROOT, "harbor-local-x402.env.local") : "/dev/null/pilot-disabled/harbor-local-x402.env.local");
export const LOCAL_PROFILES = Object.freeze({
	READ_ONLY: "read-only",
	X402_SIGNING: "x402-signing",
});

const LOCAL_CONFIG = "wrangler.local.jsonc";
const LOCAL_X402_CONFIG = "wrangler.local-x402.jsonc";
const LOCAL_EMPTY_ENV = "config/local-empty.env";
const X402_SIGNING_PROFILE = "reviewed-testnet-local-v1";
const X402_SECRET_KEYS = new Set([
	"EXEC_NETWORK",
	"HARBOR_API_KEYS",
	"HARBOR_KEK",
	"HARBOR_LOCAL_READ_ONLY",
	"HARBOR_LOCAL_X402",
	"HARBOR_LOCAL_X402_MERCHANT_PAY_TO",
	"HARBOR_LOCAL_X402_RUNTIME_ENABLED",
	"HARBOR_LOCAL_X402_SIGNING_PROFILE",
	"MAINNET_EXECUTION",
]);
const X402_REQUIRED_SECRET_VALUES = Object.freeze({
	EXEC_NETWORK: "testnet",
	HARBOR_LOCAL_READ_ONLY: "true",
	HARBOR_LOCAL_X402: "true",
	HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
	HARBOR_LOCAL_X402_SIGNING_PROFILE: X402_SIGNING_PROFILE,
	MAINNET_EXECUTION: "false",
});

const CHILD_ENV_ALLOWLIST = [
	"PATH",
	// Node needs these to locate system executables and DLLs on Windows.
	...(process.platform === "win32" ? ["COMSPEC", "PATHEXT", "SystemRoot", "WINDIR"] : []),
];
const CLEANUP_GRACE_MS = 2_000;
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_RETRY_MS = 100;
const READINESS_ATTEMPT_TIMEOUT_MS = 1_000;
const READINESS_BODY_MAX_BYTES = 1_024;
export const LOCAL_X402_SECRET_MAX_BYTES = 16_384;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SESSION_LOSS_EVENT = "disconnect";
const FORBIDDEN_ARGUMENT =
	/^(?:--?)?(?:deploy|publish|remote|tunnel)(?:$|[=:-])/i;

/**
 * Build the deliberately sparse environment inherited by every local child.
 * This is an allowlist, rather than a credential denylist: unknown variables,
 * proxy settings, cloud configuration, and future secret names stay excluded.
 */
export function sanitizedChildEnvironment(
	source = process.env,
	profile = LOCAL_PROFILES.READ_ONLY,
) {
	validateProfile(profile);
	const sanitized = {};
	for (const name of CHILD_ENV_ALLOWLIST) {
		const value = source[name];
		if (value !== undefined) sanitized[name] = value;
	}

	return {
		...sanitized,
		CI: "1",
		CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
		// Wrangler 4.151.1 uses this gate even when --env-file is explicit.
		// Every validated Wrangler command below supplies its exact reviewed file.
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
		DO_NOT_TRACK: "1",
		NODE_ENV: "development",
		WRANGLER_LOG_PATH: join(
			REPO_ROOT,
			profile === LOCAL_PROFILES.X402_SIGNING
				? LOCAL_X402_STATE_DIRECTORY
				: LOCAL_STATE_DIRECTORY,
			"wrangler.log",
		),
		WRANGLER_SEND_ERROR_REPORTS: "false",
		WRANGLER_SEND_METRICS: "false",
	};
}

export function enforceLocalFileUmask(setUmask = process.umask) {
	setUmask(LOCAL_FILE_UMASK);
}

export function validateLocalArguments(args) {
	const forbidden = args.find((arg) => FORBIDDEN_ARGUMENT.test(arg));
	if (forbidden !== undefined) {
		throw new Error("Local Harbor refuses remote, tunnel, and deploy arguments");
	}
	if (args.length > 0) {
		throw new Error("Local Harbor does not accept command-line overrides");
	}
}

function validateProfile(profile) {
	if (profile !== LOCAL_PROFILES.READ_ONLY && profile !== LOCAL_PROFILES.X402_SIGNING) {
		throw new Error("Unknown local Harbor profile");
	}
}

export function localCommands(
	repoRoot = REPO_ROOT,
	{ profile = LOCAL_PROFILES.READ_ONLY } = {},
) {
	validateProfile(profile);
	const signingEnabled = profile === LOCAL_PROFILES.X402_SIGNING;
	const config = join(repoRoot, signingEnabled ? LOCAL_X402_CONFIG : LOCAL_CONFIG);
	const emptyEnv = join(repoRoot, LOCAL_EMPTY_ENV);
	const persistence = join(
		repoRoot,
		signingEnabled ? LOCAL_X402_STATE_DIRECTORY : LOCAL_STATE_DIRECTORY,
	);
	const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
	const commonWranglerArgs = [
		"--config",
		config,
	];

	return [
		{
			label: "catalog",
			command: process.execPath,
			args: [join(repoRoot, "scripts", "build-catalog.mjs")],
		},
		{
			label: "local D1 migrations",
			command: process.execPath,
			args: [
				wrangler,
				"d1",
				"migrations",
				"apply",
				"DB",
				"--local",
				"--persist-to",
				persistence,
				...commonWranglerArgs,
				"--env-file",
				emptyEnv,
			],
		},
		{
			label: "loopback Worker",
			command: process.execPath,
			readinessUrl: LOCAL_HEALTH_URL,
			args: [
				wrangler,
				"dev",
				"--local",
				"--ip",
				LOCAL_HOST,
				"--inspector-ip",
				LOCAL_HOST,
				"--port",
				String(LOCAL_PORT),
				"--persist-to",
				persistence,
				"--show-interactive-dev-session=false",
				...commonWranglerArgs,
				"--env-file",
				signingEnabled ? LOCAL_X402_SECRET_FILE : emptyEnv,
			],
		},
	];
}

function sameKeys(value, expected) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...expected].sort();
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index])
	);
}

export function validateLocalConfiguration(config, profile = LOCAL_PROFILES.READ_ONLY) {
	validateProfile(profile);
	const signingEnabled = profile === LOCAL_PROFILES.X402_SIGNING;
	if (
		!sameKeys(config, [
			"$schema",
			"compatibility_date",
			"compatibility_flags",
			"d1_databases",
			"main",
			"name",
			"vars",
		]) ||
		config.$schema !== "node_modules/wrangler/config-schema.json" ||
		config.main !== "src/server.ts" ||
		config.name !== (signingEnabled ? "harbor-local-x402-only" : "harbor-local-only") ||
		config.compatibility_date !== "2026-10-06" ||
		!Array.isArray(config.compatibility_flags) ||
		config.compatibility_flags.length !== 1 ||
		config.compatibility_flags[0] !== "nodejs_compat"
	) {
		throw new Error("Local Harbor configuration is not the reviewed isolated profile");
	}

	if (
		!Array.isArray(config.d1_databases) ||
		config.d1_databases.length !== 1 ||
		!sameKeys(config.d1_databases[0], [
			"binding",
			"database_id",
			"database_name",
			"migrations_dir",
			"remote",
		])
	) {
		throw new Error("Local Harbor D1 configuration is not isolated");
	}
	const database = config.d1_databases[0];
	if (
		database.binding !== "DB" ||
		database.database_name !== "harbor-local-only" ||
		database.database_id !== "00000000-0000-0000-0000-000000000000" ||
		database.migrations_dir !== "migrations-local-x402" ||
		database.remote !== false
	) {
		throw new Error("Local Harbor D1 configuration is not isolated");
	}

	const expectedVars = {
		EXEC_NETWORK: "testnet",
		EXECUTOR: "quickjs",
		HARBOR_LOCAL_DEV: "true",
		HARBOR_LOCAL_READ_ONLY: "true",
		HARBOR_LOCAL_X402: "true",
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: signingEnabled ? "true" : "false",
		HARBOR_SOURCE_TAG: "2610240",
		MAINNET_EXECUTION: "false",
		...(signingEnabled
			? { HARBOR_LOCAL_X402_SIGNING_PROFILE: X402_SIGNING_PROFILE }
			: {}),
	};
	if (!sameKeys(config.vars, Object.keys(expectedVars))) {
		throw new Error("Local Harbor runtime variables are not the reviewed profile");
	}
	for (const [name, value] of Object.entries(expectedVars)) {
		if (config.vars[name] !== value) {
			throw new Error("Local Harbor runtime variables are not the reviewed profile");
		}
	}
}

export async function validateLocalConfigurationFile(
	repoRoot = REPO_ROOT,
	profile = LOCAL_PROFILES.READ_ONLY,
) {
	validateProfile(profile);
	const path = join(
		repoRoot,
		profile === LOCAL_PROFILES.X402_SIGNING ? LOCAL_X402_CONFIG : LOCAL_CONFIG,
	);
	let config;
	try {
		config = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Local Harbor configuration could not be loaded");
	}
	validateLocalConfiguration(config, profile);
}

function invalidSecretFile() {
	return new Error("Local x402 secret file is missing or unsafe");
}

async function x402SecretDirectoryMetadata(path) {
	const metadata = await lstat(path);
	if (
		metadata.isSymbolicLink() ||
		!metadata.isDirectory() ||
		(await realpath(path)) !== path
	) {
		throw invalidSecretFile();
	}
	return metadata;
}

export async function validateX402SecretParentChain(
	path = dirname(LOCAL_X402_SECRET_FILE),
) {
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const immediate = await x402SecretDirectoryMetadata(path);
	if (
		(immediate.mode & 0o777) !== 0o700 ||
		(currentUid !== undefined && immediate.uid !== currentUid)
	) {
		throw invalidSecretFile();
	}

	let ancestor = dirname(path);
	while (true) {
		const metadata = await x402SecretDirectoryMetadata(ancestor);
		if (
			(metadata.mode & 0o022) !== 0 ||
			(currentUid !== undefined && metadata.uid !== currentUid && metadata.uid !== 0)
		) {
			throw invalidSecretFile();
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
}

function safeX402SecretMetadata(metadata) {
	const permissions = metadata.mode & 0o777;
	return (
		!metadata.isSymbolicLink() &&
		metadata.isFile() &&
		metadata.nlink === 1 &&
		metadata.size <= LOCAL_X402_SECRET_MAX_BYTES &&
		(permissions === 0o400 || permissions === 0o600) &&
		(typeof process.getuid !== "function" || metadata.uid === process.getuid())
	);
}

function parseX402SecretFile(contents) {
	const values = Object.create(null);
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw invalidSecretFile();
		const name = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (
			!/^[A-Z][A-Z0-9_]*$/.test(name) ||
			!X402_SECRET_KEYS.has(name) ||
			Object.prototype.hasOwnProperty.call(values, name) ||
			value.length === 0 ||
			value !== value.trim() ||
			/[\r\n\0]/.test(value)
		) {
			throw invalidSecretFile();
		}
		values[name] = value;
	}

	if (!sameKeys(values, X402_SECRET_KEYS)) throw invalidSecretFile();
	for (const [name, expected] of Object.entries(X402_REQUIRED_SECRET_VALUES)) {
		if (values[name] !== expected) throw invalidSecretFile();
	}
	const apiKeys = values.HARBOR_API_KEYS.split(",");
	if (
		values.HARBOR_API_KEYS.length > 8_192 ||
		apiKeys.length === 0 ||
		apiKeys.some((pair) => {
			const separator = pair.indexOf(":");
			const principal = pair.slice(0, separator);
			const credential = pair.slice(separator + 1);
			return (
				separator <= 0 ||
				!/^[A-Za-z0-9._-]{1,64}$/.test(principal) ||
				principal === "local-dev" ||
				credential.length < 16 ||
				credential.length > 512 ||
				!/^[\x21-\x7e]+$/.test(credential) ||
				credential.includes(",")
			);
		})
	) {
		throw invalidSecretFile();
	}
	const kek = values.HARBOR_KEK;
	const decodedKek = Buffer.from(kek, "base64");
	if (
		decodedKek.length !== 32 ||
		decodedKek.toString("base64").replace(/=+$/, "") !== kek.replace(/=+$/, "")
	) {
		throw invalidSecretFile();
	}
	if (!isValidClassicAddress(values.HARBOR_LOCAL_X402_MERCHANT_PAY_TO)) {
		throw invalidSecretFile();
	}
	return values;
}

export async function validateX402SecretFile(
	path = LOCAL_X402_SECRET_FILE,
	{
		openFile = open,
		validateParent = validateX402SecretParentChain,
	} = {},
) {
	if (path !== LOCAL_X402_SECRET_FILE) throw invalidSecretFile();
	if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") throw invalidSecretFile();
	let handle;
	try {
		await validateParent(dirname(path));
		handle = await openFile(
			path,
			FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
		);
		const beforeRead = await handle.stat();
		if (!safeX402SecretMetadata(beforeRead)) throw invalidSecretFile();
		const contents = await handle.readFile("utf8");
		const afterRead = await handle.stat();
		if (
			!safeX402SecretMetadata(afterRead) ||
			Buffer.byteLength(contents, "utf8") > LOCAL_X402_SECRET_MAX_BYTES
		) throw invalidSecretFile();
		return parseX402SecretFile(contents);
	} catch {
		throw invalidSecretFile();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function sameArguments(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((argument, index) => argument === expected[index])
	);
}

export function validateLocalCommandPlan(
	commands,
	repoRoot = REPO_ROOT,
	profile = LOCAL_PROFILES.READ_ONLY,
	secretValues = undefined,
) {
	validateProfile(profile);
	const signingEnabled = profile === LOCAL_PROFILES.X402_SIGNING;
	if (!Array.isArray(commands) || commands.length !== 3) {
		throw new Error("Local Harbor command plan is invalid");
	}
	const [catalog, migration, server] = commands;
	const expectedConfig = join(repoRoot, signingEnabled ? LOCAL_X402_CONFIG : LOCAL_CONFIG);
	const expectedEmptyEnv = join(repoRoot, LOCAL_EMPTY_ENV);
	const expectedPersistence = join(
		repoRoot,
		signingEnabled ? LOCAL_X402_STATE_DIRECTORY : LOCAL_STATE_DIRECTORY,
	);
	const expectedWrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
	const expectedMigrationArgs = [
		expectedWrangler,
		"d1",
		"migrations",
		"apply",
		"DB",
		"--local",
		"--persist-to",
		expectedPersistence,
		"--config",
		expectedConfig,
		"--env-file",
		expectedEmptyEnv,
	];
	const expectedServerArgs = [
		expectedWrangler,
		"dev",
		"--local",
		"--ip",
		LOCAL_HOST,
		"--inspector-ip",
		LOCAL_HOST,
		"--port",
		String(LOCAL_PORT),
		"--persist-to",
		expectedPersistence,
		"--show-interactive-dev-session=false",
		"--config",
		expectedConfig,
		"--env-file",
		signingEnabled ? LOCAL_X402_SECRET_FILE : expectedEmptyEnv,
	];
	if (
		catalog.label !== "catalog" ||
		catalog.command !== process.execPath ||
		catalog.args.length !== 1 ||
		catalog.args[0] !== join(repoRoot, "scripts", "build-catalog.mjs") ||
		migration.label !== "local D1 migrations" ||
		migration.command !== process.execPath ||
		!sameArguments(migration.args, expectedMigrationArgs) ||
		server.label !== "loopback Worker" ||
		server.command !== process.execPath ||
		server.readinessUrl !== LOCAL_HEALTH_URL ||
		!sameArguments(server.args, expectedServerArgs)
	) {
		throw new Error("Local Harbor command plan is invalid");
	}
	for (const command of commands) {
		if (
			command.args.some((argument) =>
				/^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument),
			)
		) {
			throw new Error("Local Harbor command plan is not local-only");
		}
	}
	if (secretValues !== undefined) {
		const sensitiveValues = [secretValues.HARBOR_API_KEYS, secretValues.HARBOR_KEK];
		if (
			commands.some((command) =>
				command.args.some((argument) =>
					sensitiveValues.some(
						(value) => typeof value === "string" && argument.includes(value),
					),
				),
			)
		) {
			throw new Error("Local x402 secrets must not be placed in process arguments");
		}
	}
}

function childIsRunning(child) {
	return (
		hasSpawnedPid(child) &&
		child.exitCode === null &&
		child.signalCode === null
	);
}

function hasSpawnedPid(child) {
	return Number.isInteger(child?.pid) && child.pid > 0;
}

function killWindowsProcessTree(pid, signal) {
	const result = spawnSync(
		"taskkill.exe",
		["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
		{
			env: sanitizedChildEnvironment(),
			stdio: "ignore",
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

/**
 * Terminate exactly the process tree created for a launcher child. POSIX uses
 * the detached child's process-group ID; Windows uses taskkill with that PID
 * and /T. No port scan or name-based process lookup is used.
 */
export function terminateSpawnedProcessTree(
	child,
	signal,
	{
		allowExitedLeader = false,
		killProcess = process.kill,
		killWindowsTree = killWindowsProcessTree,
		platform = process.platform,
	} = {},
) {
	if (!hasSpawnedPid(child)) return false;
	if (!allowExitedLeader && !childIsRunning(child)) return false;
	// taskkill cannot safely distinguish a dead leader's reused PID. POSIX group
	// IDs remain addressable while any descendant in the group is alive.
	if (platform === "win32" && !childIsRunning(child)) return false;

	try {
		if (platform === "win32") {
			return killWindowsTree(child.pid, signal);
		} else {
			killProcess(-child.pid, signal);
		}
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ESRCH") return false;
		throw error;
	}
}

function spawnedProcessTreeIsRunning(
	child,
	{ killProcess = process.kill, platform = process.platform } = {},
) {
	if (!hasSpawnedPid(child)) return false;
	if (platform === "win32") return childIsRunning(child);

	try {
		killProcess(-child.pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ESRCH") return false;
		if (error && typeof error === "object" && error.code === "EPERM") return true;
		throw error;
	}
}

async function waitForProcessTreeExit(child, timeoutMs, treeIsRunning) {
	if (!treeIsRunning(child)) return;
	const deadline = Date.now() + timeoutMs;

	while (treeIsRunning(child) && Date.now() < deadline) {
		await new Promise((resolvePromise) =>
			setTimeout(resolvePromise, Math.min(25, Math.max(1, deadline - Date.now()))),
		);
	}
}

function abortError() {
	const error = new Error("Local Harbor readiness attempt timed out");
	error.name = "AbortError";
	return error;
}

async function abortable(promise, signal) {
	if (signal.aborted) throw abortError();
	let handleAbort;
	const aborted = new Promise((_, rejectPromise) => {
		handleAbort = () => rejectPromise(abortError());
		signal.addEventListener("abort", handleAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", handleAbort);
	}
}

async function boundedJsonBody(response, signal) {
	const declared = response.headers.get("content-length");
	if (
		declared !== null &&
		(!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > READINESS_BODY_MAX_BYTES)
	) {
		throw new Error("Local Harbor readiness response is too large");
	}
	if (response.body === null) throw new Error("Local Harbor readiness response is empty");
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const next = await abortable(reader.read(), signal);
			if (next.done) break;
			total += next.value.byteLength;
			if (total > READINESS_BODY_MAX_BYTES) {
				throw new Error("Local Harbor readiness response is too large");
			}
			chunks.push(next.value);
		}
	} finally {
		if (signal.aborted || total > READINESS_BODY_MAX_BYTES) void reader.cancel().catch(() => undefined);
		releaseReader(reader);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function releaseReader(reader) {
	try {
		reader.releaseLock();
	} catch {
		// An aborting stream may already have released or invalidated its reader.
	}
}

async function waitForLocalReadiness(
	url,
	{
		fetchProcess = globalThis.fetch,
		signal,
		timeoutMs = READINESS_TIMEOUT_MS,
		retryMs = READINESS_RETRY_MS,
		attemptTimeoutMs = READINESS_ATTEMPT_TIMEOUT_MS,
	} = {},
) {
	if (!LOCAL_PROCESS_HEALTH_URLS.includes(url)) {
		throw new Error("Local Harbor process-health target is not the fixed loopback interface");
	}
	const deadline = Date.now() + timeoutMs;
	while (!signal?.aborted && Date.now() < deadline) {
		const attempt = new AbortController();
		const forwardAbort = () => attempt.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		const remaining = Math.max(1, deadline - Date.now());
		const attemptTimer = setTimeout(
			() => attempt.abort(),
			Math.min(attemptTimeoutMs, remaining),
		);
		try {
			const response = await abortable(fetchProcess(url, {
				method: "GET",
				redirect: "error",
				signal: attempt.signal,
			}), attempt.signal);
			const contentType = response.headers.get("content-type") ?? "";
			if (response.status === 200 && contentType.startsWith("application/json")) {
				const body = await boundedJsonBody(response, attempt.signal);
				if (
					typeof body === "object" &&
					body !== null &&
					Object.keys(body).length === 4 &&
					body.ok === true &&
					body.service === "harbor" &&
					body.health === "process" &&
					body.handoff_readiness === "not_evaluated"
				) {
					return;
				}
			}
		} catch (error) {
			if (signal?.aborted) throw error;
		} finally {
			clearTimeout(attemptTimer);
			signal?.removeEventListener("abort", forwardAbort);
		}
		const retryDelay = Math.min(retryMs, Math.max(0, deadline - Date.now()));
		if (retryDelay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelay));
	}
	if (signal?.aborted) throw new Error("Local Harbor process-health check was cancelled");
	throw new Error("Local Harbor process did not become healthy on the fixed loopback interface");
}

export class LauncherInterruptedError extends Error {
	constructor(signal) {
		super(`interrupted by ${signal}`);
		this.name = "LauncherInterruptedError";
		this.signal = signal;
	}
}

export async function runCommand(
	command,
	env,
	{
		spawnProcess = spawn,
		signalSource = process,
		killProcess = process.kill,
		killWindowsTree = killWindowsProcessTree,
		platform = process.platform,
		cleanupGraceMs = CLEANUP_GRACE_MS,
		fetchProcess = globalThis.fetch,
		readinessTimeoutMs = READINESS_TIMEOUT_MS,
		readinessRetryMs = READINESS_RETRY_MS,
		readinessAttemptTimeoutMs = READINESS_ATTEMPT_TIMEOUT_MS,
		treeIsRunning = (childProcess) =>
			spawnedProcessTreeIsRunning(childProcess, { killProcess, platform }),
	} = {},
) {
	const child = spawnProcess(command.command, command.args, {
		cwd: REPO_ROOT,
		detached: platform !== "win32",
		env,
		stdio: "inherit",
	});
	let interruptedSignal;
	let rejectRun;
	let handleChildError;
	let handleChildExit;
	const readinessController = new AbortController();
	const shutdownEvents = [
		...FORWARDED_SIGNALS.map((signal) => [signal, signal]),
		[SESSION_LOSS_EVENT, "SIGTERM"],
	];
	const shutdownHandlers = new Map(
		shutdownEvents.map(([event, signal]) => [
			event,
			() => {
				if (interruptedSignal !== undefined) return;
				interruptedSignal = event;
				try {
					terminateSpawnedProcessTree(child, signal, {
						killProcess,
						killWindowsTree,
						platform,
					});
					rejectRun?.(new LauncherInterruptedError(event));
				} catch (error) {
					rejectRun?.(error);
				}
			},
		]),
	);

	for (const [event, handler] of shutdownHandlers) signalSource.on(event, handler);

	try {
		const completion = new Promise((resolvePromise, rejectPromise) => {
			rejectRun = rejectPromise;
			handleChildError = rejectPromise;
			handleChildExit = (code, signal) => {
				if (code === 0 && interruptedSignal === undefined) {
					resolvePromise();
					return;
				}
				rejectPromise(
					interruptedSignal === undefined
						? new Error(
								`${command.label} exited ${signal === null ? `with code ${code}` : `on signal ${signal}`}`,
							)
						: new LauncherInterruptedError(interruptedSignal),
				);
			};
			child.once("error", handleChildError);
			child.once("exit", handleChildExit);
		});
		if (command.readinessUrl !== undefined) {
			await Promise.race([
				waitForLocalReadiness(command.readinessUrl, {
					fetchProcess,
					signal: readinessController.signal,
					timeoutMs: readinessTimeoutMs,
					retryMs: readinessRetryMs,
					attemptTimeoutMs: readinessAttemptTimeoutMs,
				}),
				completion.then(() => {
					throw new Error("Local Harbor exited before the fixed loopback process became healthy");
				}),
			]);
		}
		await completion;
	} finally {
		readinessController.abort();
		for (const [event, handler] of shutdownHandlers) signalSource.off(event, handler);
		if (handleChildError !== undefined) child.off("error", handleChildError);
		if (handleChildExit !== undefined) child.off("exit", handleChildExit);

		if (treeIsRunning(child)) {
			if (interruptedSignal === undefined) {
				terminateSpawnedProcessTree(child, "SIGTERM", {
					allowExitedLeader: true,
					killProcess,
					killWindowsTree,
					platform,
				});
			}
			await waitForProcessTreeExit(child, cleanupGraceMs, treeIsRunning);
			if (treeIsRunning(child)) {
				terminateSpawnedProcessTree(child, "SIGKILL", {
					allowExitedLeader: true,
					killProcess,
					killWindowsTree,
					platform,
				});
				await waitForProcessTreeExit(child, cleanupGraceMs, treeIsRunning);
			}
			if (treeIsRunning(child)) {
				throw new Error("Local Harbor could not confirm spawned process tree termination");
			}
		}
	}
}

export async function prepareLocalLaunch(
	profile = LOCAL_PROFILES.READ_ONLY,
	repoRoot = REPO_ROOT,
	{
		validateConfiguration = validateLocalConfigurationFile,
		validateSecret = validateX402SecretFile,
		ensureState = ensureLocalX402StateDirectory,
	} = {},
) {
	validateProfile(profile);
	await validateConfiguration(repoRoot, profile);
	const secretValues =
		profile === LOCAL_PROFILES.X402_SIGNING
			? await validateSecret()
			: undefined;
	if (profile === LOCAL_PROFILES.X402_SIGNING) {
		ensureState(join(repoRoot, LOCAL_X402_STATE_DIRECTORY));
	}
	const commands = localCommands(repoRoot, { profile });
	validateLocalCommandPlan(commands, repoRoot, profile, secretValues);
	return commands;
}

export async function main(
	args = process.argv.slice(2),
	{
		profile = LOCAL_PROFILES.READ_ONLY,
		prepareLaunch = prepareLocalLaunch,
		run = runCommand,
		setUmask = process.umask,
	} = {},
) {
	validateLocalArguments(args);
	enforceLocalFileUmask(setUmask);
	const env = sanitizedChildEnvironment(process.env, profile);
	for (const command of await prepareLaunch(profile)) {
		console.log(`[harbor-local] ${command.label}`);
		await run(command, env);
	}
}

export function runCli(profile = LOCAL_PROFILES.READ_ONLY) {
	main(process.argv.slice(2), { profile }).catch((error) => {
		if (error instanceof LauncherInterruptedError) {
			process.exitCode = error.signal === "SIGINT" ? 130 : error.signal === "SIGHUP" ? 129 : 143;
			return;
		}
		console.error(`harbor-local: ${error instanceof Error ? error.message : "startup failed"}`);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
	runCli();
}
