import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DemoApprovalDialog, matchesRecordedOfferCreate } from "./demo-approval-dialog";
import { fixtureEvent } from "../../app/chat/fixtures";

const recordedTx = {
  TransactionType: "OfferCreate",
  Account: "ra7Zr8ddy9tB88RaXL8B87YkqhEJG2vkAJ",
  Flags: 0x0004_0000,
  TakerPays: {
    currency: "RLUSD",
    issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    value: "100",
  },
  TakerGets: "75000000",
  Fee: "12",
};
const fixture = fixtureEvent("awaiting_approval");
const event = {
  ...fixture,
  build: fixture.build ? { ...fixture.build, tx_json: recordedTx } : undefined,
  exec: fixture.exec?.status === "needs_approval"
    ? { ...fixture.exec, tx_json: recordedTx }
    : fixture.exec,
};

describe("DemoApprovalDialog Ledger replay", () => {
  it("requires the recorded Simulated Ledger flow instead of a fake sign button", () => {
    const markup = renderToStaticMarkup(createElement(DemoApprovalDialog, {
      event,
      reducedMotion: true,
      onClose: vi.fn(),
      onSubmitted: vi.fn(),
      onValidated: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Simulated Ledger"');
    expect(markup).toContain("Approve an owner-signed offer");
    expect(markup).toContain("Recorded demo · no signing");
    expect(markup).not.toContain("Sign (simulated)");
  });

  it("fails closed instead of replaying OfferCreate screens for another transaction type", () => {
    const vaultEvent = fixtureEvent("awaiting_approval", {
      id: "demo-ledger-vault",
      network: "devnet",
      kind: "vault_deposit",
      vault_id: "A".repeat(64),
      asset: { currency: "XRP" },
      amount: "100",
    });
    const markup = renderToStaticMarkup(createElement(DemoApprovalDialog, {
      event: vaultEvent,
      reducedMotion: true,
      onClose: vi.fn(),
      onSubmitted: vi.fn(),
      onValidated: vi.fn(),
    }));

    expect(markup).toContain("recorded device replay is not available");
    expect(markup).not.toContain('aria-label="Simulated Ledger"');
    expect(markup).not.toContain("Approve an owner-signed offer");
  });

  it("requires every bounded field shown by the recorded OfferCreate transcript", () => {
    expect(matchesRecordedOfferCreate(recordedTx)).toBe(true);
    expect(matchesRecordedOfferCreate({ ...recordedTx, Account: "rPT7vGmYxnV6wNP9RC2Mm3Fp9NBH3bK" })).toBe(false);
    expect(matchesRecordedOfferCreate({ ...recordedTx, TakerGets: "75000001" })).toBe(false);
    expect(matchesRecordedOfferCreate({ ...recordedTx, Sequence: 7 })).toBe(false);
    expect(matchesRecordedOfferCreate({ ...recordedTx, TakerPays: { ...recordedTx.TakerPays, value: "101" } })).toBe(false);
  });
});
