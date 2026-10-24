import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { BacktestQuotaError, type BacktestAccessScope } from "./access-control";
import {
  BACKTEST_QUOTA_POLICY_VERSION,
  createConfiguredBacktestQuota,
  readBacktestQuotaConfig,
  SqliteBacktestExternalReadQuota,
  type SqliteBacktestQuotaConfig,
} from "./durable-quota";

const cleanup = new Set<string>();
const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));

async function stateDirectory(prefix = "pilot-backtest-quota-"): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  cleanup.add(directory);
  return directory;
}

function config(directory: string, overrides: Partial<SqliteBacktestQuotaConfig> = {}): SqliteBacktestQuotaConfig {
  return {
    backend: "sqlite-single-host",
    stateDirectory: directory,
    policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
    accountMaximum: 2,
    sessionMaximum: 2,
    ...overrides,
  };
}

function scope(account: string, session: string, overrides: Partial<BacktestAccessScope> = {}): BacktestAccessScope {
  return {
    accountScopeId: account.repeat(64),
    sessionScopeId: session.repeat(64),
    network: "testnet",
    sessionExpiresAt: 10_000_000,
    ...overrides,
  };
}

async function compileQuotaWorker(directory: string): Promise<string> {
  for (const name of ["quota-contract", "durable-quota"]) {
    const source = await readFile(join(sourceDirectory, `${name}.ts`), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: `${name}.ts`,
    }).outputText;
    await writeFile(join(directory, `${name}.js`), output, { mode: 0o600 });
  }
  const runner = join(directory, "quota-race-worker.cjs");
  await writeFile(runner, `
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { SqliteBacktestExternalReadQuota, BACKTEST_QUOTA_POLICY_VERSION } = require("./durable-quota.js");
const [stateDirectory, identity, peerIdentity] = process.argv.slice(2);
const ready = join(stateDirectory, "ready-" + identity);
const peerReady = join(stateDirectory, "ready-" + peerIdentity);
let quota;
try {
  quota = new SqliteBacktestExternalReadQuota({
    backend: "sqlite-single-host",
    stateDirectory,
    policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
    accountMaximum: 1,
    sessionMaximum: 1,
  });
  writeFileSync(ready, "ready", { mode: 0o600 });
  const deadline = Date.now() + 5000;
  while (!existsSync(peerReady) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (!existsSync(peerReady)) throw new Error("peer did not become ready");
  quota.reserve({
    accountScopeId: "a".repeat(64),
    sessionScopeId: identity.repeat(64),
    network: "testnet",
    sessionExpiresAt: 10000000,
  }, 1000);
  process.stdout.write(JSON.stringify({ outcome: "reserved" }));
} catch (error) {
  process.stdout.write(JSON.stringify({ outcome: "rejected", code: error && error.code }));
} finally {
  if (quota) quota.close();
}
`, { mode: 0o600 });
  return runner;
}

