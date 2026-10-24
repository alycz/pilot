import {
  StrategyDecisionSchema,
  type Strategy,
  type StrategyDecision,
  type StrategyHoldCode,
  type StrategyPlanObservation,
} from "../contracts";
import { decideRebalance, decimalToMicrounitsCeil, type StrategyObservation } from "./engine";
import { evaluateDeclarativeStrategy } from "./plan/interpreter";
import {
  StrategySchedulerStore,
  StrategyStore,
  stableStrategyId,
  type DeclarativeStrategyUsage,
  type DueStrategy,
  type StrategyLease,
  type UnresolvedStrategyExecution,
} from "./store";

export type StrategyBuild = {
  buildId: string;
  buildRevision: number;
  lastLedgerSequence: number | null;
  feeDrops: string;
};

export type StrategyValidatedReceipt = {
  txHash: string;
  network: "testnet";
  ledgerIndex: number;
  validated: true;
  engineResult: "tesSUCCESS";
  result: "success";
};

export type StrategyExecuteResult =
  | ({ status: "executed"; harborExecutionId?: string } & StrategyValidatedReceipt)
  | { status: "needs_approval"; harborExecutionId?: string }
  | { status: "pending_reconciliation"; harborExecutionId?: string; txHash?: string }
  | { status: "failed"; detail: string };

export type StrategyReconcileResult =
  | { status: "pending" }
  | { status: "needs_approval"; approvalId: string }
  | { status: "validated" | "not_included" | "failed"; evidence: Record<string, unknown> };

export interface StrategyExecutionAdapter {
  /** Read-only, validated-ledger observation. The runner may retry this only. */
  observe(strategy: Strategy, now: Date): Promise<StrategyObservation>;
  /** Build and simulation are mutations of durable Harbor execution state and run once. */
  build(strategy: Strategy, decision: StrategyDecision, idempotencyKey: string): Promise<StrategyBuild>;
  /** Submission runs once. A thrown response is always treated as ambiguous. */
  execute(build: StrategyBuild, idempotencyKey: string): Promise<StrategyExecuteResult>;
  /** Read-only reconciliation may be retried with the original execution identity. */
  reconcile(execution: UnresolvedStrategyExecution): Promise<StrategyReconcileResult>;
}

export type StrategyRunnerOptions = {
  db: D1Database;
  now: Date;
  holderId: string;
  adapterForPrincipal(principal: string): StrategyExecutionAdapter;
  maxDue?: number;
  readAttempts?: number;
  clock?: () => Date;
};

export type StrategyRunSummary = {
  claimed: number;
  held: number;
  executed: number;
  blocked: number;
  failed: number;
};

function compareUnsignedIntegers(left: string, right: string): number {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) throw new TypeError("drops must be integers");
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function validatedReceiptEvidence(value: unknown): value is {
  tx_hash: string;
  network: "testnet";
  ledger_index: number;
  validated: true;
  engine_result: "tesSUCCESS";
  result: "success";
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.tx_hash === "string" && /^[A-F0-9]{64}$/.test(evidence.tx_hash) &&
    evidence.network === "testnet" && Number.isSafeInteger(evidence.ledger_index) &&
    Number(evidence.ledger_index) > 0 && evidence.validated === true &&
    evidence.engine_result === "tesSUCCESS" && evidence.result === "success";
}

function isValidatedReceipt(value: unknown): value is StrategyValidatedReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.txHash === "string" && /^[A-F0-9]{64}$/.test(receipt.txHash) &&
    receipt.network === "testnet" && Number.isSafeInteger(receipt.ledgerIndex) &&
    Number(receipt.ledgerIndex) > 0 && receipt.validated === true &&
    receipt.engineResult === "tesSUCCESS" && receipt.result === "success";
}

function receiptEvidence(receipt: StrategyValidatedReceipt): Record<string, unknown> {
  return {
    tx_hash: receipt.txHash,
    network: receipt.network,
    ledger_index: receipt.ledgerIndex,
    validated: receipt.validated,
    engine_result: receipt.engineResult,
    result: receipt.result,
  };
}

