import { describe, expect, it } from "vitest";

import {
  Ap4mPurchaseIntentSchema,
  CancelIntentSchema,
  FundBudgetIntentSchema,
  IntentSchema,
  LimitIntentSchema,
  LpDepositIntentSchema,
  LpWithdrawIntentSchema,
  PayIntentSchema,
  SwapIntentSchema,
  VaultDepositIntentSchema,
  X402CallIntentSchema,
} from "../src/index.js";

const XRP = { currency: "XRP" } as const;
const RLUSD = {
  currency: "RLUSD",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;
const BASE = { id: "intent-1", network: "testnet" } as const;

const validIntents = {
  swap: {
    ...BASE,
    kind: "swap",
    sell: RLUSD,
    buy: XRP,
    amount: "50",
    side: "sell",
    max_slippage_bps: 100,
  },
  limit: {
    ...BASE,
    kind: "limit",
    sell: XRP,
    buy: RLUSD,
    sell_amount: "2",
    buy_amount: "1",
    expires_at: "2030-01-02T03:04:05.000Z",
  },
  cancel: { ...BASE, kind: "cancel", offer_sequence: 41 },
  lp_deposit: {
    ...BASE,
    kind: "lp_deposit",
    asset: XRP,
    asset2: RLUSD,
    amount: "2",
    amount2: "1",
  },
  lp_withdraw: {
    ...BASE,
    kind: "lp_withdraw",
    asset: XRP,
    asset2: RLUSD,
    amount: "1",
  },
  vault_deposit: {
    ...BASE,
    kind: "vault_deposit",
    vault_id: "B100000000000000000000000000000000000000000000000000000000000001",
    amount: "10",
    asset: XRP,
  },
  pay: {
    ...BASE,
    kind: "pay",
    to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    asset: RLUSD,
    amount: "25",
    memo: "invoice-42",
  },
  fund_budget: {
    ...BASE,
    kind: "fund_budget",
    asset: RLUSD,
    amount: "1000",
  },
  x402_call: {
    ...BASE,
    kind: "x402_call",
    url: "https://merchant.example/x402/compare",
    max_price_drops: "10000",
  },
  ap4m_purchase: {
    ...BASE,
    kind: "ap4m_purchase",
    merchant_id: "venue-yield-desk",
    sku: "yield-report",
    mandate_id: "mandate-demo-001",
  },
} as const;

const cases = [
  ["swap", SwapIntentSchema, validIntents.swap],
  ["limit", LimitIntentSchema, validIntents.limit],
  ["cancel", CancelIntentSchema, validIntents.cancel],
  ["lp_deposit", LpDepositIntentSchema, validIntents.lp_deposit],
  ["lp_withdraw", LpWithdrawIntentSchema, validIntents.lp_withdraw],
  ["vault_deposit", VaultDepositIntentSchema, validIntents.vault_deposit],
  ["pay", PayIntentSchema, validIntents.pay],
  ["fund_budget", FundBudgetIntentSchema, validIntents.fund_budget],
  ["x402_call", X402CallIntentSchema, validIntents.x402_call],
  ["ap4m_purchase", Ap4mPurchaseIntentSchema, validIntents.ap4m_purchase],
] as const;

const without = (value: object, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

describe("intent schemas", () => {
  it.each(cases)("accepts a valid %s intent", (_kind, schema, intent) => {
    expect(schema.parse(intent)).toEqual(intent);
    expect(IntentSchema.parse(intent)).toEqual(intent);
  });

  it.each(cases)("rejects invalid common fields for %s", (_kind, schema, intent) => {
    expect(schema.safeParse({ ...intent, id: "" }).success).toBe(false);
    expect(schema.safeParse({ ...intent, network: "sidechain" }).success).toBe(false);
    expect(schema.safeParse({ ...intent, unexpected: true }).success).toBe(false);
    expect(schema.safeParse(without(intent, "id")).success).toBe(false);
    expect(schema.safeParse(without(intent, "network")).success).toBe(false);
  });

  it("accepts every network in the fixed Intent contract", () => {
    for (const network of ["mainnet", "testnet", "devnet", "lending-devnet"]) {
      expect(IntentSchema.safeParse({ ...validIntents.cancel, network }).success).toBe(true);
    }
  });

  it("restricts AP4M purchase intents to Testnet", () => {
    expect(Ap4mPurchaseIntentSchema.safeParse(validIntents.ap4m_purchase).success).toBe(
      true,
    );
    expect(
      Ap4mPurchaseIntentSchema.safeParse({
        ...validIntents.ap4m_purchase,
        network: "mainnet",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown intent kind", () => {
    expect(IntentSchema.safeParse({ ...BASE, kind: "market_order" }).success).toBe(false);
  });

  it("rejects invalid assets, including nested unknown fields", () => {
    for (const asset of [
      { currency: "" },
      { currency: 123 },
      { currency: "RLUSD", issuer: "" },
      { currency: "XRP", extra: true },
    ]) {
      expect(
        SwapIntentSchema.safeParse({ ...validIntents.swap, sell: asset }).success,
      ).toBe(false);
    }
  });
});

describe("swap intent schema", () => {
  it.each(["sell", "buy", "amount", "side", "max_slippage_bps"])(
    "requires %s",
    (field) => {
      expect(SwapIntentSchema.safeParse(without(validIntents.swap, field)).success).toBe(
        false,
      );
    },
  );

  it.each([
    ["zero amount", { amount: "0" }],
    ["negative amount", { amount: "-1" }],
    ["non-decimal amount", { amount: "fifty" }],
    ["empty amount", { amount: "" }],
    ["invalid side", { side: "hold" }],
    ["negative slippage", { max_slippage_bps: -1 }],
    ["fractional slippage", { max_slippage_bps: 1.5 }],
    ["excessive slippage", { max_slippage_bps: 10_001 }],
  ])("rejects %s", (_label, patch) => {
    expect(SwapIntentSchema.safeParse({ ...validIntents.swap, ...patch }).success).toBe(
      false,
    );
  });
});

describe("limit intent schema", () => {
  it.each(["sell", "buy", "sell_amount", "buy_amount"])("requires %s", (field) => {
    expect(LimitIntentSchema.safeParse(without(validIntents.limit, field)).success).toBe(
      false,
    );
  });

  it("accepts an omitted expiration", () => {
    expect(
      LimitIntentSchema.safeParse(without(validIntents.limit, "expires_at")).success,
    ).toBe(true);
  });

  it.each([
    ["zero sell amount", { sell_amount: "0" }],
    ["negative buy amount", { buy_amount: "-1" }],
    ["non-decimal sell amount", { sell_amount: "all" }],
    ["empty buy amount", { buy_amount: "" }],
    ["malformed expiration", { expires_at: "next Tuesday" }],
  ])("rejects %s", (_label, patch) => {
    expect(LimitIntentSchema.safeParse({ ...validIntents.limit, ...patch }).success).toBe(
      false,
    );
  });
});

describe("cancel intent schema", () => {
  it("requires a positive integer offer sequence", () => {
    expect(
      CancelIntentSchema.safeParse(without(validIntents.cancel, "offer_sequence")).success,
    ).toBe(false);
    for (const offer_sequence of [0, -1, 1.5, "41"]) {
      expect(
        CancelIntentSchema.safeParse({ ...validIntents.cancel, offer_sequence }).success,
      ).toBe(false);
    }
  });
});

describe.each([
  ["lp_deposit", LpDepositIntentSchema, validIntents.lp_deposit],
  ["lp_withdraw", LpWithdrawIntentSchema, validIntents.lp_withdraw],
] as const)("%s intent schema", (_kind, schema, intent) => {
  it.each(["asset", "asset2", "amount"])("requires %s", (field) => {
    expect(schema.safeParse(without(intent, field)).success).toBe(false);
  });

  it("accepts an omitted second amount", () => {
    expect(schema.safeParse(without(intent, "amount2")).success).toBe(true);
  });

  it.each([
    ["zero amount", { amount: "0" }],
    ["negative amount", { amount: "-1" }],
    ["non-decimal amount", { amount: "all" }],
    ["empty second amount", { amount2: "" }],
  ])("rejects %s", (_label, patch) => {
    expect(schema.safeParse({ ...intent, ...patch }).success).toBe(false);
  });
});

describe("vault deposit intent schema", () => {
  it.each(["vault_id", "asset", "amount"])("requires %s", (field) => {
    expect(
      VaultDepositIntentSchema.safeParse(without(validIntents.vault_deposit, field)).success,
    ).toBe(false);
  });

  it.each([
    ["empty vault id", { vault_id: "" }],
    ["zero amount", { amount: "0" }],
    ["negative amount", { amount: "-1" }],
    ["non-decimal amount", { amount: "all" }],
  ])("rejects %s", (_label, patch) => {
    expect(
      VaultDepositIntentSchema.safeParse({ ...validIntents.vault_deposit, ...patch })
        .success,
    ).toBe(false);
  });
});

describe("pay intent schema", () => {
  it.each(["to", "asset", "amount"])("requires %s", (field) => {
    expect(PayIntentSchema.safeParse(without(validIntents.pay, field)).success).toBe(false);
  });

  it("accepts an omitted memo", () => {
    expect(PayIntentSchema.safeParse(without(validIntents.pay, "memo")).success).toBe(true);
  });

  it.each([
    ["empty destination", { to: "" }],
    ["zero amount", { amount: "0" }],
    ["negative amount", { amount: "-1" }],
    ["non-decimal amount", { amount: "all" }],
    ["overlong memo", { memo: "x".repeat(257) }],
  ])("rejects %s", (_label, patch) => {
    expect(PayIntentSchema.safeParse({ ...validIntents.pay, ...patch }).success).toBe(false);
  });
});

describe("fund budget intent schema", () => {
  it.each(["asset", "amount"])("requires %s", (field) => {
    expect(
      FundBudgetIntentSchema.safeParse(without(validIntents.fund_budget, field)).success,
    ).toBe(false);
  });

  it.each(["", "0", "-1", "all"])("rejects amount %j", (amount) => {
    expect(
      FundBudgetIntentSchema.safeParse({ ...validIntents.fund_budget, amount }).success,
    ).toBe(false);
  });
});

describe("x402 call intent schema", () => {
  it.each(["url", "max_price_drops"])("requires %s", (field) => {
    expect(
      X402CallIntentSchema.safeParse(without(validIntents.x402_call, field)).success,
    ).toBe(false);
  });

  it.each([
    ["empty URL", { url: "" }],
    ["malformed URL", { url: "not-a-url" }],
    ["empty max price", { max_price_drops: "" }],
    ["zero max price", { max_price_drops: "0" }],
    ["negative max price", { max_price_drops: "-1" }],
    ["fractional max price", { max_price_drops: "1.5" }],
  ])("rejects %s", (_label, patch) => {
    expect(
      X402CallIntentSchema.safeParse({ ...validIntents.x402_call, ...patch }).success,
    ).toBe(false);
  });
});
