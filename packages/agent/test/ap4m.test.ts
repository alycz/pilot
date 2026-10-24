import { describe, expect, it } from "vitest";

import {
  Ap4mPurchaseToolInputSchema,
  createAp4mModelTools,
  projectAp4mDataSummary,
  revokeAp4mAgent,
  type CreateAp4mToolsOptions,
} from "../src/ap4m.js";

const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

const mandate = (status: "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED" = "ACTIVE") => ({
  id: "mandate-demo-001",
  owner: OWNER,
  network: "testnet" as const,
  status,
  execution_type: "DEFERRED" as const,
  not_before: "2026-10-21T12:00:00.000Z",
  expires_at: "2026-10-22T12:00:00.000Z",
  constraints: {
    currency: "USD" as const,
    per_payment_max: "5",
    total_max: "50",
    daily_max: "20",
    payees: ["venue-yield-desk"],
    skus: ["yield-report"],
  },
  agent_public_jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  l1_digest: "1".repeat(64),
  l2_digest: "2".repeat(64),
  setup_batch_hash: "3".repeat(64),
  channels: [],
  spent_usd: "0",
});

const purchase = {
  receipt: {
    receipt_id: "receipt-demo-001",
    mandate_id: "mandate-demo-001",
    merchant_id: "venue-yield-desk",
    sku: "yield-report",
    intent_id: "demo-intent-001",
    l3a_digest: "4".repeat(64),
    l3b_digest: "5".repeat(64),
    scheme: "exact" as const,
    amount: {
      asset: {
        kind: "iou" as const,
        currency: "RLUSD",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      value: "1",
    },
    proof: { tx_hash: "6".repeat(64) },
    merchant_validation: {
      intentId: "demo-intent-001",
      validated: true,
      checks: {
        agent_identity: "pass" as const,
        intent: "pass" as const,
        payment: "pass" as const,
        credential: "pass" as const,
      },
      validation_errors: [],
    },
    settlement: "validated" as const,
    at: "2026-10-21T12:04:00.000Z",
  },
  data: {
    schema_id: "yield_report_v1",
    venue: "xrpl-amm",
    apr_percent: "4.25",
    tvl_usd: "2500000",
    risk: "medium",
    as_of_basis: "deterministic mock derived from Harbor venue catalog",
  },
};

const ok = (data: unknown) => ({
  ok: true as const,
  data,
  asOf: "2026-10-21T12:00:00.000Z",
  asOfBasis: "offline AP4M fixture",
});

function activeOptions(
  op: (name: string, args: unknown) => Promise<any>,
): CreateAp4mToolsOptions {
  return {
    account: { budget_account: OWNER },
    network: "testnet" as const,
    harborRest: { op },
    ap4m: {
      activeMandate: { mandate_id: "mandate-demo-001", owner: OWNER },
      createIdempotencyKey: () => "server-idempotency-001",
    },
  };
}

describe("AP4M model tools", () => {
  it("exposes only merchant and SKU as model-controlled purchase inputs", () => {
    expect(
      Ap4mPurchaseToolInputSchema.safeParse({
        merchant_id: "venue-yield-desk",
        sku: "yield-report",
      }).success,
    ).toBe(true);
    for (const forbidden of ["mandate_id", "network", "url", "amount", "headers"] as const) {
      expect(
        Ap4mPurchaseToolInputSchema.safeParse({
          merchant_id: "venue-yield-desk",
          sku: "yield-report",
          [forbidden]: "model-controlled",
        }).success,
      ).toBe(false);
    }
  });

  it("binds mandate, network, owner, and idempotency outside model input", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const tools = createAp4mModelTools(
      activeOptions(async (name, args) => {
        calls.push({ name, args });
        if (name === "mandate.status") return ok(mandate());
        if (name === "ap4m.purchase") return ok(purchase);
        throw new Error(`unexpected ${name}`);
      }),
    );
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;

    await expect(
      execute({ merchant_id: "venue-yield-desk", sku: "yield-report" }),
    ).resolves.toEqual({
      status: "completed",
      merchant: "venue-yield-desk",
      sku: "yield-report",
      amount: purchase.receipt.amount,
      settlement: "validated",
      receipt_id: "receipt-demo-001",
      data_summary: {
        schema_id: "yield_report_v1",
        venue: "xrpl-amm",
        apr_percent: "4.25",
        tvl_usd: "2500000",
        risk: "medium",
      },
    });
    expect(calls).toEqual([
      { name: "mandate.status", args: { mandate_id: "mandate-demo-001" } },
      {
        name: "ap4m.purchase",
        args: {
          mandate_id: "mandate-demo-001",
          merchant_id: "venue-yield-desk",
          sku: "yield-report",
          idempotency_key: "server-idempotency-001",
        },
      },
    ]);
  });

  it("blocks a revoked mandate by named rule and never retries in the run", async () => {
    let calls = 0;
    const tools = createAp4mModelTools(
      activeOptions(async () => {
        calls += 1;
        return ok(mandate("REVOKED"));
      }),
    );
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;
    const input = { merchant_id: "venue-yield-desk", sku: "yield-report" };

    await expect(execute(input)).rejects.toThrow("MANDATE_NOT_ACTIVE");
    await expect(execute(input)).rejects.toThrow("was not retried");
    expect(calls).toBe(1);
  });

  it("latches settlement_unknown and never creates a second same-run payment", async () => {
    const pendingPurchase: any = structuredClone(purchase);
    pendingPurchase.receipt.settlement = "settlement_unknown";
    pendingPurchase.receipt.merchant_validation.validated = false;
    pendingPurchase.receipt.merchant_validation.checks.payment = "fail";
    pendingPurchase.receipt.merchant_validation.validation_errors = [
      "settlement is being reconciled",
    ];
    let calls = 0;
    let idempotencyKeys = 0;
    const options = activeOptions(async (name) => {
      calls += 1;
      return name === "mandate.status"
        ? ok(mandate())
        : ok(pendingPurchase);
    });
    options.ap4m!.createIdempotencyKey = () => {
      idempotencyKeys += 1;
      return `server-idempotency-${idempotencyKeys}`;
    };
    const tools = createAp4mModelTools(options);
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;
    const input = { merchant_id: "venue-yield-desk", sku: "yield-report" };

    const first = await execute(input);
    const second = await execute(input);
    expect(first).toEqual({
      status: "pending",
      merchant: "venue-yield-desk",
      sku: "yield-report",
      amount: purchase.receipt.amount,
      settlement: "settlement_unknown",
      receipt_id: "receipt-demo-001",
      data_summary: {},
    });
    expect(second).toEqual(first);
    expect(calls).toBe(2);
    expect(idempotencyKeys).toBe(1);
  });

  it.each([
    ["unvalidated", (value: any) => { value.receipt.merchant_validation.validated = false; }],
    ["wrong intent", (value: any) => { value.receipt.merchant_validation.intentId = "other"; }],
    ["failed check", (value: any) => { value.receipt.merchant_validation.checks.credential = "fail"; }],
    ["validation error", (value: any) => { value.receipt.merchant_validation.validation_errors = ["bad"]; }],
    ["missing exact tx hash", (value: any) => { delete value.receipt.proof.tx_hash; }],
    ["mixed exact proof", (value: any) => { value.receipt.proof.channel_id = "channel"; }],
    ["wrong exact settlement", (value: any) => { value.receipt.settlement = "claim_accepted"; }],
  ])("rejects a structurally valid but unsafe %s receipt", async (_label, mutate) => {
    const value = structuredClone(purchase);
    mutate(value);
    const tools = createAp4mModelTools(
      activeOptions(async (name) =>
        name === "mandate.status" ? ok(mandate()) : ok(value),
      ),
    );
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;

    await expect(
      execute({ merchant_id: "venue-yield-desk", sku: "yield-report" }),
    ).rejects.toThrow();
  });

  it("accepts a consistent validated risk-score channel receipt", async () => {
    const value = structuredClone(purchase) as any;
    value.receipt.receipt_id = "receipt-risk-001";
    value.receipt.merchant_id = "risk-oracle";
    value.receipt.sku = "risk-score";
    value.receipt.scheme = "xrpl-paychan";
    value.receipt.amount = { asset: { kind: "xrp" }, value: "0.05" };
    value.receipt.proof = {
      channel_id: "A".repeat(64),
      cumulative_drops: "50000",
    };
    value.receipt.settlement = "claim_accepted";
    value.data = {
      schema_id: "risk_score_v1",
      venue: "xrpl-amm",
      score: 82,
      rating: "low-risk",
      factors: ["on-ledger liquidity"],
      as_of_basis: "deterministic mock derived from Harbor venue catalog",
    };
    const tools = createAp4mModelTools(
      activeOptions(async (name) =>
        name === "mandate.status" ? ok(mandate()) : ok(value),
      ),
    );
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;

    await expect(
      execute({ merchant_id: "risk-oracle", sku: "risk-score" }),
    ).resolves.toMatchObject({
      status: "completed",
      merchant: "risk-oracle",
      sku: "risk-score",
      settlement: "claim_accepted",
      data_summary: {
        schema_id: "risk_score_v1",
        venue: "xrpl-amm",
        score: 82,
        rating: "low-risk",
      },
    });
  });

  it("rejects a typed response schema that does not match the purchased SKU", async () => {
    const value: any = structuredClone(purchase);
    value.data = {
      schema_id: "risk_score_v1",
      venue: "xrpl-amm",
      score: 82,
      rating: "low-risk",
    };
    const tools = createAp4mModelTools(
      activeOptions(async (name) =>
        name === "mandate.status" ? ok(mandate()) : ok(value),
      ),
    );
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;

    await expect(
      execute({ merchant_id: "venue-yield-desk", sku: "yield-report" }),
    ).rejects.toThrow("did not match the purchased SKU");
  });

  it("does not register a purchase tool without a server-bound mandate", () => {
    const tools = createAp4mModelTools({
      account: { budget_account: OWNER },
      network: "testnet",
      harborRest: { op: async () => ok([]) },
    });
    expect(tools).toHaveProperty("merchants_search");
    expect(tools).not.toHaveProperty("ap4m_purchase");
    expect(tools).not.toHaveProperty("revoke_ap4m_agent");
  });

  it("labels and minimizes merchant discovery sources", async () => {
    const tools = createAp4mModelTools({
      account: { budget_account: OWNER },
      network: "testnet",
      harborRest: {
        op: async (name) => {
          if (name === "merchants.list") {
            return ok([
              {
                id: "venue-yield-desk",
                name: "Venue Yield Desk",
                network: "testnet",
                base_url: "http://127.0.0.1:8794/m/venue-yield-desk",
                xrpl_address: OWNER,
                src_dpa_id: "demo-dpa-venue-yield-desk",
                schemes: ["exact"],
                settle_asset: { kind: "xrp" },
                required_credential: {
                  issuer: OWNER,
                  credential_type_hex: "4150344D2D4167656E74",
                },
                products: [
                  {
                    sku: "yield-report",
                    name: "Venue yield report",
                    description: "raw description is intentionally omitted",
                    price: { asset: { kind: "xrp" }, value: "1" },
                    response_schema_id: "yield_report_v1",
                  },
                ],
                wba_required: true,
              },
            ]);
          }
          return ok({
            source: "Mastercard Developers",
            query: "yield",
            results: [],
          });
        },
      },
    });
    const execute = tools.merchants_search!.execute as unknown as (
      input: { query: string },
    ) => Promise<any>;
    const result = await execute({ query: "yield" });

    expect(result.sources[0]).toMatchObject({
      source: "Harbor merchant registry",
      results: [
        {
          id: "venue-yield-desk",
          products: [{ sku: "yield-report" }],
        },
      ],
    });
    expect(result.sources[0].results[0]).not.toHaveProperty("base_url");
    expect(result.sources[0].results[0].products[0]).not.toHaveProperty("description");
    expect(result.sources[1]).toMatchObject({
      source: "Mastercard Developers",
      third_party: true,
    });
  });
});

