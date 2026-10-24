#!/usr/bin/env node

import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	LOCAL_FILE_UMASK,
	LauncherInterruptedError,
	enforceLocalFileUmask,
	runCommand,
	sanitizedChildEnvironment,
	validateLocalArguments,
} from "./dev-local.mjs";
import {
	validateTradingStateDirectory,
} from "./dev-local-trading.mjs";
import {
	TRADING_ISOLATED_V1_MIGRATION_DIRECTORY,
	TRADING_ISOLATED_V1_MIGRATIONS,
	validateIsolatedMigrationProfile,
} from "./isolated-migration-profiles.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_EMPTY_ENV = "config/local-empty.env";
const MAX_SECRET_FILE_BYTES = 4_096;
const ISOLATED_SECRET_KEYS = new Set(["HARBOR_API_KEYS", "HARBOR_KEK"]);
const HARBOR_BASELINE_TABLES = new Set([
	"approvals",
	"builds",
	"events",
	"executions",
	"links",
	"policies",
	"account_sequence_leases",
	"d1_migrations",
]);
const MINIFLARE_D1_DIRECTORY_RELATIVE_PATH = join(
	"v3",
	"d1",
	"miniflare-D1DatabaseObject",
);
const MINIFLARE_D1_METADATA_RELATIVE_PATH = join(
	MINIFLARE_D1_DIRECTORY_RELATIVE_PATH,
	"metadata.sqlite",
);
const MINIFLARE_D1_PAYLOAD_NAME = /^[0-9a-f]{64}\.sqlite$/;

export const LOCAL_TRADING_ISOLATED_V1_CONFIG =
	"wrangler.local-trading-isolated-v1.jsonc";
export const LOCAL_TRADING_ISOLATED_V1_STATE_DIRECTORY =
	".wrangler/harbor-local-trading-isolated-v1";
export const LOCAL_TRADING_ISOLATED_V1_STATE_ROOT =
	(process.env.HARBOR_PRIVATE_STATE_ROOT ? resolve(process.env.HARBOR_PRIVATE_STATE_ROOT, "harbor-local-trading-isolated-v1/.wrangler/harbor-local-trading-isolated-v1") : "/dev/null/pilot-disabled/harbor-local-trading-isolated-v1/.wrangler/harbor-local-trading-isolated-v1");
export const LOCAL_TRADING_ISOLATED_V1_SECRET_FILE =
	(process.env.HARBOR_PRIVATE_SECRETS_ROOT ? resolve(process.env.HARBOR_PRIVATE_SECRETS_ROOT, "harbor-local-trading-isolated-v1.env.local") : "/dev/null/pilot-disabled/harbor-local-trading-isolated-v1.env.local");
export const LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE =
	"local-wallet-isolated-v1";
export const LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN =
	"local-trading-isolated-v1";
export const LOCAL_TRADING_ISOLATED_V1_HOST = "127.0.0.2";
export const LOCAL_TRADING_ISOLATED_V1_PORT = 8791;
export const LOCAL_TRADING_ISOLATED_V1_ORIGIN =
	`http://${LOCAL_TRADING_ISOLATED_V1_HOST}:${LOCAL_TRADING_ISOLATED_V1_PORT}`;
export const LOCAL_TRADING_ISOLATED_V1_HEALTH_URL =
	`${LOCAL_TRADING_ISOLATED_V1_ORIGIN}/health`;

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
	return new Error("Local trading isolated v1 secret file is missing or unsafe");
}

function parseIsolatedTradingSecretFile(contents) {
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
			!ISOLATED_SECRET_KEYS.has(name) ||
			Object.prototype.hasOwnProperty.call(values, name) ||
			value.length === 0 ||
			value !== value.trim() ||
			/[\r\n\0]/.test(value)
		) {
			throw invalidSecretFile();
		}
		values[name] = value;
	}

	if (!sameKeys(values, ISOLATED_SECRET_KEYS)) throw invalidSecretFile();
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

export async function validateIsolatedTradingSecretParentChain(
	path = dirname(LOCAL_TRADING_ISOLATED_V1_SECRET_FILE),
) {
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

export async function validateIsolatedTradingSecretFile(
	path = LOCAL_TRADING_ISOLATED_V1_SECRET_FILE,
	{ openFile = open, validateParent = validateIsolatedTradingSecretParentChain } = {},
) {
	if (path !== LOCAL_TRADING_ISOLATED_V1_SECRET_FILE) throw invalidSecretFile();
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
		return parseIsolatedTradingSecretFile(contents);
	} catch {
		throw invalidSecretFile();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function collectSqliteFiles(path, databases = []) {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			await collectSqliteFiles(child, databases);
		} else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
			databases.push(child);
		}
	}
	return databases;
}

