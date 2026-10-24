import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AP4M_X402_COMBINED_V1_CONFIG,
  AP4M_X402_COMBINED_V1_HEALTH_URL,
  combinedCommands,
  main,
  prepareCombinedLaunch,
  validateCombinedCommandPlan,
  validateCombinedConfiguration,
} from "../scripts/dev-local-ap4m-x402-combined-v1.mjs";
import {
  AP4M_X402_COMBINED_V1_PROFILE_MARKER,
  AP4M_X402_COMBINED_V1_RUNTIME_MARKER,
  AP4M_X402_COMBINED_V1_SIGNING_PROFILE,
} from "../scripts/local-ap4m-x402-combined-state.mjs";
import {
  main as upgradeMain,
  parseUpgradeArguments,
} from "../scripts/upgrade-local-ap4m-x402-combined-v1.mjs";

const REPO_ROOT = resolve(process.cwd());
const STATE_ROOT = "/private/tmp/approved-isolated-x402-v1";
const DB_PATH = `${STATE_ROOT}/v3/d1/miniflare-D1DatabaseObject/${"a".repeat(64)}.sqlite`;

function secrets(stateRoot = STATE_ROOT) {
  return {
    HARBOR_API_KEYS: `combined-principal:${"T".repeat(32)}`,
    HARBOR_KEK: Buffer.alloc(32, 0x22).toString("base64"),
    HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT: stateRoot,
    stateRoot,
  };
}

function lease(events: string[] = []) {
  return vi.fn(async () => {
    events.push("lease");
    return { release: vi.fn(async () => events.push("release")) };
  });
}

