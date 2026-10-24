import { describe, expect, it, vi } from "vitest";

import {
  createHermesProposalProvider,
  createRedactedProposalContext,
  deriveHermesProfileBinding,
  type HermesFetch,
  type HermesProposalConfig,
  type HermesServerScope,
  type RedactedProposalContextInput,
} from "../src/hermes-transport.js";
import type { ProposalRequest, ProposalResult } from "../src/proposal-provider.js";

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
  apiKey: "hermes-profile-key-not-a-real-credential",
  model: "hermes-agent",
  timeoutMs: 1_000,
  maxResponseBytes: 4_096,
};

const readResult: ProposalResult = {
  kind: "read_only",
  summary: "The bounded fixture contains two observations.",
  evidence: [],
  caveats: ["Synthetic fixture evidence only"],
};
const procedureResult: ProposalResult = {
  kind: "procedure_proposal",
  procedure: {
    id: "candidate",
    version: "1.0.0",
    title: "Bounded review candidate",
    description: "A declarative candidate for offline review.",
    steps: [
      {
        id: "read",
        operation: "read_context",
        description: "Read the bounded redacted context.",
        dependsOn: [],
      },
    ],
    invariants: [
      "no_network",
      "no_execution",
      "no_runtime_rewrite",
      "no_policy_change",
      "no_automatic_promotion",
      "scope_isolation",
    ],
  },
  rationale: "Provides review material without executing it.",
  risks: ["Requires human review"],
};

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

const disabledToolsets = {
  object: "list",
  platform: "api_server",
  data: [
    {
      name: "synthetic",
      label: "Synthetic disabled toolset",
      description: "A bounded disabled toolset used by request-hardening tests.",
      enabled: false,
      configured: false,
      tools: ["synthetic_tool_metadata"],
    },
  ],
} as const;

function successfulFetch(calls: FetchCall[]): HermesFetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/toolsets")) return jsonResponse(disabledToolsets);

    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const request = JSON.parse(body.messages[1]!.content) as Pick<
      ProposalRequest,
      "purpose"
    >;
    const result = request.purpose === "read" ? readResult : procedureResult;
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
    }, {
      headers: {
        "X-Hermes-Session-Id": new Headers(init.headers).get("x-hermes-session-id") ?? "",
      },
    });
  }) as HermesFetch;
}

function context(entries?: RedactedProposalContextInput["entries"]) {
  return createRedactedProposalContext({
    entries:
      entries ??
      [
        {
          kind: "redacted_text",
          field: "evidence_summary",
          value: "Two synthetic observations",
        },
        { kind: "metric", field: "evidence_count", value: 2 },
      ],
  });
}

function request(
  proposalContext: ReturnType<typeof context>,
  patch: Partial<ProposalRequest> = {},
): ProposalRequest {
  return {
    requestId: "request-1",
    purpose: "read",
    prompt: "Summarize the supplied offline evidence.",
    context: proposalContext,
    ...patch,
  };
}

function chatIdempotencyKeys(calls: FetchCall[]): string[] {
  return calls
    .filter(({ url }) => url.endsWith("/chat/completions"))
    .map(({ init }) => new Headers(init.headers).get("idempotency-key"))
    .filter((value): value is string => value !== null);
}

