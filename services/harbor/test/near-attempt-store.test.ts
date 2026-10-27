import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  D1NearAttemptStore,
  type NearHostedArbitrumUsdcReceiptEvidence,
  type NearHostedEvidenceInput,
  type NearHostedNativeReconciliation,
  type NearHostedNativeRefundReceiptEvidence,
  type NearHostedNativeSourceFundingEvidence,
  type NearHostedNativeToArbitrumBinding,
  type NearHostedReserveInput,
} from "../src/near/attempt-store";

type SqlValue = string | number | bigint | null | Uint8Array;

class Coordinator {
  readonly sqlite = new DatabaseSync(":memory:");
  tail: Promise<void> = Promise.resolve();

  constructor(nativeLifecycle = true) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(readFileSync(
      new URL("../migrations/0018_near_attempt_store.sql", import.meta.url),
      "utf8",
    ));
    if (nativeLifecycle) {
      this.sqlite.exec(readFileSync(
        new URL("../migrations/0020_near_native_to_arbitrum_usdc_lifecycle.sql", import.meta.url),
        "utf8",
      ));
    }
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
const ARBITRUM_USDC_ASSET =
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" as const;
const ARBITRUM_USDC_CONTRACT = "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const;
const ARBITRUM_RECIPIENT = `0x${"1".repeat(40)}`;
const ARBITRUM_SENDER = `0x${"2".repeat(40)}`;
const ARBITRUM_TRANSACTION = `0x${"a".repeat(64)}`;
const SOURCE_TRANSACTION = "5".repeat(44);
const SOURCE_RECEIPT = "6".repeat(44);
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

function nativeReservation(input: Partial<NearHostedReserveInput> = {}): NearHostedReserveInput {
  return reservation({
    depositAddress: "native-deposit.near",
    depositMemo: undefined,
    assetId: ASSET,
    amountAtomic: ONE_NEAR_ATOMIC,
    budgetLimitAtomic: ONE_AND_HALF_NEAR_ATOMIC,
    ...input,
  });
}

function nativeBinding(
  input: Partial<NearHostedNativeToArbitrumBinding> = {},
): NearHostedNativeToArbitrumBinding {
  return {
    version: "pilot-near-native-to-arbitrum-usdc-hosted-binding-v1",
    accountId: "alice.near",
    approvalDigest: "B".repeat(64),
    quoteId: "quote-1",
    quoteHash: "4".repeat(44),
    correlationId: "quote-1",
    originAssetId: "nep141:wrap.near",
    originTokenContract: "wrap.near",
    amountIn: ONE_NEAR_ATOMIC,
    refundTo: "alice.near",
    depositAddress: "native-deposit.near",
    destinationAssetId: ARBITRUM_USDC_ASSET,
    destinationTokenContract: ARBITRUM_USDC_CONTRACT,
    destinationRecipient: ARBITRUM_RECIPIENT,
    minAmountOut: "500000",
    ...input,
  };
}

function sourceFunding(
  input: Partial<NearHostedNativeSourceFundingEvidence> = {},
): NearHostedNativeSourceFundingEvidence {
  return {
    version: "pilot-near-native-near-source-funding-v1",
    provenance: "near-rpc-finalized-native-transfer",
    network: "near:mainnet",
    transaction_hash: SOURCE_TRANSACTION,
    receipt_id: SOURCE_RECEIPT,
    block_height: 123,
    finality: "final",
    execution_status: "SUCCESS",
    source_account_id: "alice.near",
    receiver_account_id: "native-deposit.near",
    amount_yocto_near: ONE_NEAR_ATOMIC,
    included_at: "2026-11-01T00:01:00.000Z",
    verified_at: "2026-11-01T00:01:30.000Z",
    ...input,
  };
}

function arbitrumReceipt(
  input: Partial<NearHostedArbitrumUsdcReceiptEvidence> = {},
): NearHostedArbitrumUsdcReceiptEvidence {
  return {
    version: "pilot-near-arbitrum-canonical-usdc-receipt-v1",
    provenance: "arbitrum-rpc-finalized-erc20-transfer",
    chain: "arb",
    chain_id: 42161,
    transaction_hash: ARBITRUM_TRANSACTION,
    block_hash: `0x${"b".repeat(64)}`,
    block_number: 456,
    transaction_index: 1,
    log_index: 2,
    finality: "final",
    receipt_status: "success",
    event_signature: "Transfer(address,address,uint256)",
    token_contract: ARBITRUM_USDC_CONTRACT,
    token_decimals: 6,
    sender_address: ARBITRUM_SENDER,
    recipient_address: ARBITRUM_RECIPIENT,
    amount_received: "500000",
    verified_at: "2026-11-01T00:03:00.000Z",
    ...input,
  };
}

function refundReceipt(
  input: Partial<NearHostedNativeRefundReceiptEvidence> = {},
): NearHostedNativeRefundReceiptEvidence {
  return {
    version: "pilot-near-native-near-refund-receipt-v1",
    provenance: "near-rpc-finalized-refund",
    network: "near:mainnet",
    transaction_hash: "7".repeat(44),
    receipt_id: "8".repeat(44),
    block_height: 789,
    finality: "final",
    execution_status: "SUCCESS",
    refund_account_id: "alice.near",
    amount_refunded_yocto_near: ONE_NEAR_ATOMIC,
    verified_at: "2026-11-01T00:03:00.000Z",
    ...input,
  };
}

function nativeReconciliation(
  outcome: NearHostedNativeReconciliation["outcome"],
  input: Record<string, unknown> = {},
): NearHostedNativeReconciliation {
  const base = {
    version: "pilot-near-native-near-to-arbitrum-usdc-reconciliation-v1",
    quote_hash: "4".repeat(44),
    correlation_id: "quote-1",
    deposit_account_id: "native-deposit.near",
    deposit_memo_present: false,
    checked_at: "2026-11-01T00:03:30.000Z",
    safe_to_resubmit: false,
  } as const;
  if (outcome === "pending") {
    return { ...base, outcome, provider_status: "PROCESSING", ...input } as NearHostedNativeReconciliation;
  }
  if (outcome === "unknown") {
    return { ...base, outcome, reason: "timeout", ...input } as NearHostedNativeReconciliation;
  }
  if (outcome === "refunded") {
    return {
      ...base, outcome, provider_status: "REFUNDED", refund_receipt: refundReceipt(), ...input,
    } as NearHostedNativeReconciliation;
  }
  if (outcome === "failed") {
    return {
      ...base, outcome, provider_status: "FAILED", independent_terminal_evidence: false, ...input,
    } as NearHostedNativeReconciliation;
  }
  if (outcome === "provider-success-only") {
    return {
      ...base, outcome, provider_status: "SUCCESS", independent_destination_receipt: false, ...input,
    } as NearHostedNativeReconciliation;
  }
  return {
    ...base,
    outcome,
    provider_status: "SUCCESS",
    destination_receipt: arbitrumReceipt(),
    ...input,
  } as NearHostedNativeReconciliation;
}

function nativeTransition(
  evidenceValue: NearHostedNativeSourceFundingEvidence | NearHostedNativeReconciliation,
  revision: number,
  transitionId: string,
) {
  return {
    accountId: "alice.near",
    transitionId,
    expectedEntryRevision: revision,
    binding: nativeBinding(),
    evidence: evidenceValue,
  } as const;
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

describe("D1 hosted native NEAR to Arbitrum USDC lifecycle", () => {
  it("atomically binds finalized native source funding and replays only exact evidence", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    const admitted = await store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    expect(admitted).toEqual(expect.objectContaining({
      replay: false,
      attempt: expect.objectContaining({ state: "approved", reservationState: "reserved" }),
      lifecycle: expect.objectContaining({ lifecycleState: "reserved", lifecycleRevision: 0 }),
    }));
    await expect(store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding()))
      .resolves.toEqual(expect.objectContaining({ replay: true }));
    await expect(store.reserveNativeNearToArbitrum(
      nativeReservation(),
      nativeBinding({ destinationRecipient: `0x${"9".repeat(40)}` }),
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const transition = nativeTransition(sourceFunding(), 1, "source-funding-1");
    const recorded = await store.recordNativeNearToArbitrumEvidence("idempotency-1", transition);
    expect(recorded).toEqual(expect.objectContaining({
      replay: false,
      attempt: expect.objectContaining({
        state: "unknown", reservationState: "outcome_unknown", entryRevision: 2,
      }),
      lifecycle: expect.objectContaining({
        lifecycleState: "source_verified",
        sourceTransactionHash: SOURCE_TRANSACTION,
        lifecycleRevision: 1,
      }),
    }));
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    await expect(store.recordNativeNearToArbitrumEvidence("idempotency-1", transition))
      .resolves.toEqual(expect.objectContaining({ replay: true }));
    await expect(store.recordNativeNearToArbitrumEvidence("idempotency-1", {
      ...transition,
      binding: nativeBinding({ destinationRecipient: `0x${"9".repeat(40)}` }),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(store.recordNativeNearToArbitrumEvidence("idempotency-1", {
      ...transition,
      accountId: "mallory.near",
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(attemptStore(coordinator, "tenant-1", "principal-2")
      .recordNativeNearToArbitrumEvidence("idempotency-1", transition))
      .rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
  });

  it("rejects source funding that changes the approved account, deposit, or amount", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    await expect(store.recordNativeNearToArbitrumEvidence("idempotency-1", nativeTransition(
      sourceFunding({ receiver_account_id: "attacker.near" }), 1, "wrong-source-1",
    ))).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(store.recordNativeNearToArbitrumEvidence("idempotency-1", nativeTransition(
      sourceFunding({ amount_yocto_near: "999" }), 1, "wrong-amount-1",
    ))).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it.each([
    "pending",
    "unknown",
    "failed",
    "provider-success-only",
  ] as const)("rejects %s provider evidence before finalized native source funding", async (outcome) => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());

    await expect(store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(nativeReconciliation(outcome), 1, `premature-${outcome}`),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const retained = await store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    expect(retained).toEqual(expect.objectContaining({
      replay: true,
      attempt: expect.objectContaining({ state: "approved", reservationState: "reserved", entryRevision: 1 }),
      lifecycle: expect.objectContaining({ lifecycleState: "reserved", lifecycleRevision: 0 }),
    }));
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("rolls back the reservation when immutable binding admission fails", async () => {
    const coordinator = new Coordinator();
    coordinator.sqlite.exec(`CREATE TRIGGER reject_native_binding
      BEFORE INSERT ON near_native_to_arbitrum_usdc_lifecycles
      BEGIN SELECT RAISE(ABORT, 'simulated binding write failure'); END;`);
    const store = attemptStore(coordinator);
    await expect(store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding()))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await store.budgetConsumed(ASSET)).toBe("0");
    expect(coordinator.sqlite.prepare("SELECT count(*) AS count FROM near_hosted_attempts")
      .get()).toEqual({ count: 0 });
    expect(coordinator.sqlite.prepare("SELECT count(*) AS count FROM near_native_to_arbitrum_usdc_lifecycles")
      .get()).toEqual({ count: 0 });
  });

  it("refuses to attach a native route binding after a generic reservation", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserve(nativeReservation());
    await expect(store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(sourceFunding(), 1, "late-source-1"),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(coordinator.sqlite.prepare(
      "SELECT count(*) AS count FROM near_native_to_arbitrum_usdc_lifecycles",
    ).get()).toEqual({ count: 0 });
  });

  it("admits one atomic reservation+binding across competing Worker instances", async () => {
    const coordinator = new Coordinator();
    const barrier = oneShotBarrier();
    const storeA = attemptStore(coordinator, "tenant-1", "principal-1", { afterReservationRead: barrier });
    const storeB = attemptStore(coordinator, "tenant-1", "principal-1", { afterReservationRead: barrier });
    const [first, second] = await Promise.all([
      storeA.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding()),
      storeB.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding()),
    ]);
    expect([first.replay, second.replay].sort()).toEqual([false, true]);
    expect(await storeA.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
    expect(coordinator.sqlite.prepare(
      "SELECT count(*) AS count FROM near_native_to_arbitrum_usdc_lifecycles",
    ).get()).toEqual({ count: 1 });
  });

  it("keeps provider SUCCESS unknown until a finalized canonical USDC receipt commits", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    await store.recordNativeNearToArbitrumEvidence(
      "idempotency-1", nativeTransition(sourceFunding(), 1, "source-1"),
    );
    const provider = await store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(nativeReconciliation("provider-success-only", {
        checked_at: "2026-11-01T00:02:00.000Z",
      }), 2, "provider-success-1"),
    );
    expect(provider.attempt).toEqual(expect.objectContaining({
      state: "unknown", reservationState: "outcome_unknown", entryRevision: 3,
    }));
    expect(provider.lifecycle).toEqual(expect.objectContaining({
      lifecycleState: "provider_observed", lastProviderStatus: "SUCCESS",
    }));
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);

    const wrongRecipient = nativeReconciliation("independently-settled", {
      destination_receipt: arbitrumReceipt({ recipient_address: `0x${"9".repeat(40)}` }),
    });
    await expect(store.recordNativeNearToArbitrumEvidence(
      "idempotency-1", nativeTransition(wrongRecipient, 3, "wrong-destination-1"),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const settled = await store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(nativeReconciliation("independently-settled"), 3, "destination-1"),
    );
    expect(settled.attempt).toEqual(expect.objectContaining({
      state: "settled", reservationState: "committed", providerStatus: "SUCCESS",
    }));
    expect(settled.lifecycle.lifecycleState).toBe("destination_verified");
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("keeps provider failure held and releases only an exact finalized NEAR refund", async () => {
    const coordinator = new Coordinator();
    const store = attemptStore(coordinator);
    await store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    await store.recordNativeNearToArbitrumEvidence(
      "idempotency-1", nativeTransition(sourceFunding(), 1, "source-1"),
    );
    const providerFailure = await store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(nativeReconciliation("failed", {
        checked_at: "2026-11-01T00:02:00.000Z",
      }), 2, "provider-failure-1"),
    );
    expect(providerFailure.attempt.reservationState).toBe("outcome_unknown");
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);

    await expect(store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(nativeReconciliation("refunded", {
        refund_receipt: refundReceipt({ amount_refunded_yocto_near: "999" }),
      }), 3, "wrong-refund-1"),
    )).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const refunded = await store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(nativeReconciliation("refunded"), 3, "refund-1"),
    );
    expect(refunded.attempt).toEqual(expect.objectContaining({
      state: "refunded", reservationState: "released", providerStatus: "REFUNDED",
    }));
    expect(await store.budgetConsumed(ASSET)).toBe("0");
  });

  it("uses cross-Worker CAS so one same-revision observation wins", async () => {
    const coordinator = new Coordinator();
    const baseline = attemptStore(coordinator);
    await baseline.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    await baseline.recordNativeNearToArbitrumEvidence(
      "idempotency-1", nativeTransition(sourceFunding(), 1, "source-1"),
    );
    const barrier = oneShotBarrier();
    const storeA = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReconciliationRead: barrier,
    });
    const storeB = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReconciliationRead: barrier,
    });
    const outcomes = await Promise.allSettled([
      storeA.recordNativeNearToArbitrumEvidence(
        "idempotency-1",
        nativeTransition(nativeReconciliation("pending", {
          checked_at: "2026-11-01T00:02:00.000Z",
        }), 2, "pending-race"),
      ),
      storeB.recordNativeNearToArbitrumEvidence(
        "idempotency-1",
        nativeTransition(nativeReconciliation("unknown", {
          checked_at: "2026-11-01T00:02:00.000Z",
        }), 2, "unknown-race"),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "VERSION_CONFLICT" }) })]);
    expect(await baseline.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("rejects a stale-read provider SUCCESS racing finalized source funding", async () => {
    const coordinator = new Coordinator();
    const baseline = attemptStore(coordinator);
    await baseline.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    const barrier = oneShotBarrier();
    const sourceWorker = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReconciliationRead: barrier,
    });
    const providerWorker = attemptStore(coordinator, "tenant-1", "principal-1", {
      afterReconciliationRead: barrier,
    });

    const [sourceResult, providerResult] = await Promise.allSettled([
      sourceWorker.recordNativeNearToArbitrumEvidence(
        "idempotency-1",
        nativeTransition(sourceFunding(), 1, "source-race"),
      ),
      providerWorker.recordNativeNearToArbitrumEvidence(
        "idempotency-1",
        nativeTransition(nativeReconciliation("provider-success-only", {
          checked_at: "2026-11-01T00:02:00.000Z",
        }), 1, "premature-provider-success-race"),
      ),
    ]);

    expect(sourceResult).toEqual(expect.objectContaining({ status: "fulfilled" }));
    expect(providerResult).toEqual(expect.objectContaining({
      status: "rejected",
      reason: expect.objectContaining({ code: "INVALID_TRANSITION" }),
    }));
    const retained = await baseline.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding());
    expect(retained).toEqual(expect.objectContaining({
      replay: true,
      attempt: expect.objectContaining({ state: "unknown", reservationState: "outcome_unknown", entryRevision: 2 }),
      lifecycle: expect.objectContaining({
        lifecycleState: "source_verified",
        lifecycleRevision: 1,
      }),
    }));
    expect(retained.lifecycle).not.toHaveProperty("lastProviderStatus");
    expect(await baseline.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });

  it("fails closed when forward schema 0020 is unavailable", async () => {
    const coordinator = new Coordinator(false);
    const store = attemptStore(coordinator);
    await expect(store.reserveNativeNearToArbitrum(nativeReservation(), nativeBinding()))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await store.reserve(nativeReservation());
    await expect(store.recordNativeNearToArbitrumEvidence(
      "idempotency-1",
      nativeTransition(sourceFunding(), 1, "source-1"),
    )).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await store.budgetConsumed(ASSET)).toBe(ONE_NEAR_ATOMIC);
  });
});
