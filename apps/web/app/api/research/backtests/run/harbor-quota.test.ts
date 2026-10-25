import { describe, expect, it, vi } from "vitest";

import {
  HarborHostedStateClientError,
  type ResearchQuotaReserveRequest,
  type ResearchQuotaReserveResponse,
} from "../../../../../lib/harbor-hosted-state-client";

import { BacktestQuotaError, type BacktestAccessScope } from "./quota-contract";
import { BACKTEST_QUOTA_POLICY_VERSION, type HarborD1BacktestQuotaConfig } from "./durable-quota";
import { HarborBacktestExternalReadQuota } from "./harbor-quota";

const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const CONFIG: HarborD1BacktestQuotaConfig = {
  backend: "harbor-d1",
  policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
  accountMaximum: 12,
  sessionMaximum: 4,
};
const SCOPE: BacktestAccessScope = {
  accountScopeId: "a".repeat(64),
  sessionScopeId: "b".repeat(64),
  network: "testnet",
  sessionExpiresAt: 100_000,
};

function response(overrides: Partial<ResearchQuotaReserveResponse> = {}): ResearchQuotaReserveResponse {
  return {
    reserved: true,
    idempotent: false,
    policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
    windowExpiresAtMs: 3_600_000,
    remainingAccountRuns: 11,
    remainingSessionRuns: 3,
    ...overrides,
  };
}

describe("Harbor D1 backtest quota adapter", () => {
  it("sends one exact policy-bound reservation with a stable UUID", async () => {
    const reserveResearchQuota = vi.fn(async (_input: ResearchQuotaReserveRequest) => response());
    const quota = new HarborBacktestExternalReadQuota(CONFIG, { reserveResearchQuota }, () => REQUEST_ID);
    await expect(quota.reserve(SCOPE, 1_000)).resolves.toBeUndefined();
    expect(reserveResearchQuota).toHaveBeenCalledOnce();
    expect(reserveResearchQuota).toHaveBeenCalledWith({
      version: 1,
      requestId: REQUEST_ID,
      accountScopeId: SCOPE.accountScopeId,
      sessionScopeId: SCOPE.sessionScopeId,
      network: "testnet",
      sessionExpiresAtMs: 100_000,
      policyVersion: BACKTEST_QUOTA_POLICY_VERSION,
      accountMaximum: 12,
      sessionMaximum: 4,
    });
  });

  it("accepts an idempotent response for the same logical reservation", async () => {
    const quota = new HarborBacktestExternalReadQuota(CONFIG, {
      reserveResearchQuota: async () => response({ idempotent: true }),
    }, () => REQUEST_ID);
    await expect(quota.reserve(SCOPE, 1_000)).resolves.toBeUndefined();
  });

  it("maps only the authoritative quota-exhausted response to a retryable quota rejection", async () => {
    const quota = new HarborBacktestExternalReadQuota(CONFIG, {
      reserveResearchQuota: async () => {
        throw new HarborHostedStateClientError("QUOTA_EXHAUSTED", 429, 900);
      },
    }, () => REQUEST_ID);
    await expect(quota.reserve(SCOPE, 1_000)).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
  });

  it("fails closed on a malformed request identity, expired scope, policy drift, or transport failure", async () => {
    const client = { reserveResearchQuota: vi.fn(async () => response()) };
    await expect(new HarborBacktestExternalReadQuota(CONFIG, client, () => "not-a-uuid")
      .reserve(SCOPE, 1_000)).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });
    await expect(new HarborBacktestExternalReadQuota(CONFIG, client, () => REQUEST_ID)
      .reserve({ ...SCOPE, sessionExpiresAt: 1_000 }, 1_000)).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });

    const drifted = new HarborBacktestExternalReadQuota(CONFIG, {
      reserveResearchQuota: async () => response({ policyVersion: "other-policy" }),
    }, () => REQUEST_ID);
    await expect(drifted.reserve(SCOPE, 1_000)).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });

    const impossibleRemaining = new HarborBacktestExternalReadQuota(CONFIG, {
      reserveResearchQuota: async () => response({ remainingSessionRuns: 4 }),
    }, () => REQUEST_ID);
    await expect(impossibleRemaining.reserve(SCOPE, 1_000)).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });

    const unavailable = new HarborBacktestExternalReadQuota(CONFIG, {
      reserveResearchQuota: async () => { throw new Error("timeout"); },
    }, () => REQUEST_ID);
    await expect(unavailable.reserve(SCOPE, 1_000)).rejects.toBeInstanceOf(BacktestQuotaError);
    await expect(unavailable.reserve(SCOPE, 1_000)).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE" });
  });
});
