import { describe, expect, it } from "vitest";

import {
  assertHarborSelfCredentialTransaction,
  buildHarborSelfCredentialAccept,
  HARBOR_SELF_TRANSACTION_ALLOWLIST,
} from "../src/exec/credential-self";

const PAYER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TYPE = "4150344D2D4167656E74";

describe("Harbor-self credential transaction boundary", () => {
  it("allows only CredentialAccept for the exact Harbor payer", () => {
    expect(HARBOR_SELF_TRANSACTION_ALLOWLIST).toEqual(["CredentialAccept"]);
    const transaction = buildHarborSelfCredentialAccept(PAYER, {
      issuer: ISSUER,
      credentialTypeHex: TYPE,
    });
    expect(transaction).toEqual({
      TransactionType: "CredentialAccept",
      Account: PAYER,
      Issuer: ISSUER,
      CredentialType: TYPE,
    });
    expect(() =>
      assertHarborSelfCredentialTransaction(transaction, PAYER),
    ).not.toThrow();
  });

  it("rejects owner delegation, payments, and a different payer", () => {
    expect(() =>
      assertHarborSelfCredentialTransaction(
        {
          ...buildHarborSelfCredentialAccept(PAYER, {
            issuer: ISSUER,
            credentialTypeHex: TYPE,
          }),
          Delegate: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        },
        PAYER,
      ),
    ).toThrow(/not allowed/i);
    expect(() =>
      assertHarborSelfCredentialTransaction(
        { TransactionType: "Payment", Account: PAYER },
        PAYER,
      ),
    ).toThrow(/not allowed/i);
    expect(() =>
      assertHarborSelfCredentialTransaction(
        buildHarborSelfCredentialAccept(PAYER, {
          issuer: ISSUER,
          credentialTypeHex: TYPE,
        }),
        "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      ),
    ).toThrow(/not allowed/i);
  });
});
