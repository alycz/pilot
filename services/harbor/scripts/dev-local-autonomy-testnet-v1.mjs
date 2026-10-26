#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	LOCAL_FILE_UMASK,
	LauncherInterruptedError,
	enforceLocalFileUmask,
	runCommand,
	sanitizedChildEnvironment,
} from "./dev-local.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_EMPTY_ENV = "config/local-empty.env";
const MAX_SECRET_FILE_BYTES = 4_096;
const SECRET_KEYS = new Set(["HARBOR_API_KEYS", "HARBOR_KEK"]);
const FORBIDDEN_ARGUMENT =
	/^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i;

export const LOCAL_AUTONOMY_TESTNET_V1_CONFIG =
	"wrangler.local-autonomy-testnet-v1.jsonc";
export const LOCAL_AUTONOMY_TESTNET_V1_HOST = "127.0.0.3";
export const LOCAL_AUTONOMY_TESTNET_V1_PORT = 8793;
export const LOCAL_AUTONOMY_TESTNET_V1_ORIGIN =
	`http://${LOCAL_AUTONOMY_TESTNET_V1_HOST}:${LOCAL_AUTONOMY_TESTNET_V1_PORT}`;
export const LOCAL_AUTONOMY_TESTNET_V1_HEALTH_URL =
	`${LOCAL_AUTONOMY_TESTNET_V1_ORIGIN}/health`;
export const LOCAL_AUTONOMY_TESTNET_V1_SCHEDULED_URL =
	`${LOCAL_AUTONOMY_TESTNET_V1_ORIGIN}/__scheduled?cron=*+*+*+*+*`;
export const LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT =
	"/absolute/private/pilot/harbor-state";
export const LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT =
	join(LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT, "harbor-autonomy-testnet-v1");
export const LOCAL_AUTONOMY_TESTNET_V1_SECRET_FILE =
	join(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "credentials.env.local");
export const LOCAL_AUTONOMY_TESTNET_V1_MARKER_FILE =
	join(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "profile.json");
export const LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID =
	"44444444-4444-4444-4444-444444444444";

const STATE_MARKER = Object.freeze({
	profile: "harbor-local-autonomy-testnet-v1-only",
	version: 1,
	database_id: LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID,
});

const CANONICAL_MIGRATIONS = Object.freeze({
	"0001_init.sql": "5d8ef181b9d30c0b33b0457c2911c2d3742777f14b1291f2b1479ea5f52e604c",
	"0002_build_capability_isolation.sql": "b7394bb6b7b135a9730655d85e29c1489461e0a769629af9efaad5e46261302c",
	"0002_quicknode.sql": "636baf9b62db702f94547216fe28f7796b66fa47f124b98d2f2c59e06440774c",
	"0003_execution_lifetime_v2.sql": "a0852ba68b34851d226aa88ccf992dbafc3ba3d6e3758de1886b96e1602e9155",
	"0004_v2_preflight_rejections.sql": "be6e3f538ceae8440a56c4fd0a0751ffc3fa9c240468e11ee22bd8ee7134e018",
	"0005_v2_approval_recovery.sql": "f761f8b889b13a553c0f3baec40b5738bb136a40c6b6389144cfc70c47e8dfda",
	"0006_local_trading_isolated_onboarding_v1.sql": "a2c8d06cc2eb763f9eb57ac33ecf4166463b0707e448f91186c2ec36296f4a48",
	"0007_ap4m_mandates.sql": "a72eb0286becacf639a03fd7610105265f276a8a47b614b9b413a7e682e7a635",
	"0008_ap4m_purchase_attempts.sql": "37d3dcac1ae8126630043dfb5e59fa4fefd249f41e774a9f2878cd5c5f7a181b",
	"0008_quicknode_rpc_counters.sql": "88bb144b9dba6a4a92a2ed80e10a6ffda6eeb8f67e2cbe4f5c90c12c0d2c5fd3",
	"0009_aws_kms_delegate_keys.sql": "38db2663ab897d46da23e904190d7541cabbb686173153abe274248bf240bbab",
	"0010_ap4m_channel_purchase.sql": "4c27d6cfe254e993eeb4d392ad42196b43bde941da71b9aef1bc07e665e30e91",
	"0011_autonomous_strategies.sql": "1b7d69ff047c9bfce5b584c057f9874ae24691c0f466a71bb36cb84d652546b9",
	"0012_isolated_sequence_authority.sql": "6bb35501d472ca3ec7215e7073fde77433a8152644819ed0bdca51e4c3a659b9",
	"0013_demo_model_quota.sql": "a690e5c304aaf98dcba460de2a4db0c73c96995dcbca799cf3e16846c7279342",
	"0014_declarative_strategies.sql": "c6cea482f4ba8c31339695c7ee405fa898a4974d7c08d1a1f37e16ab232436ad",
	"0015_strategy_owner_scope.sql": "5c2cd2868a45c561bb875ad04a38221ce3531737dd1c795aa9247cc1af368580",
	"0016_ap4m_evm_event.sql": "e13b58d348a350767f835b1b86270432df90f04e4ccf639e6b3b286c1155e931",
	"0017_hosted_pilot_state.sql": "c5f0b77b231e40138fe17b3cb07690182b0da2519956ecf46e3844de31c3562b",
	"0018_near_attempt_store.sql": "2460a259b348ad1d563bd34f7887f1292b65cd668325e5708e61d2cdf4ae82e8",
	"0019_near_wallet_proof_replay.sql": "9239e61697ed8bc4c109151563408f97a5c862a5f7c836e82bc4f753f62c9c4e",
});

