import type { Intent } from "@pilot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toBuild } from "../src/index.js";
import type { BuildRequest } from "../src/index.js";

const BUDGET_ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const MAIN_ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE_ACCOUNT = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w";
const DESTINATION = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ACCOUNTS = {
  main_account: MAIN_ACCOUNT,
  budget_account: BUDGET_ACCOUNT,
  delegate_account: DELEGATE_ACCOUNT,
} as const;
const XRP = { currency: "XRP" } as const;
const RLUSD = {
  currency: "RLUSD",
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
} as const;
const WIRE_RLUSD = {
  ...RLUSD,
  currency: "524C555344000000000000000000000000000000",
} as const;
const BASE = { id: "intent-1", network: "testnet" } as const;

const mappings = [
  {
    name: "swap",
    intent: {
      ...BASE,
      kind: "swap",
      sell: RLUSD,
      buy: XRP,
      amount: "50",
      side: "sell",
      max_slippage_bps: 100,
    },
    expected: {
      op: "tx.swap",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        sell: WIRE_RLUSD,
        buy: XRP,
        amount: { ...WIRE_RLUSD, value: "50" },
        side: "sell",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      },
    },
  },
  {
    name: "limit",
    intent: {
      ...BASE,
      kind: "limit",
      sell: XRP,
      buy: RLUSD,
      sell_amount: "2",
      buy_amount: "1",
      expires_at: "2030-01-02T03:04:05.000Z",
    },
    expected: {
      op: "tx.offer",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        sell: XRP,
        buy: WIRE_RLUSD,
        sell_amount: "2",
        buy_amount: "1",
        expires_at: "2030-01-02T03:04:05.000Z",
      },
    },
  },
  {
    name: "cancel",
    intent: { ...BASE, kind: "cancel", offer_sequence: 41 },
    expected: {
      op: "tx.offerCancel",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        offer_sequence: 41,
      },
    },
  },
  {
    name: "lp_deposit",
    intent: {
      ...BASE,
      kind: "lp_deposit",
      asset: XRP,
      asset2: RLUSD,
      amount: "2",
      amount2: "1",
    },
    expected: {
      op: "tx.ammDeposit",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        asset: XRP,
        asset2: WIRE_RLUSD,
        amount: "2000000",
        amount2: { ...WIRE_RLUSD, value: "1" },
        flags: 0x0010_0000,
      },
    },
  },
  {
    name: "lp_withdraw",
    intent: {
      ...BASE,
      kind: "lp_withdraw",
      asset: XRP,
      asset2: RLUSD,
      amount: "1",
    },
    expected: {
      op: "tx.ammWithdraw",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        asset: XRP,
        asset2: WIRE_RLUSD,
        amount: "1000000",
        flags: 0x0008_0000,
      },
    },
  },
  {
    name: "vault_deposit",
    intent: {
      ...BASE,
      kind: "vault_deposit",
      vault_id:
        "B100000000000000000000000000000000000000000000000000000000000001",
      asset: XRP,
      amount: "10",
    },
    expected: {
      op: "tx.vaultDeposit",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        vault_id:
          "B100000000000000000000000000000000000000000000000000000000000001",
        amount: "10000000",
      },
    },
  },
  {
    name: "pay",
    intent: {
      ...BASE,
      kind: "pay",
      to: DESTINATION,
      asset: RLUSD,
      amount: "25",
      memo: "invoice-42",
    },
    expected: {
      op: "tx.payment",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        to: DESTINATION,
        asset: WIRE_RLUSD,
        amount: "25",
        memo: "invoice-42",
      },
    },
  },
  {
    name: "fund_budget",
    intent: {
      ...BASE,
      kind: "fund_budget",
      asset: RLUSD,
      amount: "1000",
    },
    expected: {
      op: "tx.payment",
      args: {
        account: MAIN_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        to: BUDGET_ACCOUNT,
        asset: WIRE_RLUSD,
        amount: "1000",
      },
    },
  },
  {
    name: "ap4m_purchase",
    intent: {
      ...BASE,
      kind: "ap4m_purchase",
      merchant_id: "venue-yield-desk",
      sku: "yield-report",
      mandate_id: "mandate-demo-001",
    },
    expected: {
      op: "ap4m.purchase",
      args: {
        mandate_id: "mandate-demo-001",
        merchant_id: "venue-yield-desk",
        sku: "yield-report",
        idempotency_key: "intent-1",
      },
    },
  },
] as const satisfies ReadonlyArray<{
  name: Intent["kind"];
  intent: Intent;
  expected: BuildRequest;
}>;

