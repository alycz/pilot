import { describe, expect, it } from "vitest";

import { ledgerSigningMode } from "../src/ledger/clear-sign.js";
import {
  LEDGER_PERMISSION_LEGEND,
  ledgerPermission,
} from "../src/ledger/permissions.js";

const CLEAR_TYPES = [
  "Payment",
  "EscrowCreate",
  "EscrowFinish",
  "EscrowCancel",
  "AccountSet",
  "SetRegularKey",
  "OfferCreate",
  "OfferCancel",
  "TicketCreate",
  "SignerListSet",
  "PaymentChannelCreate",
  "PaymentChannelFund",
  "PaymentChannelClaim",
  "CheckCreate",
  "CheckCash",
  "CheckCancel",
  "DepositPreauth",
  "TrustSet",
  "AccountDelete",
  "NFTokenMint",
  "NFTokenBurn",
  "NFTokenCreateOffer",
  "NFTokenCancelOffer",
  "NFTokenAcceptOffer",
  "Clawback",
  "AMMCreate",
  "AMMDeposit",
  "AMMWithdraw",
  "AMMVote",
  "AMMBid",
  "AMMDelete",
] as const;

describe("Ledger clear-sign classification", () => {
  it.each(CLEAR_TYPES)("classifies XRP app 2.8.2 %s as clear", (type) => {
    expect(ledgerSigningMode({ TransactionType: type })).toBe("clear");
  });

  it.each([
    "DelegateSet",
    "VaultCreate",
    "VaultSet",
    "VaultDelete",
    "VaultDeposit",
    "VaultWithdraw",
    "VaultClawback",
    "LoanSet",
    "FutureTransaction",
  ])("classifies %s as blind", (type) => {
    expect(ledgerSigningMode({ TransactionType: type })).toBe("blind");
  });

  it("allows known flags and fails closed on unknown bits", () => {
    expect(
      ledgerSigningMode({ TransactionType: "OfferCreate", Flags: 0x0004_0000 }),
    ).toBe("clear");
    expect(
      ledgerSigningMode({ TransactionType: "OfferCreate", Flags: 0x20 }),
    ).toBe("blind");
  });

  it.each([
    ["PaymentChannelClaim", 0x0001_0000],
    ["PaymentChannelClaim", 0x0002_0000],
    ["NFTokenMint", 0x0000_0010],
    ["AMMDeposit", 0x0080_0000],
    ["AMMWithdraw", 0x0040_0000],
  ])("allows XRP app 2.8.2 %s flag 0x%s", (type, flags) => {
    expect(ledgerSigningMode({ TransactionType: type, Flags: flags })).toBe(
      "clear",
    );
  });

  it.each([-1, 0x1_0000_0000, Number.MAX_SAFE_INTEGER])(
    "fails closed on out-of-uint32 Flags %s",
    (flags) => {
      expect(ledgerSigningMode({ TransactionType: "Payment", Flags: flags }))
        .toBe("blind");
    },
  );
});

describe("Ledger permission legend", () => {
  it("matches the seven onboarding permission values", () => {
    expect(LEDGER_PERMISSION_LEGEND.map((entry) => entry.permissionValue)).toEqual([
      8, 9, 21, 37, 38, 3, 18,
    ]);
    expect(ledgerPermission(8)).toMatchObject({ transactionType: "OfferCreate" });
    expect(ledgerPermission(999)).toBeUndefined();
  });
});