function sameKeys(value, expected) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function invalidSecretFile() {
	return new Error("Local autonomy Testnet credential file is missing or unsafe");
}

export function parseAutonomySecretFile(contents) {
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
			!SECRET_KEYS.has(name) ||
			Object.prototype.hasOwnProperty.call(values, name) ||
			value.length === 0 ||
			value !== value.trim() ||
			/[\r\n\0]/.test(value)
		) throw invalidSecretFile();
		values[name] = value;
	}
	if (!sameKeys(values, SECRET_KEYS)) throw invalidSecretFile();
	const apiKey = values.HARBOR_API_KEYS;
	const separator = apiKey.indexOf(":");
	if (
		separator <= 0 ||
		apiKey.indexOf(":", separator + 1) !== -1 ||
		apiKey.includes(",") ||
		!/^[A-Za-z0-9._-]{1,64}$/.test(apiKey.slice(0, separator)) ||
		apiKey.slice(0, separator) === "local-dev" ||
		!/^[A-Za-z0-9_-]{32,128}$/.test(apiKey.slice(separator + 1))
	) throw invalidSecretFile();
	if (
		!/^[A-Za-z0-9+/]{43}=$/.test(values.HARBOR_KEK) ||
		Buffer.from(values.HARBOR_KEK, "base64").length !== 32
	) throw invalidSecretFile();
	return values;
}

