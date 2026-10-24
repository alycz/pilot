import {
  StrategyAuditEventSchema,
  StrategyAuthorizeArgsSchema,
  StrategyCreateArgsSchema,
  StrategyKillSwitchSchema,
  StrategyMandateSchema,
  StrategySchema,
  type Strategy,
  type StrategyAuditEvent,
  type StrategyAuthorizeArgs,
  type StrategyCreateArgs,
  type StrategyDecision,
  type StrategyKillSwitch,
  type StrategyHoldCode,
  type AnyStrategyMandate,
} from "../contracts";
import { decimalToMicrounitsCeil } from "./engine";
import { compileDeclarativeStrategyProposal } from "./plan/compiler";

type RawStrategy = {
  id: string;
  lifecycle: string;
  generation: number;
  next_evaluation_at: string | null;
  last_evaluation_at: string | null;
  last_trade_at: string | null;
  hold_reason: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  config_json: string;
};

type DeclarativeMandate = Extract<
  AnyStrategyMandate,
  { kind: "declarative_strategy_v1" }
>;

export type DeclarativeStrategyUsage = {
  daily_value: string;
  cumulative_value: string;
  daily_fee_drops: string;
  cumulative_fee_drops: string;
  daily_trades: number;
  total_trades: number;
  mandate_occurrences: number;
};

function isDeclarativeMandate(
  mandate: AnyStrategyMandate,
): mandate is DeclarativeMandate {
  return mandate.kind === "declarative_strategy_v1";
}

function safeDrops(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("fee drops are not canonical");
  }
  const drops = BigInt(value);
  if (drops > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("fee drops exceed atomic reservation range");
  }
  return Number(drops);
}

