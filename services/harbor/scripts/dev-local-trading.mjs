#!/usr/bin/env node

import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	LOCAL_FILE_UMASK,
	LOCAL_HEALTH_URL,
	LOCAL_HOST,
	LOCAL_PORT,
	LauncherInterruptedError,
	enforceLocalFileUmask,
	runCommand,
	sanitizedChildEnvironment,
	validateLocalArguments,
} from "./dev-local.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LOCAL_TRADING_CONFIG = "wrangler.local-trading.jsonc";
export const LOCAL_TRADING_STATE_DIRECTORY = ".wrangler/harbor-local-trading";
export const LOCAL_TRADING_SECRET_FILE =
	(process.env.HARBOR_PRIVATE_SECRETS_ROOT ? resolve(process.env.HARBOR_PRIVATE_SECRETS_ROOT, "harbor-local-trading.env.local") : "/dev/null/pilot-disabled/harbor-local-trading.env.local");
export const LOCAL_TRADING_SIGNING_PROFILE =
	"reviewed-testnet-local-trading-v1";

const LOCAL_EMPTY_ENV = "config/local-empty.env";
const TRADING_SECRET_KEYS = new Set([
	"HARBOR_API_KEYS",
	"HARBOR_KEK",
]);
const MAX_SECRET_FILE_BYTES = 4_096;

function sameKeys(value, expected) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...expected].sort();
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index])
	);
}

function invalidSecretFile() {
	return new Error("Local trading secret file is missing or unsafe");
}

function parseTradingSecretFile(contents) {
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
			!TRADING_SECRET_KEYS.has(name) ||
			Object.prototype.hasOwnProperty.call(values, name) ||
			value.length === 0 ||
			value !== value.trim() ||
			/[\r\n\0]/.test(value)
		) {
			throw invalidSecretFile();
		}
		values[name] = value;
	}

	if (!sameKeys(values, TRADING_SECRET_KEYS)) throw invalidSecretFile();
	const apiKey = values.HARBOR_API_KEYS;
	const separator = apiKey.indexOf(":");
	const principal = apiKey.slice(0, separator);
	const credential = apiKey.slice(separator + 1);
	if (
		apiKey.length > 640 ||
		separator <= 0 ||
		apiKey.indexOf(":", separator + 1) !== -1 ||
		apiKey.includes(",") ||
		!/^[A-Za-z0-9._-]{1,64}$/.test(principal) ||
		principal === "local-dev" ||
		!/^[A-Za-z0-9_-]{32,128}$/.test(credential)
	) {
		throw invalidSecretFile();
	}
	const kek = values.HARBOR_KEK;
	if (
		!/^[A-Za-z0-9+/]{43}=$/.test(kek) ||
		Buffer.from(kek, "base64").length !== 32
	) {
		throw invalidSecretFile();
	}
	return values;
}

