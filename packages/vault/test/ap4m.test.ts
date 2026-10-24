import type { Ap4mReceipt, McIntent } from "@pilot/contracts";
import matter from "gray-matter";
import { describe, expect, it, vi } from "vitest";

import {
  resolveActiveAp4mMandate,
  writeAp4mMandateNote,
  writeAp4mReceiptNote,
  type Ap4mMandateSnapshotSource,
} from "../src/ap4m";

const hash = (character: string) => character.repeat(64);
const OWNER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const OTHER_OWNER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

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
  amount: {
    asset: { kind: "iou", currency: "RLUSD", issuer: "rDemoIssuer" },
    value: "1",
  },
  proof: { tx_hash: hash("c") },
  merchant_validation: {
    intentId: intent.intentId,
    validated: true,
    checks: {
      agent_identity: "pass",
      intent: "pass",
      credential: "pass",
      payment: "pass",
    },
    validation_errors: [],
  },
  settlement: "validated",
  at: "2026-10-21T17:00:00.000Z",
};

function mandateNote(
  mandateId: string,
  overrides: Partial<Parameters<typeof writeAp4mMandateNote>[0]> = {},
) {
  return writeAp4mMandateNote({
    mandate_id: mandateId,
    network: "testnet",
    status: "ACTIVE",
    execution_type: "DEFERRED",
    not_before: "2026-10-21T16:00:00.000Z",
    expires_at: "2026-10-22T16:00:00.000Z",
    constraints: {
      currency: "USD",
      per_payment_max: "5",
      daily_max: "10",
      total_max: "25",
      payees: ["venue-yield-desk"],
      skus: ["yield-report"],
    },
    l1_digest: hash("d"),
    l2_digest: hash("e"),
    setup_tx_hashes: [hash("f")],
    channels: [],
    open_finance: {
      label: "Mastercard Open Finance · mock",
      mode: "mock",
      owner_name_hash: hash("2"),
    },
    recorded_at: "2026-10-21T17:01:00.000Z",
    ...overrides,
  });
}

function mandateSnapshot(files: Record<string, string>): Ap4mMandateSnapshotSource {
  return {
    openReadSnapshot: async (options = {}) => {
      const captured = Object.entries(files)
        .filter(([path]) => !options.prefix || path.startsWith(`${options.prefix}/`))
        .filter(([path]) => !options.suffix || path.endsWith(options.suffix))
        .slice(0, options.maxEntries ?? Number.MAX_SAFE_INTEGER);
      return {
        revision: "mandates-1",
        list: async (prefix = "") => captured
          .filter(([path]) => !prefix || path.startsWith(`${prefix}/`))
          .map(([path, content]) => ({ path, size: Buffer.byteLength(content, "utf8") })),
        read: async (path: string, maxBytes: number) => {
          const content = captured.find(([candidate]) => candidate === path)?.[1] ?? null;
          if (content !== null && Buffer.byteLength(content, "utf8") > maxBytes) {
            throw new Error("bounded read exceeded");
          }
          return content;
        },
      };
    },
  };
}

function scopedMandatePath(owner: string, mandateId: string): string {
  return `Pilot/Scopes/testnet/${owner}/Mandates/${mandateId}.md`;
}

