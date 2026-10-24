import { describe, expect, it } from "vitest";

import {
  X402_APPROVED_RECEIVER,
  completeX402Operation,
  loadPendingX402Operation,
  markX402OperationJournalPending,
  markX402OperationRecovering,
  withLockedX402OperationDispatch,
  type PendingX402Operation,
  type PublicOperationLockManager,
  type PublicOperationStorage,
  type X402OperationScope,
} from "./x402-operation-state";

const ownerA = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const ownerB = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const scope = (owner: string): X402OperationScope => ({
  owner,
  network: "testnet",
  resource: "compare",
  max_price_drops: "5000",
  receiver: X402_APPROVED_RECEIVER,
});

function memoryStorage(): PublicOperationStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

class DeterministicLockManager implements PublicOperationLockManager {
  private readonly held = new Set<string>();

  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

async function reserve(
  locks: PublicOperationLockManager,
  storage: PublicOperationStorage,
  operationScope: X402OperationScope,
  createOperationId: () => string,
  expectedOperationId?: string,
): Promise<PendingX402Operation> {
  const outcome = await withLockedX402OperationDispatch(
    locks,
    storage,
    operationScope,
    { createOperationId, expectedOperationId },
    async (operation) => operation,
  );
  if (outcome.kind !== "dispatched") throw new Error(`unexpected ${outcome.kind} outcome`);
  return outcome.operation;
}

const LIVE_COMPLETE = {
  result_status: "delivered" as const,
  mode: "live-local" as const,
  journal_status: "recorded" as const,
};

describe("durable x402 operation identity", () => {
  it("persists before dispatch and restores the same identity after reload or crash", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    const first = await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-operation-1");
    const restored = loadPendingX402Operation(storage, scope(ownerA));
    const repeated = await reserve(locks, storage, scope(ownerA), () => "x402-must-not-be-created");
    expect(first.version).toBe(2);
    expect(first.max_price_drops).toBe("5000");
    expect(first.receiver).toBe(X402_APPROVED_RECEIVER);
    expect(JSON.parse([...storage.values.values()][0]!).max_price_drops).toBe("5000");
    expect(JSON.parse([...storage.values.values()][0]!).receiver).toBe(X402_APPROVED_RECEIVER);
    expect(restored).toEqual(first);
    expect(repeated.operation_id).toBe(first.operation_id);
  });

  it("keeps pending identities isolated by owner", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    const first = await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-operation-1");
    const second = await reserve(locks, storage, scope(ownerB), () => "x402-owner-b-operation-1");
    expect(second.operation_id).not.toBe(first.operation_id);
    expect(loadPendingX402Operation(storage, scope(ownerA))?.operation_id).toBe(first.operation_id);
    expect(loadPendingX402Operation(storage, scope(ownerB))?.operation_id).toBe(second.operation_id);
  });

  it.each(["5001", "100000"])(
    "rejects a same-key record with changed or legacy price %s even when its fingerprint matches",
    async (maxPriceDrops) => {
      const storage = memoryStorage();
      const locks = new DeterministicLockManager();
      await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-operation-1");
      const [key, raw] = [...storage.values.entries()][0]!;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      const changedScope = {
        owner: saved.owner,
        network: saved.network,
        resource: saved.resource,
        max_price_drops: maxPriceDrops,
        receiver: saved.receiver,
      };
      const changedRecord = JSON.stringify({
        ...saved,
        max_price_drops: maxPriceDrops,
        payload_fingerprint: JSON.stringify(changedScope),
      });
      storage.values.set(key, changedRecord);
      expect(() => loadPendingX402Operation(storage, scope(ownerA))).toThrow(/does not match/i);
      let dispatches = 0;
      await expect(withLockedX402OperationDispatch(
        locks,
        storage,
        scope(ownerA),
        {
          createOperationId: () => "x402-must-not-replace-invalid-state",
          expectedOperationId: String(saved.operation_id),
        },
        async () => { dispatches += 1; },
      )).rejects.toThrow(/does not match/i);
      expect(dispatches).toBe(0);
      expect(storage.values.get(key)).toBe(changedRecord);
    },
  );

