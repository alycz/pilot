import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import wireFixture from "./fixtures/x402-wire.json";

const engineExecute = vi.hoisted(() => vi.fn());
const engineCreate = vi.hoisted(() =>
  vi.fn(() => ({ execute: engineExecute })),
);

vi.mock("../src/exec/x402-pay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/exec/x402-pay")>();
  return {
    ...actual,
    createX402PaymentEngine: engineCreate,
  };
});

import {
  createLocalX402Service,
  encodeT54PaymentSignature,
  publicX402Result,
} from "../src/exec/x402-runtime";
import { LOCAL_X402_COMPARE_PRICE_DROPS } from "../src/local-x402";
import {
  LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
  LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
} from "../src/local-x402-isolated-v1";
import type { X402PayRequest } from "../src/x402-contract";
import type { X402PaymentRow } from "../src/exec/x402-store";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const PAY_TO = LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO;
const UNAPPROVED_PAY_TO = "rDNPy1xcB9PJoNZyG1u36Whd1rboH6Go9D";
const HASH = "A".repeat(64);
const localX402Profile = JSON.parse(
  readFileSync(new URL("../wrangler.local-x402.jsonc", import.meta.url), "utf8"),
) as { vars?: { HARBOR_SOURCE_TAG?: string } };
const SOURCE_TAG = Number(localX402Profile.vars?.HARBOR_SOURCE_TAG);

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
}