function runQuotaWorker(runner: string, directory: string, identity: string, peerIdentity: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, directory, identity, peerIdentity], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`quota worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error(`quota worker returned invalid output: ${stdout} ${stderr}`));
      }
    });
  });
}

afterEach(async () => {
  await Promise.all([...cleanup].map((path) => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

describe("durable backtest quota configuration", () => {
  it("is disabled by default and requires the complete explicit local contract", async () => {
    expect(readBacktestQuotaConfig({})).toBeNull();
    const directory = await stateDirectory();
    expect(readBacktestQuotaConfig({
      BACKTEST_EXTERNAL_READS_ENABLED: "1",
      BACKTEST_QUOTA_BACKEND: "sqlite-single-host",
      BACKTEST_QUOTA_STATE_DIR: directory,
      BACKTEST_QUOTA_POLICY_VERSION,
      BACKTEST_QUOTA_ACCOUNT_HOURLY_RUNS: "12",
      BACKTEST_QUOTA_SESSION_HOURLY_RUNS: "4",
    })).toEqual(config(directory, { accountMaximum: 12, sessionMaximum: 4 }));
  });

  it("rejects serverless enablement and unsafe state directories", async () => {
    const directory = await stateDirectory();
    const environment = {
      BACKTEST_EXTERNAL_READS_ENABLED: "1",
      BACKTEST_QUOTA_BACKEND: "sqlite-single-host",
      BACKTEST_QUOTA_STATE_DIR: directory,
      BACKTEST_QUOTA_POLICY_VERSION,
      BACKTEST_QUOTA_ACCOUNT_HOURLY_RUNS: "12",
      BACKTEST_QUOTA_SESSION_HOURLY_RUNS: "4",
    };
    expect(() => readBacktestQuotaConfig({ ...environment, VERCEL: "1" })).toThrow(/cannot enable.*serverless/i);

    await chmod(directory, 0o755);
    expect(() => readBacktestQuotaConfig(environment)).toThrow(/mode 0700/i);
    await chmod(directory, 0o700);
    const parent = await stateDirectory("pilot-backtest-quota-parent-");
    const link = join(parent, "state-link");
    await symlink(directory, link, "dir");
    expect(() => readBacktestQuotaConfig({ ...environment, BACKTEST_QUOTA_STATE_DIR: link })).toThrow(/symbolic link/i);

    const target = await stateDirectory("pilot-backtest-quota-ancestor-target-");
    const nested = join(target, "nested");
    await mkdir(nested, { mode: 0o700 });
    const ancestorLink = join(parent, "ancestor-link");
    await symlink(target, ancestorLink, "dir");
    expect(() => readBacktestQuotaConfig({
      ...environment,
      BACKTEST_QUOTA_STATE_DIR: join(ancestorLink, "nested"),
    })).toThrow(/canonical path/i);
  });

  it("fails closed without creating state when durable quota is disabled", () => {
    const quota = createConfiguredBacktestQuota({});
    expect(() => quota.reserve(scope("a", "b"), 1_000)).toThrowError(BacktestQuotaError);
  });
});

describe("SQLite backtest external-read quota", () => {
  it("atomically prevents two processes from exceeding one shared account slot", async () => {
    const directory = await stateDirectory();
    const initialized = new SqliteBacktestExternalReadQuota(config(directory, {
      accountMaximum: 1,
      sessionMaximum: 1,
    }));
    initialized.close();
    const runner = await compileQuotaWorker(directory);
    const results = await Promise.all([
      runQuotaWorker(runner, directory, "b", "c"),
      runQuotaWorker(runner, directory, "c", "b"),
    ]);
    expect(results).toEqual(expect.arrayContaining([
      { outcome: "reserved" },
      { outcome: "rejected", code: "QUOTA_EXHAUSTED" },
    ]));
  }, 10_000);

  it("preserves account and session usage across adapter restarts", async () => {
    const directory = await stateDirectory();
    const policy = config(directory, { accountMaximum: 1, sessionMaximum: 1 });
    const first = new SqliteBacktestExternalReadQuota(policy);
    first.reserve(scope("a", "b"), 1_000);
    first.close();
    const restarted = new SqliteBacktestExternalReadQuota(policy);
    expect(() => restarted.reserve(scope("a", "c"), 1_000)).toThrow(/exhausted/i);
    restarted.close();
  });

  it("rejects a second instance with drifted shared quota policy", async () => {
    const directory = await stateDirectory();
    const first = new SqliteBacktestExternalReadQuota(config(directory, { accountMaximum: 1, sessionMaximum: 1 }));
    expect(() => new SqliteBacktestExternalReadQuota(config(directory, {
      accountMaximum: 2,
      sessionMaximum: 1,
    }))).toThrow(/storage is unavailable/i);
    first.close();
  });

  it("isolates accounts while preventing replacement sessions from bypassing the account cap", async () => {
    const directory = await stateDirectory();
    const quota = new SqliteBacktestExternalReadQuota(config(directory));
    quota.reserve(scope("a", "b"), 1_000);
    quota.reserve(scope("a", "c"), 1_001);
    expect(() => quota.reserve(scope("a", "d"), 1_002)).toThrow(/exhausted/i);
    expect(() => quota.reserve(scope("e", "f"), 1_002)).not.toThrow();
    quota.close();
  });

  it("rejects cross-account session rebinding and expires old windows", async () => {
    const directory = await stateDirectory();
    const quota = new SqliteBacktestExternalReadQuota(config(directory, { accountMaximum: 1, sessionMaximum: 1 }));
    quota.reserve(scope("a", "b"), 1_000);
    expect(() => quota.reserve(scope("c", "b"), 1_001)).toThrow(/changed accounts or networks/i);
    expect(() => quota.reserve(scope("a", "d"), 3_601_000)).not.toThrow();
    quota.close();
  });

  it("fails closed on expired or malformed scopes", async () => {
    const directory = await stateDirectory();
    const quota = new SqliteBacktestExternalReadQuota(config(directory));
    expect(() => quota.reserve(scope("a", "b", { sessionExpiresAt: 1_000 }), 1_000)).toThrow(/invalid or expired/i);
    expect(() => quota.reserve(scope("A", "b"), 1_000)).toThrow(/invalid or expired/i);
    quota.close();
  });
});
