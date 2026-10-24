import { describe, expect, it, vi } from "vitest";

import { XrplRpcError } from "../src/adapters/xrpl-rpc";
import {
  CREDENTIAL_ACCEPTED_FLAG,
  normalizeRequiredCredential,
  readCredentialLedgerStatus,
} from "../src/exec/credential-ledger";

const SUBJECT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TYPE = "4150344D2D4167656E74";
const ID = "A".repeat(64);

function context(result: Record<string, unknown>) {
  return {
    principal: "test",
    xrplRpc: { request: vi.fn().mockResolvedValue(result) },
  };
}

describe("AP4M credential ledger reader", () => {
  it("uses the exact Credential selector and reports accepted status", async () => {
    const ctx = context({
      validated: true,
      index: ID,
      node: {
        LedgerEntryType: "Credential",
        Subject: SUBJECT,
        Issuer: ISSUER,
        CredentialType: TYPE,
        Flags: CREDENTIAL_ACCEPTED_FLAG,
        Expiration: 845_942_400,
      },
    });

    await expect(
      readCredentialLedgerStatus(
        ctx,
        SUBJECT,
        { issuer: ISSUER, credentialTypeHex: TYPE.toLowerCase() },
        new Date("2026-10-21T00:00:00.000Z"),
      ),
    ).resolves.toEqual({
      account: SUBJECT,
      issuer: ISSUER,
      credentialTypeHex: TYPE,
      credentialId: ID,
      accepted: true,
      expired: false,
      expiration: "2026-10-22T00:00:00.000Z",
    });

    expect(ctx.xrplRpc.request).toHaveBeenCalledWith(
      "testnet",
      "ledger_entry",
      {
        ledger_index: "validated",
        credential: {
          subject: SUBJECT,
          issuer: ISSUER,
          credential_type: TYPE,
        },
      },
      undefined,
    );
  });

  it("marks an expired credential and treats entryNotFound as absent", async () => {
    await expect(
      readCredentialLedgerStatus(
        context({
          validated: true,
          index: ID,
          node: {
            LedgerEntryType: "Credential",
            Subject: SUBJECT,
            Issuer: ISSUER,
            CredentialType: TYPE,
            Flags: 0,
            Expiration: 845_942_400,
          },
        }),
        SUBJECT,
        { issuer: ISSUER, credentialTypeHex: TYPE },
        new Date("2026-10-23T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ accepted: false, expired: true });

    const missing = {
      principal: "test",
      xrplRpc: {
        request: vi
          .fn()
          .mockRejectedValue(
            new XrplRpcError("not found", "entryNotFound", "soft-empty"),
          ),
      },
    };
    await expect(
      readCredentialLedgerStatus(missing, SUBJECT, {
        issuer: ISSUER,
        credentialTypeHex: TYPE,
      }),
    ).resolves.toBeNull();
  });

  it("rejects malformed configuration and mismatched ledger entries", async () => {
    expect(() =>
      normalizeRequiredCredential({ issuer: ISSUER, credentialTypeHex: "xyz" }),
    ).toThrow(/configuration/i);
    expect(() =>
      normalizeRequiredCredential({
        issuer: "not-an-xrpl-address",
        credentialTypeHex: TYPE,
      }),
    ).toThrow(/configuration/i);

    await expect(
      readCredentialLedgerStatus(
        context({
          validated: true,
          index: ID,
          node: {
            LedgerEntryType: "Credential",
            Subject: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
            Issuer: ISSUER,
            CredentialType: TYPE,
            Flags: 0,
          },
        }),
        SUBJECT,
        { issuer: ISSUER, credentialTypeHex: TYPE },
      ),
    ).rejects.toMatchObject({ code: "XRPL_MALFORMED_RESPONSE" });
  });
});
