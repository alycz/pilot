#!/usr/bin/env -S node --experimental-transform-types

import { pathToFileURL } from "node:url";

import { JsonKeyStore, type LocalKmsStore } from "../../tools/aws-local/src/key-store.ts";
import { handleKms } from "../../tools/aws-local/src/kms.ts";
import {
  appendProbeStatus,
  EVENT_AUTHORITY_REQUIRED,
  exactHarborCleanupAlias,
  parseKmsProbeCli,
  type KmsProbeMode,
} from "./kms-probe-support.ts";

export type CleanupResult = {
  mode: KmsProbeMode;
  status: "pass";
  aliasesInspected: number;
  keysScheduled: number;
  aliases: string[];
  bedrockKeyToRevoke: string;
  scope: "explicit-standin-state" | "authorized-live-account";
};

export type CleanupOptions = {
  mode: KmsProbeMode;
  store?: LocalKmsStore;
  bedrockKeyName: string;
  statusFile?: string;
  now?: () => Date;
  output?: (line: string) => void;
  eventRunner?: () => Promise<CleanupResult>;
};

export async function runCleanup(options: CleanupOptions): Promise<CleanupResult> {
  if (!options.bedrockKeyName.trim()) throw new Error("BEDROCK_KEY_NAME_REQUIRED");
  if (options.mode === "event") {
    if (!options.eventRunner) throw new Error(EVENT_AUTHORITY_REQUIRED);
    const result = await options.eventRunner();
    if (result.mode !== "event" || result.status !== "pass" || result.scope !== "authorized-live-account") {
      throw new Error("EVENT_EVIDENCE_INVALID");
    }
    await appendProbeStatus(options.statusFile, "cleanup", `event scheduled=${result.keysScheduled} bedrock_key=${result.bedrockKeyToRevoke}`, options.now);
    options.output?.(JSON.stringify(result));
    return result;
  }
  if (!options.store) throw new Error("EXPLICIT_STANDIN_STATE_REQUIRED");

  const state = await options.store.load();
  const entries = Object.entries(state.aliases)
    .filter(([alias]) => exactHarborCleanupAlias(alias))
    .sort(([left], [right]) => left.localeCompare(right));
  const keyIds = [...new Set(entries.map(([, keyId]) => keyId))];
  for (const keyId of keyIds) {
    if (!state.keys[keyId]) throw new Error("STANDIN_ALIAS_TARGET_MISSING");
  }
  const unscheduledKeyIds = keyIds.filter((keyId) => state.keys[keyId]?.deletionDate === undefined);
  for (const keyId of unscheduledKeyIds) {
    await handleKms("TrentService.ScheduleKeyDeletion", {
      KeyId: keyId,
      PendingWindowInDays: 7,
    }, options.store);
  }
  const result: CleanupResult = {
    mode: "standin",
    status: "pass",
    aliasesInspected: entries.length,
    keysScheduled: unscheduledKeyIds.length,
    aliases: entries.map(([alias]) => alias),
    bedrockKeyToRevoke: options.bedrockKeyName,
    scope: "explicit-standin-state",
  };
  await appendProbeStatus(options.statusFile, "cleanup", `standin explicit-state scheduled=${result.keysScheduled} bedrock_key=${result.bedrockKeyToRevoke}`, options.now);
  options.output?.(JSON.stringify(result));
  return result;
}

async function main(): Promise<void> {
  const args = parseKmsProbeCli(process.argv.slice(2));
  if (args.mode === "event") throw new Error(EVENT_AUTHORITY_REQUIRED);
  if (!args.storeFile) throw new Error("EXPLICIT_STANDIN_STATE_REQUIRED");
  if (!args.bedrockKeyName) throw new Error("BEDROCK_KEY_NAME_REQUIRED");
  await runCleanup({
    mode: "standin",
    store: new JsonKeyStore(args.storeFile),
    bedrockKeyName: args.bedrockKeyName,
    statusFile: args.statusFile,
    output: (line) => process.stdout.write(`${line}\n`),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "CLEANUP_FAILED";
    process.stderr.write(`aws-cleanup: fail ${message}\n`);
    process.exitCode = 1;
  });
}
