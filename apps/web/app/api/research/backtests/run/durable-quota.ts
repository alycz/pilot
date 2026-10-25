import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BacktestQuotaError,
  type BacktestAccessScope,
  type BacktestExternalReadQuota,
} from "./quota-contract";

const DATABASE_NAME = "backtest-external-read-quota.sqlite";
const SCHEMA_VERSION = 1;
const WINDOW_MS = 60 * 60 * 1_000;
const MAX_ACTIVE_RESERVATIONS = 4_096;
export const BACKTEST_QUOTA_POLICY_VERSION = "pilot.backtest.external-read.v1";

type Environment = Readonly<Record<string, string | undefined>>;

export type SqliteBacktestQuotaConfig = Readonly<{
  backend: "sqlite-single-host";
  stateDirectory: string;
  policyVersion: typeof BACKTEST_QUOTA_POLICY_VERSION;
  accountMaximum: number;
  sessionMaximum: number;
}>;

export type HarborD1BacktestQuotaConfig = Readonly<{
  backend: "harbor-d1";
  policyVersion: typeof BACKTEST_QUOTA_POLICY_VERSION;
  accountMaximum: number;
  sessionMaximum: number;
}>;

export type BacktestQuotaConfig = SqliteBacktestQuotaConfig | HarborD1BacktestQuotaConfig;

export type BacktestQuotaFactoryDependencies = Readonly<{
  createHarborD1Quota?: (
    config: HarborD1BacktestQuotaConfig,
    environment: Environment,
  ) => BacktestExternalReadQuota;
}>;

function configurationError(message: string): never {
  throw new BacktestQuotaError("QUOTA_UNAVAILABLE", `backtest external-read quota is misconfigured: ${message}`);
}

function positiveInteger(environment: Environment, name: string, maximum: number): number {
  const value = environment[name];
  if (!value || !/^[1-9][0-9]*$/.test(value)) configurationError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) configurationError(`${name} exceeds its supported bound`);
  return parsed;
}

function validateStateDirectory(path: string | undefined): string {
  if (!path || !isAbsolute(path) || resolve(path) !== path) {
    return configurationError("BACKTEST_QUOTA_STATE_DIR must be a normalized absolute path");
  }
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return configurationError("BACKTEST_QUOTA_STATE_DIR must be a pre-existing private directory");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return configurationError("BACKTEST_QUOTA_STATE_DIR must be a real directory, not a symbolic link");
  }
  if (realpathSync(path) !== path) {
    return configurationError("BACKTEST_QUOTA_STATE_DIR must use its canonical path");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    return configurationError("BACKTEST_QUOTA_STATE_DIR must have exact mode 0700");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    return configurationError("BACKTEST_QUOTA_STATE_DIR must be owned by the current user");
  }
  return path;
}

function isServerless(environment: Environment): boolean {
  return environment.VERCEL === "1" ||
    environment.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    environment.AWS_EXECUTION_ENV?.startsWith("AWS_Lambda_") === true;
}

/**
 * External reads are disabled unless either the complete private single-host
 * contract or the exact shared Harbor D1 contract is configured.
 */
export function readBacktestQuotaConfig(
  environment: Environment = process.env,
): BacktestQuotaConfig | null {
  const enabled = environment.BACKTEST_EXTERNAL_READS_ENABLED;
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") return configurationError("BACKTEST_EXTERNAL_READS_ENABLED must be exactly 0 or 1");
  const backend = environment.BACKTEST_QUOTA_BACKEND;
  if (backend !== "sqlite-single-host" && backend !== "harbor-d1") {
    return configurationError("BACKTEST_QUOTA_BACKEND must be sqlite-single-host or harbor-d1");
  }
  if (backend === "sqlite-single-host" && isServerless(environment)) {
    return configurationError("sqlite-single-host quota cannot enable external reads on serverless deployments");
  }
  if (environment.BACKTEST_QUOTA_POLICY_VERSION !== BACKTEST_QUOTA_POLICY_VERSION) {
    return configurationError(`BACKTEST_QUOTA_POLICY_VERSION must be ${BACKTEST_QUOTA_POLICY_VERSION}`);
  }
  const accountMaximum = positiveInteger(environment, "BACKTEST_QUOTA_ACCOUNT_HOURLY_RUNS", 24);
  const sessionMaximum = positiveInteger(environment, "BACKTEST_QUOTA_SESSION_HOURLY_RUNS", 12);
  if (sessionMaximum > accountMaximum) {
    return configurationError("session hourly runs cannot exceed account hourly runs");
  }
  return backend === "sqlite-single-host"
    ? Object.freeze({
      backend,
      stateDirectory: validateStateDirectory(environment.BACKTEST_QUOTA_STATE_DIR),
      policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
      accountMaximum,
      sessionMaximum,
    })
    : Object.freeze({
      backend,
      policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
      accountMaximum,
      sessionMaximum,
    });
}

