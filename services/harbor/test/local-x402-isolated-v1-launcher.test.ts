import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_X402_ISOLATED_V1_CONFIG,
  LOCAL_X402_ISOLATED_V1_HEALTH_URL,
  LOCAL_X402_ISOLATED_V1_INSPECTOR_PORT,
  LOCAL_X402_ISOLATED_V1_SECRET_FILE,
  LOCAL_X402_ISOLATED_V1_STATE_DIRECTORY,
  isolatedX402ChildEnvironment,
  isolatedX402Commands,
  isolatedX402MigrationCommand,
  main,
  parseIsolatedX402SecretFile,
  prepareIsolatedX402Launch,
  validateIsolatedX402CommandPlan,
  validateIsolatedX402Configuration,
  validateIsolatedX402MigrationCommand,
  validateIsolatedX402SecretFile,
} from "../scripts/dev-local-x402-isolated-v1.mjs";
import { runCommand } from "../scripts/dev-local.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "I".repeat(32);
const PAY_TO = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const STATE_ROOT = join(tmpdir(), "harbor-explicit-x402-state");

function secretFile(stateRoot = STATE_ROOT): string {
  return [
    `HARBOR_API_KEYS=isolated-x402:${TOKEN}`,
    `HARBOR_KEK=${"A".repeat(43)}=`,
    "EXEC_NETWORK=testnet",
    "MAINNET_EXECUTION=false",
    "HARBOR_LOCAL_READ_ONLY=true",
    "HARBOR_LOCAL_AUTH_REQUIRED=true",
    "HARBOR_LOCAL_CRON_DISABLED=true",
    "HARBOR_LOCAL_X402=true",
    `HARBOR_LOCAL_X402_MERCHANT_PAY_TO=${PAY_TO}`,
    "HARBOR_LOCAL_X402_RUNTIME_ENABLED=true",
    "HARBOR_LOCAL_X402_SIGNING_PROFILE=reviewed-testnet-isolated-v1",
    "HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED=true",
    "HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE=reviewed-testnet-isolated-v1",
    `HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT=${stateRoot}`,
    "",
  ].join("\n");
}

function lease(events?: string[]) {
  return vi.fn(async () => {
    events?.push("lease");
    return { path: join(STATE_ROOT, "lock"), release: vi.fn(async () => events?.push("release")) };
  });
}