function formatMicrounits(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export type DueStrategy = {
  principal: string;
  strategyId: string;
  mandateVersion: number;
  scheduleGeneration: number;
  scheduledFor: string;
};

export type StrategyLease = {
  principal: string;
  strategyId: string;
  token: string;
  fencingToken: number;
  expiresAt: string;
};

export type UnresolvedStrategyExecution = {
  principal?: string;
  id: string;
  strategyId: string;
  decisionId: string;
  buildId: string | null;
  harborExecutionId: string | null;
  idempotencyKey: string;
  txHash: string | null;
  submissionState: string;
  lastLedgerSequence: number | null;
};

function changes(result: D1Result): number {
  return Number(result.meta?.changes ?? 0);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function extractStrategyId(value: unknown): string | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).strategy_id;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function parseStrategy(row: RawStrategy): Strategy {
  const mandate = StrategyMandateSchema.parse(JSON.parse(row.config_json));
  return StrategySchema.parse({
    strategy_id: row.id,
    lifecycle: row.lifecycle,
    mandate,
    generation: row.generation,
    ...(row.next_evaluation_at ? { next_evaluation_at: row.next_evaluation_at } : {}),
    ...(row.last_evaluation_at ? { last_evaluation_at: row.last_evaluation_at } : {}),
    ...(row.last_trade_at ? { last_trade_at: row.last_trade_at } : {}),
    ...(row.hold_reason ? { hold_reason: row.hold_reason } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export class StrategyStore {
  constructor(readonly db: D1Database, readonly principal: string) {
    if (!principal.trim()) throw new TypeError("principal is required");
  }

  async createDraft(rawArgs: StrategyCreateArgs, now: Date): Promise<Strategy> {
    const args = StrategyCreateArgsSchema.parse(rawArgs);
    const existing = await this.db.prepare(
      `SELECT id, lifecycle, mandate_version, generation FROM strategies
       WHERE principal = ? AND owner = ? AND network = 'testnet' LIMIT 1`,
    ).bind(this.principal, args.account).first<{ id: string; lifecycle: string; mandate_version: number; generation: number }>();
    if (existing?.lifecycle === "active") throw new Error("active strategy configuration is immutable; pause it before drafting a new version");
    const strategyId = existing?.id ?? id("strategy");
    const version = (existing?.mandate_version ?? 0) + 1;
    const mandateId = id("mandate");
    const at = now.toISOString();
    const intervalSeconds = args.kind === "declarative_strategy_v1"
      ? args.plan.trigger.interval_seconds
      : args.interval_seconds;
    const declarativeCompilation = args.kind === "declarative_strategy_v1"
      ? await compileDeclarativeStrategyProposal(args)
      : null;
    const next = new Date(now.getTime() + intervalSeconds * 1_000).toISOString();
    const mandateBase = {
      mandate_id: mandateId,
      strategy_id: strategyId,
      version,
      status: "draft" as const,
      kind: args.kind,
      network: "testnet" as const,
      account: args.account,
      issued_asset: args.issued_asset,
      ...(args.kind === "declarative_strategy_v1"
        ? { semantics_version: args.semantics_version, plan: args.plan }
        : { allocation: args.allocation }),
      limits: args.limits,
      schedule: { interval_seconds: intervalSeconds, next_evaluation_at: next },
      execution_mode: args.execution_mode,
      not_before: args.not_before,
      expires_at: args.expires_at,
    };
    const mandate: AnyStrategyMandate = StrategyMandateSchema.parse({
      ...mandateBase,
      digest: declarativeCompilation?.planDigest ?? await digest(mandateBase),
    });
    const eventId = id("audit");
    if (!existing) {
      const statements = [
        this.insertMandate(mandate, at),
        this.db.prepare(`INSERT INTO strategies(
          id, principal, owner, network, issued_currency, issued_issuer, lifecycle,
          mandate_id, mandate_version, mandate_digest, generation, created_at, updated_at
        ) VALUES (?, ?, ?, 'testnet', ?, ?, 'draft', ?, ?, ?, 0, ?, ?)`)
          .bind(strategyId, this.principal, args.account, args.issued_asset.currency, args.issued_asset.issuer,
            mandateId, version, mandate.digest, at, at),
        this.db.prepare(`INSERT INTO strategy_schedules(
          strategy_id, principal, interval_seconds, next_evaluation_at, enabled, generation, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?)`)
          .bind(strategyId, this.principal, intervalSeconds, next, at),
        this.auditStatement(eventId, strategyId, "owner", "created", { mandate_version: version, mandate_digest: mandate.digest }, at),
      ];
      if (isDeclarativeMandate(mandate)) {
        statements.splice(1, 0, this.insertDeclarativePlan(mandate, at));
      }
      await this.db.batch(statements);
    } else {
      const statements = [
        this.db.prepare(`INSERT INTO strategy_mandates(
          id, principal, strategy_id, version, digest, status, kind, network, owner,
          issued_currency, issued_issuer, config_json, not_before, expires_at, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, 'testnet', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND generation = ? AND lifecycle = ?)`)
          .bind(mandate.mandate_id, this.principal, mandate.strategy_id, mandate.version, mandate.digest,
            mandate.status, "xrp_issued_rebalancer_v1", mandate.account, mandate.issued_asset.currency, mandate.issued_asset.issuer,
            JSON.stringify(mandate), mandate.not_before, mandate.expires_at, at,
            this.principal, strategyId, existing.generation, existing.lifecycle),
        this.db.prepare(`UPDATE strategies SET lifecycle = 'draft', mandate_id = ?, mandate_version = ?,
          mandate_digest = ?, issued_currency = ?, issued_issuer = ?, generation = generation + 1,
          next_evaluation_at = NULL, hold_reason = NULL, error_code = NULL, updated_at = ?
          WHERE principal = ? AND id = ? AND generation = ? AND lifecycle = ?`)
          .bind(mandateId, version, mandate.digest, args.issued_asset.currency, args.issued_asset.issuer, at,
            this.principal, strategyId, existing.generation, existing.lifecycle),
        this.db.prepare(`UPDATE strategy_schedules SET interval_seconds = ?, next_evaluation_at = ?,
          enabled = 0, generation = generation + 1, updated_at = ? WHERE principal = ? AND strategy_id = ?
          AND EXISTS (SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND mandate_id = ? AND generation = ?)`)
          .bind(intervalSeconds, next, at, this.principal, strategyId,
            this.principal, strategyId, mandateId, existing.generation + 1),
        this.conditionalAuditStatement(eventId, strategyId, "owner", "created",
          { mandate_version: version, mandate_digest: mandate.digest }, at, mandateId, existing.generation + 1),
      ];
      if (isDeclarativeMandate(mandate)) {
        statements.splice(1, 0, this.insertDeclarativePlan(mandate, at));
      }
      const results = await this.db.batch(statements);
      if (results.some((result) => changes(result) !== 1)) {
        throw new Error("strategy draft changed concurrently");
      }
    }
    return this.requireStrategy(strategyId);
  }

  /**
   * Claims a control request before mutation. A crash after the claim leaves a
   * durable pending outcome and retries fail closed instead of repeating the
   * mutation. Completed requests replay their exact stored JSON result.
   */
  async runControlOnce<T>(
    requestId: string,
    operation: string,
    requestDigest: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(requestId)) throw new TypeError("request id is invalid");
    if (!/^[A-Fa-f0-9]{64}$/.test(requestDigest)) throw new TypeError("request digest is invalid");
    const normalizedDigest = requestDigest.toUpperCase();
    const pending = JSON.stringify({ control_receipt: "pending" });
    const inserted = await this.db.prepare(`INSERT OR IGNORE INTO strategy_control_receipts(
      principal, request_id, operation, request_digest, strategy_id, result_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?)`)
      .bind(this.principal, requestId, operation, normalizedDigest, pending, new Date().toISOString()).run();
    if (changes(inserted) === 0) {
      const existing = await this.db.prepare(`SELECT operation, request_digest, result_json
        FROM strategy_control_receipts WHERE principal = ? AND request_id = ?`)
        .bind(this.principal, requestId).first<{ operation: string; request_digest: string; result_json: string }>();
      if (!existing || existing.operation !== operation || existing.request_digest !== normalizedDigest) {
        throw new Error("control request id is already bound to different immutable input");
      }
      const parsed = JSON.parse(existing.result_json) as unknown;
      if (canonical(parsed) === canonical({ control_receipt: "pending" })) {
        throw new Error("control outcome is pending or unknown; read status before any further action");
      }
      return parsed as T;
    }
    const result = await action();
    const serialized = JSON.stringify(result);
    const updated = await this.db.prepare(`UPDATE strategy_control_receipts SET result_json = ?,
      strategy_id = ? WHERE principal = ? AND request_id = ? AND operation = ? AND request_digest = ?
      AND result_json = ?`)
      .bind(serialized, extractStrategyId(result), this.principal, requestId, operation, normalizedDigest, pending).run();
    if (changes(updated) !== 1) throw new Error("control result could not be persisted consistently");
    return result;
  }

  async getStrategy(strategyId: string): Promise<Strategy | null> {
    const row = await this.db.prepare(`SELECT s.*, m.config_json FROM strategies s
      JOIN strategy_mandates m ON m.id = s.mandate_id AND m.principal = s.principal
      WHERE s.principal = ? AND s.id = ?`).bind(this.principal, strategyId).first<RawStrategy>();
    return row ? parseStrategy(row) : null;
  }

  async listStrategies(owner?: string): Promise<Strategy[]> {
    const statement = owner
      ? this.db.prepare(`SELECT s.*, m.config_json FROM strategies s JOIN strategy_mandates m
          ON m.id = s.mandate_id AND m.principal = s.principal WHERE s.principal = ? AND s.owner = ? ORDER BY s.created_at`)
          .bind(this.principal, owner)
      : this.db.prepare(`SELECT s.*, m.config_json FROM strategies s JOIN strategy_mandates m
          ON m.id = s.mandate_id AND m.principal = s.principal WHERE s.principal = ? ORDER BY s.created_at`)
          .bind(this.principal);
    const rows = await statement.all<RawStrategy>();
    return rows.results.map(parseStrategy);
  }

  async authorizeAndActivate(rawArgs: StrategyAuthorizeArgs, now: Date): Promise<Strategy> {
    const args = StrategyAuthorizeArgsSchema.parse(rawArgs);
    const strategy = await this.requireStrategy(args.strategy_id);
    if (strategy.lifecycle !== "draft" && strategy.lifecycle !== "paused") throw new Error("strategy cannot be activated from its current lifecycle");
    if (strategy.mandate.version !== args.mandate_version || strategy.mandate.digest !== args.mandate_digest) throw new Error("authorization does not bind the current mandate");
    if (args.authorization.owner !== strategy.mandate.account || args.authorization.mandate_digest !== strategy.mandate.digest || args.authorization.mandate_version !== strategy.mandate.version) {
      throw new Error("owner authorization does not bind the current mandate");
    }
    const at = now.toISOString();
    if (now.getTime() < Date.parse(strategy.mandate.not_before) || now.getTime() >= Date.parse(strategy.mandate.expires_at) ||
        now.getTime() >= Date.parse(args.authorization.expires_at)) throw new Error("mandate authorization is not currently valid");
    if ((await this.getGlobalKill(strategy.mandate.account, strategy.mandate.network)).enabled) throw new Error("global kill switch is enabled");
    if (await this.getUnresolvedExecution(strategy.strategy_id)) throw new Error("unresolved execution blocks activation");
    const mandate = StrategyMandateSchema.parse({ ...strategy.mandate, status: "approved", authorization: args.authorization });
    const next = new Date(Math.max(now.getTime(), Date.parse(mandate.schedule.next_evaluation_at))).toISOString();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE strategy_mandates SET status = 'approved', authorization_id = ?,
        authorization_method = ?, approved_at = ?, config_json = ?
        WHERE principal = ? AND id = ? AND version = ? AND digest = ? AND status = 'draft'
        AND EXISTS (SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND generation = ?
          AND lifecycle IN ('draft','paused')) AND EXISTS (
          SELECT 1 FROM strategy_global_controls
          WHERE principal = ? AND owner = ? AND network = ? AND kill_enabled = 0
        ) AND NOT EXISTS (
          SELECT 1 FROM strategies owner_scope WHERE owner_scope.owner = ?
            AND owner_scope.network = ? AND owner_scope.principal <> ?
        ) AND NOT EXISTS (
          SELECT 1 FROM strategy_global_controls control_scope WHERE control_scope.owner = ?
            AND control_scope.network = ? AND control_scope.principal <> ?
        ) AND NOT EXISTS (
          SELECT 1 FROM strategy_executions execution
          WHERE execution.principal = ? AND execution.strategy_id = ?
            AND execution.unresolved = 1
        )`)
        .bind(args.authorization.authorization_id, args.authorization.method, args.authorization.approved_at,
          JSON.stringify(mandate), this.principal, mandate.mandate_id, mandate.version, mandate.digest,
          this.principal, strategy.strategy_id, strategy.generation,
          this.principal, mandate.account, mandate.network,
          mandate.account, mandate.network, this.principal,
          mandate.account, mandate.network, this.principal,
          this.principal, strategy.strategy_id),
      this.db.prepare(`UPDATE strategies SET lifecycle = 'active', generation = generation + 1,
        next_evaluation_at = ?, hold_reason = NULL, error_code = NULL, updated_at = ?
        WHERE principal = ? AND id = ? AND mandate_id = ? AND mandate_digest = ? AND generation = ?
        AND EXISTS (SELECT 1 FROM strategy_mandates WHERE principal = ? AND id = ? AND status = 'approved'
          AND authorization_id = ?) AND EXISTS (SELECT 1 FROM strategy_global_controls
          WHERE principal = ? AND owner = ? AND network = ? AND kill_enabled = 0)
        AND NOT EXISTS (SELECT 1 FROM strategies owner_scope WHERE owner_scope.owner = ?
          AND owner_scope.network = ? AND owner_scope.principal <> ?)
        AND NOT EXISTS (SELECT 1 FROM strategy_global_controls control_scope WHERE control_scope.owner = ?
          AND control_scope.network = ? AND control_scope.principal <> ?)
        AND NOT EXISTS (SELECT 1 FROM strategy_executions execution
          WHERE execution.principal = ? AND execution.strategy_id = ?
            AND execution.unresolved = 1)`)
        .bind(next, at, this.principal, strategy.strategy_id, mandate.mandate_id, mandate.digest, strategy.generation,
          this.principal, mandate.mandate_id, args.authorization.authorization_id,
          this.principal, mandate.account, mandate.network,
          mandate.account, mandate.network, this.principal,
          mandate.account, mandate.network, this.principal,
          this.principal, strategy.strategy_id),
      this.db.prepare(`UPDATE strategy_schedules SET enabled = 1, next_evaluation_at = ?,
        generation = generation + 1, updated_at = ? WHERE principal = ? AND strategy_id = ?
        AND EXISTS (SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND lifecycle = 'active'
          AND generation = ? AND updated_at = ?)`)
        .bind(next, at, this.principal, strategy.strategy_id, this.principal, strategy.strategy_id,
          strategy.generation + 1, at),
      this.conditionalAuditStatement(id("audit"), strategy.strategy_id, "owner", "activated",
        { mandate_version: mandate.version }, at, mandate.mandate_id, strategy.generation + 1),
    ]);
    if (results.some((result) => changes(result) !== 1)) throw new Error("strategy activation changed concurrently");
    return this.requireStrategy(strategy.strategy_id);
  }

  async pause(strategyId: string, now: Date, reason = "owner requested pause"): Promise<Strategy> {
    return this.transition(strategyId, ["active", "paused"], "paused", now, "paused", reason, false);
  }

  async resume(strategyId: string, now: Date): Promise<Strategy> {
    const strategy = await this.requireStrategy(strategyId);
    if (strategy.lifecycle !== "paused") throw new Error("only a paused strategy can resume");
    if (strategy.mandate.status !== "approved" || !strategy.mandate.authorization || now.getTime() >= Date.parse(strategy.mandate.expires_at) ||
        now.getTime() >= Date.parse(strategy.mandate.authorization.expires_at)) throw new Error("mandate is not currently authorized");
    if ((await this.getGlobalKill(strategy.mandate.account, strategy.mandate.network)).enabled) throw new Error("global kill switch is enabled");
    if (await this.getUnresolvedExecution(strategyId)) throw new Error("unresolved execution blocks resume");
    return this.transition(strategyId, ["paused"], "active", now, "resumed", "owner resumed unchanged mandate", true);
  }

  async stop(strategyId: string, now: Date, reason = "owner stopped strategy; unresolved submissions remain for reconciliation"): Promise<Strategy> {
    return this.transition(strategyId, ["draft", "paused", "active", "stopped", "error"], "stopped", now, "stopped", reason, false);
  }

  async kill(strategyId: string, now: Date, reason: string): Promise<Strategy> {
    if (!reason.trim()) throw new Error("kill reason is required");
    return this.transition(strategyId, ["draft", "paused", "active", "stopped", "error"], "stopped", now, "kill_enabled", reason, false);
  }

  async getGlobalKill(owner: string, network: "testnet"): Promise<StrategyKillSwitch> {
    const conflict = await this.ownerPrincipalConflict(owner, network);
    if (conflict) {
      return StrategyKillSwitchSchema.parse({
        enabled: true,
        reason: "owner strategy scope conflicts across authenticated principals",
        updated_at: conflict.updated_at,
      });
    }
    const row = await this.db.prepare(`SELECT kill_enabled, kill_reason, updated_at FROM strategy_global_controls
      WHERE principal = ? AND owner = ? AND network = ?`).bind(this.principal, owner, network)
      .first<{ kill_enabled: number; kill_reason: string | null; updated_at: string }>();
    if (!row) return StrategyKillSwitchSchema.parse({ enabled: true, reason: "not explicitly initialized", updated_at: new Date(0).toISOString() });
    return StrategyKillSwitchSchema.parse({ enabled: row.kill_enabled === 1, ...(row.kill_reason ? { reason: row.kill_reason } : {}), updated_at: row.updated_at });
  }

  async setGlobalKill(owner: string, network: "testnet", enabled: boolean, reason: string, now: Date): Promise<StrategyKillSwitch> {
    if (!reason.trim()) throw new Error("kill-switch reason is required");
    if (!enabled && await this.ownerPrincipalConflict(owner, network)) {
      throw new Error("owner strategy scope conflicts across authenticated principals; global kill remains enabled");
    }
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO strategy_global_controls(principal, owner, network, kill_enabled, kill_reason, generation, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(principal, owner, network) DO UPDATE SET kill_enabled = excluded.kill_enabled,
        kill_reason = excluded.kill_reason, generation = strategy_global_controls.generation + 1, updated_at = excluded.updated_at`)
        .bind(this.principal, owner, network, enabled ? 1 : 0, reason, at),
    ]);
    return this.getGlobalKill(owner, network);
  }

  private async ownerPrincipalConflict(owner: string, network: "testnet"): Promise<{ updated_at: string } | null> {
    return this.db.prepare(`SELECT updated_at FROM (
      SELECT principal, updated_at FROM strategies WHERE owner = ? AND network = ?
      UNION ALL
      SELECT principal, updated_at FROM strategy_global_controls WHERE owner = ? AND network = ?
    ) WHERE principal <> ? ORDER BY updated_at DESC LIMIT 1`)
      .bind(owner, network, owner, network, this.principal)
      .first<{ updated_at: string }>();
  }

  async listAudit(strategyId: string, limit = 100): Promise<StrategyAuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const statement = this.db.prepare(`SELECT * FROM strategy_audit_events WHERE principal = ? AND strategy_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).bind(this.principal, strategyId, safeLimit);
    const rows = await statement.all<Record<string, unknown>>();
    return rows.results.map((row) => StrategyAuditEventSchema.parse({
      event_id: row.id,
      ...(row.strategy_id ? { strategy_id: row.strategy_id } : {}),
      ...(row.trigger_id ? { trigger_id: row.trigger_id } : {}),
      ...(row.decision_id ? { decision_id: row.decision_id } : {}),
      ...(row.execution_id ? { execution_id: row.execution_id } : {}),
      actor: row.actor,
      kind: row.kind,
      detail: JSON.parse(String(row.detail_json)),
      at: row.created_at,
    }));
  }

  async getUnresolvedExecution(strategyId: string): Promise<UnresolvedStrategyExecution | null> {
    const row = await this.db.prepare(`SELECT * FROM strategy_executions WHERE principal = ? AND strategy_id = ?
      AND unresolved = 1 ORDER BY created_at LIMIT 1`).bind(this.principal, strategyId).first<Record<string, unknown>>();
    return row ? {
      id: String(row.id), strategyId: String(row.strategy_id), decisionId: String(row.decision_id),
      buildId: row.build_id === null ? null : String(row.build_id),
      harborExecutionId: row.harbor_execution_id === null ? null : String(row.harbor_execution_id),
      idempotencyKey: String(row.idempotency_key), txHash: row.tx_hash === null ? null : String(row.tx_hash),
      submissionState: String(row.submission_state), lastLedgerSequence: row.last_ledger_sequence === null ? null : Number(row.last_ledger_sequence),
    } : null;
  }

  async getExecutionForDecision(decisionId: string): Promise<UnresolvedStrategyExecution | null> {
    const row = await this.db.prepare(`SELECT * FROM strategy_executions WHERE principal = ? AND decision_id = ?`)
      .bind(this.principal, decisionId).first<Record<string, unknown>>();
    return row ? {
      id: String(row.id), strategyId: String(row.strategy_id), decisionId: String(row.decision_id),
      buildId: row.build_id === null ? null : String(row.build_id),
      harborExecutionId: row.harbor_execution_id === null ? null : String(row.harbor_execution_id),
      idempotencyKey: String(row.idempotency_key), txHash: row.tx_hash === null ? null : String(row.tx_hash),
      submissionState: String(row.submission_state), lastLedgerSequence: row.last_ledger_sequence === null ? null : Number(row.last_ledger_sequence),
    } : null;
  }

  async abandonPreSubmission(executionId: string, now: Date, evidence: Record<string, unknown>): Promise<void> {
    const execution = await this.db.prepare(`SELECT submission_state FROM strategy_executions
      WHERE principal = ? AND id = ?`).bind(this.principal, executionId).first<{ submission_state: string }>();
    if (!execution || execution.submission_state !== "prepared") throw new Error("only a definitely unsubmitted execution can be abandoned");
    await this.resolveExecution(executionId, "failed", evidence, now);
  }

  async getPendingDailyValue(strategyId: string, now: Date): Promise<string> {
    const strategy = await this.getStrategy(strategyId);
    if (strategy && isDeclarativeMandate(strategy.mandate)) {
      return (await this.getDeclarativeUsage(strategy, now)).daily_value;
    }
    const row = await this.db.prepare(`SELECT COALESCE(SUM(order_value_microunits), 0) AS amount
      FROM strategy_budget_reservations WHERE principal = ? AND strategy_id = ?
      AND state IN ('reserved','committed','unknown') AND reserved_at >= ?`)
      .bind(this.principal, strategyId, `${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
      .first<{ amount: number | string }>();
    return formatMicrounits(BigInt(row?.amount ?? 0));
  }

  async getDeclarativeUsage(
    strategy: Strategy,
    now: Date,
    excludeDecisionId?: string,
  ): Promise<DeclarativeStrategyUsage> {
    if (!isDeclarativeMandate(strategy.mandate)) {
      return {
        daily_value: await this.getPendingDailyValue(strategy.strategy_id, now),
        cumulative_value: "0",
        daily_fee_drops: "0",
        cumulative_fee_drops: "0",
        daily_trades: 0,
        total_trades: 0,
        mandate_occurrences: 0,
      };
    }
    const mandate = strategy.mandate;
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = await this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN reserved_at >= ? THEN order_value_microunits ELSE 0 END), 0) AS daily_value,
      COALESCE(SUM(order_value_microunits), 0) AS cumulative_value,
      COALESCE(SUM(CASE WHEN reserved_at >= ? THEN fee_drops ELSE 0 END), 0) AS daily_fees,
      COALESCE(SUM(fee_drops), 0) AS cumulative_fees,
      COALESCE(SUM(CASE WHEN reserved_at >= ? THEN 1 ELSE 0 END), 0) AS daily_trades,
      COUNT(*) AS total_trades,
      (SELECT COUNT(*) FROM strategy_declarative_reservations occurrence
        WHERE occurrence.principal = ? AND occurrence.mandate_id = ?
          AND (? IS NULL OR occurrence.decision_id <> ?)
          AND NOT (
            occurrence.state = 'released' AND
            COALESCE(json_extract(occurrence.release_evidence, '$.occurrence_release_reason'), '')
              IN ('pre_submit', 'not_included')
          )) AS mandate_occurrences
      FROM strategy_declarative_reservations
      WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
        AND (? IS NULL OR decision_id <> ?)
        AND state IN ('reserved','committed','unknown')`)
      .bind(
        dayStart,
        dayStart,
        dayStart,
        this.principal,
        mandate.mandate_id,
        excludeDecisionId ?? null,
        excludeDecisionId ?? null,
        mandate.account,
        mandate.network,
        mandate.issued_asset.currency,
        mandate.issued_asset.issuer,
        excludeDecisionId ?? null,
        excludeDecisionId ?? null,
      )
      .first<Record<string, number | string>>();
    return {
      daily_value: formatMicrounits(BigInt(row?.daily_value ?? 0)),
      cumulative_value: formatMicrounits(BigInt(row?.cumulative_value ?? 0)),
      daily_fee_drops: String(row?.daily_fees ?? 0),
      cumulative_fee_drops: String(row?.cumulative_fees ?? 0),
      daily_trades: Number(row?.daily_trades ?? 0),
      total_trades: Number(row?.total_trades ?? 0),
      mandate_occurrences: Number(row?.mandate_occurrences ?? 0),
    };
  }

  async getBudgetSummary(strategyId: string, now: Date): Promise<{ reserved_value: string; committed_value: string }> {
    const strategy = await this.getStrategy(strategyId);
    const table = strategy && isDeclarativeMandate(strategy.mandate)
      ? "strategy_declarative_reservations"
      : "strategy_budget_reservations";
    const rows = await this.db.prepare(`SELECT state, COALESCE(SUM(order_value_microunits), 0) AS amount
      FROM ${table} WHERE principal = ? AND strategy_id = ?
      AND state IN ('reserved','unknown','committed') AND reserved_at >= ? GROUP BY state`)
      .bind(this.principal, strategyId,
        `${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
      .all<{ state: string; amount: number | string }>();
    const values = new Map(rows.results.map((row) => [row.state, BigInt(row.amount)]));
    return { reserved_value: formatMicrounits((values.get("reserved") ?? 0n) + (values.get("unknown") ?? 0n)),
      committed_value: formatMicrounits(values.get("committed") ?? 0n) };
  }

  async recordHold(strategyId: string, explanation: string, now: Date): Promise<void> {
    await this.db.prepare(`UPDATE strategies SET hold_reason = ?, updated_at = ?
      WHERE principal = ? AND id = ? AND lifecycle = 'active'`)
      .bind(explanation.slice(0, 240), now.toISOString(), this.principal, strategyId).run();
  }

  async reserveDecision(
    strategy: Strategy,
    decision: StrategyDecision,
    executionId: string,
    now: Date,
    estimatedFeeDrops = "0",
  ): Promise<boolean> {
    if (!decision.proposed_value) throw new Error("trade decision has no value");
    if (isDeclarativeMandate(strategy.mandate)) {
      return this.reserveDeclarativeDecision(
        { ...strategy, mandate: strategy.mandate },
        decision,
        executionId,
        now,
        estimatedFeeDrops,
      );
    }
    const amount = decimalToMicrounitsCeil(decision.proposed_value);
    const cap = decimalToMicrounitsCeil(strategy.mandate.limits.max_daily_value);
    const reservationId = `reservation:${decision.decision_id}`;
    const result = await this.db.prepare(`INSERT INTO strategy_budget_reservations(
      id, principal, strategy_id, decision_id, mandate_id, mandate_version, order_value,
      order_value_microunits, fee_drops, state, execution_id, reserved_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, '0', 'reserved', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM strategy_budget_reservations WHERE principal = ? AND decision_id = ?)
      AND COALESCE((SELECT SUM(order_value_microunits) FROM strategy_budget_reservations
        WHERE principal = ? AND strategy_id = ? AND state IN ('reserved','committed','unknown')
          AND reserved_at >= ?), 0) + ? <= ?`)
      .bind(reservationId, this.principal, strategy.strategy_id, decision.decision_id,
        strategy.mandate.mandate_id, strategy.mandate.version, decision.proposed_value, amount,
        executionId, now.toISOString(), now.toISOString(), this.principal, decision.decision_id,
        this.principal, strategy.strategy_id, `${now.toISOString().slice(0, 10)}T00:00:00.000Z`, amount, cap).run();
    return changes(result) === 1;
  }

  private async reserveDeclarativeDecision(
    strategy: Strategy & { mandate: DeclarativeMandate },
    decision: StrategyDecision,
    executionId: string,
    now: Date,
    estimatedFeeDrops: string,
  ): Promise<boolean> {
    if (!decision.proposed_value) throw new Error("trade decision has no value");
    const mandate = strategy.mandate;
    const amount = decimalToMicrounitsCeil(decision.proposed_value);
    const fee = safeDrops(estimatedFeeDrops);
    const dailyCap = decimalToMicrounitsCeil(mandate.limits.max_daily_value);
    const cumulativeCap = decimalToMicrounitsCeil(mandate.limits.max_cumulative_value);
    const dailyFeeCap = safeDrops(mandate.limits.max_daily_fee_drops);
    const cumulativeFeeCap = safeDrops(mandate.limits.max_cumulative_fee_drops);
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const reservationId = `declarative-reservation:${decision.decision_id}`;
    const scope = [
      mandate.account,
      mandate.network,
      mandate.issued_asset.currency,
      mandate.issued_asset.issuer,
    ] as const;
    const result = await this.db.prepare(`INSERT INTO strategy_declarative_reservations(
      id, principal, strategy_id, decision_id, mandate_id, mandate_version,
      owner, network, issued_currency, issued_issuer, authority_not_before,
      authority_expires_at, order_value, order_value_microunits, fee_drops,
      state, execution_id, reserved_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM strategy_declarative_reservations
        WHERE principal = ? AND decision_id = ?
      )
      AND COALESCE((SELECT SUM(order_value_microunits)
        FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND state IN ('reserved','committed','unknown') AND reserved_at >= ?), 0) + ? <= ?
      AND COALESCE((SELECT SUM(order_value_microunits)
        FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND state IN ('reserved','committed','unknown')), 0) + ? <= ?
      AND COALESCE((SELECT SUM(fee_drops)
        FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND state IN ('reserved','committed','unknown') AND reserved_at >= ?), 0) + ? <= ?
      AND COALESCE((SELECT SUM(fee_drops)
        FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND state IN ('reserved','committed','unknown')), 0) + ? <= ?
      AND COALESCE((SELECT COUNT(*) FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND state IN ('reserved','committed','unknown') AND reserved_at >= ?), 0) + 1 <= ?
      AND COALESCE((SELECT COUNT(*) FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND state IN ('reserved','committed','unknown')), 0) + 1 <= ?
      AND (? IS NULL OR COALESCE((SELECT COUNT(*)
        FROM strategy_declarative_reservations occurrence
        WHERE occurrence.principal = ? AND occurrence.mandate_id = ?
          AND NOT (
            occurrence.state = 'released' AND
            COALESCE(json_extract(occurrence.release_evidence, '$.occurrence_release_reason'), '')
              IN ('pre_submit', 'not_included')
          )), 0) + 1 <= ?)`)
      .bind(
        reservationId,
        this.principal,
        strategy.strategy_id,
        decision.decision_id,
        mandate.mandate_id,
        mandate.version,
        mandate.account,
        mandate.network,
        mandate.issued_asset.currency,
        mandate.issued_asset.issuer,
        mandate.not_before,
        mandate.expires_at,
        decision.proposed_value,
        amount,
        fee,
        executionId,
        now.toISOString(),
        now.toISOString(),
        this.principal,
        decision.decision_id,
        ...scope,
        dayStart,
        amount,
        dailyCap,
        ...scope,
        amount,
        cumulativeCap,
        ...scope,
        dayStart,
        fee,
        dailyFeeCap,
        ...scope,
        fee,
        cumulativeFeeCap,
        ...scope,
        dayStart,
        mandate.limits.max_daily_trades,
        ...scope,
        mandate.limits.max_total_trades,
        mandate.limits.max_mandate_occurrences ?? null,
        this.principal,
        mandate.mandate_id,
        mandate.limits.max_mandate_occurrences ?? null,
      )
      .run();
    return changes(result) === 1;
  }

  async updateReservedFee(
    strategy: Strategy,
    decisionId: string,
    feeDrops: string,
    now: Date,
  ): Promise<boolean> {
    if (!isDeclarativeMandate(strategy.mandate)) return true;
    const mandate = strategy.mandate;
    const fee = safeDrops(feeDrops);
    if (fee > safeDrops(mandate.limits.max_fee_drops)) return false;
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const scope = [
      mandate.account,
      mandate.network,
      mandate.issued_asset.currency,
      mandate.issued_asset.issuer,
    ] as const;
    const result = await this.db.prepare(`UPDATE strategy_declarative_reservations
      SET fee_drops = ?, updated_at = ?
      WHERE principal = ? AND decision_id = ? AND state = 'reserved'
      AND COALESCE((SELECT SUM(fee_drops) FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND decision_id <> ? AND state IN ('reserved','committed','unknown')
          AND reserved_at >= ?), 0) + ? <= ?
      AND COALESCE((SELECT SUM(fee_drops) FROM strategy_declarative_reservations
        WHERE owner = ? AND network = ? AND issued_currency = ? AND issued_issuer = ?
          AND decision_id <> ? AND state IN ('reserved','committed','unknown')), 0) + ? <= ?`)
      .bind(
        fee,
        now.toISOString(),
        this.principal,
        decisionId,
        ...scope,
        decisionId,
        dayStart,
        fee,
        safeDrops(mandate.limits.max_daily_fee_drops),
        ...scope,
        decisionId,
        fee,
        safeDrops(mandate.limits.max_cumulative_fee_drops),
      )
      .run();
    return changes(result) === 1;
  }

  async markBudgetHold(
    decisionId: string,
    explanation: string,
    now: Date,
    code: StrategyHoldCode = "daily_limit",
  ): Promise<void> {
    const result = await this.db.prepare(`UPDATE strategy_decisions SET action = 'hold',
      hold_codes_json = ?, proposed_value = NULL, state = 'held', explanation = ?, updated_at = ?
      WHERE principal = ? AND id = ? AND state = 'planned'`)
      .bind(JSON.stringify([code]), explanation, now.toISOString(), this.principal, decisionId).run();
    if (changes(result) !== 1) throw new Error("budget hold decision changed concurrently");
  }

  async beginExecution(decision: StrategyDecision, executionId: string, idempotencyKey: string, now: Date): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO strategy_executions(
      id, principal, strategy_id, decision_id, idempotency_key, submission_state,
      unresolved, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'prepared', 1, ?, ?)`)
      .bind(executionId, this.principal, decision.strategy_id, decision.decision_id,
        idempotencyKey, now.toISOString(), now.toISOString()).run();
  }

  async attachBuild(executionId: string, buildId: string, lastLedgerSequence: number | null, now: Date): Promise<void> {
    const result = await this.db.prepare(`UPDATE strategy_executions SET build_id = ?,
      last_ledger_sequence = ?, updated_at = ? WHERE principal = ? AND id = ?
      AND submission_state = 'prepared' AND build_id IS NULL`)
      .bind(buildId, lastLedgerSequence, now.toISOString(), this.principal, executionId).run();
    if (changes(result) !== 1) throw new Error("strategy execution build identity changed concurrently");
  }

  async markExecution(executionId: string, state: "submitting" | "unknown" | "submitted" | "needs_approval" | "failed",
    now: Date, input: { harborExecutionId?: string; txHash?: string } = {}): Promise<void> {
    const declarative = await this.executionIsDeclarative(executionId);
    const reservationState = state === "unknown" || state === "submitted" ||
      state === "submitting" || state === "needs_approval"
      ? "unknown"
      : state === "failed" ? "released" : "reserved";
    const reservationStatement = declarative
      ? this.db.prepare(`UPDATE strategy_declarative_reservations SET state = ?,
          released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END,
          release_evidence = CASE WHEN ? = 'released' THEN ? ELSE release_evidence END,
          updated_at = ? WHERE principal = ? AND execution_id = ?
          AND state IN ('reserved','unknown')`)
        .bind(reservationState, reservationState, now.toISOString(), reservationState,
          reservationState === "released" ? JSON.stringify({ state }) : null,
          now.toISOString(), this.principal, executionId)
      : this.db.prepare(`UPDATE strategy_budget_reservations SET state = ?, updated_at = ?
          WHERE principal = ? AND execution_id = ? AND state IN ('reserved','unknown')`)
        .bind(reservationState, now.toISOString(), this.principal, executionId);
    await this.db.batch([
      this.db.prepare(`UPDATE strategy_executions SET submission_state = ?, harbor_execution_id = COALESCE(?, harbor_execution_id),
        tx_hash = COALESCE(?, tx_hash), unresolved = ?, updated_at = ? WHERE principal = ? AND id = ?`)
        .bind(state, input.harborExecutionId ?? null, input.txHash ?? null,
          state === "failed" ? 0 : 1, now.toISOString(), this.principal, executionId),
      reservationStatement,
    ]);
  }

  async markSubmittingFenced(executionId: string, strategy: Strategy, lease: StrategyLease, now: Date): Promise<boolean> {
    const declarative = isDeclarativeMandate(strategy.mandate);
    const reservationTable = declarative
      ? "strategy_declarative_reservations"
      : "strategy_budget_reservations";
    const reservationStatement = declarative
      ? this.db.prepare(`UPDATE strategy_declarative_reservations SET state = 'unknown', updated_at = ?
          WHERE principal = ? AND execution_id = ? AND state = 'reserved' AND EXISTS (
            SELECT 1 FROM strategy_executions WHERE principal = ? AND id = ? AND submission_state = 'submitting')`)
        .bind(now.toISOString(), this.principal, executionId, this.principal, executionId)
      : this.db.prepare(`UPDATE strategy_budget_reservations SET state = 'unknown', updated_at = ?
          WHERE principal = ? AND execution_id = ? AND state = 'reserved' AND EXISTS (
            SELECT 1 FROM strategy_executions WHERE principal = ? AND id = ? AND submission_state = 'submitting')`)
        .bind(now.toISOString(), this.principal, executionId, this.principal, executionId);
    const results = await this.db.batch([
      this.db.prepare(`UPDATE strategy_executions SET submission_state = 'submitting', unresolved = 1, updated_at = ?
        WHERE principal = ? AND id = ? AND submission_state = 'prepared' AND EXISTS (
          SELECT 1 FROM strategies s WHERE s.principal = ? AND s.id = ? AND s.lifecycle = 'active'
            AND s.generation = ? AND s.mandate_id = ? AND s.mandate_digest = ?) AND EXISTS (
          SELECT 1 FROM strategy_mandates m WHERE m.principal = ? AND m.id = ?
            AND m.version = ? AND m.digest = ? AND m.status = 'approved'
            AND m.not_before <= ? AND m.expires_at > ?
            AND json_extract(m.config_json, '$.authorization.expires_at') > ?) AND EXISTS (
          SELECT 1 FROM strategy_leases l WHERE l.principal = ? AND l.strategy_id = ? AND l.lease_token = ?
            AND l.fencing_token = ? AND l.expires_at > ?) AND EXISTS (
          SELECT 1 FROM strategy_global_controls g WHERE g.principal = ? AND g.owner = ? AND g.network = ?
            AND g.kill_enabled = 0) AND NOT EXISTS (
          SELECT 1 FROM strategies owner_scope WHERE owner_scope.owner = ? AND owner_scope.network = ?
            AND owner_scope.principal <> ?) AND NOT EXISTS (
          SELECT 1 FROM strategy_global_controls control_scope WHERE control_scope.owner = ?
            AND control_scope.network = ? AND control_scope.principal <> ?) AND EXISTS (
          SELECT 1 FROM ${reservationTable} reservation
          WHERE reservation.principal = ? AND reservation.execution_id = ?
            AND reservation.state = 'reserved')`)
        .bind(now.toISOString(), this.principal, executionId, this.principal, strategy.strategy_id,
          strategy.generation, strategy.mandate.mandate_id, strategy.mandate.digest,
          this.principal, strategy.mandate.mandate_id, strategy.mandate.version,
          strategy.mandate.digest, now.toISOString(), now.toISOString(), now.toISOString(),
          lease.principal, lease.strategyId, lease.token, lease.fencingToken, now.toISOString(),
          this.principal, strategy.mandate.account, strategy.mandate.network,
          strategy.mandate.account, strategy.mandate.network, this.principal,
          strategy.mandate.account, strategy.mandate.network, this.principal,
          this.principal, executionId),
      reservationStatement,
    ]);
    if (changes(results[0]) === 0) return false;
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) {
      throw new Error("submission fence changed inconsistently");
    }
    return true;
  }

  async resolveExecution(executionId: string, state: "validated" | "not_included" | "failed",
    evidence: Record<string, unknown>, now: Date): Promise<void> {
    const declarative = await this.executionIsDeclarative(executionId);
    const reservationStatement = declarative
      ? this.db.prepare(`UPDATE strategy_declarative_reservations SET state = ?,
          released_at = ?, release_evidence = ?, updated_at = ?
          WHERE principal = ? AND execution_id = ? AND state IN ('reserved','unknown')`)
        .bind(state === "validated" ? "committed" : "released",
          state === "validated" ? null : now.toISOString(), JSON.stringify(evidence),
          now.toISOString(), this.principal, executionId)
      : this.db.prepare(`UPDATE strategy_budget_reservations SET state = ?, released_at = ?, release_evidence = ?, updated_at = ?
          WHERE principal = ? AND execution_id = ? AND state IN ('reserved','unknown')`)
        .bind(state === "validated" ? "committed" : "released",
          state === "validated" ? null : now.toISOString(), JSON.stringify(evidence),
          now.toISOString(), this.principal, executionId);
    await this.db.batch([
      this.db.prepare(`UPDATE strategy_executions SET submission_state = ?, unresolved = 0,
        resolved_at = ?, resolution_evidence = ?, updated_at = ? WHERE principal = ? AND id = ? AND unresolved = 1`)
        .bind(state, now.toISOString(), JSON.stringify(evidence), now.toISOString(), this.principal, executionId),
      reservationStatement,
    ]);
  }

  async pauseForRunner(strategyId: string, reason: string, now: Date): Promise<void> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE strategies SET lifecycle = 'paused', next_evaluation_at = NULL,
        hold_reason = ?, generation = generation + 1, updated_at = ? WHERE principal = ? AND id = ? AND lifecycle = 'active'`)
        .bind(reason, at, this.principal, strategyId),
      this.db.prepare(`UPDATE strategy_schedules SET enabled = 0, generation = generation + 1, updated_at = ?
        WHERE principal = ? AND strategy_id = ? AND EXISTS (SELECT 1 FROM strategies
          WHERE principal = ? AND id = ? AND lifecycle = 'paused' AND updated_at = ? AND hold_reason = ?)`)
        .bind(at, this.principal, strategyId, this.principal, strategyId, at, reason),
    ]);
    if (changes(results[0]) === 0) return;
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) throw new Error("runner pause changed concurrently");
  }

  async appendAudit(input: {
    strategyId: string;
    triggerId?: string;
    decisionId?: string;
    executionId?: string;
    actor: StrategyAuditEvent["actor"];
    kind: StrategyAuditEvent["kind"];
    detail: Record<string, unknown>;
    at: Date;
  }): Promise<void> {
    await this.db.prepare(`INSERT INTO strategy_audit_events(
      id, principal, strategy_id, trigger_id, decision_id, execution_id, actor, kind, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id("audit"), this.principal, input.strategyId, input.triggerId ?? null, input.decisionId ?? null,
        input.executionId ?? null, input.actor, input.kind, JSON.stringify(input.detail), input.at.toISOString()).run();
  }

  async markTradeComplete(strategyId: string, now: Date): Promise<void> {
    await this.db.prepare(`UPDATE strategies SET last_trade_at = ?, hold_reason = NULL, updated_at = ?
      WHERE principal = ? AND id = ?`).bind(now.toISOString(), now.toISOString(), this.principal, strategyId).run();
  }

  private insertMandate(mandate: AnyStrategyMandate, createdAt: string): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO strategy_mandates(
      id, principal, strategy_id, version, digest, status, kind, network, owner,
      issued_currency, issued_issuer, config_json, not_before, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'testnet', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(mandate.mandate_id, this.principal, mandate.strategy_id, mandate.version, mandate.digest,
        // Migration 0011 intentionally freezes the legacy discriminator. The
        // additive v2 table below is the authoritative declarative kind/plan
        // marker; config_json retains the exact owner-approved mandate.
        mandate.status, "xrp_issued_rebalancer_v1", mandate.account,
        mandate.issued_asset.currency, mandate.issued_asset.issuer,
        JSON.stringify(mandate), mandate.not_before, mandate.expires_at, createdAt);
  }

  private insertDeclarativePlan(
    mandate: DeclarativeMandate,
    createdAt: string,
  ): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO strategy_declarative_plans(
      mandate_id, principal, strategy_id, mandate_version, plan_version,
      plan_digest, plan_json, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM strategy_mandates
      WHERE principal = ? AND id = ? AND strategy_id = ? AND version = ?
        AND digest = ? AND status = 'draft'
    )`)
      .bind(
        mandate.mandate_id,
        this.principal,
        mandate.strategy_id,
        mandate.version,
        mandate.plan.plan_version,
        mandate.digest,
        JSON.stringify(mandate.plan),
        createdAt,
        this.principal,
        mandate.mandate_id,
        mandate.strategy_id,
        mandate.version,
        mandate.digest,
      );
  }

  private async executionIsDeclarative(executionId: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT m.config_json FROM strategy_executions e
      JOIN strategy_decisions d ON d.principal = e.principal AND d.id = e.decision_id
      JOIN strategy_mandates m ON m.principal = d.principal
        AND m.strategy_id = d.strategy_id AND m.version = d.mandate_version
        AND m.digest = d.mandate_digest
      WHERE e.principal = ? AND e.id = ?`)
      .bind(this.principal, executionId)
      .first<{ config_json: string }>();
    if (!row) return false;
    return StrategyMandateSchema.parse(JSON.parse(row.config_json)).kind ===
      "declarative_strategy_v1";
  }

  private async requireStrategy(strategyId: string): Promise<Strategy> {
    const result = await this.getStrategy(strategyId);
    if (!result) throw new Error("strategy not found");
    return result;
  }

  private async transition(strategyId: string, allowed: string[], lifecycle: Strategy["lifecycle"], now: Date,
    kind: StrategyAuditEvent["kind"], reason: string, enabled: boolean): Promise<Strategy> {
    const current = await this.requireStrategy(strategyId);
    const at = now.toISOString();
    const placeholders = allowed.map(() => "?").join(",");
    const result = await this.db.batch([
      this.db.prepare(`UPDATE strategies SET lifecycle = ?, generation = generation + 1,
        next_evaluation_at = CASE WHEN ? = 1 THEN COALESCE(next_evaluation_at, ?) ELSE NULL END,
        hold_reason = ?, updated_at = ? WHERE principal = ? AND id = ? AND generation = ? AND lifecycle IN (${placeholders})
        AND (? = 0 OR EXISTS (SELECT 1 FROM strategy_global_controls WHERE principal = ? AND owner = ?
          AND network = ? AND kill_enabled = 0) AND NOT EXISTS (
          SELECT 1 FROM strategies owner_scope WHERE owner_scope.owner = ? AND owner_scope.network = ?
            AND owner_scope.principal <> ?) AND NOT EXISTS (
          SELECT 1 FROM strategy_global_controls control_scope WHERE control_scope.owner = ?
            AND control_scope.network = ? AND control_scope.principal <> ?) AND NOT EXISTS (
          SELECT 1 FROM strategy_executions execution WHERE execution.principal = ?
            AND execution.strategy_id = ? AND execution.unresolved = 1))`)
        .bind(lifecycle, enabled ? 1 : 0, at, reason, at, this.principal, strategyId, current.generation, ...allowed,
          enabled ? 1 : 0, this.principal, current.mandate.account, current.mandate.network,
          current.mandate.account, current.mandate.network, this.principal,
          current.mandate.account, current.mandate.network, this.principal,
          this.principal, strategyId),
      this.db.prepare(`UPDATE strategy_schedules SET enabled = ?, generation = generation + 1,
        next_evaluation_at = CASE WHEN ? = 1 THEN ? ELSE next_evaluation_at END, updated_at = ?
        WHERE principal = ? AND strategy_id = ? AND EXISTS (
          SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND lifecycle = ? AND generation = ? AND updated_at = ?)`)
        .bind(enabled ? 1 : 0, enabled ? 1 : 0, at, at, this.principal, strategyId,
          this.principal, strategyId, lifecycle, current.generation + 1, at),
      this.db.prepare(`INSERT INTO strategy_audit_events(id, principal, strategy_id, actor, kind, detail_json, created_at)
        SELECT ?, ?, ?, 'owner', ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND lifecycle = ? AND generation = ? AND updated_at = ?)`)
        .bind(id("audit"), this.principal, strategyId, kind, JSON.stringify({ reason }), at,
          this.principal, strategyId, lifecycle, current.generation + 1, at),
    ]);
    if (result.some((entry) => changes(entry) !== 1)) throw new Error("strategy lifecycle changed concurrently");
    return this.requireStrategy(strategyId);
  }

  private auditStatement(eventId: string, strategyId: string | null, actor: string, kind: string,
    detail: Record<string, unknown>, at: string): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO strategy_audit_events(
      id, principal, strategy_id, actor, kind, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(eventId, this.principal, strategyId, actor, kind, JSON.stringify(detail), at);
  }

  private conditionalAuditStatement(eventId: string, strategyId: string, actor: string, kind: string,
    detail: Record<string, unknown>, at: string, mandateId: string, generation: number): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO strategy_audit_events(
      id, principal, strategy_id, actor, kind, detail_json, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM strategies WHERE principal = ? AND id = ? AND mandate_id = ? AND generation = ?)`)
      .bind(eventId, this.principal, strategyId, actor, kind, JSON.stringify(detail), at,
        this.principal, strategyId, mandateId, generation);
  }
}