async function directoryMetadata(path) {
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

export async function validateTradingSecretParentChain(path = dirname(LOCAL_TRADING_SECRET_FILE)) {
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const immediate = await directoryMetadata(path);
	if (
		(immediate.mode & 0o777) !== 0o700 ||
		(currentUid !== undefined && immediate.uid !== currentUid)
	) {
		throw invalidSecretFile();
	}

	let ancestor = dirname(path);
	while (true) {
		const metadata = await directoryMetadata(ancestor);
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

export async function validateTradingSecretFile(
	path = LOCAL_TRADING_SECRET_FILE,
	{ openFile = open, validateParent = validateTradingSecretParentChain } = {},
) {
	if (path !== LOCAL_TRADING_SECRET_FILE) throw invalidSecretFile();
	if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") throw invalidSecretFile();
	let handle;
	try {
		await validateParent(dirname(path));
		handle = await openFile(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
		const metadata = await handle.stat();
		const permissions = metadata.mode & 0o777;
		if (
			metadata.isSymbolicLink() ||
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.size > MAX_SECRET_FILE_BYTES ||
			(permissions !== 0o400 && permissions !== 0o600) ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid())
		) {
			throw invalidSecretFile();
		}
		const contents = await handle.readFile("utf8");
		if (Buffer.byteLength(contents, "utf8") > MAX_SECRET_FILE_BYTES) {
			throw invalidSecretFile();
		}
		return parseTradingSecretFile(contents);
	} catch {
		throw invalidSecretFile();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function unsafeState() {
	return new Error("Local trading state is missing ownership or permission isolation");
}

async function validateStatePath(path, expectedType) {
	const metadata = await lstat(path);
	const expectedPermissions = expectedType === "directory" ? 0o700 : 0o600;
	if (
		(expectedType === "directory" ? !metadata.isDirectory() : !metadata.isFile()) ||
		metadata.isSymbolicLink() ||
		(await realpath(path)) !== path ||
		(metadata.mode & 0o777) !== expectedPermissions ||
		(expectedType === "file" && metadata.nlink !== 1) ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid())
	) {
		throw unsafeState();
	}
}

async function validateStateParent(path) {
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	let current = path;
	while (true) {
		const metadata = await lstat(current);
		if (
			metadata.isSymbolicLink() ||
			!metadata.isDirectory() ||
			(await realpath(current)) !== current ||
			(metadata.mode & 0o022) !== 0 ||
			(currentUid !== undefined && metadata.uid !== currentUid && metadata.uid !== 0)
		) {
			throw unsafeState();
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

async function validateStateTree(directory) {
	await validateStatePath(directory, "directory");
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await validateStateTree(path);
		} else if (entry.isFile()) {
			await validateStatePath(path, "file");
		} else {
			throw unsafeState();
		}
	}
}

export async function validateTradingStateDirectory(
	path = join(REPO_ROOT, LOCAL_TRADING_STATE_DIRECTORY),
) {
	try {
		await validateStateParent(dirname(path));
		await validateStateTree(path);
	} catch (error) {
		throw unsafeState();
	}
}

export async function ensureTradingStateDirectory(
	path = join(REPO_ROOT, LOCAL_TRADING_STATE_DIRECTORY),
) {
	const parent = dirname(path);
	try {
		await mkdir(parent, { mode: 0o700 });
	} catch (error) {
		if (!error || typeof error !== "object" || error.code !== "EEXIST") {
			throw unsafeState();
		}
	}
	try {
		await validateStateParent(parent);
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!error || typeof error !== "object" || error.code !== "EEXIST") {
			throw unsafeState();
		}
	}
	await validateTradingStateDirectory(path);
}

export function tradingChildEnvironment(source = process.env) {
	return {
		...sanitizedChildEnvironment(source),
		WRANGLER_LOG_PATH: join(REPO_ROOT, LOCAL_TRADING_STATE_DIRECTORY, "wrangler.log"),
	};
}

export function tradingCommands(repoRoot = REPO_ROOT) {
	const config = join(repoRoot, LOCAL_TRADING_CONFIG);
	const emptyEnv = join(repoRoot, LOCAL_EMPTY_ENV);
	const persistence = join(repoRoot, LOCAL_TRADING_STATE_DIRECTORY);
	const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
	return [
		{
			label: "catalog",
			command: process.execPath,
			args: [join(repoRoot, "scripts", "build-catalog.mjs")],
		},
		{
			label: "local trading D1 migrations",
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
				"--config",
				config,
				"--env-file",
				emptyEnv,
			],
		},
		{
			label: "loopback trading Worker",
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
				"--config",
				config,
				"--env-file",
				LOCAL_TRADING_SECRET_FILE,
			],
		},
	];
}

export function validateTradingConfiguration(config) {
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
		config.name !== "harbor-local-trading-only" ||
		config.compatibility_date !== "2026-10-06" ||
		!Array.isArray(config.compatibility_flags) ||
		config.compatibility_flags.length !== 1 ||
		config.compatibility_flags[0] !== "nodejs_compat"
	) {
		throw new Error("Local trading configuration is not the reviewed isolated profile");
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
		throw new Error("Local trading D1 configuration is not isolated");
	}
	const database = config.d1_databases[0];
	if (
		database.binding !== "DB" ||
		database.database_name !== "harbor-local-trading-only" ||
		database.database_id !== "11111111-1111-1111-1111-111111111111" ||
		database.migrations_dir !== "migrations" ||
		database.remote !== false
	) {
		throw new Error("Local trading D1 configuration is not isolated");
	}
	const expectedVars = {
		EXEC_NETWORK: "testnet",
		EXECUTOR: "quickjs",
		HARBOR_LOCAL_DEV: "true",
		HARBOR_LOCAL_READ_ONLY: "false",
		HARBOR_LOCAL_AUTH_REQUIRED: "true",
		HARBOR_LOCAL_CRON_DISABLED: "true",
		HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
		HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
		HARBOR_LOCAL_X402: "false",
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
		HARBOR_SOURCE_TAG: "2610240",
		MAINNET_EXECUTION: "false",
	};
	if (!sameKeys(config.vars, Object.keys(expectedVars))) {
		throw new Error("Local trading runtime variables are not the reviewed profile");
	}
	for (const [name, value] of Object.entries(expectedVars)) {
		if (config.vars[name] !== value) {
			throw new Error("Local trading runtime variables are not the reviewed profile");
		}
	}
}

export async function validateTradingConfigurationFile(repoRoot = REPO_ROOT) {
	let config;
	try {
		config = JSON.parse(await readFile(join(repoRoot, LOCAL_TRADING_CONFIG), "utf8"));
	} catch {
		throw new Error("Local trading configuration could not be loaded");
	}
	validateTradingConfiguration(config);
}

function sameArguments(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((argument, index) => argument === expected[index])
	);
}

