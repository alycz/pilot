import { describe, expect, it, vi } from "vitest";

import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import type { Strategy } from "../src/contracts";
import { createProductionStrategyAdapter } from "../src/strategy/execution-adapter";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";
const at = new Date("2026-10-22T12:00:10.000Z");
const strategy: Strategy = {
  strategy_id: "strategy:1", lifecycle: "active", generation: 1,
  next_evaluation_at: at.toISOString(), created_at: at.toISOString(), updated_at: at.toISOString(),
  mandate: { mandate_id: "mandate:1", strategy_id: "strategy:1", version: 1, digest: "AB".repeat(32),
    status: "approved", kind: "xrp_issued_rebalancer_v1", network: "testnet", account,
    issued_asset: { currency, issuer }, allocation: { target_xrp_bps: 5000, lower_xrp_bps: 4500, upper_xrp_bps: 5500 },
    limits: { max_order_value: "25", max_daily_value: "100", min_order_value: "1", max_fee_drops: "20",
      max_slippage_bps: 100, max_price_impact_bps: 100, min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000",
      max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000", min_liquidity_value: "50",
      cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1 },
    schedule: { interval_seconds: 300, next_evaluation_at: at.toISOString() }, execution_mode: "offer_create_fok",
    not_before: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-23T00:00:00.000Z",
    authorization: { authorization_id: "auth:1", method: "wallet_action_proof_v1", owner: account,
      mandate_digest: "AB".repeat(32), mandate_version: 1, approved_at: "2026-10-22T00:00:00.000Z", expires_at: "2026-10-23T00:00:00.000Z" } },
};

type Overrides = {
  accountValidated?: boolean;
  ownerCount?: number;
  linesValidated?: boolean;
  linesLedger?: number;
  bookValidated?: boolean;
  frozen?: boolean;
  deepFrozen?: boolean;
  peerAuthorized?: boolean;
  linkFrozen?: boolean;
};

function harness(overrides: Overrides = {}) {
  const rpc: XrplRpc = { request: vi.fn(async (_network, command, params = {}) => {
    if (command === "account_info") return { validated: overrides.accountValidated ?? true, ledger_index: 100,
      account_data: { Account: account, Balance: "50000000", OwnerCount: overrides.ownerCount ?? 1 } };
    if (command === "account_lines") return { validated: overrides.linesValidated ?? true,
      ledger_index: overrides.linesLedger ?? 100, lines: [{ account: issuer, currency, balance: "50",
        freeze: overrides.frozen ?? false, deep_freeze_peer: overrides.deepFrozen ?? false,
        peer_authorized: overrides.peerAuthorized ?? true }] };
    if (command === "book_offers") {
      const gets = params.taker_gets as { currency?: string };
      return { validated: overrides.bookValidated ?? true, ledger_index: 100, offers: [gets.currency === "XRP"
        ? { TakerGets: "1000000", TakerPays: { currency, issuer, value: "1" } }
        : { TakerGets: { currency, issuer, value: "1" }, TakerPays: "1000000" }] };
    }
    if (command === "fee") return { drops: { open_ledger_fee: "12" } };
    if (command === "server_info") return { info: { validated_ledger: { reserve_base_xrp: "10", reserve_inc_xrp: "2" } } };
    throw new Error(`unexpected ${command}`);
  }) };
  const db = { prepare: vi.fn((sql: string) => ({ bind: vi.fn(() => ({ first: vi.fn(async () =>
    sql.includes("FROM links")
      ? { status: "active", permissions: JSON.stringify(["OfferCreate"]), frozen_at: overrides.linkFrozen ? at.toISOString() : null }
      : { json: JSON.stringify({ networks: ["testnet"] }) }) })) })) } as unknown as D1Database;
  return createProductionStrategyAdapter({ principal: "tenant", db, env: { EXEC_NETWORK: "testnet" },
    xrplRpc: rpc });
}

describe("production strategy observation provenance", () => {
  it("accepts one exact fully validated ledger snapshot and timestamps after reads", async () => {
    const result = await harness().observe(strategy, at);
    expect(result).toMatchObject({ ledgerIndex: 100, quoteLedgerIndex: 100, observedAt: at.toISOString(),
      grantActive: true, issuedCurrency: currency, issuedIssuer: issuer });
  });

  it.each([
    ["unvalidated account", { accountValidated: false }],
    ["negative owner count", { ownerCount: -1 }],
    ["unvalidated lines", { linesValidated: false }],
    ["cross-ledger lines", { linesLedger: 99 }],
    ["unvalidated book", { bookValidated: false }],
    ["frozen trustline", { frozen: true }],
    ["deep-frozen trustline", { deepFrozen: true }],
    ["unauthorized trustline", { peerAuthorized: false }],
  ] as const)("rejects %s", async (_name, overrides) => {
    await expect(harness(overrides).observe(strategy, at)).rejects.toThrow();
  });

  it("marks a frozen Harbor link inactive even with OfferCreate permission", async () => {
    expect((await harness({ linkFrozen: true }).observe(strategy, at)).grantActive).toBe(false);
  });
});
