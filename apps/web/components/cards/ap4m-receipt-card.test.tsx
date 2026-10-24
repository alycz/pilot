import type { Ap4mReceipt, CardTrust, McIntent } from "@pilot/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Ap4mReceiptCard,
  buildAp4mDisputeEvidence,
  serializeAp4mDisputeEvidence,
  type Ap4mEvidenceArtifact,
} from "./ap4m-receipt-card";

const hash = (character: string) => character.repeat(64);

const intent: McIntent = {
  intentId: "demo-intent-receipt-1",
  intentSummary: "Buy the full venue yield report",
  intentStatus: "ACTIVE",
  orders: [
    {
      orderId: "order-1",
      orderExecutionType: "DEFERRED",
      orderExpiry: 1_793_000_000,
      orderTotalAmount: { amount: "1", currency: "USD" },
      items: [
        {
          itemId: "yield-report",
          itemName: "Yield report",
          itemUnitPrice: { amount: "1", currency: "USD" },
          itemQuantity: 1,
          itemDeliveryMethod: "DIGITAL",
        },
      ],
      merchants: [
        {
          srcDpaId: "src-dpa-venue-yield-desk",
          merchantName: "Venue Yield Desk",
          merchantUrl: "https://merchant.example.test/m/venue-yield-desk",
        },
      ],
    },
  ],
};

const receipt: Ap4mReceipt = {
  receipt_id: "receipt-1",
  mandate_id: "mandate-1",
  merchant_id: "venue-yield-desk",
  sku: "yield-report",
  intent_id: intent.intentId,
  l3a_digest: hash("a"),
  l3b_digest: hash("b"),
  scheme: "exact",
  amount: { asset: { kind: "iou", currency: "RLUSD", issuer: "rDemoIssuer" }, value: "1" },
  proof: { tx_hash: hash("c") },
  merchant_validation: {
    intentId: intent.intentId,
    validated: true,
    checks: { agent_identity: "pass", intent: "pass", credential: "pass", payment: "pass" },
    validation_errors: [],
  },
  settlement: "validated",
  at: "2026-10-21T17:00:00.000Z",
};

const signedArtifacts: Ap4mEvidenceArtifact[] = ["l1", "l2", "l3a", "l3b", "payment"].map(
  (kind, index) => ({
    kind: kind as Ap4mEvidenceArtifact["kind"],
    digest: String(index + 3).repeat(64),
    signature: "A".repeat(86),
    key_id: `public-key-${index + 1}`,
  }),
);

const trust: CardTrust = {
  screen: {
    provider: "mock",
    fields_checked: 4,
    fields_blocked: 1,
    max_score: 0.95,
  },
  model: {
    provider: "bedrock-mock",
    id: "anthropic.claude-sonnet-4-5-v1:0",
  },
  signer: {
    kind: "aws-kms-kek",
    key_ref: "alias/harbor/kek",
  },
};

describe("AP4M receipt card", () => {
  it("renders the complete evidence chain, mandatory labels, and safe explorer links", () => {
    const markup = renderToStaticMarkup(
      createElement(Ap4mReceiptCard, {
        receipt,
        intent,
        signedArtifacts,
        setupTransactionHashes: [hash("f")],
      }),
    );

    for (const label of ["Mandate", "Intent", "L3", "Payment", "Ledger"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("XRPL Testnet");
    expect(markup).toContain("Verifiable Intent v0.1");
    expect(markup).toContain("Mastercard&#x27;s Level 3 Agentic Commerce guide");
    expect(markup).toContain(`https://testnet.xrpl.org/transactions/${hash("c").toUpperCase()}`);
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Dispute evidence");
    expect(markup).not.toContain("AWS trust receipt");
  });

  it("renders the shared AWS trust receipt when canonical trust metadata is present", () => {
    const markup = renderToStaticMarkup(
      createElement(Ap4mReceiptCard, {
        receipt,
        intent,
        signedArtifacts,
        trust,
      }),
    );

    expect(markup).toContain('aria-label="AWS trust receipt"');
    expect(markup).toContain("Screened by Bedrock Guardrails (mock)");
    expect(markup).toContain("Model · Amazon Bedrock (mock)");
    expect(markup).toContain("Key protected by AWS KMS");
    expect(markup).toContain("alias/harbor/kek");
    for (const label of ["Mandate", "Intent", "L3", "Payment", "Ledger", "Dispute evidence"]) {
      expect(markup).toContain(label);
    }
  });

  it("hides the entire trust row when screening is off and no other trust state is visible", () => {
    const markup = renderToStaticMarkup(
      createElement(Ap4mReceiptCard, {
        receipt,
        intent,
        signedArtifacts,
        trust: {
          screen: { provider: "off", fields_checked: 0, fields_blocked: 0 },
        },
      }),
    );

    expect(markup).not.toContain("AWS trust receipt");
    expect(markup).not.toContain("bg-slate-50 px-4 py-3");
  });

  it("builds a deterministic public-evidence bundle without compact tokens or transaction blobs", () => {
    const input = {
      receipt,
      intent,
      signed_artifacts: signedArtifacts,
      setup_tx_hashes: [hash("f")],
    };
    expect(buildAp4mDisputeEvidence(input)).toMatchObject({
      format: "ap4m-dispute-evidence-v1",
      network: "XRPL Testnet",
      transaction_hashes: [hash("f").toUpperCase(), hash("c").toUpperCase()],
    });
    const serialized = serializeAp4mDisputeEvidence(input);
    expect(serialized).not.toMatch(/tx_blob|credential_ids|sd-jwt|private[_ -]?key|mnemonic|customer/i);
    expect(JSON.parse(serialized)).toMatchObject({ receipt: { receipt_id: "receipt-1" } });
  });

  it("fails closed when artifacts are missing, duplicated, or malformed", () => {
    expect(() =>
      buildAp4mDisputeEvidence({ receipt, intent, signed_artifacts: signedArtifacts.slice(1) }),
    ).toThrow(/missing l1/);
    expect(() =>
      buildAp4mDisputeEvidence({
        receipt,
        intent,
        signed_artifacts: [...signedArtifacts, signedArtifacts[0]!],
      }),
    ).toThrow(/must be unique/);
    expect(() =>
      buildAp4mDisputeEvidence({
        receipt,
        intent,
        signed_artifacts: signedArtifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, signature: "not valid" } : artifact,
        ),
      }),
    ).toThrow(/base64url/);
  });
});
