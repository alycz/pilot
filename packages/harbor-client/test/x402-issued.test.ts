import { describe, expect, it, vi } from "vitest";

import {
  HarborArgsSchemas,
  HarborResultSchemas,
  X402IssuedPayArgsSchema,
  compareX402IssuedAmounts,
  createHarborRestClient,
  type X402IssuedFixtureResult,
  type X402IssuedPayArgs,
} from "../src/index.js";

const request: X402IssuedPayArgs = {
  owner: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
  network: "testnet",
  resource: "compare",
  session_scope: "session-scope-001",
  merchant: {
    id: "merchant-local-001",
    resource_method: "POST",
    resource_url: "http://127.0.0.1:8000/api/x402/compare",
  },
  asset: {
    kind: "xrpl-issued",
    network: "xrpl:1",
    currency: "524C555344000000000000000000000000000000",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  },
  max_amount: "0.01",
  pay_to: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  idempotency_key: "issued-request-001",
};

const result: X402IssuedFixtureResult = {
  status: "fixture_delivered",
  evidence: "deterministic-offline-fixture",
  session_scope: request.session_scope,
  merchant: request.merchant,
  merchant_invoice_id: "merchant-invoice-raw-001",
  idempotency_key: request.idempotency_key,
  approval_digest: "A".repeat(64),
  asset: request.asset,
  amount: "0.01",
  payer: request.owner,
  pay_to: request.pay_to,
  fee_drops: "12",
  transaction_hash: "B".repeat(64),
  validated_ledger_index: 1_000,
  merchant_body: {
    comparison: ["dex", "amm"],
    paymentEvidence: "deterministic-offline-fixture-not-live-validation",
  },
};

function response(value: X402IssuedFixtureResult): Response {
  return new Response(JSON.stringify({
    ok: true,
    data: value,
    asOf: "2026-10-24T12:00:00.000Z",
    asOfBasis: "deterministic-offline-fixture",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("issued x402 Harbor client contract", () => {
  it("registers an exact issued request/result map without changing x402.pay", () => {
    expect(HarborArgsSchemas["x402.payIssuedFixture"].parse(request)).toEqual(request);
    expect(HarborResultSchemas["x402.payIssuedFixture"].parse(result)).toEqual(result);
    expect(X402IssuedPayArgsSchema.safeParse({ ...request, max_amount: 0.01 }).success).toBe(false);
    expect(X402IssuedPayArgsSchema.safeParse({
      ...request,
      asset: { ...request.asset, currency: request.asset.currency.toLowerCase() },
    }).success).toBe(false);
    expect(HarborArgsSchemas["x402.pay"].safeParse(request).success).toBe(false);
  });

  it("compares decimal amounts without binary floating point", () => {
    expect(compareX402IssuedAmounts("0.010000000000001", "0.01")).toBe(1);
    expect(compareX402IssuedAmounts("99999999999999.9", "100000000000000")).toBe(-1);
  });

  it("binds REST fixture evidence to the complete request", async () => {
    const fetch = vi.fn(async () => response(result));
    const client = createHarborRestClient({
      baseUrl: "http://127.0.0.1:8791",
      apiKey: "fixture-key",
      mock: false,
      fetch,
    });
    await expect(client.op("x402.payIssuedFixture", request)).resolves.toMatchObject({
      ok: true,
      data: result,
    });
    const mismatched = createHarborRestClient({
      baseUrl: "http://127.0.0.1:8791",
      apiKey: "fixture-key",
      mock: false,
      fetch: vi.fn(async () => response({ ...result, session_scope: "other-scope-001" })),
    });
    await expect(mismatched.op("x402.payIssuedFixture", request)).rejects.toThrow(
      "outside the authorized binding",
    );
  });
});
