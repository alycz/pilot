import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import { invokeOp } from "../src/guard";
import { ops } from "../src/ops/vault";

const VAULT_ID =
  "9E48171960CD9F62C3A7B6559315A510AE544C3F51E02947B5D4DAC8AA66C3BA";
const VAULT_ACCOUNT = "rQhUcbJoDfvgXr1EkMwarLP5QT3XinEBDg";
const VAULT_OWNER = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";
const SHARE_MPT_ID = "00000001FCE5D5E313303F3D0C700789108CC6BE7D711493";
const AS_OF = "2026-10-18T00:00:00.000Z";

// Recorded from the official vault_info response shape:
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/vault-methods/vault_info#response-format
const VAULT_INFO_FIXTURE = {
  ledger_index: 3_280_200,
  validated: true,
  vault: {
    Account: VAULT_ACCOUNT,
    Asset: { currency: "XRP" },
    AssetsAvailable: "24000000",
    AssetsMaximum: "1000000000",
    AssetsTotal: "25000000",
    Data: "50726976617465207661756C74",
    Flags: 65_536,
    LedgerEntryType: "Vault",
    LEVersion: 1,
    LossUnrealized: "1000000",
    Owner: VAULT_OWNER,
    OwnerNode: "0",
    PreviousTxnID: "F".repeat(64),
    PreviousTxnLgrSeq: 3_113_735,
    Scale: 0,
    Sequence: 3_113_728,
    ShareMPTID: SHARE_MPT_ID,
    WithdrawalPolicy: 1,
    index: VAULT_ID,
    shares: {
      Flags: 60,
      Issuer: VAULT_ACCOUNT,
      LedgerEntryType: "MPTokenIssuance",
      OutstandingAmount: "25000000",
      OwnerNode: "0",
      PreviousTxnID: "F".repeat(64),
      PreviousTxnLgrSeq: 3_113_735,
      Sequence: 1,
      index: "A".repeat(64),
      mpt_issuance_id: SHARE_MPT_ID,
    },
  },
};

function operation(): OpDef {
  const op = ops.find(({ name }) => name === "vault.info");
  if (!op) throw new Error("Missing vault.info");
  return op;
}

function fixtureContext(request: ReturnType<typeof vi.fn>): OpContext {
  return {
    principal: "vault-fixture-test",
    xrplRpc: { request },
  };
}

describe("vault.info", () => {
  it("declares the fixed amendment-gated devnet caveats", () => {
    expect(ops.map(({ name }) => name)).toEqual(["vault.info"]);
    expect(operation().caveats).toEqual([
      "devnet-only",
      "amendment-pending",
    ]);
  });

  it("reads a vault by ID through the injected XRPL adapter and surfaces risks", async () => {
    const request = vi.fn().mockResolvedValue(VAULT_INFO_FIXTURE);

    const result = await invokeOp(
      operation(),
      fixtureContext(request),
      { network: "devnet", vault_id: VAULT_ID },
      { asOf: AS_OF, asOfBasis: "recorded-fixture" },
    );

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "vault_info",
      { vault_id: VAULT_ID },
      undefined,
    );
    expect(result).toMatchObject({
      ok: true,
      caveat: ["devnet-only", "amendment-pending"],
      data: {
        network: "devnet",
        ...VAULT_INFO_FIXTURE,
      },
    });
    if (!result.ok) throw new Error("Expected successful fixture response");
    expect(result.data.risks).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not a fixed-interest promise/i),
        expect.stringMatching(/verify the vault owner/i),
      ]),
    );
  });

  it("supports the official owner and sequence selector", async () => {
    const request = vi.fn().mockResolvedValue(VAULT_INFO_FIXTURE);

    await operation().handler(fixtureContext(request), {
      network: "lending-devnet",
      owner: VAULT_OWNER,
      seq: 3_113_728,
    });

    expect(request).toHaveBeenCalledWith(
      "lending-devnet",
      "vault_info",
      { owner: VAULT_OWNER, seq: 3_113_728 },
      undefined,
    );
  });

  it("strictly rejects unsupported networks, invalid selectors, and extra keys", () => {
    const schema = operation().args;

    expect(
      schema.safeParse({ network: "devnet", vault_id: VAULT_ID }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        network: "lending-devnet",
        owner: VAULT_OWNER,
        seq: 1,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ network: "testnet", vault_id: VAULT_ID }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ network: "mainnet", vault_id: VAULT_ID }).success,
    ).toBe(false);
    expect(schema.safeParse({ network: "devnet" }).success).toBe(false);
    expect(
      schema.safeParse({ network: "devnet", owner: VAULT_OWNER }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        network: "devnet",
        vault_id: VAULT_ID,
        owner: VAULT_OWNER,
        seq: 1,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        network: "devnet",
        vault_id: VAULT_ID,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed or claim-inflated XRPL fixtures", async () => {
    const request = vi.fn().mockResolvedValue({
      ...VAULT_INFO_FIXTURE,
      vault: {
        ...VAULT_INFO_FIXTURE.vault,
        promisedApr: 42,
      },
    });

    await expect(
      operation().handler(fixtureContext(request), {
        network: "devnet",
        vault_id: VAULT_ID,
      }),
    ).rejects.toThrow();
  });
});
