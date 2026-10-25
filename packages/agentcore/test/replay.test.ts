import { describe, expect, it } from "vitest";
import { AgentCoreReplayError, createInMemoryAgentCoreReplayStore, deriveAgentCoreReplayBinding, deriveAgentCoreReplayNamespace } from "../src/replay";

const D = { namespaceDigest: "1".repeat(64), requestDigest: "2".repeat(64), bindingDigest: "3".repeat(64) };
const response = { protocolVersion: "pilot-agentcore.research.v1" as const, transport: "aws-agentcore-runtime" as const, dataProvenance: "external-unverified" as const, requestId: "request-1", scopeDigest: "4".repeat(64), gatewayBindingDigest: "5".repeat(64), requestDigest: D.requestDigest, result: { kind: "read_only" as const, summary: "Public market context", evidence: [], caveats: [] } };
const UUIDS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
function store() { let index = 0; return createInMemoryAgentCoreReplayStore({ nextLeaseId: () => UUIDS[index++]! }); }

describe("AgentCore replay fencing", () => {
  it("fences an expired claimant and replays one immutable completion", async () => {
    const replay = store();
    const first = await replay.claim({ ...D, nowMs: 1_000, leaseMs: 1_000, retentionMs: 60_000 });
    await expect(replay.claim({ ...D, nowMs: 1_500, leaseMs: 1_000, retentionMs: 60_000 })).resolves.toEqual({ status: "busy", retryAfterMs: 500 });
    const second = await replay.claim({ ...D, nowMs: 2_000, leaseMs: 1_000, retentionMs: 60_000 });
    if (first.status !== "claimed" || second.status !== "claimed") throw new Error("fixture claim failed");
    expect(second.fence).toBe(2);
    await expect(replay.markDispatched({ ...D, leaseId: first.leaseId, fence: first.fence, nowMs: 2_001, retentionMs: 60_000 })).rejects.toMatchObject({ code: "fenced" });
    await replay.markDispatched({ ...D, leaseId: second.leaseId, fence: second.fence, nowMs: 2_001, retentionMs: 60_000 });
    await replay.complete({ ...D, leaseId: second.leaseId, fence: second.fence, response, nowMs: 2_002, retentionMs: 60_000 });
    await expect(replay.claim({ ...D, nowMs: 3_000, leaseMs: 1_000, retentionMs: 60_000 })).resolves.toEqual({ status: "completed", response });
    await expect(replay.claim({ ...D, nowMs: 63_000, leaseMs: 1_000, retentionMs: 60_000 })).resolves.toEqual({ status: "uncertain" });
  });

  it("treats dispatched-without-result as terminal uncertain even after lease expiry", async () => {
    const replay = store();
    const claim = await replay.claim({ ...D, nowMs: 1_000, leaseMs: 1_000, retentionMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture claim failed");
    await replay.markDispatched({ ...D, leaseId: claim.leaseId, fence: claim.fence, nowMs: 1_100, retentionMs: 60_000 });
    await expect(replay.claim({ ...D, nowMs: 999_999, leaseMs: 1_000, retentionMs: 60_000 })).resolves.toEqual({ status: "uncertain" });
    await expect(replay.releaseClaim({ ...D, leaseId: claim.leaseId, fence: claim.fence, nowMs: 1_200, retentionMs: 60_000 })).rejects.toMatchObject({ code: "fenced" });
  });

  it("permits released pre-dispatch work to be reclaimed but rejects cross-binding reuse", async () => {
    const replay = store();
    const claim = await replay.claim({ ...D, nowMs: 1_000, leaseMs: 1_000, retentionMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture claim failed");
    await replay.releaseClaim({ ...D, leaseId: claim.leaseId, fence: claim.fence, nowMs: 1_100, retentionMs: 60_000 });
    await expect(replay.claim({ ...D, nowMs: 1_101, leaseMs: 1_000, retentionMs: 60_000 })).resolves.toMatchObject({ status: "claimed", fence: 2 });
    await expect(replay.claim({ ...D, bindingDigest: "9".repeat(64), nowMs: 3_000, leaseMs: 1_000, retentionMs: 60_000 })).rejects.toMatchObject({ code: "binding" });
  });

  it("hashes deployment and tenant namespaces without exposing raw values", () => {
    const namespace = deriveAgentCoreReplayNamespace({ deploymentId: "pilot-event", tenantId: "wallet-opaque-tenant" });
    expect(namespace).toMatch(/^[a-f0-9]{64}$/); expect(namespace).not.toMatch(/pilot|wallet|tenant/);
    expect(deriveAgentCoreReplayBinding({ requestDigest: D.requestDigest, scopeDigest: response.scopeDigest, gatewayBindingDigest: response.gatewayBindingDigest })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects malformed keys, aborted operations, and completion before dispatch", async () => {
    const replay = store();
    await expect(replay.claim({ ...D, requestDigest: "secret prompt", nowMs: 1_000, leaseMs: 1_000, retentionMs: 60_000 })).rejects.toBeInstanceOf(AgentCoreReplayError);
    const aborted = new AbortController(); aborted.abort();
    await expect(replay.claim({ ...D, nowMs: 1_000, leaseMs: 1_000, retentionMs: 60_000, signal: aborted.signal })).rejects.toMatchObject({ code: "uncertain" });
    const claim = await replay.claim({ ...D, nowMs: 1_000, leaseMs: 1_000, retentionMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture claim failed");
    await expect(replay.complete({ ...D, leaseId: claim.leaseId, fence: claim.fence, response, nowMs: 1_100, retentionMs: 60_000 })).rejects.toMatchObject({ code: "fenced" });
  });
});
