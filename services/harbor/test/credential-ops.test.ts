import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import type { CredentialLedgerStatus } from "../src/exec/credential-ledger";
import { ops } from "../src/ops/credential";

const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const PAYER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TYPE = "4150344D2D4167656E74";
const ID = "A".repeat(64);
const HASH = "B".repeat(64);

function operation(name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`missing ${name}`);
  return op;
}

function ledgerStatus(
  account: string,
  overrides: Partial<CredentialLedgerStatus> = {},
): CredentialLedgerStatus {
  return {
    account,
    issuer: ISSUER,
    credentialTypeHex: TYPE,
    credentialId: ID,
    accepted: true,
    expired: false,
    ...overrides,
  };
}

function context(
  readStatus: (
    ctx: OpContext,
    account: string,
  ) => Promise<CredentialLedgerStatus | null>,
  submitSelfTransaction = vi.fn(),
) {
  return {
    principal: "pilot",
    credentialServices: {
      demoEnabled: true,
      requiredCredential: { issuer: ISSUER, credentialTypeHex: TYPE },
      payerAddress: PAYER,
      readStatus,
      submitSelfTransaction,
      now: () => new Date("2026-10-21T00:00:00.000Z"),
    },
  };
}

describe("credential operations", () => {
  it("exports exactly the three AP4M credential operations", () => {
    expect(ops.map(({ name }) => name)).toEqual([
      "credential.status",
      "credential.payerAccept",
      "credential.ids",
    ]);
  });

  it("returns a public status and accepted CredentialIDs", async () => {
    const ctx = context(async (_ctx, account) => ledgerStatus(account));

    await expect(
      operation("credential.status").handler(ctx, { account: ACCOUNT }),
    ).resolves.toEqual({
      account: ACCOUNT,
      network: "testnet",
      issuer: ISSUER,
      credential_type_hex: TYPE,
      credential_id: ID,
      accepted: true,
      expired: false,
    });
    await expect(
      operation("credential.ids").handler(ctx, { account: ACCOUNT }),
    ).resolves.toEqual({
      account: ACCOUNT,
      network: "testnet",
      credential_ids: [ID],
    });
  });

  it("does not return an unaccepted or expired CredentialID", async () => {
    const unaccepted = context(async (_ctx, account) =>
      ledgerStatus(account, { accepted: false }),
    );
    const expired = context(async (_ctx, account) =>
      ledgerStatus(account, { expired: true }),
    );
    await expect(
      operation("credential.ids").handler(unaccepted, { account: ACCOUNT }),
    ).resolves.toMatchObject({ credential_ids: [] });
    await expect(
      operation("credential.ids").handler(expired, { account: ACCOUNT }),
    ).resolves.toMatchObject({ credential_ids: [] });
  });

  it("submits only a Harbor-self CredentialAccept from the configured payer", async () => {
    const submit = vi.fn().mockResolvedValue({
      status: "validated",
      hash: HASH,
      engine_result: "tesSUCCESS",
    });
    const ctx = context(
      async (_ctx, account) =>
        ledgerStatus(account, { accepted: false }),
      submit,
    );

    await expect(
      operation("credential.payerAccept").handler(ctx, {}),
    ).resolves.toEqual({
      account: PAYER,
      credential_id: ID,
      status: "validated",
      hash: HASH,
      engine_result: "tesSUCCESS",
    });
    expect(submit).toHaveBeenCalledWith({
      network: "testnet",
      transaction: {
        TransactionType: "CredentialAccept",
        Account: PAYER,
        Issuer: ISSUER,
        CredentialType: TYPE,
      },
    });
  });

  it("is idempotent when the payer credential is already accepted", async () => {
    const submit = vi.fn();
    const ctx = context(
      async (_ctx, account) => ledgerStatus(account),
      submit,
    );
    await expect(
      operation("credential.payerAccept").handler(ctx, {}),
    ).resolves.toEqual({
      account: PAYER,
      credential_id: ID,
      status: "validated",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed when disabled or when a credential does not exist", async () => {
    const disabled = context(async () => null);
    disabled.credentialServices.demoEnabled = false;
    await expect(
      operation("credential.status").handler(disabled, { account: ACCOUNT }),
    ).rejects.toMatchObject({ code: "AP4M_DISABLED" });

    await expect(
      operation("credential.payerAccept").handler(
        context(async () => null),
        {},
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_NOT_ACCEPTABLE" });
  });

  it("rejects unknown arguments before handlers run", () => {
    expect(() =>
      operation("credential.status").args.parse({
        account: ACCOUNT,
        network: "mainnet",
      }),
    ).toThrow();
    expect(() =>
      operation("credential.payerAccept").args.parse({ owner: ACCOUNT }),
    ).toThrow();
  });
});
