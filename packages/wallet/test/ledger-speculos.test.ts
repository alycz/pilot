import { describe, expect, it } from "vitest";

import { createWallet } from "../src/index.js";

const base = process.env.LEDGER_SPECULOS_URL;
const enabled = process.env.TEST_LEDGER_SPECULOS === "1";

describe.skipIf(!enabled)("Ledger facade against Speculos", () => {
  it("signs the supported owner flows and maps blind-sign refusal", async () => {
    if (base === undefined) {
      throw new Error("LEDGER_SPECULOS_URL is required for the opt-in Ledger check");
    }
    const driverModulePath = "../../../tools/ledger-sim/drive.mjs";
    const { speculos } = await import(driverModulePath);
    const device = speculos(base) as {
      review(target?: "approve" | "reject"): Promise<string[]>;
    };
    const wallet = createWallet({
      provider: "ledger",
      network: "testnet",
      ledger: { transport: "virtual", virtualBaseUrl: base },
    });
    const account = await wallet.connect();
    const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
    const delegate = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
    const hex = (value: string) =>
      Buffer.from(value, "utf8").toString("hex").toUpperCase();
    const sign = async (transaction: Record<string, unknown>) => {
      const [blob] = await Promise.all([
        wallet.signOnly(transaction),
        device.review("approve"),
      ]);
      expect(blob).toMatch(/^[A-F0-9]+$/);
    };

    await sign({
      TransactionType: "AccountSet",
      Account: account,
      Sequence: 0,
      Fee: "0",
      LastLedgerSequence: 0,
      Memos: [{
        Memo: {
          MemoType: hex("pilot-wallet-auth-v1"),
          MemoData: hex("A".repeat(43)),
        },
      }],
    });
    await sign({
      TransactionType: "TrustSet",
      Account: account,
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 99_999_999,
      LimitAmount: {
        currency: "524C555344000000000000000000000000000000",
        issuer,
        value: "1000",
      },
    });
    await sign({
      TransactionType: "OfferCreate",
      Account: account,
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 99_999_999,
      TakerGets: "75000000",
      TakerPays: {
        currency: "524C555344000000000000000000000000000000",
        issuer,
        value: "100",
      },
      Flags: 0x0004_0000,
    });

    const blind = wallet.signOnly({
      TransactionType: "DelegateSet",
      Account: account,
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 99_999_999,
      Authorize: delegate,
      Permissions: [8, 9, 21, 37, 38, 3, 18].map((PermissionValue) => ({
        Permission: { PermissionValue },
      })),
    });
    await Promise.all([device.review("approve"), expect(blind).rejects.toMatchObject({
      code: "LEDGER_BLIND_SIGNING_DISABLED",
    })]);
    await wallet.disconnect();
  }, 120_000);
});