describe("inactive combined AP4M/x402 profile and launcher", () => {
  it("pins the existing isolated-x402 D1 and remains mock/inactive by default", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, AP4M_X402_COMBINED_V1_CONFIG), "utf8"));
    expect(() => validateCombinedConfiguration(config)).not.toThrow();
    expect(config.d1_databases).toEqual([{
      binding: "DB",
      database_name: "harbor-local-x402-isolated-v1-only",
      database_id: "33333333-3333-3333-3333-333333333333",
      migrations_dir: "migrations-local-x402",
      remote: false,
    }]);
    expect(config.vars).toMatchObject({
      [AP4M_X402_COMBINED_V1_RUNTIME_MARKER]: "true",
      [AP4M_X402_COMBINED_V1_PROFILE_MARKER]: AP4M_X402_COMBINED_V1_SIGNING_PROFILE,
      AP4M_DEMO_ENABLED: "true",
      AP4M_PURCHASE_MODE: "mock",
      HARBOR_MOCK: "1",
      MAINNET_EXECUTION: "false",
    });
    expect(config.vars).not.toHaveProperty("LIVE");
  });

  it("uses the exact external root and has no migration, remote, or secret argument", () => {
    const commands = combinedCommands(REPO_ROOT, STATE_ROOT);
    expect(() => validateCombinedCommandPlan(commands, REPO_ROOT, STATE_ROOT, secrets()))
      .not.toThrow();
    expect(commands.map(({ label }) => label)).toEqual([
      "catalog",
      "combined AP4M/x402 Worker",
    ]);
    expect(commands[1]?.readinessUrl).toBe(AP4M_X402_COMBINED_V1_HEALTH_URL);
    expect(commands[1]?.args[commands[1].args.indexOf("--persist-to") + 1]).toBe(STATE_ROOT);
    expect(JSON.stringify(commands)).not.toMatch(/migrations apply|--remote|T{32}/u);
    expect(() => combinedCommands(REPO_ROOT, "")).toThrow(/state root is required/u);
  });

  it("prepares only after config, credential-bound root, combined marker/schema, and payer", async () => {
    const order: string[] = [];
    const launch = await prepareCombinedLaunch(REPO_ROOT, {
      validateConfiguration: vi.fn(async () => { order.push("config"); }),
      validateSecret: vi.fn(async () => { order.push("secret"); return secrets(); }),
      validateRoot: vi.fn(async () => { order.push("root"); }),
      validateState: vi.fn(async () => { order.push("state"); return {
        databasePath: DB_PATH,
        schemaFingerprint: "f".repeat(64),
      }; }),
      assertPayer: vi.fn(() => { order.push("payer"); return {
        principal: "combined-principal",
        payer: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      }; }),
    });
    expect(order).toEqual(["config", "secret", "root", "state", "payer"]);
    expect(launch.stateRoot).toBe(STATE_ROOT);
  });

  it("refuses a different root or D1 identity before starting", async () => {
    const wrongRoot = { ...secrets("/private/tmp/different-root") };
    await expect(prepareCombinedLaunch(REPO_ROOT, {
      validateConfiguration: vi.fn(async () => undefined),
      validateSecret: vi.fn(async () => wrongRoot),
      validateRoot: vi.fn(async () => { throw new Error("wrong root"); }),
      validateState: vi.fn(),
      assertPayer: vi.fn(),
    })).rejects.toThrow("wrong root");

    const config = JSON.parse(readFileSync(join(REPO_ROOT, AP4M_X402_COMBINED_V1_CONFIG), "utf8"));
    config.d1_databases[0].database_id = "44444444-4444-4444-4444-444444444444";
    expect(() => validateCombinedConfiguration(config)).toThrow(/D1 is not exact/u);
  });

  it("holds one root lease for the Worker lifetime and refuses a concurrent v1 or second process", async () => {
    const events: string[] = [];
    const commands = combinedCommands(REPO_ROOT, STATE_ROOT);
    const run = vi.fn(async (command: { label: string }) => events.push(`run:${command.label}`));
    await main([], {
      prepare: vi.fn(async () => ({ commands, secrets: secrets(), stateRoot: STATE_ROOT })),
      run,
      setUmask: vi.fn(),
      environment: vi.fn(() => ({})),
      acquireLease: lease(events),
      revalidateSecret: vi.fn(async () => secrets()),
      revalidateState: vi.fn(async () => ({ databasePath: DB_PATH })),
      assertPayer: vi.fn(() => events.push("payer")),
    });
    expect(events).toEqual([
      "run:catalog",
      "lease",
      "payer",
      "payer",
      "run:combined AP4M/x402 Worker",
      "release",
    ]);

    const blockedRun = vi.fn();
    await expect(main([], {
      prepare: vi.fn(async () => ({ commands, secrets: secrets(), stateRoot: STATE_ROOT })),
      run: blockedRun,
      setUmask: vi.fn(),
      environment: vi.fn(() => ({})),
      acquireLease: vi.fn(async () => { throw new Error("preserved state is already leased"); }),
      revalidateSecret: vi.fn(),
      revalidateState: vi.fn(),
      assertPayer: vi.fn(),
    })).rejects.toThrow("already leased");
    expect(blockedRun).toHaveBeenCalledTimes(1);
    expect(blockedRun).toHaveBeenCalledWith(commands[0], {});
  });

  it("requires an explicit offline-upgrade flag and the exact credential-bound root", async () => {
    expect(parseUpgradeArguments([
      "--apply-offline-v1-to-combined",
      "--state-root",
      STATE_ROOT,
    ])).toEqual({ stateRoot: STATE_ROOT });
    for (const args of [
      [],
      ["--state-root", STATE_ROOT],
      ["--apply-offline-v1-to-combined", "--state-root", "relative"],
    ]) expect(() => parseUpgradeArguments(args)).toThrow(/arguments are invalid/u);

    const upgrade = vi.fn();
    await expect(upgradeMain([
      "--apply-offline-v1-to-combined",
      "--state-root",
      STATE_ROOT,
    ], {
      validateSecret: vi.fn(async () => secrets("/private/tmp/different-root")),
      upgrade,
      output: vi.fn(),
    })).rejects.toThrow(/arguments are invalid/u);
    expect(upgrade).not.toHaveBeenCalled();
  });
});
