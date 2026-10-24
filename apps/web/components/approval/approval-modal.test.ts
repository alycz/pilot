import { describe, expect, it } from "vitest";

import {
  ApprovalAttemptGate,
  canAttemptLedgerApproval,
  isApprovalExpired,
  ledgerApprovalActionLabel,
  ledgerApprovalSignerLabel,
  ledgerApprovalNeedsRebuild,
  ledgerExpectedScreens,
  signOnlyAfterPreflight,
} from "./approval-modal";

describe("isApprovalExpired", () => {
  it("refuses approvals at and after expiry", () => {
    const expiry = "2026-10-18T00:10:00.000Z";
    expect(isApprovalExpired(expiry, Date.parse("2026-10-18T00:09:59.999Z"))).toBe(false);
    expect(isApprovalExpired(expiry, Date.parse(expiry))).toBe(true);
    expect(isApprovalExpired(expiry, Date.parse("2026-10-18T00:10:01.000Z"))).toBe(true);
  });

  it("allows requests without an expiry", () => {
    expect(isApprovalExpired(undefined)).toBe(false);
  });

  it("fails closed for a malformed expiry", () => {
    expect(isApprovalExpired("not-a-timestamp")).toBe(true);
  });

  it("runs the freshness gate immediately before signing and blocks signing on failure", async () => {
    const events: string[] = [];
    const request = {
      txJson: { TransactionType: "OfferCreate" },
      summary: { action: "test", amounts: [], feeDrops: "12", network: "testnet" as const },
    };
    const wallet = {
      signOnly: async () => {
        events.push("sign");
        return "signed";
      },
    };

    await expect(signOnlyAfterPreflight(request, wallet, async () => {
      events.push("preflight");
    }, () => {
      events.push("sign-complete");
    })).resolves.toBe("signed");
    expect(events).toEqual(["preflight", "sign", "sign-complete"]);

    await expect(signOnlyAfterPreflight(request, wallet, async () => {
      throw new Error("too few ledgers remain");
    })).rejects.toThrow("too few ledgers remain");
    expect(events).toEqual(["preflight", "sign", "sign-complete"]);

    await expect(signOnlyAfterPreflight(request, wallet, undefined, () => {
      throw new Error("timing sink unavailable");
    })).resolves.toBe("signed");
  });

  it("serializes concurrent approval clicks so sign-only runs once", async () => {
    const gate = new ApprovalAttemptGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let signs = 0;
    const first = gate.run(async () => {
      await blocked;
      signs += 1;
    });
    const second = gate.run(async () => {
      signs += 1;
    });

    await expect(second).resolves.toBeUndefined();
    release();
    await first;
    expect(signs).toBe(1);
  });
});

describe("Ledger approval presentation", () => {
  const expiry = "2026-10-18T00:10:00.000Z";

  it("arms before the approval window and rebuilds below thirty seconds", () => {
    expect(ledgerApprovalNeedsRebuild(expiry, Date.parse("2026-10-18T00:09:30.000Z"))).toBe(false);
    expect(ledgerApprovalNeedsRebuild(expiry, Date.parse("2026-10-18T00:09:30.001Z"))).toBe(true);
    expect(ledgerApprovalNeedsRebuild(expiry, Date.parse(expiry))).toBe(true);
    expect(ledgerApprovalNeedsRebuild("malformed", Date.parse(expiry))).toBe(true);
    expect(ledgerApprovalNeedsRebuild(undefined, Date.parse(expiry))).toBe(false);
  });

  it("uses Ledger-specific labels without changing other wallets", () => {
    expect(ledgerApprovalActionLabel({ expiresAt: expiry, now: Date.parse("2026-10-18T00:09:00.000Z"), ledger: true })).toBe("Approve on Ledger");
    expect(ledgerApprovalActionLabel({ expiresAt: expiry, now: Date.parse("2026-10-18T00:09:45.000Z"), ledger: true })).toBe("Rebuild and approve");
    expect(ledgerApprovalActionLabel({ expiresAt: expiry, now: Date.parse(expiry), ledger: false })).toBe("Sign only");
  });

  it.each([
    ["webhid", "Signed via Ledger transport · account 1"],
    ["virtual", "Signed via Virtual Ledger (Speculos) · account 1"],
    [undefined, "Signed through configured Ledger flow · account 1"],
  ] as const)("labels %s signing provenance truthfully", (transport, expected) => {
    expect(ledgerApprovalSignerLabel({ accountIndex: 1, transport })).toBe(expected);
  });

  it("keeps signing disabled until the device and a required rebuild are armed", () => {
    expect(canAttemptLedgerApproval({ busy: false, deviceReady: false, needsRebuild: false, hasRebuildHandler: false })).toBe(false);
    expect(canAttemptLedgerApproval({ busy: true, deviceReady: true, needsRebuild: false, hasRebuildHandler: false })).toBe(false);
    expect(canAttemptLedgerApproval({ busy: false, deviceReady: true, needsRebuild: true, hasRebuildHandler: false })).toBe(false);
    expect(canAttemptLedgerApproval({ busy: false, deviceReady: true, needsRebuild: true, hasRebuildHandler: true })).toBe(true);
    expect(canAttemptLedgerApproval({ busy: false, deviceReady: true, needsRebuild: false, hasRebuildHandler: false })).toBe(true);
  });

  it("builds bounded clear-sign screen copy from the validated summary", () => {
    expect(ledgerExpectedScreens({
      txJson: { TransactionType: "OfferCreate", Flags: 0x00080000 },
      summary: {
        action: "Create Offer",
        amounts: ["Sell 20 RLUSD", "Buy XRP"],
        feeDrops: "12",
        network: "testnet",
      },
    })).toEqual([
      "Type OfferCreate",
      "Create Offer",
      "Sell 20 RLUSD",
      "Buy XRP",
      "Flags 524288",
      "Fee 12 drops",
    ]);
  });
});
