import { describe, expect, it, vi } from "vitest";

import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import { StrategySchema, type Strategy } from "../src/contracts";
import { createProductionStrategyAdapter } from "../src/strategy/execution-adapter";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";
const at = new Date("2026-10-22T12:00:10.000Z");

const strategy: Strategy = StrategySchema.parse({
  strategy_id: "strategy:declarative-adapter",
  lifecycle: "active",
  generation: 1,
  next_evaluation_at: at.toISOString(),
  created_at: at.toISOString(),
  updated_at: at.toISOString(),
  mandate: {
    mandate_id: "mandate:declarative-adapter",
    strategy_id: "strategy:declarative-adapter",
    version: 1,
    digest: "AB".repeat(32),
    status: "approved",
    semantics_version: "harbor.declarative-strategy/1",
    kind: "declarative_strategy_v1",
    network: "testnet",
    account,
    issued_asset: { currency, issuer },
    plan: {
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 300 },
      rules: [{
        rule_id: "fixed-buy",
        all: [{ kind: "always" }],
        action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
      }],
      fallback: { kind: "hold" },
    },
    limits: {
      max_order_value: "10",
      max_daily_value: "20",
      max_cumulative_value: "100",
      min_order_value: "1",
      max_fee_drops: "20",
      max_daily_fee_drops: "100",
      max_cumulative_fee_drops: "1000",
      max_daily_trades: 5,
      max_total_trades: 20,
      cumulative_scope: "owner_network_asset_lifetime",
      max_slippage_bps: 100,
      max_price_impact_bps: 100,
      min_xrp_reserve_drops: "12000000",
      fee_buffer_drops: "1000",
      max_xrp_exposure_drops: "1000000000",
      max_issued_exposure: "1000",
      min_liquidity_value: "5",
      cooldown_seconds: 300,
      max_quote_age_seconds: 20,
      max_ledger_gap: 1,
    },
    schedule: { interval_seconds: 300, next_evaluation_at: at.toISOString() },
    execution_mode: "offer_create_fok",
    not_before: "2026-10-22T00:00:00.000Z",
    expires_at: "2026-10-23T00:00:00.000Z",
    authorization: {
      authorization_id: "auth:declarative-adapter",
      method: "wallet_action_proof_v1",
      owner: account,
      mandate_digest: "AB".repeat(32),
      mandate_version: 1,
      approved_at: "2026-10-22T00:00:00.000Z",
      expires_at: "2026-10-23T00:00:00.000Z",
    },
  },
});

describe("declarative strategy production adapter", () => {
  it("observes only the exact mandate account and allowlisted asset", async () => {
    const rpc: XrplRpc = {
      request: vi.fn(async (_network, command, params = {}) => {
        if (command === "account_info") {
          expect(params).toMatchObject({ account, ledger_index: "validated" });
          return {
            validated: true,
            ledger_index: 100,
            account_data: { Account: account, Balance: "50000000", OwnerCount: 1 },
          };
        }
        if (command === "account_lines") {
          expect(params).toMatchObject({ account, peer: issuer, ledger_index: 100 });
          return {
            validated: true,
            ledger_index: 100,
            lines: [{ account: issuer, currency, balance: "50", peer_authorized: true }],
          };
        }
        if (command === "book_offers") {
          const gets = params.taker_gets as { currency?: string };
          const pays = params.taker_pays as { currency?: string; issuer?: string };
          if (gets.currency === "XRP") {
            expect(pays).toEqual({ currency, issuer });
            return {
              validated: true,
              ledger_index: 100,
              offers: [{
                TakerGets: "1000000",
                TakerPays: { currency, issuer, value: "1" },
              }],
            };
          }
          expect(gets).toEqual({ currency, issuer });
          return {
            validated: true,
            ledger_index: 100,
            offers: [{
              TakerGets: { currency, issuer, value: "1" },
              TakerPays: "1000000",
            }],
          };
        }
        if (command === "fee") return { drops: { open_ledger_fee: "12" } };
        if (command === "server_info") {
          return {
            info: { validated_ledger: {
              reserve_base_xrp: "10", reserve_inc_xrp: "2", seq: 100, age: 1,
            } },
          };
        }
        throw new Error(`unexpected ${command}`);
      }),
    };
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => sql.includes("FROM links")
            ? {
                status: "active",
                permissions: JSON.stringify(["OfferCreate"]),
                frozen_at: null,
              }
            : { json: JSON.stringify({ networks: ["testnet"] }) }),
        })),
      })),
    } as unknown as D1Database;

    const result = await createProductionStrategyAdapter({
      principal: "tenant",
      db,
      env: { EXEC_NETWORK: "testnet" },
      xrplRpc: rpc,
    }).observe(strategy, at);

    expect(result).toMatchObject({
      account,
      network: "testnet",
      issuedCurrency: currency,
      issuedIssuer: issuer,
      ledgerIndex: 100,
      quoteLedgerIndex: 100,
      grantActive: true,
    });
  });
});
