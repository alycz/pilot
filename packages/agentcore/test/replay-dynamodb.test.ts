import { describe, expect, it, vi } from "vitest";
import { createDynamoDbAgentCoreReplayStore } from "../src/replay-dynamodb";
const D = { namespaceDigest: "1".repeat(64), requestDigest: "2".repeat(64), bindingDigest: "3".repeat(64) };
const leaseId = "00000000-0000-4000-8000-000000000001";
const response = { protocolVersion: "pilot-agentcore.research.v1" as const, transport: "aws-agentcore-runtime" as const, dataProvenance: "external-unverified" as const, requestId: "request-1", scopeDigest: "4".repeat(64), gatewayBindingDigest: "5".repeat(64), requestDigest: D.requestDigest, result: { kind: "read_only" as const, summary: "Public result", evidence: [], caveats: [] } };
function client(updateItem: ReturnType<typeof vi.fn>, getItem = vi.fn()) { return { updateItem, getItem, isConditionalFailure: (error: unknown) => (error as { name?: string })?.name === "ConditionalCheckFailedException" }; }

describe("DynamoDB replay command adapter", () => {
  it("claims conditionally and persists digests only", async () => {
    const updateItem = vi.fn().mockResolvedValue({ Attributes: { fence: { N: "1" } } });
    const replay = createDynamoDbAgentCoreReplayStore({ tableName: "pilot-agentcore-replay", client: client(updateItem), nextLeaseId: () => leaseId });
    await expect(replay.claim({ ...D, nowMs: 1_000, leaseMs: 2_000, retentionMs: 60_000 })).resolves.toEqual({ status: "claimed", leaseId, fence: 1, leaseUntil: 3_000 });
    const serialized = JSON.stringify(updateItem.mock.calls[0]![0]);
    expect(serialized).toContain("attribute_not_exists(#namespace)"); expect(serialized).toContain("#leaseUntil <= :now");
    expect(serialized).not.toMatch(/prompt|wallet|Bearer|private|owner/i);
  });

  it("strongly reads a lost claim, replays only fresh validated responses, and rejects stale TTL items", async () => {
    const condition = Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
    const updateItem = vi.fn().mockRejectedValue(condition);
    const getItem = vi.fn().mockResolvedValueOnce({ Item: { bindingDigest: { S: D.bindingDigest }, state: { S: "completed" }, expiresAt: { N: "100" }, responseJson: { S: JSON.stringify(response) } } }).mockResolvedValueOnce({ Item: { bindingDigest: { S: D.bindingDigest }, state: { S: "completed" }, expiresAt: { N: "1" }, responseJson: { S: JSON.stringify(response) } } });
    const replay = createDynamoDbAgentCoreReplayStore({ tableName: "pilot-agentcore-replay", client: client(updateItem, getItem), nextLeaseId: () => leaseId });
    await expect(replay.claim({ ...D, nowMs: 1_000, leaseMs: 2_000, retentionMs: 60_000 })).resolves.toEqual({ status: "completed", response });
    await expect(replay.claim({ ...D, nowMs: 2_000, leaseMs: 2_000, retentionMs: 60_000 })).resolves.toEqual({ status: "uncertain" });
    expect(getItem.mock.calls[0]![0]).toMatchObject({ ConsistentRead: true });
  });

  it("never takes over dispatched state and rejects cross-binding records", async () => {
    const condition = Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
    const getItem = vi.fn().mockResolvedValueOnce({ Item: { bindingDigest: { S: D.bindingDigest }, state: { S: "dispatched" } } }).mockResolvedValueOnce({ Item: { bindingDigest: { S: "9".repeat(64) }, state: { S: "claimed" }, leaseUntil: { N: "5000" } } });
    const replay = createDynamoDbAgentCoreReplayStore({ tableName: "pilot-agentcore-replay", client: client(vi.fn().mockRejectedValue(condition), getItem), nextLeaseId: () => leaseId });
    await expect(replay.claim({ ...D, nowMs: 99_000, leaseMs: 2_000, retentionMs: 60_000 })).resolves.toEqual({ status: "uncertain" });
    await expect(replay.claim({ ...D, nowMs: 1_000, leaseMs: 2_000, retentionMs: 60_000 })).rejects.toMatchObject({ code: "binding" });
  });

  it("uses generation fences for dispatch, completion, and release", async () => {
    const updateItem = vi.fn().mockResolvedValue({});
    const replay = createDynamoDbAgentCoreReplayStore({ tableName: "pilot-agentcore-replay", client: client(updateItem), nextLeaseId: () => leaseId });
    const owned = { ...D, leaseId, fence: 7, nowMs: 1_000, retentionMs: 60_000 };
    await replay.markDispatched(owned); await replay.complete({ ...owned, response }); await replay.releaseClaim(owned);
    expect(updateItem.mock.calls[0]![0].ConditionExpression).toContain("#leaseUntil > :now"); expect(updateItem.mock.calls[1]![0].ConditionExpression).toContain("#state = :dispatched"); expect(updateItem.mock.calls[2]![0].ConditionExpression).toContain("#state = :claimed");
    expect(updateItem.mock.calls[0]![0].UpdateExpression).toContain("REMOVE #expiresAt");
    expect(updateItem.mock.calls[0]![0].ExpressionAttributeValues).not.toHaveProperty(":expiresAt");
    expect(JSON.stringify(updateItem.mock.calls)).not.toMatch(/prompt|wallet|Bearer|private|owner/i);
  });

  it("bounds a cancellation-ignoring client and redacts transport errors", async () => {
    const replay = createDynamoDbAgentCoreReplayStore({ tableName: "pilot-agentcore-replay", timeoutMs: 100, client: client(vi.fn(() => new Promise(() => undefined))), nextLeaseId: () => leaseId });
    await expect(replay.claim({ ...D, nowMs: 1_000, leaseMs: 2_000, retentionMs: 60_000 })).rejects.toMatchObject({ code: "uncertain", message: "AgentCore replay outcome is uncertain" });
  });
});
