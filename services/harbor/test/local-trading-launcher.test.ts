import { spawnSync } from "node:child_process";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_FILE_UMASK,
  LOCAL_TRADING_CONFIG,
  LOCAL_TRADING_SECRET_FILE,
  LOCAL_TRADING_SIGNING_PROFILE,
  LOCAL_TRADING_STATE_DIRECTORY,
  ensureTradingStateDirectory,
  main,
  tradingChildEnvironment,
  tradingCommands,
  validateTradingCommandPlan,
  validateTradingConfiguration,
  validateTradingConfigurationFile,
  validateTradingSecretParentChain,
  validateTradingSecretFile,
  validateTradingStateDirectory,
} from "../scripts/dev-local-trading.mjs";
import { LOCAL_HEALTH_URL } from "../scripts/dev-local.mjs";

const repoRoot = process.cwd();
const temporaryDirectories: string[] = [];
const testSecretContents = [
  `HARBOR_API_KEYS=trading-principal:${"A".repeat(32)}`,
  `HARBOR_KEK=${Buffer.alloc(32, 9).toString("base64")}`,
  "",
].join("\n");

function privateFixture(prefix: string): string {
  const directory = mkdtempSync(join(realpathSync(repoRoot), `.${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function secretFileMetadata(overrides: Record<string, unknown> = {}) {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
    mode: 0o100600,
    nlink: 1,
    size: Buffer.byteLength(testSecretContents),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    ...overrides,
  };
}

function secretFileHandle(
  metadata = secretFileMetadata(),
  contents = testSecretContents,
) {
  return {
    stat: vi.fn(async () => metadata),
    readFile: vi.fn(async () => contents),
    close: vi.fn(async () => undefined),
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("isolated local trading launcher", () => {
  it("sets umask before validation and spawning", async () => {
    const events: string[] = [];
    const command = { label: "fixture", command: "/node", args: ["fixture.js"] };

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
        return [command];
      },
      run: async (actual: typeof command) => {
        expect(actual).toBe(command);
        events.push("spawn");
      },
    });

    expect(events).toEqual(["umask", "environment", "prepare", "spawn"]);
  });

  it("uses only the fixed loopback port, isolated state, config, and env files", () => {
    const [catalog, migration, worker] = tradingCommands(repoRoot);
    const persistence = join(repoRoot, LOCAL_TRADING_STATE_DIRECTORY);
    const config = join(repoRoot, LOCAL_TRADING_CONFIG);
    const emptyEnv = join(repoRoot, "config", "local-empty.env");

    expect(catalog.args).toEqual([join(repoRoot, "scripts", "build-catalog.mjs")]);
    expect(migration.args).toContain("--local");
    expect(worker.args).toContain("--local");
    expect(valueAfter(migration.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(worker.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(migration.args, "--config")).toBe(config);
    expect(valueAfter(worker.args, "--config")).toBe(config);
    expect(valueAfter(migration.args, "--env-file")).toBe(emptyEnv);
    expect(valueAfter(worker.args, "--env-file")).toBe(LOCAL_TRADING_SECRET_FILE);
    expect(valueAfter(worker.args, "--ip")).toBe("127.0.0.1");
    expect(valueAfter(worker.args, "--inspector-ip")).toBe("127.0.0.1");
    expect(valueAfter(worker.args, "--port")).toBe("8791");
    expect(worker.readinessUrl).toBe(LOCAL_HEALTH_URL);
    expect(worker.args.join(" ")).not.toContain("wrangler.jsonc");
    expect(worker.args.join(" ")).not.toContain(".dev.vars");
    expect(() =>
      validateTradingCommandPlan(tradingCommands(repoRoot), repoRoot, {
        HARBOR_API_KEYS: `trading-principal:${"A".repeat(32)}`,
        HARBOR_KEK: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).not.toThrow();

    const tampered = structuredClone(tradingCommands(repoRoot));
    const port = tampered[2].args.indexOf("--port");
    tampered[2].args[port + 1] = "9000";
    expect(() =>
      validateTradingCommandPlan(tampered, repoRoot, {
        HARBOR_API_KEYS: `trading-principal:${"A".repeat(32)}`,
        HARBOR_KEK: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toThrow("Local trading command plan is invalid");
  });

  it("uses a sparse child environment and keeps its log inside trading state", () => {
    const env = tradingChildEnvironment({
      PATH: "/usr/bin",
      DATABASE_URL: "secret-db",
      SENTRY_DSN: "secret-sentry",
      CI_JOB_JWT: "secret-ci",
      HTTPS_PROXY: "http://proxy.invalid",
      AWS_SECRET_ACCESS_KEY: "secret-cloud",
      HARBOR_KEK: "secret-kek",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.WRANGLER_LOG_PATH).toBe(
      join(repoRoot, LOCAL_TRADING_STATE_DIRECTORY, "wrangler.log"),
    );
    for (const name of [
      "DATABASE_URL",
      "SENTRY_DSN",
      "CI_JOB_JWT",
      "HTTPS_PROXY",
      "AWS_SECRET_ACCESS_KEY",
      "HARBOR_KEK",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env.CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe("false");
    expect(env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe("true");
  });

  it("lets Wrangler load only the explicit fixture env file", () => {
    const directory = privateFixture("harbor-trading-wrangler-env");
    const config = join(directory, "wrangler.fixture.jsonc");
    const explicit = join(directory, "approved.fixture.env");
    writeFileSync(config, "{}\n", { mode: 0o600 });
    writeFileSync(explicit, [
      `HARBOR_API_KEYS=fixture-principal:${"B".repeat(32)}`,
      `HARBOR_KEK=${Buffer.alloc(32, 4).toString("base64")}`,
      "EXPLICIT_ONLY=loaded",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(directory, ".dev.vars"), "DEV_VARS_ONLY=must-not-load\n", {
      mode: 0o600,
    });
    writeFileSync(join(directory, ".env"), "DOT_ENV_ONLY=must-not-load\n", {
      mode: 0o600,
    });

    const script = [
      'const { unstable_getVarsForDev } = require("wrangler");',
      "const bindings = unstable_getVarsForDev(process.argv[1], [process.argv[2]], {}, undefined, true);",
      "const values = Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, binding.value]));",
      "process.stdout.write(JSON.stringify(values));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["-e", script, config, explicit], {
      cwd: repoRoot,
      encoding: "utf8",
      env: tradingChildEnvironment({
        PATH: process.env.PATH,
        HARBOR_API_KEYS: "inherited-principal:must-not-load",
        HARBOR_KEK: "inherited-kek-must-not-load",
        PROCESS_ONLY: "must-not-load",
      }),
    });

    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({
      HARBOR_API_KEYS: `fixture-principal:${"B".repeat(32)}`,
      HARBOR_KEK: Buffer.alloc(32, 4).toString("base64"),
      EXPLICIT_ONLY: "loaded",
    });
  });

  it("revalidates migration-created state before the Worker can spawn", async () => {
    const commands = tradingCommands(repoRoot).slice(1);
    const run = vi.fn(async () => undefined);
    const revalidateState = vi.fn(async () => {
      throw new Error("unsafe migration output");
    });

    await expect(
      main([], {
        setUmask: vi.fn(),
        environment: () => ({ PATH: "/bin" }),
        prepareLaunch: async () => commands,
        run,
        revalidateState,
      }),
    ).rejects.toThrow("unsafe migration output");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(commands[0], { PATH: "/bin" });
    expect(revalidateState).toHaveBeenCalledOnce();
  });

  it("validates the exact secret file contract without exposing values", async () => {
    const handle = secretFileHandle();
    const openFile = vi.fn(async () => handle);
    const validateParent = vi.fn(async () => undefined);

    await expect(
      validateTradingSecretFile(LOCAL_TRADING_SECRET_FILE, {
        openFile,
        validateParent,
      }),
    ).resolves.toMatchObject({
      HARBOR_API_KEYS: `trading-principal:${"A".repeat(32)}`,
    });
    expect(openFile).toHaveBeenCalledWith(
      LOCAL_TRADING_SECRET_FILE,
      FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW,
    );
    expect(handle.close).toHaveBeenCalledOnce();
    expect(validateParent).toHaveBeenCalledOnce();

    const secretValue = "must-not-be-reflected";
    const unsafe = secretFileHandle(
      secretFileMetadata({ mode: 0o100644 }),
      testSecretContents.replace("0123456789abcdef", secretValue),
    );
    await expect(
      validateTradingSecretFile(LOCAL_TRADING_SECRET_FILE, {
        openFile: async () => unsafe,
        validateParent,
      }),
    ).rejects.not.toThrow(secretValue);
    await expect(
      validateTradingSecretFile("/tmp/alternate.env", {
        openFile,
        validateParent,
      }),
    ).rejects.toThrow("Local trading secret file is missing or unsafe");
  });

  it.each([
    ["multiple credentials", testSecretContents.replace(
      `trading-principal:${"A".repeat(32)}`,
      `trading-principal:${"A".repeat(32)},other:${"B".repeat(32)}`,
    )],
    ["local-dev principal", testSecretContents.replace("trading-principal", "local-dev")],
    ["weak token", testSecretContents.replace("A".repeat(32), "too-short")],
    ["noncanonical KEK", testSecretContents.replace(/HARBOR_KEK=.*/, "HARBOR_KEK=not-base64")],
    ["unknown key", `${testSecretContents}CLOUDFLARE_API_TOKEN=never\n`],
  ])("rejects %s in the trading secret file", async (_name, contents) => {
    await expect(
      validateTradingSecretFile(LOCAL_TRADING_SECRET_FILE, {
        openFile: async () => secretFileHandle(secretFileMetadata(), contents),
        validateParent: async () => undefined,
      }),
    ).rejects.toThrow("Local trading secret file is missing or unsafe");
  });

  it.each([
    ["hard link", { nlink: 2 }],
    ["oversized file", { size: 4_097 }],
    ["group-readable file", { mode: 0o100640 }],
    ["non-regular file", { isFile: () => false }],
  ])("rejects secret file metadata with %s", async (_name, overrides) => {
    await expect(
      validateTradingSecretFile(LOCAL_TRADING_SECRET_FILE, {
        openFile: async () => secretFileHandle(secretFileMetadata(overrides)),
        validateParent: async () => undefined,
      }),
    ).rejects.toThrow("Local trading secret file is missing or unsafe");
  });

  it("rejects an unsafe secret parent before opening the file", async () => {
    const openFile = vi.fn();
    await expect(
      validateTradingSecretFile(LOCAL_TRADING_SECRET_FILE, {
        openFile,
        validateParent: async () => {
          throw new Error("unsafe parent detail");
        },
      }),
    ).rejects.toThrow("Local trading secret file is missing or unsafe");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("accepts read-only ancestors but requires an exact private secrets directory", async () => {
    const ancestor = privateFixture("harbor-trading-secret");
    const secrets = join(ancestor, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    chmodSync(ancestor, 0o755);

    await expect(validateTradingSecretParentChain(secrets)).resolves.toBeUndefined();

    chmodSync(secrets, 0o755);
    await expect(validateTradingSecretParentChain(secrets)).rejects.toThrow(
      "Local trading secret file is missing or unsafe",
    );
    expect(lstatSync(secrets).mode & 0o777).toBe(0o755);
  });

  it("rejects writable or symlinked secret ancestors without changing them", async () => {
    const ancestor = privateFixture("harbor-trading-secret");
    const realSecrets = join(ancestor, "real-secrets");
    const linkedSecrets = join(ancestor, "linked-secrets");
    mkdirSync(realSecrets, { mode: 0o700 });

    chmodSync(ancestor, 0o775);
    await expect(validateTradingSecretParentChain(realSecrets)).rejects.toThrow(
      "Local trading secret file is missing or unsafe",
    );
    expect(lstatSync(ancestor).mode & 0o777).toBe(0o775);

    chmodSync(ancestor, 0o700);
    symlinkSync(realSecrets, linkedSecrets);
    await expect(validateTradingSecretParentChain(linkedSecrets)).rejects.toThrow(
      "Local trading secret file is missing or unsafe",
    );
    expect(lstatSync(linkedSecrets).isSymbolicLink()).toBe(true);
  });

  it("creates a missing state root privately and accepts a fully private tree", async () => {
    const parent = privateFixture("harbor-trading-state");
    const missing = join(parent, "missing");
    await expect(ensureTradingStateDirectory(missing)).resolves.toBeUndefined();
    expect(lstatSync(missing).mode & 0o777).toBe(0o700);

    const state = join(parent, "state");
    const nested = join(state, "v3", "d1");
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    chmodSync(join(state, "v3"), 0o700);
    chmodSync(nested, 0o700);
    writeFileSync(join(nested, "state.sqlite"), "fixture", { mode: 0o600 });
    writeFileSync(join(nested, "state.sqlite-wal"), "fixture", { mode: 0o600 });
    await expect(validateTradingStateDirectory(state)).resolves.toBeUndefined();
  });

  it("rejects every insecure nested entry without chmod or deletion", async () => {
    const parent = privateFixture("harbor-trading-state");
    const state = join(parent, "state");
    const nested = join(state, "nested");
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    chmodSync(nested, 0o755);
    const database = join(nested, "state.sqlite");
    writeFileSync(database, "fixture", { mode: 0o600 });

    await expect(validateTradingStateDirectory(state)).rejects.toThrow(
      "Local trading state is missing ownership or permission isolation",
    );
    expect(lstatSync(nested).mode & 0o777).toBe(0o755);
    expect(lstatSync(database).isFile()).toBe(true);

    chmodSync(nested, 0o700);
    chmodSync(database, 0o644);
    await expect(validateTradingStateDirectory(state)).rejects.toThrow();
    expect(lstatSync(database).mode & 0o777).toBe(0o644);
    expect(lstatSync(database).isFile()).toBe(true);

    chmodSync(database, 0o600);
    symlinkSync(database, join(state, "state-link"));
    await expect(validateTradingStateDirectory(state)).rejects.toThrow();
    expect(lstatSync(join(state, "state-link")).isSymbolicLink()).toBe(true);

    rmSync(join(state, "state-link"));
    const hardlink = join(state, "state-hardlink");
    linkSync(database, hardlink);
    await expect(validateTradingStateDirectory(state)).rejects.toThrow();
    expect(lstatSync(database).nlink).toBe(2);
  });

  it("accepts a 0755 state parent but rejects a writable one without changing it", async () => {
    const parent = privateFixture("harbor-trading-state");
    const state = join(parent, "state");
    mkdirSync(state, { mode: 0o700 });
    chmodSync(parent, 0o755);

    await expect(validateTradingStateDirectory(state)).resolves.toBeUndefined();
    expect(lstatSync(parent).mode & 0o777).toBe(0o755);

    chmodSync(parent, 0o775);
    await expect(validateTradingStateDirectory(state)).rejects.toThrow(
      "Local trading state is missing ownership or permission isolation",
    );
    expect(lstatSync(parent).mode & 0o777).toBe(0o775);
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
  });

  it("validates an isolated, cron-free, x402-disabled testnet config", async () => {
    const config = JSON.parse(
      await readFile(join(repoRoot, LOCAL_TRADING_CONFIG), "utf8"),
    ) as Record<string, any>;

    expect(() => validateTradingConfiguration(config)).not.toThrow();
    await expect(validateTradingConfigurationFile(repoRoot)).resolves.toBeUndefined();
    expect(config.name).toBe("harbor-local-trading-only");
    expect(config).not.toHaveProperty("worker_loaders");
    expect(config).not.toHaveProperty("triggers");
    expect(config).not.toHaveProperty("observability");
    expect(config).not.toHaveProperty("upload_source_maps");
    expect(config.vars).not.toHaveProperty("HARBOR_LOCAL_X402_SIGNING_PROFILE");
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "harbor-local-trading-only",
        database_id: "11111111-1111-1111-1111-111111111111",
        migrations_dir: "migrations",
        remote: false,
      },
    ]);
    expect(config.vars).toMatchObject({
      EXEC_NETWORK: "testnet",
      MAINNET_EXECUTION: "false",
      EXECUTOR: "quickjs",
      HARBOR_LOCAL_READ_ONLY: "false",
      HARBOR_LOCAL_AUTH_REQUIRED: "true",
      HARBOR_LOCAL_CRON_DISABLED: "true",
      HARBOR_LOCAL_X402: "false",
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
      HARBOR_LOCAL_TRADING_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_TRADING_SIGNING_PROFILE: LOCAL_TRADING_SIGNING_PROFILE,
    });

    for (const patch of [
      { triggers: { crons: ["* * * * *"] } },
      { worker_loaders: [{ binding: "LOADER" }] },
      { vars: { ...config.vars, MAINNET_EXECUTION: "true" } },
      { vars: { ...config.vars, EXEC_NETWORK: "devnet" } },
      { vars: { ...config.vars, HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true" } },
      { d1_databases: [{ ...config.d1_databases[0], remote: true }] },
    ]) {
      expect(() => validateTradingConfiguration({ ...config, ...patch })).toThrow();
    }
  });
});
