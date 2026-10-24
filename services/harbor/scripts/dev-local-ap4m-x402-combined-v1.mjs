#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LauncherInterruptedError,
  enforceLocalFileUmask,
  runCommand,
  sanitizedChildEnvironment,
  validateLocalArguments,
} from "./dev-local.mjs";
import {
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME,
  acquireIsolatedX402StateLease,
  validateConfiguredIsolatedX402StateRoot,
} from "./local-x402-isolated-state.mjs";
import {
  AP4M_X402_COMBINED_V1_PROFILE_MARKER,
  AP4M_X402_COMBINED_V1_RUNTIME_MARKER,
  AP4M_X402_COMBINED_V1_SIGNING_PROFILE,
  assertCombinedPayerBinding,
  validateExistingCombinedState,
} from "./local-ap4m-x402-combined-state.mjs";
import {
  LOCAL_X402_ISOLATED_V1_SECRET_FILE,
  validateIsolatedX402SecretFile,
} from "./dev-local-x402-isolated-v1.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const AP4M_X402_COMBINED_V1_CONFIG =
  "wrangler.local-ap4m-x402-combined-v1.jsonc";
export const AP4M_X402_COMBINED_V1_HOST = "127.0.0.2";
export const AP4M_X402_COMBINED_V1_PORT = 8792;
export const AP4M_X402_COMBINED_V1_INSPECTOR_PORT = 9232;
export const AP4M_X402_COMBINED_V1_HEALTH_URL =
  `http://${AP4M_X402_COMBINED_V1_HOST}:${AP4M_X402_COMBINED_V1_PORT}/health`;

function sameKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function validateCombinedConfiguration(config) {
  if (
    !sameKeys(config, [
      "$schema", "compatibility_date", "compatibility_flags", "d1_databases",
      "main", "name", "vars",
    ]) ||
    config.$schema !== "node_modules/wrangler/config-schema.json" ||
    config.name !== "harbor-local-ap4m-x402-combined-v1-only" ||
    config.main !== "src/server.ts" ||
    config.compatibility_date !== "2026-10-06" ||
    JSON.stringify(config.compatibility_flags) !== JSON.stringify(["nodejs_compat"])
  ) throw new Error("Combined AP4M/x402 configuration is not exact");
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new Error("Combined AP4M/x402 D1 is not exact");
  }
  const d1 = config.d1_databases[0];
  if (
    !sameKeys(d1, ["binding", "database_id", "database_name", "migrations_dir", "remote"]) ||
    d1.binding !== "DB" || d1.database_id !== LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID ||
    d1.database_name !== LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME ||
    d1.migrations_dir !== "migrations-local-x402" || d1.remote !== false
  ) throw new Error("Combined AP4M/x402 D1 is not exact");
  const expectedVars = {
    HARBOR_SOURCE_TAG: "2610240",
    EXEC_NETWORK: "testnet",
    MAINNET_EXECUTION: "false",
    EXECUTOR: "quickjs",
    HARBOR_LOCAL_DEV: "true",
    HARBOR_LOCAL_READ_ONLY: "true",
    HARBOR_LOCAL_AUTH_REQUIRED: "true",
    HARBOR_LOCAL_CRON_DISABLED: "true",
    HARBOR_LOCAL_X402: "true",
    HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
    HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-isolated-v1",
    HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
    HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE: "reviewed-testnet-isolated-v1",
    [AP4M_X402_COMBINED_V1_RUNTIME_MARKER]: "true",
    [AP4M_X402_COMBINED_V1_PROFILE_MARKER]: AP4M_X402_COMBINED_V1_SIGNING_PROFILE,
    AP4M_DEMO_ENABLED: "true",
    AP4M_PURCHASE_MODE: "mock",
    HARBOR_MOCK: "1",
  };
  if (!sameKeys(config.vars, Object.keys(expectedVars))) {
    throw new Error("Combined AP4M/x402 variables are not exact");
  }
  for (const [key, value] of Object.entries(expectedVars)) {
    if (config.vars[key] !== value) {
      throw new Error("Combined AP4M/x402 variables are not exact");
    }
  }
}

export async function validateCombinedConfigurationFile(repoRoot = REPO_ROOT) {
  try {
    const config = JSON.parse(await readFile(
      join(repoRoot, AP4M_X402_COMBINED_V1_CONFIG),
      "utf8",
    ));
    validateCombinedConfiguration(config);
  } catch {
    throw new Error("Combined AP4M/x402 configuration could not be loaded");
  }
}

function requireRoot(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("Combined AP4M/x402 state root is required");
  }
  return value;
}