export function validateTradingCommandPlan(commands, repoRoot = REPO_ROOT, secretValues) {
	const expected = tradingCommands(repoRoot);
	if (
		!Array.isArray(commands) ||
		commands.length !== expected.length ||
		commands.some(
			(command, index) =>
				command.label !== expected[index].label ||
				command.command !== expected[index].command ||
				command.readinessUrl !== expected[index].readinessUrl ||
				!sameArguments(command.args, expected[index].args),
		)
	) {
		throw new Error("Local trading command plan is invalid");
	}
	for (const command of commands) {
		if (
			command.args.some((argument) =>
				/^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument),
			)
		) {
			throw new Error("Local trading command plan is not local-only");
		}
	}
	const sensitiveValues = [secretValues?.HARBOR_API_KEYS, secretValues?.HARBOR_KEK];
	if (
		commands.some((command) =>
			command.args.some((argument) =>
				sensitiveValues.some(
					(value) => typeof value === "string" && argument.includes(value),
				),
			),
		)
	) {
		throw new Error("Local trading secrets must not be placed in process arguments");
	}
}

export async function prepareTradingLaunch(repoRoot = REPO_ROOT) {
	await validateTradingConfigurationFile(repoRoot);
	const secretValues = await validateTradingSecretFile();
	await ensureTradingStateDirectory(join(repoRoot, LOCAL_TRADING_STATE_DIRECTORY));
	const commands = tradingCommands(repoRoot);
	validateTradingCommandPlan(commands, repoRoot, secretValues);
	return commands;
}

export async function main(
	args = process.argv.slice(2),
	{
		prepareLaunch = prepareTradingLaunch,
		run = runCommand,
		setUmask = process.umask,
		environment = tradingChildEnvironment,
		revalidateState = () =>
			validateTradingStateDirectory(join(REPO_ROOT, LOCAL_TRADING_STATE_DIRECTORY)),
	} = {},
) {
	validateLocalArguments(args);
	enforceLocalFileUmask(setUmask);
	const env = environment(process.env);
	for (const command of await prepareLaunch()) {
		console.log(`[harbor-local-trading] ${command.label}`);
		await run(command, env);
		if (command.label === "local trading D1 migrations") {
			await revalidateState();
		}
	}
}

export function runCli() {
	main().catch((error) => {
		if (error instanceof LauncherInterruptedError) {
			process.exitCode =
				error.signal === "SIGINT" ? 130 : error.signal === "SIGHUP" ? 129 : 143;
			return;
		}
		console.error(
			`harbor-local-trading: ${error instanceof Error ? error.message : "startup failed"}`,
		);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();

export { LOCAL_FILE_UMASK };