export async function findIsolatedTradingD1Payload(
	stateRoot,
	{ findSqliteFiles = collectSqliteFiles } = {},
) {
	const d1Directory = join(
		stateRoot,
		MINIFLARE_D1_DIRECTORY_RELATIVE_PATH,
	);
	const sqliteFiles = await findSqliteFiles(d1Directory);
	if (!Array.isArray(sqliteFiles)) throw new Error();
	const d1Metadata = join(stateRoot, MINIFLARE_D1_METADATA_RELATIVE_PATH);
	const payloads = sqliteFiles.filter(
		(path) =>
			dirname(path) === d1Directory &&
			MINIFLARE_D1_PAYLOAD_NAME.test(basename(path)),
	);
	const expectedFiles = new Set([d1Metadata, ...payloads]);
	if (
		payloads.length !== 1 ||
		!sqliteFiles.includes(d1Metadata) ||
		sqliteFiles.length !== expectedFiles.size ||
		sqliteFiles.some((path) => !expectedFiles.has(path))
	) {
		throw new Error();
	}
	return payloads[0];
}

function validateHarborDatabase(
	path,
	{ openDatabase = (databasePath) => new DatabaseSync(databasePath, { readOnly: true }) } = {},
) {
	let database;
	try {
		database = openDatabase(path);
		const integrity = database.prepare("PRAGMA quick_check").all();
		if (
			integrity.length !== 1 ||
			integrity[0]?.quick_check !== "ok"
		) {
			throw new Error();
		}
		const tables = new Set(
			database
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
				.all()
				.map((row) => row.name),
		);
		if ([...HARBOR_BASELINE_TABLES].some((table) => !tables.has(table))) {
			throw new Error();
		}
		const migrations = database
			.prepare("SELECT id, name FROM d1_migrations ORDER BY id")
			.all();
		const expectedMigrations = TRADING_ISOLATED_V1_MIGRATIONS.map(
			(name, index) => ({ id: index + 1, name }),
		);
		if (JSON.stringify(migrations) !== JSON.stringify(expectedMigrations)) {
			throw new Error();
		}
	} finally {
		database?.close();
	}
}

export async function validateExistingIsolatedTradingState(
	path,
	{
		validateState = validateTradingStateDirectory,
		findDatabase = findIsolatedTradingD1Payload,
		validateDatabase = validateHarborDatabase,
	} = {},
) {
	try {
		await validateState(path);
		const database = await findDatabase(path);
		if (typeof database !== "string") throw new Error();
		validateDatabase(database);
	} catch {
		throw new Error(
			"Local trading isolated v1 preserved state is missing or unsafe",
		);
	}
}

export async function validatePinnedIsolatedTradingStateRoot(
	path = LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
	dependencies,
) {
	if (path !== LOCAL_TRADING_ISOLATED_V1_STATE_ROOT) {
		throw new Error(
			"Local trading isolated v1 preserved state is missing or unsafe",
		);
	}
	await validateExistingIsolatedTradingState(path, dependencies);
}

export function isolatedTradingChildEnvironment(source = process.env) {
	return {
		...sanitizedChildEnvironment(source),
		WRANGLER_LOG_PATH: join(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT, "wrangler.log"),
	};
}

export function isolatedTradingCommands(repoRoot = REPO_ROOT) {
	const config = join(repoRoot, LOCAL_TRADING_ISOLATED_V1_CONFIG);
	const emptyEnv = join(repoRoot, LOCAL_EMPTY_ENV);
	const persistence = LOCAL_TRADING_ISOLATED_V1_STATE_ROOT;
	const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
	return [
		{
			label: "catalog",
			command: process.execPath,
			args: [join(repoRoot, "scripts", "build-catalog.mjs")],
		},
		{
			label: "local trading isolated v1 D1 migrations",
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
			label: "isolated v1 loopback trading Worker",
			command: process.execPath,
			readinessUrl: LOCAL_TRADING_ISOLATED_V1_HEALTH_URL,
			args: [
				wrangler,
				"dev",
				"--local",
				"--ip",
				LOCAL_TRADING_ISOLATED_V1_HOST,
				"--inspector-ip",
				LOCAL_TRADING_ISOLATED_V1_HOST,
				"--port",
				String(LOCAL_TRADING_ISOLATED_V1_PORT),
				"--persist-to",
				persistence,
				"--show-interactive-dev-session=false",
				"--config",
				config,
				"--env-file",
				LOCAL_TRADING_ISOLATED_V1_SECRET_FILE,
			],
		},
	];
}