export class StrategySchedulerStore {
  constructor(readonly db: D1Database) {}

  async listDue(now: Date, limit = 20): Promise<DueStrategy[]> {
    const rows = await this.db.prepare(`SELECT s.principal, s.id AS strategy_id, s.mandate_version,
      sc.generation AS schedule_generation, sc.next_evaluation_at
      FROM strategies s JOIN strategy_schedules sc ON sc.strategy_id = s.id AND sc.principal = s.principal
      WHERE s.lifecycle = 'active' AND sc.enabled = 1 AND sc.next_evaluation_at <= ?
      ORDER BY sc.next_evaluation_at, s.id LIMIT ?`).bind(now.toISOString(), Math.min(100, Math.max(1, limit))).all<Record<string, unknown>>();
    return rows.results.map((row) => ({ principal: String(row.principal), strategyId: String(row.strategy_id),
      mandateVersion: Number(row.mandate_version), scheduleGeneration: Number(row.schedule_generation),
      scheduledFor: String(row.next_evaluation_at) }));
  }

  async listUnresolved(limit = 20): Promise<Array<{ principal: string; strategyId: string; executionId: string }>> {
    const rows = await this.db.prepare(`SELECT principal, strategy_id, id FROM strategy_executions
      WHERE unresolved = 1 AND submission_state IN ('submitting','unknown','submitted','needs_approval')
      ORDER BY updated_at, id LIMIT ?`).bind(Math.min(100, Math.max(1, limit))).all<Record<string, unknown>>();
    return rows.results.map((row) => ({ principal: String(row.principal), strategyId: String(row.strategy_id), executionId: String(row.id) }));
  }

