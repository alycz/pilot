#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateIsolatedX402SecretFile } from "./dev-local-x402-isolated-v1.mjs";
import {
  assertCombinedPayerBinding,
  upgradeIsolatedX402StateToCombined,
} from "./local-ap4m-x402-combined-state.mjs";

const APPLY_FLAG = "--apply-offline-v1-to-combined";

function invalidArguments() {
  return new Error("Combined AP4M/x402 upgrade arguments are invalid");
}

export function parseUpgradeArguments(args) {
  if (
    !Array.isArray(args) || args.length !== 3 || args[0] !== APPLY_FLAG ||
    args[1] !== "--state-root" || typeof args[2] !== "string" ||
    !args[2] || resolve(args[2]) !== args[2]
  ) throw invalidArguments();
  return { stateRoot: args[2] };
}

export async function main(args = process.argv.slice(2), {
  validateSecret = validateIsolatedX402SecretFile,
  upgrade = upgradeIsolatedX402StateToCombined,
  output = console.log,
} = {}) {
  const { stateRoot } = parseUpgradeArguments(args);
  const secrets = await validateSecret();
  if (secrets.stateRoot !== stateRoot) throw invalidArguments();
  const result = await upgrade(stateRoot, {
    assertPayer: (databasePath) => assertCombinedPayerBinding(databasePath, secrets),
  });
  output(`Combined AP4M/x402 offline state upgrade verified: ${result.schemaFingerprint}`);
  return result;
}

export function runCli() {
  main().catch((error) => {
    console.error(`upgrade-local-ap4m-x402-combined-v1: ${
      error instanceof Error ? error.message : "upgrade failed"
    }`);
    process.exitCode = 1;
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();
