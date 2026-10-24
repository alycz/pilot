#!/usr/bin/env node

import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isValidClassicAddress } from "xrpl";

import {
  LauncherInterruptedError,
  enforceLocalFileUmask,
  runCommand,
  sanitizedChildEnvironment,
  validateLocalArguments,
} from "./dev-local.mjs";
import { assertMacAcl } from "./macos-acl.mjs";
import {
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID,
  LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME,
  acquireIsolatedX402StateLease,
  validateConfiguredIsolatedX402StateRoot,
  validateExistingIsolatedX402State,
} from "./local-x402-isolated-state.mjs";
import {
  X402_ISOLATED_V1_MIGRATION_DIRECTORY,
  validateIsolatedMigrationProfile,
} from "./isolated-migration-profiles.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EMPTY_ENV_FILE = "config/local-empty.env";
const SECRET_MAX_BYTES = 16_384;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const EXPECTED_SECRET_KEYS = new Set([
  "EXEC_NETWORK",
  "HARBOR_API_KEYS",
  "HARBOR_KEK",
  "HARBOR_LOCAL_AUTH_REQUIRED",
  "HARBOR_LOCAL_CRON_DISABLED",
  "HARBOR_LOCAL_READ_ONLY",
  "HARBOR_LOCAL_X402",
  "HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED",
  "HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE",
  "HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT",
  "HARBOR_LOCAL_X402_MERCHANT_PAY_TO",
  "HARBOR_LOCAL_X402_RUNTIME_ENABLED",
  "HARBOR_LOCAL_X402_SIGNING_PROFILE",
  "MAINNET_EXECUTION",
]);

export const LOCAL_X402_ISOLATED_V1_CONFIG =
  "wrangler.local-x402-isolated-v1.jsonc";
export const LOCAL_X402_ISOLATED_V1_STATE_DIRECTORY =
  ".wrangler/harbor-local-x402-isolated-v1";
export const LOCAL_X402_ISOLATED_V1_SECRET_FILE =
  (process.env.HARBOR_PRIVATE_SECRETS_ROOT ? resolve(process.env.HARBOR_PRIVATE_SECRETS_ROOT, "harbor-local-x402-isolated-v1.env.local") : "/dev/null/pilot-disabled/harbor-local-x402-isolated-v1.env.local");
export const LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE =
  "reviewed-testnet-isolated-v1";
export const LOCAL_X402_ISOLATED_V1_HOST = "127.0.0.2";
export const LOCAL_X402_ISOLATED_V1_PORT = 8792;
export const LOCAL_X402_ISOLATED_V1_INSPECTOR_PORT = 9232;
export const LOCAL_X402_ISOLATED_V1_ORIGIN =
  `http://${LOCAL_X402_ISOLATED_V1_HOST}:${LOCAL_X402_ISOLATED_V1_PORT}`;
export const LOCAL_X402_ISOLATED_V1_HEALTH_URL =
  `${LOCAL_X402_ISOLATED_V1_ORIGIN}/health`;

function sameKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function invalidSecret() {
  return new Error("Local isolated x402 secret file is missing or unsafe");
}

async function directoryMetadata(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (await realpath(path)) !== path) {
    throw invalidSecret();
  }
  return metadata;
}

export async function validateIsolatedX402SecretParentChain(
  path = dirname(LOCAL_X402_ISOLATED_V1_SECRET_FILE),
  { assertAcl = assertMacAcl } = {},
) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const immediate = await directoryMetadata(path);
  if ((immediate.mode & 0o777) !== 0o700 || (uid !== undefined && immediate.uid !== uid)) {
    throw invalidSecret();
  }
  assertAcl(path, "private");
  let ancestor = dirname(path);
  while (true) {
    const metadata = await directoryMetadata(ancestor);
    if (
      (metadata.mode & 0o022) !== 0 ||
      (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)
    ) throw invalidSecret();
    assertAcl(ancestor, "ancestor");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

export function parseIsolatedX402SecretFile(contents) {
  const values = Object.create(null);
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw invalidSecret();
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      !EXPECTED_SECRET_KEYS.has(name) ||
      Object.hasOwn(values, name) ||
      !value ||
      value !== value.trim() ||
      /[\r\n\0]/.test(value)
    ) throw invalidSecret();
    values[name] = value;
  }
  if (!sameKeys(values, EXPECTED_SECRET_KEYS)) throw invalidSecret();
  const expected = {
    EXEC_NETWORK: "testnet",
    MAINNET_EXECUTION: "false",
    HARBOR_LOCAL_READ_ONLY: "true",
    HARBOR_LOCAL_AUTH_REQUIRED: "true",
    HARBOR_LOCAL_CRON_DISABLED: "true",
    HARBOR_LOCAL_X402: "true",
    HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
    HARBOR_LOCAL_X402_SIGNING_PROFILE: LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
    HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
    HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
      LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (values[name] !== value) throw invalidSecret();
  }
  const credential = values.HARBOR_API_KEYS;
  if (credential.includes(",")) throw invalidSecret();
  const separator = credential.indexOf(":");
  const principal = credential.slice(0, separator);
  const token = credential.slice(separator + 1);
  if (
    separator <= 0 ||
    credential.indexOf(":", separator + 1) !== -1 ||
    principal === "local-dev" ||
    !PRINCIPAL.test(principal) ||
    !TOKEN.test(token)
  ) throw invalidSecret();
  const kek = values.HARBOR_KEK;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(kek) || Buffer.from(kek, "base64").length !== 32) {
    throw invalidSecret();
  }
  if (!isValidClassicAddress(values.HARBOR_LOCAL_X402_MERCHANT_PAY_TO)) {
    throw invalidSecret();
  }
  values.stateRoot = values.HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT;
  return values;
}

