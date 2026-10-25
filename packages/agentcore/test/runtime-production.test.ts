import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_PROTOCOL_VERSION,
  deriveAgentCoreGatewayBindingDigest,
  deriveAgentCoreRequestDigest,
  deriveAgentCoreScopeDigest,
} from "../src/contracts";
import type { AgentCoreWorkloadJwtResolver } from "../src/jwt";
import type { AgentCoreTokenRevocationChecker } from "../src/jwt";
import {
  AgentCoreReplayError,
  createInMemoryAgentCoreReplayStore,
  type AgentCoreReplayStore,
  type AgentCoreRuntimeResponse,
} from "../src/replay";
import { createAgentCoreProductionRuntimeInvoker } from "../src/runtime-production";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ISSUER = "https://identity.example.test/oauth2/default";
const JWKS = "https://identity.example.test/.well-known/jwks.json";
const AUDIENCE = "pilot-agentcore-gateway";
const SUBJECT = "pilot-runtime-workload";
const DEPLOYMENT_TENANT = "pilot-runtime-deployment";
const CLIENT = "pilot-runtime-client";
const SCOPE = "gateway:invoke";
const gatewayUrl = "https://pilotgateway-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";
const gatewayToolName = "PilotReadTarget___pilot.read_market_context";
const scope = {
  tenantId: "wallet-tenant",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
  invocationNonce: "nonce-123456789",
};
const request = {
  requestId: "research-1",
  purpose: "read" as const,
  prompt: "Read public market context",
  context: { pair: "XRP/RLUSD" },
};
const gatewayBindingDigest = deriveAgentCoreGatewayBindingDigest({
  gatewayUrl,
  gatewayToolName,
  gatewayProtocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
  gatewayAuthMode: "custom_jwt",
});
const scopeDigest = deriveAgentCoreScopeDigest(scope);
const requestDigest = deriveAgentCoreRequestDigest({ request, scopeDigest, gatewayBindingDigest });
const invocation = {
  protocolVersion: AGENTCORE_PROTOCOL_VERSION,
  request,
  scope,
  allowedTools: [gatewayToolName] as const,
  gatewayBindingDigest,
  requestDigest,
};
const config = {
  gatewayUrl,
  gatewayToolName,
  jwtDeploymentTenantId: DEPLOYMENT_TENANT,
  replayDeploymentId: "pilot-runtime-v1",
  replayLeaseMs: 30_000,
  replayRetentionMs: 86_400_000,
  jwtPolicy: {
    issuer: ISSUER,
    jwksUrl: JWKS,
    audiences: [AUDIENCE],
    allowedSubjects: [SUBJECT],
    allowedClients: [CLIENT],
    requiredScopes: [SCOPE],
    clientClaim: "client_id" as const,
    tenantClaim: "tenant_id",
    algorithms: ["RS256" as const],
    clockToleranceSeconds: 0,
  },
};

function authFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk: JsonWebKey = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "key-a", alg: "RS256", use: "sig", key_ops: ["verify"],
  };
  const seconds = Math.floor(NOW / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-a", typ: "at+jwt" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER, sub: SUBJECT, aud: AUDIENCE, iat: seconds - 5, nbf: seconds - 5,
    exp: seconds + 120, jti: "gateway-token-1", tenant_id: DEPLOYMENT_TENANT,
    client_id: CLIENT, scope: SCOPE,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "ascii"), pair.privateKey).toString("base64url");
  const authorization = `Bearer ${header}.${payload}.${signature}`;
  return {
    resolveAuthorization: vi.fn<AgentCoreWorkloadJwtResolver["resolveAuthorization"]>(async () => authorization),
    jwksFetch: vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      headers: { "content-type": "application/jwk-set+json" },
    })) as typeof fetch,
  };
}

function gatewayFixture(input: Readonly<{
  wait?: Promise<void>;
  fail?: boolean;
  afterTool?: () => void;
}> = {}) {
  let dispatches = 0;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (call.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: call.id,
        result: {
          protocolVersion: AGENTCORE_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" },
        },
      }), { headers: { "content-type": "application/json", "mcp-session-id": "session-abcdefghijklmnop" } });
    }
    if (call.method === "notifications/initialized" || call.method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    if (call.method !== "tools/call") throw new Error("unexpected fixture call");
    dispatches += 1;
    await input.wait;
    if (input.fail) throw new Error("fixture Gateway failure");
    input.afterTool?.();
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: call.id,
      result: {
        content: [{ type: "text", text: "fixture" }],
        structuredContent: { summary: "Bounded market fixture", evidence: [], caveats: [] },
        isError: false,
      },
    }), { headers: { "content-type": "application/json" } });
  });
  return { fetcher: fetcher as typeof fetch, dispatches: () => dispatches };
}

