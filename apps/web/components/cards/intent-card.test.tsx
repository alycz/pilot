import type { CardEvent } from "@pilot/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./state-cards", async () => {
  const { createElement } = await import("react");
  const StateCard = ({ event }: { event: CardEvent }) =>
    createElement("article", { "data-state": event.state }, `State: ${event.state}`);

  return {
    AwaitingApprovalCard: StateCard,
    BlockedCard: StateCard,
    DraftingCard: StateCard,
    ExecutingCard: StateCard,
    FailedCard: StateCard,
    PlannedCard: StateCard,
    PolicyCheckedCard: StateCard,
    SimulatedCard: StateCard,
    SubmittedCard: StateCard,
    ValidatedCard: StateCard,
  };
});

import { IntentCard, testnetTransactionExplorerUrl } from "./intent-card";
import { DraftingCard } from "./state-cards";

const event: CardEvent = {
  intent_id: "intent-aws-trust-receipt",
  state: "drafting",
  at: "2026-10-21T00:00:00.000Z",
  intent: {
    id: "intent-aws-trust-receipt",
    network: "testnet",
    kind: "swap",
    sell: { currency: "RLUSD", issuer: "rDemoIssuer" },
    buy: { currency: "XRP" },
    amount: "50",
    side: "sell",
    max_slippage_bps: 100,
  },
};

describe("IntentCard AWS trust receipt", () => {
  it("preserves the existing state-card markup when trust metadata is absent", () => {
    const intentMarkup = renderToStaticMarkup(createElement(IntentCard, { event }));
    const stateMarkup = renderToStaticMarkup(createElement(DraftingCard, { event }));

    expect(intentMarkup).toBe(stateMarkup);
    expect(intentMarkup).not.toContain("AWS trust receipt");
  });

  it("adds no receipt wrapper when all trust providers are off", () => {
    const offEvent: CardEvent = {
      ...event,
      trust: { screen: { provider: "off", fields_checked: 0, fields_blocked: 0 } },
    };

    expect(renderToStaticMarkup(createElement(IntentCard, { event: offEvent }))).toBe(
      renderToStaticMarkup(createElement(DraftingCard, { event: offEvent })),
    );
  });

  it("renders all canonical trust chips after the state card", () => {
    const trustedEvent: CardEvent = {
      ...event,
      trust: {
        screen: { provider: "mock", fields_checked: 3, fields_blocked: 1, max_score: 0.95 },
        model: { provider: "bedrock-mock", id: "anthropic.claude-sonnet-4-5-v1:0" },
        signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
      },
    };
    const markup = renderToStaticMarkup(createElement(IntentCard, { event: trustedEvent }));

    expect(markup).toContain("State: drafting");
    expect(markup).toContain('aria-label="AWS trust receipt"');
    expect(markup).toContain("Screened by Bedrock Guardrails (mock)");
    expect(markup).toContain("Model · Amazon Bedrock (mock)");
    expect(markup).toContain("Key protected by AWS KMS");
    expect(markup.indexOf("State: drafting")).toBeLessThan(markup.indexOf("AWS trust receipt"));
  });

  it("renders bounded client-known Ledger evidence beside existing trust chips", () => {
    const trustedEvent: CardEvent = {
      ...event,
      trust: {
        signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
      },
    };
    const markup = renderToStaticMarkup(createElement(IntentCard, {
      event: trustedEvent,
      ownerSigner: { kind: "ledger", accountIndex: 1 },
    }));

    expect(markup).toContain("Key protected by AWS KMS");
    expect(markup).toContain("Signed through configured Ledger flow");
    expect(markup).toContain("account 1");
  });

  it("renders no owner chip for malformed client metadata", () => {
    const markup = renderToStaticMarkup(createElement(IntentCard, {
      event,
      ownerSigner: { kind: "ledger", accountIndex: 99 } as never,
    }));

    expect(markup).not.toContain("Signed through configured Ledger flow");
    expect(markup).toBe(renderToStaticMarkup(createElement(DraftingCard, { event })));
  });

  it("renders an explorer receipt only for a real validated Testnet 64-hex hash", () => {
    const hash = "a".repeat(64);
    const validated = { ...event, state: "validated" as const, hash };
    const markup = renderToStaticMarkup(createElement(IntentCard, {
      event: validated,
      realLedgerReceipt: true,
    }));
    expect(markup).toContain("Validated ledger transaction · XRPL Testnet");
    expect(markup).toContain(hash.toUpperCase());
    expect(markup).toContain(`https://testnet.xrpl.org/transactions/${hash.toUpperCase()}`);
    expect(testnetTransactionExplorerUrl(validated, true)).toBe(`https://testnet.xrpl.org/transactions/${hash.toUpperCase()}`);
  });

  it("never links submitted, simulated, malformed, mock, or non-Testnet receipts", () => {
    const hash = "B".repeat(64);
    const candidates: Array<{ candidate: CardEvent; real: boolean }> = [
      { candidate: { ...event, state: "submitted", hash }, real: true },
      { candidate: { ...event, state: "validated", hash: `SIM${"A".repeat(61)}` }, real: true },
      { candidate: { ...event, state: "validated", hash }, real: false },
      { candidate: { ...event, state: "validated", hash, intent: { ...event.intent, network: "devnet" } }, real: true },
    ];
    for (const { candidate, real } of candidates) {
      expect(testnetTransactionExplorerUrl(candidate, real)).toBeUndefined();
      expect(renderToStaticMarkup(createElement(IntentCard, { event: candidate, realLedgerReceipt: real }))).not.toContain("testnet.xrpl.org/transactions");
    }
  });
});
