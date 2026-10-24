import {
  createHermesProposalProvider,
  deriveHermesProfileBinding,
  type HermesFetch,
  type HermesProposalLeaseRequest,
} from "@pilot/agent/hermes-transport";
import type { ProposalProvider } from "@pilot/agent/proposal-provider";
import { describe, expect, it, vi } from "vitest";

import {
  issueHermesConsentCookie,
  readHermesConsentCookie,
} from "./hermes-consent";
import {
  createHermesWorkflowAdvisor,
  createProcessHermesUsageMonitor,
} from "./hermes-workflow-lessons";

const scope = {
  tenantId: "tenant-a",
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet" as const,
};
const disclosure = {
  provider: "openrouter",
  model: "example/read-only",
  dataPolicy: "bounded-redacted-proposals" as const,
  retentionDays: 7,
  termsVersion: "v1",
};
const CONSENT_SECRET = "workflow-advisor-consent-secret-at-least-32";
const CONSENT_NOW = 1_800_000_000_000;
const issuedConsent = issueHermesConsentCookie(scope, disclosure, {
  secret: CONSENT_SECRET,
  now: CONSENT_NOW,
});
const consent = readHermesConsentCookie(
  `__Host-pilot-hermes-consent=${issuedConsent.value}`,
  scope,
  disclosure,
  { secret: CONSENT_SECRET, now: CONSENT_NOW },
)!;
const input = {
  recordId: `lesson:${"a".repeat(32)}`,
  revision: 2,
  version: 1,
  target: { category: "response_detail" as const, value: "concise" as const },
  evidenceCount: 2,
};

