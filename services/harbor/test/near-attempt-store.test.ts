import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  D1NearAttemptStore,
  type NearHostedEvidenceInput,
  type NearHostedReserveInput,
} from "../src/near/attempt-store";

type SqlValue = string | number | bigint | null | Uint8Array;

class Coordinator {
  readonly sqlite = new DatabaseSync(":memory:");
  tail: Promise<void> = Promise.resolve();

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0018_near_attempt_store.sql", import.meta.url),
      "utf8",
    ));
  }
}

class Statement {
  #values: SqlValue[] = [];

  constructor(
    readonly statement: StatementSync,
    readonly query: boolean,
  ) {}

  bind(...values: unknown[]): this {
    this.#values = values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue);
    return this;
  }

  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.#values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.#values) ?? null) as T | null;
  }

  execute(): D1Result {
    if (this.query) {
      return {
        success: true,
        results: this.statement.all(...this.#values),
        meta: { changes: 0 },
      } as unknown as D1Result;
    }
    const result = this.statement.run(...this.#values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
  }
}

class WorkerD1 {
  constructor(readonly coordinator: Coordinator) {}

  prepare(sql: string): Statement {
    return new Statement(
      this.coordinator.sqlite.prepare(sql),
      /^\s*(?:SELECT|WITH\s)/iu.test(sql),
    );
  }

  async batch(statements: Statement[]): Promise<D1Result[]> {
    const previous = this.coordinator.tail;
    let release!: () => void;
    this.coordinator.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.coordinator.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.coordinator.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.coordinator.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}

function d1(coordinator: Coordinator): D1Database {
  return new WorkerD1(coordinator) as unknown as D1Database;
}

function oneShotBarrier(parties = 2): () => Promise<void> {
  let arrivals = 0;
  let released = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    if (released) return;
    arrivals += 1;
    if (arrivals >= parties) {
      released = true;
      release();
    }
    await gate;
  };
}

const ONE_NEAR_ATOMIC = "1000000000000000000000000";
const ONE_AND_HALF_NEAR_ATOMIC = "1500000000000000000000000";
const ASSET = "nep141:wrap.near";
const TEST_NOW = Date.parse("2026-11-01T00:04:00.000Z");

function attemptStore(
  coordinator: Coordinator,
  tenantId = "tenant-1",
  principalId = "principal-1",
  dependencies: ConstructorParameters<typeof D1NearAttemptStore>[3] = {},
): D1NearAttemptStore {
  return new D1NearAttemptStore(d1(coordinator), tenantId, principalId, {
    now: () => TEST_NOW,
    ...dependencies,
  });
}

function reservation(input: Partial<NearHostedReserveInput> = {}): NearHostedReserveInput {
  return {
    accountId: "alice.near",
    authorizationId: "authorization-1",
    authorizationExpiresAt: "2026-11-01T00:05:00.000Z",
    idempotencyVersion: "pilot-near-idempotency-v1",
    idempotencyKey: "idempotency-1",
    requestDigest: "A".repeat(64),
    requestFingerprint: "A".repeat(64),
    attemptId: "attempt-1",
    reservationId: "reservation-1",
    approvalDigest: "B".repeat(64),
    policyDigest: "C".repeat(64),
    quoteId: "quote-1",
    quoteHash: "4".repeat(44),
    depositAddress: "provider-deposit.near",
    depositMemo: "route-123",
    assetId: ASSET,
    amountAtomic: ONE_NEAR_ATOMIC,
    budgetLimitAtomic: ONE_AND_HALF_NEAR_ATOMIC,
    artifactKind: "provider_verified_executable_quote",
    providerSignatureVerified: true,
    approvalExpiresAt: "2026-11-01T00:05:00.000Z",
    providerDeadlineAt: "2026-11-01T00:10:00.000Z",
    createdAt: "2026-11-01T00:00:01.000Z",
    ...input,
  };
}

function distinctReservation(index: number, input: Partial<NearHostedReserveInput> = {}) {
  const digest = String.fromCharCode(65 + index).repeat(64);
  return reservation({
    idempotencyKey: `idempotency-${index}`,
    requestDigest: digest,
    requestFingerprint: digest,
    attemptId: `attempt-${index}`,
    reservationId: `reservation-${index}`,
    quoteId: `quote-${index}`,
    ...input,
  });
}

function evidence(
  outcome: NearHostedEvidenceInput["outcome"],
  input: Partial<NearHostedEvidenceInput> = {},
): NearHostedEvidenceInput {
  return {
    transitionId: `${outcome}-1`,
    expectedEntryRevision: 1,
    checkedAt: "2026-11-01T00:01:00.000Z",
    depositAddress: "provider-deposit.near",
    depositMemo: "route-123",
    outcome,
    ...(outcome === "unknown" ? { unknownReason: "timeout" as const } : {}),
    ...(outcome === "pending" ? { providerStatus: "PROCESSING" as const } : {}),
    ...(outcome === "terminal" ? {
      providerStatus: "SUCCESS" as const,
      evidenceDigest: "E".repeat(64),
    } : {}),
    safeToResubmit: false,
    ...input,
  };
}

describe("D1 hosted NEAR attempt reservation", () => {
  it("keeps arbitrary-precision atomic accounting exact without SQLite numeric casts", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await expect(store.reserve(reservation())).resolves.toEqual(expect.objectContaining({ replay: false }));
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    await expect(store.reserve(distinctReservation(2)))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("admits only one separately instantiated Worker under stale-read contention", async () => {
    const coordinator = new Coordinator();
    const barrier = oneShotBarrier();
    const storeA = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReservationRead: barrier,
    });
    const storeB = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReservationRead: barrier,
    });
    const results = await Promise.allSettled([
      storeA.reserve(distinctReservation(1)),
      storeB.reserve(distinctReservation(2)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "BUDGET_EXCEEDED" }) })]);
    expect(await storeA.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("replays an exact concurrent key once and rejects a conflicting digest", async () => {
    const coordinator = new Coordinator();
    const barrier = oneShotBarrier();
    const exact = reservation();
    const stores = [
      attemptStore(coordinator, "tenant-1", "principal-1", { afterReservationRead: barrier }),
      attemptStore(coordinator, "tenant-1", "principal-1", { afterReservationRead: barrier }),
    ];
    const [first, second] = await Promise.all([
      stores[0]!.reserve(exact),
      stores[1]!.reserve(exact),
    ]);
    expect([first.replay, second.replay].sort()).toEqual([false, true]);
    expect(await stores[0]!.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    await expect(stores[0]!.reserve({
      ...exact,
      requestDigest: "F".repeat(64),
      requestFingerprint: "F".repeat(64),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(stores[0]!.reserve({
      ...exact,
      authorizationExpiresAt: "2026-11-01T00:04:00.000Z",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("uses the trusted Worker clock for first admission while retaining exact replay", async () => {
    const coordinator = new Coordinator();
    const live = attemptStore(coordinator);
    const exact = reservation();
    await expect(live.reserve(exact)).resolves.toEqual(expect.objectContaining({ replay: false }));

    const afterExpiry = attemptStore(coordinator, "tenant-1", "principal-1", {
      now: () => Date.parse("2026-11-01T00:06:00.000Z"),
    });
    await expect(afterExpiry.reserve(exact))
      .resolves.toEqual(expect.objectContaining({ replay: true }));
    await expect(afterExpiry.reserve(distinctReservation(2)))
      .rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
  });

  it("scopes budgets by tenant and principal but not by wallet account", async () => {
    const coordinator = new Coordinator();
    const tenantOne = attemptStore(coordinator);
    const tenantTwo = attemptStore(coordinator, "tenant-2");
    await tenantOne.reserve(reservation());
    await expect(tenantOne.reserve(distinctReservation(2, { accountId: "bob.near" })))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(tenantTwo.reserve(reservation())).resolves.toEqual(expect.objectContaining({ replay: false }));
    expect(await tenantOne.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    expect(await tenantTwo.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it.each(["dry_quote", "fixture"] as const)("never reserves a %s artifact", async (artifactKind) => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await expect(store.reserve(reservation({ artifactKind })))
      .rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect(await store.budgetConsumed(ASSET)).toBe("0");
  });
});

describe("D1 hosted NEAR attempt reconciliation", () => {
  it("preserves unknown and pending budget after a provider-reported refund", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserve(reservation());
    const unknown = await store.reconcile("idempotency-1", evidence("unknown"));
    expect(unknown.attempt).toEqual(expect.objectContaining({ state: "unknown", reservationState: "outcome_unknown" }));
    await expect(store.reserve(distinctReservation(2)))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    const pending = await store.reconcile("idempotency-1", evidence("pending", {
      transitionId: "pending-1",
      expectedEntryRevision: 2,
      checkedAt: "2026-11-01T00:02:00.000Z",
    }));
    expect(pending.attempt).toEqual(expect.objectContaining({
      state: "pending", reservationState: "outcome_unknown", reservationRevision: 2,
    }));
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);

    const refunded = await store.reconcile("idempotency-1", evidence("terminal", {
      transitionId: "refund-1",
      expectedEntryRevision: 3,
      checkedAt: "2026-11-01T00:03:00.000Z",
      providerStatus: "REFUNDED",
    }));
    expect(refunded.attempt).toEqual(expect.objectContaining({
      state: "unknown",
      reservationState: "outcome_unknown",
    }));
    expect(refunded.attempt.providerStatus).toBeUndefined();
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    await expect(store.reserve(distinctReservation(2)))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it.each(["SUCCESS", "REFUNDED", "FAILED"] as const)(
    "keeps provider %s nonterminal even when accompanied by an arbitrary digest",
    async (providerStatus) => {
      const coordinator = new Coordinator();
      const store = attemptStore(coordinator);
      await store.reserve(reservation());
      await store.reconcile("idempotency-1", evidence("unknown"));
      const observed = await store.reconcile("idempotency-1", evidence("terminal", {
        transitionId: `provider-${providerStatus.toLowerCase()}`,
        expectedEntryRevision: 2,
        checkedAt: "2026-11-01T00:02:00.000Z",
        providerStatus,
        evidenceDigest: "F".repeat(64),
      }));
      expect(observed.attempt).toEqual(expect.objectContaining({
        state: "unknown",
        reservationState: "outcome_unknown",
        entryRevision: 3,
      }));
      expect(observed.attempt.providerStatus).toBeUndefined();
      expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    },
  );

  it("uses entry revision CAS so only one separate Worker can resolve an unknown attempt", async () => {
    const coordinator = new Coordinator();
    const baseline = attemptStore(coordinator);
    await baseline.reserve(reservation());
    await baseline.reconcile("idempotency-1", evidence("unknown"));
    const barrier = oneShotBarrier();
    const storeA = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReconciliationRead: barrier,
    });
    const storeB = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReconciliationRead: barrier,
    });
    const results = await Promise.allSettled([
      storeA.reconcile("idempotency-1", evidence("terminal", {
        transitionId: "success-race", expectedEntryRevision: 2,
        checkedAt: "2026-11-01T00:02:00.000Z",
      })),
      storeB.reconcile("idempotency-1", evidence("terminal", {
        transitionId: "refund-race", expectedEntryRevision: 2,
        checkedAt: "2026-11-01T00:02:00.000Z", providerStatus: "REFUNDED",
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "VERSION_CONFLICT" }) })]);
    const winner = results.find((result) => result.status === "fulfilled");
    const attempt = winner?.status === "fulfilled" ? winner.value.attempt : undefined;
    expect(attempt).toEqual(expect.objectContaining({
      state: "unknown",
      reservationState: "outcome_unknown",
    }));
    expect(await baseline.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("replays exact transition evidence and rejects a changed reuse", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserve(reservation());
    const transition = evidence("unknown");
    await expect(store.reconcile("idempotency-1", transition))
      .resolves.toEqual(expect.objectContaining({ replay: false }));
    await expect(store.reconcile("idempotency-1", transition))
      .resolves.toEqual(expect.objectContaining({ replay: true }));
    await expect(store.reconcile("idempotency-1", { ...transition, unknownReason: "not_found" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects reconciliation timestamps that move backward or exceed the trusted clock", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserve(reservation());
    await store.reconcile("idempotency-1", evidence("unknown"));

    await expect(store.reconcile("idempotency-1", evidence("pending", {
      transitionId: "backdated",
      expectedEntryRevision: 2,
      checkedAt: "2026-11-01T00:00:30.000Z",
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.reconcile("idempotency-1", evidence("pending", {
      transitionId: "future",
      expectedEntryRevision: 2,
      checkedAt: "2026-11-01T00:05:00.000Z",
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