export function validateIsolatedTradingConfiguration(config) {
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
		config.name !== "harbor-local-trading-isolated-v1-only" ||
		config.compatibility_date !== "2026-10-06" ||
		!Array.isArray(config.compatibility_flags) ||
		config.compatibility_flags.length !== 1 ||
		config.compatibility_flags[0] !== "nodejs_compat"
	) {
		throw new Error("Local trading isolated v1 configuration is not exact");
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
		throw new Error("Local trading isolated v1 D1 is not isolated");
	}
	const database = config.d1_databases[0];
	if (
		database.binding !== "DB" ||
		database.database_name !== "harbor-local-trading-isolated-v1-only" ||
		database.database_id !== "22222222-2222-2222-2222-222222222222" ||
		database.migrations_dir !== TRADING_ISOLATED_V1_MIGRATION_DIRECTORY ||
		database.remote !== false
	) {
		throw new Error("Local trading isolated v1 D1 is not isolated");
	}
	const expectedVars = {
		EXEC_NETWORK: "testnet",
		EXECUTOR: "quickjs",
		HARBOR_LOCAL_AUTH_REQUIRED: "true",
		HARBOR_LOCAL_CRON_DISABLED: "true",
		HARBOR_LOCAL_DEV: "true",
		HARBOR_LOCAL_READ_ONLY: "false",
		HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
		HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
			LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
		HARBOR_LOCAL_X402: "false",
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
		HARBOR_SOURCE_TAG: "2610240",
		MAINNET_EXECUTION: "false",
	};
	if (!sameKeys(config.vars, Object.keys(expectedVars))) {
		throw new Error("Local trading isolated v1 runtime variables are not exact");
	}
	for (const [name, value] of Object.entries(expectedVars)) {
		if (config.vars[name] !== value) {
			throw new Error("Local trading isolated v1 runtime variables are not exact");
		}
	}
}

export async function validateIsolatedTradingConfigurationFile(repoRoot = REPO_ROOT) {
	let config;
	try {
		config = JSON.parse(
			await readFile(join(repoRoot, LOCAL_TRADING_ISOLATED_V1_CONFIG), "utf8"),
		);
	} catch {
		throw new Error("Local trading isolated v1 configuration could not be loaded");
	}
	validateIsolatedTradingConfiguration(config);
}

function sameArguments(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((argument, index) => argument === expected[index])
	);
}

export function validateIsolatedTradingCommandPlan(
	commands,
	repoRoot = REPO_ROOT,
	secretValues,
) {
	const expected = isolatedTradingCommands(repoRoot);
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
		throw new Error("Local trading isolated v1 command plan is invalid");
	}
	for (const command of commands) {
		if (
			command.args.some((argument) =>
				/^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument),
			)
		) {
			throw new Error("Local trading isolated v1 command plan is not local-only");
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
		throw new Error("Local trading isolated v1 secrets must not enter process arguments");
	}
}

export async function prepareIsolatedTradingLaunch(
	repoRoot = REPO_ROOT,
	{
		validateConfiguration = validateIsolatedTradingConfigurationFile,
		validateMigrationProfile = (root) =>
			validateIsolatedMigrationProfile(root, "trading-isolated-v1"),
		validateState = validatePinnedIsolatedTradingStateRoot,
		validateSecret = validateIsolatedTradingSecretFile,
	} = {},
) {
	await validateConfiguration(repoRoot);
	await validateMigrationProfile(repoRoot);
	await validateState(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT);
	const secretValues = await validateSecret();
	const commands = isolatedTradingCommands(repoRoot);
	validateIsolatedTradingCommandPlan(commands, repoRoot, secretValues);
	return commands;
}

export async function main(
	args = process.argv.slice(2),
	{
		prepareLaunch = prepareIsolatedTradingLaunch,
		run = runCommand,
		setUmask = process.umask,
		environment = isolatedTradingChildEnvironment,
		revalidateState = () =>
			validatePinnedIsolatedTradingStateRoot(
				LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
			),
		revalidateMigrationProfile = () =>
			validateIsolatedMigrationProfile(REPO_ROOT, "trading-isolated-v1"),
	} = {},
) {
	validateLocalArguments(args);
	enforceLocalFileUmask(setUmask);
	const env = environment(process.env);
	for (const command of await prepareLaunch()) {
		console.log(`[harbor-local-trading-isolated-v1] ${command.label}`);
		if (command.label === "local trading isolated v1 D1 migrations") {
			await revalidateMigrationProfile();
		}
		if (
			command.label === "local trading isolated v1 D1 migrations" ||
			command.label === "isolated v1 loopback trading Worker"
		) {
			await revalidateState();
		}
		await run(command, env);
		if (command.label === "local trading isolated v1 D1 migrations") {
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
			`harbor-local-trading-isolated-v1: ${error instanceof Error ? error.message : "startup failed"}`,
		);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();

export { LOCAL_FILE_UMASK };