async function readWithRetry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

function holdDecision(strategy: Strategy, due: DueStrategy, triggerId: string, decisionId: string,
  now: Date, code: StrategyHoldCode, explanation: string): StrategyDecision {
  return StrategyDecisionSchema.parse({
    decision_id: decisionId,
    trigger_id: triggerId,
    strategy_id: strategy.strategy_id,
    mandate_digest: strategy.mandate.digest,
    mandate_version: due.mandateVersion,
    action: "hold",
    hold_codes: [code],
    ...(strategy.mandate.kind === "declarative_strategy_v1"
      ? {
          semantics_version: strategy.mandate.semantics_version,
          plan_digest: strategy.mandate.digest,
        }
      : {}),
    explanation,
    created_at: now.toISOString(),
  });
}

function planObservation(
  observation: StrategyObservation,
  usage: DeclarativeStrategyUsage,
): StrategyPlanObservation {
  return {
    account: observation.account,
    network: observation.network,
    issued_asset: {
      currency: observation.issuedCurrency as StrategyPlanObservation["issued_asset"]["currency"],
      issuer: observation.issuedIssuer as StrategyPlanObservation["issued_asset"]["issuer"],
    },
    xrp_balance_drops: observation.xrpBalanceDrops,
    issued_balance: observation.issuedBalance,
    bid: observation.bid,
    ask: observation.ask,
    executable_liquidity_value: observation.executableLiquidityValue,
    fee_drops: observation.feeDrops,
    reserve_base_drops: observation.reserveBaseDrops,
    reserve_increment_drops: observation.reserveIncrementDrops,
    owner_count: observation.ownerCount,
    daily_value_used: usage.daily_value,
    cumulative_value_used: usage.cumulative_value,
    daily_fee_drops_used: usage.daily_fee_drops,
    cumulative_fee_drops_used: usage.cumulative_fee_drops,
    daily_trades_used: usage.daily_trades,
    total_trades_used: usage.total_trades,
    ledger_index: observation.ledgerIndex,
    quote_ledger_index: observation.quoteLedgerIndex,
    observed_at: observation.observedAt,
    ...(observation.lastTradeAt
      ? { last_trade_at: observation.lastTradeAt }
      : {}),
    global_kill: observation.globalKill === true,
    unresolved_execution: observation.unresolvedExecution === true,
    grant_active: observation.grantActive === true,
    policy_active: observation.policyActive === true,
  };
}

async function decideStrategy(
  strategy: Strategy,
  observation: StrategyObservation,
  usage: DeclarativeStrategyUsage | undefined,
  triggerId: string,
  decisionId: string,
  now: Date,
): Promise<StrategyDecision> {
  if (strategy.mandate.kind === "xrp_issued_rebalancer_v1") {
    return decideRebalance({
      mandate: strategy.mandate,
      observation,
      triggerId,
      decisionId,
      now,
    });
  }
  if (!usage) throw new Error("declarative usage snapshot is required");
  if (
    strategy.mandate.limits.max_mandate_occurrences !== undefined &&
    usage.mandate_occurrences >=
      strategy.mandate.limits.max_mandate_occurrences
  ) {
    return StrategyDecisionSchema.parse({
      decision_id: decisionId,
      trigger_id: triggerId,
      strategy_id: strategy.strategy_id,
      mandate_digest: strategy.mandate.digest,
      mandate_version: strategy.mandate.version,
      action: "hold",
      hold_codes: ["trade_count_limit"],
      semantics_version: strategy.mandate.semantics_version,
      plan_digest: strategy.mandate.digest,
      explanation:
        "The owner-approved mandate executed-action occurrence count is exhausted.",
      created_at: now.toISOString(),
    });
  }
  return (await evaluateDeclarativeStrategy({
    authority: strategy.mandate,
    observation: planObservation(observation, usage),
    triggerId,
    decisionId,
    now,
  })).decision;
}

