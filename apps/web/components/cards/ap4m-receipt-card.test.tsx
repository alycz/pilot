import type { Ap4mPublicEvidence, Ap4mReceipt, CardTrust, McIntent } from "@pilot/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Ap4mReceiptCard, buildAp4mDisputeEvidence, serializeAp4mDisputeEvidence } from "./ap4m-receipt-card";

const hash = (character: string) => character.repeat(64).toUpperCase();
const intent: McIntent = {
  intentId: "demo-intent-receipt-1", intentSummary: "Buy the full venue yield report",
  intentStatus: "ACTIVE", orders: [{
    orderId: "order-1", orderExecutionType: "DEFERRED", orderExpiry: 1_793_000_000,
    orderTotalAmount: { amount: "1", currency: "USD" },
    items: [{ itemId: "yield-report", itemName: "Yield report", itemUnitPrice: { amount: "1", currency: "USD" }, itemQuantity: 1, itemDeliveryMethod: "DIGITAL" }],
    merchants: [{ srcDpaId: "src-dpa-venue-yield-desk", merchantName: "Venue Yield Desk", merchantUrl: "https://merchant.example.test/m/venue-yield-desk" }],
  }],
};
const receipt: Ap4mReceipt = {
  receipt_id: "receipt-1", mandate_id: "mandate-1", merchant_id: "venue-yield-desk",
  sku: "yield-report", intent_id: intent.intentId, l3a_digest: hash("A"), l3b_digest: hash("B"),
  scheme: "exact", amount: { asset: { kind: "iou", currency: "RLUSD", issuer: "rDemoIssuer" }, value: "1" },
  proof: { tx_hash: hash("C") },
  merchant_validation: { intentId: intent.intentId, validated: true, checks: { agent_identity: "pass", intent: "pass", credential: "pass", payment: "pass" }, validation_errors: [] },
  settlement: "validated", at: "2026-10-21T17:00:00.000Z",
};
const evidence: Ap4mPublicEvidence = {
  version: "ap4m-public-evidence-v1", provenance: "live-testnet", network: "testnet", rail: "exact", intent,
  artifacts: [
    { kind: "l1", digest: hash("1"), digest_basis: "sha256-utf8/vi-l1-presentation" },
    { kind: "l2", digest: hash("2"), digest_basis: "sha256-utf8/vi-l2-merchant-presentation" },
    { kind: "l3a", digest: hash("A"), digest_basis: "sha256-utf8/vi-l3a-presentation" },
    { kind: "l3b", digest: hash("B"), digest_basis: "sha256-utf8/vi-l3b-presentation" },
    { kind: "payment", digest: hash("C"), digest_basis: "xrpl/signed-transaction-hash" },
  ],
};
const trust: CardTrust = {
  screen: { provider: "mock", fields_checked: 4, fields_blocked: 1, max_score: 0.95 },
  model: { provider: "bedrock-mock", id: "anthropic.claude-sonnet-4-5-v1:0" },
  signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
};

describe("AP4M receipt card", () => {
  it("renders only validated exact live evidence with an official Testnet explorer link", () => {
    const markup = renderToStaticMarkup(createElement(Ap4mReceiptCard, { receipt, evidence }));
    for (const label of ["Mandate", "Intent", "L3", "Payment", "Ledger"]) expect(markup).toContain(label);
    expect(markup).toContain("live validated evidence");
    expect(markup).toContain(`https://testnet.xrpl.org/transactions/${hash("C")}`);
    expect(markup).toContain("five bounded digest references");
    expect(markup).not.toMatch(/signature|pay channel|setup/i);
  });

  it("renders shared trust metadata without changing evidence provenance", () => {
    const markup = renderToStaticMarkup(createElement(Ap4mReceiptCard, { receipt, evidence, trust }));
    expect(markup).toContain('aria-label="AWS trust receipt"');
    expect(markup).toContain("Screened by Bedrock Guardrails (mock)");
  });

  it("exports deterministic digest references without secret-bearing fields", () => {
    expect(buildAp4mDisputeEvidence({ receipt, evidence })).toMatchObject({
      format: "ap4m-dispute-evidence-v1", network: "XRPL Testnet",
      intent: { intentId: intent.intentId }, transaction_hashes: [hash("C")],
    });
    const serialized = serializeAp4mDisputeEvidence({ receipt, evidence });
    expect(serialized).toContain("artifact_references");
    expect(serialized).not.toMatch(/tx_blob|credential_ids|compact|disclosure|private[_ -]?key|mnemonic|signature/i);
  });

  it("fails closed for pending, paychan, mock provenance, or mismatched references", () => {
    expect(() => buildAp4mDisputeEvidence({ receipt: { ...receipt, settlement: "settlement_unknown" }, evidence })).toThrow(/validated exact/);
    expect(() => buildAp4mDisputeEvidence({
      receipt: { ...receipt, merchant_validation: { ...receipt.merchant_validation, validated: false, checks: { ...receipt.merchant_validation.checks, payment: "fail" }, validation_errors: ["payment mismatch"] } },
      evidence,
    })).toThrow(/fully passed merchant validation/);
    expect(() => buildAp4mDisputeEvidence({
      receipt: { ...receipt, scheme: "xrpl-paychan", proof: { channel_id: hash("D"), cumulative_drops: "1" }, settlement: "claim_accepted" },
      evidence,
    })).toThrow(/validated exact/);
    expect(() => buildAp4mDisputeEvidence({
      receipt,
      evidence: { ...evidence, provenance: "fixture" } as unknown as Ap4mPublicEvidence,
    })).toThrow();
    expect(() => buildAp4mDisputeEvidence({
      receipt,
      evidence: { ...evidence, artifacts: evidence.artifacts.map((entry, index) => index === 4 ? { ...entry, digest: hash("D") } : entry) as Ap4mPublicEvidence["artifacts"] },
    })).toThrow(/do not match/);
  });
});
