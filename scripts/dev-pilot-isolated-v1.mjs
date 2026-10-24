#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ISOLATED_PILOT_PROFILE = "local-wallet-isolated-v1";
export const ISOLATED_PILOT_BUILD_MARKER = "pilot-local-wallet-isolated-v1";
export const PILOT_PRIVATE_SECRETS_ROOT_ENV = "PILOT_PRIVATE_SECRETS_ROOT";
export const PILOT_PRIVATE_STATE_ROOT_ENV = "PILOT_PRIVATE_STATE_ROOT";

export function requirePrivateRoot(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`${name} must be an explicit absolute path`);
  }
  return value;
}
export const ISOLATED_PILOT_HARBOR_ORIGIN = "http://127.0.0.2:8791";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
export const WEB_DIRECTORY = join(REPOSITORY_ROOT, "apps", "web");
export const GENERIC_DOTENV_PATHS = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
].map((name) => join(WEB_DIRECTORY, name));

const PASSTHROUGH_ENVIRONMENT = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
];

function assertPrivateOwned(info, description, expectedKind) {
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link`);
  if (!info[expectedKind]()) throw new Error(`${description} has the wrong file type`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${description} must be user-only`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${description} must be owned by the current user`);
  }
}

export function parseIsolatedCredentialFile(source) {
  const result = {};
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(HARBOR_API_KEY|SESSION_SECRET)=([^\s]+)$/.exec(line);
    if (!match) throw new Error(`Unsupported isolated credential entry on line ${index + 1}`);
    if (Object.hasOwn(result, match[1])) {
      throw new Error(`Duplicate isolated credential ${match[1]}`);
    }
    result[match[1]] = match[2];
  }
  if (!result.HARBOR_API_KEY) throw new Error("HARBOR_API_KEY is missing");
  if (!result.SESSION_SECRET || result.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return result;
}

export function createIsolatedChildEnvironment(environment, credentials, stateDirectory) {
  const child = {};
  for (const name of PASSTHROUGH_ENVIRONMENT) {
    if (environment[name] !== undefined) child[name] = environment[name];
  }
  return {
    ...child,
    NODE_ENV: "development",
    PILOT_DEPLOYMENT_PROFILE: ISOLATED_PILOT_PROFILE,
    NEXT_PUBLIC_PILOT_BUILD_MARKER: ISOLATED_PILOT_BUILD_MARKER,
    HARBOR_URL: ISOLATED_PILOT_HARBOR_ORIGIN,
    HARBOR_MOCK: "0",
    EXEC_NETWORK: "testnet",
    NEXT_PUBLIC_DEV_SIGNER: "1",
    P_LIVE_HARBOR_FOK_DEPLOYED: "1",
    P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED: "1",
    P_LIVE_HARBOR_EXECUTION_V2: "1",
    P_LIVE_RLUSD_ACQUISITION_STATE_DIR: stateDirectory,
    HARBOR_API_KEY: credentials.HARBOR_API_KEY,
    SESSION_SECRET: credentials.SESSION_SECRET,
  };
}

async function readPrivateCredentialFile(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertPrivateOwned(info, "The isolated Pilot credential file", "isFile");
    if (info.size > 16_384) throw new Error("The isolated Pilot credential file is too large");
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function buildIsolatedLaunchPlan({
  argv = [],
  environment = process.env,
  lstatFile = lstat,
  readCredentialFile = readPrivateCredentialFile,
  assertMissing = async (path) => {
    try {
      await access(path, fsConstants.F_OK);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    throw new Error(`Generic dotenv file is forbidden for isolated Pilot: ${path}`);
  },
} = {}) {
  if (argv.length !== 0) throw new Error("The isolated Pilot launcher accepts no arguments");
  for (const path of GENERIC_DOTENV_PATHS) await assertMissing(path);

  const secretsRoot = requirePrivateRoot(environment, PILOT_PRIVATE_SECRETS_ROOT_ENV);
  const stateRoot = requirePrivateRoot(environment, PILOT_PRIVATE_STATE_ROOT_ENV);
  const credentialFile = resolve(secretsRoot, "pilot-isolated-v1.env.local");
  const stateDirectory = resolve(stateRoot, "p-live-isolated-v1");
  const credentials = parseIsolatedCredentialFile(
    await readCredentialFile(credentialFile),
  );

  const stateInfo = await lstatFile(stateDirectory);
  assertPrivateOwned(stateInfo, "The isolated Pilot state directory", "isDirectory");

  return {
    command: "pnpm",
    args: [
      "--filter",
      "web",
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.2",
      "--port",
      "3003",
    ],
    cwd: REPOSITORY_ROOT,
    env: createIsolatedChildEnvironment(environment, credentials, stateDirectory),
  };
}

async function main() {
  const plan = await buildIsolatedLaunchPlan({ argv: process.argv.slice(2) });
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
