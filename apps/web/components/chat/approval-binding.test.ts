import type { CardEvent } from "@pilot/contracts";
import { describe, expect, it } from "vitest";

import { bindApprovalTransaction } from "./approval-binding";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD = "524C555344000000000000000000000000000000";
const HASH = "A".repeat(64);

function swapEvent(overrides: Record<string, unknown> = {}): CardEvent {
  const semantic = {
    TransactionType: "OfferCreate",
    Account: ACCOUNT,
    TakerGets: { currency: RLUSD, issuer: ISSUER, value: "50" },
    TakerPays: "97000000",
    Flags: 0x000c_0000,
  };
  const approvalTx = { ...semantic, Fee: "12", Sequence: 10, LastLedgerSequence: 120, ...overrides };
  return {
    intent_id: "swap-approval",
    state: "awaiting_approval",
    at: "2026-10-18T00:00:00.000Z",
    intent: {
      id: "swap-approval",
      network: "testnet",
      kind: "swap",
      sell: { currency: "RLUSD", issuer: ISSUER },
      buy: { currency: "XRP" },
      amount: "50",
      side: "sell",
      max_slippage_bps: 100,
    },
    build: {
      build_id: "build-swap",
      network: "testnet",
      tx_json: { ...semantic, Fee: "10", Sequence: 9, LastLedgerSequence: 115 },
      delegable: true,
      simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: false },
      preflight: [{ check: "schema", pass: true }],
      summary: { action: "untrusted", account: ACCOUNT, amounts: ["wrong"], fee_drops: "99", reserve_delta_drops: "0" },
    },
    exec: {
      status: "needs_approval",
      approval_id: "approval-1",
      tx_json: approvalTx,
      expires_at: "2099-01-01T00:00:00.000Z",
      policy: { verdict: "needs_approval", reasons: [] },
    },
  };
}

describe("chat approval transaction binding", () => {
  it("derives displayed terms from the exact approval transaction", () => {
    expect(bindApprovalTransaction(swapEvent(), ACCOUNT, 100, 10, 0)).toMatchObject({
      approvalId: "approval-1",
      summary: {
        action: "Swap RLUSD for XRP",
        amounts: [`50 ${RLUSD}`, "97 XRP"],
        feeDrops: "12",
        network: "testnet",
      },
    });
  });

  it("allows only refreshed autofill fields within the safe ledger window", () => {
    const bound = bindApprovalTransaction(swapEvent({ Fee: "13", Sequence: 11, LastLedgerSequence: 125 }), ACCOUNT, 100, 11, 0);
    expect(bound.txJson).toMatchObject({ Fee: "13", Sequence: 11, LastLedgerSequence: 125 });
  });

  it.each([
    ["different amount", { TakerGets: { currency: RLUSD, issuer: ISSUER, value: "51" } }],
    ["different flags", { Flags: 0x0002_0000 }],
    ["excess fee", { Fee: "101" }],
    ["expired ledger window", { LastLedgerSequence: 100 }],
    ["stale account sequence", { Sequence: 11 }],
    ["unknown field", { Destination: ACCOUNT }],
    ["counter-asset drift", { TakerPays: { currency: "USD", issuer: ISSUER, value: "97" } }],
    ["source tag drift", { SourceTag: 99 }],
    ["memo drift", { Memos: [{ Memo: { MemoData: "626164" } }] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => bindApprovalTransaction(swapEvent(overrides), ACCOUNT, 100, 10, 0)).toThrow();
  });

  it("fails closed for malformed expiry metadata", () => {
    const event = swapEvent();
    if (event.exec?.status !== "needs_approval") throw new Error("fixture mismatch");
    event.exec.expires_at = "not-a-timestamp";
    expect(() => bindApprovalTransaction(event, ACCOUNT, 100, 10, 0)).toThrow(/expired/i);
  });

  it.each([
    ["failed simulation", { simulate: { engine_result: "tecUNFUNDED_OFFER", engine_result_message: "no", applied: false } }],
    ["applied simulation", { simulate: { engine_result: "tesSUCCESS", engine_result_message: "bad", applied: true } }],
    ["failed preflight", { preflight: [{ check: "policy", pass: false }] }],
  ])("rejects a %s", (_label, buildOverride) => {
    const event = swapEvent();
    if (!event.build) throw new Error("fixture mismatch");
    event.build = { ...event.build, ...buildOverride } as unknown as NonNullable<CardEvent["build"]>;
    expect(() => bindApprovalTransaction(event, ACCOUNT, 100, 10, 0)).toThrow(/simulation|preflight/i);
  });

  it("binds a Devnet vault deposit to its exact vault and XRP amount", () => {
    const transaction = {
      TransactionType: "VaultDeposit",
      Account: ACCOUNT,
      VaultID: HASH,
      Amount: "100000000",
      Fee: "12",
      Sequence: 10,
      LastLedgerSequence: 120,
    };
    const event: CardEvent = {
      intent_id: "vault-approval",
      state: "awaiting_approval",
      at: "2026-10-18T00:00:00.000Z",
      intent: { id: "vault-approval", network: "devnet", kind: "vault_deposit", vault_id: HASH, asset: { currency: "XRP" }, amount: "100" },
      build: {
        build_id: "build-vault",
        network: "devnet",
        tx_json: transaction,
        delegable: false,
        simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: false },
        preflight: [{ check: "schema", pass: true }],
        summary: { action: "wrong", account: ACCOUNT, amounts: [], fee_drops: "1", reserve_delta_drops: "0" },
      },
      exec: { status: "needs_approval", approval_id: "approval-vault", tx_json: transaction, expires_at: "2099-01-01T00:00:00.000Z", policy: { verdict: "needs_approval", reasons: [] } },
    };
    expect(bindApprovalTransaction(event, ACCOUNT, 100, 10, 0).summary).toEqual({
      action: "Deposit into XRPL vault",
      amounts: ["100 XRP"],
      destination: HASH,
      feeDrops: "12",
      network: "devnet",
    });
  });
});
