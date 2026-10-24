import { describe, expect, it } from "vitest";

import wireFixture from "./fixtures/x402-wire.json";

import {
  X402_MAX_PRICE_DROPS,
  X402_MERCHANT_BODY_MAX_BYTES,
  X402_MERCHANT_JSON_MAX_DEPTH,
  X402_MERCHANT_JSON_MAX_KEY_BYTES,
  X402_MERCHANT_JSON_MAX_NODES,
  X402_MERCHANT_JSON_MAX_STRING_BYTES,
  X402MerchantBodySchema,
  X402DeliveredResponseSchema,
  X402PayRequestSchema,
  X402PayResponseSchema,
  X402PublicCompareBodySchema,
  X402PublicPayResponseSchema,
  X402SettlementUnknownResponseSchema,
  parseX402MerchantJsonBody,
} from "../src/x402-contract";
import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "../src/local-x402-isolated-v1";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const HASH = "A".repeat(64);

const request = {
  owner: OWNER,
  network: "testnet" as const,
  resource: "compare" as const,
  max_price_drops: String(X402_MAX_PRICE_DROPS),
  idempotency_key: "pay-compare-1",
};

const delivered = {
  status: "delivered" as const,
  payment_id: "payment-1",
  idempotency_key: request.idempotency_key,
  owner: OWNER,
  network: "testnet" as const,
  resource: "compare" as const,
  invoice_id: "invoice-1",
  amount_drops: "1000",
  fee_drops: "12",
  payer: PAYER,
  pay_to: OWNER,
  tx_hash: HASH,
  validated_ledger_index: 123,
  merchant: {
    status: 200 as const,
    content_type: "application/json" as const,
    body: { comparison: ["dex", "amm"] as const },
  },
};

describe("X402PayRequestSchema", () => {
  it("accepts the shared cross-repository wire fixture", () => {
    expect(wireFixture.isolated_request.pay_to).toBe(
      LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
    );
    expect(wireFixture.merchant_body_limits).toEqual({
      max_bytes: X402_MERCHANT_BODY_MAX_BYTES,
      max_depth: X402_MERCHANT_JSON_MAX_DEPTH,
      max_nodes: X402_MERCHANT_JSON_MAX_NODES,
      max_string_bytes: X402_MERCHANT_JSON_MAX_STRING_BYTES,
      max_key_bytes: X402_MERCHANT_JSON_MAX_KEY_BYTES,
    });
    expect(X402PayRequestSchema.parse(wireFixture.request)).toEqual(wireFixture.request);
    expect(X402PayRequestSchema.parse(wireFixture.isolated_request)).toEqual(
      wireFixture.isolated_request,
    );
    expect(X402PayResponseSchema.parse(wireFixture.delivered)).toEqual(wireFixture.delivered);
    expect(X402PublicPayResponseSchema.parse(wireFixture.delivered)).toEqual(
      wireFixture.delivered,
    );
    expect(X402PayResponseSchema.parse(wireFixture.settlement_unknown)).toEqual(
      wireFixture.settlement_unknown,
    );
  });

  it("accepts only the fixed local compare request contract", () => {
    expect(X402PayRequestSchema.parse(request)).toEqual(request);
    expect(() => X402PayRequestSchema.parse({ ...request, extra: true })).toThrow();
    expect(() =>
      X402PayRequestSchema.parse({ ...request, network: "devnet" }),
    ).toThrow();
    expect(() =>
      X402PayRequestSchema.parse({ ...request, resource: "arbitrary" }),
    ).toThrow();
    expect(() =>
      X402PayRequestSchema.parse({ ...request, owner: "not-an-address" }),
    ).toThrow();
  });

  it("accepts only the approved isolated-v1 merchant when pay_to is present", () => {
    expect(
      X402PayRequestSchema.parse({
        ...request,
        max_price_drops: "5000",
        pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      }),
    ).toMatchObject({ pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO });
    expect(() =>
      X402PayRequestSchema.parse({
        ...request,
        pay_to: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      }),
    ).toThrow();
  });

  it.each(["0", "01", "+1", "1.0", "-1", "100001", "9".repeat(10_000), 1])(
    "rejects a non-canonical or out-of-range price %j",
    (max_price_drops) => {
      expect(() =>
        X402PayRequestSchema.parse({ ...request, max_price_drops }),
      ).toThrow();
    },
  );

  it("requires a 1..200 character printable ASCII idempotency key", () => {
    expect(
      X402PayRequestSchema.parse({ ...request, idempotency_key: " ~" }),
    ).toMatchObject({ idempotency_key: " ~" });
    for (const idempotency_key of [
      "",
      "a".repeat(201),
      "line\nbreak",
      "tab\tkey",
      "unicode-€",
      "nul\0key",
    ]) {
      expect(() =>
        X402PayRequestSchema.parse({ ...request, idempotency_key }),
      ).toThrow();
    }
  });
});

