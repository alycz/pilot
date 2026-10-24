import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHermesProposalProvider,
  createRedactedProposalContext,
  deriveHermesProfileBinding,
  isHermesProviderBoundToLeaseAuthority,
  type HermesFetch,
  type HermesProposalConfig,
  type HermesProposalLeaseRequest,
  type HermesServerScope,
} from "../src/hermes-transport.js";

const API_KEY = "hermes-profile-key-not-a-real-credential";
const scope: HermesServerScope = {
  principalId: "principal-private-value",
  tenantId: "tenant-private-value",
  channelId: "channel-private-value",
};
const config: HermesProposalConfig = {
  enabled: true,
  origin: "http://127.0.0.1:8642",
  profile: "pilot-readonly",
  profileBinding: deriveHermesProfileBinding(scope),
  apiKey: API_KEY,
  model: "hermes-agent",
  timeoutMs: 1_000,
  maxResponseBytes: 16_384,
};
const request = {
  requestId: "request-1",
  purpose: "read" as const,
  prompt: "Summarize the supplied offline evidence.",
  context: createRedactedProposalContext({
    entries: [
      {
        kind: "redacted_text",
        field: "evidence_summary",
        value: "Two bounded offline observations",
      },
      { kind: "metric", field: "evidence_count", value: 2 },
    ],
  }),
};
const result = {
  kind: "read_only" as const,
  summary: "The evidence contains two bounded entries.",
  evidence: [],
  caveats: ["Fixture evidence only"],
};

type ToolsetsFixture = {
  object: string;
  platform: string;
  data: Array<{
    name: string;
    label: string;
    description: string;
    enabled: boolean;
    configured: boolean;
    tools: string[];
  }>;
};

const toolsetsFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hermes-v0.22.2-toolsets.json", import.meta.url),
    "utf8",
  ),
) as ToolsetsFixture;

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

function successfulFetch(calls: FetchCall[] = []): HermesFetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return url.endsWith("/toolsets")
      ? jsonResponse(toolsetsFixture)
      : jsonResponse({
          choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
        }, {
          headers: {
            "X-Hermes-Session-Id": headersOf(init).get("x-hermes-session-id") ?? "",
          },
        });
  }) as HermesFetch;
}

