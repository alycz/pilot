import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDemoModelBudget,
  DemoModelAccessError,
  DemoModelBudget,
  readDemoModelConfig,
  readDemoModelPublicStatus,
  readDemoModelPublicStatusAsync,
} from "./demo-model-budget";

const WALLET_A = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const WALLET_B = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const SESSION_A = "a".repeat(64);
const SESSION_B = "b".repeat(64);
const MODEL = "provider/tool-model:free";
const REMOTE_POLICY = "free-demo-v1";
const REMOTE_SECRET = "remote-session-secret-that-is-longer-than-32-characters";
const REMOTE_API_KEY = `pilot:${"k".repeat(40)}`;
const RESERVATION_ID = "550e8400-e29b-41d4-a716-446655440000";
const directories: string[] = [];

function privateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pilot-demo-budget-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    DEMO_MODEL_ENABLED: "1",
    DEMO_MODEL_QUOTA_BACKEND: "sqlite-single-host",
    DEMO_MODEL_COST_POLICY: "free-only",
    DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE: "verified",
    DEMO_OPENROUTER_KEY_LIMIT_USD: "0",
    DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT: "1",
    DEMO_OPENROUTER_NO_BYOK: "verified",
    DEMO_OPENROUTER_PAID_ADDONS_DISABLED: "verified",
    DEMO_MODEL_STATE_DIR: privateDirectory(),
    DEMO_MODEL_ALLOWED_MODELS: MODEL,
    DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS: "1000",
    DEMO_MODEL_GLOBAL_DAILY_REQUESTS: "20",
    DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS: "512",
    DEMO_MODEL_WALLET_DAILY_REQUESTS: "10",
    DEMO_MODEL_RATE_WINDOW_SECONDS: "60",
    DEMO_MODEL_RATE_REQUESTS: "5",
    DEMO_MODEL_MAX_GLOBAL_CONCURRENCY: "1",
    DEMO_MODEL_MAX_WALLET_CONCURRENCY: "1",
    DEMO_MODEL_RESERVATION_TTL_SECONDS: "30",
    DEMO_MODEL_ABORT_GRACE_SECONDS: "2",
    DEMO_MODEL_MAX_INPUT_BYTES: "4096",
    DEMO_MODEL_MAX_OUTPUT_TOKENS: "256",
    DEMO_MODEL_MAX_STEPS: "3",
    ...overrides,
  };
}

function remoteEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return environment({
    DEMO_MODEL_QUOTA_BACKEND: "harbor-d1",
    DEMO_MODEL_QUOTA_POLICY_VERSION: REMOTE_POLICY,
    HARBOR_API_KEY: REMOTE_API_KEY,
    HARBOR_URL: "https://harbor.example/base/",
    NEXT_PUBLIC_DEV_SIGNER: "0",
    PILOT_DEPLOYMENT_PROFILE: "hosted",
    PILOT_PUBLIC_ORIGIN: "https://pilot.example",
    SESSION_SECRET: REMOTE_SECRET,
    VERCEL: "1",
    ...overrides,
  });
}

