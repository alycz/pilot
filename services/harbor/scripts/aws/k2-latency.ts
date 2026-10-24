#!/usr/bin/env -S node --experimental-transform-types

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { MemoryKeyStore, type LocalKmsStore } from "../../tools/aws-local/src/key-store.ts";
import { handleKms } from "../../tools/aws-local/src/kms.ts";
import {
  appendProbeStatus,
  EVENT_AUTHORITY_REQUIRED,
  parseKmsProbeCli,
  type KmsProbeMode,
} from "./kms-probe-support.ts";

const SAMPLE_COUNT = 20;
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

export type K2Result = {
  mode: KmsProbeMode;
  status: "pass";
  calls: 20;
  p50Ms: number;
  p95Ms: number;
};

export type K2Options = {
  mode: KmsProbeMode;
  sign?: (input: {
    KeyId: string;
    Message: string;
    MessageType: "RAW";
    SigningAlgorithm: "ED25519_SHA_512";
  }) => Promise<unknown>;
  store?: LocalKmsStore;
  nowMs?: () => number;
  statusFile?: string;
  now?: () => Date;
  output?: (line: string) => void;
  eventRunner?: () => Promise<K2Result>;
};

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

export async function runK2(options: K2Options): Promise<K2Result> {
  if (options.mode === "event") {
    if (!options.eventRunner) throw new Error(EVENT_AUTHORITY_REQUIRED);
    const result = await options.eventRunner();
    if (result.mode !== "event" || result.status !== "pass" || result.calls !== SAMPLE_COUNT) {
      throw new Error("EVENT_EVIDENCE_INVALID");
    }
    await appendProbeStatus(options.statusFile, "k2-latency", `event calls=20 p50_ms=${result.p50Ms} p95_ms=${result.p95Ms}`, options.now);
    options.output?.(JSON.stringify(result));
    return result;
  }

  const store = options.store ?? new MemoryKeyStore();
  const created = await handleKms("TrentService.CreateKey", {
    KeySpec: "ECC_NIST_EDWARDS25519",
    KeyUsage: "SIGN_VERIFY",
    Tags: [
      { TagKey: "harbor:principal", TagValue: "aws6-k2-standin" },
      { TagKey: "harbor:owner", TagValue: OWNER },
      { TagKey: "harbor:network", TagValue: "testnet" },
    ],
  }, store);
  const keyMetadata = created.KeyMetadata;
  if (typeof keyMetadata !== "object" || keyMetadata === null || Array.isArray(keyMetadata)) {
    throw new Error("STANDIN_RESPONSE_INVALID");
  }
  const keyId = (keyMetadata as Record<string, unknown>).KeyId;
  if (typeof keyId !== "string" || keyId.length === 0) throw new Error("STANDIN_RESPONSE_INVALID");
  const sign = options.sign ?? ((input) => handleKms("TrentService.Sign", input, store));
  const nowMs = options.nowMs ?? (() => performance.now());
  const message = Buffer.from("aws6-k2-local-sign-latency", "utf8").toString("base64");
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = nowMs();
    await sign({
      KeyId: keyId,
      Message: message,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    });
    samples.push(Math.max(0, nowMs() - started));
  }
  samples.sort((left, right) => left - right);
  const result: K2Result = {
    mode: "standin",
    status: "pass",
    calls: 20,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
  };
  await appendProbeStatus(options.statusFile, "k2-latency", `standin calls=20 p50_ms=${result.p50Ms} p95_ms=${result.p95Ms}`, options.now);
  options.output?.(JSON.stringify(result));
  return result;
}

async function main(): Promise<void> {
  const args = parseKmsProbeCli(process.argv.slice(2));
  if (args.mode === "event") throw new Error(EVENT_AUTHORITY_REQUIRED);
  await runK2({
    mode: "standin",
    statusFile: args.statusFile,
    output: (line) => process.stdout.write(`${line}\n`),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "K2_FAILED";
    process.stderr.write(`k2-latency: fail ${message}\n`);
    process.exitCode = 1;
  });
}