class UnavailableBacktestQuota implements BacktestExternalReadQuota {
  reserve(): never {
    throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "durable backtest quota is not configured and verified");
  }
}

export class SqliteBacktestExternalReadQuota implements BacktestExternalReadQuota {
  private readonly database!: DatabaseSync;

  constructor(readonly config: SqliteBacktestQuotaConfig) {
    const databasePath = join(config.stateDirectory, DATABASE_NAME);
    try {
      let existing: ReturnType<typeof lstatSync> | undefined;
      try {
        existing = lstatSync(databasePath);
      } catch {
        existing = undefined;
      }
      if (existing && (existing.isSymbolicLink() || !existing.isFile() ||
        (existing.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && existing.uid !== process.getuid()))) {
        throw new Error("unsafe quota database path");
      }
      this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
      if (!existing) chmodSync(databasePath, 0o600);
      this.database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS backtest_quota_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL,
          policy_version TEXT NOT NULL,
          account_maximum INTEGER NOT NULL,
          session_maximum INTEGER NOT NULL,
          window_ms INTEGER NOT NULL,
          max_active_reservations INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backtest_quota_session_bindings (
          session_scope_id TEXT PRIMARY KEY,
          account_scope_id TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
          session_expires_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backtest_quota_reservations (
          reservation_id TEXT PRIMARY KEY,
          account_scope_id TEXT NOT NULL,
          session_scope_id TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
          window_start_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          FOREIGN KEY (session_scope_id) REFERENCES backtest_quota_session_bindings(session_scope_id)
        );
        CREATE INDEX IF NOT EXISTS backtest_quota_account_window
          ON backtest_quota_reservations(account_scope_id, window_start_ms);
        CREATE INDEX IF NOT EXISTS backtest_quota_session_window
          ON backtest_quota_reservations(session_scope_id, window_start_ms);
      `);
      this.database.prepare(`
        INSERT OR IGNORE INTO backtest_quota_metadata(
          singleton, schema_version, policy_version, account_maximum,
          session_maximum, window_ms, max_active_reservations
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `).run(
        SCHEMA_VERSION,
        config.policyVersion,
        config.accountMaximum,
        config.sessionMaximum,
        WINDOW_MS,
        MAX_ACTIVE_RESERVATIONS,
      );
      const metadata = this.database.prepare(`
        SELECT schema_version, policy_version, account_maximum, session_maximum,
          window_ms, max_active_reservations
        FROM backtest_quota_metadata WHERE singleton = 1
      `).get() as Record<string, unknown> | undefined;
      if (metadata?.schema_version !== SCHEMA_VERSION ||
        metadata.policy_version !== config.policyVersion ||
        metadata.account_maximum !== config.accountMaximum ||
        metadata.session_maximum !== config.sessionMaximum ||
        metadata.window_ms !== WINDOW_MS ||
        metadata.max_active_reservations !== MAX_ACTIVE_RESERVATIONS) {
        throw new Error("quota schema or policy mismatch");
      }
    } catch (error) {
      try { this.database?.close(); } catch { /* best effort */ }
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "durable backtest quota storage is unavailable", { cause: error });
    }
  }

  close(): void {
    this.database.close();
  }

  reserve(scope: BacktestAccessScope, now: number): void {
    if (!/^[a-f0-9]{64}$/.test(scope.accountScopeId) || !/^[a-f0-9]{64}$/.test(scope.sessionScopeId) ||
      (scope.network !== "testnet" && scope.network !== "devnet") ||
      !Number.isSafeInteger(scope.sessionExpiresAt) || scope.sessionExpiresAt <= now ||
      !Number.isSafeInteger(now) || now < 0) {
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "backtest quota scope is invalid or expired");
    }
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const expiresAt = windowStart + WINDOW_MS;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database.prepare("DELETE FROM backtest_quota_reservations WHERE expires_at_ms <= ?").run(now);
      this.database.prepare(`
        DELETE FROM backtest_quota_session_bindings
        WHERE session_expires_at_ms <= ? AND session_scope_id NOT IN (
          SELECT session_scope_id FROM backtest_quota_reservations
        )
      `).run(now);

      const binding = this.database.prepare(`
        SELECT account_scope_id, network FROM backtest_quota_session_bindings
        WHERE session_scope_id = ?
      `).get(scope.sessionScopeId) as { account_scope_id?: unknown; network?: unknown } | undefined;
      if (binding && (binding.account_scope_id !== scope.accountScopeId || binding.network !== scope.network)) {
        throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "backtest session scope changed accounts or networks");
      }

      const accountCount = this.count("account_scope_id", scope.accountScopeId, windowStart);
      const sessionCount = this.count("session_scope_id", scope.sessionScopeId, windowStart);
      if (accountCount >= this.config.accountMaximum || sessionCount >= this.config.sessionMaximum) {
        throw new BacktestQuotaError("QUOTA_EXHAUSTED", "the authenticated research read quota is exhausted for this hour");
      }
      const active = this.database.prepare("SELECT COUNT(*) AS count FROM backtest_quota_reservations")
        .get() as { count?: unknown } | undefined;
      if (typeof active?.count !== "number" || active.count >= MAX_ACTIVE_RESERVATIONS) {
        throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "durable backtest quota state is saturated");
      }

      this.database.prepare(`
        INSERT OR IGNORE INTO backtest_quota_session_bindings(
          session_scope_id, account_scope_id, network, session_expires_at_ms
        ) VALUES (?, ?, ?, ?)
      `).run(scope.sessionScopeId, scope.accountScopeId, scope.network, scope.sessionExpiresAt);
      this.database.prepare(`
        UPDATE backtest_quota_session_bindings
        SET session_expires_at_ms = MAX(session_expires_at_ms, ?)
        WHERE session_scope_id = ?
      `).run(scope.sessionExpiresAt, scope.sessionScopeId);
      this.database.prepare(`
        INSERT INTO backtest_quota_reservations(
          reservation_id, account_scope_id, session_scope_id, network,
          window_start_ms, expires_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), scope.accountScopeId, scope.sessionScopeId, scope.network, windowStart, expiresAt, now);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      if (error instanceof BacktestQuotaError) throw error;
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "durable backtest quota storage is unavailable", { cause: error });
    }
  }

  private count(column: "account_scope_id" | "session_scope_id", value: string, windowStart: number): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM backtest_quota_reservations
      WHERE ${column} = ? AND window_start_ms = ?
    `).get(value, windowStart) as { count?: unknown } | undefined;
    if (typeof row?.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error("invalid quota count");
    }
    return row.count;
  }
}

export function createConfiguredBacktestQuota(
  environment: Environment = process.env,
  dependencies: BacktestQuotaFactoryDependencies = {},
): BacktestExternalReadQuota {
  try {
    const config = readBacktestQuotaConfig(environment);
    if (!config) return new UnavailableBacktestQuota();
    return config.backend === "sqlite-single-host"
      ? new SqliteBacktestExternalReadQuota(config)
      : dependencies.createHarborD1Quota?.(config, environment) ?? new UnavailableBacktestQuota();
  } catch {
    return new UnavailableBacktestQuota();
  }
}
