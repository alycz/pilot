import { EventEmitter } from "node:events";
import {
  chmodSync,
  constants as FS_CONSTANTS,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_HOST,
  LOCAL_HEALTH_URL,
  LOCAL_FILE_UMASK,
  LOCAL_PORT,
  LOCAL_PROFILES,
  LOCAL_STATE_DIRECTORY,
  LOCAL_X402_SECRET_FILE,
  LOCAL_X402_SECRET_MAX_BYTES,
  LOCAL_X402_STATE_DIRECTORY,
  LauncherInterruptedError,
  enforceLocalFileUmask,
  localCommands,
  main,
  prepareLocalLaunch,
  runCommand,
  sanitizedChildEnvironment,
  terminateSpawnedProcessTree,
  validateLocalCommandPlan,
  validateLocalConfiguration,
  validateLocalConfigurationFile,
  validateLocalArguments,
  validateX402SecretParentChain,
  validateX402SecretFile,
} from "../scripts/dev-local.mjs";
import {
  ensureLocalX402StateDirectory,
  LocalX402StateError,
} from "../scripts/local-x402-state.mjs";

const repoRoot = process.cwd();
const temporaryDirectories: string[] = [];

function privateWorkspaceDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(realpathSync(repoRoot), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const testSecretContents = [
  "HARBOR_API_KEYS=named-principal:0123456789abcdef",
  `HARBOR_KEK=${Buffer.alloc(32, 7).toString("base64")}`,
  "EXEC_NETWORK=testnet",
  "MAINNET_EXECUTION=false",
  "HARBOR_LOCAL_READ_ONLY=true",
  "HARBOR_LOCAL_X402=true",
  "HARBOR_LOCAL_X402_MERCHANT_PAY_TO=r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  "HARBOR_LOCAL_X402_SIGNING_PROFILE=reviewed-testnet-local-v1",
  "HARBOR_LOCAL_X402_RUNTIME_ENABLED=true",
  "",
].join("\n");

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function secretFileHandle(metadata = secretFileMetadata(), contents = testSecretContents) {
  return {
    stat: vi.fn(async () => metadata),
    readFile: vi.fn(async () => contents),
    close: vi.fn(async () => undefined),
  };
}

describe("isolated local Harbor launcher", () => {
  it("sets a restrictive inherited file umask", () => {
    const setUmask = vi.fn();

    enforceLocalFileUmask(setUmask);

    expect(LOCAL_FILE_UMASK).toBe(0o077);
    expect(setUmask).toHaveBeenCalledExactlyOnceWith(0o077);
  });

  it.each([LOCAL_PROFILES.READ_ONLY, LOCAL_PROFILES.X402_SIGNING])(
    "sets umask before preparing or spawning the %s profile",
    async (profile) => {
      const events: string[] = [];
      const command = { label: "test child", command: "/node", args: ["child.js"] };

      await main([], {
        profile,
        setUmask: (mask: number) => {
          expect(mask).toBe(0o077);
          events.push("umask");
        },
        prepareLaunch: async (preparedProfile: string) => {
          expect(preparedProfile).toBe(profile);
          events.push("prepare");
          return [command];
        },
        run: async (launchedCommand: typeof command) => {
          expect(launchedCommand).toBe(command);
          events.push("spawn");
        },
      });

      expect(events).toEqual(["umask", "prepare", "spawn"]);
    },
  );

  it("uses one local-only config and persistence directory for migration and serving", () => {
    const [, migration, server] = localCommands(repoRoot);
    const config = join(repoRoot, "wrangler.local.jsonc");
    const emptyEnv = join(repoRoot, "config", "local-empty.env");
    const persistence = join(repoRoot, LOCAL_STATE_DIRECTORY);

    expect(migration.args).toContain("--local");
    expect(server.args).toContain("--local");
    expect(valueAfter(migration.args, "--config")).toBe(config);
    expect(valueAfter(server.args, "--config")).toBe(config);
    expect(valueAfter(migration.args, "--env-file")).toBe(emptyEnv);
    expect(valueAfter(server.args, "--env-file")).toBe(emptyEnv);
    expect(migration.args.join(" ")).not.toContain(".dev.vars");
    expect(server.args.join(" ")).not.toContain(".dev.vars");
    expect(valueAfter(migration.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(server.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(server.args, "--ip")).toBe(LOCAL_HOST);
    expect(valueAfter(server.args, "--inspector-ip")).toBe(LOCAL_HOST);
    expect(valueAfter(server.args, "--port")).toBe(String(LOCAL_PORT));
    expect(server.args).not.toContain("--remote");
    expect(server.args).not.toContain("--tunnel");
    expect(server.args).toContain("--show-interactive-dev-session=false");
    expect(server.readinessUrl).toBe(LOCAL_HEALTH_URL);
    expect(() =>
      validateLocalCommandPlan(localCommands(repoRoot), repoRoot),
    ).not.toThrow();
  });

  it("uses the exact external secret file only for the isolated x402 server", () => {
    const commands = localCommands(repoRoot, {
      profile: LOCAL_PROFILES.X402_SIGNING,
    });
    const [, migration, server] = commands;
    const x402Config = join(repoRoot, "wrangler.local-x402.jsonc");
    const emptyEnv = join(repoRoot, "config", "local-empty.env");
    const persistence = join(repoRoot, LOCAL_X402_STATE_DIRECTORY);
    const secretValues = {
      HARBOR_API_KEYS: "named-principal:0123456789abcdef",
      HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
    };

    expect(valueAfter(migration.args, "--config")).toBe(x402Config);
    expect(valueAfter(server.args, "--config")).toBe(x402Config);
    expect(valueAfter(migration.args, "--env-file")).toBe(emptyEnv);
    expect(valueAfter(server.args, "--env-file")).toBe(LOCAL_X402_SECRET_FILE);
    expect(valueAfter(migration.args, "--persist-to")).toBe(persistence);
    expect(valueAfter(server.args, "--persist-to")).toBe(persistence);
    expect(persistence).not.toBe(join(repoRoot, LOCAL_STATE_DIRECTORY));
    expect(server.readinessUrl).toBe("http://127.0.0.1:8791/health");
    expect(commands.flatMap((command) => command.args)).not.toContain(
      secretValues.HARBOR_API_KEYS,
    );
    expect(commands.flatMap((command) => command.args)).not.toContain(
      secretValues.HARBOR_KEK,
    );
    const allArguments = commands.flatMap((command) => command.args).join(" ");
    expect(allArguments).not.toContain("wrangler.jsonc");
    expect(allArguments).not.toContain(".dev.vars");
    expect(allArguments).not.toMatch(/(?:faucet|generate|provision|sign)/i);
    expect(() =>
      validateLocalCommandPlan(
        commands,
        repoRoot,
        LOCAL_PROFILES.X402_SIGNING,
        secretValues,
      ),
    ).not.toThrow();

    const altered = structuredClone(commands);
    altered[2].args.push("--var", "HARBOR_KEK=not-allowed");
    expect(() =>
      validateLocalCommandPlan(
        altered,
        repoRoot,
        LOCAL_PROFILES.X402_SIGNING,
        secretValues,
      ),
    ).toThrow("Local Harbor command plan is invalid");
  });

  it("creates and validates the private x402 state tree before launch", () => {
    const root = privateWorkspaceDirectory(".harbor-x402-state-root-");
    const state = join(root, ".wrangler", "harbor-local-x402");

    expect(ensureLocalX402StateDirectory(state)).toBe(state);
    expect(lstatSync(join(root, ".wrangler")).mode & 0o777).toBe(0o700);
    expect(lstatSync(state).mode & 0o777).toBe(0o700);

    const database = join(state, "state.sqlite");
    writeFileSync(database, "fixture", { mode: 0o600 });
    expect(ensureLocalX402StateDirectory(state)).toBe(state);

    const alias = join(state, "state-alias.sqlite");
    linkSync(database, alias);
    expect(() => ensureLocalX402StateDirectory(state)).toThrow(LocalX402StateError);
  });

  it("rejects a symlinked x402 state ancestor before any child can spawn", async () => {
    const root = privateWorkspaceDirectory(".harbor-x402-state-launch-");
    const actualWrangler = join(root, "actual-wrangler");
    mkdirSync(actualWrangler, { mode: 0o700 });
    mkdirSync(join(actualWrangler, "harbor-local-x402"), { mode: 0o700 });
    symlinkSync(actualWrangler, join(root, ".wrangler"));
    const run = vi.fn();

    await expect(main([], {
      profile: LOCAL_PROFILES.X402_SIGNING,
      prepareLaunch: (profile: string) => prepareLocalLaunch(profile, root, {
        validateConfiguration: async () => undefined,
        validateSecret: async () => ({
          HARBOR_API_KEYS: "named-principal:0123456789abcdef",
          HARBOR_KEK: Buffer.alloc(32, 7).toString("base64"),
        }),
      }),
      run,
      setUmask: () => undefined,
    })).rejects.toThrow(LocalX402StateError);
    expect(run).not.toHaveBeenCalled();
  });

  it("never redirects x402 persistence into the legacy local state tree", async () => {
    const root = privateWorkspaceDirectory(".harbor-x402-no-redirect-");
    const wrangler = join(root, ".wrangler");
    const legacyState = join(wrangler, "harbor-local");
    const x402State = join(wrangler, "harbor-local-x402");
    mkdirSync(wrangler, { mode: 0o700 });
    mkdirSync(legacyState, { mode: 0o700 });
    const legacyMarker = join(legacyState, "legacy.sqlite");
    writeFileSync(legacyMarker, "legacy", { mode: 0o600 });
    symlinkSync(legacyState, x402State);

    expect(() => ensureLocalX402StateDirectory(x402State)).toThrow(LocalX402StateError);
    await expect(readFile(legacyMarker, "utf8")).resolves.toBe("legacy");
  });

  it("validates the exact secret file without exposing its values", async () => {
    const handle = secretFileHandle();
    const openFile = vi.fn(async () => handle);
    const validateParent = vi.fn(async () => undefined);

    await expect(
      validateX402SecretFile(LOCAL_X402_SECRET_FILE, { openFile, validateParent }),
    ).resolves.toMatchObject({
      EXEC_NETWORK: "testnet",
      HARBOR_LOCAL_READ_ONLY: "true",
      HARBOR_LOCAL_X402_MERCHANT_PAY_TO: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
      MAINNET_EXECUTION: "false",
    });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(validateParent).toHaveBeenCalledExactlyOnceWith(
      join(LOCAL_X402_SECRET_FILE, ".."),
    );
    expect(openFile.mock.calls[0]?.[0]).toBe(LOCAL_X402_SECRET_FILE);
    expect(typeof openFile.mock.calls[0]?.[1]).toBe("number");
    expect((openFile.mock.calls[0]?.[1] as number) & FS_CONSTANTS.O_NOFOLLOW).toBe(
      FS_CONSTANTS.O_NOFOLLOW,
    );
    expect(handle.readFile).toHaveBeenCalledExactlyOnceWith("utf8");
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["symlink", secretFileMetadata({ isSymbolicLink: () => true }), testSecretContents],
    ["non-file", secretFileMetadata({ isFile: () => false }), testSecretContents],
    ["group-readable", secretFileMetadata({ mode: 0o100640 }), testSecretContents],
    ["world-readable", secretFileMetadata({ mode: 0o100604 }), testSecretContents],
    ["owner-executable", secretFileMetadata({ mode: 0o100700 }), testSecretContents],
    ["hard link", secretFileMetadata({ nlink: 2 }), testSecretContents],
    [
      "oversized metadata",
      secretFileMetadata({ size: LOCAL_X402_SECRET_MAX_BYTES + 1 }),
      testSecretContents,
    ],
    [
      "foreign-owner",
      secretFileMetadata({
        uid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1,
      }),
      testSecretContents,
    ],
    ["cloud variable", secretFileMetadata(), `${testSecretContents}AWS_PROFILE=prod\n`],
    [
      "invalid merchant receiver",
      secretFileMetadata(),
      testSecretContents.replace(
        "HARBOR_LOCAL_X402_MERCHANT_PAY_TO=r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        "HARBOR_LOCAL_X402_MERCHANT_PAY_TO=rInvalid",
      ),
    ],
    [
      "unsafe runtime override",
      secretFileMetadata(),
      testSecretContents.replace("MAINNET_EXECUTION=false", "MAINNET_EXECUTION=true"),
    ],
  ])("rejects an unsafe x402 secret file: %s", async (_name, metadata, contents) => {
    const handle = secretFileHandle(metadata, contents);
    await expect(
      validateX402SecretFile(LOCAL_X402_SECRET_FILE, {
        openFile: async () => handle,
        validateParent: async () => undefined,
      }),
    ).rejects.toThrow("Local x402 secret file is missing or unsafe");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a secret that grows beyond the bound during the read", async () => {
    const handle = secretFileHandle();
    handle.stat
      .mockResolvedValueOnce(secretFileMetadata())
      .mockResolvedValueOnce(secretFileMetadata({ size: LOCAL_X402_SECRET_MAX_BYTES + 1 }));

    await expect(validateX402SecretFile(LOCAL_X402_SECRET_FILE, {
      openFile: async () => handle,
      validateParent: async () => undefined,
    })).rejects.toThrow("Local x402 secret file is missing or unsafe");
    expect(handle.readFile).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized secret contents even when file metadata is stale", async () => {
    const handle = secretFileHandle(
      secretFileMetadata(),
      "x".repeat(LOCAL_X402_SECRET_MAX_BYTES + 1),
    );
    await expect(validateX402SecretFile(LOCAL_X402_SECRET_FILE, {
      openFile: async () => handle,
      validateParent: async () => undefined,
    })).rejects.toThrow("Local x402 secret file is missing or unsafe");
  });

  it("validates the canonical owner-controlled secret parent chain", async () => {
    const ancestor = privateWorkspaceDirectory(".harbor-x402-secret-");
    const secrets = join(ancestor, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    chmodSync(ancestor, 0o755);

    await expect(validateX402SecretParentChain(secrets)).resolves.toBeUndefined();

    chmodSync(ancestor, 0o775);
    await expect(validateX402SecretParentChain(secrets)).rejects.toThrow(
      "Local x402 secret file is missing or unsafe",
    );
    expect(lstatSync(ancestor).mode & 0o777).toBe(0o775);
  });

  it("rejects a non-private or symlinked immediate secret parent", async () => {
    const ancestor = privateWorkspaceDirectory(".harbor-x402-secret-");
    const realSecrets = join(ancestor, "real-secrets");
    const linkedSecrets = join(ancestor, "linked-secrets");
    mkdirSync(realSecrets, { mode: 0o700 });

    chmodSync(realSecrets, 0o755);
    await expect(validateX402SecretParentChain(realSecrets)).rejects.toThrow(
      "Local x402 secret file is missing or unsafe",
    );

    chmodSync(realSecrets, 0o700);
    symlinkSync(realSecrets, linkedSecrets);
    await expect(validateX402SecretParentChain(linkedSecrets)).rejects.toThrow(
      "Local x402 secret file is missing or unsafe",
    );
  });

  it("refuses any alternate secret path", async () => {
    const openFile = vi.fn();
    await expect(
      validateX402SecretFile("/tmp/not-the-reviewed-secret", { openFile }),
    ).rejects.toThrow("Local x402 secret file is missing or unsafe");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("only forwards the explicit runtime allowlist to every child", () => {
    const sanitized = sanitizedChildEnvironment({
      PATH: "/bin",
      NODE_ENV: "production",
      HOME: "/private/home",
      DATABASE_URL: "postgres://secret",
      SENTRY_DSN: "https://secret@sentry.example/1",
      CI_JOB_JWT: "job-secret",
      HTTPS_PROXY: "https://proxy.example",
      HTTP_PROXY: "http://proxy.example",
      ALL_PROXY: "socks5://proxy.example",
      NO_PROXY: "127.0.0.1",
      CLOUDFLARE_API_TOKEN: "cloud-token",
      CF_API_KEY: "cloud-key",
      HARBOR_API_KEYS: "principal:key",
      HARBOR_KEK: "kek",
      MM_WALLET_SEED: "seed",
      OPENROUTER_API_KEY: "model-key",
      SSH_AUTH_SOCK: "/private/socket",
      NPM_TOKEN: "registry-token",
      UNKNOWN_FUTURE_SECRET: "future-secret",
      UNRELATED_SETTING: "not-needed",
    });

    expect(sanitized.PATH).toBe("/bin");
    expect(sanitized.NODE_ENV).toBe("development");
    expect(sanitized).not.toHaveProperty("HOME");
    expect(sanitized).not.toHaveProperty("DATABASE_URL");
    expect(sanitized).not.toHaveProperty("SENTRY_DSN");
    expect(sanitized).not.toHaveProperty("CI_JOB_JWT");
    expect(sanitized).not.toHaveProperty("HTTPS_PROXY");
    expect(sanitized).not.toHaveProperty("HTTP_PROXY");
    expect(sanitized).not.toHaveProperty("ALL_PROXY");
    expect(sanitized).not.toHaveProperty("NO_PROXY");
    expect(sanitized).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(sanitized).not.toHaveProperty("CF_API_KEY");
    expect(sanitized).not.toHaveProperty("HARBOR_API_KEYS");
    expect(sanitized).not.toHaveProperty("HARBOR_KEK");
    expect(sanitized).not.toHaveProperty("MM_WALLET_SEED");
    expect(sanitized).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(sanitized).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(sanitized).not.toHaveProperty("NPM_TOKEN");
    expect(sanitized).not.toHaveProperty("UNKNOWN_FUTURE_SECRET");
    expect(sanitized).not.toHaveProperty("UNRELATED_SETTING");
    expect(sanitized.WRANGLER_SEND_METRICS).toBe("false");
    expect(sanitized.WRANGLER_SEND_ERROR_REPORTS).toBe("false");
    expect(sanitized.WRANGLER_LOG_PATH).toBe(
      join(repoRoot, LOCAL_STATE_DIRECTORY, "wrangler.log"),
    );
    expect(
      sanitizedChildEnvironment({}, LOCAL_PROFILES.X402_SIGNING).WRANGLER_LOG_PATH,
    ).toBe(join(repoRoot, LOCAL_X402_STATE_DIRECTORY, "wrangler.log"));
    expect(sanitized.CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe("false");
    expect(sanitized.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe("true");
  });

  it("targets only the detached child process group during termination", () => {
    const child = {
      pid: 43210,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    };
    const kills: Array<[number, NodeJS.Signals]> = [];

    expect(
      terminateSpawnedProcessTree(child, "SIGTERM", {
        platform: "darwin",
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          return true;
        },
      }),
    ).toBe(true);
    expect(kills).toEqual([[-child.pid, "SIGTERM"]]);
  });

  it("targets only the spawned process tree on Windows", () => {
    const child = {
      pid: 43210,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error("must not signal only the direct child");
      },
    };
    const kills: Array<[number, NodeJS.Signals]> = [];

    expect(
      terminateSpawnedProcessTree(child, "SIGKILL", {
        platform: "win32",
        killWindowsTree: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          return true;
        },
      }),
    ).toBe(true);
    expect(kills).toEqual([[child.pid, "SIGKILL"]]);
  });

  it("does not target an exited leader PID on Windows", () => {
    const child = {
      pid: 43210,
      exitCode: 0,
      signalCode: null,
      kill: () => true,
    };
    let attempted = false;

    expect(
      terminateSpawnedProcessTree(child, "SIGTERM", {
        allowExitedLeader: true,
        platform: "win32",
        killWindowsTree: () => {
          attempted = true;
          return true;
        },
      }),
    ).toBe(false);
    expect(attempted).toBe(false);
  });

  it.each([
    ["SIGINT", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
    ["SIGHUP", "SIGHUP"],
    ["disconnect", "SIGTERM"],
  ] as const)(
    "handles launcher shutdown event %s and removes its handlers",
    async (shutdownEvent, forwardedSignal) => {
      const signalSource = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        pid: 54321,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      const kills: Array<[number, NodeJS.Signals]> = [];
      let spawnOptions: Record<string, unknown> | undefined;

      const running = runCommand(
        { label: "test child", command: "/node", args: ["child.js"] },
        { PATH: "/bin" },
        {
          platform: "darwin",
          signalSource,
          cleanupGraceMs: 5,
          treeIsRunning: () => child.signalCode === null,
          spawnProcess: (_command: string, _args: string[], options: Record<string, unknown>) => {
            spawnOptions = options;
            return child;
          },
          killProcess: (pid: number, signal: NodeJS.Signals) => {
            kills.push([pid, signal]);
            child.signalCode = signal;
            queueMicrotask(() => child.emit("exit", null, signal));
            return true;
          },
        },
      );

      signalSource.emit(shutdownEvent);
      await expect(running).rejects.toMatchObject({
        name: LauncherInterruptedError.name,
        signal: shutdownEvent,
      });
      expect(spawnOptions).toMatchObject({ detached: true, stdio: "inherit" });
      expect(kills).toEqual([[-child.pid, forwardedSignal]]);
      expect(signalSource.listenerCount("SIGINT")).toBe(0);
      expect(signalSource.listenerCount("SIGTERM")).toBe(0);
      expect(signalSource.listenerCount("SIGHUP")).toBe(0);
      expect(signalSource.listenerCount("disconnect")).toBe(0);
    },
  );

  it("probes readiness only on the exact served loopback interface", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 55432,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const fetchProcess = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8791/health");
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
      runCommand(
        {
          label: "loopback Worker",
          command: "/node",
          args: ["worker.js"],
          readinessUrl: LOCAL_HEALTH_URL,
        },
        { PATH: "/bin" },
        {
          platform: "linux",
          signalSource,
          fetchProcess,
          readinessTimeoutMs: 50,
          readinessRetryMs: 1,
          spawnProcess: () => child,
          treeIsRunning: () => false,
        },
      ),
    ).resolves.toBeUndefined();
    expect(fetchProcess).toHaveBeenCalledTimes(1);
  });

  it("escalates cleanup only within the spawned group when launcher work fails", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 65432,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const kills: Array<[number, NodeJS.Signals]> = [];
    const running = runCommand(
      { label: "test child", command: "/node", args: ["child.js"] },
      { PATH: "/bin" },
      {
        platform: "linux",
        signalSource,
        cleanupGraceMs: 5,
        treeIsRunning: () => child.signalCode === null,
        spawnProcess: () => child,
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          if (signal === "SIGKILL") {
            child.signalCode = signal;
            queueMicrotask(() => child.emit("exit", null, signal));
          }
          return true;
        },
      },
    );

    child.emit("error", new Error("spawned child failed"));
    await expect(running).rejects.toThrow("spawned child failed");
    expect(kills).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
  });

  it("bounds a hung loopback readiness body and cleans the spawned group", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 66543,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const kills: Array<[number, NodeJS.Signals]> = [];
    const fetchProcess = vi.fn(async () => new Response(new ReadableStream({
      pull: () => new Promise(() => undefined),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const running = runCommand(
      {
        label: "loopback Worker",
        command: "/node",
        args: ["worker.js"],
        readinessUrl: LOCAL_HEALTH_URL,
      },
      { PATH: "/bin" },
      {
        platform: "linux",
        signalSource,
        fetchProcess,
        readinessTimeoutMs: 20,
        readinessAttemptTimeoutMs: 5,
        readinessRetryMs: 1,
        cleanupGraceMs: 1,
        spawnProcess: () => child,
        treeIsRunning: () => child.signalCode === null,
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          child.signalCode = signal;
          queueMicrotask(() => child.emit("exit", null, signal));
          return true;
        },
      },
    );

    await expect(running).rejects.toThrow(
      "Local Harbor process did not become healthy on the fixed loopback interface",
    );
    expect(fetchProcess).toHaveBeenCalled();
    expect(kills).toEqual([[-child.pid, "SIGTERM"]]);
  });

  it("caps the retry sleep at the exact readiness deadline", async () => {
    vi.useFakeTimers();
    try {
      const signalSource = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        pid: 67543,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      const fetchProcess = vi.fn(async () => new Response(null, { status: 503 }));
      const running = runCommand(
        {
          label: "loopback Worker",
          command: "/node",
          args: ["worker.js"],
          readinessUrl: LOCAL_HEALTH_URL,
        },
        { PATH: "/bin" },
        {
          platform: "linux",
          signalSource,
          fetchProcess,
          readinessTimeoutMs: 10_000,
          readinessAttemptTimeoutMs: 1_000,
          readinessRetryMs: 30_000,
          spawnProcess: () => child,
          treeIsRunning: () => false,
        },
      );
      const rejection = expect(running).rejects.toThrow(
        "Local Harbor process did not become healthy on the fixed loopback interface",
      );

      await vi.advanceTimersByTimeAsync(9_999);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(fetchProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans the original process group when its leader exits before descendants", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 76543,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const kills: Array<[number, NodeJS.Signals]> = [];
    let descendantAlive = true;
    const running = runCommand(
      { label: "test child", command: "/node", args: ["child.js"] },
      { PATH: "/bin" },
      {
        platform: "linux",
        signalSource,
        cleanupGraceMs: 5,
        spawnProcess: () => child,
        treeIsRunning: () => descendantAlive,
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          if (signal === "SIGKILL") descendantAlive = false;
          return true;
        },
      },
    );

    child.exitCode = 7;
    child.emit("exit", 7, null);

    await expect(running).rejects.toThrow("test child exited with code 7");
    expect(kills).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
    expect(kills.every(([pid]) => pid === -child.pid)).toBe(true);
  });

  it("cleans surviving descendants after a clean leader exit", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 87654,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const kills: Array<[number, NodeJS.Signals]> = [];
    let descendantAlive = true;
    const running = runCommand(
      { label: "test child", command: "/node", args: ["child.js"] },
      { PATH: "/bin" },
      {
        platform: "linux",
        signalSource,
        cleanupGraceMs: 5,
        spawnProcess: () => child,
        treeIsRunning: () => descendantAlive,
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          if (signal === "SIGKILL") descendantAlive = false;
          return true;
        },
      },
    );

    child.exitCode = 0;
    child.emit("exit", 0, null);

    await expect(running).resolves.toBeUndefined();
    expect(kills).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
  });

  it("fails closed and stops command progression when the process group survives SIGKILL", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 88765,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const kills: Array<[number, NodeJS.Signals]> = [];
    const commands = [
      { label: "stuck child", command: "/node", args: ["stuck.js"] },
      { label: "must not launch", command: "/node", args: ["next.js"] },
    ];
    const run = vi.fn(async (command: (typeof commands)[number], env: NodeJS.ProcessEnv) => {
      await runCommand(command, env, {
        platform: "linux",
        signalSource,
        cleanupGraceMs: 0,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          });
          return child;
        },
        treeIsRunning: () => true,
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          return true;
        },
      });
    });

    await expect(main([], {
      setUmask: () => undefined,
      prepareLaunch: async () => commands,
      run,
    })).rejects.toThrow("Local Harbor could not confirm spawned process tree termination");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(commands[0]);
    expect(kills).toEqual([
      [-child.pid, "SIGTERM"],
      [-child.pid, "SIGKILL"],
    ]);
  });

  it("does not signal after a clean exit when the process group is gone", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 98765,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    const kills: Array<[number, NodeJS.Signals]> = [];
    const running = runCommand(
      { label: "test child", command: "/node", args: ["child.js"] },
      { PATH: "/bin" },
      {
        platform: "linux",
        signalSource,
        spawnProcess: () => child,
        treeIsRunning: () => false,
        killProcess: (pid: number, signal: NodeJS.Signals) => {
          kills.push([pid, signal]);
          return true;
        },
      },
    );

    child.exitCode = 0;
    child.emit("exit", 0, null);

    await expect(running).resolves.toBeUndefined();
    expect(kills).toEqual([]);
  });

  it("refuses command-line overrides, including remote, tunnel, and deploy modes", () => {
    expect(() => validateLocalArguments([])).not.toThrow();
    for (const args of [
      ["--remote"],
      ["--tunnel"],
      ["deploy"],
      ["--force"],
      ["--overwrite"],
      ["--port", "9000"],
      ["--config", "wrangler.jsonc"],
      ["--env-file", ".dev.vars"],
    ]) {
      expect(() => validateLocalArguments(args)).toThrow();
    }

		const secretLookingValue = "HARBOR_KEK=must-not-be-reflected";
		try {
			validateLocalArguments(["--var", secretLookingValue]);
			throw new Error("expected local argument rejection");
		} catch (error) {
			expect(String(error)).not.toContain(secretLookingValue);
		}
  });

  it("uses a dummy D1 identity and contains no cloud-capable bindings", async () => {
    const config = JSON.parse(await readFile("wrangler.local.jsonc", "utf8")) as {
      name: string;
      d1_databases: Array<Record<string, unknown>>;
      vars: Record<string, string>;
      worker_loaders?: unknown;
      triggers?: unknown;
      observability?: unknown;
      upload_source_maps?: unknown;
    };
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const productionConfig = JSON.parse(await readFile("wrangler.jsonc", "utf8")) as {
      d1_databases: Array<Record<string, unknown>>;
    };
    const signingConfig = JSON.parse(
      await readFile("wrangler.local-x402.jsonc", "utf8"),
    ) as Record<string, unknown> & {
      d1_databases: Array<Record<string, unknown>>;
      vars: Record<string, string>;
    };
    const emptyEnv = await readFile("config/local-empty.env", "utf8");
    const [productionBaseMigration, localBaseMigration] = await Promise.all([
      readFile("migrations/0001_init.sql", "utf8"),
      readFile("migrations-local-x402/0001_init.sql", "utf8"),
    ]);

    expect(config.name).toBe("harbor-local-only");
    expect(config.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB",
        database_name: "harbor-local-only",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: "migrations-local-x402",
        remote: false,
      }),
    ]);
    expect(productionConfig.d1_databases[0]).not.toHaveProperty("migrations_dir");
    expect(config.d1_databases[0].migrations_dir).not.toBe("migrations");
    expect(localBaseMigration).toBe(productionBaseMigration);
    expect(config.d1_databases[0].database_name).not.toBe("pilot-harbor-disabled");
    expect(config.d1_databases[0].database_id).not.toBe(
      "26650077-dd29-413f-a527-b33494bb99e4",
    );
    expect(config).not.toHaveProperty("worker_loaders");
    expect(config).not.toHaveProperty("triggers");
    expect(config).not.toHaveProperty("observability");
    expect(config).not.toHaveProperty("upload_source_maps");
    expect(config.vars).toMatchObject({
      EXECUTOR: "quickjs",
      MAINNET_EXECUTION: "false",
      HARBOR_LOCAL_DEV: "true",
      HARBOR_LOCAL_READ_ONLY: "true",
      HARBOR_LOCAL_X402: "true",
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "false",
    });
    expect(() => validateLocalConfiguration(config)).not.toThrow();
    expect(() =>
      validateLocalConfiguration(signingConfig, LOCAL_PROFILES.X402_SIGNING),
    ).not.toThrow();
    const unsafeSigningConfig = structuredClone(signingConfig);
    unsafeSigningConfig.vars.MAINNET_EXECUTION = "true";
    expect(() =>
      validateLocalConfiguration(unsafeSigningConfig, LOCAL_PROFILES.X402_SIGNING),
    ).toThrow("Local Harbor runtime variables are not the reviewed profile");
    expect(() =>
      validateLocalConfiguration(
        { ...signingConfig, triggers: { crons: ["* * * * *"] } },
        LOCAL_PROFILES.X402_SIGNING,
      ),
    ).toThrow("Local Harbor configuration is not the reviewed isolated profile");
    await expect(validateLocalConfigurationFile(repoRoot)).resolves.toBeUndefined();
    await expect(
      validateLocalConfigurationFile(repoRoot, LOCAL_PROFILES.X402_SIGNING),
    ).resolves.toBeUndefined();
    expect(signingConfig.name).toBe("harbor-local-x402-only");
    expect(signingConfig).not.toHaveProperty("worker_loaders");
    expect(signingConfig).not.toHaveProperty("triggers");
    expect(signingConfig).not.toHaveProperty("observability");
    expect(signingConfig).not.toHaveProperty("upload_source_maps");
    expect(signingConfig.d1_databases).toEqual(config.d1_databases);
    expect(signingConfig.vars).toEqual({
      HARBOR_SOURCE_TAG: "2610240",
      EXEC_NETWORK: "testnet",
      MAINNET_EXECUTION: "false",
      EXECUTOR: "quickjs",
      HARBOR_LOCAL_DEV: "true",
      HARBOR_LOCAL_READ_ONLY: "true",
      HARBOR_LOCAL_X402: "true",
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1",
    });
    expect(packageJson.scripts["dev:local"]).toBe("node scripts/dev-local.mjs");
    expect(packageJson.scripts["dev:local:x402"]).toBe(
      "node scripts/dev-local-x402.mjs",
    );
    expect(emptyEnv.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"))).toEqual([]);
  });
});