export function combinedCommands(repoRoot = REPO_ROOT, stateRoot) {
  const root = requireRoot(stateRoot);
  const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  return [
    {
      label: "catalog",
      command: process.execPath,
      args: [join(repoRoot, "scripts", "build-catalog.mjs")],
    },
    {
      label: "combined AP4M/x402 Worker",
      command: process.execPath,
      readinessUrl: AP4M_X402_COMBINED_V1_HEALTH_URL,
      args: [
        wrangler,
        "dev",
        "--local",
        "--ip",
        AP4M_X402_COMBINED_V1_HOST,
        "--inspector-ip",
        AP4M_X402_COMBINED_V1_HOST,
        "--inspector-port",
        String(AP4M_X402_COMBINED_V1_INSPECTOR_PORT),
        "--port",
        String(AP4M_X402_COMBINED_V1_PORT),
        "--persist-to",
        root,
        "--show-interactive-dev-session=false",
        "--config",
        join(repoRoot, AP4M_X402_COMBINED_V1_CONFIG),
        "--env-file",
        LOCAL_X402_ISOLATED_V1_SECRET_FILE,
      ],
    },
  ];
}

export function validateCombinedCommandPlan(commands, repoRoot, stateRoot, secrets) {
  const expected = combinedCommands(repoRoot, stateRoot);
  const sensitive = [secrets?.HARBOR_API_KEYS, secrets?.HARBOR_KEK].filter(Boolean);
  if (
    JSON.stringify(commands) !== JSON.stringify(expected) ||
    commands.length !== 2 ||
    commands.some((command) => command.args.some((argument) =>
      sensitive.some((value) => argument.includes(value)) ||
      /migrations?/iu.test(argument) ||
      /^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/iu.test(argument)
    ))
  ) throw new Error("Combined AP4M/x402 command plan is unsafe");
}

export function combinedChildEnvironment(source, stateRoot) {
  return {
    ...sanitizedChildEnvironment(source),
    WRANGLER_LOG_PATH: join(requireRoot(stateRoot), "combined-v1.wrangler.log"),
  };
}

export async function prepareCombinedLaunch(repoRoot = REPO_ROOT, {
  validateConfiguration = validateCombinedConfigurationFile,
  validateSecret = validateIsolatedX402SecretFile,
  validateRoot = validateConfiguredIsolatedX402StateRoot,
  validateState = validateExistingCombinedState,
  assertPayer = assertCombinedPayerBinding,
} = {}) {
  await validateConfiguration(repoRoot);
  const secrets = await validateSecret();
  const stateRoot = secrets.stateRoot;
  await validateRoot(stateRoot, { repoRoot });
  const state = await validateState(stateRoot, repoRoot);
  assertPayer(state.databasePath, secrets);
  const commands = combinedCommands(repoRoot, stateRoot);
  validateCombinedCommandPlan(commands, repoRoot, stateRoot, secrets);
  return { commands, secrets, stateRoot };
}

function sameSecrets(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export async function main(args = process.argv.slice(2), {
  prepare = prepareCombinedLaunch,
  run = runCommand,
  setUmask = process.umask,
  environment = combinedChildEnvironment,
  acquireLease = acquireIsolatedX402StateLease,
  revalidateSecret = validateIsolatedX402SecretFile,
  revalidateState = validateExistingCombinedState,
  assertPayer = assertCombinedPayerBinding,
} = {}) {
  validateLocalArguments(args);
  enforceLocalFileUmask(setUmask);
  const launch = await prepare();
  const env = environment(process.env, launch.stateRoot);
  let lease;
  try {
    for (const command of launch.commands) {
      if (command.label === "combined AP4M/x402 Worker") {
        const currentSecrets = await revalidateSecret();
        if (
          currentSecrets.stateRoot !== launch.stateRoot ||
          !sameSecrets(currentSecrets, launch.secrets)
        ) throw new Error("Combined AP4M/x402 credential changed before startup");
        const state = await revalidateState(launch.stateRoot);
        assertPayer(state.databasePath, currentSecrets);
      }
      await run(command, env);
      if (command.label === "catalog") {
        lease = await acquireLease(launch.stateRoot);
        const state = await revalidateState(launch.stateRoot);
        assertPayer(state.databasePath, launch.secrets);
      }
    }
  } finally {
    await lease?.release();
  }
}

export function runCli() {
  main().catch((error) => {
    if (error instanceof LauncherInterruptedError) {
      process.exitCode = error.signal === "SIGINT" ? 130 : error.signal === "SIGHUP" ? 129 : 143;
      return;
    }
    console.error(`harbor-local-ap4m-x402-combined-v1: ${
      error instanceof Error ? error.message : "startup failed"
    }`);
    process.exitCode = 1;
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();