  it("rejects a changed receiver without dispatching or replacing the saved identity", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-operation-1");
    const [key, raw] = [...storage.values.entries()][0]!;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const changedScope = {
      owner: saved.owner,
      network: saved.network,
      resource: saved.resource,
      max_price_drops: saved.max_price_drops,
      receiver: ownerB,
    };
    const changedRecord = JSON.stringify({
      ...saved,
      receiver: ownerB,
      payload_fingerprint: JSON.stringify(changedScope),
    });
    storage.values.set(key, changedRecord);

    let dispatches = 0;
    await expect(withLockedX402OperationDispatch(
      locks,
      storage,
      scope(ownerA),
      {
        createOperationId: () => "x402-must-not-replace-changed-receiver",
        expectedOperationId: String(saved.operation_id),
      },
      async () => { dispatches += 1; },
    )).rejects.toThrow(/does not match/i);
    expect(dispatches).toBe(0);
    expect(storage.values.get(key)).toBe(changedRecord);
  });

  it("rejects a legacy receiver-less v1 record without dispatching or migrating it", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-operation-1");
    const [key, raw] = [...storage.values.entries()][0]!;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const legacyRecord = { ...saved };
    delete legacyRecord.receiver;
    const legacyScope = {
      owner: saved.owner,
      network: saved.network,
      resource: saved.resource,
      max_price_drops: saved.max_price_drops,
    };
    const changedRecord = JSON.stringify({
      ...legacyRecord,
      version: 1,
      payload_fingerprint: JSON.stringify(legacyScope),
    });
    storage.values.set(key, changedRecord);

    let dispatches = 0;
    await expect(withLockedX402OperationDispatch(
      locks,
      storage,
      scope(ownerA),
      {
        createOperationId: () => "x402-must-not-migrate-legacy-state",
        expectedOperationId: String(saved.operation_id),
      },
      async () => { dispatches += 1; },
    )).rejects.toThrow(/does not match/i);
    expect(dispatches).toBe(0);
    expect(storage.values.get(key)).toBe(changedRecord);
  });

  it("retains uncertainty and clears only matching terminal proof", async () => {
    const storage = memoryStorage();
    const pending = await reserve(new DeterministicLockManager(), storage, scope(ownerA), () => "x402-owner-a-operation-1");
    expect(markX402OperationRecovering(storage, scope(ownerA), pending.operation_id).phase).toBe("recovering");
    expect(() => completeX402Operation(storage, scope(ownerA), "x402-other-operation", LIVE_COMPLETE)).toThrow(/does not match/i);
    expect(loadPendingX402Operation(storage, scope(ownerA))).toBeDefined();
    completeX402Operation(storage, scope(ownerA), pending.operation_id, LIVE_COMPLETE);
    expect(loadPendingX402Operation(storage, scope(ownerA))).toBeUndefined();
  });

  it("does not mint a new identity when a dispatched response fails DTO validation", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    const pending = await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-dto-recovery");
    markX402OperationRecovering(storage, scope(ownerA), pending.operation_id);
    const createAnother = () => { throw new Error("must not mint a replacement identity"); };
    await expect(reserve(locks, storage, scope(ownerA), createAnother)).resolves.toMatchObject({
      operation_id: pending.operation_id,
      phase: "recovering",
    });
  });

  it("distinguishes stop before dispatch from stream loss after acceptance", async () => {
    const storage = memoryStorage();
    const reserved = await reserve(new DeterministicLockManager(), storage, scope(ownerA), () => "x402-owner-a-operation-stop");
    // A pre-dispatch stop keeps the reusable identity reserved without claiming
    // settlement uncertainty.
    expect(loadPendingX402Operation(storage, scope(ownerA))).toMatchObject({
      operation_id: reserved.operation_id,
      phase: "reserved",
    });
    // Once dispatched, stop, timeout, or stream loss all converge on recovery
    // with the same key. Abort cannot prove that payment was cancelled.
    markX402OperationRecovering(storage, scope(ownerA), reserved.operation_id);
    expect(loadPendingX402Operation(storage, scope(ownerA))).toMatchObject({
      operation_id: reserved.operation_id,
      phase: "recovering",
    });
    completeX402Operation(storage, scope(ownerA), reserved.operation_id, LIVE_COMPLETE);
    expect(loadPendingX402Operation(storage, scope(ownerA))).toBeUndefined();
  });

  it("allows exactly one initial dispatch under a deterministic cross-tab interleaving", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const dispatched: string[] = [];
    const first = withLockedX402OperationDispatch(
      locks,
      storage,
      scope(ownerA),
      { createOperationId: () => "x402-owner-a-tab-one" },
      async (operation) => {
        dispatched.push(operation.operation_id);
        firstStarted();
        await release;
        completeX402Operation(storage, scope(ownerA), operation.operation_id, LIVE_COMPLETE);
      },
    );
    await started;
    const second = withLockedX402OperationDispatch(
      locks,
      storage,
      scope(ownerA),
      { createOperationId: () => "x402-owner-a-tab-two" },
      async (operation) => { dispatched.push(operation.operation_id); },
    );
    const contended = await second;
    expect(contended).toMatchObject({
      kind: "contended",
      operation: { operation_id: "x402-owner-a-tab-one" },
    });
    expect(dispatched).toEqual(["x402-owner-a-tab-one"]);
    releaseFirst();
    await first;
    let retryDispatches = 0;
    const replay = await withLockedX402OperationDispatch(
      locks,
      storage,
      scope(ownerA),
      {
        createOperationId: () => "x402-must-not-replace-winner",
        expectedOperationId: contended.operation.operation_id,
      },
      async () => { retryDispatches += 1; },
    );
    expect(replay).toMatchObject({
      kind: "completed",
      operation: {
        operation_id: "x402-owner-a-tab-one",
        terminal: LIVE_COMPLETE,
      },
    });
    expect(retryDispatches).toBe(0);
    expect(dispatched).toEqual(["x402-owner-a-tab-one"]);
    expect(loadPendingX402Operation(storage, scope(ownerA))).toBeUndefined();
  });

  it("reuses one durable identity in copied tabs and after reload", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    const original = await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-copied-tab");
    const copiedTab = await reserve(locks, storage, scope(ownerA), () => "x402-must-not-exist");
    const reloadedTab = await reserve(new DeterministicLockManager(), storage, scope(ownerA), () => "x402-also-must-not-exist");
    expect(copiedTab.operation_id).toBe(original.operation_id);
    expect(reloadedTab.operation_id).toBe(original.operation_id);
  });

  it("fails closed without Web Locks and never writes an operation record", async () => {
    const storage = memoryStorage();
    await expect(withLockedX402OperationDispatch(
      undefined,
      storage,
      scope(ownerA),
      { createOperationId: () => "x402-unsafe-no-lock" },
      async () => undefined,
    )).rejects.toThrow(/cannot safely lock/i);
    expect(storage.values.size).toBe(0);
  });

  it("retains a paid operation until journal recovery completes", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    const pending = await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-journal-recovery");
    markX402OperationJournalPending(storage, scope(ownerA), pending.operation_id);
    const replay = await reserve(
      locks,
      storage,
      scope(ownerA),
      () => { throw new Error("must not create a second paid operation"); },
      pending.operation_id,
    );
    expect(replay).toMatchObject({
      operation_id: pending.operation_id,
      phase: "paid_journal_pending",
    });
    expect(markX402OperationRecovering(storage, scope(ownerA), pending.operation_id).phase)
      .toBe("paid_journal_pending");
    completeX402Operation(storage, scope(ownerA), pending.operation_id, LIVE_COMPLETE);
    expect(loadPendingX402Operation(storage, scope(ownerA))).toBeUndefined();
  });

  it("does not create a replacement when a copied tab holds a stale recovery id", async () => {
    const storage = memoryStorage();
    const locks = new DeterministicLockManager();
    const pending = await reserve(locks, storage, scope(ownerA), () => "x402-owner-a-terminal");
    completeX402Operation(storage, scope(ownerA), pending.operation_id, LIVE_COMPLETE);
    let staleDispatches = 0;
    const completed = await withLockedX402OperationDispatch(
      locks,
      storage,
      scope(ownerA),
      {
        createOperationId: () => "x402-must-not-replace-terminal",
        expectedOperationId: pending.operation_id,
      },
      async () => { staleDispatches += 1; },
    );
    expect(completed).toMatchObject({ kind: "completed", operation: { operation_id: pending.operation_id } });
    expect(staleDispatches).toBe(0);
    expect(storage.values.size).toBe(1);

    const explicitNewPurchase = await reserve(
      locks,
      storage,
      scope(ownerA),
      () => "x402-explicit-new-purchase",
    );
    expect(explicitNewPurchase.operation_id).toBe("x402-explicit-new-purchase");
  });
});
