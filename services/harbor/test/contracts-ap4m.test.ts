import { describe, expect, it } from "vitest";
import {
  Ap4mAssetSchema,
  Ap4mReceiptSchema,
  DEFAULT_POLICY,
  IntentSchema,
  IntentValidationSchema,
  MandateConstraintsSchema,
  MandateSchema,
  McIntentSchema,
  MerchantSchema,
  PolicySchema,
  XrplPaymentProofSchema,
} from "../src/contracts";

const xrpAsset = { kind: "xrp" as const };
const iouAsset = {
  kind: "iou" as const,
  currency: "RLUSD",
  issuer: "rIssuer",
};

const constraints = {
  currency: "USD" as const,
  per_payment_max: "5",
  total_max: "25",
  daily_max: "10",
  payees: ["venue-yield-desk"],
  skus: ["yield-report"],
};

const validation = {
  intentId: "demo-intent-1",
  validated: true,
  checks: {
    agent_identity: "pass" as const,
    intent: "pass" as const,
    payment: "pass" as const,
    credential: "pass" as const,
  },
  validation_errors: [],
};

const merchant = {
  id: "venue-yield-desk",
  name: "Venue Yield Desk",
  network: "testnet" as const,
  base_url: "https://merchant.example",
  xrpl_address: "rMerchant",
  src_dpa_id: "demo-dpa-venue-yield-desk",
  schemes: ["exact", "xrpl-paychan"] as const,
  settle_asset: iouAsset,
  required_credential: {
    issuer: "rDemoNetwork",
    credential_type_hex: "4150344D2D4167656E74",
  },
  products: [
    {
      sku: "yield-report",
      name: "Yield report",
      description: "A typed venue yield report",
      price: { asset: iouAsset, value: "1" },
      response_schema_id: "yield_report_v1",
    },
  ],
  wba_required: true,
};

const mcIntent = {
  intentId: "demo-intent-1",
  intentSummary: "Buy a venue yield report",
  intentStatus: "ACTIVE" as const,
  orders: [
    {
      orderId: "order-1",
      orderExecutionType: "DEFERRED" as const,
      orderExpiry: 1_800_000_000,
      orderTotalAmount: { amount: "1", currency: "USD" },
      items: [
        {
          itemId: "yield-report",
          itemName: "Yield report",
          itemUnitPrice: { amount: "1", currency: "USD" },
          itemQuantity: 1,
          itemDeliveryMethod: "DIGITAL" as const,
        },
      ],
      merchants: [
        {
          srcDpaId: "demo-dpa-venue-yield-desk",
          merchantName: "Venue Yield Desk",
          merchantUrl: "https://merchant.example",
        },
      ],
    },
  ],
};

const mandate = {
  id: "mandate-1",
  owner: "rOwner",
  network: "testnet" as const,
  status: "ACTIVE" as const,
  execution_type: "DEFERRED" as const,
  not_before: "2026-10-21T00:00:00.000Z",
  expires_at: "2026-10-22T00:00:00.000Z",
  constraints,
  agent_public_jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  l1_digest: "a".repeat(64),
  l2_digest: "b".repeat(64),
  setup_batch_hash: "ABC",
  channels: [
    {
      merchant_id: "venue-yield-desk",
      channel_id: "CHANNEL",
      amount_drops: "1000000",
    },
  ],
  spent_usd: "1",
};

const receipt = {
  receipt_id: "receipt-1",
  mandate_id: "mandate-1",
  merchant_id: "venue-yield-desk",
  sku: "yield-report",
  intent_id: "demo-intent-1",
  l3a_digest: "c".repeat(64),
  l3b_digest: "d".repeat(64),
  scheme: "exact" as const,
  amount: { asset: iouAsset, value: "1" },
  proof: { tx_hash: "HASH" },
  merchant_validation: validation,
  settlement: "validated" as const,
  at: "2026-10-21T00:01:00.000Z",
};

function withUnknown<T extends object>(value: T): T & { unexpected: true } {
  return { ...value, unexpected: true };
}

describe("AP4M contracts", () => {
  it("parses both AP4M asset variants and rejects unknown keys", () => {
    expect(Ap4mAssetSchema.parse(xrpAsset)).toEqual(xrpAsset);
    expect(Ap4mAssetSchema.parse(iouAsset)).toEqual(iouAsset);
    expect(() => Ap4mAssetSchema.parse(withUnknown(xrpAsset))).toThrow();
  });

  it("parses strict merchant fixtures", () => {
    expect(MerchantSchema.parse(merchant)).toEqual(merchant);
    expect(() => MerchantSchema.parse(withUnknown(merchant))).toThrow();
  });

  it("parses strict mandate constraints and mandates", () => {
    expect(MandateConstraintsSchema.parse(constraints)).toEqual(constraints);
    expect(() =>
      MandateConstraintsSchema.parse(withUnknown(constraints)),
    ).toThrow();
    expect(MandateSchema.parse(mandate)).toEqual(mandate);
    expect(() => MandateSchema.parse(withUnknown(mandate))).toThrow();
  });

  it("parses strict Mastercard intent fixtures", () => {
    expect(McIntentSchema.parse(mcIntent)).toEqual(mcIntent);
    expect(() => McIntentSchema.parse(withUnknown(mcIntent))).toThrow();
  });

  it("parses both strict XRPL payment proof variants", () => {
    const exact = {
      type: "xrpl_exact" as const,
      tx_blob: "BLOB",
      credential_ids: ["CREDENTIAL"],
    };
    const claim = {
      type: "xrpl_paychan_claim" as const,
      channel_id: "CHANNEL",
      cumulative_drops: "50000",
      signature: "SIGNATURE",
      public_key: "PUBLIC_KEY",
    };

    expect(XrplPaymentProofSchema.parse(exact)).toEqual(exact);
    expect(XrplPaymentProofSchema.parse(claim)).toEqual(claim);
    expect(() => XrplPaymentProofSchema.parse(withUnknown(exact))).toThrow();
  });

  it("parses strict merchant validation and receipt fixtures", () => {
    expect(IntentValidationSchema.parse(validation)).toEqual(validation);
    expect(() =>
      IntentValidationSchema.parse(withUnknown(validation)),
    ).toThrow();
    expect(Ap4mReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => Ap4mReceiptSchema.parse(withUnknown(receipt))).toThrow();
  });

  it("adds the AP4M policy switch without loosening the policy contract", () => {
    expect(PolicySchema.parse(DEFAULT_POLICY).ap4m_enabled).toBe(false);
    expect(() => PolicySchema.parse(withUnknown(DEFAULT_POLICY))).toThrow();
  });

  it("parses the AP4M purchase intent and rejects unknown keys", () => {
    const intent = {
      id: "intent-1",
      network: "testnet" as const,
      kind: "ap4m_purchase" as const,
      merchant_id: "venue-yield-desk",
      sku: "yield-report",
      mandate_id: "mandate-1",
    };

    expect(IntentSchema.parse(intent)).toEqual(intent);
    expect(() => IntentSchema.parse(withUnknown(intent))).toThrow();
  });
});
