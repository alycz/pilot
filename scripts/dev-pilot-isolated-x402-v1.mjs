#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PILOT_PRIVATE_SECRETS_ROOT_ENV,
  PILOT_PRIVATE_STATE_ROOT_ENV,
  parseIsolatedCredentialFile,
  requirePrivateRoot,
} from "./dev-pilot-isolated-v1.mjs";

export const ISOLATED_X402_PILOT_PROFILE = "local-wallet-isolated-v1";
export const ISOLATED_X402_PILOT_BUILD_MARKER = "pilot-local-wallet-isolated-v1";
export const ISOLATED_X402_PILOT_CREDENTIAL_FILE_NAME =
  "pilot-isolated-v1.env.local";
export const ISOLATED_X402_PILOT_CAPABILITY_FILE_NAME =
  "pilot-isolated-x402-capability-v1.env.local";
export const ISOLATED_X402_PILOT_STATE_DIRECTORY_NAME =
  "p-live-isolated-v1";
export const ISOLATED_X402_TRADING_HARBOR_ORIGIN = "http://127.0.0.2:8791";
export const ISOLATED_X402_HARBOR_ORIGIN = "http://127.0.0.2:8792";

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
const NAMED_CREDENTIAL = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-Za-z0-9_-]{32,128})$/;

function assertPrivateOwned(info, description, expectedKind) {
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link`);
  if (!info[expectedKind]()) throw new Error(`${description} has the wrong file type`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${description} must be user-only`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${description} must be owned by the current user`);
  }
}

export function parseIsolatedX402CapabilityFile(source) {
  const result = {};
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(HARBOR_X402_API_KEY)=([^\s]+)$/.exec(line);
    if (!match) throw new Error(`Unsupported isolated x402 credential entry on line ${index + 1}`);
    if (Object.hasOwn(result, match[1])) {
      throw new Error(`Duplicate isolated x402 credential ${match[1]}`);
    }
    result[match[1]] = match[2];
  }
  const x402 = result.HARBOR_X402_API_KEY?.match(NAMED_CREDENTIAL);
  if (!x402) throw new Error("HARBOR_X402_API_KEY must be one named credential");
  return result;
}

export function combineIsolatedX402Credentials(baseSource, capabilitySource) {
  const base = parseIsolatedCredentialFile(baseSource);
  const capability = parseIsolatedX402CapabilityFile(capabilitySource);
  const primary = base.HARBOR_API_KEY?.match(NAMED_CREDENTIAL);
  const x402 = capability.HARBOR_X402_API_KEY.match(NAMED_CREDENTIAL);
  if (!primary) throw new Error("HARBOR_API_KEY must be one named credential");
  if (primary[1] === x402[1]) {
    throw new Error("The trading and x402 principals must be different");
  }
  if (primary[2] === x402[2]) {
    throw new Error("The trading and x402 bearer tokens must be different");
  }
  return { ...base, ...capability };
}

export function createIsolatedX402ChildEnvironment(environment, credentials, stateDirectory) {
  const child = {};
  for (const name of PASSTHROUGH_ENVIRONMENT) {
    if (environment[name] !== undefined) child[name] = environment[name];
  }
  return {
    ...child,
    NODE_ENV: "development",
    PILOT_DEPLOYMENT_PROFILE: ISOLATED_X402_PILOT_PROFILE,
    NEXT_PUBLIC_PILOT_BUILD_MARKER: ISOLATED_X402_PILOT_BUILD_MARKER,
    HARBOR_URL: ISOLATED_X402_TRADING_HARBOR_ORIGIN,
    HARBOR_X402_URL: ISOLATED_X402_HARBOR_ORIGIN,
    HARBOR_MOCK: "0",
    EXEC_NETWORK: "testnet",
    NEXT_PUBLIC_DEV_SIGNER: "1",
    P_LIVE_HARBOR_FOK_DEPLOYED: "1",
    P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED: "1",
    P_LIVE_HARBOR_EXECUTION_V2: "1",
    P_LIVE_RLUSD_ACQUISITION_STATE_DIR: stateDirectory,
    HARBOR_API_KEY: credentials.HARBOR_API_KEY,
    HARBOR_X402_API_KEY: credentials.HARBOR_X402_API_KEY,
    SESSION_SECRET: credentials.SESSION_SECRET,
  };
}

async function readPrivateCredentialFile(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertPrivateOwned(info, "The isolated Pilot credential input", "isFile");
    if (info.size > 16_384) throw new Error("The isolated Pilot credential input is too large");
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function buildIsolatedX402LaunchPlan({
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
    throw new Error(`Generic dotenv file is forbidden for isolated x402 Pilot: ${path}`);
  },
} = {}) {
  if (argv.length !== 0) throw new Error("The isolated x402 Pilot launcher accepts no arguments");
  for (const path of GENERIC_DOTENV_PATHS) await assertMissing(path);
  const secretsRoot = requirePrivateRoot(environment, PILOT_PRIVATE_SECRETS_ROOT_ENV);
  const stateRoot = requirePrivateRoot(environment, PILOT_PRIVATE_STATE_ROOT_ENV);
  const credentialFile = resolve(secretsRoot, ISOLATED_X402_PILOT_CREDENTIAL_FILE_NAME);
  const capabilityFile = resolve(secretsRoot, ISOLATED_X402_PILOT_CAPABILITY_FILE_NAME);
  const stateDirectory = resolve(stateRoot, ISOLATED_X402_PILOT_STATE_DIRECTORY_NAME);
  const credentials = combineIsolatedX402Credentials(
    await readCredentialFile(credentialFile),
    await readCredentialFile(capabilityFile),
  );
  const stateInfo = await lstatFile(stateDirectory);
  assertPrivateOwned(stateInfo, "The isolated Pilot state directory", "isDirectory");
  return {
    command: "pnpm",
    args: [
      "--filter", "web", "exec", "next", "dev",
      "--hostname", "127.0.0.2", "--port", "3003",
    ],
    cwd: REPOSITORY_ROOT,
    env: createIsolatedX402ChildEnvironment(environment, credentials, stateDirectory),
  };
}

async function main() {
  const plan = await buildIsolatedX402LaunchPlan({ argv: process.argv.slice(2) });
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