describe("local x402 isolated v1 resume launcher", () => {
  it("pins the config, D1, host, inspector, route, and signing profile", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, LOCAL_X402_ISOLATED_V1_CONFIG), "utf8"));
    expect(() => validateIsolatedX402Configuration(config)).not.toThrow();
    expect(config.name).toBe("harbor-local-x402-isolated-v1-only");
    expect(config.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_name: "harbor-local-x402-isolated-v1-only",
      database_id: "33333333-3333-3333-3333-333333333333",
      migrations_dir: "migrations-profile-x402-isolated-v1",
      remote: false,
    });
    expect(config.vars.HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE)
      .toBe("reviewed-testnet-isolated-v1");
    expect(LOCAL_X402_ISOLATED_V1_HEALTH_URL).toBe("http://127.0.0.2:8792/health");
    expect(LOCAL_X402_ISOLATED_V1_INSPECTOR_PORT).toBe(9232);
  });

  it("uses the explicit external root across checkout changes and has no resume migration", () => {
    for (const checkout of [
      "/private/fake-checkout-a",
      "/private/harbor-migration-profile-safety/fake-checkout-b",
    ]) {
      const secrets = parseIsolatedX402SecretFile(secretFile());
      const commands = isolatedX402Commands(checkout, STATE_ROOT);
      expect(() => validateIsolatedX402CommandPlan(commands, checkout, STATE_ROOT, secrets))
        .not.toThrow();
      expect(commands.map(({ label }) => label)).toEqual(["catalog", "isolated x402 Worker"]);
      const server = commands[1]!;
      expect(server.readinessUrl).toBe(LOCAL_X402_ISOLATED_V1_HEALTH_URL);
      expect(server.args[server.args.indexOf("--persist-to") + 1]).toBe(STATE_ROOT);
      expect(server.args[server.args.indexOf("--config") + 1])
        .toBe(join(checkout, LOCAL_X402_ISOLATED_V1_CONFIG));
      expect(server.args).toContain(LOCAL_X402_ISOLATED_V1_SECRET_FILE);
      expect(JSON.stringify(commands)).not.toMatch(/migrations apply/);
    }
    expect(() => isolatedX402Commands(REPO_ROOT, undefined)).toThrow(/state root is required/);
    expect(LOCAL_X402_ISOLATED_V1_STATE_DIRECTORY)
      .toBe(".wrangler/harbor-local-x402-isolated-v1");

    const crossProfile = isolatedX402Commands(REPO_ROOT, STATE_ROOT);
    crossProfile[1] = {
      ...crossProfile[1]!,
      readinessUrl: "http://127.0.0.2:8791/health",
    };
    expect(() => validateIsolatedX402CommandPlan(
      crossProfile,
      REPO_ROOT,
      STATE_ROOT,
      parseIsolatedX402SecretFile(secretFile()),
    )).toThrow(/command plan is not exact/);
  });

  it.each([
    "--migrations-dir",
    "migrations-evil",
    "/private/unsafe/migrations/0008_unreviewed.sql",
  ])("rejects adversarial migration-like worker argument %s", (argument) => {
    const commands = isolatedX402Commands(REPO_ROOT, STATE_ROOT);
    commands[1] = {
      ...commands[1]!,
      args: [...commands[1]!.args, argument],
    };
    expect(() => validateIsolatedX402CommandPlan(
      commands,
      REPO_ROOT,
      STATE_ROOT,
      parseIsolatedX402SecretFile(secretFile()),
    )).toThrow(/command plan is not exact|command plan is unsafe/);
  });

  it("exposes an exact migration command only for explicit provisioning", () => {
    const migration = isolatedX402MigrationCommand(REPO_ROOT, STATE_ROOT);
    expect(() => validateIsolatedX402MigrationCommand(migration, REPO_ROOT, STATE_ROOT))
      .not.toThrow();
    expect(migration.args.slice(1, 6)).toEqual(["d1", "migrations", "apply", "DB", "--local"]);
    expect(migration.args[migration.args.indexOf("--persist-to") + 1]).toBe(STATE_ROOT);
    expect(migration).not.toHaveProperty("readinessUrl");
    expect(() => validateIsolatedX402MigrationCommand({
      ...migration,
      readinessUrl: "http://example.invalid",
    }, REPO_ROOT, STATE_ROOT)).toThrow(/migration command is unsafe/);
    expect(() => validateIsolatedX402MigrationCommand({
      ...migration,
      args: [...migration.args, "--remote"],
    }, REPO_ROOT, STATE_ROOT)).toThrow(/migration command is unsafe/);
  });

  it("requires the fixed secret file to supply the state root", () => {
    const parsed = parseIsolatedX402SecretFile(secretFile());
    expect(parsed.HARBOR_API_KEYS).toBe(`isolated-x402:${TOKEN}`);
    expect(parsed.stateRoot).toBe(STATE_ROOT);
    expect(parsed.HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT).toBe(STATE_ROOT);
    for (const contents of [
      secretFile().replace(`HARBOR_LOCAL_X402_ISOLATED_V1_STATE_ROOT=${STATE_ROOT}\n`, ""),
      secretFile().replace(STATE_ROOT, ""),
      secretFile().replace("reviewed-testnet-isolated-v1", "reviewed-testnet-local-v1"),
      secretFile().replace(`isolated-x402:${TOKEN}`, `isolated-x402:${TOKEN},other:${TOKEN}`),
    ]) expect(() => parseIsolatedX402SecretFile(contents)).toThrow(/missing or unsafe/);
  });

  it("prepares in config-profile-secret-root-existing order and returns the bound secrets", async () => {
    const order: string[] = [];
    const secrets = parseIsolatedX402SecretFile(secretFile());
    const launch = await prepareIsolatedX402Launch(REPO_ROOT, {
      validateConfiguration: vi.fn(async () => { order.push("config"); }),
      validateMigrationProfile: vi.fn(async () => { order.push("profile"); }),
      validateSecret: vi.fn(async () => { order.push("secret"); return secrets; }),
      validateStateRoot: vi.fn(async () => { order.push("root"); }),
      validateState: vi.fn(async () => { order.push("existing"); }),
    });
    expect(order).toEqual(["config", "profile", "secret", "root", "existing"]);
    expect(launch).toEqual({
      commands: isolatedX402Commands(REPO_ROOT, STATE_ROOT),
      secrets,
      stateRoot: STATE_ROOT,
    });
  });

  it("fails closed on missing state without creating or running anything", async () => {
    await expect(prepareIsolatedX402Launch(REPO_ROOT, {
      validateConfiguration: vi.fn(async () => undefined),
      validateMigrationProfile: vi.fn(async () => undefined),
      validateSecret: vi.fn(async () => parseIsolatedX402SecretFile(secretFile())),
      validateStateRoot: vi.fn(async () => STATE_ROOT),
      validateState: vi.fn(async () => { throw new Error("preserved state is missing or unsafe"); }),
    })).rejects.toThrow("preserved state is missing or unsafe");
    const run = vi.fn();
    await expect(main([], {
      prepareLaunch: vi.fn(async () => { throw new Error("missing state"); }),
      run,
      setUmask: vi.fn(),
    })).rejects.toThrow("missing state");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on migration profile drift before secret or state access", async () => {
    const validateSecret = vi.fn(async () => parseIsolatedX402SecretFile(secretFile()));
    const validateStateRoot = vi.fn(async () => STATE_ROOT);
    const validateState = vi.fn(async () => undefined);
    await expect(prepareIsolatedX402Launch(REPO_ROOT, {
      validateConfiguration: vi.fn(async () => undefined),
      validateMigrationProfile: vi.fn(async () => {
        throw new Error("stale migration profile");
      }),
      validateSecret,
      validateStateRoot,
      validateState,
    })).rejects.toThrow("stale migration profile");
    expect(validateSecret).not.toHaveBeenCalled();
    expect(validateStateRoot).not.toHaveBeenCalled();
    expect(validateState).not.toHaveBeenCalled();
  });

  it("revalidates state after catalog and credential plus state before the worker", async () => {
    const commands = isolatedX402Commands(REPO_ROOT, STATE_ROOT);
    const secrets = parseIsolatedX402SecretFile(secretFile());
    const events: string[] = [];
    const run = vi.fn(async (command) => { events.push(`run:${command.label}`); });
    await main([], {
      prepareLaunch: vi.fn(async () => ({ commands, secrets, stateRoot: STATE_ROOT })),
      acquireLease: lease(events),
      environment: vi.fn(() => ({})),
      revalidateSecret: vi.fn(async () => { events.push("secret"); return secrets; }),
      revalidateState: vi.fn(async () => { events.push("state"); }),
      run,
      setUmask: vi.fn(),
    });
    expect(events).toEqual([
      "run:catalog", "lease", "state", "secret", "state", "run:isolated x402 Worker",
      "release",
    ]);
  });

  it("passes the exact isolated health URL from main into process-health validation", async () => {
    const commands = isolatedX402Commands(REPO_ROOT, STATE_ROOT);
    const secrets = parseIsolatedX402SecretFile(secretFile());
    const signalSource = new EventEmitter();
    let workerChild: EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    } | undefined;
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 58792,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      if (args.includes(join(REPO_ROOT, "scripts", "build-catalog.mjs"))) {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      } else {
        workerChild = child;
      }
      return child;
    });
    const fetchProcess = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.2:8792/health");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      setTimeout(() => {
        if (workerChild === undefined) return;
        workerChild.exitCode = 0;
        workerChild.emit("exit", 0, null);
      }, 0);
      return Response.json({
        ok: true,
        service: "harbor",
        health: "process",
        handoff_readiness: "not_evaluated",
      });
    });
    const run = vi.fn((command, env) => runCommand(command, env, {
      platform: "linux",
      signalSource,
      fetchProcess,
      readinessTimeoutMs: 50,
      readinessRetryMs: 1,
      spawnProcess,
      treeIsRunning: () => false,
    }));

    await expect(main([], {
      prepareLaunch: vi.fn(async () => ({ commands, secrets, stateRoot: STATE_ROOT })),
      acquireLease: lease(),
      environment: vi.fn(() => ({ PATH: "/bin" })),
      revalidateSecret: vi.fn(async () => secrets),
      revalidateState: vi.fn(async () => undefined),
      run,
      setUmask: vi.fn(),
    })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(fetchProcess).toHaveBeenCalledOnce();
  });

  it.each([
    "http://127.0.0.3:8792/health",
    "http://localhost:8792/health",
    "http://127.0.0.02:8792/health",
    "http://2130706434:8792/health",
    "http://0x7f000002:8792/health",
    "http://127.0.0.2:8793/health",
    "https://127.0.0.2:8792/health",
  ])("rejects non-contract isolated readiness target %s before fetch", async (readinessUrl) => {
    const commands = isolatedX402Commands(REPO_ROOT, STATE_ROOT);
    commands[1] = { ...commands[1]!, readinessUrl };
    const secrets = parseIsolatedX402SecretFile(secretFile());
    const signalSource = new EventEmitter();
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 58793,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      if (args.includes(join(REPO_ROOT, "scripts", "build-catalog.mjs"))) {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      }
      return child;
    });
    const fetchProcess = vi.fn();
    const run = vi.fn((command, env) => runCommand(command, env, {
      signalSource,
      fetchProcess,
      spawnProcess,
      treeIsRunning: () => false,
    }));

    await expect(main([], {
      prepareLaunch: vi.fn(async () => ({ commands, secrets, stateRoot: STATE_ROOT })),
      acquireLease: lease(),
      environment: vi.fn(() => ({ PATH: "/bin" })),
      revalidateSecret: vi.fn(async () => secrets),
      revalidateState: vi.fn(async () => undefined),
      run,
      setUmask: vi.fn(),
    })).rejects.toThrow(
      "Local Harbor process-health target is not the fixed loopback interface",
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(fetchProcess).not.toHaveBeenCalled();
  });

  it("blocks Worker when the fixed credential file changes after catalog", async () => {
    const commands = isolatedX402Commands(REPO_ROOT, STATE_ROOT);
    const secrets = parseIsolatedX402SecretFile(secretFile());
    const replacement = parseIsolatedX402SecretFile(
      secretFile().replace(TOKEN, "R".repeat(32)),
    );
    const run = vi.fn(async () => undefined);
    await expect(main([], {
      prepareLaunch: vi.fn(async () => ({ commands, secrets, stateRoot: STATE_ROOT })),
      acquireLease: lease(),
      environment: vi.fn(() => ({})),
      revalidateSecret: vi.fn(async () => replacement),
      revalidateState: vi.fn(async () => undefined),
      run,
      setUmask: vi.fn(),
    })).rejects.toThrow(/credential file changed/);
    expect(run).toHaveBeenCalledExactlyOnceWith(commands[0], {});
  });

  it("keeps the child environment sparse and logs inside the configured root", () => {
    const child = isolatedX402ChildEnvironment({
      PATH: "/safe/bin",
      HARBOR_API_KEYS: "ambient",
      HARBOR_KEK: "ambient",
      AWS_SECRET_ACCESS_KEY: "ambient",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
    }, STATE_ROOT);
    expect(child.PATH).toBe("/safe/bin");
    expect(child.WRANGLER_LOG_PATH).toBe(join(STATE_ROOT, "wrangler.log"));
    expect(child).not.toHaveProperty("HARBOR_API_KEYS");
    expect(child).not.toHaveProperty("HARBOR_KEK");
    expect(child).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(child).not.toHaveProperty("NODE_OPTIONS");
  });

  it("rejects command-line overrides before preparation", async () => {
    const prepareLaunch = vi.fn();
    await expect(main(["--port=9000"], {
      prepareLaunch,
      run: vi.fn(),
      setUmask: vi.fn(),
    })).rejects.toThrow(/does not accept command-line overrides/);
    expect(prepareLaunch).not.toHaveBeenCalled();
  });

  it("retains inode, permission, and ACL checks for the fixed secret file", async () => {
    const contents = secretFile();
    const metadata = {
      dev: 1, ino: 2, mode: 0o100600, nlink: 1,
      size: Buffer.byteLength(contents),
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const handle = {
      stat: vi.fn(async () => metadata),
      readFile: vi.fn(async () => contents),
      close: vi.fn(async () => undefined),
    };
    const assertAcl = vi.fn();
    await expect(validateIsolatedX402SecretFile(LOCAL_X402_ISOLATED_V1_SECRET_FILE, {
      openFile: vi.fn(async () => handle),
      lstatFile: vi.fn(async () => metadata),
      validateParent: vi.fn(async () => undefined),
      assertAcl,
    })).resolves.toMatchObject({ stateRoot: STATE_ROOT });
    expect(assertAcl).toHaveBeenCalledWith(LOCAL_X402_ISOLATED_V1_SECRET_FILE, "private");
  });
});
