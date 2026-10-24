import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MandateApprovalCard } from "./mandate-approval-card";
import { MandateBuilder } from "./mandate-builder";
import { MandateSummary } from "./mandate-summary";
import { validateMandateDraft, type MandateDraft } from "./types";

const payees = [
  { id: "venue-yield-desk", name: "Venue Yield Desk" },
  { id: "risk-oracle", name: "Risk Oracle" },
] as const;
const draft: MandateDraft = {
  perPaymentMaxUsd: "5.00",
  dailyMaxUsd: "10.00",
  totalMaxUsd: "25.00",
  payees: payees.map(({ id }) => id),
  expiresAt: "2026-10-22T18:00",
};
const channels = payees.map((payee) => ({
  merchantId: payee.id,
  merchantName: payee.name,
  amountDrops: "50000",
  lockedUntil: "2026-10-23T18:00:00.000Z",
}));

function findButton(node: ReactNode, label: string): ReactElement<{ onClick?: () => void }> | undefined {
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (element.type === "button" && renderToStaticMarkup(element).includes(label)) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return undefined;
}

describe("AP4M mandate UI", () => {
  it("renders bounded editable fields without sensitive credential inputs", () => {
    const markup = renderToStaticMarkup(createElement(MandateBuilder, {
      availablePayees: payees,
      maximumTotalUsd: "25.00",
      onChange: vi.fn(),
      value: draft,
    }));
    for (const label of ["Per payment", "Per day", "Total", "Allowed merchants", "Mandate expiry", "XRPL Testnet"]) {
      expect(markup).toContain(label);
    }
    expect(markup).not.toMatch(/sd-jwt|private.?key|customer_ref|credential/i);
  });

  it("shows every limit, merchant, lock, mandatory label, and one explicit Batch approval", () => {
    const approve = vi.fn();
    const element = MandateApprovalCard({
      channels,
      draft,
      onApprove: approve,
      payees,
      promptCount: 1,
      signingMode: "batch",
    });
    const markup = renderToStaticMarkup(element);
    for (const label of ["$5.00", "$10.00", "$25.00", "Venue Yield Desk", "Risk Oracle", "locked until", "expiry plus one day", "XRPL Testnet", "one sign-only prompt"]) {
      expect(markup).toContain(label);
    }
    const button = findButton(element, "Approve once in wallet");
    expect(button?.props.onClick).toBe(approve);
    button?.props.onClick?.();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("explains sequential prompts and terminal cancellation before explicit approval", () => {
    const markup = renderToStaticMarkup(createElement(MandateApprovalCard, {
      channels,
      draft,
      onApprove: vi.fn(),
      payees,
      promptCount: 3,
      signingMode: "sequential",
    }));
    expect(markup).toContain("Approve 3 transactions in wallet");
    expect(markup).toContain("selected before signing");
    expect(markup).toContain("will not retry automatically");
  });

  it("validates exact cents, hierarchy, proposal ceiling, payees, and future expiry", () => {
    const options = {
      maximumTotalUsd: "25.00",
      availablePayeeIds: payees.map(({ id }) => id),
      now: new Date("2026-10-21T18:00:00.000Z"),
    };
    expect(validateMandateDraft(draft, options)).toEqual(draft);
    expect(() => validateMandateDraft({ ...draft, totalMaxUsd: "25.001" }, options)).toThrow(/exact USD/);
    expect(() => validateMandateDraft({ ...draft, perPaymentMaxUsd: "11" }, options)).toThrow(/per-payment/);
    expect(() => validateMandateDraft({ ...draft, totalMaxUsd: "26" }, options)).toThrow(/proposal/);
    expect(() => validateMandateDraft({ ...draft, payees: ["unknown"] }, options)).toThrow(/unknown merchant/);
    expect(() => validateMandateDraft({ ...draft, expiresAt: "2026-10-20T18:00" }, options)).toThrow(/future/);
  });

  it("renders the active result without raw intent presentations", () => {
    const markup = renderToStaticMarkup(createElement(MandateSummary, {
      draft,
      mandateId: "mandate-1",
      payees,
      setupTransactionHashes: ["a".repeat(64)],
    }));
    expect(markup).toContain("ACTIVE · XRPL Testnet");
    expect(markup).toContain("Demo Network — Mastercard&#x27;s role in production");
    expect(markup).toContain("Verifiable Intent v0.1 · verified with Mastercard&#x27;s reference implementation");
    expect(markup).not.toMatch(/eyJ[A-Za-z0-9_-]+|private.?jwk/i);
  });
});
