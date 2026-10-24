import { describe, expect, it, vi } from "vitest";

import type { OpContext, OpDef } from "../src/catalog/registry";
import { invokeOp } from "../src/guard";
import { ops } from "../src/ops/yield";

const VAULT_ID =
  "9E48171960CD9F62C3A7B6559315A510AE544C3F51E02947B5D4DAC8AA66C3BA";
const VAULT_ACCOUNT = "rQhUcbJoDfvgXr1EkMwarLP5QT3XinEBDg";
const VAULT_OWNER = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";
const SHARE_MPT_ID = "00000001FCE5D5E313303F3D0C700789108CC6BE7D711493";
const ISSUER = "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd";
const AS_OF = "2026-10-18T00:00:00.000Z";

const VAULT_FIXTURE = {
  ledger_index: 3_280_200,
  validated: true,
  vault: {
    Account: VAULT_ACCOUNT,
    Asset: { currency: "XRP" },
    AssetsAvailable: "24000000",
    AssetsMaximum: "1000000000",
    AssetsTotal: "25000000",
    Flags: 0,
    LedgerEntryType: "Vault",
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
  const op = ops.find(({ name }) => name === "yield.options");
  if (!op) throw new Error("Missing yield.options");
  return op;
}

function fixtureContext(options?: {
  pools?: unknown;
  vault?: Record<string, unknown>;
}) {
  const ammPools = vi.fn().mockResolvedValue(
    options?.pools ?? {
      source: "xrpl.to",
      data: [
        {
          id: "pool-1",
          account: "rp9E3FN3gNmvePGhYnf414T2TkUuoxu8vM",
          asset1: { currency: "XRP" },
          asset2: { currency: "USD", issuer: ISSUER },
          tradingFee: 300,
          liquidityXrp: 50_000,
          volume24hXrp: 10_000,
          fees24hXrp: 30,
        },
        {
          id: "pool-without-metrics",
          asset1: { currency: "XRP" },
          asset2: { currency: "TST", issuer: ISSUER },
          tradingFee: 100,
        },
      ],
    },
  );
  const request = vi.fn().mockResolvedValue(options?.vault ?? VAULT_FIXTURE);
  return {
    ammPools,
    request,
    ctx: {
      principal: "yield-fixture-test",
      indexer: { ammPools },
      xrplRpc: { request },
    } as OpContext,
  };
}

describe("yield.options", () => {
  it("declares every fixed caveat for its mixed ledger and registry sources", () => {
    expect(ops.map(({ name }) => name)).toEqual(["yield.options"]);
    expect(operation().caveats).toEqual([
      "devnet-only",
      "off-ledger",
      "amendment-pending",
    ]);
  });

  it("combines fixture-backed AMM, vault, Doppler, and SOIL options", async () => {
    const { ammPools, ctx, request } = fixtureContext();

    const result = await invokeOp(
      operation(),
      ctx,
      {
        amm_limit: 2,
        vault_network: "devnet",
        vault_ids: [VAULT_ID],
      },
      { asOf: AS_OF, asOfBasis: "recorded-fixture" },
    );

    expect(ammPools).toHaveBeenCalledWith({ limit: 2 });
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "vault_info",
      { vault_id: VAULT_ID },
      undefined,
    );
    expect(result).toMatchObject({
      ok: true,
      caveat: ["devnet-only", "off-ledger", "amendment-pending"],
    });
    if (!result.ok) throw new Error("Expected successful fixture response");

    expect(result.data.options.map(({ id }) => id)).toEqual([
      "amm:pool-1",
      "amm:pool-without-metrics",
      `vault:${VAULT_ID}`,
      "registry:doppler-finance",
      "registry:soil",
    ]);

    const availableAmm = result.data.options[0];
    expect(availableAmm).toMatchObject({
      kind: "amm-fees",
      network: "mainnet",
      source: { kind: "indexer", provider: "xrpl.to" },
      rate: {
        annualized: false,
        availability: "available",
        basis: "trailing-24h-volume",
        fee_fraction: 0.003,
        fee_return_ratio: 0.0006,
        formula: "volume24hXrp * feeFraction / tvlXrp",
        period: "24h-input-unannualized",
      },
    });
    expect(result.data.options[1].rate).toMatchObject({
      availability: "unavailable",
    });

    for (const id of [
      `vault:${VAULT_ID}`,
      "registry:doppler-finance",
      "registry:soil",
    ]) {
      expect(result.data.options.find((option) => option.id === id)?.rate).toEqual(
        expect.objectContaining({ availability: "unavailable" }),
      );
    }
    expect(
      result.data.options.find(({ id }) => id === `vault:${VAULT_ID}`),
    ).toMatchObject({
      network: "devnet",
      source: { kind: "xrpl-ledger", provider: "rippled:vault_info" },
      vault: {
        account: VAULT_ACCOUNT,
        owner: VAULT_OWNER,
        vault_id: VAULT_ID,
      },
    });
  });

  it("allows an indexer-only fixture call and never performs an implicit vault read", async () => {
    const { ammPools, ctx, request } = fixtureContext({
      pools: { source: "xrpscan", data: [] },
    });

    const result = await operation().handler(ctx, { amm_limit: 5 });

    expect(ammPools).toHaveBeenCalledWith({ limit: 5 });
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      options: [
        { id: "registry:doppler-finance" },
        { id: "registry:soil" },
      ],
    });
  });

  it("strictly validates limits and coupled vault selectors", () => {
    const schema = operation().args;

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ amm_limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ amm_limit: 101 }).success).toBe(false);
    expect(
      schema.safeParse({
        vault_network: "lending-devnet",
        vault_ids: [VAULT_ID],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ vault_network: "testnet", vault_ids: [VAULT_ID] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ vault_network: "devnet" }).success,
    ).toBe(false);
    expect(schema.safeParse({ vault_ids: [VAULT_ID] }).success).toBe(false);
    expect(
      schema.safeParse({
        vault_network: "devnet",
        vault_ids: [VAULT_ID, VAULT_ID],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("rejects extra indexer claims instead of passing them through", async () => {
    const { ctx } = fixtureContext({
      pools: {
        source: "xrpl.to",
        data: [
          {
            id: "claim-inflated-pool",
            asset1: { currency: "XRP" },
            asset2: { currency: "USD", issuer: ISSUER },
            promisedApr: 99,
          },
        ],
      },
    });

    await expect(operation().handler(ctx, {})).rejects.toThrow();
  });
});