function boundProvider(propose = vi.fn(async () => ({
  kind: "read_only" as const,
  summary: "Use a concise response shape after the user reviews this lesson.",
  evidence: [],
  caveats: ["This does not change transaction policy."],
}))): Readonly<{ provider: ProposalProvider; proof: object }> {
  const proof = Object.freeze({ bridge: "test" });
  const serverScope = {
    principalId: scope.owner,
    tenantId: scope.tenantId,
    channelId: `${scope.network}:${scope.owner}`,
  };
  const adapter = createHermesProposalProvider({
    enabled: true,
    origin: "http://127.0.0.1:8642",
    profile: "pilot-proposal-v1",
    profileBinding: deriveHermesProfileBinding(serverScope),
    apiKey: "test-hermes-profile-key-not-real",
    model: disclosure.model,
  }, serverScope, vi.fn() as unknown as HermesFetch, {
    provider: disclosure.provider,
    leaseAuthority: {
      proof,
      async issueLease(input: HermesProposalLeaseRequest) {
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
    sessionLifecycle: {
      prepare: vi.fn(),
      settle: vi.fn(async ({ outcome }) =>
        outcome === "created" ? "active" as const : "uncertain" as const),
    },
  });
  vi.spyOn(adapter, "propose").mockImplementation(propose);
  return { provider: adapter, proof };
}

describe("Hermes workflow lesson advisory", () => {
  it("sends only fixed target enums and aggregate evidence, then returns disclosure", async () => {
    const propose = vi.fn<ProposalProvider["propose"]>(async () => ({
      kind: "read_only" as const,
      summary: "Use a concise response shape after review.",
      evidence: [],
      caveats: ["Review remains required."],
    }));
    const bound = boundProvider(propose);
    const profile = vi.fn(async () => undefined);
    const monitor = createProcessHermesUsageMonitor(3);
    const advisor = createHermesWorkflowAdvisor({
      provider: bound.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure, usageMonitor: monitor,
      leaseAuthorityProof: bound.proof, assertProfileUnchanged: profile,
      readUsage: (requestId) => ({
        requestId,
        profile: "pilot-proposal-v1",
        provider: "openrouter",
        model: "example/read-only",
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      }),
      now: () => new Date("2026-10-21T03:00:00.000Z"),
    });

    await expect(advisor.advise(input)).resolves.toMatchObject({
      schemaVersion: "pilot.hermes-workflow-advisory.v1",
      disclosure,
      usage: { callsRemainingToday: 2, totalTokens: 30 },
    });
    expect(profile).toHaveBeenCalledTimes(2);
    const sent = propose.mock.calls[0]![0];
    expect(JSON.stringify(sent)).toContain("response_detail:concise");
    expect(JSON.stringify(sent)).not.toContain(scope.owner);
    expect(JSON.stringify(sent)).not.toContain(scope.tenantId);
    expect(JSON.stringify(sent)).not.toContain(input.recordId);
    expect(monitor.snapshot()).toHaveLength(1);
    expect(JSON.stringify(monitor.snapshot())).not.toContain(scope.owner);
  });

  it.each([
    ["missing consent", { consent: null }],
    ["disabled provider", { provider: { enabled: false, propose: vi.fn() } }],
  ])("stays disabled for %s", async (_label, override) => {
    const propose = vi.fn();
    const bound = boundProvider(propose);
    const advisor = createHermesWorkflowAdvisor({
      provider: bound.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure, usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: bound.proof, assertProfileUnchanged: async () => undefined,
      ...override,
    });
    expect(advisor.enabled).toBe(false);
    await expect(advisor.advise(input)).rejects.toThrow("disabled");
    expect(propose).not.toHaveBeenCalled();
  });

  it("rejects a forged cost-gate readiness object", async () => {
    const propose = vi.fn();
    const bound = boundProvider(propose);
    const advisor = createHermesWorkflowAdvisor({
      provider: bound.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure, usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: {},
      assertProfileUnchanged: async () => undefined,
    });
    expect(advisor.enabled).toBe(false);
    await expect(advisor.advise(input)).rejects.toThrow("disabled");
    expect(propose).not.toHaveBeenCalled();
  });

  it("rejects consent validated for a different supplied scope or disclosure", () => {
    const first = boundProvider();
    const wrongScope = createHermesWorkflowAdvisor({
      provider: first.provider, profile: "pilot-proposal-v1", consent,
      consentScope: { ...scope, tenantId: "tenant-b" }, disclosure,
      usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: first.proof, assertProfileUnchanged: async () => undefined,
    });
    const second = boundProvider();
    const wrongDisclosure = createHermesWorkflowAdvisor({
      provider: second.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure: { ...disclosure, model: "example/other" },
      usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: second.proof, assertProfileUnchanged: async () => undefined,
    });
    expect(wrongScope.enabled).toBe(false);
    expect(wrongDisclosure.enabled).toBe(false);
  });

  it("enforces the aggregate daily monitor before a second model call", async () => {
    const propose = vi.fn(async () => ({
      kind: "read_only" as const,
      summary: "Review-only explanation.", evidence: [], caveats: [],
    }));
    const bound = boundProvider(propose);
    const advisor = createHermesWorkflowAdvisor({
      provider: bound.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure, usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: bound.proof, assertProfileUnchanged: async () => undefined,
      now: () => new Date("2026-10-21T03:00:00.000Z"),
    });
    await advisor.advise(input);
    await expect(advisor.advise(input)).rejects.toThrow("daily advisory limit");
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("bounds usage scopes and retained events while pruning previous days", async () => {
    const monitor = createProcessHermesUsageMonitor(1);
    const firstDay = new Date("2026-10-21T03:00:00.000Z");
    for (let index = 0; index < 1_024; index += 1) {
      const identity = index.toString(16).padStart(64, "0");
      await expect(monitor.reserve(identity, firstDay)).resolves.toEqual({
        callsRemainingToday: 0,
      });
      await monitor.record({
        scopeDigest: identity,
        day: "2026-10-21",
        provider: "openrouter",
        model: "example/read-only",
        profile: "pilot-proposal-v1",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      });
    }
    await expect(monitor.reserve("f".repeat(64), firstDay)).rejects.toThrow(
      "capacity reached",
    );
    await monitor.record({
      scopeDigest: "f".repeat(64),
      day: "2026-10-21",
      provider: "openrouter",
      model: "example/read-only",
      profile: "pilot-proposal-v1",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });
    expect(monitor.snapshot()).toHaveLength(1_024);
    expect(monitor.snapshot()[0]?.scopeDigest).toBe("1".padStart(64, "0"));

    await expect(monitor.reserve(
      "f".repeat(64),
      new Date("2026-10-22T03:00:00.000Z"),
    )).resolves.toEqual({ callsRemainingToday: 0 });
  });

  it("discards a result when the immutable profile changes after the call", async () => {
    const profile = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("profile changed"));
    const bound = boundProvider();
    const advisor = createHermesWorkflowAdvisor({
      provider: bound.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure, usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: bound.proof, assertProfileUnchanged: profile,
    });
    await expect(advisor.advise(input)).rejects.toThrow("profile changed");
  });

  it("rejects stale usage from another request", async () => {
    const bound = boundProvider();
    const advisor = createHermesWorkflowAdvisor({
      provider: bound.provider, profile: "pilot-proposal-v1", consent,
      consentScope: scope, disclosure, usageMonitor: createProcessHermesUsageMonitor(1),
      leaseAuthorityProof: bound.proof, assertProfileUnchanged: async () => undefined,
      readUsage: () => ({
        requestId: "lesson-advice-stale",
        profile: "pilot-proposal-v1",
        provider: "openrouter",
        model: "example/read-only",
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
      }),
    });
    await expect(advisor.advise(input)).rejects.toThrow("current advisory request");
  });
});
