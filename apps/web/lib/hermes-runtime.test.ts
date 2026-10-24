import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HermesFetch } from "@pilot/agent/hermes-transport";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateHermesBridgeServiceForTest,
  createHermesBridgeClient,
  createHermesBridgeService,
  HERMES_BRIDGE_PROFILE_INVARIANTS,
  type HermesBridgeConfig,
} from "./hermes-bridge-service";
import { issueHermesConsentCookie } from "./hermes-consent";
import type { HermesProfileGateSnapshot } from "./hermes-profile-gate";
import { createProcessHermesUsageMonitor } from "./hermes-workflow-lessons";
import {
  createHermesRuntimeAdvisorFactory,
  createHermesRuntimeAdvisorFactoryFromEnvironment,
  installHermesRuntimeActivationServices,
  type HermesRuntimeConfig,
  type HermesRuntimeActivationServices,
} from "./hermes-runtime";

const roots: string[] = [];
const activationDisposers: Array<() => void> = [];
const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const scope = { tenantId: "tenant-runtime", owner, network: "testnet" as const };
const consentSecret = "runtime-consent-secret-at-least-thirty-two-characters";
const now = 1_800_000_000_000;

afterEach(async () => {
  while (activationDisposers.length) activationDisposers.pop()!();
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pilot-hermes-runtime-")),
  );
  roots.push(root);
  await chmod(root, 0o700);
  const bridgeConfig: HermesBridgeConfig = {
    controlOrigin: "http://127.0.0.1:8650",
    ingressOrigin: "http://127.0.0.1:8644",
    controlBearer: "control-bearer-at-least-thirty-two-characters",
    controlResponseKey: "control-response-key-at-least-thirty-two-characters",
    ingressBearer: "ingress-bearer-at-least-thirty-two-characters",
    upstreamUrl: "https://provider.example/v1/chat/completions",
    upstreamCredential: "provider-credential-not-real",
    profile: "pilot-proposal-v1",
    provider: "openrouter",
    model: "example/read-only",
    tokenParameter: "max_completion_tokens",
    outputTokens: 64,
    maxInputBytes: 8_192,
    maxMessages: 16,
    maxResponseBytes: 16_384,
    timeoutMs: 1_000,
    framingTokenAllowance: 128,
    inputMicrousdPerMillionTokens: 1_000,
    outputMicrousdPerMillionTokens: 2_000,
    maxCallMicrousd: 10,
    maxDailyMicrousd: 100,
    journalRoot: root,
    journalPath: path.join(root, "bridge-journal.json"),
    profileInvariants: HERMES_BRIDGE_PROFILE_INVARIANTS,
  };
  const result = {
    kind: "read_only" as const,
    summary: "A bounded review-only explanation.",
    evidence: [],
    caveats: ["Review is still required."],
  };
  const service = await createHermesBridgeService(bridgeConfig, {
    now: () => now,
    fetch: vi.fn(async () => Response.json({
      id: "completion-1",
      object: "chat.completion",
      created: 1,
      model: bridgeConfig.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify(result) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })),
  });
  await activateHermesBridgeServiceForTest(service);
  const controlFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    service.handleControl(new Request(String(input), init), { remoteAddress: "127.0.0.1" }));
  const client = createHermesBridgeClient({
    ...service.contract,
    controlOrigin: bridgeConfig.controlOrigin,
    controlBearer: bridgeConfig.controlBearer,
    controlResponseKey: bridgeConfig.controlResponseKey,
  }, controlFetch as typeof fetch, { now: () => now });
  const registered: string[] = [];
  const settlements: Array<{ sessionId: string; outcome: "created" | "uncertain" }> = [];
  let consentState: "accepted" | "revoked" = "accepted";
  let consentEpoch = 1;
  let revokeAfterChat = false;
  let rotateConsentDuringAttestation = false;
  let blockRegistrationUntilAbort = false;
  const retention = {
    consent: vi.fn(async () => ({ epoch: consentEpoch, state: consentState })),
    registerSession: vi.fn(async ({
      sessionId,
      expectedConsentEpoch,
      signal,
    }: {
      sessionId: string;
      expectedConsentEpoch: number;
      signal?: AbortSignal;
    }) => {
      if (consentState !== "accepted" || consentEpoch !== expectedConsentEpoch) {
        throw new Error("Hermes session cannot be retained without current consent.");
      }
      if (blockRegistrationUntilAbort) {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      registered.push(sessionId);
    }),
    settleSessionCreation: vi.fn(async ({
      sessionId,
      expectedConsentEpoch,
      outcome,
    }: {
      sessionId: string;
      expectedConsentEpoch: number;
      outcome: "created" | "uncertain";
    }) => {
      if (!registered.includes(sessionId) || expectedConsentEpoch !== 1) {
        throw new Error("Hermes retention session is missing.");
      }
      settlements.push({ sessionId, outcome });
      return outcome === "created" && consentState === "accepted" && consentEpoch === 1
        ? "active" as const
        : outcome === "created" ? "pending_delete" as const : "uncertain" as const;
    }),
  };
  const toolsets = {
    object: "list",
    platform: "api_server",
    data: [{
      name: "terminal",
      label: "Terminal",
      description: "disabled fixture",
      enabled: false,
      configured: false,
      tools: ["terminal"],
    }],
  };
  const hermesFetch = vi.fn(async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    if (String(input).endsWith("/toolsets")) {
      if (rotateConsentDuringAttestation) {
        consentState = "revoked";
        consentEpoch += 1;
        consentState = "accepted";
        consentEpoch += 1;
        rotateConsentDuringAttestation = false;
      }
      return Response.json(toolsets);
    }
    const sessionId = new Headers(init.headers).get("x-hermes-session-id");
    expect(registered).toContain(sessionId);
    const response = await service.handleIngress(new Request(
      `${bridgeConfig.ingressOrigin}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridgeConfig.ingressBearer}`,
          "content-type": "application/json",
          host: new URL(bridgeConfig.ingressOrigin).host,
        },
        body: String(init.body),
      },
    ), { remoteAddress: "127.0.0.1" });
    if (revokeAfterChat) {
      consentState = "revoked";
      consentEpoch += 1;
    }
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "x-hermes-session-id": sessionId ?? "",
      },
    });
  }) as HermesFetch;
  const disclosure = {
    provider: bridgeConfig.provider,
    model: bridgeConfig.model,
    dataPolicy: "bounded-redacted-proposals" as const,
    retentionDays: 7,
    termsVersion: "v1",
  };
  const issued = issueHermesConsentCookie(scope, disclosure, {
    secret: consentSecret,
    epoch: 1,
    now,
  });
  const config: HermesRuntimeConfig = {
    enabled: true,
    origin: "http://127.0.0.1:8642",
    profile: bridgeConfig.profile,
    apiKey: "hermes-profile-api-key-not-real",
    provider: bridgeConfig.provider,
    model: bridgeConfig.model,
    retentionDays: 7,
    termsVersion: "v1",
    consentSecret,
    retentionStatePath: path.join(root, "retention.json"),
    dailyCallLimit: 3,
    profileGate: {} as HermesRuntimeConfig["profileGate"],
  };
  const profileSnapshot = {} as HermesProfileGateSnapshot;
  const sweepRetention = vi.fn(async () => ({
    scopes: 0,
    attempted: 0,
    databaseAbsent: 0,
    blocked: 0,
    exhausted: 0,
  }));
  const assertImmutableProfile = vi.fn(async () => undefined);
  let sweeperReady = true;
  const factory = createHermesRuntimeAdvisorFactory(config, {
    bridge: {
      client,
      usageMonitor: createProcessHermesUsageMonitor(3),
    },
    transport: hermesFetch,
    retentionJournal: retention,
    verifyProfile: vi.fn(async () => profileSnapshot),
    assertProfileUnchanged: vi.fn(async () => undefined),
    activation: {
      assertImmutableProfile,
      retentionSweeper: {
        runOnce: sweepRetention,
        status: () => ({
          phase: sweeperReady ? "ready" as const : "stopped" as const,
          started: sweeperReady,
          ready: sweeperReady,
          inFlight: false,
          completedCycles: 1,
          attempted: 0,
          databaseAbsent: 0,
          blocked: 0,
        }),
      },
    },
    now: () => now,
  });
  const request = new Request("http://127.0.0.1:3003/api/chat", {
    headers: { cookie: `__Host-pilot-hermes-consent=${issued.value}` },
  });
  return {
    factory,
    request,
    sweepRetention,
    assertImmutableProfile,
    stopSweeper: () => { sweeperReady = false; },
    registered,
    settlements,
    retention,
    revoke: () => {
      consentState = "revoked";
      consentEpoch += 1;
    },
    reaccept: () => {
      consentState = "accepted";
      consentEpoch += 1;
    },
    rotateConsentBeforePrepare: () => { rotateConsentDuringAttestation = true; },
    blockRegistration: () => { blockRegistrationUntilAbort = true; },
    revokeAfterChat: () => { revokeAfterChat = true; },
    hermesFetch,
  };
}

