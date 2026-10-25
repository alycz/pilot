import { randomUUID } from "node:crypto";

import {
  createHarborHostedStateClientFromEnv,
  HarborHostedStateClientError,
  isHarborHostedStateConfigured,
  type ResearchQuotaReserveRequest,
  type ResearchQuotaReserveResponse,
} from "../../../../../lib/harbor-hosted-state-client";

import type { HarborD1BacktestQuotaConfig } from "./durable-quota";
import {
  BacktestQuotaError,
  type BacktestAccessScope,
  type BacktestExternalReadQuota,
} from "./quota-contract";

type Environment = Readonly<Record<string, string | undefined>>;

export type ResearchQuotaClient = Readonly<{
  reserveResearchQuota(input: ResearchQuotaReserveRequest): Promise<ResearchQuotaReserveResponse>;
}>;

function invalidScope(scope: BacktestAccessScope, now: number): boolean {
  return !/^[a-f0-9]{64}$/.test(scope.accountScopeId) ||
    !/^[a-f0-9]{64}$/.test(scope.sessionScopeId) ||
    (scope.network !== "testnet" && scope.network !== "devnet") ||
    !Number.isSafeInteger(scope.sessionExpiresAt) || scope.sessionExpiresAt <= now ||
    !Number.isSafeInteger(now) || now < 0;
}

/**
 * Shared hosted quota adapter. The client owns the single byte-identical retry
 * on an uncertain transport result; one UUID is generated for each logical
 * reservation and is never reused for another request.
 */
export class HarborBacktestExternalReadQuota implements BacktestExternalReadQuota {
  constructor(
    private readonly config: HarborD1BacktestQuotaConfig,
    private readonly client: ResearchQuotaClient,
    private readonly createRequestId: () => string = randomUUID,
  ) {}

  async reserve(scope: BacktestAccessScope, now: number): Promise<void> {
    if (invalidScope(scope, now)) {
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "backtest quota scope is invalid or expired");
    }
    const requestId = this.createRequestId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "backtest quota request identity is unavailable");
    }
    try {
      const response = await this.client.reserveResearchQuota({
        version: 1,
        requestId,
        accountScopeId: scope.accountScopeId,
        sessionScopeId: scope.sessionScopeId,
        network: scope.network,
        sessionExpiresAtMs: scope.sessionExpiresAt,
        policyVersion: this.config.policyVersion,
        accountMaximum: this.config.accountMaximum,
        sessionMaximum: this.config.sessionMaximum,
      });
      if (response.reserved !== true || response.policyVersion !== this.config.policyVersion ||
        response.windowExpiresAtMs <= now ||
        response.remainingAccountRuns >= this.config.accountMaximum ||
        response.remainingSessionRuns >= this.config.sessionMaximum) {
        throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "shared backtest quota returned a policy mismatch");
      }
    } catch (error) {
      if (error instanceof BacktestQuotaError) throw error;
      if (error instanceof HarborHostedStateClientError && error.status === 429) {
        throw new BacktestQuotaError(
          "QUOTA_EXHAUSTED",
          "the authenticated research read quota is exhausted for this hour",
          { cause: error },
        );
      }
      throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "shared backtest quota is unavailable", { cause: error });
    }
  }
}

export function createHarborBacktestExternalReadQuota(
  config: HarborD1BacktestQuotaConfig,
  environment: Environment = process.env,
): BacktestExternalReadQuota {
  if (!isHarborHostedStateConfigured(environment)) {
    throw new BacktestQuotaError("QUOTA_UNAVAILABLE", "shared backtest quota client is not configured");
  }
  return new HarborBacktestExternalReadQuota(
    config,
    createHarborHostedStateClientFromEnv(environment),
  );
}