describe("toBuild", () => {
  beforeEach(() => vi.stubEnv("HARBOR_MOCK", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it.each(mappings)("maps $name to the exact Harbor operation and args", ({ intent, expected }) => {
    expect(toBuild(intent, ACCOUNTS)).toEqual(expected);
  });

  it("omits absent optional fields instead of emitting undefined", () => {
    const limit = toBuild(
      {
        ...BASE,
        kind: "limit",
        sell: XRP,
        buy: RLUSD,
        sell_amount: "2",
        buy_amount: "1",
      },
      ACCOUNTS,
    );
    const deposit = toBuild(
      {
        ...BASE,
        kind: "lp_deposit",
        asset: XRP,
        asset2: RLUSD,
        amount: "2",
      },
      ACCOUNTS,
    );
    const pay = toBuild(
      {
        ...BASE,
        kind: "pay",
        to: DESTINATION,
        asset: XRP,
        amount: "1",
      },
      ACCOUNTS,
    );

    expect(limit.args).not.toHaveProperty("expires_at");
    expect(deposit.args).not.toHaveProperty("amount2");
    expect(pay.args).not.toHaveProperty("memo");
  });

  it("does not mutate an intent", () => {
    const intent: Intent = Object.freeze({
      ...BASE,
      kind: "swap",
      sell: Object.freeze({ ...RLUSD }),
      buy: Object.freeze({ ...XRP }),
      amount: "50",
      side: "sell",
      max_slippage_bps: 100,
    });
    const snapshot = structuredClone(intent);

    toBuild(intent, ACCOUNTS);

    expect(intent).toEqual(snapshot);
  });

  it("rejects missing or empty source-account input", () => {
    const intent = { ...BASE, kind: "cancel", offer_sequence: 41 } as const;
    expect(() => toBuild(intent)).toThrow();
    expect(() => toBuild(intent, BUDGET_ACCOUNT as never)).toThrow();
    expect(() =>
      toBuild(intent, { main_account: MAIN_ACCOUNT, budget_account: "" }),
    ).toThrow();
  });

  it("requires both account roles for fund_budget", () => {
    const intent = {
      ...BASE,
      kind: "fund_budget",
      asset: RLUSD,
      amount: "1000",
    } as const;

    expect(() =>
      toBuild(intent, { main_account: "", budget_account: BUDGET_ACCOUNT }),
    ).toThrow();
    expect(() =>
      toBuild(intent, { main_account: MAIN_ACCOUNT, budget_account: "" }),
    ).toThrow();
    expect(() =>
      toBuild(intent, {
        main_account: MAIN_ACCOUNT,
        budget_account: MAIN_ACCOUNT,
      }),
    ).toThrow();
  });

  it("keeps x402 out of the generic transaction build path", () => {
    const intent = {
      ...BASE,
      kind: "x402_call",
      url: "https://merchant.example/x402/compare",
      max_price_drops: "10000",
    } as const;

    expect(() =>
      toBuild(intent, {
        main_account: MAIN_ACCOUNT,
        budget_account: BUDGET_ACCOUNT,
        delegate_account: DELEGATE_ACCOUNT,
      }),
    ).toThrow("dedicated local Testnet x402 operation");
  });

  it("validates an intent at runtime before mapping it", () => {
    expect(() =>
      toBuild(
        {
          ...BASE,
          kind: "swap",
          sell: RLUSD,
          buy: XRP,
          amount: "-50",
          side: "sell",
          max_slippage_bps: 100,
        } as Intent,
        ACCOUNTS,
      ),
    ).toThrow();
  });

  it("encodes long currency codes only at the live Harbor build boundary", () => {
    const intent = {
      ...BASE,
      kind: "swap",
      sell: RLUSD,
      buy: XRP,
      amount: "50",
      side: "sell",
      max_slippage_bps: 100,
    } as const;
    const snapshot = structuredClone(intent);
    const request = toBuild(intent, ACCOUNTS);
    expect(request).toEqual({
      op: "tx.swap",
      args: {
        account: BUDGET_ACCOUNT,
        network: "testnet",
        intent_id: "intent-1",
        sell: WIRE_RLUSD,
        buy: XRP,
        amount: { ...WIRE_RLUSD, value: "50" },
        side: "sell",
        max_slippage_bps: 100,
        execution_mode: "fill_or_kill",
      },
    });
    expect(intent).toEqual(snapshot);
  });

  it("uses the same canonical Harbor currency and amount shape in explicit mock mode", () => {
    vi.stubEnv("HARBOR_MOCK", "1");
    const request = toBuild(
      {
        ...BASE,
        kind: "swap",
        sell: RLUSD,
        buy: XRP,
        amount: "50",
        side: "sell",
        max_slippage_bps: 100,
      },
      ACCOUNTS,
    );
    expect(request.args).toMatchObject({
      sell: WIRE_RLUSD,
      buy: XRP,
      amount: { ...WIRE_RLUSD, value: "50" },
    });
  });

  it("encodes fixed-buy XRP as drops in Harbor's CurrencyAmount field", () => {
    const request = toBuild(
      {
        ...BASE,
        kind: "swap",
        sell: RLUSD,
        buy: XRP,
        amount: "2.5",
        side: "buy",
        max_slippage_bps: 100,
      },
      ACCOUNTS,
    );
    expect(request.args).toMatchObject({
      sell: WIRE_RLUSD,
      buy: XRP,
      amount: "2500000",
      side: "buy",
    });
  });

  it("rejects mainnet AP4M intents instead of dropping their network", () => {
    expect(() =>
      toBuild(
        {
          id: "intent-ap4m-mainnet",
          network: "mainnet",
          kind: "ap4m_purchase",
          merchant_id: "venue-yield-desk",
          sku: "yield-report",
          mandate_id: "mandate-demo-001",
        },
        ACCOUNTS,
      ),
    ).toThrow("Testnet-only");
  });
});