  async claim(due: DueStrategy, holderId: string, now: Date, ttlMs = 60_000): Promise<StrategyLease | null> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await this.db.prepare(`INSERT OR IGNORE INTO strategy_leases(
      strategy_id, principal, holder_id, lease_token, fencing_token, acquired_at, heartbeat_at, expires_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(due.strategyId, due.principal, holderId, token, now.toISOString(), now.toISOString(), expiresAt).run();
    await this.db.prepare(`UPDATE strategy_leases SET holder_id = ?, lease_token = ?, fencing_token = fencing_token + 1,
      acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE principal = ? AND strategy_id = ? AND expires_at <= ?`)
      .bind(holderId, token, now.toISOString(), now.toISOString(), expiresAt, due.principal, due.strategyId, now.toISOString()).run();
    const row = await this.db.prepare(`SELECT lease_token, fencing_token, expires_at FROM strategy_leases
      WHERE principal = ? AND strategy_id = ?`).bind(due.principal, due.strategyId)
      .first<{ lease_token: string; fencing_token: number; expires_at: string }>();
    return row?.lease_token === token ? { principal: due.principal, strategyId: due.strategyId, token,
      fencingToken: row.fencing_token, expiresAt: row.expires_at } : null;
  }

  async isCurrent(lease: StrategyLease, now = new Date()): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 AS present FROM strategy_leases WHERE principal = ? AND strategy_id = ?
      AND lease_token = ? AND fencing_token = ? AND expires_at > ?`).bind(
        lease.principal, lease.strategyId, lease.token, lease.fencingToken, now.toISOString())
      .first<{ present: number }>();
    return row !== null;
  }

  async renew(lease: StrategyLease, now: Date, ttlMs = 300_000): Promise<StrategyLease | null> {
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const result = await this.db.prepare(`UPDATE strategy_leases SET heartbeat_at = ?, expires_at = ?
      WHERE principal = ? AND strategy_id = ? AND lease_token = ? AND fencing_token = ? AND expires_at > ?`)
      .bind(now.toISOString(), expiresAt, lease.principal, lease.strategyId, lease.token, lease.fencingToken, now.toISOString()).run();
    return changes(result) === 1 ? { ...lease, expiresAt } : null;
  }

  async release(lease: StrategyLease): Promise<void> {
    await this.db.prepare(`DELETE FROM strategy_leases WHERE principal = ? AND strategy_id = ?
      AND lease_token = ? AND fencing_token = ?`).bind(lease.principal, lease.strategyId, lease.token, lease.fencingToken).run();
  }

  async createTrigger(
    due: DueStrategy,
    lease: StrategyLease,
    triggerId: string,
    now: Date,
  ): Promise<"created" | "terminal" | "duplicate"> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO strategy_triggers(
      id, principal, strategy_id, schedule_generation, scheduled_for, status, lease_fencing_token, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, 'running', ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ? AND lease_token = ?
        AND fencing_token = ? AND expires_at > ?)`)
      .bind(triggerId, due.principal, due.strategyId, due.scheduleGeneration, due.scheduledFor,
        lease.fencingToken, now.toISOString(), now.toISOString(), due.principal, due.strategyId,
        lease.token, lease.fencingToken, now.toISOString()).run();
    if (changes(result) === 1) return "created";
    const recovered = await this.db.prepare(`UPDATE strategy_triggers SET lease_fencing_token = ?, updated_at = ?
      WHERE principal = ? AND id = ? AND strategy_id = ? AND schedule_generation = ? AND scheduled_for = ?
      AND status = 'running' AND EXISTS (SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ?
        AND lease_token = ? AND fencing_token = ? AND expires_at > ?)`)
      .bind(lease.fencingToken, now.toISOString(), due.principal, triggerId, due.strategyId,
        due.scheduleGeneration, due.scheduledFor, due.principal, due.strategyId, lease.token,
        lease.fencingToken, now.toISOString()).run();
    if (changes(recovered) === 1) return "created";
    const existing = await this.db.prepare(`SELECT status FROM strategy_triggers
      WHERE principal = ? AND id = ? AND strategy_id = ? AND schedule_generation = ?
        AND scheduled_for = ?`)
      .bind(
        due.principal,
        triggerId,
        due.strategyId,
        due.scheduleGeneration,
        due.scheduledFor,
      )
      .first<{ status: string }>();
    return existing && ["complete", "blocked", "failed"].includes(existing.status)
      ? "terminal"
      : "duplicate";
  }

  async getTriggerDecision(principal: string, triggerId: string): Promise<{
    decisionId: string; action: "hold" | "buy_xrp" | "sell_xrp"; state: string;
  } | null> {
    const row = await this.db.prepare(`SELECT id, action, state FROM strategy_decisions
      WHERE principal = ? AND trigger_id = ?`).bind(principal, triggerId)
      .first<{ id: string; action: "hold" | "buy_xrp" | "sell_xrp"; state: string }>();
    return row ? { decisionId: row.id, action: row.action, state: row.state } : null;
  }

  async persistDecision(principal: string, lease: StrategyLease, mandate: AnyStrategyMandate,
    decision: StrategyDecision, now: Date, snapshot: Record<string, unknown> = {}): Promise<boolean> {
    const result = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO strategy_decisions(
        id, principal, strategy_id, trigger_id, mandate_id, mandate_version, mandate_digest,
        action, hold_codes_json, snapshot_json, proposed_value, state, explanation, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ? AND lease_token = ?
          AND fencing_token = ? AND expires_at > ?)`)
        .bind(decision.decision_id, principal, decision.strategy_id, decision.trigger_id, mandate.mandate_id,
          mandate.version, mandate.digest, decision.action, JSON.stringify(decision.hold_codes), JSON.stringify(snapshot), decision.proposed_value ?? null,
          decision.action === "hold" ? "held" : "planned", decision.explanation, now.toISOString(), now.toISOString(),
          principal, decision.strategy_id, lease.token, lease.fencingToken, now.toISOString()),
      this.db.prepare(`UPDATE strategy_triggers SET decision_id = ?, status = ?, updated_at = ?
        WHERE principal = ? AND id = ? AND lease_fencing_token = ? AND EXISTS (
          SELECT 1 FROM strategy_decisions WHERE principal = ? AND id = ?) AND EXISTS (
          SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ? AND lease_token = ?
            AND fencing_token = ? AND expires_at > ?)`)
        .bind(decision.decision_id, decision.action === "hold" ? "complete" : "running", now.toISOString(),
          principal, decision.trigger_id, lease.fencingToken, principal, decision.decision_id,
          principal, decision.strategy_id, lease.token, lease.fencingToken, now.toISOString()),
    ]);
    return changes(result[0]) === 1 && changes(result[1]) === 1;
  }

  async finishTrigger(principal: string, lease: StrategyLease, triggerId: string,
    decisionId: string, status: "complete" | "blocked" | "failed", now: Date,
    decisionState?: "executed" | "needs_approval" | "pending_reconciliation" | "failed"): Promise<void> {
    const statements = [
      this.db.prepare(`UPDATE strategy_triggers SET status = ?, updated_at = ?
        WHERE principal = ? AND id = ? AND decision_id = ? AND lease_fencing_token = ? AND EXISTS (
          SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ? AND lease_token = ?
            AND fencing_token = ? AND expires_at > ?)`)
        .bind(status, now.toISOString(), principal, triggerId, decisionId, lease.fencingToken,
          principal, lease.strategyId, lease.token, lease.fencingToken, now.toISOString()),
    ];
    if (decisionState) {
      statements.push(this.db.prepare(`UPDATE strategy_decisions SET state = ?, updated_at = ?
        WHERE principal = ? AND id = ? AND trigger_id = ?`)
        .bind(decisionState, now.toISOString(), principal, decisionId, triggerId));
    }
    const results = await this.db.batch(statements);
    if (results.some((result) => changes(result) !== 1)) throw new Error("stale strategy lease cannot finish trigger");
  }

  async advanceSchedule(due: DueStrategy, lease: StrategyLease, intervalSeconds: number, now: Date): Promise<void> {
    const next = new Date(Math.max(Date.parse(due.scheduledFor) + intervalSeconds * 1_000, now.getTime() + intervalSeconds * 1_000)).toISOString();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE strategy_schedules SET next_evaluation_at = ?, generation = generation + 1, updated_at = ?
        WHERE principal = ? AND strategy_id = ? AND generation = ? AND EXISTS (
          SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ? AND lease_token = ? AND fencing_token = ?
            AND expires_at > ?)`)
        .bind(next, now.toISOString(), due.principal, due.strategyId, due.scheduleGeneration,
          due.principal, due.strategyId, lease.token, lease.fencingToken, now.toISOString()),
      this.db.prepare(`UPDATE strategies SET next_evaluation_at = ?, last_evaluation_at = ?, updated_at = ?
        WHERE principal = ? AND id = ? AND EXISTS (
          SELECT 1 FROM strategy_schedules WHERE principal = ? AND strategy_id = ? AND generation = ?
            AND next_evaluation_at = ? AND updated_at = ?) AND EXISTS (
          SELECT 1 FROM strategy_leases WHERE principal = ? AND strategy_id = ? AND lease_token = ?
            AND fencing_token = ? AND expires_at > ?)`)
        .bind(next, now.toISOString(), now.toISOString(), due.principal, due.strategyId,
          due.principal, due.strategyId, due.scheduleGeneration + 1, next, now.toISOString(),
          due.principal, due.strategyId, lease.token, lease.fencingToken, now.toISOString()),
    ]);
    if (results.some((result) => changes(result) !== 1)) throw new Error("stale strategy lease cannot advance schedule");
  }
}

export async function stableStrategyId(prefix: string, ...parts: string[]): Promise<string> {
  return `${prefix}:${(await digest(parts)).slice(0, 48)}`;
}