export async function validateIsolatedX402SecretFile(
  path = LOCAL_X402_ISOLATED_V1_SECRET_FILE,
  {
    openFile = open,
    lstatFile = lstat,
    validateParent = validateIsolatedX402SecretParentChain,
    assertAcl = assertMacAcl,
  } = {},
) {
  if (path !== LOCAL_X402_ISOLATED_V1_SECRET_FILE) throw invalidSecret();
  if (typeof FS_CONSTANTS.O_NOFOLLOW !== "number") throw invalidSecret();
  let handle;
  try {
    await validateParent(dirname(path), { assertAcl });
    handle = await openFile(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const metadata = await handle.stat();
    const permissions = metadata.mode & 0o777;
    if (
      metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
      metadata.size > SECRET_MAX_BYTES ||
      (permissions !== 0o400 && permissions !== 0o600) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw invalidSecret();
    const named = await lstatFile(path);
    if (
      named.isSymbolicLink() || named.dev !== metadata.dev || named.ino !== metadata.ino
    ) throw invalidSecret();
    assertAcl(path, "private");
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev || after.ino !== metadata.ino ||
      after.nlink !== 1 || after.size !== metadata.size
    ) throw invalidSecret();
    if (Buffer.byteLength(contents, "utf8") > SECRET_MAX_BYTES) throw invalidSecret();
    return parseIsolatedX402SecretFile(contents);
  } catch {
    throw invalidSecret();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function validateIsolatedX402Configuration(config) {
  if (
    !sameKeys(config, [
      "$schema", "compatibility_date", "compatibility_flags", "d1_databases",
      "main", "name", "vars",
    ]) ||
    config.$schema !== "node_modules/wrangler/config-schema.json" ||
    config.name !== "harbor-local-x402-isolated-v1-only" ||
    config.main !== "src/server.ts" ||
    config.compatibility_date !== "2026-10-06" ||
    JSON.stringify(config.compatibility_flags) !== JSON.stringify(["nodejs_compat"])
  ) throw new Error("Local isolated x402 configuration is not exact");
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new Error("Local isolated x402 D1 is not exact");
  }
  const database = config.d1_databases[0];
  if (
    !sameKeys(database, ["binding", "database_id", "database_name", "migrations_dir", "remote"]) ||
    database.binding !== "DB" ||
    database.database_name !== LOCAL_X402_ISOLATED_V1_D1_DATABASE_NAME ||
    database.database_id !== LOCAL_X402_ISOLATED_V1_D1_DATABASE_ID ||
    database.migrations_dir !== X402_ISOLATED_V1_MIGRATION_DIRECTORY ||
    database.remote !== false
  ) throw new Error("Local isolated x402 D1 is not exact");
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
    HARBOR_LOCAL_X402_SIGNING_PROFILE: LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
    HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
    HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
      LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
  };
  if (!sameKeys(config.vars, Object.keys(expectedVars))) {
    throw new Error("Local isolated x402 variables are not exact");
  }
  for (const [name, value] of Object.entries(expectedVars)) {
    if (config.vars[name] !== value) throw new Error("Local isolated x402 variables are not exact");
  }
}

export async function validateIsolatedX402ConfigurationFile(repoRoot = REPO_ROOT) {
  let config;
  try {
    config = JSON.parse(await readFile(join(repoRoot, LOCAL_X402_ISOLATED_V1_CONFIG), "utf8"));
  } catch {
    throw new Error("Local isolated x402 configuration could not be loaded");
  }
  validateIsolatedX402Configuration(config);
}

function requireStateRoot(stateRoot) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    throw new Error("Local isolated x402 state root is required");
  }
  return stateRoot;
}

export function isolatedX402MigrationCommand(repoRoot = REPO_ROOT, stateRoot) {
  const config = join(repoRoot, LOCAL_X402_ISOLATED_V1_CONFIG);
  const emptyEnv = join(repoRoot, EMPTY_ENV_FILE);
  const persistence = requireStateRoot(stateRoot);
  const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  return {
    label: "isolated x402 D1 migrations",
    command: process.execPath,
    args: [
      wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to",
      persistence, "--config", config, "--env-file", emptyEnv,
    ],
  };
}

export function validateIsolatedX402MigrationCommand(
  command,
  repoRoot = REPO_ROOT,
  stateRoot,
) {
  const expected = isolatedX402MigrationCommand(repoRoot, stateRoot);
  if (
    JSON.stringify(command) !== JSON.stringify(expected) ||
    command.readinessUrl !== undefined ||
    command.args.some((argument) =>
      /HARBOR_API_KEYS|HARBOR_KEK|SECRET|TOKEN|SEED|PRIVATE_KEY/i.test(argument) ||
      /^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument)
    )
  ) throw new Error("Local isolated x402 migration command is unsafe");
  return command;
}

