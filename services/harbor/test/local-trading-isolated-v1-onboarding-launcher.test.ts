import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCommand } from "../scripts/dev-local.mjs";
import {
  LOCAL_FILE_UMASK,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_CONFIG,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HEALTH_URL,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HOST,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_ORIGIN,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_PORT,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SECRET_FILE,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE,
  LOCAL_TRADING_ISOLATED_V1_ONBOARDING_STATE_DIRECTORY,
  LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
  isolatedOnboardingChildEnvironment,
  isolatedOnboardingCommands,
  main,
  validateIsolatedOnboardingCommandPlan,
  validateIsolatedOnboardingConfiguration,
  validateIsolatedOnboardingConfigurationFile,
} from "../scripts/dev-local-trading-isolated-v1-onboarding.mjs";

const repoRoot = process.cwd();
const secretValues = {
  HARBOR_API_KEYS: `isolated-principal:${"A".repeat(32)}`,
  HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("local trading isolated v1 onboarding launcher", () => {
  it("freezes the exact sequential onboarding profile and shared local artifacts", () => {
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE).toBe(
      "local-wallet-isolated-onboarding-v1",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_BUILD_ORIGIN).toBe(
      "local-trading-isolated-onboarding-v1",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HOST).toBe("127.0.0.2");
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_PORT).toBe(8791);
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_ORIGIN).toBe(
      "http://127.0.0.2:8791",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_HEALTH_URL).toBe(
      "http://127.0.0.2:8791/health",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_STATE_DIRECTORY).toBe(
      ".wrangler/harbor-local-trading-isolated-v1",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SECRET_FILE).toBe(
      "/absolute/private/pilot/harbor-secrets/harbor-local-trading-isolated-v1.env.local",
    );

    const [catalog, migration, worker] = isolatedOnboardingCommands(repoRoot);
    const persistence = LOCAL_TRADING_ISOLATED_V1_STATE_ROOT;
    const config = join(repoRoot, LOCAL_TRADING_ISOLATED_V1_ONBOARDING_CONFIG);

    expect(catalog.args).toEqual([join(repoRoot, "scripts", "build-catalog.mjs")]);
    expect(valueAfter(migration.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(worker.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(migration.args, "--config")).toBe(config);
    expect(valueAfter(worker.args, "--config")).toBe(config);
    expect(valueAfter(migration.args, "--env-file")).toBe(
      join(repoRoot, "config", "local-empty.env"),
    );
    expect(valueAfter(worker.args, "--env-file")).toBe(
      LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SECRET_FILE,
    );
    expect(valueAfter(worker.args, "--ip")).toBe("127.0.0.2");
    expect(valueAfter(worker.args, "--inspector-ip")).toBe("127.0.0.2");
    expect(valueAfter(worker.args, "--port")).toBe("8791");
    expect(worker.readinessUrl).toBe("http://127.0.0.2:8791/health");
    expect(() =>
      validateIsolatedOnboardingCommandPlan(
        isolatedOnboardingCommands(repoRoot),
        repoRoot,
        secretValues,
      ),
    ).not.toThrow();
  });

  it("uses a distinct onboarding log and strips inherited credentials", () => {
    const env = isolatedOnboardingChildEnvironment({
      PATH: "/usr/bin",
      HARBOR_API_KEYS: "inherited-secret",
      HARBOR_KEK: "inherited-kek",
      DATABASE_URL: "database-secret",
      HTTPS_PROXY: "http://proxy.invalid",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.WRANGLER_LOG_PATH).toBe(
      join(
        LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
        "onboarding.wrangler.log",
      ),
    );
    expect(env.WRANGLER_LOG_PATH.endsWith("/wrangler.log")).toBe(false);
    for (const name of [
      "HARBOR_API_KEYS",
      "HARBOR_KEK",
      "DATABASE_URL",
      "HTTPS_PROXY",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("reuses process-health readiness at only the exact isolated URL", async () => {
    const worker = isolatedOnboardingCommands(repoRoot)[2];
    const child = Object.assign(new EventEmitter(), {
      pid: 57921,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const fetchProcess = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.2:8791/health");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 0);
      return Response.json({
        ok: true,
        service: "harbor",
        health: "process",
        handoff_readiness: "not_evaluated",
      });
    });

    await expect(
      runCommand(worker, { PATH: "/bin" }, {
        platform: "linux",
        signalSource: new EventEmitter(),
        fetchProcess,
        readinessTimeoutMs: 50,
        readinessRetryMs: 1,
        spawnProcess: () => child,
        treeIsRunning: () => false,
      }),
    ).resolves.toBeUndefined();
    expect(fetchProcess).toHaveBeenCalledOnce();
  });

  it("rejects legacy, trading, remote, and overridden command plans", () => {
    const patches = [
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--ip") + 1] = "127.0.0.1";
      },
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--port") + 1] = "8792";
      },
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[1].args[commands[1].args.indexOf("--persist-to") + 1] =
          join(repoRoot, ".wrangler", "harbor-local-trading");
      },
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--config") + 1] =
          join(repoRoot, "wrangler.local-trading-isolated-v1.jsonc");
      },
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--env-file") + 1] =
          "/absolute/private/pilot/harbor-secrets/harbor-local-trading.env.local";
      },
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[2].args.push("--remote");
      },
      (commands: ReturnType<typeof isolatedOnboardingCommands>) => {
        commands[2].args.push("--tunnel");
      },
    ];

    for (const patch of patches) {
      const commands = structuredClone(isolatedOnboardingCommands(repoRoot));
      patch(commands);
      expect(() =>
        validateIsolatedOnboardingCommandPlan(commands, repoRoot, secretValues),
      ).toThrow();
    }
    const allArgs = isolatedOnboardingCommands(repoRoot).flatMap(
      (command) => command.args,
    );
    expect(allArgs).not.toContain(secretValues.HARBOR_API_KEYS);
    expect(allArgs).not.toContain(secretValues.HARBOR_KEK);
  });

  it("validates only the exact isolated onboarding D1 and marker profile", async () => {
    const config = JSON.parse(
      await readFile(
        join(repoRoot, LOCAL_TRADING_ISOLATED_V1_ONBOARDING_CONFIG),
        "utf8",
      ),
    ) as Record<string, any>;

    expect(() => validateIsolatedOnboardingConfiguration(config)).not.toThrow();
    await expect(
      validateIsolatedOnboardingConfigurationFile(repoRoot),
    ).resolves.toBeUndefined();
    expect(config.name).toBe("harbor-local-trading-isolated-v1-onboarding-only");
    expect(config).not.toHaveProperty("triggers");
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("worker_loaders");
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "harbor-local-trading-isolated-v1-only",
        database_id: "22222222-2222-2222-2222-222222222222",
        migrations_dir: "migrations-profile-trading-isolated-v1",
        remote: false,
      },
    ]);
    expect(config.vars).toMatchObject({
      EXEC_NETWORK: "testnet",
      EXECUTOR: "quickjs",
      MAINNET_EXECUTION: "false",
      HARBOR_LOCAL_CRON_DISABLED: "true",
      HARBOR_LOCAL_X402: "false",
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
        "local-wallet-isolated-onboarding-v1",
    });

    for (const mixedMarker of [
      "HARBOR_LOCAL_TRADING_RUNTIME_ENABLED",
      "HARBOR_LOCAL_TRADING_SIGNING_PROFILE",
      "HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED",
      "HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE",
      "HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED",
      "HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE",
      "HARBOR_LOCAL_X402_SIGNING_PROFILE",
    ]) {
      expect(config.vars).not.toHaveProperty(mixedMarker);
      expect(() =>
        validateIsolatedOnboardingConfiguration({
          ...config,
          vars: { ...config.vars, [mixedMarker]: "mixed" },
        }),
      ).toThrow();
    }

    for (const patch of [
      { triggers: { crons: ["* * * * *"] } },
      { vars: { ...config.vars, EXEC_NETWORK: "mainnet" } },
      { vars: { ...config.vars, EXECUTOR: "remote" } },
      { vars: { ...config.vars, HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true" } },
      {
        vars: {
          ...config.vars,
          HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED: "false",
        },
      },
      {
        vars: {
          ...config.vars,
          HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE:
            "local-wallet-isolated-v1",
        },
      },
      { d1_databases: [{ ...config.d1_databases[0], remote: true }] },
      {
        d1_databases: [
          { ...config.d1_databases[0], database_name: "harbor-local-trading-only" },
        ],
      },
    ]) {
      expect(() =>
        validateIsolatedOnboardingConfiguration({ ...config, ...patch }),
      ).toThrow();
    }
  });

  it("rejects every argument before any preparation or execution", async () => {
    for (const argument of [
      "--remote",
      "--deploy",
      "--tunnel",
      "--force",
      "--port=9000",
      "extra",
    ]) {
      const prepareLaunch = vi.fn();
      const run = vi.fn();
      await expect(
        main([argument], { prepareLaunch, run, setUmask: vi.fn() }),
      ).rejects.toThrow();
      expect(prepareLaunch).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("sets umask and revalidates migrations before the Worker", async () => {
    const commands = isolatedOnboardingCommands(repoRoot).slice(1);
    const events: string[] = [];

    await main([], {
      setUmask: (mask: number) => {
        expect(mask).toBe(LOCAL_FILE_UMASK);
        events.push("umask");
      },
      environment: () => {
        events.push("environment");
        return { PATH: "/bin" };
      },
      prepareLaunch: async () => {
        events.push("prepare");
        return commands;
      },
      run: async () => {
        events.push("run");
      },
      revalidateState: async () => {
        events.push("revalidate");
      },
    });

    expect(events).toEqual([
      "umask",
      "environment",
      "prepare",
      "revalidate",
      "run",
      "revalidate",
      "revalidate",
      "run",
    ]);
  });

  it("registers only the exact no-arguments package launcher", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["dev:local:trading:isolated:v1:onboarding"]).toBe(
      "node scripts/dev-local-trading-isolated-v1-onboarding.mjs",
    );
  });
});
