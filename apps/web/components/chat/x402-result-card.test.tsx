import type { X402PaymentEvent } from "@pilot/agent";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { X402ResultCard } from "./x402-result-card";

const owner = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const payer = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const payTo = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";

describe("X402ResultCard", () => {
  it("never describes an uncertain settlement as paid or delivered", () => {
    const event: X402PaymentEvent = {
      operation_id: "operation-402-0002",
      mode: "live-local",
      at: "2026-10-19T12:00:00.000Z",
      journal_status: "not_recorded",
      result: {
        status: "settlement_unknown",
        payment_id: "payment-unknown",
        idempotency_key: "pilot-x402:operation-402-0002",
        owner,
        network: "testnet",
        resource: "compare",
        request_fingerprint: "B".repeat(64),
        tx_hash: "B".repeat(64),
        last_ledger_sequence: 12_400,
        retry_after_seconds: 5,
      },
    };
    const html = renderToStaticMarkup(<X402ResultCard event={event} onRetry={() => undefined} />);
    expect(html).toContain("Settlement status unknown");
    expect(html).toContain("Retry same operation");
    expect(html.toLowerCase()).not.toContain("paid");
    expect(html.toLowerCase()).not.toContain("delivered");
    expect(html).not.toContain("Merchant JSON data");
  });

  it("renders untrusted merchant data as escaped JSON and labels fixtures honestly", () => {
    const event: X402PaymentEvent = {
      operation_id: "operation-402-0001",
      mode: "fixture",
      at: "2026-10-19T12:00:00.000Z",
      journal_status: "fixture",
      result: {
        status: "delivered",
        payment_id: "payment-402-1",
        idempotency_key: "pilot-x402:operation-402-0001",
        owner,
        network: "testnet",
        resource: "compare",
        invoice_id: "invoice-1",
        amount_drops: "5000",
        fee_drops: "12",
        payer,
        pay_to: payTo,
        tx_hash: "A".repeat(64),
        validated_ledger_index: 12_345,
        merchant: {
          status: 200,
          content_type: "application/json",
          body: { attack: '<script>alert(1)</script><a href="https://evil.invalid">go</a>' },
        },
      },
    };
    const html = renderToStaticMarkup(<X402ResultCard event={event} />);
    expect(html).toContain("Explicit local fixture only");
    expect(html).toContain("No payment, settlement, or ledger validation occurred");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<a href=");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps validated payment distinct from a failed journal and offers same-operation recovery", () => {
    const event: X402PaymentEvent = {
      operation_id: "operation-402-journal-1",
      mode: "live-local",
      at: "2026-10-19T12:00:00.000Z",
      journal_status: "failed",
      journal_error: "Durable x402 journal write failed",
      result: {
        status: "delivered",
        payment_id: "payment-402-journal-1",
        idempotency_key: "pilot-x402:operation-402-journal-1",
        owner,
        network: "testnet",
        resource: "compare",
        invoice_id: "invoice-journal-1",
        amount_drops: "5000",
        fee_drops: "12",
        payer,
        pay_to: payTo,
        tx_hash: "A".repeat(64),
        validated_ledger_index: 12_345,
        merchant: { status: 200, content_type: "application/json", body: { comparison: "delivered" } },
      },
    };
    const html = renderToStaticMarkup(<X402ResultCard event={event} onRetry={() => undefined} />);
    expect(html).toContain("Premium comparison delivered");
    expect(html).toContain("Payment settlement is validated");
    expect(html).toContain("Only the durable journal receipt is pending");
    expect(html).toContain("Retry journal with same operation");
    expect(html).not.toContain("Settlement status unknown");
  });
});