export function isolatedX402Commands(repoRoot = REPO_ROOT, stateRoot) {
  const config = join(repoRoot, LOCAL_X402_ISOLATED_V1_CONFIG);
  const persistence = requireStateRoot(stateRoot);
  const wrangler = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  return [
    {
      label: "catalog",
      command: process.execPath,
      args: [join(repoRoot, "scripts", "build-catalog.mjs")],
    },
    {
      label: "isolated x402 Worker",
      command: process.execPath,
      readinessUrl: LOCAL_X402_ISOLATED_V1_HEALTH_URL,
      args: [
        wrangler, "dev", "--local", "--ip", LOCAL_X402_ISOLATED_V1_HOST,
        "--inspector-ip", LOCAL_X402_ISOLATED_V1_HOST, "--inspector-port",
        String(LOCAL_X402_ISOLATED_V1_INSPECTOR_PORT), "--port",
        String(LOCAL_X402_ISOLATED_V1_PORT), "--persist-to", persistence,
        "--show-interactive-dev-session=false", "--config", config, "--env-file",
        LOCAL_X402_ISOLATED_V1_SECRET_FILE,
      ],
    },
  ];
}

export function validateIsolatedX402CommandPlan(
  commands,
  repoRoot = REPO_ROOT,
  stateRoot,
  secrets,
) {
  const expected = isolatedX402Commands(repoRoot, stateRoot);
  if (JSON.stringify(commands) !== JSON.stringify(expected)) {
    throw new Error("Local isolated x402 command plan is not exact");
  }
  const sensitive = [secrets?.HARBOR_API_KEYS, secrets?.HARBOR_KEK].filter(Boolean);
  if (commands.length !== 2 || commands.some((command) => command.args.some((argument) =>
    sensitive.some((value) => argument.includes(value)) ||
    /migrations?/i.test(basename(argument)) ||
    /^(?:--?)?(?:deploy|publish|remote|tunnel|force|overwrite)(?:$|[=:-])/i.test(argument)
  ))) throw new Error("Local isolated x402 command plan is unsafe");
}

export function isolatedX402ChildEnvironment(source = process.env, stateRoot) {
  return {
    ...sanitizedChildEnvironment(source),
    WRANGLER_LOG_PATH: join(requireStateRoot(stateRoot), "wrangler.log"),
  };
}

export async function prepareIsolatedX402Launch(
  repoRoot = REPO_ROOT,
  {
    validateConfiguration = validateIsolatedX402ConfigurationFile,
    validateMigrationProfile = (root) =>
      validateIsolatedMigrationProfile(root, "x402-isolated-v1"),
    validateSecret = validateIsolatedX402SecretFile,
    validateStateRoot = validateConfiguredIsolatedX402StateRoot,
    validateState = validateExistingIsolatedX402State,
  } = {},
) {
  await validateConfiguration(repoRoot);
  await validateMigrationProfile(repoRoot);
  const secrets = await validateSecret();
  const stateRoot = secrets.stateRoot;
  await validateStateRoot(stateRoot, { repoRoot });
  await validateState(stateRoot, { repoRoot });
  const commands = isolatedX402Commands(repoRoot, stateRoot);
  validateIsolatedX402CommandPlan(commands, repoRoot, stateRoot, secrets);
  return { commands, secrets, stateRoot };
}

function sameSecretValues(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) =>
      key === expectedKeys[index] && actual[key] === expected[key]
    );
}

export async function main(
  args = process.argv.slice(2),
  {
    prepareLaunch = prepareIsolatedX402Launch,
    run = runCommand,
    setUmask = process.umask,
    environment = isolatedX402ChildEnvironment,
    acquireLease = acquireIsolatedX402StateLease,
    revalidateSecret = validateIsolatedX402SecretFile,
    revalidateState = validateExistingIsolatedX402State,
  } = {},
) {
  validateLocalArguments(args);
  enforceLocalFileUmask(setUmask);
  const launch = await prepareLaunch();
  const env = environment(process.env, launch.stateRoot);
  let lease;
  try {
    for (const command of launch.commands) {
      console.log(`[harbor-local-x402-isolated-v1] ${command.label}`);
      if (command.label === "isolated x402 Worker") {
        const currentSecrets = await revalidateSecret();
        if (
          currentSecrets.stateRoot !== launch.stateRoot ||
          !sameSecretValues(currentSecrets, launch.secrets)
        ) throw new Error("Local isolated x402 credential file changed before startup");
        await revalidateState(launch.stateRoot);
      }
      await run(command, env);
      if (command.label === "catalog") {
        lease = await acquireLease(launch.stateRoot);
        await revalidateState(launch.stateRoot);
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
    console.error(`harbor-local-x402-isolated-v1: ${error instanceof Error ? error.message : "startup failed"}`);
    process.exitCode = 1;
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();