function row(overrides: Partial<X402PaymentRow> = {}): X402PaymentRow {
  return {
    id: "payment-1",
    principal: "pilot-local",
    idempotencyKey: "request-1",
    requestFingerprint: "B".repeat(64),
    owner: OWNER,
    network: "testnet",
    delegate: PAYER,
    url: "http://127.0.0.1:8000/api/x402/compare",
    status: "delivered",
    amountDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
    feeCapDrops: "100",
    reservedTotalDrops: "5100",
    callerMaxDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
    policyPerCallCapDrops: "100000",
    dailyCapDrops: "1000000",
    payTo: PAY_TO,
    invoiceId: "invoice-1",
    requirements: null,
    transaction: { Fee: "12" },
    signedBlob: "ABCD",
    hash: HASH,
    lastLedgerSeq: 1015,
    expiresAt: "2026-10-19T10:01:00.000Z",
    reservedAt: "2026-10-19T10:00:00.000Z",
    leaseAcquiredAt: "2026-10-19T10:00:00.000Z",
    signingStartedAt: "2026-10-19T10:00:00.000Z",
    signedAt: "2026-10-19T10:00:00.000Z",
    settlementUnknownAt: "2026-10-19T10:00:00.000Z",
    settledAt: "2026-10-19T10:00:00.000Z",
    deliveredAt: "2026-10-19T10:00:00.000Z",
    failedAt: null,
    settlement: { ledger_index: 1004 },
    delivery: {
      http_status: 200,
      content_type: "application/json",
      body: { comparison: ["dex", "amm"] },
    },
    failure: null,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
}

const request = {
  owner: OWNER,
  network: "testnet" as const,
  resource: "compare" as const,
  max_price_drops: LOCAL_X402_COMPARE_PRICE_DROPS,
  idempotency_key: "request-1",
};

describe("local x402 runtime adapter", () => {
  it.each([
    {
      profile: "legacy .1",
      markers: {},
      maxPriceDrops: "5001",
      exactPriceDrops: undefined,
      payTo: undefined,
    },
    {
      profile: "reviewed isolated-v1",
      markers: {
        HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
          LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
      },
      maxPriceDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
      exactPriceDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
      payTo: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
    },
  ])(
    "passes the exact engine price only for the $profile marker pair",
    async ({
      markers,
      maxPriceDrops,
      exactPriceDrops,
      payTo,
    }) => {
      engineExecute.mockReset();
      engineExecute.mockResolvedValue({
        status: "delivered",
        hash: HASH,
        httpStatus: 200,
        body: { comparison: ["dex", "amm"] },
        replayed: false,
        row: row({ callerMaxDrops: maxPriceDrops }),
      });
      const service = createLocalX402Service({
        DB: {} as D1Database,
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_MERCHANT_PAY_TO: PAY_TO,
        ...markers,
      });
      const profileRequest = {
        ...request,
        max_price_drops: maxPriceDrops,
        ...(payTo === undefined ? {} : { pay_to: payTo }),
      } as X402PayRequest;

      await service.pay("pilot-local", profileRequest);

      const input = engineExecute.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input).toMatchObject({
        principal: "pilot-local",
        owner: OWNER,
        network: "testnet",
        idempotencyKey: "request-1",
        maxPriceDrops,
      });
      if (exactPriceDrops === undefined) {
        expect(input).not.toHaveProperty("exactPriceDrops");
        expect(input).not.toHaveProperty("payTo");
      } else {
        expect(input).toHaveProperty("exactPriceDrops", exactPriceDrops);
        expect(input).toHaveProperty("payTo", payTo);
      }
    },
  );

  it("enables the shared authority only for the exact combined marker pair", async () => {
    engineCreate.mockClear();
    engineExecute.mockReset();
    engineExecute.mockResolvedValue({
      status: "delivered",
      hash: HASH,
      httpStatus: 200,
      body: { comparison: ["dex", "amm"] },
      replayed: false,
      row: row(),
    });
    const service = createLocalX402Service({
      DB: {} as D1Database,
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_X402_MERCHANT_PAY_TO: PAY_TO,
      HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
        LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
      HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE:
        "reviewed-testnet-ap4m-x402-combined-v1",
    });

    await service.pay("pilot-local", {
      ...request,
      pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
    });

    const dependencies = engineCreate.mock.calls.at(-1)?.[0] as {
      sequenceLeases?: unknown;
    };
    expect(dependencies.sequenceLeases).toBeDefined();
  });

  it("rejects partial or substituted combined markers before engine dispatch", async () => {
    for (const markers of [
      { HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED: "true" },
      {
        HARBOR_LOCAL_AP4M_X402_COMBINED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_AP4M_X402_COMBINED_V1_SIGNING_PROFILE: "substituted",
      },
    ]) {
      engineExecute.mockReset();
      const service = createLocalX402Service({
        DB: {} as D1Database,
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_MERCHANT_PAY_TO: PAY_TO,
        ...markers,
      });
      await expect(service.pay("pilot-local", request)).rejects.toThrow(
        "Combined AP4M x402 profile is invalid",
      );
      expect(engineExecute).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      profile: "partial isolated-v1",
      markers: {
        HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
      },
    },
    {
      profile: "mixed isolated-v1 and trading",
      markers: {
        HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
          LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
        HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true",
      },
    },
  ])(
    "refuses the $profile markers before engine dispatch",
    async ({ markers }) => {
      engineExecute.mockReset();
      const service = createLocalX402Service({
        DB: {} as D1Database,
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_MERCHANT_PAY_TO:
          LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
        ...markers,
      });

      await expect(
        service.pay("pilot-local", {
          ...request,
          max_price_drops: "5001",
        }),
      ).rejects.toThrow("isolated profile is invalid");
      expect(engineExecute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined],
    ["substituted valid", UNAPPROVED_PAY_TO],
  ] as const)(
    "refuses a %s isolated merchant before engine or signer access",
    async (_label, merchantPayTo) => {
      engineExecute.mockReset();
      expect(LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO).toBe(
        "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr",
      );
      const service = createLocalX402Service({
        DB: {} as D1Database,
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        ...(merchantPayTo === undefined
          ? {}
          : { HARBOR_LOCAL_X402_MERCHANT_PAY_TO: merchantPayTo }),
        HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
          LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
      });

      await expect(
        service.pay("pilot-local", {
          ...request,
          pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
        }),
      ).rejects.toThrow("merchant receiver");
      expect(engineExecute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", request],
    [
      "substituted valid",
      { ...request, pay_to: UNAPPROVED_PAY_TO } as unknown as X402PayRequest,
    ],
  ] as const)(
    "refuses a %s isolated request pay_to before engine dispatch",
    async (_label, isolatedRequest) => {
      engineExecute.mockReset();
      const service = createLocalX402Service({
        DB: {} as D1Database,
        HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_MERCHANT_PAY_TO:
          LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
        HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
        HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
          LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
      });

      await expect(
        service.pay("pilot-local", isolatedRequest),
      ).rejects.toThrow();
      expect(engineExecute).not.toHaveBeenCalled();
    },
  );

  it("forbids pay_to in the generic runtime before engine dispatch", async () => {
    engineExecute.mockReset();
    const service = createLocalX402Service({
      DB: {} as D1Database,
      HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
      HARBOR_LOCAL_X402_MERCHANT_PAY_TO:
        LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
    });

    await expect(
      service.pay("pilot-local", {
        ...request,
        pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      }),
    ).rejects.toThrow();
    expect(engineExecute).not.toHaveBeenCalled();
  });

  it("encodes the exact T54 v2 PAYMENT-SIGNATURE envelope", () => {
    const encoded = encodeT54PaymentSignature({
      challenge: {
        x402Version: 2,
        resource: {
          url: "http://127.0.0.1:8000/api/x402/compare",
          description: "Local comparison",
          mimeType: "application/json",
          serviceName: "Pilot",
          tags: ["compare"],
          iconUrl: "https://example.test/icon.png",
        },
        scheme: "exact",
        network: "xrpl:1",
        asset: "XRP",
        payTo: PAY_TO,
        amountDrops: LOCAL_X402_COMPARE_PRICE_DROPS,
        maxTimeoutSeconds: 60,
        invoiceId: "invoice-1",
        sourceTag: SOURCE_TAG,
        destinationTag: 7,
      },
      transaction: { TransactionType: "Payment" },
      signedBlob: "ABCD",
      hash: HASH,
    });
    expect(decodeBase64Json(encoded)).toEqual(wireFixture.t54_payment_signature);
    expect(SOURCE_TAG).toBe(2_610_240);
    expect(
      wireFixture.t54_payment_signature.accepted.extra.sourceTag,
    ).toBe(SOURCE_TAG);
  });

  it("maps only durable delivered evidence into the frozen public response", () => {
    expect(publicX402Result("pilot-local", request, {
      status: "delivered",
      hash: HASH,
      httpStatus: 200,
      body: { comparison: ["dex", "amm"] },
      replayed: false,
      row: row(),
    }, PAY_TO)).toEqual({
      status: "delivered",
      payment_id: "payment-1",
      idempotency_key: "request-1",
      owner: OWNER,
      network: "testnet",
      resource: "compare",
      invoice_id: "invoice-1",
      amount_drops: LOCAL_X402_COMPARE_PRICE_DROPS,
      fee_drops: "12",
      payer: PAYER,
      pay_to: PAY_TO,
      tx_hash: HASH,
      validated_ledger_index: 1004,
      merchant: {
        status: 200,
        content_type: "application/json",
        body: { comparison: ["dex", "amm"] },
      },
    });
  });

  it("returns a bounded recovery record without claiming delivery", () => {
    expect(publicX402Result("pilot-local", request, {
      status: "settlement_unknown",
      hash: HASH,
      row: row({ status: "settlement_unknown", settlement: null, deliveredAt: null }),
    }, PAY_TO)).toEqual({
      status: "settlement_unknown",
      payment_id: "payment-1",
      idempotency_key: "request-1",
      network: "testnet",
      owner: OWNER,
      resource: "compare",
      request_fingerprint: "B".repeat(64),
      tx_hash: HASH,
      last_ledger_sequence: 1015,
      retry_after_seconds: 5,
    });
  });

  it("fails closed when durable owner binding or settlement evidence is missing", () => {
    expect(() => publicX402Result("pilot-local", request, {
      status: "delivered",
      hash: HASH,
      httpStatus: 200,
      body: {},
      replayed: false,
      row: row({ owner: PAY_TO }),
    }, PAY_TO)).toThrow("binding");
    expect(() => publicX402Result("pilot-local", request, {
      status: "delivered",
      hash: HASH,
      httpStatus: 200,
      body: {},
      replayed: false,
      row: row({ settlement: null }),
    }, PAY_TO)).toThrow("settlement");
    expect(() => publicX402Result("pilot-local", request, {
      status: "delivered",
      hash: HASH,
      httpStatus: 200,
      body: {},
      replayed: false,
      row: row(),
    }, OWNER)).toThrow("binding");
  });
});
