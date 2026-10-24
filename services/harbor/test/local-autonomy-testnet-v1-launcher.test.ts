import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_AUTONOMY_TESTNET_V1_CONFIG,
  LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID,
  LOCAL_AUTONOMY_TESTNET_V1_HOST,
  LOCAL_AUTONOMY_TESTNET_V1_ORIGIN,
  LOCAL_AUTONOMY_TESTNET_V1_PORT,
  LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT,
  LOCAL_AUTONOMY_TESTNET_V1_SECRET_FILE,
  LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT,
  autonomyChildEnvironment,
  autonomyCommands,
  ensureAutonomyStateDirectory,
  main,
  parseAutonomyArguments,
  parseAutonomySecretFile,
  validateAutonomyCommandPlan,
  validateAutonomyConfiguration,
  validateAutonomyConfigurationFile,
  validateCanonicalAutonomyMigrations,
} from "../scripts/dev-local-autonomy-testnet-v1.mjs";

const repoRoot = process.cwd();
const credentials = {
  HARBOR_API_KEYS: `autonomy-acceptance:${"A".repeat(32)}`,
  HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function directoryMetadata(mode = 0o40700) {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
  };
}

describe("local autonomy Testnet v1 launcher", () => {
  it("pins a separate loopback origin, D1 identity, state root, and credential path", () => {
    expect(LOCAL_AUTONOMY_TESTNET_V1_HOST).toBe("127.0.0.3");
    expect(LOCAL_AUTONOMY_TESTNET_V1_PORT).toBe(8793);
    expect(LOCAL_AUTONOMY_TESTNET_V1_ORIGIN).toBe("http://127.0.0.3:8793");
    expect(LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID).toBe(
      "44444444-4444-4444-4444-444444444444",
    );
    expect(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT).toBe(
      join(LOCAL_AUTONOMY_TESTNET_V1_RUNTIME_PARENT, "harbor-autonomy-testnet-v1"),
    );
    expect(LOCAL_AUTONOMY_TESTNET_V1_SECRET_FILE).toBe(
      join(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "credentials.env.local"),
    );
    expect(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT).not.toContain(
      "harbor-local-trading-isolated-v1",
    );
  });

  it("uses canonical local migrations and keeps the runner disabled by default", async () => {
    await expect(validateAutonomyConfigurationFile(repoRoot)).resolves.toBeUndefined();
    await expect(validateCanonicalAutonomyMigrations(repoRoot)).resolves.toBeUndefined();

    const config = JSON.parse(
      await readFile(join(repoRoot, LOCAL_AUTONOMY_TESTNET_V1_CONFIG), "utf8"),
    );
    expect(config.d1_databases[0]).toMatchObject({
      database_id: LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID,
      migrations_dir: "migrations",
      remote: false,
    });
    expect(config.vars).toMatchObject({
      AUTONOMOUS_STRATEGY_RUNNER: "false",
      EXEC_NETWORK: "testnet",
      HARBOR_LOCAL_AUTH_REQUIRED: "true",
      HARBOR_LOCAL_CRON_DISABLED: "false",
      HARBOR_LOCAL_DEV: "false",
      MAINNET_EXECUTION: "false",
    });
  });

  it.each([
    ["wrong network", (config: any) => { config.vars.EXEC_NETWORK = "mainnet"; }],
    ["mainnet enabled", (config: any) => { config.vars.MAINNET_EXECUTION = "true"; }],
    ["auth bypass", (config: any) => { config.vars.HARBOR_LOCAL_DEV = "true"; }],
    ["runner default on", (config: any) => { config.vars.AUTONOMOUS_STRATEGY_RUNNER = "true"; }],
    ["remote D1", (config: any) => { config.d1_databases[0].remote = true; }],
    ["partial migrations", (config: any) => { config.d1_databases[0].migrations_dir = "migrations-profile-trading-isolated-v1"; }],
  ])("rejects %s configuration", async (_name, mutate) => {
    const config = JSON.parse(
      await readFile(join(repoRoot, LOCAL_AUTONOMY_TESTNET_V1_CONFIG), "utf8"),
    );
    mutate(config);
    expect(() => validateAutonomyConfiguration(config)).toThrow();
  });

  it("accepts only the explicit runner enablement flag and refuses remote/deploy controls", () => {
    expect(parseAutonomyArguments([])).toEqual({ runnerEnabled: false });
    expect(parseAutonomyArguments(["--enable-runner"])).toEqual({ runnerEnabled: true });
    for (const args of [
      ["--remote"],
      ["deploy"],
      ["--publish"],
      ["--enable-runner", "--force"],
      ["--config=other.jsonc"],
    ]) expect(() => parseAutonomyArguments(args)).toThrow();
  });

  it("builds a local-only plan and adds the runner override only when explicit", () => {
    const disabled = autonomyCommands(repoRoot);
    const enabled = autonomyCommands(repoRoot, { runnerEnabled: true });
    const migration = disabled[1];
    const worker = disabled[2];

    expect(valueAfter(migration.args, "--persist-to")).toBe(
      LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT,
    );
    expect(valueAfter(worker.args, "--persist-to")).toBe(
      LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT,
    );
    expect(valueAfter(worker.args, "--ip")).toBe("127.0.0.3");
    expect(valueAfter(worker.args, "--port")).toBe("8793");
    expect(worker.args).toContain("--test-scheduled");
    expect(worker.args).not.toContain("--var");
    expect(enabled[2].args.slice(-2)).toEqual([
      "--var",
      "AUTONOMOUS_STRATEGY_RUNNER:true",
    ]);
    expect(() =>
      validateAutonomyCommandPlan(disabled, repoRoot, {}, credentials),
    ).not.toThrow();
    expect(() =>
      validateAutonomyCommandPlan(
        enabled,
        repoRoot,
        { runnerEnabled: true },
        credentials,
      ),
    ).not.toThrow();
    expect(JSON.stringify(enabled)).not.toContain(credentials.HARBOR_API_KEYS);
    expect(JSON.stringify(enabled)).not.toContain(credentials.HARBOR_KEK);
  });

  it("rejects changed, remote, and existing-profile command plans", () => {
    const changed = autonomyCommands(repoRoot, { runnerEnabled: true });
    changed[2].args.push("--remote");
    expect(() =>
      validateAutonomyCommandPlan(
        changed,
        repoRoot,
        { runnerEnabled: true },
        credentials,
      ),
    ).toThrow();

    const reused = autonomyCommands(repoRoot);
    reused[1].args[reused[1].args.indexOf("--persist-to") + 1] =
      "/absolute/private/pilot/harbor-state/harbor-local-trading-isolated-v1/.wrangler/harbor-local-trading-isolated-v1";
    expect(() =>
      validateAutonomyCommandPlan(reused, repoRoot, {}, credentials),
    ).toThrow();
  });

  it("keeps inherited credentials, cloud settings, and proxies out of children", () => {
    const env = autonomyChildEnvironment({
      PATH: "/usr/bin",
      HARBOR_API_KEYS: "inherited",
      HARBOR_KEK: "inherited",
      AWS_SECRET_ACCESS_KEY: "inherited",
      HTTPS_PROXY: "http://proxy.invalid",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.WRANGLER_LOG_PATH).toBe(
      join(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, "wrangler.log"),
    );
    for (const key of [
      "HARBOR_API_KEYS",
      "HARBOR_KEK",
      "AWS_SECRET_ACCESS_KEY",
      "HTTPS_PROXY",
    ]) expect(env).not.toHaveProperty(key);
  });

  it("parses only one named bearer and one 32-byte KEK", () => {
    const text = [
      `HARBOR_API_KEYS=${credentials.HARBOR_API_KEYS}`,
      `HARBOR_KEK=${credentials.HARBOR_KEK}`,
      "",
    ].join("\n");
    expect(parseAutonomySecretFile(text)).toEqual(credentials);
    for (const invalid of [
      text.replace("autonomy-acceptance", "local-dev"),
      `${text}EXEC_NETWORK=testnet\n`,
      text.replace("A".repeat(32), "short"),
      text.replace(/HARBOR_KEK=.*/, "HARBOR_KEK=invalid"),
    ]) expect(() => parseAutonomySecretFile(invalid)).toThrow(
      "Local autonomy Testnet credential file is missing or unsafe",
    );
  });

  it("accepts only the exact marked state and rejects unmarked or reused state", async () => {
    const expectedMarker = `${JSON.stringify({
      profile: "harbor-local-autonomy-testnet-v1-only",
      version: 1,
      database_id: LOCAL_AUTONOMY_TESTNET_V1_DATABASE_ID,
    }, null, 2)}\n`;
    const statPath = vi.fn(async () => directoryMetadata());
    const realPath = vi.fn(async (path: string) => path);
    await expect(
      ensureAutonomyStateDirectory(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, {
        statPath,
        realPath,
        readMarker: async () => expectedMarker,
      }),
    ).resolves.toBeUndefined();

    await expect(
      ensureAutonomyStateDirectory(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, {
        statPath,
        realPath,
        readMarker: async () => "{}\n",
      }),
    ).rejects.toThrow("state is missing, reused, or unsafe");
    await expect(
      ensureAutonomyStateDirectory(
        "/absolute/private/pilot/harbor-state/harbor-local-trading-isolated-v1/.wrangler/harbor-local-trading-isolated-v1",
      ),
    ).rejects.toThrow("state is missing, reused, or unsafe");
  });

  it("refuses symlinked and permissive state roots", async () => {
    for (const metadata of [
      { ...directoryMetadata(), isSymbolicLink: () => true },
      directoryMetadata(0o40755),
    ]) {
      await expect(
        ensureAutonomyStateDirectory(LOCAL_AUTONOMY_TESTNET_V1_STATE_ROOT, {
          statPath: async () => metadata,
          realPath: async (path: string) => path,
          readMarker: async () => "",
        }),
      ).rejects.toThrow("state is missing, reused, or unsafe");
    }
  });

  it("passes runner selection into preparation and launches no unreviewed overrides", async () => {
    const prepareLaunch = vi.fn(async () => []);
    const setUmask = vi.fn();
    await main(["--enable-runner"], {
      prepareLaunch,
      run: vi.fn(),
      setUmask,
      environment: () => ({ PATH: "/bin" }),
    });
    expect(prepareLaunch).toHaveBeenCalledWith(repoRoot, { runnerEnabled: true });
    expect(setUmask).toHaveBeenCalledWith(0o077);
  });
});
