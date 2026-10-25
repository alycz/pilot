import { createHmac } from "node:crypto";

import { readCookie } from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";
import {
  openWalletSession,
  WALLET_SESSION_COOKIE,
} from "../../../../../lib/wallet-session";

import {
  BacktestQuotaError,
  type BacktestAccessScope,
  type BacktestExternalReadQuota,
} from "./quota-contract";

export {
  BacktestQuotaError,
  type BacktestAccessScope,
  type BacktestExternalReadQuota,
} from "./quota-contract";

type Environment = Readonly<{
  SESSION_SECRET?: string;
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_PUBLIC_ORIGIN?: string;
}>;

export type BacktestAccessResolver = (request: Request) => BacktestAccessScope | null;

type Window = { startedAt: number; count: number };

/**
 * Small process-local guard in front of the public provider. A shared
 * deployment must replace it with durable quota state before external reads
 * are enabled across multiple instances.
 */
export class InMemoryBacktestExternalReadQuota implements BacktestExternalReadQuota {
  private readonly accounts = new Map<string, Window>();
  private readonly sessions = new Map<string, Window>();

  constructor(
    private readonly accountMaximum = 12,
    private readonly sessionMaximum = 4,
    private readonly windowMs = 60 * 60 * 1_000,
    private readonly maximumTrackedScopes = 4_096,
  ) {
    if (!Number.isSafeInteger(accountMaximum) || accountMaximum < 1 ||
      !Number.isSafeInteger(sessionMaximum) || sessionMaximum < 1 ||
      sessionMaximum > accountMaximum ||
      !Number.isSafeInteger(windowMs) || windowMs < 1 ||
      !Number.isSafeInteger(maximumTrackedScopes) || maximumTrackedScopes < 2) {
      throw new TypeError("backtest external-read quota configuration is invalid");
    }
  }

  reserve(scope: BacktestAccessScope, now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "backtest quota clock is invalid");
    }
    this.prune(now);
    const account = this.current(this.accounts, scope.accountScopeId, now);
    const session = this.current(this.sessions, scope.sessionScopeId, now);
    if (account?.count === this.accountMaximum || session?.count === this.sessionMaximum) {
      throw new BacktestQuotaError("QUOTA_EXHAUSTED", "the authenticated research read quota is exhausted for this hour");
    }
    const newScopes = Number(account === undefined) + Number(session === undefined);
    if (this.accounts.size + this.sessions.size + newScopes > this.maximumTrackedScopes) {
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "backtest quota state is saturated");
    }
    this.accounts.set(scope.accountScopeId, {
      startedAt: account?.startedAt ?? now,
      count: (account?.count ?? 0) + 1,
    });
    this.sessions.set(scope.sessionScopeId, {
      startedAt: session?.startedAt ?? now,
      count: (session?.count ?? 0) + 1,
    });
  }

  private current(store: Map<string, Window>, key: string, now: number): Window | undefined {
    const value = store.get(key);
    return value && now - value.startedAt < this.windowMs ? value : undefined;
  }

  private prune(now: number): void {
    for (const store of [this.accounts, this.sessions]) {
      for (const [key, value] of store) {
        if (now - value.startedAt >= this.windowMs) store.delete(key);
      }
    }
  }
}

function scopeDigest(secret: string, domain: "account" | "session", value: string): string {
  return createHmac("sha256", secret)
    .update(`pilot.backtest.${domain}.v2\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function resolveAuthenticatedBacktestScope(
  request: Request,
  environment: Environment = process.env,
): BacktestAccessScope | null {
  try {
    const authority = resolvePilotRequestAuthority(environment, request);
    if (request.headers.get("origin") !== authority.origin ||
      request.headers.get("sec-fetch-site") !== "same-origin") return null;
  } catch {
    return null;
  }
  const cookie = readCookie(request, WALLET_SESSION_COOKIE);
  const secret = environment.SESSION_SECRET;
  if (!cookie || !secret || secret.length < 32 || secret !== secret.trim()) return null;
  try {
    const session = openWalletSession(cookie, { secret, environment });
    if (!session) return null;
    return Object.freeze({
      accountScopeId: scopeDigest(secret, "account", `${session.network}\0${session.account}`),
      sessionScopeId: scopeDigest(secret, "session", cookie),
      network: session.network,
      sessionExpiresAt: session.expiresAt,
    });
  } catch {
    return null;
  }
}