async function revalidateBeforeSubmission(store: StrategyStore, scheduler: StrategySchedulerStore,
  original: Strategy, lease: StrategyLease, now: Date): Promise<boolean> {
  if (!(await scheduler.isCurrent(lease, now))) return false;
  const current = await store.getStrategy(original.strategy_id);
  if (!current || current.lifecycle !== "active" || current.generation !== original.generation ||
      current.mandate.mandate_id !== original.mandate.mandate_id ||
      current.mandate.version !== original.mandate.version || current.mandate.digest !== original.mandate.digest ||
      current.mandate.status !== "approved" || !current.mandate.authorization ||
      now.getTime() < Date.parse(current.mandate.not_before) ||
      now.getTime() >= Date.parse(current.mandate.expires_at) ||
      now.getTime() >= Date.parse(current.mandate.authorization.expires_at)) return false;
  return !(await store.getGlobalKill(current.mandate.account, current.mandate.network)).enabled;
}

async function runClaimed(due: DueStrategy, lease: StrategyLease, options: StrategyRunnerOptions,
  scheduler: StrategySchedulerStore, summary: StrategyRunSummary): Promise<void> {
  const { now } = options;
  const store = new StrategyStore(options.db, due.principal);
  const adapter = options.adapterForPrincipal(due.principal);
  const strategy = await store.getStrategy(due.strategyId);
  if (!strategy || strategy.lifecycle !== "active" || strategy.mandate.version !== due.mandateVersion) return;
  const triggerId = await stableStrategyId("trigger", due.strategyId, String(due.scheduleGeneration), due.scheduledFor);
  const decisionId = await stableStrategyId("decision", triggerId, strategy.mandate.digest);
  const trigger = await scheduler.createTrigger(due, lease, triggerId, now);
  if (trigger === "duplicate") return;
  const recoveredDecision = await scheduler.getTriggerDecision(due.principal, triggerId);
  if (recoveredDecision) {
    const recoveredExecution = await store.getExecutionForDecision(recoveredDecision.decisionId);
    if (!recoveredExecution && recoveredDecision.state !== "executed" && recoveredDecision.state !== "pending_reconciliation" &&
        recoveredDecision.state !== "needs_approval") {
      await scheduler.finishTrigger(due.principal, lease, triggerId, recoveredDecision.decisionId,
        recoveredDecision.action === "hold" ? "complete" : "failed", now,
        recoveredDecision.action === "hold" ? undefined : "failed");
      await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
      summary.failed += recoveredDecision.action === "hold" ? 0 : 1;
      summary.held += recoveredDecision.action === "hold" ? 1 : 0;
      return;
    }
    if (recoveredExecution?.submissionState === "prepared") {
      await store.abandonPreSubmission(recoveredExecution.id, now,
        { reason: "restart recovered durable pre-dispatch state; Harbor execute was never called",
          occurrence_release_reason: "pre_submit" });
      await scheduler.finishTrigger(due.principal, lease, triggerId, recoveredDecision.decisionId, "failed", now, "failed");
      await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
      summary.failed += 1;
      return;
    }
    // Submitting/unknown/submitted/approval states are handled only by the
    // reconciliation pass. Never create or submit another order here.
    summary.blocked += 1;
    return;
  }
  await store.appendAudit({ strategyId: due.strategyId, triggerId, actor: "scheduler", kind: "tick_started",
    detail: { scheduled_for: due.scheduledFor, fencing_token: lease.fencingToken }, at: now });

  const unresolved = await store.getUnresolvedExecution(due.strategyId);
  if (unresolved) {
    let reconciled: StrategyReconcileResult;
    try {
      reconciled = await adapter.reconcile(unresolved);
    } catch {
      reconciled = { status: "pending" };
    }
    if (reconciled.status === "validated" && !validatedReceiptEvidence(reconciled.evidence)) {
      reconciled = { status: "pending" };
    }
    if (reconciled.status === "pending") {
      const decision = holdDecision(strategy, due, triggerId, decisionId, now, "service_unavailable",
        "A prior transaction remains unresolved; no new order was built or submitted.");
      await scheduler.persistDecision(due.principal, lease, strategy.mandate, decision, now);
      await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "blocked", now);
      await store.pauseForRunner(due.strategyId, "pending transaction reconciliation", now);
      summary.blocked += 1;
      return;
    }
    if (reconciled.status === "needs_approval") {
      await store.markExecution(unresolved.id, "needs_approval", now, { harborExecutionId: reconciled.approvalId });
      await store.appendAudit({ strategyId: due.strategyId, executionId: unresolved.id, actor: "reconciler", kind: "needs_approval",
        detail: { approval_id: reconciled.approvalId, preserved: true,
          next_action: "Complete the existing Harbor owner-approval workflow; no replacement order will be created." }, at: now });
      await store.pauseForRunner(due.strategyId, "owner approval required", now);
      summary.blocked += 1;
      return;
    }
    const reconciliationEvidence = reconciled.status === "not_included"
      ? { ...reconciled.evidence, occurrence_release_reason: "not_included" }
      : reconciled.evidence;
    await store.resolveExecution(unresolved.id, reconciled.status, reconciliationEvidence, now);
    await store.appendAudit({ strategyId: due.strategyId, executionId: unresolved.id, actor: "reconciler", kind: "reconciled",
      detail: { status: reconciled.status, ...reconciled.evidence }, at: now });
    if (reconciled.status === "validated") await store.markTradeComplete(due.strategyId, now);
    await store.pauseForRunner(due.strategyId, "prior transaction reconciled; owner may resume after review", now);
    summary.blocked += 1;
    return;
  }

  let observation: StrategyObservation;
  try {
    observation = await readWithRetry(options.readAttempts ?? 3,
      () => adapter.observe(strategy, options.clock?.() ?? new Date()));
  } catch {
    const decision = holdDecision(strategy, due, triggerId, decisionId, now, "service_unavailable",
      "Required validated-ledger observations were unavailable after bounded read retries.");
    if (await scheduler.persistDecision(due.principal, lease, strategy.mandate, decision, now)) {
      await store.recordHold(due.strategyId, decision.explanation, now);
      await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, actor: "runner", kind: "held",
        detail: { hold_codes: decision.hold_codes }, at: now });
      await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
      summary.held += 1;
    }
    return;
  }
  const globalKill = await store.getGlobalKill(strategy.mandate.account, strategy.mandate.network);
  const usage = strategy.mandate.kind === "declarative_strategy_v1"
    ? await store.getDeclarativeUsage(strategy, now)
    : undefined;
  observation = { ...observation, globalKill: globalKill.enabled,
    pendingDailyValue: usage?.daily_value ??
      await store.getPendingDailyValue(strategy.strategy_id, now), unresolvedExecution: false };
  const observedLease = await scheduler.renew(lease, options.clock?.() ?? new Date());
  if (!observedLease) return;
  lease = observedLease;
  const decisionNow = options.clock?.() ?? new Date();
  let decision = await decideStrategy(
    strategy,
    observation,
    usage,
    triggerId,
    decisionId,
    decisionNow,
  );
  if (!(await scheduler.persistDecision(due.principal, lease, strategy.mandate, decision, now,
    { ...observation, globalKill: globalKill.enabled }))) return;
  if (decision.action === "hold") {
    const terminalLease = await scheduler.renew(lease, options.clock?.() ?? new Date());
    if (!terminalLease) return;
    lease = terminalLease;
    await store.recordHold(due.strategyId, decision.explanation, now);
    await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, actor: "runner", kind: "held",
      detail: { hold_codes: decision.hold_codes, explanation: decision.explanation }, at: now });
    await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
    summary.held += 1;
    return;
  }

  const executionId = await stableStrategyId("execution", decisionId);
  const idempotencyKey = `strategy:${strategy.strategy_id}:${decision.decision_id}`;
  await store.beginExecution(decision, executionId, idempotencyKey, now);
  if (!(await store.reserveDecision(
    strategy,
    decision,
    executionId,
    now,
    observation.feeDrops,
  ))) {
    await store.abandonPreSubmission(executionId, now, {
      phase: "reservation_race",
      occurrence_release_reason: "pre_submit",
    });
    let code: StrategyHoldCode = "daily_limit";
    let explanation = "A concurrent reservation consumed the remaining daily mandate budget.";
    if (strategy.mandate.kind === "declarative_strategy_v1") {
      const racedUsage = await store.getDeclarativeUsage(strategy, now);
      const racedDecision = await decideStrategy(
        strategy,
        observation,
        racedUsage,
        triggerId,
        decisionId,
        decisionNow,
      );
      if (racedDecision.action === "hold") {
        code = racedDecision.hold_codes[0] ?? "daily_limit";
        explanation = racedDecision.explanation;
      }
    }
    await store.markBudgetHold(decisionId, explanation, now, code);
    decision = holdDecision(
      strategy,
      due,
      triggerId,
      decisionId,
      now,
      code,
      explanation,
    );
    await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "complete", now);
    await store.recordHold(due.strategyId, decision.explanation, now);
    await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, executionId, actor: "runner", kind: "held",
      detail: { hold_codes: [code] }, at: now });
    await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
    summary.held += 1;
    return;
  }
  await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, executionId, actor: "runner", kind: "budget_reserved",
    detail: { proposed_value: decision.proposed_value }, at: now });

  let build: StrategyBuild;
  try {
    build = await adapter.build(strategy, decision, idempotencyKey);
    if (compareUnsignedIntegers(build.feeDrops, strategy.mandate.limits.max_fee_drops) > 0) {
      throw new Error("autofilled fee exceeds immutable mandate");
    }
    if (!(await store.updateReservedFee(
      strategy,
      decision.decision_id,
      build.feeDrops,
      now,
    ))) {
      throw new Error("autofilled fee exceeds an aggregate mandate fee budget");
    }
    await store.attachBuild(executionId, build.buildId, build.lastLedgerSequence, now);
  } catch (error) {
    const terminalLease = await scheduler.renew(lease, options.clock?.() ?? new Date());
    if (!terminalLease) return;
    lease = terminalLease;
    await store.abandonPreSubmission(executionId, now, {
      phase: "build_or_simulation",
      occurrence_release_reason: "pre_submit",
    });
    await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "failed", now, "failed");
    await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, executionId, actor: "runner", kind: "failed",
      detail: { phase: "build_or_simulation", message: error instanceof Error ? error.message : "failed" }, at: now });
    await store.pauseForRunner(due.strategyId, "build or simulation failed; owner review is required", now);
    summary.failed += 1;
    return;
  }
  const builtLease = await scheduler.renew(lease, options.clock?.() ?? new Date());
  if (!builtLease) {
    await store.abandonPreSubmission(executionId, now, {
      reason: "lease expired before submission",
      occurrence_release_reason: "pre_submit",
    });
    summary.blocked += 1;
    return;
  }
  lease = builtLease;
  const freshReadStartedAt = options.clock?.() ?? new Date();
  let freshObservation: StrategyObservation;
  try {
    freshObservation = await readWithRetry(options.readAttempts ?? 3, () => adapter.observe(strategy, freshReadStartedAt));
  } catch {
    freshObservation = { ...observation, grantActive: false, policyActive: false };
  }
  const freshNow = options.clock?.() ?? new Date();
  const freshKill = await store.getGlobalKill(strategy.mandate.account, strategy.mandate.network);
  const freshUsage = strategy.mandate.kind === "declarative_strategy_v1"
    ? await store.getDeclarativeUsage(strategy, freshNow, decision.decision_id)
    : undefined;
  freshObservation = { ...freshObservation, globalKill: freshKill.enabled,
    pendingDailyValue: observation.pendingDailyValue, unresolvedExecution: false };
  const freshDecision = await decideStrategy(
    strategy,
    freshObservation,
    freshUsage,
    triggerId,
    decisionId,
    freshNow,
  );
  const stillPermitted = freshDecision.action === decision.action && freshDecision.proposed_value !== undefined &&
    decision.proposed_value !== undefined &&
    decimalToMicrounitsCeil(freshDecision.proposed_value) >= decimalToMicrounitsCeil(decision.proposed_value) &&
    (strategy.mandate.kind !== "declarative_strategy_v1" ||
      freshDecision.matched_rule_id === decision.matched_rule_id);
  const revalidationNow = options.clock?.() ?? new Date();
  if (!stillPermitted || !(await revalidateBeforeSubmission(
    store,
    scheduler,
    strategy,
    lease,
    revalidationNow,
  ))) {
    await store.abandonPreSubmission(executionId, now, {
      reason: "mandate, kill switch, or lease changed before submission",
      occurrence_release_reason: "pre_submit",
    });
    await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "blocked", now, "failed");
    await store.pauseForRunner(due.strategyId, "mandate, kill switch, or lease changed before submission", now);
    summary.blocked += 1;
    return;
  }

  // Re-sample after asynchronous revalidation. The database fence atomically
  // checks this exact instant against the lease, owner kill, mandate window,
  // and owner-authorization expiry. Also fail closed if the quote aged out
  // while those reads were in flight.
  const fenceNow = options.clock?.() ?? new Date();
  const quoteAgeAtFence = fenceNow.getTime() - Date.parse(freshObservation.observedAt);
  const quoteFreshAtFence = Number.isFinite(quoteAgeAtFence) && quoteAgeAtFence >= 0 &&
    quoteAgeAtFence <= strategy.mandate.limits.max_quote_age_seconds * 1_000;
  if (!quoteFreshAtFence || !(await store.markSubmittingFenced(
    executionId,
    strategy,
    lease,
    fenceNow,
  ))) {
    await store.abandonPreSubmission(executionId, fenceNow,
      { reason: "atomic generation, lease, or wallet kill fence rejected submission",
        occurrence_release_reason: "pre_submit" });
    await store.pauseForRunner(due.strategyId, "submission fence rejected stale or killed work", fenceNow);
    summary.blocked += 1;
    return;
  }
  let outcome: StrategyExecuteResult;
  try {
    outcome = await adapter.execute(build, idempotencyKey);
  } catch {
    outcome = { status: "pending_reconciliation" };
  }
  if (outcome.status === "executed" && !isValidatedReceipt(outcome)) {
    // The relay may have happened. Malformed or incomplete success evidence is
    // therefore ambiguous, never a terminal failure or validated execution.
    outcome = { status: "pending_reconciliation" };
  }
  const terminalLease = await scheduler.renew(lease, options.clock?.() ?? new Date());
  if (!terminalLease) {
    // Durable submitting state is intentionally left unresolved. A later
    // reconciler recovers the exact identity; this worker must not finalize.
    summary.blocked += 1;
    return;
  }
  lease = terminalLease;
  if (outcome.status === "executed") {
    const evidence = receiptEvidence(outcome);
    await store.markExecution(executionId, "submitted", now,
      { harborExecutionId: outcome.harborExecutionId, txHash: outcome.txHash });
    await store.resolveExecution(executionId, "validated", evidence, now);
    await store.markTradeComplete(due.strategyId, now);
    await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "complete", now, "executed");
    await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, executionId, actor: "runner", kind: "executed",
      detail: evidence, at: now });
    await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
    summary.executed += 1;
  } else if (outcome.status === "failed") {
    await store.markExecution(executionId, "failed", now);
    await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "failed", now, "failed");
    await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, executionId, actor: "runner", kind: "failed",
      detail: { phase: "execution", message: outcome.detail }, at: now });
    await scheduler.advanceSchedule(due, lease, strategy.mandate.schedule.interval_seconds, now);
    summary.failed += 1;
  } else {
    const approval = outcome.status === "needs_approval";
    await store.markExecution(executionId, approval ? "needs_approval" : "unknown", now,
      { harborExecutionId: outcome.harborExecutionId,
        ...(outcome.status === "pending_reconciliation" && outcome.txHash ? { txHash: outcome.txHash } : {}) });
    await scheduler.finishTrigger(due.principal, lease, triggerId, decisionId, "blocked", now,
      approval ? "needs_approval" : "pending_reconciliation");
    await store.pauseForRunner(due.strategyId, approval ? "owner approval required" : "submission outcome requires reconciliation", now);
    await store.appendAudit({ strategyId: due.strategyId, triggerId, decisionId, executionId, actor: "runner",
      kind: approval ? "needs_approval" : "submission_unknown", detail: approval
        ? { preserved: true, approval_id: outcome.harborExecutionId,
          next_action: "Complete the existing Harbor owner-approval workflow; the strategy will not sign for the owner or create a replacement order." }
        : { preserved: true, next_action: "Wait for ledger reconciliation; no replacement order will be submitted." }, at: now });
    summary.blocked += 1;
  }
}

