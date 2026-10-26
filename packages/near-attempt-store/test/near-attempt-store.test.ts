import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NEAR_ARBITRUM_USDC_ASSET_ID,
  NEAR_ARBITRUM_USDC_CONTRACT,
  computeNearApprovalDigest,
  type NearApprovalBinding,
} from "@pilot/contracts/near";
import { afterEach, describe, expect, it } from "vitest";

import {
  LocalFileNearAttemptPersistence,
  MemoryNearAttemptPersistence,
  NearAttemptStore,
  computeNearAttemptRequestDigest,
  type LocalFileFaultPhase,
  type NearAttemptEntry,
  type NearReserveAttemptInput,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const OWNER_SOURCE = `0x${"1".repeat(40)}`;
const DEPOSIT_ADDRESS = `0x${"2".repeat(40)}`;
const FUNDING_TRANSACTION = `0x${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

type InputOverrides = Readonly<{
  attempt_id?: string;
  reservation_id?: string;
  idempotency_key?: string;
  amount_atomic?: string;
  budget_limit_atomic?: string;
  artifact_kind?: NearReserveAttemptInput["artifact_kind"];
  account_id?: string;
  request_digest?: string;
}>;

async function input(overrides: InputOverrides = {}): Promise<NearReserveAttemptInput> {
  const idempotencyKey = overrides.idempotency_key ?? "idempotency-1";
  const accountId = overrides.account_id ?? "alice.near";
  const amount = overrides.amount_atomic ?? "60";
  const approval: NearApprovalBinding = {
    version: "pilot-near-1click-approval-v2",
    principal_id: "principal-1",
    account_id: accountId,
    network: "near:mainnet",
    idempotency_version: "pilot-near-idempotency-v1",
    idempotency_key: idempotencyKey,
    policy_digest: "A".repeat(64),
    quote_id: `quote-${overrides.attempt_id ?? "1"}`,
    quote_hash: "4".repeat(44),
    provider_signature_verified: true,
    origin_asset: NEAR_ARBITRUM_USDC_ASSET_ID,
    destination_asset: "nep141:wrap.near",
    amount_in: amount,
    min_amount_out: "50",
    recipient: "recipient.near",
    refund_to: OWNER_SOURCE,
    deposit_address: DEPOSIT_ADDRESS,
    approval_expires_at: "2026-11-01T00:05:00.000Z",
    provider_deadline_at: "2026-11-01T00:10:00.000Z",
  };
  const payload = {
    artifact_kind: "provider_verified_executable_quote" as const,
    authorization: {
      version: "pilot-near-principal-authorization-v1",
      authorization_id: "authorization-1",
      principal_id: "principal-1",
      account_id: accountId,
      network: "near:mainnet",
      operations: ["near.intents.approval.review"],
      issued_at: "2026-11-01T00:00:00.000Z",
      expires_at: "2026-11-01T00:05:00.000Z",
    },
    approval,
    approval_digest: await computeNearApprovalDigest(approval),
    attempt_id: overrides.attempt_id ?? "attempt-1",
    reservation_id: overrides.reservation_id ?? "reservation-1",
    asset_id: approval.origin_asset,
    amount_atomic: amount,
    budget_limit_atomic: overrides.budget_limit_atomic ?? "100",
  };
  const executableDigest = await computeNearAttemptRequestDigest(payload);
  return {
    ...payload,
    artifact_kind: overrides.artifact_kind ?? payload.artifact_kind,
    idempotency: {
      version: "pilot-near-idempotency-v1",
      principal_id: "principal-1",
      account_id: accountId,
      network: "near:mainnet",
      idempotency_key: idempotencyKey,
      request_digest: overrides.request_digest ?? executableDigest,
      created_at: "2026-11-01T00:00:01.000Z",
    },
  };
}

function unknownEvidence(entry: NearAttemptEntry, checkedAt = "2026-11-01T00:01:00.000Z") {
  return {
    version: "pilot-near-reconciliation-v1",
    outcome: "unknown",
    attempt_id: entry.attempt.attempt_id,
    principal_id: entry.attempt.principal_id,
    account_id: entry.attempt.account_id,
    network: entry.attempt.network,
    checked_at: checkedAt,
    deposit_address: entry.approval.deposit_address,
    deposit_memo: entry.approval.deposit_memo,
    reason: "timeout",
    safe_to_resubmit: false,
  } as const;
}

function providerEvidence(
  entry: NearAttemptEntry,
  providerStatus: "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED",
  checkedAt: string,
) {
  return {
    version: "pilot-near-reconciliation-v1",
    outcome: providerStatus === "PROCESSING" ? "pending" : "terminal",
    attempt_id: entry.attempt.attempt_id,
    principal_id: entry.attempt.principal_id,
    account_id: entry.attempt.account_id,
    network: entry.attempt.network,
    checked_at: checkedAt,
    deposit_address: entry.approval.deposit_address,
    deposit_memo: entry.approval.deposit_memo,
    provider_status: providerStatus,
    evidence_digest: "E".repeat(64),
    safe_to_resubmit: false,
  } as const;
}

function ownerFunding(reportedAt = "2026-11-01T00:00:02.000Z") {
  return {
    version: "pilot-near-arbitrum-usdc-owner-funding-v1",
    provenance: "owner-reported",
    independently_verified: false,
    funding_mode: "manual-owner-wallet-send",
    chain: "arb",
    chain_id: 42161,
    token_contract: NEAR_ARBITRUM_USDC_CONTRACT,
    token_decimals: 6,
    transaction_hash: FUNDING_TRANSACTION,
    source_address: OWNER_SOURCE,
    deposit_address: DEPOSIT_ADDRESS,
    amount_in: "60",
    reported_at: reportedAt,
  } as const;
}

function originReceipt(
  outcome: "funding-confirmed" | "funding-failed" | "refund-confirmed" = "funding-confirmed",
  verifiedAt = "2026-11-01T00:00:03.000Z",
) {
  const base = {
    version: "pilot-near-arbitrum-usdc-origin-receipt-v1",
    provenance: "origin-chain-verified",
    verification_source: "arbitrum-rpc-transaction-receipt",
    chain: "arb",
    chain_id: 42161,
    token_contract: NEAR_ARBITRUM_USDC_CONTRACT,
    token_decimals: 6,
    funding_transaction_hash: FUNDING_TRANSACTION,
    source_address: OWNER_SOURCE,
    deposit_address: DEPOSIT_ADDRESS,
    amount_in: "60",
    block_number: 123,
    block_hash: `0x${"b".repeat(64)}`,
    verified_at: verifiedAt,
  } as const;
  return outcome === "refund-confirmed" ? {
    ...base,
    outcome,
    receipt_status: "success" as const,
    refund_transaction_hash: `0x${"c".repeat(64)}`,
    refund_to: OWNER_SOURCE,
    refunded_amount: "60",
  } : {
    ...base,
    outcome,
    receipt_status: outcome === "funding-confirmed" ? "success" as const : "failed" as const,
  };
}

function settlement(
  providerStatus: "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED",
  checkedAt: string,
  independentlyVerified = false,
) {
  const base = {
    version: "pilot-near-arbitrum-usdc-to-wnear-settlement-v1",
    correlation_id: "quote-1",
    quote_hash: "4".repeat(44),
    nested_quote_signature_verified: true,
    deposit_address: DEPOSIT_ADDRESS,
    deposit_memo_present: false,
    provider_status: providerStatus,
    provider_checked_at: checkedAt,
    safe_to_resubmit: false,
  } as const;
  return independentlyVerified ? {
    ...base,
    evidence_level: "independent-destination-receipt" as const,
    independent_destination_receipt: {
      source: "near-rpc-final-receipt" as const,
      network: "near:mainnet" as const,
      receipt_id: "5".repeat(44),
      transaction_hash: "6".repeat(44),
      block_height: 456,
      execution_status: "SUCCESS" as const,
      recipient: "recipient.near",
      token_contract: "wrap.near" as const,
      asset_id: "nep141:wrap.near" as const,
      token_decimals: 24 as const,
      amount_received: "50",
      verified_at: checkedAt,
    },
  } : {
    ...base,
    evidence_level: "provider-reported-only" as const,
    independent_destination_receipt: false as const,
  };
}

function fundingTransition(
  evidence: unknown,
  revision: number,
  transitionId: string,
) {
  return {
    principal_id: "principal-1",
    account_id: "alice.near",
    idempotency_key: "idempotency-1",
    transition_id: transitionId,
    expected_entry_revision: revision,
    evidence,
  };
}

async function localFile(
  faultInjector?: (phase: LocalFileFaultPhase) => void | Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pilot-near-attempt-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "attempts.json");
  return { path, persistence: new LocalFileNearAttemptPersistence(path, { faultInjector }) };
}

describe("NEAR durable attempt safety", () => {
  it.each(["dry_quote", "fixture"] as const)("never treats a %s artifact as executable", async (artifactKind) => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    await expect(store.reserve(await input({ artifact_kind: artifactKind })))
      .rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
    expect((await store.snapshot()).entries).toHaveLength(0);
  });

  it("rejects an unverified provider quote and mismatched principal account", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    const unverified = await input();
    await expect(store.reserve({
      ...unverified,
      approval: { ...(unverified.approval as object), provider_signature_verified: false },
    }))
      .rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    const mismatched = await input();
    await expect(store.reserve({
      ...mismatched,
      idempotency: { ...(mismatched.idempotency as object), account_id: "mallory.near" },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects expired principal authority and terminal claims without durable evidence", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    const expired = await input();
    await expect(store.reserve({
      ...expired,
      authorization: { ...(expired.authorization as object), expires_at: "2026-11-01T00:00:01.000Z" },
    })).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });

    const reserved = await store.reserve(await input());
    const unknown = await store.recordOutcomeUnknown({
      principal_id: "principal-1", idempotency_key: "idempotency-1", transition_id: "unknown-1",
      expected_entry_revision: 1, evidence: unknownEvidence(reserved.entry),
    });
    const terminal = providerEvidence(unknown.entry, "REFUNDED", "2026-11-01T00:02:00.000Z");
    const { evidence_digest: _removed, ...withoutEvidenceDigest } = terminal;
    await expect(store.reconcile({
      principal_id: "principal-1", idempotency_key: "idempotency-1", transition_id: "refund-1",
      expected_entry_revision: 2, evidence: withoutEvidenceDigest,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ unknown_atomic: "60" }));
  });

  it("atomically permits only one concurrent reservation within the budget", async () => {
    const persistence = new MemoryNearAttemptPersistence();
    const storeA = new NearAttemptStore(persistence);
    const storeB = new NearAttemptStore(persistence);
    const outcomes = await Promise.allSettled([
      storeA.reserve(await input()),
      storeB.reserve(await input({
        attempt_id: "attempt-2", reservation_id: "reservation-2", idempotency_key: "idempotency-2",
      })),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "BUDGET_EXCEEDED" }) })]);
    expect(await storeA.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "60" }));
  });

  it("replays the exact versioned request but rejects key reuse with another digest", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    const exact = await input();
    const first = await store.reserve(exact);
    await expect(store.reserve(exact)).resolves.toEqual({ replay: true, entry: first.entry });
    await expect(store.reserve({
      ...exact,
      idempotency: { ...(exact.idempotency as object), request_digest: "F".repeat(64) },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("preserves unknown budget through pending status and releases only on terminal refund evidence", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    const reserved = await store.reserve(await input());
    const unknown = await store.recordOutcomeUnknown({
      principal_id: "principal-1",
      idempotency_key: "idempotency-1",
      transition_id: "unknown-1",
      expected_entry_revision: 1,
      evidence: unknownEvidence(reserved.entry),
    });
    expect(unknown.entry.reservation.state).toBe("outcome_unknown");
    expect(await store.replayDecision("principal-1", "idempotency-1"))
      .toEqual(expect.objectContaining({ action: "blocked_unknown", safe_to_resubmit: false }));
    await expect(store.reserve(await input({
      attempt_id: "attempt-2", reservation_id: "reservation-2", idempotency_key: "idempotency-2", amount_atomic: "50",
    }))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    await expect(store.reconcile({
      principal_id: "principal-1",
      idempotency_key: "idempotency-1",
      transition_id: "status-stale",
      expected_entry_revision: 1,
      evidence: providerEvidence(unknown.entry, "PROCESSING", "2026-11-01T00:02:00.000Z"),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const pending = await store.reconcile({
      principal_id: "principal-1",
      idempotency_key: "idempotency-1",
      transition_id: "status-1",
      expected_entry_revision: 2,
      evidence: providerEvidence(unknown.entry, "PROCESSING", "2026-11-01T00:02:00.000Z"),
    });
    expect(pending.entry.reservation.state).toBe("outcome_unknown");
    expect(await store.replayDecision("principal-1", "idempotency-1"))
      .toEqual(expect.objectContaining({ action: "poll_existing" }));
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ unknown_atomic: "60", consumed_atomic: "60" }));

    const refunded = await store.reconcile({
      principal_id: "principal-1",
      idempotency_key: "idempotency-1",
      transition_id: "status-2",
      expected_entry_revision: 3,
      evidence: providerEvidence(pending.entry, "REFUNDED", "2026-11-01T00:03:00.000Z"),
    });
    expect(refunded.entry.reservation.state).toBe("released");
    await expect(store.reserve(await input({
      attempt_id: "attempt-2", reservation_id: "reservation-2", idempotency_key: "idempotency-2", amount_atomic: "50",
    }))).resolves.toEqual(expect.objectContaining({ replay: false }));
  });

  it("keeps successful value committed and enforces revisioned transition idempotency", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    const reserved = await store.reserve(await input());
    const unknown = await store.recordOutcomeUnknown({
      principal_id: "principal-1", idempotency_key: "idempotency-1", transition_id: "unknown-1",
      expected_entry_revision: 1, evidence: unknownEvidence(reserved.entry),
    });
    const transition = {
      principal_id: "principal-1", idempotency_key: "idempotency-1", transition_id: "success-1",
      expected_entry_revision: 2,
      evidence: providerEvidence(unknown.entry, "SUCCESS", "2026-11-01T00:02:00.000Z"),
    };
    const settled = await store.reconcile(transition);
    expect(settled.entry.reservation.state).toBe("committed");
    await expect(store.reconcile(transition)).resolves.toEqual({ replay: true, entry: settled.entry });
    await expect(store.reconcile({ ...transition, evidence: providerEvidence(unknown.entry, "FAILED", "2026-11-01T00:02:00.000Z") }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ committed_atomic: "60", consumed_atomic: "60" }));
  });
});

describe("NEAR local owner-funded lifecycle", () => {
  it("binds the exact manual funding transaction and denies identity or replay drift", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    await store.reserve(await input());
    const report = fundingTransition(ownerFunding(), 1, "funding-report-1");
    const recorded = await store.recordOwnerFundingEvidence(report);
    expect(recorded.entry.owner_funding).toMatchObject({
      status: "outcome_unknown",
      binding: {
        chain_id: 42161,
        token_contract: NEAR_ARBITRUM_USDC_CONTRACT,
        source_address: OWNER_SOURCE,
        transaction_hash: FUNDING_TRANSACTION,
        amount_in: "60",
        deposit_address: DEPOSIT_ADDRESS,
      },
    });
    await expect(store.recordOwnerFundingEvidence(report))
      .resolves.toEqual({ replay: true, entry: recorded.entry });
    await expect(store.recordOwnerFundingEvidence({ ...report, account_id: "mallory.near" }))
      .rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    await expect(store.recordOwnerFundingEvidence({ ...report, principal_id: "principal-2" }))
      .rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
    await expect(store.recordOwnerFundingEvidence({
      ...report,
      evidence: { ...ownerFunding(), transaction_hash: `0x${"d".repeat(64)}` },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await store.replayDecision("principal-1", "idempotency-1"))
      .toEqual(expect.objectContaining({ action: "blocked_unknown", safe_to_resubmit: false }));
  });

  it("keeps provider SUCCESS nonterminal until an independent destination receipt", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    await store.reserve(await input());
    await store.recordOwnerFundingEvidence(fundingTransition(ownerFunding(), 1, "funding-1"));
    await store.recordOwnerFundingEvidence(fundingTransition(
      originReceipt(), 2, "origin-1",
    ));
    const provider = await store.recordOwnerFundingEvidence(fundingTransition(
      settlement("SUCCESS", "2026-11-01T00:00:04.000Z"), 3, "provider-1",
    ));
    expect(provider.entry.owner_funding?.status).toBe("provider_observed");
    expect(provider.entry.attempt.state).toBe("unknown");
    expect(provider.entry.reservation.state).toBe("outcome_unknown");
    expect(await store.replayDecision("principal-1", "idempotency-1"))
      .toEqual(expect.objectContaining({ action: "blocked_unknown", safe_to_resubmit: false }));

    const settled = await store.recordOwnerFundingEvidence(fundingTransition(
      settlement("SUCCESS", "2026-11-01T00:00:05.000Z", true), 4, "destination-1",
    ));
    expect(settled.entry.owner_funding?.status).toBe("destination_chain_verified");
    expect(settled.entry.attempt.state).toBe("settled");
    expect(settled.entry.reservation.state).toBe("committed");
  });

  it("retains ambiguous provider refund/failure and releases only on matching origin evidence", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    await store.reserve(await input());
    await store.recordOwnerFundingEvidence(fundingTransition(ownerFunding(), 1, "funding-1"));
    const observed = await store.recordOwnerFundingEvidence(fundingTransition(
      settlement("REFUNDED", "2026-11-01T00:00:03.000Z"), 2, "provider-refund-1",
    ));
    expect(observed.entry.reservation.state).toBe("outcome_unknown");
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "60" }));
    const refunded = await store.recordOwnerFundingEvidence(fundingTransition(
      originReceipt("refund-confirmed", "2026-11-01T00:00:04.000Z"), 3, "origin-refund-1",
    ));
    expect(refunded.entry.attempt.state).toBe("refunded");
    expect(refunded.entry.reservation.state).toBe("released");
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "0" }));
  });

  it("retains a provider-reported failure until the origin failure is independently verified", async () => {
    const store = new NearAttemptStore(new MemoryNearAttemptPersistence());
    await store.reserve(await input());
    await store.recordOwnerFundingEvidence(fundingTransition(ownerFunding(), 1, "funding-1"));
    const observed = await store.recordOwnerFundingEvidence(fundingTransition(
      settlement("FAILED", "2026-11-01T00:00:03.000Z"), 2, "provider-failure-1",
    ));
    expect(observed.entry.attempt.state).toBe("unknown");
    expect(observed.entry.reservation.state).toBe("outcome_unknown");
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "60" }));

    const failed = await store.recordOwnerFundingEvidence(fundingTransition(
      originReceipt("funding-failed", "2026-11-01T00:00:04.000Z"), 3, "origin-failure-1",
    ));
    expect(failed.entry.attempt.state).toBe("failed");
    expect(failed.entry.reservation.state).toBe("released");
    expect(await store.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "0" }));
  });

  it("uses entry revision CAS so only one concurrent observation wins", async () => {
    const persistence = new MemoryNearAttemptPersistence();
    const storeA = new NearAttemptStore(persistence);
    const storeB = new NearAttemptStore(persistence);
    await storeA.reserve(await input());
    await storeA.recordOwnerFundingEvidence(fundingTransition(ownerFunding(), 1, "funding-1"));
    const outcomes = await Promise.allSettled([
      storeA.recordOwnerFundingEvidence(fundingTransition(
        originReceipt(), 2, "origin-race",
      )),
      storeB.recordOwnerFundingEvidence(fundingTransition(
        settlement("PROCESSING", "2026-11-01T00:00:03.000Z"), 2, "provider-race",
      )),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "VERSION_CONFLICT" }) })]);
  });
});

describe("NEAR local file restart and crash boundaries", () => {
  it("persists owner funding provenance and exact replay across restart", async () => {
    const { path } = await localFile();
    const store = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    await store.reserve(await input());
    const report = fundingTransition(ownerFunding(), 1, "funding-restart-1");
    const recorded = await store.recordOwnerFundingEvidence(report);
    const restarted = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    await expect(restarted.recordOwnerFundingEvidence(report))
      .resolves.toEqual({ replay: true, entry: recorded.entry });
    expect((await restarted.snapshot()).entries[0]?.owner_funding?.binding.transaction_hash)
      .toBe(FUNDING_TRANSACTION);
  });

  it("survives restart and returns an exact replay without double reservation", async () => {
    const { path, persistence } = await localFile();
    const exact = await input();
    const first = await new NearAttemptStore(persistence).reserve(exact);
    const restarted = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    await expect(restarted.reserve(exact)).resolves.toEqual({ replay: true, entry: first.entry });
    expect(await restarted.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "60" }));
  });

  it("serializes concurrent reservations across local store instances", async () => {
    const { path } = await localFile();
    const storeA = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    const storeB = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    const outcomes = await Promise.allSettled([
      storeA.reserve(await input()),
      storeB.reserve(await input({
        attempt_id: "attempt-2", reservation_id: "reservation-2", idempotency_key: "idempotency-2",
      })),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "BUDGET_EXCEEDED" }) })]);
  });

  it("keeps the prior snapshot when a crash occurs before atomic rename", async () => {
    const { path } = await localFile();
    await new NearAttemptStore(new LocalFileNearAttemptPersistence(path)).reserve(await input({ amount_atomic: "40" }));
    const crashing = new NearAttemptStore(new LocalFileNearAttemptPersistence(path, {
      faultInjector: (phase) => {
        if (phase === "before_rename") throw new Error("simulated crash before rename");
      },
    }));
    await expect(crashing.reserve(await input({
      attempt_id: "attempt-2", reservation_id: "reservation-2", idempotency_key: "idempotency-2", amount_atomic: "40",
    }))).rejects.toThrow("simulated crash before rename");
    const restarted = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    expect((await restarted.snapshot()).entries.map((entry) => entry.attempt.attempt_id)).toEqual(["attempt-1"]);
  });

  it("recovers an exact replay after commit succeeds but the response crashes", async () => {
    const { path } = await localFile();
    let injected = false;
    const crashing = new NearAttemptStore(new LocalFileNearAttemptPersistence(path, {
      faultInjector: (phase) => {
        if (phase === "after_rename" && !injected) {
          injected = true;
          throw new Error("simulated crash after rename");
        }
      },
    }));
    const exact = await input();
    await expect(crashing.reserve(exact)).rejects.toThrow("simulated crash after rename");
    const restarted = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    await expect(restarted.reserve(exact)).resolves.toEqual(expect.objectContaining({ replay: true }));
    expect(await restarted.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ consumed_atomic: "60" }));
  });

  it("preserves an unknown reservation when reconciliation state commits before a crash", async () => {
    const { path } = await localFile();
    const baseline = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    const reserved = await baseline.reserve(await input());
    let injected = false;
    const crashing = new NearAttemptStore(new LocalFileNearAttemptPersistence(path, {
      faultInjector: (phase) => {
        if (phase === "after_rename" && !injected) {
          injected = true;
          throw new Error("simulated unknown-state response crash");
        }
      },
    }));
    const transition = {
      principal_id: "principal-1",
      idempotency_key: "idempotency-1",
      transition_id: "unknown-crash-1",
      expected_entry_revision: 1,
      evidence: unknownEvidence(reserved.entry),
    };
    await expect(crashing.recordOutcomeUnknown(transition))
      .rejects.toThrow("simulated unknown-state response crash");

    const restarted = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    await expect(restarted.recordOutcomeUnknown(transition))
      .resolves.toEqual(expect.objectContaining({ replay: true }));
    expect(await restarted.replayDecision("principal-1", "idempotency-1"))
      .toEqual(expect.objectContaining({ action: "blocked_unknown", safe_to_resubmit: false }));
    expect(await restarted.budgetSummary("principal-1", NEAR_ARBITRUM_USDC_ASSET_ID))
      .toEqual(expect.objectContaining({ unknown_atomic: "60", consumed_atomic: "60" }));
  });

  it("fails closed on unknown schema versions without modifying the file", async () => {
    const { path } = await localFile();
    const unsupported = { schema_version: 3, revision: 0, entries: [] };
    await writeFile(path, JSON.stringify(unsupported), { mode: 0o600 });
    const store = new NearAttemptStore(new LocalFileNearAttemptPersistence(path));
    await expect(store.snapshot()).rejects.toMatchObject({ code: "PERSISTENCE_CORRUPT" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(unsupported);
  });
});