describe("Hermes production runtime composition", () => {
  it("runs one synthetic advisory through the actual bridge contract", async () => {
    const runtime = await fixture();
    const advisor = await runtime.factory({ request: runtime.request, scope });
    expect(advisor.enabled).toBe(true);
    await expect(advisor.advise({
      recordId: `lesson:${"a".repeat(32)}`,
      revision: 1,
      version: 1,
      target: { category: "response_detail", value: "concise" },
      evidenceCount: 2,
    }, runtime.request.signal)).resolves.toMatchObject({
      summary: "A bounded review-only explanation.",
      disclosure: { provider: "openrouter", model: "example/read-only" },
      usage: { totalTokens: 30 },
    });
    expect(runtime.registered).toHaveLength(1);
    expect(runtime.retention.registerSession).toHaveBeenCalledWith(expect.objectContaining({
      expectedConsentEpoch: 1,
      creationDeadline: now + 90_000,
    }));
    expect(runtime.settlements).toEqual([{
      sessionId: runtime.registered[0],
      outcome: "created",
    }]);
    expect(runtime.sweepRetention).toHaveBeenCalledOnce();
    expect(runtime.assertImmutableProfile).toHaveBeenCalledTimes(3);
    expect(runtime.hermesFetch).toHaveBeenCalledTimes(3);
  });

  it("stays disabled without current exact consent and performs no live checks", async () => {
    const runtime = await fixture();
    const request = new Request(runtime.request.url);
    const advisor = await runtime.factory({ request, scope });
    expect(advisor.enabled).toBe(false);
    expect(runtime.sweepRetention).toHaveBeenCalledOnce();
    expect(runtime.hermesFetch).not.toHaveBeenCalled();
  });

  it("discards a completed advisory when consent is revoked during the call", async () => {
    const runtime = await fixture();
    const advisor = await runtime.factory({ request: runtime.request, scope });
    runtime.revokeAfterChat();
    await expect(advisor.advise({
      recordId: `lesson:${"b".repeat(32)}`,
      revision: 1,
      version: 1,
      target: { category: "response_detail", value: "concise" },
      evidenceCount: 2,
    })).rejects.toThrow("consent changed");
    expect(runtime.registered).toHaveLength(1);
    expect(runtime.settlements).toEqual([{
      sessionId: runtime.registered[0],
      outcome: "created",
    }]);
  });

  it("does not POST after consent is revoked and reaccepted with a new epoch", async () => {
    const runtime = await fixture();
    const advisor = await runtime.factory({ request: runtime.request, scope });
    runtime.rotateConsentBeforePrepare();
    await expect(advisor.advise({
      recordId: `lesson:${"c".repeat(32)}`,
      revision: 1,
      version: 1,
      target: { category: "response_detail", value: "concise" },
      evidenceCount: 2,
    })).rejects.toThrow("consent changed");
    expect(runtime.registered).toHaveLength(0);
    expect(runtime.settlements).toHaveLength(0);
    expect(runtime.hermesFetch).toHaveBeenCalledTimes(2);
    expect(runtime.hermesFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\/toolsets$/),
      expect.anything(),
    );
    expect(runtime.hermesFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/toolsets$/),
      expect.anything(),
    );
  });

  it("cancels contended registration without leaving a phantom creating session", async () => {
    const runtime = await fixture();
    const advisor = await runtime.factory({ request: runtime.request, scope });
    runtime.blockRegistration();
    const controller = new AbortController();
    const pending = advisor.advise({
      recordId: `lesson:${"d".repeat(32)}`,
      revision: 1,
      version: 1,
      target: { category: "response_detail", value: "concise" },
      evidenceCount: 2,
    }, controller.signal);
    await vi.waitFor(() => {
      expect(runtime.retention.registerSession).toHaveBeenCalledOnce();
      const registration = runtime.retention.registerSession.mock.calls[0]![0];
      expect(registration.signal).toBeInstanceOf(AbortSignal);
    });

    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(runtime.registered).toHaveLength(0);
    expect(runtime.settlements).toHaveLength(0);
    expect(runtime.hermesFetch).toHaveBeenCalledTimes(2);
  });

  it("stays disabled when the explicitly owned retention sweeper is stopped", async () => {
    const runtime = await fixture();
    runtime.stopSweeper();
    const advisor = await runtime.factory({ request: runtime.request, scope });
    expect(advisor.enabled).toBe(false);
    expect(runtime.sweepRetention).not.toHaveBeenCalled();
    expect(runtime.assertImmutableProfile).not.toHaveBeenCalled();
    expect(runtime.hermesFetch).not.toHaveBeenCalled();
  });

  it("keeps the production environment factory disabled until launcher services are installed", async () => {
    const environment = {
      PILOT_HERMES_ENABLED: "1",
      PILOT_HERMES_ORIGIN: "http://127.0.0.1:8642",
      PILOT_HERMES_PROFILE: "pilot-proposal-v1",
      PILOT_HERMES_API_KEY: "hermes-profile-api-key-not-real",
      PILOT_HERMES_PROVIDER: "openrouter",
      PILOT_HERMES_MODEL: "example/read-only",
      PILOT_HERMES_RETENTION_DAYS: "7",
      PILOT_HERMES_TERMS_VERSION: "v1",
      PILOT_HERMES_CONSENT_SECRET: consentSecret,
      PILOT_HERMES_RETENTION_STATE_PATH: "/private/retention.json",
      PILOT_HERMES_DAILY_CALL_LIMIT: "3",
      PILOT_HERMES_PRIVATE_ROOT: "/private",
      PILOT_HERMES_MANIFEST_PATH: "/private/manifest.json",
      PILOT_HERMES_MANIFEST_SHA256: "a".repeat(64),
      PILOT_HERMES_PROFILE_CONFIG_PATH: "/private/profile.yaml",
      PILOT_HERMES_EGRESS_ORIGIN: "http://127.0.0.1:8644",
      PILOT_HERMES_PROFILE_PROVIDER: "pilot-egress-v1",
      PILOT_HERMES_PROFILE_MODEL: "proposal-lease-v1",
      PILOT_HERMES_BRIDGE_CONTROL_ORIGIN: "http://127.0.0.1:8650",
      PILOT_HERMES_BRIDGE_CONTROL_BEARER: "control-bearer-at-least-thirty-two-characters",
      PILOT_HERMES_BRIDGE_CONTROL_RESPONSE_KEY: "control-response-key-at-least-thirty-two-characters",
      PILOT_HERMES_PROFILE_INVARIANTS_SHA256: "b".repeat(64),
      PILOT_HERMES_BRIDGE_CONFIG_SHA256: "c".repeat(64),
    };
    const transport = vi.fn();
    const factory = createHermesRuntimeAdvisorFactoryFromEnvironment(
      environment,
      transport as typeof fetch,
    );
    const advisor = await factory({ request: new Request("http://127.0.0.1:3003/api/chat"), scope });
    expect(advisor.enabled).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it("accepts exactly one launcher-owned activation registration", () => {
    const services: HermesRuntimeActivationServices = {
      assertImmutableProfile: async () => undefined,
      retentionSweeper: {
        runOnce: async () => ({ scopes: 0, attempted: 0, databaseAbsent: 0, blocked: 0, exhausted: 0 }),
        status: () => ({
          phase: "ready",
          started: true,
          ready: true,
          inFlight: false,
          completedCycles: 1,
          attempted: 0,
          databaseAbsent: 0,
          blocked: 0,
        }),
      },
    };
    const dispose = installHermesRuntimeActivationServices(services);
    activationDisposers.push(dispose);
    expect(() => installHermesRuntimeActivationServices(services)).toThrow(
      "already installed",
    );
  });
});