export async function validateAutonomySecretFile(
	path = LOCAL_AUTONOMY_TESTNET_V1_SECRET_FILE,
	{ openFile = open } = {},
) {
	if (path !== LOCAL_AUTONOMY_TESTNET_V1_SECRET_FILE || typeof FS_CONSTANTS.O_NOFOLLOW !== "number") {
		throw invalidSecretFile();
	}
	let handle;
	try {
		handle = await openFile(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
		const metadata = await handle.stat();
		const permissions = metadata.mode & 0o777;
		if (
			metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
			metadata.size > MAX_SECRET_FILE_BYTES ||
			(permissions !== 0o400 && permissions !== 0o600) ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid())
		) throw invalidSecretFile();
		const contents = await handle.readFile("utf8");
		if (Buffer.byteLength(contents, "utf8") > MAX_SECRET_FILE_BYTES) throw invalidSecretFile();
		return parseAutonomySecretFile(contents);
	} catch {
		throw invalidSecretFile();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function stateError() {
	return new Error("Local autonomy Testnet state is missing, reused, or unsafe");
}

async function readAutonomyStateMarker(path) {
	let handle;
	try {
		handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
		const metadata = await handle.stat();
		if (
			metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
			(metadata.mode & 0o777) !== 0o600 || metadata.size > 512 ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid())
		) throw stateError();
		return await handle.readFile("utf8");
	} catch {
		throw stateError();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function safeDirectory(path, exactMode, { statPath = lstat, realPath = realpath } = {}) {
	const metadata = await statPath(path);
	if (
		metadata.isSymbolicLink() || !metadata.isDirectory() ||
		(await realPath(path)) !== path ||
		(metadata.mode & 0o777) !== exactMode ||
		(typeof process.getuid === "function" && metadata.uid !== process.getuid())
	) throw stateError();
}

export async function ensureAutonomyStateDirectory(
	path = LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT,
	{
		statPath = lstat,
		realPath = realpath,
		makeDirectory = mkdir,
		readMarker = readAutonomyStateMarker,
		writeMarker = writeFile,
	} = {},
) {
	if (
		path !== LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT ||
		path.includes("harbor-local-trading-isolated-v1") ||
		path.includes("harbor-local-x402")
	) throw stateError();
	const dependencies = { statPath, realPath };
	try {
		await safeDirectory(LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT, 0o700, dependencies);
	} catch (error) {
		if (error?.code !== "ENOENT") throw stateError();
		await makeDirectory(LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT, { mode: 0o700 });
		await safeDirectory(LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT, 0o700, dependencies);
	}

	let created = false;
	try {
		await safeDirectory(path, 0o700, dependencies);
	} catch (error) {
		if (error?.code !== "ENOENT") throw stateError();
		await makeDirectory(path, { mode: 0o700 });
		await safeDirectory(path, 0o700, dependencies);
		created = true;
	}
	const expected = `${JSON.stringify(STATE_MARKER, null, 2)}\n`;
	if (created) {
		await writeMarker(LOCAL_AUTONOMY_TESTNET_V1_MARKER_FILE, expected, {
			encoding: "utf8", flag: "wx", mode: 0o600,
		});
	} else {
		let marker;
		try {
			marker = await readMarker(LOCAL_AUTONOMY_TESTNET_V1_MARKER_FILE, "utf8");
		} catch {
			throw stateError();
		}
		if (marker !== expected) throw stateError();
	}
}

export async function validateCanonicalAutonomyMigrations(repoRoot = REPO_ROOT) {
	const migrationRoot = join(repoRoot, "migrations");
	let names;
	try {
		names = (await readdir(migrationRoot)).filter((name) => name.endsWith(".sql")).sort();
	} catch {
		throw new Error("Local autonomy Testnet canonical migrations could not be loaded");
	}
	const expectedNames = Object.keys(CANONICAL_MIGRATIONS).sort();
	if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
		throw new Error("Local autonomy Testnet canonical migration set changed");
	}
	for (const name of names) {
		const digest = createHash("sha256").update(await readFile(join(migrationRoot, name))).digest("hex");
		if (digest !== CANONICAL_MIGRATIONS[name]) {
			throw new Error(`Local autonomy Testnet canonical migration changed: ${name}`);
		}
	}
}

export function validateAutonomyConfiguration(config) {
	if (
		!sameKeys(config, ["$schema", "compatibility_date", "compatibility_flags", "d1_databases", "main", "name", "vars"]) ||
		config.$schema !== "node_modules/wrangler/config-schema.json" ||
		config.main !== "src/server.ts" ||
		config.name !== "harbor-local-autonomy-testnet-v1-only" ||
		config.compatibility_date !== "2026-10-06" ||
		JSON.stringify(config.compatibility_flags) !== JSON.stringify(["nodejs_compat"])
	) throw new Error("Local autonomy Testnet configuration is not exact");
	if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
		throw new Error("Local autonomy Testnet D1 is not isolated");
	}
	const database = config.d1_databases[0];
	if (
		!sameKeys(database, ["binding", "database_id", "database_name", "migrations_dir", "remote"]) ||
		database.binding !== "DB" ||
		database.database_name !== "harbor-local-autonomy-testnet-v1-only" ||
		database.database_id !== LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID ||
		database.migrations_dir !== "migrations" || database.remote !== false
	) throw new Error("Local autonomy Testnet D1 is not isolated");
	const expectedVars = {
		AUTONOMOUS_STRATEGY_RUNNER: "false",
		EXEC_NETWORK: "testnet",
		EXECUTOR: "quickjs",
		HARBOR_LOCAL_AUTH_REQUIRED: "true",
		HARBOR_LOCAL_AUTONOMY_TESTNET_V1: "true",
		HARBOR_LOCAL_CRON_DISABLED: "false",
		HARBOR_LOCAL_DEV: "false",
		HARBOR_LOCAL_READ_ONLY: "false",
		HARBOR_LOCAL_X402: "false",
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
		HARBOR_SOURCE_TAG: "2610240",
		MAINNET_EXECUTION: "false",
	};
	if (!sameKeys(config.vars, Object.keys(expectedVars))) {
		throw new Error("Local autonomy Testnet variables are not exact");
	}
	for (const [name, value] of Object.entries(expectedVars)) {
		if (config.vars[name] !== value) throw new Error("Local autonomy Testnet variables are not exact");
	}
}

export async function validateAutonomyConfigurationFile(repoRoot = REPO_ROOT) {
	let config;
	try {
		config = JSON.parse(await readFile(join(repoRoot, LOCAL_AUTONOMY_TESTNET_V1_CONFIG), "utf8"));
	} catch {
		throw new Error("Local autonomy Testnet configuration could not be loaded");
	}
	validateAutonomyConfiguration(config);
}

export function parseAutonomyArguments(args) {
	const forbidden = args.find((argument) => FORBIDDEN_ARGUMENT.test(argument));
	if (forbidden !== undefined) throw new Error("Local autonomy Testnet refuses remote and deploy arguments");
	if (args.length === 0) return { runnerEnabled: false };
	if (args.length === 1 && args[0] === "--enable-runner") return { runnerEnabled: true };
	throw new Error("Local autonomy Testnet accepts only the explicit --enable-runner flag");
}

export function autonomyChildEnvironment(source = process.env) {
	return {
		...sanitizedChildEnvironment(source),
		WRANGLER_LOG_PATH: join(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "wrangler.log"),
	};
}

export function autonomyCommands(repoRoot = REPO_ROOT, { runnerEnabled = false } = {}) {
	const config = join(repoRoot, LOCAL_AUTONOMY_TESTNET_V1_CONFIG);
	const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
	const workerArgs = [
		wrangler, "dev", "--local", "--ip", LOCAL_AUTONOMY_TESTNET_V1_HOST,
		"--inspector-ip", LOCAL_AUTONOMY_TESTNET_V1_HOST,
		"--port", String(LOCAL_AUTONOMY_TESTNET_V1_PORT),
		"--persist-to", LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT,
		"--test-scheduled", "--show-interactive-dev-session=false",
		"--config", config, "--env-file", LOCAL_AUTONOMY_TESTNET_V1_SECRET_FILE,
	];
	if (runnerEnabled) workerArgs.push("--var", "AUTONOMOUS_STRATEGY_RUNNER:true");
	return [
		{ label: "catalog", command: process.execPath, args: [join(repoRoot, "scripts", "build-catalog.mjs")] },
		{
			label: "local autonomy Testnet D1 migrations", command: process.execPath,
			args: [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to",
				LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "--config", config, "--env-file", join(repoRoot, LOCAL_EMPTY_ENV)],
		},
		{ label: "local autonomy Testnet Worker", command: process.execPath, args: workerArgs },
	];
}

export function validateAutonomyCommandPlan(commands, repoRoot = REPO_ROOT, options = {}, secretValues) {
	const expected = autonomyCommands(repoRoot, options);
	if (JSON.stringify(commands) !== JSON.stringify(expected)) {
		throw new Error("Local autonomy Testnet command plan is invalid");
	}
	for (const command of commands) {
		if (command.args.some((argument) => FORBIDDEN_ARGUMENT.test(argument))) {
			throw new Error("Local autonomy Testnet command plan is not local-only");
		}
		if (!command.args.includes("--local") && command.label !== "catalog") {
			throw new Error("Local autonomy Testnet command plan is not local-only");
		}
	}
	for (const sensitiveValue of [secretValues?.HARBOR_API_KEYS, secretValues?.HARBOR_KEK]) {
		if (typeof sensitiveValue === "string" && commands.some((command) => command.args.some((arg) => arg.includes(sensitiveValue)))) {
			throw new Error("Local autonomy Testnet credentials must not enter process arguments");
		}
	}
}

export async function prepareAutonomyLaunch(
	repoRoot = REPO_ROOT,
	{ runnerEnabled = false } = {},
	{
		validateConfiguration = validateAutonomyConfigurationFile,
		validateMigrations = validateCanonicalAutonomyMigrations,
		ensureState = ensureAutonomyStateDirectory,
		validateSecret = validateAutonomySecretFile,
	} = {},
) {
	await validateConfiguration(repoRoot);
	await validateMigrations(repoRoot);
	await ensureState();
	const secretValues = await validateSecret();
	const commands = autonomyCommands(repoRoot, { runnerEnabled });
	validateAutonomyCommandPlan(commands, repoRoot, { runnerEnabled }, secretValues);
	return commands;
}

export async function main(
	args = process.argv.slice(2),
	{
		prepareLaunch = prepareAutonomyLaunch,
		run = runCommand,
		setUmask = process.umask,
		environment = autonomyChildEnvironment,
	} = {},
) {
	const options = parseAutonomyArguments(args);
	enforceLocalFileUmask(setUmask);
	const env = environment(process.env);
	for (const command of await prepareLaunch(REPO_ROOT, options)) {
		console.log(`[harbor-local-autonomy-testnet-v1] ${command.label}`);
		await run(command, env);
	}
}

export function runCli() {
	main().catch((error) => {
		if (error instanceof LauncherInterruptedError) {
			process.exitCode = error.signal === "SIGINT" ? 130 : error.signal === "SIGHUP" ? 129 : 143;
			return;
		}
		console.error(`harbor-local-autonomy-testnet-v1: ${error instanceof Error ? error.message : "startup failed"}`);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();

export { LOCAL_FILE_UMASK };
