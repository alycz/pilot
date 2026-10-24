#!/usr/bin/env node

import { readFile } from "node:fs/promises";
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
	validateLocalArguments,
} from "./dev-local.mjs";
import {
	LOCAL_TRADING_SECRET_FILE,
	LOCAL_TRADING_STATE_DIRECTORY,
	ensureTradingStateDirectory,
	tradingChildEnvironment,
	validateTradingSecretFile,
	validateTradingStateDirectory,
} from "./dev-local-trading.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_EMPTY_ENV = "config/local-empty.env";

export const LOCAL_TRADING_ONBOARDING_CONFIG =
	"wrangler.local-trading-onboarding.jsonc";
export const LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE =
	"reviewed-testnet-local-trading-onboarding-v1";

function sameKeys(value, expected) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...expected].sort();
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index])
	);
}

export function onboardingCommands(repoRoot = REPO_ROOT) {
	const config = join(repoRoot, LOCAL_TRADING_ONBOARDING_CONFIG);
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
			label: "local trading onboarding D1 migrations",
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
			label: "loopback trading onboarding Worker",
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

export function validateOnboardingConfiguration(config) {
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
		config.name !== "harbor-local-trading-onboarding-only" ||
		config.compatibility_date !== "2026-10-06" ||
		!Array.isArray(config.compatibility_flags) ||
		config.compatibility_flags.length !== 1 ||
		config.compatibility_flags[0] !== "nodejs_compat"
	) {
		throw new Error("Local trading onboarding configuration is not the reviewed profile");
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
		throw new Error("Local trading onboarding D1 is not isolated");
	}
	const database = config.d1_databases[0];
	if (
		database.binding !== "DB" ||
		database.database_name !== "harbor-local-trading-only" ||
		database.database_id !== "11111111-1111-1111-1111-111111111111" ||
		database.migrations_dir !== "migrations" ||
		database.remote !== false
	) {
		throw new Error("Local trading onboarding D1 is not isolated");
	}
	const expectedVars = {
		EXEC_NETWORK: "testnet",
		EXECUTOR: "quickjs",
		HARBOR_LOCAL_AUTH_REQUIRED: "true",
		HARBOR_LOCAL_CRON_DISABLED: "true",
		HARBOR_LOCAL_DEV: "true",
		HARBOR_LOCAL_READ_ONLY: "false",
		HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
		HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
			LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
		HARBOR_LOCAL_X402: "false",
		HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
		HARBOR_SOURCE_TAG: "2610240",
		MAINNET_EXECUTION: "false",
	};
	if (!sameKeys(config.vars, Object.keys(expectedVars))) {
		throw new Error("Local trading onboarding runtime variables are not exact");
	}
	for (const [name, value] of Object.entries(expectedVars)) {
		if (config.vars[name] !== value) {
			throw new Error("Local trading onboarding runtime variables are not exact");
		}
	}
}

export async function validateOnboardingConfigurationFile(repoRoot = REPO_ROOT) {
	let config;
	try {
		config = JSON.parse(
			await readFile(join(repoRoot, LOCAL_TRADING_ONBOARDING_CONFIG), "utf8"),
		);
	} catch {
		throw new Error("Local trading onboarding configuration could not be loaded");
	}
	validateOnboardingConfiguration(config);
}

function sameArguments(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((argument, index) => argument === expected[index])
	);
}

export function validateOnboardingCommandPlan(
	commands,
	repoRoot = REPO_ROOT,
	secretValues,
) {
	const expected = onboardingCommands(repoRoot);
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
		throw new Error("Local trading onboarding command plan is invalid");
	}
	for (const command of commands) {
		if (
			command.args.some((argument) =>
				/^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument),
			)
		) {
			throw new Error("Local trading onboarding command plan is not local-only");
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
		throw new Error("Local trading onboarding secrets must not enter process arguments");
	}
}

export async function prepareOnboardingLaunch(repoRoot = REPO_ROOT) {
	await validateOnboardingConfigurationFile(repoRoot);
	const secretValues = await validateTradingSecretFile();
	await ensureTradingStateDirectory(join(repoRoot, LOCAL_TRADING_STATE_DIRECTORY));
	const commands = onboardingCommands(repoRoot);
	validateOnboardingCommandPlan(commands, repoRoot, secretValues);
	return commands;
}

export async function main(
	args = process.argv.slice(2),
	{
		prepareLaunch = prepareOnboardingLaunch,
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
		console.log(`[harbor-local-trading-onboarding] ${command.label}`);
		await run(command, env);
		if (command.label === "local trading onboarding D1 migrations") {
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
			`harbor-local-trading-onboarding: ${error instanceof Error ? error.message : "startup failed"}`,
		);
		process.exitCode = 1;
	});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();

export { LOCAL_FILE_UMASK };
