import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createHermesEgressGate,
  digestHermesEgressMessages,
  HermesEgressGateError,
  type HermesEgressGateConfig,
  type HermesEgressMessage,
} from "./hermes-egress-gate";

const INGRESS_BEARER = "ingress-bearer-that-is-longer-than-thirty-two-chars";
const UPSTREAM_CREDENTIAL = "provider-credential-private-value";
const SCOPE = createHash("sha256").update("scope").digest("hex");
const OTHER_SCOPE = createHash("sha256").update("other-scope").digest("hex");
const MESSAGES: HermesEgressMessage[] = [
  { role: "system", content: "Return one bounded proposal." },
  { role: "user", content: "Explain the already-selected concise lesson." },
];
const REQUEST_DIGEST = digestHermesEgressMessages(MESSAGES);

function config(
  overrides: Partial<HermesEgressGateConfig> = {},
): HermesEgressGateConfig {
  return {
    ingressOrigin: "http://127.0.0.1:8644",
    ingressBearer: INGRESS_BEARER,
    upstreamUrl: "https://provider.example/v1/chat/completions",
    upstreamCredential: UPSTREAM_CREDENTIAL,
    provider: "reviewed-provider",
    model: "reviewed-model-v1",
    tokenParameter: "max_completion_tokens",
    outputTokens: 64,
    maxInputBytes: 4_096,
    maxMessages: 4,
    maxResponseBytes: 4_096,
    timeoutMs: 250,
    framingTokenAllowance: 128,
    inputMicrousdPerMillionTokens: 1_000,
    outputMicrousdPerMillionTokens: 2_000,
    maxCallMicrousd: 10,
    ...overrides,
  };
}

function completion(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    id: "completion-1",
    object: "chat.completion",
    created: 1_792_000_000,
    model: "provider-internal-name",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "{\"kind\":\"read_only\"}" },
        finish_reason: "stop",
        provider_metadata: { ignored: true },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    provider_secret_metadata: "must-not-pass-through",
    ...overrides,
  });
}

function caller(
  overrides: Partial<{ remoteAddress: string }> = {},
) {
  return {
    remoteAddress: "127.0.0.1",
    ...overrides,
  };
}

function ingressRequest(
  model: string,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request("http://127.0.0.1:8644/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${INGRESS_BEARER}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages: MESSAGES,
      stream: false,
      tools: [],
      tool_choice: "none",
      ...overrides,
    }),
  });
}

function deterministicRandom() {
  let counter = 0;
  return (size: number) => {
    counter += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(size - 4, counter);
    return bytes;
  };
}

async function expectGateError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected the Hermes egress gate to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(HermesEgressGateError);
    expect(error).toMatchObject({ code, ...(status ? { status } : {}) });
  }
}