function remoteResponse(url: string, body: unknown, status = 200): Response {
  const value = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function remoteQuotaStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    policyVersion: REMOTE_POLICY,
    costPolicy: "free-only",
    allowedModels: [MODEL],
    globalDailyOutputTokens: 1000,
    globalDailyRequests: 20,
    walletDailyOutputTokens: 512,
    walletDailyRequests: 10,
    rateWindowSeconds: 60,
    rateRequests: 5,
    maxGlobalConcurrency: 1,
    maxWalletConcurrency: 1,
    reservationTtlSeconds: 30,
    abortGraceSeconds: 2,
    maxInputBytes: 4096,
    maxOutputTokens: 256,
    maxSteps: 3,
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<DemoModelBudget["reserve"]>[0]> = {}) {
  return {
    walletAccount: WALLET_A,
    network: "testnet" as const,
    walletSessionId: SESSION_A,
    model: MODEL,
    inputBytes: 128,
    now: Date.parse("2026-10-21T12:00:00.000Z"),
    ...overrides,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof DemoModelAccessError ? error.code : undefined;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
describe("demo model configuration", () => {
  it("is disabled by default and exposes only a non-sensitive status", () => {
    expect(readDemoModelConfig({})).toBeNull();
    expect(readDemoModelPublicStatus({})).toEqual({
      available: false,
      code: "DEMO_DISABLED",
    });
    expect(() => DemoModelBudget.fromEnvironment({})).toThrowError(
      expect.objectContaining({ code: "DEMO_DISABLED", status: 503 }),
    );
  });

  it.each([
    ["ambiguous enable", { DEMO_MODEL_ENABLED: "true" }],
    ["missing single-host backend assertion", { DEMO_MODEL_QUOTA_BACKEND: "" }],
    ["missing free-only policy", { DEMO_MODEL_COST_POLICY: "" }],
    ["unverified operator acceptance", { DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE: "" }],
    ["nonzero key limit", { DEMO_OPENROUTER_KEY_LIMIT_USD: "0.01" }],
    ["BYOK excluded from key limit", { DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT: "0" }],
    ["BYOK presence unverified", { DEMO_OPENROUTER_NO_BYOK: "" }],
    ["paid add-ons unverified", { DEMO_OPENROUTER_PAID_ADDONS_DISABLED: "" }],
    ["positive legacy money setting", { DEMO_MODEL_GLOBAL_BUDGET_MICRO_USD: "1" }],
    ["Vercel serverless runtime", { VERCEL: "1" }],
    ["AWS Lambda runtime", { AWS_LAMBDA_FUNCTION_NAME: "pilot-demo" }],
    ["zero integer", { DEMO_MODEL_MAX_STEPS: "0" }],
    ["decimal integer", { DEMO_MODEL_RATE_REQUESTS: "1.5" }],
    ["paid model", { DEMO_MODEL_ALLOWED_MODELS: "provider/paid" }],
    ["chained free variant", { DEMO_MODEL_ALLOWED_MODELS: "provider/model:online:free" }],
    ["free router alias", { DEMO_MODEL_ALLOWED_MODELS: "openrouter/free" }],
    ["duplicate model", { DEMO_MODEL_ALLOWED_MODELS: `${MODEL},${MODEL}` }],
    ["request output over global", {
      DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS: "255",
    }],
    ["wallet concurrency over global", {
      DEMO_MODEL_MAX_GLOBAL_CONCURRENCY: "1",
      DEMO_MODEL_MAX_WALLET_CONCURRENCY: "2",
    }],
    ["parallel zero-cost requests", {
      DEMO_MODEL_MAX_GLOBAL_CONCURRENCY: "2",
      DEMO_MODEL_MAX_WALLET_CONCURRENCY: "1",
    }],
  ] as const)("fails closed for %s", (_label, overrides) => {
    expect(() => readDemoModelConfig(environment(overrides))).toThrowError(
      expect.objectContaining({ code: "DEMO_MISCONFIGURED", status: 503 }),
    );
  });

  it("requires a pre-existing normalized owner-only real directory", () => {
    const loose = privateDirectory();
    chmodSync(loose, 0o755);
    expect(() => readDemoModelConfig(environment({
      DEMO_MODEL_STATE_DIR: loose,
    }))).toThrowError(expect.objectContaining({ code: "DEMO_MISCONFIGURED" }));

    const target = privateDirectory();
    const parent = privateDirectory();
    const link = join(parent, "linked-state");
    symlinkSync(target, link);
    expect(() => readDemoModelConfig(environment({
      DEMO_MODEL_STATE_DIR: link,
    }))).toThrowError(expect.objectContaining({ code: "DEMO_MISCONFIGURED" }));

    expect(() => readDemoModelConfig(environment({
      DEMO_MODEL_STATE_DIR: join(tmpdir(), "pilot-demo-budget-does-not-exist"),
    }))).toThrowError(expect.objectContaining({ code: "DEMO_STATE_UNAVAILABLE" }));
  });

  it("returns only allowlist and request caps in public status", () => {
    const env = environment();
    const status = readDemoModelPublicStatus(env);
    expect(status).toEqual({
      available: true,
      costPolicy: "free-only",
      allowedModels: [MODEL],
      maxInputBytes: 4096,
      maxOutputTokens: 256,
      maxSteps: 3,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(env.DEMO_MODEL_STATE_DIR!);
    expect(serialized).not.toContain("BUDGET_MICRO_USD");
    expect(serialized).not.toContain("walletSessionId");
  });

  it("accepts the remote D1 backend on serverless without retaining secrets", () => {
    const env = remoteEnvironment();
    const config = readDemoModelConfig(env);
    expect(config).toEqual(expect.objectContaining({
      quotaBackend: "harbor-d1",
      harborBaseUrl: "https://harbor.example/base",
      policyVersion: REMOTE_POLICY,
      costPolicy: "free-only",
    }));
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(REMOTE_API_KEY);
    expect(serialized).not.toContain(REMOTE_SECRET);
    expect(serialized).not.toContain("DEMO_MODEL_STATE_DIR");
  });

  it.each([
    ["http Harbor", { HARBOR_URL: "http://harbor.example" }],
    ["loopback Harbor", { HARBOR_URL: "https://127.0.0.1:8791" }],
    ["missing Harbor key", { HARBOR_API_KEY: undefined }],
    ["short session secret", { SESSION_SECRET: "short" }],
    ["missing policy version", { DEMO_MODEL_QUOTA_POLICY_VERSION: undefined }],
  ] as const)("fails the remote backend closed for %s", (_label, overrides) => {
    expect(() => readDemoModelConfig(remoteEnvironment(overrides))).toThrowError(
      expect.objectContaining({ code: "DEMO_MISCONFIGURED" }),
    );
  });
});

describe("Harbor D1 demo model budget", () => {
  it("sends only domain-separated opaque scopes and server-authorized request fields", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return remoteResponse(String(request), {
        ok: true,
        reservation: {
          id: RESERVATION_ID,
          timeoutMs: 28_000,
          maxOutputTokens: 85,
          maxSteps: 3,
          remainingGlobalDailyOutputTokens: 744,
          remainingWalletDailyOutputTokens: 256,
          remainingWalletDailyRequests: 9,
          policyVersion: REMOTE_POLICY,
        },
      });
    });
    const budget = createDemoModelBudget(remoteEnvironment(), { fetch });
    await expect(budget.reserve(input())).resolves.toEqual({
      id: RESERVATION_ID,
      timeoutMs: 28_000,
      maxOutputTokens: 85,
      maxSteps: 3,
      remainingGlobalDailyOutputTokens: 744,
      remainingWalletDailyOutputTokens: 256,
      remainingWalletDailyRequests: 9,
    });
    expect(requestBody).toEqual(expect.objectContaining({
      version: 1,
      requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
      walletScopeId: expect.stringMatching(/^[a-f0-9]{64}$/),
      sessionScopeId: expect.stringMatching(/^[a-f0-9]{64}$/),
      network: "testnet",
      model: MODEL,
      inputBytes: 128,
    }));
    expect(requestBody?.walletScopeId).not.toBe(requestBody?.sessionScopeId);
    const serialized = JSON.stringify(requestBody);
    expect(serialized).not.toContain(WALLET_A);
    expect(serialized).not.toContain(SESSION_A);
    expect(serialized).not.toContain(REMOTE_SECRET);
    expect(serialized).not.toContain(REMOTE_API_KEY);
    await budget.close?.();
  });

  it("rejects reservation caps that drift from the verified local policy", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) =>
      remoteResponse(String(request), {
        ok: true,
        reservation: {
          id: RESERVATION_ID,
          timeoutMs: 27_000,
          maxOutputTokens: 85,
          maxSteps: 3,
          remainingGlobalDailyOutputTokens: 744,
          remainingWalletDailyOutputTokens: 256,
          remainingWalletDailyRequests: 9,
          policyVersion: REMOTE_POLICY,
        },
      }));
    const budget = createDemoModelBudget(remoteEnvironment(), { fetch });

    await expect(budget.reserve(input())).rejects.toEqual(expect.objectContaining({
      code: "DEMO_STATE_UNAVAILABLE",
      status: 503,
    }));
  });

  it("reads shared public status asynchronously and rejects policy drift", async () => {
    const status = remoteQuotaStatus();
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) =>
      remoteResponse(String(request), { ok: true, status }));
    await expect(readDemoModelPublicStatusAsync(remoteEnvironment(), { fetch })).resolves.toEqual({
      available: true,
      costPolicy: "free-only",
      allowedModels: [MODEL],
      maxInputBytes: 4096,
      maxOutputTokens: 256,
      maxSteps: 3,
    });
    expect(readDemoModelPublicStatus(remoteEnvironment())).toEqual({
      available: false,
      code: "DEMO_STATE_UNAVAILABLE",
    });

    for (const changed of [
      { maxOutputTokens: 255 },
      { globalDailyRequests: 21 },
      { rateWindowSeconds: 61 },
      { maxGlobalConcurrency: 5 },
      { reservationTtlSeconds: 31 },
    ]) {
      const drift = vi.fn<typeof globalThis.fetch>(async (request) =>
        remoteResponse(String(request), {
          ok: true,
          status: remoteQuotaStatus(changed),
        }));
      await expect(readDemoModelPublicStatusAsync(remoteEnvironment(), { fetch: drift }))
        .resolves.toEqual({ available: false, code: "DEMO_STATE_UNAVAILABLE" });
    }
  });

  it("maps bounded Harbor quota failures and fails malformed responses closed", async () => {
    const denied = vi.fn<typeof globalThis.fetch>(async (request) =>
      remoteResponse(String(request), {
        ok: false,
        error: {
          code: "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED",
          message: "exhausted",
        },
      }, 429));
    const budget = createDemoModelBudget(remoteEnvironment(), { fetch: denied });
    await expect(budget.reserve(input())).rejects.toEqual(expect.objectContaining({
      code: "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED",
      status: 429,
    }));

    const malformed = vi.fn<typeof globalThis.fetch>(async (request) =>
      remoteResponse(String(request), { ok: true, reservation: { id: RESERVATION_ID } }));
    const unavailable = createDemoModelBudget(remoteEnvironment(), { fetch: malformed });
    await expect(unavailable.reserve(input())).rejects.toEqual(expect.objectContaining({
      code: "DEMO_STATE_UNAVAILABLE",
      status: 503,
    }));
  });
});