export async function runStrategyScheduler(options: StrategyRunnerOptions): Promise<StrategyRunSummary> {
  const summary: StrategyRunSummary = { claimed: 0, held: 0, executed: 0, blocked: 0, failed: 0 };
  const scheduler = new StrategySchedulerStore(options.db);
  // Reconciliation is independent of lifecycle and remains active for
  // paused/stopped/killed strategies. It can never create a new build.
  for (const item of await scheduler.listUnresolved(options.maxDue ?? 20)) {
    const lease = await scheduler.claim({ principal: item.principal, strategyId: item.strategyId,
      mandateVersion: 1, scheduleGeneration: 0, scheduledFor: options.now.toISOString() },
    `${options.holderId}:reconcile`, options.now, 300_000);
    if (!lease) continue;
    summary.claimed += 1;
    try {
      const store = new StrategyStore(options.db, item.principal);
      const unresolved = await store.getUnresolvedExecution(item.strategyId);
      if (!unresolved || unresolved.id !== item.executionId) continue;
      let result: StrategyReconcileResult;
      try { result = await options.adapterForPrincipal(item.principal).reconcile(unresolved); }
      catch { result = { status: "pending" }; }
      if (result.status === "validated" && !validatedReceiptEvidence(result.evidence)) {
        result = { status: "pending" };
      }
      if (result.status === "pending") {
        summary.blocked += 1;
      } else if (result.status === "needs_approval") {
        await store.markExecution(unresolved.id, "needs_approval", options.now, { harborExecutionId: result.approvalId });
        await store.appendAudit({ strategyId: item.strategyId, executionId: unresolved.id,
          actor: "reconciler", kind: "needs_approval", detail: { approval_id: result.approvalId, preserved: true,
            next_action: "Complete the existing Harbor owner-approval workflow; no replacement order will be created." }, at: options.now });
        summary.blocked += 1;
      } else {
        const reconciliationEvidence = result.status === "not_included"
          ? { ...result.evidence, occurrence_release_reason: "not_included" }
          : result.evidence;
        await store.resolveExecution(unresolved.id, result.status, reconciliationEvidence, options.now);
        await store.appendAudit({ strategyId: item.strategyId, executionId: unresolved.id,
          actor: "reconciler", kind: "reconciled", detail: { status: result.status, ...result.evidence }, at: options.now });
        if (result.status === "validated") await store.markTradeComplete(item.strategyId, options.now);
      }
    } finally {
      await scheduler.release(lease);
    }
  }
  for (const due of await scheduler.listDue(options.now, options.maxDue ?? 20)) {
    const lease = await scheduler.claim(due, options.holderId, options.now, 300_000);
    if (!lease) continue;
    summary.claimed += 1;
    try {
      await runClaimed(due, lease, options, scheduler, summary);
    } catch {
      summary.failed += 1;
    } finally {
      await scheduler.release(lease);
    }
  }
  return summary;
}