describe("Hermes real-provider egress gate", () => {
  it("uses a single bound lease, injects the trusted cap, and returns a sanitized completion", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamInit: RequestInit | undefined;
    const requestFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamInit = init;
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completion();
    });
    const gate = createHermesEgressGate(config(), {
      fetch: requestFetch as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });

    const response = await gate.handle(ingressRequest(lease.model), caller());
    const body = await response.json() as Record<string, unknown>;

    expect(requestFetch).toHaveBeenCalledOnce();
    expect(requestFetch.mock.calls[0]?.[0]).toBe(
      "https://provider.example/v1/chat/completions",
    );
    expect(upstreamInit).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(upstreamInit?.headers).get("authorization")).toBe(
      `Bearer ${UPSTREAM_CREDENTIAL}`,
    );
    expect(upstreamBody).toEqual({
      model: "reviewed-model-v1",
      messages: MESSAGES,
      stream: false,
      max_completion_tokens: 64,
    });
    expect(JSON.stringify(body)).not.toContain("provider_secret_metadata");
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_CREDENTIAL);
    expect(body).toMatchObject({
      model: "reviewed-model-v1",
      choices: [{ message: { role: "assistant" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
    expect(gate.usage(SCOPE)).toEqual({
      attempts: 1,
      completed: 1,
      uncertain: 0,
      promptTokens: 20,
      completionTokens: 8,
      chargedMicrousd: 2,
    });
  });

  it("atomically permits only one concurrent request and rejects replay", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestFetch = vi.fn(async () => {
      await pending;
      return completion();
    });
    const gate = createHermesEgressGate(config(), {
      fetch: requestFetch as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    const first = gate.handle(ingressRequest(lease.model), caller());
    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledOnce());

    await expectGateError(
      gate.handle(ingressRequest(lease.model), caller()),
      "invalid_or_spent_lease",
      409,
    );
    release();
    expect((await first).status).toBe(200);
    await expectGateError(
      gate.handle(ingressRequest(lease.model), caller()),
      "invalid_or_spent_lease",
      409,
    );
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it("bounds outstanding leases and prunes them after expiry", () => {
    let clock = 1_000;
    const gate = createHermesEgressGate(config(), {
      now: () => clock,
      random: deterministicRandom(),
    });
    for (let index = 0; index < 1_024; index += 1) {
      gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST, ttlMs: 10 });
    }
    expect(() => gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST }))
      .toThrowError(expect.objectContaining({ code: "lease_capacity_reached" }));
    clock += 11;
    expect(gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST }).model)
      .toMatch(/^pilot-lease-/);
  });

  it("binds a lease to canonical messages and attributes usage only to its issuing scope", async () => {
    const requestFetch = vi.fn(async () => completion());
    const gate = createHermesEgressGate(config(), {
      fetch: requestFetch as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });

    const changed = [{ role: "user" as const, content: "different request" }];
    await expectGateError(
      gate.handle(
        ingressRequest(lease.model, { messages: changed }),
        caller(),
      ),
      "request_binding_mismatch",
      403,
    );
    expect((await gate.handle(ingressRequest(lease.model), caller())).status).toBe(200);
    expect(requestFetch).toHaveBeenCalledOnce();
    expect(gate.usage(SCOPE)).toMatchObject({ attempts: 1, completed: 1 });
    expect(gate.usage(OTHER_SCOPE)).toEqual({
      attempts: 0,
      completed: 0,
      uncertain: 0,
      promptTokens: 0,
      completionTokens: 0,
      chargedMicrousd: 0,
    });
  });

  it("spends expired and ambiguously timed-out leases without retry", async () => {
    let clock = 1_000;
    const timeoutFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }));
    const gate = createHermesEgressGate(config({ timeoutMs: 100 }), {
      fetch: timeoutFetch as typeof fetch,
      now: () => clock,
      random: deterministicRandom(),
    });
    const expired = gate.issueLease({
      scopeDigest: SCOPE,
      requestDigest: REQUEST_DIGEST,
      ttlMs: 10,
    });
    clock = 3_000;
    await expectGateError(
      gate.handle(ingressRequest(expired.model), caller()),
      "expired_lease",
      409,
    );
    expect(timeoutFetch).not.toHaveBeenCalled();

    const ambiguous = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    await expectGateError(
      gate.handle(ingressRequest(ambiguous.model), caller()),
      "upstream_outcome_uncertain",
      502,
    );
    await expectGateError(
      gate.handle(ingressRequest(ambiguous.model), caller()),
      "invalid_or_spent_lease",
      409,
    );
    expect(timeoutFetch).toHaveBeenCalledOnce();
    expect(gate.usage(SCOPE)).toMatchObject({ attempts: 1, uncertain: 1 });
  });

  it.each([
    [{ stream: true }, "streaming_not_allowed"],
    [{ tools: [{ type: "function" }] }, "tools_not_allowed"],
    [{ tool_choice: "auto" }, "tools_not_allowed"],
    [{ functions: [] }, "unsupported_request_field"],
    [{ temperature: 0 }, "unsupported_request_field"],
  ])("rejects unsafe Hermes request surface %j", async (overrides, code) => {
    const requestFetch = vi.fn(async () => completion());
    const gate = createHermesEgressGate(config(), {
      fetch: requestFetch as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    await expectGateError(
      gate.handle(ingressRequest(lease.model, overrides), caller()),
      code,
    );
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("rejects non-loopback, wrong authority, wrong bearer, and oversized input before upstream", async () => {
    const requestFetch = vi.fn(async () => completion());
    const gate = createHermesEgressGate(config({ maxInputBytes: 512 }), {
      fetch: requestFetch as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const leases = Array.from({ length: 4 }, () =>
      gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST }));

    await expectGateError(
      gate.handle(ingressRequest(leases[0]!.model), caller({ remoteAddress: "10.0.0.2" })),
      "non_loopback_ingress",
      403,
    );
    const foreign = new Request("http://127.0.0.1:9999/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${INGRESS_BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ model: leases[1]!.model, messages: MESSAGES, stream: false }),
    });
    await expectGateError(gate.handle(foreign, caller()), "invalid_ingress", 403);
    await expectGateError(
      gate.handle(ingressRequest(leases[2]!.model, {}, { authorization: "Bearer wrong" }), caller()),
      "unauthorized",
      401,
    );
    await expectGateError(
      gate.handle(
        ingressRequest(leases[3]!.model, {
          messages: [{ role: "user", content: "x".repeat(1_000) }],
        }),
        caller(),
      ),
      "request_too_large",
      413,
    );
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("fails preflight when conservative worst-case cost exceeds the ceiling", async () => {
    const requestFetch = vi.fn(async () => completion());
    const gate = createHermesEgressGate(config({
      outputTokens: 2_048,
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 1_000_000,
      maxCallMicrousd: 100,
    }), {
      fetch: requestFetch as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    await expectGateError(
      gate.handle(ingressRequest(lease.model), caller()),
      "cost_ceiling_exceeded",
      402,
    );
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("supports only the explicitly configured upstream token parameter", async () => {
    let body: Record<string, unknown> = {};
    const gate = createHermesEgressGate(config({ tokenParameter: "max_tokens" }), {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return completion();
      }) as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    await gate.handle(ingressRequest(lease.model), caller());
    expect(body).toMatchObject({ max_tokens: 64 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it.each([
    [{ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "length" }] }, "incomplete_upstream_response"],
    [{ usage: { prompt_tokens: 20, completion_tokens: 65, total_tokens: 85 } }, "invalid_upstream_usage"],
    [{ usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 27 } }, "invalid_upstream_usage"],
    [{ choices: [{ message: { role: "assistant", content: "ok", tool_calls: [] }, finish_reason: "stop" }] }, "invalid_upstream_response"],
  ])("rejects malformed or excessive upstream response %j", async (override, code) => {
    const gate = createHermesEgressGate(config(), {
      fetch: (async () => completion(override)) as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    await expectGateError(gate.handle(ingressRequest(lease.model), caller()), code, 502);
  });

  it("rejects an oversized upstream response and never includes credentials in errors", async () => {
    const gate = createHermesEgressGate(config({ maxResponseBytes: 512 }), {
      fetch: (async () => Response.json({ payload: "x".repeat(1_000) })) as typeof fetch,
      now: () => 1_000,
      random: deterministicRandom(),
    });
    const lease = gate.issueLease({ scopeDigest: SCOPE, requestDigest: REQUEST_DIGEST });
    try {
      await gate.handle(ingressRequest(lease.model), caller());
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "response_too_large" });
      expect(String(error)).not.toContain(INGRESS_BEARER);
      expect(String(error)).not.toContain(UPSTREAM_CREDENTIAL);
    }
  });

  it.each([
    [{ upstreamUrl: "http://provider.example/v1/chat/completions" }, "http upstream"],
    [{ upstreamUrl: "https://provider.example/redirect" }, "non-completion endpoint"],
    [{ ingressOrigin: "http://0.0.0.0:8644" }, "non-loopback ingress"],
    [{ inputMicrousdPerMillionTokens: 0 }, "missing input pricing"],
    [{ outputMicrousdPerMillionTokens: 0 }, "missing output pricing"],
    [{ tokenParameter: "unsupported" as "max_tokens" }, "unknown cap mode"],
  ])("fails closed on invalid configuration: %s", (override, _label) => {
    expect(() => createHermesEgressGate(config(override))).toThrowError(
      expect.objectContaining({ code: "invalid_configuration", status: 500 }),
    );
  });
});