describe("Hermes redacted request boundary", () => {
  it("creates a recursively frozen allowlisted plain context", () => {
    const built = context();

    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.entries)).toBe(true);
    expect(built.entries.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    [
      "access_token field",
      { entries: [{ kind: "redacted_text", field: "access_token", value: "redacted" }] },
    ],
    [
      "api_key field",
      { entries: [{ kind: "redacted_text", field: "api_key", value: "redacted" }] },
    ],
    [
      "credential-labelled text",
      {
        entries: [
          {
            kind: "redacted_text",
            field: "evidence_summary",
            value: "API key: do-not-copy-this-value",
          },
        ],
      },
    ],
    [
      "raw top-level field",
      { entries: [], access_token: "do-not-copy-this-value" },
    ],
    [
      "nested object value",
      {
        entries: [
          {
            kind: "redacted_text",
            field: "evidence_summary",
            value: { summary: "not a scalar" },
          },
        ],
      },
    ],
  ])("rejects %s without reflecting supplied content", (_label, input) => {
    expect(() =>
      createRedactedProposalContext(input as RedactedProposalContextInput),
    ).toThrow("Invalid redacted Hermes proposal context");
    try {
      createRedactedProposalContext(input as RedactedProposalContextInput);
    } catch (error) {
      expect(String(error)).not.toContain("do-not-copy-this-value");
    }
  });

  it("rejects unbounded and duplicate builder entries", () => {
    const tooMany = Array.from({ length: 65 }, (_, index) => ({
      kind: "redacted_text" as const,
      field: "fixture_reference" as const,
      value: `fixture-${index}`,
    }));
    expect(() => createRedactedProposalContext({ entries: tooMany })).toThrow(
      "Invalid redacted Hermes proposal context",
    );
    expect(() =>
      createRedactedProposalContext({
        entries: [
          { kind: "metric", field: "evidence_count", value: 1 },
          { kind: "metric", field: "evidence_count", value: 2 },
        ],
      }),
    ).toThrow("Invalid redacted Hermes proposal context");
  });

  it("rejects structurally similar arbitrary objects before transport", async () => {
    const transport = vi.fn();
    const provider = createHermesProposalProvider(
      config,
      scope,
      transport as unknown as HermesFetch,
    );
    const bypass = {
      schema_version: "pilot.redacted-proposal-context.v1",
      entries: [
        {
          kind: "redacted_text",
          field: "evidence_summary",
          value: "Looks redacted but did not cross the builder",
        },
      ],
    };

    await expect(
      provider.propose(request(bypass as unknown as ReturnType<typeof context>)),
    ).rejects.toThrow("must be explicitly redacted");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects credential-labelled prompt text before transport without leaking it", async () => {
    const transport = vi.fn();
    const provider = createHermesProposalProvider(
      config,
      scope,
      transport as unknown as HermesFetch,
    );
    const marker = "API key: do-not-copy-this-value";

    let failure = "";
    try {
      await provider.propose(request(context(), { prompt: marker }));
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("Invalid Hermes proposal request");
    expect(failure).not.toContain("do-not-copy-this-value");
    expect(transport).not.toHaveBeenCalled();
  });

  it("derives the same idempotency key for canonical context regardless of key or entry order", async () => {
    const calls: FetchCall[] = [];
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls));
    const first = createRedactedProposalContext({
      entries: [
        { kind: "metric", field: "evidence_count", value: 2 },
        {
          kind: "redacted_text",
          field: "evidence_summary",
          value: "Two synthetic observations",
        },
      ],
    });
    const secondInput = {
      entries: [
        {
          value: "Two synthetic observations",
          field: "evidence_summary",
          kind: "redacted_text",
        },
        { value: 2, field: "evidence_count", kind: "metric" },
      ],
    } as RedactedProposalContextInput;
    const second = createRedactedProposalContext(secondInput);

    await provider.propose(request(first));
    await provider.propose(request(second));

    expect(chatIdempotencyKeys(calls)).toEqual([
      expect.stringMatching(/^pilot-hermes:[0-9a-f]{64}$/),
      expect.stringMatching(/^pilot-hermes:[0-9a-f]{64}$/),
    ]);
    expect(new Set(chatIdempotencyKeys(calls))).toHaveLength(1);
  });

  it("canonicalizes punctuation-bearing values without locale collation", async () => {
    const calls: FetchCall[] = [];
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls));
    const first = createRedactedProposalContext({
      entries: [
        {
          kind: "redacted_text",
          field: "fixture_reference",
          value: "fixture.a/2",
        },
        {
          kind: "redacted_text",
          field: "evidence_summary",
          value: "alpha-beta_gamma",
        },
      ],
    });
    const second = createRedactedProposalContext({
      entries: [...first.entries].reverse(),
    });

    await provider.propose(request(first));
    await provider.propose(request(second));

    expect(new Set(chatIdempotencyKeys(calls))).toHaveLength(1);
  });

  it("changes idempotency for changed purpose, prompt, or context", async () => {
    const calls: FetchCall[] = [];
    const provider = createHermesProposalProvider(config, scope, successfulFetch(calls));
    const baseline = context();

    await provider.propose(request(baseline));
    await provider.propose(request(baseline, { prompt: "Summarize only the policy evidence." }));
    await provider.propose(
      request(
        context([
          {
            kind: "redacted_text",
            field: "evidence_summary",
            value: "Three synthetic observations",
          },
          { kind: "metric", field: "evidence_count", value: 3 },
        ]),
      ),
    );
    await provider.propose(
      request(baseline, {
        purpose: "procedure_proposal",
      }),
    );

    const keys = chatIdempotencyKeys(calls);
    expect(keys).toHaveLength(4);
    expect(new Set(keys)).toHaveLength(4);
  });

  it("does not expose a rejected response body", async () => {
    const marker = "API key: do-not-copy-this-value";
    const transport = vi.fn(async () =>
      new Response(marker, { status: 500 }),
    ) as unknown as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);

    let failure = "";
    try {
      await provider.propose(request(context()));
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("status 500");
    expect(failure).not.toContain("do-not-copy-this-value");
  });

  it("rejects credential-labelled proposal output without reflecting it", async () => {
    const marker = "API key: do-not-copy-this-value";
    const transport = (async (input: string | URL | Request, init: RequestInit = {}) =>
      String(input).endsWith("/toolsets")
        ? jsonResponse(disabledToolsets)
        : jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({ ...readResult, summary: marker }),
                },
                finish_reason: "stop",
              },
            ],
          }, {
            headers: {
              "X-Hermes-Session-Id": new Headers(init.headers).get("x-hermes-session-id") ?? "",
            },
          })) as HermesFetch;
    const provider = createHermesProposalProvider(config, scope, transport);

    let failure = "";
    try {
      await provider.propose(request(context()));
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("unsafe proposal text");
    expect(failure).not.toContain("do-not-copy-this-value");
  });
});
