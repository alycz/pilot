#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
	LOCAL_TRADING_ISOLATED_V1_HEALTH_URL,
	LOCAL_TRADING_ISOLATED_V1_HOST,
	LOCAL_TRADING_ISOLATED_V1_ORIGIN,
	LOCAL_TRADING_ISOLATED_V1_PORT,
	LOCAL_TRADING_ISOLATED_V1_SECRET_FILE,
	LOCAL_TRADING_ISOLATED_V1_STATE_DIRECTORY,
	LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
	validateIsolatedTradingSecretFile,
	validatePinnedIsolatedTradingStateRoot,
} from "./dev-local-trading-isolated-v1.mjs";
import {
	TRADING_ISOLATED_V1_MIGRATION_DIRECTORY,
	validateIsolatedMigrationProfile,
} from "./isolated-migration-profiles.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_EMPTY_ENV = "config/local-empty.env";

export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_CONFIG =
	"wrangler.local-trading-isolated-v1-onboarding.jsonc";
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_STATE_DIRECTORY =
	LOCAL_TRADING_ISOLATED_V1_STATE_DIRECTORY;
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SECRET_FILE =
	LOCAL_TRADING_ISOLATED_V1_SECRET_FILE;
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE =
	"local-wallet-isolated-onboarding-v1";
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_BUILD_ORIGIN =
	"local-trading-isolated-onboarding-v1";
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HOST =
	LOCAL_TRADING_ISOLATED_V1_HOST;
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_PORT =
	LOCAL_TRADING_ISOLATED_V1_PORT;
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_ORIGIN =
	LOCAL_TRADING_ISOLATED_V1_ORIGIN;
export const LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HEALTH_URL =
	LOCAL_TRADING_ISOLATED_V1_HEALTH_URL;

function sameKeys(value, expected) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...expected].sort();
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index])
	);
}

export function isolatedOnboardingChildEnvironment(source = process.env) {
	return {
		...sanitizedChildEnvironment(source),
		WRANGLER_LOG_PATH: join(
			LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
			"onboarding.wrangler.log",
		),
	};
}

export function isolatedOnboardingCommands(repoRoot = REPO_ROOT) {
	const config = join(repoRoot, LOCAL_TRADING_ISOLATED_V1_ONBOARDING_CONFIG);
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
			label: "local trading isolated v1 onboarding D1 migrations",
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
			label: "isolated v1 loopback onboarding Worker",
			command: process.execPath,
			readinessUrl: LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HEALTH_URL,
			args: [
				wrangler,
				"dev",
				"--local",
				"--ip",
				LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HOST,
				"--inspector-ip",
				LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HOST,
				"--port",
				String(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_PORT),
				"--persist-to",
				persistence,
				"--show-interactive-dev-session=false",
				"--config",
				config,
				"--env-file",
				LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SECRET_FILE,
			],
		},
	];
}

export function validateIsolatedOnboardingConfiguration(config) {
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
		config.name !== "harbor-local-trading-isolated-v1-onboarding-only" ||
		config.compatibility_date !== "2026-10-06" ||
		!Array.isArray(config.compatibility_flags) ||
		config.compatibility_flags.length !== 1 ||
		config.compatibility_flags[0] !== "nodejs_compat"
	) {
		throw new Error("Local trading isolated v1 onboarding configuration is not exact");
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
		throw new Error("Local trading isolated v1 onboarding D1 is not exact");
	}
	const database = config.d1_databases[0];
	if (
		database.binding !== "DB" ||
		database.database_name !== "harbor-local-trading-isolated-v1-only" ||
		database.database_id !== "22222222-2222-2222-2222-222222222222" ||
		database.migrations_dir !== TRADING_ISOLATED_V1_MIGRATION_DIRECTORY ||
		database.remote !== false
	) {
		throw new Error("Local trading isolated v1 onboarding D1 is not exact");
	}
	const expectedVars = {
		EXEC_NETWORK: "testnet",
		EXECUTOR: "quickjs",
		HARBOR_LOCAL_AUTH_REQUIRED: "true",
		HARBOR_LOCAL_CRON_DISABLED: "true",
		HARBOR_LOCAL_DEV: "true",
		HARBOR_LOCAL_READ_ONLY: "false",
		HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
		HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
			LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE,
		HARBOR_LOCAL_X402: "false",
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
		HARBOR_SOURCE_TAG: "2610240",
		MAINNET_EXECUTION: "false",
	};
	if (!sameKeys(config.vars, Object.keys(expectedVars))) {
		throw new Error("Local trading isolated v1 onboarding variables are not exact");
	}
	for (const [name, value] of Object.entries(expectedVars)) {
		if (config.vars[name] !== value) {
			throw new Error("Local trading isolated v1 onboarding variables are not exact");
		}
	}
}

export async function validateIsolatedOnboardingConfigurationFile(
	repoRoot = REPO_ROOT,
) {
	let config;
	try {
		config = JSON.parse(
			await readFile(
				join(repoRoot, LOCAL_TRADING_ISOLATED_V1_ONBOARDING_CONFIG),
				"utf8",
			),
		);
	} catch {
		throw new Error(
			"Local trading isolated v1 onboarding configuration could not be loaded",
		);
	}
	validateIsolatedOnboardingConfiguration(config);
}

function sameArguments(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((argument, index) => argument === expected[index])
	);
}

export function validateIsolatedOnboardingCommandPlan(
	commands,
	repoRoot = REPO_ROOT,
	secretValues,
) {
	const expected = isolatedOnboardingCommands(repoRoot);
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
		throw new Error("Local trading isolated v1 onboarding command plan is invalid");
	}
	for (const command of commands) {
		if (
			command.args.some((argument) =>
				/^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument),
			)
		) {
			throw new Error(
				"Local trading isolated v1 onboarding command plan is not local-only",
			);
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
		throw new Error(
			"Local trading isolated v1 onboarding secrets must not enter process arguments",
		);
	}
}

export async function prepareIsolatedOnboardingLaunch(
	repoRoot = REPO_ROOT,
	{
		validateConfiguration = validateIsolatedOnboardingConfigurationFile,
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
	const commands = isolatedOnboardingCommands(repoRoot);
	validateIsolatedOnboardingCommandPlan(commands, repoRoot, secretValues);
	return commands;
}

export async function main(
	args = process.argv.slice(2),
	{
		prepareLaunch = prepareIsolatedOnboardingLaunch,
		run = runCommand,
		setUmask = process.umask,
		environment = isolatedOnboardingChildEnvironment,
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
		console.log(`[harbor-local-trading-isolated-v1-onboarding] ${command.label}`);
		if (command.label === "local trading isolated v1 onboarding D1 migrations") {
			await revalidateMigrationProfile();
		}
		if (
			command.label === "local trading isolated v1 onboarding D1 migrations" ||
			command.label === "isolated v1 loopback onboarding Worker"
		) {
			await revalidateState();
		}
		await run(command, env);
		if (command.label === "local trading isolated v1 onboarding D1 migrations") {
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
			`harbor-local-trading-isolated-v1-onboarding: ${error instanceof Error ? error.message : "startup failed"}`,
		);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();

export { LOCAL_FILE_UMASK, LOCAL_TRADING_ISOLATED_V1_STATE_ROOT };
