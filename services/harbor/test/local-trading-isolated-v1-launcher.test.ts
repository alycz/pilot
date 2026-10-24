import { constants as FS_CONSTANTS } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runCommand } from "../scripts/dev-local.mjs";

import {
  LOCAL_FILE_UMASK,
  LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN,
  LOCAL_TRADING_ISOLATED_V1_CONFIG,
  LOCAL_TRADING_ISOLATED_V1_HEALTH_URL,
  LOCAL_TRADING_ISOLATED_V1_HOST,
  LOCAL_TRADING_ISOLATED_V1_ORIGIN,
  LOCAL_TRADING_ISOLATED_V1_PORT,
  LOCAL_TRADING_ISOLATED_V1_SECRET_FILE,
  LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE,
  LOCAL_TRADING_ISOLATED_V1_STATE_DIRECTORY,
  LOCAL_TRADING_ISOLATED_V1_STATE_ROOT,
  isolatedTradingChildEnvironment,
  isolatedTradingCommands,
  main,
  validateIsolatedTradingCommandPlan,
  validateIsolatedTradingConfiguration,
  validateIsolatedTradingConfigurationFile,
  validateIsolatedTradingSecretFile,
} from "../scripts/dev-local-trading-isolated-v1.mjs";

const repoRoot = process.cwd();
const secretContents = [
  `HARBOR_API_KEYS=isolated-principal:${"A".repeat(32)}`,
  `HARBOR_KEK=${Buffer.alloc(32, 7).toString("base64")}`,
  "",
].join("\n");
const secretValues = {
  HARBOR_API_KEYS: `isolated-principal:${"A".repeat(32)}`,
  HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function secretHandle(contents = secretContents) {
  return {
    stat: vi.fn(async () => ({
      isSymbolicLink: () => false,
      isFile: () => true,
      mode: 0o100600,
      nlink: 1,
      size: Buffer.byteLength(contents),
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
    })),
    readFile: vi.fn(async () => contents),
    close: vi.fn(async () => undefined),
  };
}

describe("local trading isolated v1 launcher", () => {
  it("freezes the isolated profile, origin, build origin, and command topology", () => {
    expect(LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE).toBe(
      "local-wallet-isolated-v1",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_BUILD_ORIGIN).toBe(
      "local-trading-isolated-v1",
    );
    expect(LOCAL_TRADING_ISOLATED_V1_HOST).toBe("127.0.0.2");
    expect(LOCAL_TRADING_ISOLATED_V1_PORT).toBe(8791);
    expect(LOCAL_TRADING_ISOLATED_V1_ORIGIN).toBe("http://127.0.0.2:8791");
    expect(LOCAL_TRADING_ISOLATED_V1_HEALTH_URL).toBe(
      "http://127.0.0.2:8791/health",
    );

    const [catalog, migration, worker] = isolatedTradingCommands(repoRoot);
    const state = LOCAL_TRADING_ISOLATED_V1_STATE_ROOT;
    const config = join(repoRoot, LOCAL_TRADING_ISOLATED_V1_CONFIG);

    expect(catalog.args).toEqual([join(repoRoot, "scripts", "build-catalog.mjs")]);
    expect(valueAfter(migration.args, "--persist-to")).toBe(state);
    expect(valueAfter(worker.args, "--persist-to")).toBe(state);
    expect(valueAfter(migration.args, "--config")).toBe(config);
    expect(valueAfter(worker.args, "--config")).toBe(config);
    expect(valueAfter(migration.args, "--env-file")).toBe(
      join(repoRoot, "config", "local-empty.env"),
    );
    expect(valueAfter(worker.args, "--env-file")).toBe(
      LOCAL_TRADING_ISOLATED_V1_SECRET_FILE,
    );
    expect(valueAfter(worker.args, "--ip")).toBe("127.0.0.2");
    expect(valueAfter(worker.args, "--inspector-ip")).toBe("127.0.0.2");
    expect(valueAfter(worker.args, "--port")).toBe("8791");
    expect(worker.readinessUrl).toBe("http://127.0.0.2:8791/health");
    expect(() =>
      validateIsolatedTradingCommandPlan(
        isolatedTradingCommands(repoRoot),
        repoRoot,
        secretValues,
      ),
    ).not.toThrow();
  });

  it("keeps the child environment sparse and logs only inside isolated state", () => {
    const env = isolatedTradingChildEnvironment({
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      DATABASE_URL: "database-secret",
      HARBOR_API_KEYS: "inherited-secret",
      HARBOR_KEK: "inherited-kek",
      HTTPS_PROXY: "http://proxy.invalid",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.WRANGLER_LOG_PATH).toBe(
      join(LOCAL_TRADING_ISOLATED_V1_STATE_ROOT, "wrangler.log"),
    );
    for (const name of [
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "HARBOR_API_KEYS",
      "HARBOR_KEK",
      "HTTPS_PROXY",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("probes readiness only at the exact isolated health URL without a socket", async () => {
    const worker = isolatedTradingCommands(repoRoot)[2];
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 57912,
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
        signalSource,
        fetchProcess,
        readinessTimeoutMs: 50,
        readinessRetryMs: 1,
        spawnProcess: () => child,
        treeIsRunning: () => false,
      }),
    ).resolves.toBeUndefined();
    expect(fetchProcess).toHaveBeenCalledOnce();
  });

  it.each([
    "http://127.0.0.3:8791/health",
    "http://127.0.0.2:8793/health",
    "http://localhost:8791/health",
    "https://127.0.0.2:8791/health",
  ])("rejects non-contract readiness target %s", async (readinessUrl) => {
    const worker = {
      ...isolatedTradingCommands(repoRoot)[2],
      readinessUrl,
    };
    const child = Object.assign(new EventEmitter(), {
      pid: 57913,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const fetchProcess = vi.fn();

    await expect(
      runCommand(worker, { PATH: "/bin" }, {
        signalSource: new EventEmitter(),
        fetchProcess,
        spawnProcess: () => child,
        treeIsRunning: () => false,
      }),
    ).rejects.toThrow(
      "Local Harbor process-health target is not the fixed loopback interface",
    );
    expect(fetchProcess).not.toHaveBeenCalled();
  });

  it("validates only the exact credential path through injected file access", async () => {
    const handle = secretHandle();
    const openFile = vi.fn(async () => handle);
    const validateParent = vi.fn(async () => undefined);

    await expect(
      validateIsolatedTradingSecretFile(LOCAL_TRADING_ISOLATED_V1_SECRET_FILE, {
        openFile,
        validateParent,
      }),
    ).resolves.toEqual(secretValues);
    expect(openFile).toHaveBeenCalledWith(
      LOCAL_TRADING_ISOLATED_V1_SECRET_FILE,
      FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
    );
    expect(validateParent).toHaveBeenCalledWith(
      "/absolute/private/pilot/harbor-secrets",
    );
    expect(handle.close).toHaveBeenCalledOnce();

    await expect(
      validateIsolatedTradingSecretFile(
        "/absolute/private/pilot/harbor-secrets/harbor-local-trading.env.local",
        { openFile, validateParent },
      ),
    ).rejects.toThrow("Local trading isolated v1 secret file is missing or unsafe");
    expect(openFile).toHaveBeenCalledOnce();
  });

  it.each([
    ["legacy principal", secretContents.replace("isolated-principal", "local-dev")],
    ["multiple credentials", secretContents.replace("\nHARBOR_KEK", `,other:${"B".repeat(32)}\nHARBOR_KEK`)],
    ["unknown key", `${secretContents}HARBOR_LOCAL_TRADING_RUNTIME_ENABLED=true\n`],
    ["weak token", secretContents.replace("A".repeat(32), "short")],
    ["invalid KEK", secretContents.replace(/HARBOR_KEK=.*/, "HARBOR_KEK=invalid")],
  ])("rejects %s without exposing credential contents", async (_name, contents) => {
    const handle = secretHandle(contents);
    await expect(
      validateIsolatedTradingSecretFile(LOCAL_TRADING_ISOLATED_V1_SECRET_FILE, {
        openFile: async () => handle,
        validateParent: async () => undefined,
      }),
    ).rejects.toThrow("Local trading isolated v1 secret file is missing or unsafe");
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects old, mixed, remote, and overridden command plans", () => {
    const patches = [
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--ip") + 1] = "127.0.0.1";
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--inspector-ip") + 1] = "localhost";
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--port") + 1] = "8792";
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].readinessUrl = "http://127.0.0.2:8792/health";
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[1].args[commands[1].args.indexOf("--persist-to") + 1] =
          join(repoRoot, ".wrangler", "harbor-local-trading");
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--config") + 1] =
          join(repoRoot, "wrangler.local-trading.jsonc");
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args[commands[2].args.indexOf("--env-file") + 1] =
          "/absolute/private/pilot/harbor-secrets/harbor-local-trading.env.local";
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args.push("--remote");
      },
      (commands: ReturnType<typeof isolatedTradingCommands>) => {
        commands[2].args.push("--force");
      },
    ];

    for (const patch of patches) {
      const commands = structuredClone(isolatedTradingCommands(repoRoot));
      patch(commands);
      expect(() =>
        validateIsolatedTradingCommandPlan(commands, repoRoot, secretValues),
      ).toThrow();
    }
    const allArgs = isolatedTradingCommands(repoRoot).flatMap((command) => command.args);
    expect(allArgs).not.toContain(secretValues.HARBOR_API_KEYS);
    expect(allArgs).not.toContain(secretValues.HARBOR_KEK);
  });

  it("validates an exact isolated D1 and marker-only testnet config", async () => {
    const config = JSON.parse(
      await readFile(join(repoRoot, LOCAL_TRADING_ISOLATED_V1_CONFIG), "utf8"),
    ) as Record<string, any>;

    expect(() => validateIsolatedTradingConfiguration(config)).not.toThrow();
    await expect(
      validateIsolatedTradingConfigurationFile(repoRoot),
    ).resolves.toBeUndefined();
    expect(config.name).toBe("harbor-local-trading-isolated-v1-only");
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
      HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE:
        "local-wallet-isolated-v1",
    });
    for (const legacyMarker of [
      "HARBOR_LOCAL_TRADING_RUNTIME_ENABLED",
      "HARBOR_LOCAL_TRADING_SIGNING_PROFILE",
      "HARBOR_LOCAL_TRADING_ONBOARDING_RUNTIME_ENABLED",
      "HARBOR_LOCAL_TRADING_ONBOARDING_SIGNING_PROFILE",
      "HARBOR_LOCAL_X402_SIGNING_PROFILE",
    ]) {
      expect(config.vars).not.toHaveProperty(legacyMarker);
      expect(() =>
        validateIsolatedTradingConfiguration({
          ...config,
          vars: { ...config.vars, [legacyMarker]: "mixed" },
        }),
      ).toThrow();
    }

    for (const patch of [
      { triggers: { crons: ["* * * * *"] } },
      { vars: { ...config.vars, EXEC_NETWORK: "mainnet" } },
      { vars: { ...config.vars, EXECUTOR: "remote" } },
      { vars: { ...config.vars, HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true" } },
      { vars: { ...config.vars, HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "false" } },
      { vars: { ...config.vars, HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE: "unreviewed" } },
      { d1_databases: [{ ...config.d1_databases[0], remote: true }] },
      { d1_databases: [{ ...config.d1_databases[0], database_name: "harbor-local-trading-only" }] },
    ]) {
      expect(() => validateIsolatedTradingConfiguration({ ...config, ...patch })).toThrow();
    }
  });

  it("rejects every CLI argument before preparation or execution", async () => {
    for (const argument of ["--remote", "--deploy", "--tunnel", "--force", "--port=9000", "extra"]) {
      const prepareLaunch = vi.fn();
      const run = vi.fn();
      await expect(
        main([argument], { prepareLaunch, run, setUmask: vi.fn() }),
      ).rejects.toThrow();
      expect(prepareLaunch).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("sets umask before preparation and revalidates migrations before a Worker", async () => {
    const commands = isolatedTradingCommands(repoRoot).slice(1);
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

  it("registers only the exact package launcher command", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["dev:local:trading:isolated:v1"]).toBe(
      "node scripts/dev-local-trading-isolated-v1.mjs",
    );
  });
});