describe("demo model budget ledger", () => {
  it("enforces the exact allowlist and inclusive input-byte boundary", () => {
    const env = environment({ DEMO_MODEL_MAX_INPUT_BYTES: "128" });
    const budget = DemoModelBudget.fromEnvironment(env);
    expect(() => budget.assertRequest("other/tool:free", 1)).toThrowError(
      expect.objectContaining({ code: "DEMO_MODEL_NOT_ALLOWED", status: 400 }),
    );
    expect(() => budget.assertRequest(MODEL, 128)).not.toThrow();
    expect(() => budget.assertRequest(MODEL, 129)).toThrowError(
      expect.objectContaining({ code: "DEMO_INPUT_TOO_LARGE", status: 413 }),
    );
    budget.close();
  });

  it("atomically prevents distinct connections from exceeding the global token quota", async () => {
    const env = environment({
      DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS: "256",
      DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS: "512",
    });
    const left = DemoModelBudget.fromEnvironment(env);
    const right = DemoModelBudget.fromEnvironment(env);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => left.reserve(input())),
      Promise.resolve().then(() => right.reserve(input({
        walletAccount: WALLET_B,
        walletSessionId: SESSION_B,
      }))),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? code(rejection.reason) : undefined)
      .toBe("DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED");
    left.close();
    right.close();
  });

  it.each([
    "unexpected-model",
    "missing-cost",
    "nonzero-cost",
  ] as const)("persists a %s integrity trip across database connections", (integrityFailure) => {
    const env = environment();
    const left = DemoModelBudget.fromEnvironment(env);
    const right = DemoModelBudget.fromEnvironment(env);
    const reservation = left.reserve(input());

    expect(left.settle(reservation.id, {
      outcome: "uncertain",
      integrityFailure,
      now: input().now! + 1,
    })).toEqual({
      id: reservation.id,
      outcome: "uncertain",
      alreadySettled: false,
    });
    expect(() => right.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
      now: input().now! + 2,
    }))).toThrowError(expect.objectContaining({
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
      status: 503,
      message: "Free demo access is paused after a zero-cost integrity check failed",
    }));
    expect(readDemoModelPublicStatus(env)).toEqual({
      available: false,
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
    });
    expect(() => right.assertRequest(MODEL, 0)).toThrowError(
      expect.objectContaining({ code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED" }),
    );

    left.close();
    right.close();
  });

  it("persists explicit integrity evidence after ordinary uncertainty settled first", () => {
    const env = environment();
    const budget = DemoModelBudget.fromEnvironment(env);
    const reservation = budget.reserve(input());
    expect(budget.settle(reservation.id, {
      outcome: "uncertain",
      now: input().now! + 1,
    }).alreadySettled).toBe(false);

    expect(budget.settle(reservation.id, {
      outcome: "uncertain",
      integrityFailure: "nonzero-cost",
      now: input().now! + 2,
    })).toEqual({
      id: reservation.id,
      outcome: "uncertain",
      alreadySettled: true,
    });
    expect(readDemoModelPublicStatus(env)).toEqual({
      available: false,
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
    });
    budget.close();
  });

  it("blocks all later demo access after ordinary cost verification is uncertain", () => {
    const env = environment();
    const left = DemoModelBudget.fromEnvironment(env);
    const right = DemoModelBudget.fromEnvironment(env);
    const reservation = left.reserve(input());
    left.settle(reservation.id, {
      outcome: "uncertain",
      now: input().now! + 1,
    });

    expect(() => right.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
      now: input().now! + 2,
    }))).toThrowError(expect.objectContaining({
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
    }));

    left.close();
    right.close();
  });

  it("retains the full token reservation and settles idempotently", () => {
    const env = environment({
      DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS: "256",
    });
    const budget = DemoModelBudget.fromEnvironment(env);
    const reservation = budget.reserve(input());
    expect(reservation).toMatchObject({
      timeoutMs: 28_000,
      maxOutputTokens: 85,
      maxSteps: 3,
      remainingGlobalDailyOutputTokens: 0,
      remainingWalletDailyOutputTokens: 256,
      remainingWalletDailyRequests: 9,
    });
    expect(budget.settle(reservation.id, {
      outcome: "completed",
      actualInputTokens: 12,
      actualOutputTokens: 4,
      now: input().now! + 1,
    })).toEqual({ id: reservation.id, outcome: "completed", alreadySettled: false });
    expect(budget.settle(reservation.id, {
      outcome: "uncertain",
      now: input().now! + 2,
    })).toEqual({ id: reservation.id, outcome: "completed", alreadySettled: true });
    expect(() => budget.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
      now: input().now! + 3,
    }))).toThrowError(expect.objectContaining({
      code: "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED",
    }));
    budget.close();
  });

  it("turns reported output above the reserved cap into a durable block", () => {
    const budget = DemoModelBudget.fromEnvironment(environment());
    const reservation = budget.reserve(input());

    expect(budget.settle(reservation.id, {
      outcome: "completed",
      actualOutputTokens: 257,
      now: input().now! + 1,
    })).toEqual({
      id: reservation.id,
      outcome: "uncertain",
      alreadySettled: false,
    });
    expect(() => budget.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
      now: input().now! + 2,
    }))).toThrowError(expect.objectContaining({
      code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
    }));
    budget.close();
  });

  it("keeps an expired/crashed reservation as a durable zero-cost block", () => {
    const env = environment({
      DEMO_MODEL_RESERVATION_TTL_SECONDS: "3",
      DEMO_MODEL_ABORT_GRACE_SECONDS: "1",
      DEMO_MODEL_MAX_GLOBAL_CONCURRENCY: "1",
      DEMO_MODEL_MAX_WALLET_CONCURRENCY: "1",
    });
    const budget = DemoModelBudget.fromEnvironment(env);
    const first = budget.reserve(input());
    expect(() => budget.reserve(input({ now: input().now! + 500 }))).toThrowError(
      expect.objectContaining({ code: "DEMO_GLOBAL_BUSY" }),
    );
    expect(() => budget.reserve(input({ now: input().now! + 2_001 }))).toThrowError(
      expect.objectContaining({ code: "DEMO_GLOBAL_BUSY" }),
    );
    expect(() => budget.reserve(input({ now: input().now! + 3_001 }))).toThrowError(
      expect.objectContaining({ code: "DEMO_ZERO_COST_INTEGRITY_BLOCKED" }),
    );
    expect(budget.settle(first.id, {
      outcome: "completed",
      now: input().now! + 3_002,
    })).toEqual({ id: first.id, outcome: "uncertain", alreadySettled: false });
    budget.close();
  });

  it("settles a late completion as uncertain without waiting for another reservation", () => {
    const budget = DemoModelBudget.fromEnvironment(environment({
      DEMO_MODEL_RESERVATION_TTL_SECONDS: "3",
      DEMO_MODEL_ABORT_GRACE_SECONDS: "1",
    }));
    const reservation = budget.reserve(input());
    expect(budget.settle(reservation.id, {
      outcome: "completed",
      actualInputTokens: 10,
      actualOutputTokens: 10,
      now: input().now! + 3_001,
    })).toEqual({
      id: reservation.id,
      outcome: "uncertain",
      alreadySettled: false,
    });
    budget.close();
  });

  it("enforces the wallet daily output-token quota across replacement sessions", () => {
    const env = environment({
      DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS: "256",
    });
    const budget = DemoModelBudget.fromEnvironment(env);
    const first = budget.reserve(input());
    budget.settle(first.id, { outcome: "completed", now: input().now! + 1 });
    expect(() => budget.reserve(input({
      walletSessionId: SESSION_B,
      now: input().now! + 2,
    }))).toThrowError(expect.objectContaining({
      code: "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED",
    }));
    expect(() => budget.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
      now: Date.parse("2026-10-22T00:00:00.000Z"),
    }))).not.toThrow();
    budget.close();
  });

  it("binds each session digest to one wallet and network", () => {
    const budget = DemoModelBudget.fromEnvironment(environment());
    const first = budget.reserve(input({ walletSessionId: SESSION_A.toUpperCase() }));
    budget.settle(first.id, { outcome: "completed", now: input().now! + 1 });
    expect(() => budget.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_A,
      now: input().now! + 2,
    }))).toThrowError(expect.objectContaining({ code: "DEMO_MISCONFIGURED" }));
    expect(() => budget.reserve(input({
      network: "devnet",
      walletSessionId: SESSION_A,
      now: input().now! + 3,
    }))).toThrowError(expect.objectContaining({ code: "DEMO_MISCONFIGURED" }));
    budget.close();
  });

  it("enforces daily request count and resets on the next UTC day", () => {
    const env = environment({
      DEMO_MODEL_WALLET_DAILY_REQUESTS: "1",
      DEMO_MODEL_RATE_REQUESTS: "5",
    });
    const budget = DemoModelBudget.fromEnvironment(env);
    const first = budget.reserve(input());
    budget.settle(first.id, { outcome: "completed", now: input().now! + 1 });
    expect(() => budget.reserve(input({ now: input().now! + 2 }))).toThrowError(
      expect.objectContaining({ code: "DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED" }),
    );
    expect(() => budget.reserve(input({
      now: Date.parse("2026-10-22T00:00:00.000Z"),
    }))).not.toThrow();
    budget.close();
  });

  it("atomically enforces the global daily request count across connections and resets at UTC midnight", async () => {
    const env = environment({
      DEMO_MODEL_GLOBAL_DAILY_REQUESTS: "1",
      DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS: "1000",
    });
    const left = DemoModelBudget.fromEnvironment(env);
    const right = DemoModelBudget.fromEnvironment(env);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => left.reserve(input())),
      Promise.resolve().then(() => right.reserve(input({
        walletAccount: WALLET_B,
        walletSessionId: SESSION_B,
      }))),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? code(rejection.reason) : undefined)
      .toBe("DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED");
    const admitted = results.find((result) => result.status === "fulfilled");
    if (!admitted || admitted.status !== "fulfilled") {
      throw new Error("expected one admitted reservation");
    }
    right.settle(admitted.value.id, {
      outcome: "completed",
      now: input().now! + 1,
    });
    expect(() => right.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
      now: Date.parse("2026-10-22T00:00:00.000Z"),
    }))).not.toThrow();
    left.close();
    right.close();
  });

  it("enforces the session rate window and reports a bounded retry", () => {
    const env = environment({
      DEMO_MODEL_RATE_REQUESTS: "1",
      DEMO_MODEL_RATE_WINDOW_SECONDS: "60",
    });
    const budget = DemoModelBudget.fromEnvironment(env);
    const first = budget.reserve(input());
    budget.settle(first.id, { outcome: "completed", now: input().now! + 1 });
    try {
      budget.reserve(input({ now: input().now! + 30_000 }));
      throw new Error("expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(DemoModelAccessError);
      expect(error).toMatchObject({
        code: "DEMO_RATE_LIMITED",
        status: 429,
        retryAfterSeconds: 30,
      });
    }
    expect(() => budget.reserve(input({ now: input().now! + 60_001 }))).not.toThrow();
    budget.close();
  });

  it("enforces the strict single-flight global concurrency boundary", () => {
    const globalEnv = environment({
      DEMO_MODEL_MAX_GLOBAL_CONCURRENCY: "1",
      DEMO_MODEL_MAX_WALLET_CONCURRENCY: "1",
    });
    const globalBudget = DemoModelBudget.fromEnvironment(globalEnv);
    globalBudget.reserve(input());
    expect(() => globalBudget.reserve(input({
      walletAccount: WALLET_B,
      walletSessionId: SESSION_B,
    }))).toThrowError(expect.objectContaining({ code: "DEMO_GLOBAL_BUSY" }));
    globalBudget.close();
  });

  it("rejects unknown settlements and invalid usage counts", () => {
    const budget = DemoModelBudget.fromEnvironment(environment());
    expect(() => budget.settle("missing", { outcome: "uncertain" })).toThrowError(
      expect.objectContaining({ code: "DEMO_RESERVATION_NOT_FOUND", status: 404 }),
    );
    const reservation = budget.reserve(input());
    expect(() => budget.settle(reservation.id, {
      outcome: "completed",
      actualOutputTokens: -1,
    })).toThrowError(expect.objectContaining({ code: "DEMO_MISCONFIGURED" }));
    budget.close();
  });
});
