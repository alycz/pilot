import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LOCAL_HEALTH_URL } from "../scripts/dev-local.mjs";
import {
  LOCAL_TRADING_SECRET_FILE,
  LOCAL_TRADING_STATE_DIRECTORY,
} from "../scripts/dev-local-trading.mjs";
import {
  LOCAL_FILE_UMASK,
  LOCAL_TRADING_ONBOARDING_CONFIG,
  LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
  main,
  onboardingCommands,
  validateOnboardingCommandPlan,
  validateOnboardingConfiguration,
  validateOnboardingConfigurationFile,
} from "../scripts/dev-local-trading-onboarding.mjs";

const repoRoot = process.cwd();
const secretValues = {
  HARBOR_API_KEYS: `trading-principal:${"A".repeat(32)}`,
  HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("isolated local trading onboarding launcher", () => {
  it("uses the exact shared trading state, secret, loopback, and onboarding config", () => {
    const [catalog, migration, worker] = onboardingCommands(repoRoot);
    const persistence = join(repoRoot, LOCAL_TRADING_STATE_DIRECTORY);
    const config = join(repoRoot, LOCAL_TRADING_ONBOARDING_CONFIG);

    expect(catalog.args).toEqual([join(repoRoot, "scripts", "build-catalog.mjs")]);
    expect(valueAfter(migration.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(worker.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(migration.args, "--config")).toBe(config);
    expect(valueAfter(worker.args, "--config")).toBe(config);
    expect(valueAfter(migration.args, "--env-file")).toBe(
      join(repoRoot, "config", "local-empty.env"),
    );
    expect(valueAfter(worker.args, "--env-file")).toBe(
      LOCAL_TRADING_SECRET_FILE,
    );
    expect(valueAfter(worker.args, "--ip")).toBe("127.0.0.1");
    expect(valueAfter(worker.args, "--inspector-ip")).toBe("127.0.0.1");
    expect(valueAfter(worker.args, "--port")).toBe("8791");
    expect(worker.readinessUrl).toBe(LOCAL_HEALTH_URL);
    expect(() =>
      validateOnboardingCommandPlan(onboardingCommands(repoRoot), repoRoot, secretValues),
    ).not.toThrow();
  });

  it("rejects command tampering and never places secret values in argv", () => {
    const commands = onboardingCommands(repoRoot);
    expect(commands.flatMap((command) => command.args)).not.toContain(
      secretValues.HARBOR_API_KEYS,
    );
    expect(commands.flatMap((command) => command.args)).not.toContain(
      secretValues.HARBOR_KEK,
    );

    const tampered = structuredClone(commands);
    const worker = tampered[2];
    const port = worker.args.indexOf("--port");
    worker.args[port + 1] = "9000";
    expect(() =>
      validateOnboardingCommandPlan(tampered, repoRoot, secretValues),
    ).toThrow("Local trading onboarding command plan is invalid");
  });

  it("sets umask before preparation and revalidates migration output", async () => {
    const commands = onboardingCommands(repoRoot).slice(1);
    const events: string[] = [];
    const run = vi.fn(async () => events.push("run"));
    const revalidateState = vi.fn(async () => events.push("revalidate"));

    await main([], {
      setUmask: (mask: number) => {
        expect(mask).toBe(LOCAL_FILE_UMASK);
        events.push("umask");
      },
      environment: () => ({ PATH: "/bin" }),
      prepareLaunch: async () => {
        events.push("prepare");
        return commands;
      },
      run,
      revalidateState,
    });

    expect(events).toEqual(["umask", "prepare", "run", "revalidate", "run"]);
    expect(revalidateState).toHaveBeenCalledOnce();
  });

  it("uses an exact testnet-only config without runtime trading or cloud fields", async () => {
    const config = JSON.parse(
      await readFile(join(repoRoot, LOCAL_TRADING_ONBOARDING_CONFIG), "utf8"),
    ) as Record<string, any>;

    expect(() => validateOnboardingConfiguration(config)).not.toThrow();
    await expect(validateOnboardingConfigurationFile(repoRoot)).resolves.toBeUndefined();
    expect(config).not.toHaveProperty("triggers");
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("worker_loaders");
    expect(config.vars).not.toHaveProperty("HARBOR_LOCAL_TRADING_RUNTIME_ENABLED");
    expect(config.vars).not.toHaveProperty("HARBOR_LOCAL_TRADING_SIGNING_PROFILE");
    expect(config.vars).toMatchObject({
      EXEC_NETWORK: "testnet",
      MAINNET_EXECUTION: "false",
      HARBOR_LOCAL_CRON_DISABLED: "true",
      HARBOR_LOCAL_X402: "false",
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
      HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE:
        LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE,
    });
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "harbor-local-trading-only",
        database_id: "11111111-1111-1111-1111-111111111111",
        migrations_dir: "migrations",
        remote: false,
      },
    ]);

    for (const patch of [
      { triggers: { crons: ["* * * * *"] } },
      { vars: { ...config.vars, EXEC_NETWORK: "devnet" } },
      { vars: { ...config.vars, HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true" } },
      { vars: { ...config.vars, HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true" } },
      { d1_databases: [{ ...config.d1_databases[0], remote: true }] },
    ]) {
      expect(() => validateOnboardingConfiguration({ ...config, ...patch })).toThrow();
    }
  });
});