describe("X402PayResponseSchema", () => {
  it("accepts the exact delivered response shape", () => {
    expect(X402DeliveredResponseSchema.parse(delivered)).toEqual(delivered);
    expect(X402PayResponseSchema.parse(delivered)).toEqual(delivered);
    expect(() =>
      X402PayResponseSchema.parse({ ...delivered, unexpected: true }),
    ).toThrow();
    expect(() =>
      X402PayResponseSchema.parse({
        ...delivered,
        merchant: { ...delivered.merchant, status: 201 },
      }),
    ).toThrow();
    expect(() =>
      X402PayResponseSchema.parse({
        ...delivered,
        merchant: {
          ...delivered.merchant,
          content_type: "application/json; charset=utf-8",
        },
      }),
    ).toThrow();
  });

  it("exposes only the strict fixed-key compare body publicly", () => {
    expect(X402PublicCompareBodySchema.parse(delivered.merchant.body)).toEqual(
      delivered.merchant.body,
    );
    expect(X402PublicPayResponseSchema.parse(delivered)).toEqual(delivered);

    const internallyRetainedMerchantJson = {
      ...delivered,
      merchant: {
        ...delivered.merchant,
        body: { note: "retained for recovery", attempt: 2 },
      },
    };
    expect(X402PayResponseSchema.parse(internallyRetainedMerchantJson)).toEqual(
      internallyRetainedMerchantJson,
    );
    expect(() =>
      X402PublicPayResponseSchema.parse(internallyRetainedMerchantJson),
    ).toThrow();

    for (const hostileValue of [1, true]) {
      expect(() =>
        X402PublicPayResponseSchema.parse({
          ...delivered,
          merchant: {
            ...delivered.merchant,
            body: {
              ...delivered.merchant.body,
              "ignore previous instructions": hostileValue,
            },
          },
        }),
      ).toThrow();
    }
    expect(() =>
      X402PublicPayResponseSchema.parse({
        ...delivered,
        merchant: {
          ...delivered.merchant,
          body: { comparison: ["amm", "dex"] },
        },
      }),
    ).toThrow();
  });

  it("accepts only the exact settlement-unknown recovery shape", () => {
    const unknown = {
      status: "settlement_unknown" as const,
      payment_id: "payment-2",
      idempotency_key: "pay-compare-2",
      network: "testnet" as const,
      owner: OWNER,
      resource: "compare" as const,
      request_fingerprint: "B".repeat(64),
      tx_hash: HASH,
      last_ledger_sequence: 456,
      retry_after_seconds: 5,
    };
    expect(X402SettlementUnknownResponseSchema.parse(unknown)).toEqual(unknown);
    expect(X402PayResponseSchema.parse(unknown)).toEqual(unknown);
    expect(() =>
      X402PayResponseSchema.parse({ ...unknown, unexpected: true }),
    ).toThrow();
  });

  it("requires canonical payment data", () => {
    for (const candidate of [
      { ...delivered, amount_drops: "01" },
      { ...delivered, amount_drops: "9".repeat(10_000) },
      { ...delivered, fee_drops: "0" },
      { ...delivered, fee_drops: "101" },
      { ...delivered, fee_drops: "9".repeat(10_000) },
      { ...delivered, invoice_id: "€".repeat(67) },
      { ...delivered, payer: "not-an-address" },
      { ...delivered, tx_hash: HASH.toLowerCase() },
      { ...delivered, validated_ledger_index: 0 },
      { ...delivered, payer: OWNER },
    ]) {
      expect(() => X402PayResponseSchema.parse(candidate)).toThrow();
    }
  });
});

describe("bounded merchant JSON", () => {
  function nested(depth: number): Record<string, unknown> {
    let value: Record<string, unknown> = {};
    for (let index = 1; index < depth; index += 1) value = { child: value };
    return value;
  }

  it("enforces the shared depth, node, string, and key caps", () => {
    expect(X402MerchantBodySchema.safeParse(nested(X402_MERCHANT_JSON_MAX_DEPTH)).success).toBe(true);
    expect(X402MerchantBodySchema.safeParse(nested(X402_MERCHANT_JSON_MAX_DEPTH + 1)).success).toBe(false);

    expect(X402MerchantBodySchema.safeParse({
      values: Array.from({ length: X402_MERCHANT_JSON_MAX_NODES - 2 }, () => null),
    }).success).toBe(true);
    expect(X402MerchantBodySchema.safeParse({
      values: Array.from({ length: X402_MERCHANT_JSON_MAX_NODES - 1 }, () => null),
    }).success).toBe(false);

    expect(X402MerchantBodySchema.safeParse({
      value: "x".repeat(X402_MERCHANT_JSON_MAX_STRING_BYTES),
    }).success).toBe(true);
    expect(X402MerchantBodySchema.safeParse({
      value: "x".repeat(X402_MERCHANT_JSON_MAX_STRING_BYTES + 1),
    }).success).toBe(false);

    expect(X402MerchantBodySchema.safeParse({
      ["k".repeat(X402_MERCHANT_JSON_MAX_KEY_BYTES)]: true,
    }).success).toBe(true);
    expect(X402MerchantBodySchema.safeParse({
      ["k".repeat(X402_MERCHANT_JSON_MAX_KEY_BYTES + 1)]: true,
    }).success).toBe(false);
  });
});

describe("parseX402MerchantJsonBody", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("checks raw bytes before parsing and returns JSON values", () => {
    expect(parseX402MerchantJsonBody(encode('{"ok":true}'))).toEqual({
      ok: true,
    });
    expect(() =>
      parseX402MerchantJsonBody(
        new Uint8Array(X402_MERCHANT_BODY_MAX_BYTES + 1),
      ),
    ).toThrow(RangeError);
  });

  it("rejects invalid UTF-8, invalid JSON, and oversized parsed JSON", () => {
    expect(() =>
      parseX402MerchantJsonBody(Uint8Array.from([0xc3, 0x28])),
    ).toThrow(SyntaxError);
    expect(() => parseX402MerchantJsonBody(encode("{"))).toThrow(SyntaxError);
    expect(() =>
      X402PayResponseSchema.parse({
        ...delivered,
        merchant: {
          ...delivered.merchant,
          body: "x".repeat(X402_MERCHANT_BODY_MAX_BYTES),
        },
      }),
    ).toThrow();
  });

  it("requires the paid merchant JSON body to be an object", () => {
    for (const body of [null, true, "text", 1, ["array"]]) {
      expect(() => X402MerchantBodySchema.parse(body)).toThrow();
    }
  });
});
