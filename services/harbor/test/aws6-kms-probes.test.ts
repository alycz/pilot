import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCleanup } from "../scripts/aws/cleanup";
import { runK1 } from "../scripts/aws/k1-kms-sign";
import { runK2 } from "../scripts/aws/k2-latency";
import { parseKmsProbeCli } from "../scripts/aws/kms-probe-support";
import { MemoryKeyStore, type LocalKmsState } from "../tools/aws-local/src/key-store";
import { handleKms } from "../tools/aws-local/src/kms";

describe("AWS-6 KMS probes", () => {
  it("signs a synthetic OfferCreate with real stand-in Ed25519 without claiming Testnet", async () => {
    const output = vi.fn();
    const result = await runK1({ mode: "standin", output, linkId: "k1-kms-sign" });

    expect(result).toMatchObject({
      mode: "standin",
      status: "pass",
      evidence: "local-ed25519-signed-blob",
      alias: "alias/harbor/testnet/k1-kms-sign",
    });
    expect(result.hash).toMatch(/^[A-F0-9]{64}$/);
    expect(result).not.toHaveProperty("ledgerIndex");
    expect(output).toHaveBeenCalledWith(expect.stringContaining("local-ed25519-signed-blob"));
    expect(output).not.toHaveBeenCalledWith(expect.stringMatching(/validated-testnet-offer/));
  });

  it("requires an explicit authorized runner for the event/Testnet k1 path", async () => {
    await expect(runK1({ mode: "event" })).rejects.toThrow("EVENT_AUTHORITY_REQUIRED");
  });

  it("makes exactly 20 Sign calls and reports nearest-rank p50/p95", async () => {
    const store = new MemoryKeyStore();
    const sign = vi.fn((input) => handleKms("TrentService.Sign", input, store));
    const ticks = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? index * 5 : index * 5 + (index + 1) / 2);
    const result = await runK2({
      mode: "standin",
      store,
      sign,
      nowMs: () => ticks.shift() ?? 0,
    });
    expect(sign).toHaveBeenCalledTimes(20);
    expect(result.calls).toBe(20);
    expect(result.p50Ms).toBe(15);
    expect(result.p95Ms).toBe(24);
  });

  it("cleans the exact Harbor KEK and test-network aliases from explicit stand-in state", async () => {
    const initial: LocalKmsState = {
      keys: {
        "testnet-key": {
          keyId: "testnet-key",
          arn: "arn:aws:kms:us-east-1:000000000000:key/testnet-key",
          keySpec: "ECC_NIST_EDWARDS25519",
          keyUsage: "SIGN_VERIFY",
          material: Buffer.alloc(32, 1).toString("base64"),
          createdAt: "2026-10-21T00:00:00.000Z",
          tags: [],
        },
        "other-key": {
          keyId: "other-key",
          arn: "arn:aws:kms:us-east-1:000000000000:key/other-key",
          keySpec: "ECC_NIST_EDWARDS25519",
          keyUsage: "SIGN_VERIFY",
          material: Buffer.alloc(32, 2).toString("base64"),
          createdAt: "2026-10-21T00:00:00.000Z",
          tags: [],
        },
        "kek-key": {
          keyId: "kek-key",
          arn: "arn:aws:kms:us-east-1:000000000000:key/kek-key",
          keySpec: "SYMMETRIC_DEFAULT",
          keyUsage: "ENCRYPT_DECRYPT",
          material: Buffer.alloc(32, 3).toString("base64"),
          createdAt: "2026-10-21T00:00:00.000Z",
          tags: [],
        },
      },
      aliases: {
        "alias/harbor/kek": "kek-key",
        "alias/harbor/testnet/link-1": "testnet-key",
        "alias/harbor/mainnet/forbidden": "other-key",
        "alias/other/testnet/link-2": "other-key",
      },
    };
    const store = new MemoryKeyStore(initial);
    const result = await runCleanup({
      mode: "standin",
      store,
      bedrockKeyName: "event-bedrock-api-key",
    });

    expect(result).toEqual({
      mode: "standin",
      status: "pass",
      aliasesInspected: 2,
      keysScheduled: 2,
      aliases: ["alias/harbor/kek", "alias/harbor/testnet/link-1"],
      bedrockKeyToRevoke: "event-bedrock-api-key",
      scope: "explicit-standin-state",
    });
    const finalState = await store.load();
    expect(finalState.keys["testnet-key"]?.deletionDate).toBeDefined();
    expect(finalState.keys["kek-key"]?.deletionDate).toBeDefined();
    expect(finalState.keys["other-key"]?.deletionDate).toBeUndefined();

    const repeated = await runCleanup({
      mode: "standin",
      store,
      bedrockKeyName: "event-bedrock-api-key",
    });
    expect(repeated).toMatchObject({ aliasesInspected: 2, keysScheduled: 0 });
  });

  it("requires explicit stand-in state and never auto-discovers a key store", async () => {
    await expect(runCleanup({
      mode: "standin",
      bedrockKeyName: "event-bedrock-api-key",
    })).rejects.toThrow("EXPLICIT_STANDIN_STATE_REQUIRED");
  });

  it("parses strict name/value flags and appends only to an explicit status path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aws6-kms-probe-"));
    const previous = process.cwd();
    process.chdir(directory);
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir("status"));
      const statusFile = join(process.cwd(), "status", "probe.md");
      expect(parseKmsProbeCli([
        "--mode", "standin",
        "--status-file", "status/probe.md",
        "--store-file", join(directory, "keys.json"),
        "--bedrock-key-name", "event-key",
      ])).toMatchObject({ mode: "standin", statusFile });
      expect(() => parseKmsProbeCli(["--mode", "standin", "--unknown", "x"]))
        .toThrow("INVALID_ARGUMENTS");
      expect(() => parseKmsProbeCli([
        "--mode", "standin", "--status-file", "../outside.md",
      ])).toThrow("INVALID_STATUS_PATH");

      await runK1({
        mode: "standin",
        statusFile,
        linkId: "status-test",
        now: () => new Date("2026-10-21T00:00:00.000Z"),
      });
      expect(await readFile(statusFile, "utf8")).toMatch(
        /^2026-10-21T00:00:00.000Z \| AWS-6 \| k1-kms-sign \| pass \| standin local-ed25519-signed-blob hash=[A-F0-9]{64}\n$/,
      );
    } finally {
      process.chdir(previous);
    }
  });
});