describe("AP4M vault notes", () => {
  it("resolves exactly one current ACTIVE mandate from the wallet scope", async () => {
    const note = mandateNote("mandate-active");
    await expect(resolveActiveAp4mMandate(
      mandateSnapshot({ [scopedMandatePath(OWNER, "mandate-active")]: note.content }),
      { owner: OWNER, network: "testnet" },
      new Date("2026-10-21T17:30:00.000Z"),
    )).resolves.toEqual({ mandate_id: "mandate-active", owner: OWNER });
  });

  it("returns no authority for zero active, expired, or another wallet's mandates", async () => {
    const expired = mandateNote("mandate-expired", {
      not_before: "2026-10-20T16:00:00.000Z",
      expires_at: "2026-10-21T16:00:00.000Z",
    });
    const source = mandateSnapshot({
      [scopedMandatePath(OWNER, "mandate-expired")]: expired.content,
      [scopedMandatePath(OTHER_OWNER, "mandate-other")]: mandateNote("mandate-other").content,
    });

    await expect(resolveActiveAp4mMandate(
      source,
      { owner: OWNER, network: "testnet" },
      new Date("2026-10-21T17:30:00.000Z"),
    )).resolves.toBeUndefined();
    await expect(resolveActiveAp4mMandate(
      source,
      { owner: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", network: "testnet" },
      new Date("2026-10-21T17:30:00.000Z"),
    )).resolves.toBeUndefined();
  });

  it("fails closed on multiple active or malformed mandate notes", async () => {
    const first = mandateNote("mandate-a");
    const second = mandateNote("mandate-b");
    await expect(resolveActiveAp4mMandate(
      mandateSnapshot({
        [scopedMandatePath(OWNER, "mandate-a")]: first.content,
        [scopedMandatePath(OWNER, "mandate-b")]: second.content,
      }),
      { owner: OWNER, network: "testnet" },
      new Date("2026-10-21T17:30:00.000Z"),
    )).rejects.toThrow(/multiple active mandates/);

    await expect(resolveActiveAp4mMandate(
      mandateSnapshot({
        [scopedMandatePath(OWNER, "mandate-broken")]: "---\ntype: ap4m_mandate\nstatus: ACTIVE\n---\n",
      }),
      { owner: OWNER, network: "testnet" },
      new Date("2026-10-21T17:30:00.000Z"),
    )).rejects.toThrow();

    const dotName = mandateNote("mandate-dot").content.replace(
      "mandate_id: mandate-dot",
      "mandate_id: .",
    );
    await expect(resolveActiveAp4mMandate(
      mandateSnapshot({ [scopedMandatePath(OWNER, ".")]: dotName }),
      { owner: OWNER, network: "testnet" },
      new Date("2026-10-21T17:30:00.000Z"),
    )).rejects.toThrow();
  });

  it("never scans a non-Testnet mandate scope", async () => {
    const source = { openReadSnapshot: vi.fn() } as unknown as Ap4mMandateSnapshotSource;
    await expect(resolveActiveAp4mMandate(
      source,
      { owner: OWNER, network: "devnet" },
    )).resolves.toBeUndefined();
    expect(source.openReadSnapshot).not.toHaveBeenCalled();
  });

  it("writes a frontmatter-only mandate note with masked Open Finance evidence", () => {
    const note = writeAp4mMandateNote({
      mandate_id: "mandate-1",
      network: "testnet",
      status: "ACTIVE",
      execution_type: "DEFERRED",
      not_before: "2026-10-21T16:00:00.000Z",
      expires_at: "2026-10-22T16:00:00.000Z",
      constraints: {
        currency: "USD",
        per_payment_max: "5",
        daily_max: "10",
        total_max: "25",
        payees: ["venue-yield-desk", "risk-oracle"],
        skus: ["yield-report", "risk-score"],
      },
      l1_digest: hash("d"),
      l2_digest: hash("e"),
      setup_tx_hashes: [hash("f")],
      channels: [
        {
          merchant_id: "venue-yield-desk",
          channel_id: hash("1"),
          amount_drops: "50000",
        },
      ],
      open_finance: {
        label: "Mastercard Open Finance · mock",
        mode: "mock",
        owner_name_hash: hash("2"),
        masked_account_label: "FinBank checking · •••• 4242",
        balance_snapshot: { amount: "1000.50", currency: "USD" },
      },
      recorded_at: "2026-10-21T17:01:00.000Z",
    });

    expect(note.path).toBe("Pilot/Mandates/mandate-1.md");
    const parsed = matter(note.content);
    expect(parsed.content.trim()).toBe("");
    expect(parsed.data).toMatchObject({
      type: "ap4m_mandate",
      network: "testnet",
      execution_type: "DEFERRED",
      open_finance: {
        label: "Mastercard Open Finance · mock",
        mode: "mock",
        owner_name_hash: hash("2").toUpperCase(),
      },
    });
    expect(note.content).not.toMatch(/customer|credential|presentation|private|seed|mnemonic/i);
  });

  it("rejects an unmasked Open Finance account label", () => {
    expect(() =>
      writeAp4mMandateNote({
        mandate_id: "mandate-1",
        network: "testnet",
        status: "ACTIVE",
        execution_type: "DEFERRED",
        not_before: "2026-10-21T16:00:00.000Z",
        expires_at: "2026-10-22T16:00:00.000Z",
        constraints: {
          currency: "USD",
          per_payment_max: "5",
          daily_max: "10",
          total_max: "25",
          payees: ["venue-yield-desk"],
        },
        l1_digest: hash("d"),
        l2_digest: hash("e"),
        setup_tx_hashes: [hash("f")],
        channels: [],
        open_finance: {
          label: "Mastercard Open Finance · mock",
          mode: "mock",
          owner_name_hash: hash("2"),
          masked_account_label: "Ada Lovelace checking 4242",
        },
        recorded_at: "2026-10-21T17:01:00.000Z",
      }),
    ).toThrow(/masking marker/);
  });

  it("writes a strict frontmatter-only receipt with intent and validation evidence", () => {
    const note = writeAp4mReceiptNote({
      receipt,
      intent,
      recorded_at: "2026-10-21T17:01:00.000Z",
    });

    expect(note.path).toBe("Pilot/Receipts/receipt-1.md");
    const parsed = matter(note.content);
    expect(parsed.content.trim()).toBe("");
    expect(parsed.data).toMatchObject({
      type: "ap4m_receipt",
      receipt_id: "receipt-1",
      intent: { intentId: intent.intentId },
      evidence: {
        l3a_digest: hash("a").toUpperCase(),
        l3b_digest: hash("b").toUpperCase(),
        proof: { tx_hash: hash("c").toUpperCase() },
        merchant_validation: { validated: true },
        explorer: `https://testnet.xrpl.org/transactions/${hash("c").toUpperCase()}`,
      },
    });
    expect(note.content).not.toMatch(/tx_blob|credential_ids|sd-jwt|private|seed|mnemonic/i);
  });

  it("fails closed for raw-path identifiers, mismatched intent, and non-Testnet explorer links", () => {
    expect(() =>
      writeAp4mReceiptNote({ ...{ receipt, intent }, recorded_at: "2026-10-21T17:01:00.000Z", explorer_url: "https://evil.example/tx" }),
    ).toThrow(/Testnet explorer/);
    expect(() =>
      writeAp4mReceiptNote({
        receipt: { ...receipt, receipt_id: "../outside" },
        intent,
        recorded_at: "2026-10-21T17:01:00.000Z",
      }),
    ).toThrow(/receipt id/i);
    expect(() =>
      writeAp4mReceiptNote({
        receipt,
        intent: { ...intent, intentId: "demo-intent-other" },
        recorded_at: "2026-10-21T17:01:00.000Z",
      }),
    ).toThrow(/must match/);
  });
});