describe("AP4M safe projection and kill switch", () => {
  it("projects only the exact yield and risk schema scalars", () => {
    expect(
      projectAp4mDataSummary({
        schema_id: "risk_score_v1",
        venue: "xrpl-amm",
        score: 82,
        rating: "low-risk",
        factors: ["raw text"],
        as_of_basis: "raw merchant prose",
      }),
    ).toEqual({
      schema_id: "risk_score_v1",
      venue: "xrpl-amm",
      score: 82,
      rating: "low-risk",
    });
    expect(projectAp4mDataSummary(purchase.data)).toEqual({
      schema_id: "yield_report_v1",
      venue: "xrpl-amm",
      apr_percent: "4.25",
      tvl_usd: "2500000",
      risk: "medium",
    });
  });

  it.each([
    ["unknown schema", { schema_id: "other" }],
    [
      "hybrid schema",
      {
        ...purchase.data,
        score: 82,
      },
    ],
    [
      "invalid yield decimal",
      {
        ...purchase.data,
        apr_percent: 4.25,
      },
    ],
    [
      "invalid risk type",
      {
        schema_id: "risk_score_v1",
        venue: "xrpl-amm",
        score: "82",
        rating: "low-risk",
      },
    ],
  ])("rejects %s merchant data", (_label, value) => {
    expect(() => projectAp4mDataSummary(value)).toThrow();
  });

  it("revokes both the mandate and credential outside model tools", async () => {
    const calls: string[] = [];
    const options = activeOptions(async (name) => {
      calls.push(name);
      return ok(mandate("REVOKED"));
    });
    options.ap4m!.revokeCredential = async ({ mandate_id, owner, network }) => {
      expect({ mandate_id, owner, network }).toEqual({
        mandate_id: "mandate-demo-001",
        owner: OWNER,
        network: "testnet",
      });
      calls.push("credential.revoke");
      return { status: "revoked" };
    };

    await expect(revokeAp4mAgent(options)).resolves.toEqual({
      mandate_status: "REVOKED",
      credential_status: "revoked",
    });
    expect(calls).toEqual(["mandate.revoke", "credential.revoke"]);
  });

  it("mock e2e: revoke makes the next purchase fail MANDATE_NOT_ACTIVE before purchase", async () => {
    let mandateStatus: "ACTIVE" | "REVOKED" = "ACTIVE";
    let purchaseCalls = 0;
    const calls: string[] = [];
    const options = activeOptions(async (name) => {
      calls.push(name);
      if (name === "mandate.revoke") {
        mandateStatus = "REVOKED";
        return ok(mandate(mandateStatus));
      }
      if (name === "mandate.status") return ok(mandate(mandateStatus));
      if (name === "ap4m.purchase") {
        purchaseCalls += 1;
        return ok(purchase);
      }
      throw new Error(`unexpected ${name}`);
    });
    options.ap4m!.revokeCredential = async () => {
      calls.push("credential.revoke");
      return { status: "revoked" };
    };
    const tools = createAp4mModelTools(options);
    const execute = tools.ap4m_purchase!.execute as unknown as (
      input: { merchant_id: string; sku: string },
    ) => Promise<any>;

    await expect(revokeAp4mAgent(options)).resolves.toEqual({
      mandate_status: "REVOKED",
      credential_status: "revoked",
    });
    await expect(
      execute({ merchant_id: "venue-yield-desk", sku: "yield-report" }),
    ).rejects.toThrow("MANDATE_NOT_ACTIVE");

    expect(calls).toEqual([
      "mandate.revoke",
      "credential.revoke",
      "mandate.status",
    ]);
    expect(purchaseCalls).toBe(0);
  });
});