function fetchWithCompletion(completion: unknown): HermesFetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) =>
    String(input).endsWith("/toolsets")
      ? jsonResponse(toolsetsFixture)
      : jsonResponse(completion, {
          headers: {
            "X-Hermes-Session-Id": headersOf(init).get("x-hermes-session-id") ?? "",
          },
        })) as HermesFetch;
}

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function mockSessionLifecycle() {
  return {
    prepare: vi.fn(async (
      _session: { requestId: string; profile: string; sessionId: string },
      _signal: AbortSignal,
    ) => undefined),
    settle: vi.fn(async ({ outcome }: { outcome: "created" | "uncertain" }) =>
      outcome === "created" ? "active" as const : "uncertain" as const),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createHermesProposalProvider", () => {
  it("is default-off and performs no transport work", async () => {
    const transport = vi.fn();
    const provider = createHermesProposalProvider(
      { enabled: false },
      scope,
      transport as unknown as HermesFetch,
    );

    expect(provider.enabled).toBe(false);
    await expect(provider.propose(request)).rejects.toThrow("disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...config, origin: "http://example.com" }, "remote plaintext origin"],
    [{ ...config, origin: "https://example.com/path" }, "origin with path"],
    [{ ...config, origin: "https://user:pass@example.com" }, "origin credentials"],
    [{ ...config, profile: "default" }, "default profile"],
    [{ ...config, profile: "bad/profile" }, "invalid profile"],
    [{ ...config, apiKey: "short" }, "short key"],
    [{ ...config, apiKey: `${API_KEY}\nleak` }, "header injection"],
    [{ ...config, timeoutMs: 0 }, "invalid timeout"],
  ])("rejects %s configuration without exposing details", (candidate) => {
    expect(() =>
      createHermesProposalProvider(candidate as HermesProposalConfig, scope, successfulFetch()),
    ).toThrow("Invalid Hermes proposal adapter configuration");
  });

  it("uses only the fixed profile endpoint, exact restricted body, and opaque server scope", async () => {
    const calls: FetchCall[] = [];
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls));

    await expect(provider.propose(request)).resolves.toEqual(result);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8642/p/pilot-readonly/v1/toolsets",
      "http://127.0.0.1:8642/p/pilot-readonly/v1/chat/completions",
    ]);
    expect(calls.every(({ init }) => init.redirect === "error")).toBe(true);

    const toolHeaders = headersOf(calls[0]!.init);
    const chatHeaders = headersOf(calls[1]!.init);
    expect(toolHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(chatHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(toolHeaders.get("x-hermes-session-id")).toBeNull();
    expect(chatHeaders.get("x-hermes-session-id")).toMatch(/^pilot-[0-9a-f]{40}$/);
    expect(chatHeaders.get("idempotency-key")).toMatch(/^pilot-hermes:[0-9a-f]{64}$/);
    for (const privateValue of Object.values(scope)) {
      expect(JSON.stringify(calls)).not.toContain(privateValue);
    }

    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      model: "hermes-agent",
      messages: [
        {
          role: "system",
          content: expect.stringContaining("read-only proposal surface"),
        },
        {
          role: "user",
          content: JSON.stringify({
            purpose: request.purpose,
            prompt: request.prompt,
            context: request.context,
          }),
        },
      ],
      stream: false,
      tools: [],
      tool_choice: "none",
    });
    expect(calls[1]!.init).not.toHaveProperty("credentials");
  });

  it("binds an opaque one-call lease to the exact canonical payload before the model turn", async () => {
    const calls: FetchCall[] = [];
    const proof = Object.freeze({ gate: "bounded" });
    const issueLease = vi.fn(async (
      input: HermesProposalLeaseRequest,
      _signal: AbortSignal,
    ) => ({
      leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
      scopeDigest: input.scopeDigest,
      payloadDigest: input.payloadDigest,
      messageDigest: input.messageDigest,
      profile: input.profile,
      provider: input.provider,
      model: input.model,
    }));
    const sessionLifecycle = mockSessionLifecycle();
    const provider = createHermesProposalProvider(
      config,
      scope,
      successfulFetch(calls),
      {
        provider: "bounded-egress",
        leaseAuthority: { proof, issueLease },
        sessionLifecycle,
      },
    );

    await expect(provider.propose(request)).resolves.toEqual(result);
    expect(isHermesProviderBoundToLeaseAuthority(provider, proof)).toBe(true);
    expect(isHermesProviderBoundToLeaseAuthority(provider, {})).toBe(false);
    expect(issueLease).toHaveBeenCalledOnce();
    expect(sessionLifecycle.prepare).toHaveBeenCalledWith(
      {
        requestId: "request-1",
        profile: "pilot-readonly",
        sessionId: expect.stringMatching(/^pilot-[0-9a-f]{40}$/),
      },
      expect.any(AbortSignal),
    );
    expect(sessionLifecycle.settle).toHaveBeenCalledWith({
      requestId: "request-1",
      profile: "pilot-readonly",
      sessionId: expect.stringMatching(/^pilot-[0-9a-f]{40}$/),
      outcome: "created",
    });
    const [leaseRequest, signal] = issueLease.mock.calls[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(leaseRequest).toEqual({
      scopeDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      profile: "pilot-readonly",
      profileBinding: config.profileBinding,
      provider: "bounded-egress",
      model: "hermes-agent",
      requestId: "request-1",
      sessionId: expect.stringMatching(/^pilot-[0-9a-f]{40}$/),
      userContent: JSON.stringify({
        purpose: request.purpose,
        prompt: request.prompt,
        context: request.context,
      }),
      messageDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.isFrozen(leaseRequest)).toBe(true);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      model: `pilot-hermes-lease-${"A".repeat(43)}`,
      stream: false,
      tools: [],
      tool_choice: "none",
    });

    const changed = createHermesProposalProvider(
      config,
      scope,
      successfulFetch(),
      {
        provider: "bounded-egress",
        leaseAuthority: { proof, issueLease },
        sessionLifecycle,
      },
    );
    await changed.propose({ ...request, prompt: `${request.prompt} Changed.` });
    expect(issueLease.mock.calls[1]![0].payloadDigest).not.toBe(
      leaseRequest.payloadDigest,
    );
  });

  it("fails closed before the model turn for a missing, malformed, or failing lease", async () => {
    for (const issueLease of [
      vi.fn(async (input: HermesProposalLeaseRequest) => ({
        leaseModel: config.model,
        scopeDigest: input.scopeDigest,
        payloadDigest: input.payloadDigest,
        messageDigest: input.messageDigest,
        profile: input.profile,
        provider: input.provider,
        model: input.model,
      })),
      vi.fn(async (input: HermesProposalLeaseRequest) => ({
        leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
        scopeDigest: input.scopeDigest,
        payloadDigest: input.payloadDigest,
        messageDigest: "0".repeat(64),
        profile: input.profile,
        provider: input.provider,
        model: input.model,
      })),
      vi.fn(async () => { throw new Error("bridge credential leaked"); }),
    ]) {
      const calls: FetchCall[] = [];
      const provider = createHermesProposalProvider(
        config,
        scope,
        successfulFetch(calls),
        { leaseAuthority: { proof: {}, issueLease }, sessionLifecycle: mockSessionLifecycle() },
      );
      await expect(provider.propose(request)).rejects.toThrow(
        "bounded lease authorization failed",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toMatch(/\/toolsets$/);
    }
  });

  it("cancels a pending lease authorization with the caller signal", async () => {
    const controller = new AbortController();
    const issueLease = vi.fn((_input, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }));
    const provider = createHermesProposalProvider(config, scope, successfulFetch(), {
      leaseAuthority: { proof: {}, issueLease },
      sessionLifecycle: mockSessionLifecycle(),
    });
    const pending = provider.propose(request, { signal: controller.signal });
    await vi.waitFor(() => expect(issueLease).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("never starts the Hermes POST when durable session preparation fails", async () => {
    const calls: FetchCall[] = [];
    const sessionLifecycle = {
      prepare: vi.fn(async () => { throw new Error("consent epoch changed"); }),
      settle: vi.fn(async () => "uncertain" as const),
    };
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls), {
      leaseAuthority: {
        proof: {},
        async issueLease(input) {
          return {
            leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
            scopeDigest: input.scopeDigest,
            payloadDigest: input.payloadDigest,
            messageDigest: input.messageDigest,
            profile: input.profile,
            provider: input.provider,
            model: input.model,
          };
        },
      },
      sessionLifecycle,
    });

    await expect(provider.propose(request)).rejects.toThrow("session preparation failed");
    expect(sessionLifecycle.prepare).toHaveBeenCalledOnce();
    expect(sessionLifecycle.settle).not.toHaveBeenCalled();
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8642/p/pilot-readonly/v1/toolsets",
    ]);
  });

  it("cancels session preparation before POST without using the aborted signal for settlement", async () => {
    const controller = new AbortController();
    const calls: FetchCall[] = [];
    const prepareStarted = vi.fn();
    const sessionLifecycle = {
      prepare: vi.fn((_session, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          prepareStarted();
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        })),
      settle: vi.fn(async () => "uncertain" as const),
    };
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls), {
      leaseAuthority: {
        proof: {},
        async issueLease(input) {
          return {
            leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
            scopeDigest: input.scopeDigest,
            payloadDigest: input.payloadDigest,
            messageDigest: input.messageDigest,
            profile: input.profile,
            provider: input.provider,
            model: input.model,
          };
        },
      },
      sessionLifecycle,
    });

    const pending = provider.propose(request, { signal: controller.signal });
    await vi.waitFor(() => expect(prepareStarted).toHaveBeenCalledOnce());
    const preparationSignal = sessionLifecycle.prepare.mock.calls[0]![1];
    expect(preparationSignal).toBeInstanceOf(AbortSignal);
    expect(preparationSignal.aborted).toBe(false);
    controller.abort();

    await expect(pending).rejects.toThrow("cancelled");
    expect(preparationSignal.aborted).toBe(true);
    expect(sessionLifecycle.prepare).toHaveBeenCalledOnce();
    expect(sessionLifecycle.settle).not.toHaveBeenCalled();
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8642/p/pilot-readonly/v1/toolsets",
    ]);
  });

  it("settles a cancelled in-flight Hermes POST as uncertain exactly once", async () => {
    const controller = new AbortController();
    const sessionLifecycle = mockSessionLifecycle();
    let prepared = false;
    sessionLifecycle.prepare.mockImplementation(async (_session, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      prepared = true;
    });
    const chatStarted = vi.fn();
    const transport = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).endsWith("/toolsets")) return jsonResponse(toolsetsFixture);
      expect(prepared).toBe(true);
      chatStarted();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }) as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport, {
      leaseAuthority: {
        proof: {},
        async issueLease(input) {
          return {
            leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
            scopeDigest: input.scopeDigest,
            payloadDigest: input.payloadDigest,
            messageDigest: input.messageDigest,
            profile: input.profile,
            provider: input.provider,
            model: input.model,
          };
        },
      },
      sessionLifecycle,
    });

    const pending = provider.propose(request, { signal: controller.signal });
    await vi.waitFor(() => expect(chatStarted).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(sessionLifecycle.prepare).toHaveBeenCalledOnce();
    expect(sessionLifecycle.settle).toHaveBeenCalledOnce();
    expect(sessionLifecycle.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "uncertain",
    }));
    expect(sessionLifecycle.settle.mock.calls[0]).toHaveLength(1);
  });

  it("durably registers the fresh session before the call and requires its exact echo", async () => {
    const proof = {};
    const sessionLifecycle = mockSessionLifecycle();
    const issueLease = async (input: HermesProposalLeaseRequest) => ({
      leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
      scopeDigest: input.scopeDigest,
      payloadDigest: input.payloadDigest,
      messageDigest: input.messageDigest,
      profile: input.profile,
      provider: input.provider,
      model: input.model,
    });
    const wrongEcho = (async (input: string | URL | Request) =>
      String(input).endsWith("/toolsets")
        ? jsonResponse(toolsetsFixture)
        : jsonResponse({
            choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
          }, { headers: { "X-Hermes-Session-Id": "pilot-wrong-session" } })) as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, wrongEcho, {
      leaseAuthority: { proof, issueLease },
      sessionLifecycle,
    });
    await expect(provider.propose(request)).rejects.toThrow("session identity");
    expect(sessionLifecycle.prepare).toHaveBeenCalledOnce();
    expect(sessionLifecycle.settle).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "uncertain",
    }));

    const invalidProposal = (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => String(input).endsWith("/toolsets")
      ? jsonResponse(toolsetsFixture)
      : jsonResponse({
          choices: [{ message: { content: "not-json" }, finish_reason: "stop" }],
        }, {
          headers: {
            "X-Hermes-Session-Id": headersOf(init).get("x-hermes-session-id") ?? "",
          },
        })) as HermesFetch;
    const invalid = createHermesProposalProvider(config, scope, invalidProposal, {
      leaseAuthority: { proof, issueLease },
      sessionLifecycle,
    });
    await expect(invalid.propose(request)).rejects.toThrow("exact JSON");
    expect(sessionLifecycle.prepare).toHaveBeenCalledTimes(2);
    expect(sessionLifecycle.settle).toHaveBeenCalledTimes(2);
    expect(sessionLifecycle.settle).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "uncertain",
    }));
  });

  it("never returns an advisory when created settlement is not durably active", async () => {
    const issueLease = async (input: HermesProposalLeaseRequest) => ({
      leaseModel: `pilot-hermes-lease-${"A".repeat(43)}`,
      scopeDigest: input.scopeDigest,
      payloadDigest: input.payloadDigest,
      messageDigest: input.messageDigest,
      profile: input.profile,
      provider: input.provider,
      model: input.model,
    });
    const sessionLifecycle = {
      prepare: vi.fn(async () => undefined),
      settle: vi.fn(async () => "pending_delete" as const),
    };
    const provider = createHermesProposalProvider(config, scope, successfulFetch(), {
      leaseAuthority: { proof: {}, issueLease },
      sessionLifecycle,
    });

    await expect(provider.propose(request)).rejects.toThrow("session settlement failed");
    expect(sessionLifecycle.settle).toHaveBeenCalledOnce();
    expect(sessionLifecycle.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "created",
    }));
  });

  it("accepts the pinned v0.22.2 all-disabled toolset envelope", async () => {
    expect(toolsetsFixture).toMatchObject({ object: "list", platform: "api_server" });
    expect(toolsetsFixture.data).toHaveLength(27);
    expect(toolsetsFixture.data.every(({ enabled }) => enabled === false)).toBe(true);
    expect(toolsetsFixture.data.some(({ tools }) => tools.length > 0)).toBe(true);

    const calls: FetchCall[] = [];
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls));
    await expect(provider.propose(request)).resolves.toEqual(result);
    expect(calls).toHaveLength(2);
  });

  it("reports only a frozen aggregate after full proposal validation", async () => {
    const onUsage = vi.fn();
    const provider = createHermesProposalProvider(
      config,
      scope,
      fetchWithCompletion({
        choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 41, completion_tokens: 17, total_tokens: 58 },
      }),
      { provider: "bounded-egress", onUsage },
    );

    await expect(provider.propose(request)).resolves.toEqual(result);
    expect(onUsage).toHaveBeenCalledOnce();
    const aggregate = onUsage.mock.calls[0]![0];
    expect(aggregate).toEqual({
      requestId: "request-1",
      profile: "pilot-readonly",
      provider: "bounded-egress",
      model: "hermes-agent",
      promptTokens: 41,
      completionTokens: 17,
      totalTokens: 58,
    });
    expect(Object.isFrozen(aggregate)).toBe(true);
    expect(JSON.stringify(aggregate)).not.toContain(scope.principalId);
    expect(JSON.stringify(aggregate)).not.toContain(request.prompt);
    expect(JSON.stringify(aggregate)).not.toContain(API_KEY);
  });

  it("allows a valid completion without usage for backward compatibility", async () => {
    const onUsage = vi.fn();
    const provider = createHermesProposalProvider(config, scope, successfulFetch(), {
      provider: "bounded-egress",
      onUsage,
    });

    await expect(provider.propose(request)).resolves.toEqual(result);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["negative", { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }],
    ["fractional", { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 }],
    ["excessive", { prompt_tokens: 1_000_001, completion_tokens: 0, total_tokens: 1_000_001 }],
    ["inconsistent", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 14 }],
    ["unknown field", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 1 }],
    ["missing field", { prompt_tokens: 10, total_tokens: 10 }],
  ])("rejects %s completion usage without notifying the observer", async (_label, usage) => {
    const onUsage = vi.fn();
    const provider = createHermesProposalProvider(
      config,
      scope,
      fetchWithCompletion({
        choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
        usage,
      }),
      { provider: "bounded-egress", onUsage },
    );

    await expect(provider.propose(request)).rejects.toThrow("invalid completion");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not report usage for a schema-valid completion with unsafe proposal content", async () => {
    const onUsage = vi.fn();
    const provider = createHermesProposalProvider(
      config,
      scope,
      fetchWithCompletion({
        choices: [
          {
            message: {
              content: JSON.stringify({ ...result, summary: "API key: unsafe-value" }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { provider: "bounded-egress", onUsage },
    );

    await expect(provider.propose(request)).rejects.toThrow("unsafe proposal text");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("fails closed if aggregate usage monitoring fails without exposing observer errors", async () => {
    const provider = createHermesProposalProvider(
      config,
      scope,
      fetchWithCompletion({
        choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      {
        provider: "bounded-egress",
        onUsage: async () => {
          throw new Error(`observer exposed ${API_KEY}`);
        },
      },
    );

    await expect(provider.propose(request)).rejects.toThrow("Hermes usage observer failed");
    await expect(provider.propose(request)).rejects.not.toThrow(API_KEY);
  });

  it("rejects an invalid trusted provider identifier at construction", () => {
    expect(() =>
      createHermesProposalProvider(config, scope, successfulFetch(), {
        provider: "bad/provider",
        onUsage: vi.fn(),
      }),
    ).toThrow("Invalid Hermes proposal adapter configuration");
  });

  it("rejects a profile binding mismatch and missing channel before transport", async () => {
    const transport = vi.fn();
    expect(() =>
      createHermesProposalProvider(
        { ...config, profileBinding: "a".repeat(64) },
        scope,
        transport as unknown as HermesFetch,
      ),
    ).toThrow("profile binding does not match server authority");
    expect(() =>
      createHermesProposalProvider(
        config,
        { principalId: scope.principalId, tenantId: scope.tenantId } as HermesServerScope,
        transport as unknown as HermesFetch,
      ),
    ).toThrow("Invalid server-derived Hermes scope");
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses a fresh non-reused session while binding idempotency to scope and payload", async () => {
    const firstCalls: FetchCall[] = [];
    const secondCalls: FetchCall[] = [];
    const first = createHermesProposalProvider(config, scope, successfulFetch(firstCalls));
    const secondScope = { ...scope, tenantId: "other-private-tenant" };
    const second = createHermesProposalProvider(
      { ...config, profileBinding: deriveHermesProfileBinding(secondScope) },
      secondScope,
      successfulFetch(secondCalls),
    );
    await first.propose(request);
    await first.propose(request);
    await second.propose(request);

    const firstHeaders = headersOf(firstCalls[1]!.init);
    const repeatedHeaders = headersOf(firstCalls[3]!.init);
    const secondHeaders = headersOf(secondCalls[1]!.init);
    expect(firstHeaders.get("x-hermes-session-id")).not.toBe(
      repeatedHeaders.get("x-hermes-session-id"),
    );
    expect(firstHeaders.get("x-hermes-session-id")).not.toBe(
      secondHeaders.get("x-hermes-session-id"),
    );
    expect(firstHeaders.get("idempotency-key")).toBe(
      repeatedHeaders.get("idempotency-key"),
    );
    expect(firstHeaders.get("idempotency-key")).not.toBe(
      secondHeaders.get("idempotency-key"),
    );
  });

  it.each([
    ["with listed tools", { ...toolsetsFixture.data[0], enabled: true }],
    ["with an empty tool list", { ...toolsetsFixture.data[0], enabled: true, tools: [] }],
  ])("fails closed on an enabled toolset %s before creating a model turn", async (_name, activeRow) => {
    const calls: FetchCall[] = [];
    const transport = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ ...toolsetsFixture, data: [activeRow] });
    }) as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);

    await expect(provider.propose(request)).rejects.toThrow("tool attestation failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/toolsets$/);
  });

  it.each([
    ["bare array", toolsetsFixture.data],
    ["wrong object kind", { ...toolsetsFixture, object: "collection" }],
    ["wrong platform", { ...toolsetsFixture, platform: "cli" }],
    ["missing data", { object: "list", platform: "api_server" }],
    ["empty data", { ...toolsetsFixture, data: [] }],
    ["unknown envelope field", { ...toolsetsFixture, risk: "unknown" }],
    [
      "unknown row field",
      {
        ...toolsetsFixture,
        data: [{ ...toolsetsFixture.data[0], active: false }],
      },
    ],
    [
      "non-boolean enabled field",
      {
        ...toolsetsFixture,
        data: [{ ...toolsetsFixture.data[0], enabled: "false" }],
      },
    ],
    [
      "duplicate toolset names",
      {
        ...toolsetsFixture,
        data: [toolsetsFixture.data[0], toolsetsFixture.data[0]],
      },
    ],
    [
      "duplicate tool metadata",
      {
        ...toolsetsFixture,
        data: [
          {
            ...toolsetsFixture.data[0],
            tools: [toolsetsFixture.data[0]!.tools[0], toolsetsFixture.data[0]!.tools[0]],
          },
        ],
      },
    ],
  ])("rejects %s tool attestation before creating a model turn", async (_name, payload) => {
    const transport = vi.fn(async () => jsonResponse(payload)) as unknown as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);

    await expect(provider.propose(request)).rejects.toThrow("tool attestation failed");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed tool attestation", () => new Response("not-json")],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "/other" } })],
    [
      "declared oversized response",
      () => new Response("[]", { headers: { "Content-Length": "16385" } }),
    ],
  ])("rejects a %s before creating a model turn", async (_name, response) => {
    const transport = vi.fn(async () => response()) as unknown as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);
    await expect(provider.propose(request)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects streamed bytes beyond the bound", async () => {
    const encoder = new TextEncoder();
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(" ".repeat(16_385)));
        controller.close();
      },
    });
    const transport = vi.fn(async () => new Response(oversized)) as unknown as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);
    await expect(provider.propose(request)).rejects.toThrow("byte limit");
  });

  it.each([
    [{ ...request, context: { privateKey: "value" } }, "credential-bearing context"],
    [{ ...request, context: { nested: { authorization: "value" } } }, "nested credential"],
    [{ ...request, prompt: "seed: shABCDEF23456789ABCDEFGHJKLMNP" }, "secret prompt"],
    [{ ...request, context: { huge: "x".repeat(17_000) } }, "oversized context"],
    [{ ...request, unexpected: true }, "unknown request field"],
  ])("rejects %s before transport", async (candidate, label) => {
    const transport = vi.fn();
    const provider = createHermesProposalProvider(
      config,
      scope,
      transport as unknown as HermesFetch,
    );
    await expect(provider.propose(candidate as typeof request)).rejects.toThrow(
      label === "credential-bearing context" ||
        label === "nested credential" ||
        label === "oversized context"
        ? "Hermes proposal context must be explicitly redacted"
        : "Invalid Hermes proposal request",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON content", "This is not JSON"],
    ["wrong purpose", JSON.stringify({ ...result, kind: "read_only" })],
    ["execution field", JSON.stringify({ ...result, execute: { command: "rm" } })],
    ["credential-bearing output", JSON.stringify({ ...result, summary: "seed: shABCDEF23456789ABCDEFGHJKLMNP" })],
    [
      "incomplete procedure invariants",
      JSON.stringify({
        kind: "procedure_proposal",
        procedure: {
          id: "candidate",
          version: "1.0.0",
          title: "Incomplete",
          description: "Missing required invariants",
          steps: [{ id: "one", operation: "read_context", description: "Read fixture" }],
          invariants: ["no_network", "no_execution"],
        },
        rationale: "Bad",
        risks: [],
      }),
    ],
    [
      "duplicate procedure invariants",
      JSON.stringify({
        kind: "procedure_proposal",
        procedure: {
          id: "candidate",
          version: "1.0.0",
          title: "Duplicate",
          description: "Duplicates one invariant and omits another",
          steps: [{ id: "one", operation: "read_context", description: "Read fixture" }],
          invariants: [
            "no_network",
            "no_execution",
            "no_runtime_rewrite",
            "no_policy_change",
            "no_automatic_promotion",
            "no_automatic_promotion",
          ],
        },
        rationale: "Bad",
        risks: [],
      }),
    ],
    [
      "unsafe procedure operation",
      JSON.stringify({
        kind: "procedure_proposal",
        procedure: {
          id: "candidate",
          version: "1.0.0",
          title: "Unsafe",
          description: "Unsafe candidate",
          steps: [{ id: "one", operation: "shell_exec", description: "Run it" }],
          invariants: ["no_execution"],
        },
        rationale: "Bad",
        risks: [],
      }),
    ],
  ])("rejects %s output", async (label, content) => {
    const purpose =
      label === "unsafe procedure operation" ||
      label === "incomplete procedure invariants" ||
      label === "duplicate procedure invariants" ||
      label === "wrong purpose"
        ? "procedure_proposal"
        : "read";
    const transport = (async (input: string | URL | Request) =>
      String(input).endsWith("/toolsets")
        ? jsonResponse(toolsetsFixture)
        : jsonResponse({ choices: [{ message: { content }, finish_reason: "stop" }] })) as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);
    await expect(provider.propose({ ...request, purpose })).rejects.toThrow();
  });

  it("honors caller cancellation", async () => {
    const controller = new AbortController();
    const transport = (async (_input: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);
    const pending = provider.propose(request, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("enforces a request deadline", async () => {
    vi.useFakeTimers();
    const transport = (async (_input: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as HermesFetch;
    const provider = createHermesProposalProvider(
      { ...config, timeoutMs: 100 },
      scope,
      transport,
    );
    const pending = provider.propose(request);
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("sanitizes transport errors without exposing credentials", async () => {
    const transport = vi.fn(async () => {
      throw new Error(`upstream included ${API_KEY}`);
    }) as unknown as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);

    let message = "";
    try {
      await provider.propose(request);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Hermes transport failed");
    expect(message).not.toContain(API_KEY);
  });

  it("sanitizes response reader errors without exposing upstream text", async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error(`reader leaked ${API_KEY}`);
          },
        }),
      },
    } as unknown as Response)) as unknown as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);

    let message = "";
    try {
      await provider.propose(request);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Hermes response body read failed");
    expect(message).not.toContain(API_KEY);
  });
});