function runtime(store: AgentCoreReplayStore, gatewayFetch: typeof fetch, auth = authFixture()) {
  return {
    auth,
    invoker: createAgentCoreProductionRuntimeInvoker({
      config,
      workloadJwtResolver: { resolveAuthorization: auth.resolveAuthorization },
      replayStore: store,
      jwksFetch: auth.jwksFetch,
      gatewayFetch,
      now: () => NOW,
    }),
  };
}

const context = (signal = new AbortController().signal) => ({
  signal,
  workloadAccessToken: "opaque-platform-workload-token",
});

function response(overrides: Partial<AgentCoreRuntimeResponse> = {}): AgentCoreRuntimeResponse {
  return {
    protocolVersion: AGENTCORE_PROTOCOL_VERSION,
    transport: "aws-agentcore-runtime",
    dataProvenance: "external-unverified",
    requestId: request.requestId,
    scopeDigest,
    gatewayBindingDigest,
    requestDigest,
    result: { kind: "read_only", summary: "Cached fixture", evidence: [], caveats: [] },
    ...overrides,
  };
}

describe("AgentCore production replay boundary", () => {
  it("authenticates the platform token before any replay lookup", async () => {
    const resolveAuthorization = vi.fn<AgentCoreWorkloadJwtResolver["resolveAuthorization"]>(async () => {
      throw new Error("fixture stops before replay");
    });
    const store = {
      claim: vi.fn(), markDispatched: vi.fn(), complete: vi.fn(), releaseClaim: vi.fn(),
    } as unknown as AgentCoreReplayStore;
    const value = createAgentCoreProductionRuntimeInvoker({
      config,
      workloadJwtResolver: { resolveAuthorization },
      replayStore: store,
      gatewayFetch: vi.fn() as typeof fetch,
      now: () => NOW,
    });
    await expect(value.invoke(invocation, context())).rejects.toThrow("authorization");
    expect(store.claim).not.toHaveBeenCalled();
    expect(resolveAuthorization).toHaveBeenCalledWith({
      tenantId: DEPLOYMENT_TENANT,
      audiences: [AUDIENCE],
      requiredScopes: [SCOPE],
      workloadIdentityToken: "opaque-platform-workload-token",
    }, { signal: expect.any(AbortSignal) });
  });

  it("returns one completed response while reauthenticating every replay", async () => {
    const backing = createInMemoryAgentCoreReplayStore({
      nextLeaseId: () => "00000000-0000-4000-8000-000000000001",
    });
    const claim = vi.fn(backing.claim);
    const gateway = gatewayFixture();
    const value = runtime({ ...backing, claim }, gateway.fetcher);
    const first = await value.invoker.invoke(invocation, context()) as AgentCoreRuntimeResponse;
    const second = await value.invoker.invoke(invocation, context()) as AgentCoreRuntimeResponse;
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(gateway.dispatches()).toBe(1);
    expect(value.auth.resolveAuthorization).toHaveBeenCalledTimes(2);
    expect(Object.keys(claim.mock.calls[0]![0]).sort()).toEqual([
      "bindingDigest", "leaseMs", "namespaceDigest", "nowMs", "requestDigest",
      "retentionMs", "signal",
    ]);
    expect(JSON.stringify(claim.mock.calls)).not.toContain(request.prompt);
    expect(JSON.stringify(claim.mock.calls)).not.toContain(scope.owner);
    expect(JSON.stringify(claim.mock.calls)).not.toContain(scope.tenantId);
  });

  it("checks per-token revocation before returning a completed replay", async () => {
    const backing = createInMemoryAgentCoreReplayStore({
      nextLeaseId: () => "00000000-0000-4000-8000-000000000009",
    });
    const claim = vi.fn(backing.claim);
    const gateway = gatewayFixture();
    const auth = authFixture();
    const revocationChecker = vi.fn<AgentCoreTokenRevocationChecker>(async () => "active");
    const invoker = createAgentCoreProductionRuntimeInvoker({
      config: {
        ...config,
        jwtPolicy: {
          ...config.jwtPolicy,
          revocation: { mode: "checker" as const, timeoutMs: 1_000 },
        },
      },
      workloadJwtResolver: { resolveAuthorization: auth.resolveAuthorization },
      replayStore: { ...backing, claim },
      jwksFetch: auth.jwksFetch,
      gatewayFetch: gateway.fetcher,
      now: () => NOW,
      jwtRevocationChecker: revocationChecker,
    });
    await expect(invoker.invoke(invocation, context())).resolves.toMatchObject({ requestDigest });
    revocationChecker.mockResolvedValueOnce("revoked");
    await expect(invoker.invoke(invocation, context())).rejects.toThrow("authorization");
    expect(revocationChecker).toHaveBeenCalledTimes(2);
    expect(gateway.dispatches()).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("fences a concurrent duplicate and never redispatches after failure", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const concurrentStore = createInMemoryAgentCoreReplayStore({
      nextLeaseId: () => "00000000-0000-4000-8000-000000000002",
    });
    const waitingGateway = gatewayFixture({ wait });
    const concurrent = runtime(concurrentStore, waitingGateway.fetcher).invoker;
    const first = concurrent.invoke(invocation, context());
    await vi.waitFor(() => expect(waitingGateway.dispatches()).toBe(1));
    await expect(concurrent.invoke(invocation, context())).rejects.toMatchObject({ code: "uncertain" });
    expect(waitingGateway.dispatches()).toBe(1);
    release();
    await expect(first).resolves.toMatchObject({ requestDigest });

    const failedStore = createInMemoryAgentCoreReplayStore({
      nextLeaseId: () => "00000000-0000-4000-8000-000000000003",
    });
    const failedGateway = gatewayFixture({ fail: true });
    const failed = runtime(failedStore, failedGateway.fetcher).invoker;
    await expect(failed.invoke(invocation, context())).rejects.toThrow("transport failed");
    await expect(failed.invoke(invocation, context())).rejects.toMatchObject({ code: "uncertain" });
    expect(failedGateway.dispatches()).toBe(1);

    const completionBacking = createInMemoryAgentCoreReplayStore({
      nextLeaseId: () => "00000000-0000-4000-8000-000000000006",
    });
    const completionStore: AgentCoreReplayStore = {
      ...completionBacking,
      async complete() { throw new AgentCoreReplayError("uncertain"); },
    };
    const completedGateway = gatewayFixture();
    const failedCompletion = runtime(completionStore, completedGateway.fetcher).invoker;
    await expect(failedCompletion.invoke(invocation, context())).rejects.toMatchObject({ code: "uncertain" });
    await expect(failedCompletion.invoke(invocation, context())).rejects.toMatchObject({ code: "uncertain" });
    expect(completedGateway.dispatches()).toBe(1);
  });

  it("does not dispatch after a mark fault and rejects poisoned completed data", async () => {
    const markDispatched = vi.fn(async () => { throw new AgentCoreReplayError("fenced"); });
    const markStore: AgentCoreReplayStore = {
      async claim() {
        return {
          status: "claimed", leaseId: "00000000-0000-4000-8000-000000000004",
          fence: 1, leaseUntil: NOW + 30_000,
        };
      },
      markDispatched, complete: vi.fn(), releaseClaim: vi.fn(),
    };
    const gateway = gatewayFixture();
    await expect(runtime(markStore, gateway.fetcher).invoker.invoke(invocation, context()))
      .rejects.toMatchObject({ code: "fenced" });
    expect(gateway.dispatches()).toBe(0);

    const poisoned: AgentCoreReplayStore = {
      async claim() {
        return { status: "completed", response: response({ requestDigest: "0".repeat(64) }) };
      },
      markDispatched: vi.fn(), complete: vi.fn(), releaseClaim: vi.fn(),
    };
    const checked = runtime(poisoned, gateway.fetcher);
    await expect(checked.invoker.invoke(invocation, context())).rejects.toMatchObject({ code: "binding" });
    expect(checked.auth.resolveAuthorization).toHaveBeenCalledOnce();
    expect(gateway.dispatches()).toBe(0);
  });

  it("uses an independent bounded signal to release a pre-dispatch abort", async () => {
    const controller = new AbortController();
    const releaseClaim = vi.fn<AgentCoreReplayStore["releaseClaim"]>(async (input) => {
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.signal).not.toBe(controller.signal);
      expect(input.signal?.aborted).toBe(false);
    });
    const store: AgentCoreReplayStore = {
      async claim() {
        controller.abort(new Error("aborted after claim"));
        return {
          status: "claimed", leaseId: "00000000-0000-4000-8000-000000000005",
          fence: 1, leaseUntil: NOW + 30_000,
        };
      },
      markDispatched: vi.fn(), complete: vi.fn(), releaseClaim,
    };
    const gateway = gatewayFixture();
    await expect(runtime(store, gateway.fetcher).invoker.invoke(invocation, context(controller.signal)))
      .rejects.toThrow("aborted after claim");
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(store.markDispatched).not.toHaveBeenCalled();
    expect(gateway.dispatches()).toBe(0);
  });

  it("persists completion with an independent signal after external success", async () => {
    const controller = new AbortController();
    const backing = createInMemoryAgentCoreReplayStore({
      nextLeaseId: () => "00000000-0000-4000-8000-000000000007",
    });
    const complete = vi.fn<AgentCoreReplayStore["complete"]>(async (input) => {
      controller.abort(new Error("caller left after external success"));
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.signal).not.toBe(controller.signal);
      expect(input.signal?.aborted).toBe(false);
      await backing.complete(input);
    });
    const store: AgentCoreReplayStore = { ...backing, complete };
    const gateway = gatewayFixture();
    const value = runtime(store, gateway.fetcher).invoker;
    await expect(value.invoke(invocation, context(controller.signal)))
      .resolves.toMatchObject({ requestDigest });
    await expect(value.invoke(invocation, context())).resolves.toMatchObject({ requestDigest });
    expect(complete).toHaveBeenCalledOnce();
    expect(gateway.dispatches()).toBe(1);
  });
});
