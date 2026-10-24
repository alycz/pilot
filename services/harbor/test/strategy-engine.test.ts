import { describe, expect, it } from "vitest";

import { StrategyMandateSchema } from "../src/contracts";
import { decideRebalance, decimalToMicrounitsCeil, type StrategyObservation } from "../src/strategy/engine";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";
const now = new Date("2026-10-22T12:00:00.000Z");
const digest = "AB".repeat(32);
const mandate = StrategyMandateSchema.parse({
  mandate_id: "mandate:1", strategy_id: "strategy:1", version: 1, digest,
  status: "approved", kind: "xrp_issued_rebalancer_v1", network: "testnet", account,
  issued_asset: { currency, issuer },
  allocation: { target_xrp_bps: 5_000, lower_xrp_bps: 4_500, upper_xrp_bps: 5_500 },
  limits: { max_order_value: "25", max_daily_value: "100", min_order_value: "1",
    max_fee_drops: "20", max_slippage_bps: 100, max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000",
    max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000",
    min_liquidity_value: "50", cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1 },
  schedule: { interval_seconds: 300, next_evaluation_at: now.toISOString() },
  execution_mode: "offer_create_fok", not_before: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-23T00:00:00.000Z",
  authorization: { authorization_id: "authorization:1", method: "wallet_action_proof_v1", owner: account,
    mandate_digest: digest, mandate_version: 1, approved_at: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-23T00:00:00.000Z" },
});

function observation(overrides: Partial<StrategyObservation> = {}): StrategyObservation {
  return { account, network: "testnet", issuedCurrency: currency, issuedIssuer: issuer,
    xrpBalanceDrops: "50000000", issuedBalance: "50", bid: "1", ask: "1.005",
    executableLiquidityValue: "500", feeDrops: "12", reserveBaseDrops: "10000000",
    reserveIncrementDrops: "2000000", ownerCount: 1, pendingDailyValue: "0", ledgerIndex: 100,
    quoteLedgerIndex: 100, observedAt: now.toISOString(), grantActive: true, policyActive: true, ...overrides };
}

function decide(overrides: Partial<StrategyObservation> = {}) {
  return decideRebalance({ mandate, observation: observation(overrides), triggerId: "trigger:1",
    decisionId: "decision:1", now });
}

describe("deterministic strategy engine", () => {
  it("holds inclusively inside the hysteresis band and trades on both sides", () => {
    expect(decide().hold_codes).toEqual(["inside_band"]);
    expect(decide({ xrpBalanceDrops: "30000000", issuedBalance: "70" }).action).toBe("buy_xrp");
    expect(decide({ xrpBalanceDrops: "70000000", issuedBalance: "30" }).action).toBe("sell_xrp");
    expect(decide({ xrpBalanceDrops: "45000000", issuedBalance: "55.1375" }).action).toBe("hold");
  });

  it("fails closed for stale/contradictory scope, limits, reserve, cooldown, policy and unresolved state", () => {
    expect(decide({ observedAt: "2026-10-22T11:59:00.000Z" }).hold_codes).toContain("stale_price");
    expect(decide({ issuedIssuer: account }).hold_codes).toContain("contradictory_price");
    expect(decide({ feeDrops: "21" }).hold_codes).toContain("fee_limit");
    expect(decide({ xrpBalanceDrops: "70000000", issuedBalance: "30", reserveBaseDrops: "100000000" }).hold_codes).toContain("reserve_limit");
    expect(decide({ lastTradeAt: "2026-10-22T11:59:00.000Z" }).hold_codes).toContain("cooldown");
    expect(decide({ policyActive: false }).hold_codes).toContain("policy_paused");
    expect(decide({ unresolvedExecution: true }).hold_codes).toContain("pending_reconciliation");
    expect(decide({ globalKill: true }).hold_codes).toContain("global_kill");
  });

  it("accounts for prior reservations and uses conservative integer micro-units", () => {
    expect(decide({ xrpBalanceDrops: "30000000", issuedBalance: "70", pendingDailyValue: "100" }).hold_codes)
      .toContain("daily_limit");
    expect(decimalToMicrounitsCeil("1.000000000000001")).toBe(1_000_001);
  });

  it("uses the greater reserve floor and correctly scales XRP exposure drops", () => {
    expect(decide({ xrpBalanceDrops: "15000000", issuedBalance: "0",
      reserveBaseDrops: "5000000", reserveIncrementDrops: "1000000" }).action).toBe("sell_xrp");
    const exposureMandate = StrategyMandateSchema.parse({ ...mandate,
      limits: { ...mandate.limits, max_xrp_exposure_drops: "40000000" } });
    const result = decideRebalance({ mandate: exposureMandate,
      observation: observation({ xrpBalanceDrops: "30000000", issuedBalance: "70" }),
      triggerId: "trigger:exposure", decisionId: "decision:exposure", now });
    expect(result.action).toBe("buy_xrp");
    expect(Number(result.proposed_value)).toBeLessThan(11);
  });
});
