import { describe, expect, it, vi } from "vitest";

import type { Indexer } from "../src/adapters/indexer";
import type { OpContext, OpDef } from "../src/catalog/registry";
import { ops } from "../src/ops/tokens";

const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const BLACKHOLE = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";
const LEDGER_HASH = "A".repeat(64);

function operation(name: string): OpDef {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`Missing operation ${name}`);
  return op;
}

function indexerFixture(overrides: Partial<Indexer> = {}): Indexer {
  return {
    lookupToken: vi.fn(async () => ({
      source: "xrpl.to" as const,
      data: { currency: RLUSD_HEX, issuer: ISSUER, name: "RLUSD" },
    })),
    trendingTokens: vi.fn(async () => ({
      source: "xrpl.to" as const,
      data: [],
    })),
    flaggedTokens: vi.fn(async () => ({
      source: "xrpl.to" as const,
      data: [],
    })),
    ammPools: vi.fn(async () => ({
      source: "xrpl.to" as const,
      data: [],
    })),
    ...overrides,
  };
}

describe("token and indexed AMM operations", () => {
  it("exports only the P1.3 operations with their declared families", () => {
    expect(ops.map(({ name, family }) => ({ name, family }))).toEqual([
      { name: "tokens.lookup", family: "tokens" },
      { name: "tokens.trending", family: "tokens" },
      { name: "tokens.flagged", family: "tokens" },
      { name: "amm.pools", family: "amm" },
    ]);
  });

  it("strictly validates lookup identity, network, limits, and extra keys", () => {
    const lookup = operation("tokens.lookup");
    expect(
      lookup.args.safeParse({
        network: "mainnet",
        currency: "RLUSD",
        issuer: ISSUER,
      }).success,
    ).toBe(true);
    expect(
      lookup.args.safeParse({
        network: "sidechain",
        currency: "RLUSD",
        issuer: ISSUER,
      }).success,
    ).toBe(false);
    expect(
      lookup.args.safeParse({
        network: "mainnet",
        currency: "RLUSD",
        issuer: "not-an-address",
      }).success,
    ).toBe(false);
    expect(
      lookup.args.safeParse({
        network: "mainnet",
        currency: "RLUSD",
        issuer: ISSUER,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(operation("tokens.trending").args.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(operation("amm.pools").args.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("merges indexer metadata with all four validated issuer controls", async () => {
    const indexer = indexerFixture();
    const request = vi.fn(async (_network: string, command: string) => {
      if (command === "account_info") {
        return {
          account_data: {
            Account: ISSUER,
            Flags: 0x8054_0000,
            RegularKey: BLACKHOLE,
          },
          ledger_hash: LEDGER_HASH,
          validated: true,
        };
      }
      return {
        account_objects: [],
        ledger_hash: LEDGER_HASH,
        validated: true,
      };
    });
    const ctx = {
      principal: "tokens-fixture",
      indexer,
      xrplRpc: { request },
    } as OpContext;

    await expect(
      operation("tokens.lookup").handler(ctx, {
        network: "mainnet",
        currency: "RLUSD",
        issuer: ISSUER,
      }),
    ).resolves.toEqual({
      currency: RLUSD_HEX,
      issuer: ISSUER,
      metadata: {
        currency: RLUSD_HEX,
        issuer: ISSUER,
        name: "RLUSD",
      },
      metadataSource: "xrpl.to",
      ledgerFlags: {
        requireAuth: true,
        freeze: true,
        clawback: true,
        blackholed: true,
      },
      trust: {
        metadata: "external-reference",
        ledgerFlags: "validated-ledger",
      },
    });

    expect(indexer.lookupToken).toHaveBeenCalledWith({
      currency: "RLUSD",
      issuer: ISSUER,
      network: "mainnet",
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "mainnet",
      "account_info",
      { account: ISSUER, ledger_index: "validated", signer_lists: true },
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "mainnet",
      "account_objects",
      {
        account: ISSUER,
        ledger_hash: LEDGER_HASH,
        limit: 400,
        type: "delegate",
      },
      undefined,
    );
  });

  it("skips delegate enumeration when a cheaper blackhole prerequisite fails", async () => {
    const request = vi.fn(async () => ({
      account_data: { Account: ISSUER, Flags: 0 },
      ledger_hash: LEDGER_HASH,
      validated: true,
    }));

    await expect(
      operation("tokens.lookup").handler(
        {
          principal: "tokens-fixture",
          indexer: indexerFixture(),
          xrplRpc: { request },
        } as OpContext,
        { network: "mainnet", currency: "RLUSD", issuer: ISSUER },
      ),
    ).resolves.toMatchObject({ ledgerFlags: { blackholed: false } });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "mainnet",
      "account_info",
      { account: ISSUER, ledger_index: "validated", signer_lists: true },
      undefined,
    );
  });

  it("paginates empty delegate pages at the pinned ledger and finds a later Delegate", async () => {
    const request = vi.fn(
      async (_network: string, command: string, params: Record<string, unknown>) => {
        if (command === "account_info") {
          return {
            account_data: {
              Account: ISSUER,
              Flags: 0x0010_0000,
              RegularKey: BLACKHOLE,
            },
            signer_lists: [],
            ledger_hash: LEDGER_HASH,
            validated: true,
          };
        }
        return params.marker === undefined
          ? {
              account_objects: [],
              marker: "next-page",
              ledger_hash: LEDGER_HASH,
              validated: true,
            }
          : {
              account_objects: [{ LedgerEntryType: "Delegate" }],
              ledger_hash: LEDGER_HASH,
              validated: true,
            };
      },
    );

    const result = await operation("tokens.lookup").handler(
      {
        principal: "tokens-fixture",
        indexer: indexerFixture(),
        xrplRpc: { request },
      } as OpContext,
      { network: "testnet", currency: "RLUSD", issuer: ISSUER },
    );
    expect(result).toMatchObject({ ledgerFlags: { blackholed: false } });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "testnet",
      "account_objects",
      {
        account: ISSUER,
        ledger_hash: LEDGER_HASH,
        limit: 400,
        type: "delegate",
      },
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "testnet",
      "account_objects",
      {
        account: ISSUER,
        ledger_hash: LEDGER_HASH,
        limit: 400,
        type: "delegate",
        marker: "next-page",
      },
      undefined,
    );
  });

  it("rejects unvalidated account and delegate responses", async () => {
    const unvalidatedInfo = vi.fn().mockResolvedValue({
      account_data: { Account: ISSUER, Flags: 0 },
      signer_lists: [],
      ledger_hash: LEDGER_HASH,
      validated: false,
    });
    await expect(
      operation("tokens.lookup").handler(
        {
          principal: "tokens-fixture",
          indexer: indexerFixture(),
          xrplRpc: { request: unvalidatedInfo },
        } as OpContext,
        { network: "mainnet", currency: "RLUSD", issuer: ISSUER },
      ),
    ).rejects.toThrow();

    const unvalidatedObjects = vi.fn(
      async (_network: string, command: string) =>
        command === "account_info"
          ? {
              account_data: {
                Account: ISSUER,
                Flags: 0x0010_0000,
                RegularKey: BLACKHOLE,
              },
              signer_lists: [],
              ledger_hash: LEDGER_HASH,
              validated: true,
            }
          : {
              account_objects: [],
              ledger_hash: LEDGER_HASH,
              validated: false,
            },
    );
    await expect(
      operation("tokens.lookup").handler(
        {
          principal: "tokens-fixture",
          indexer: indexerFixture(),
          xrplRpc: { request: unvalidatedObjects },
        } as OpContext,
        { network: "mainnet", currency: "RLUSD", issuer: ISSUER },
      ),
    ).rejects.toThrow();
  });

  it("passes defaults and explicit limits to the injected read-only indexer", async () => {
    const indexer = indexerFixture();
    const ctx = { principal: "tokens-fixture", indexer } as OpContext;

    await expect(operation("tokens.trending").handler(ctx, {})).resolves.toMatchObject({
      trust: "external-reference",
    });
    await expect(
      operation("tokens.flagged").handler(ctx, { limit: 4 }),
    ).resolves.toMatchObject({ trust: "external-reference" });
    await expect(operation("amm.pools").handler(ctx, {})).resolves.toMatchObject({
      trust: "external-reference",
    });

    expect(indexer.trendingTokens).toHaveBeenCalledWith({ limit: 10 });
    expect(indexer.flaggedTokens).toHaveBeenCalledWith({ limit: 4 });
    expect(indexer.ammPools).toHaveBeenCalledWith({ limit: 25 });
  });

  it("rejects malformed XRPL responses instead of inferring missing flags", async () => {
    const request = vi.fn().mockResolvedValue({ account_data: { Flags: "262144" } });
    const promise = operation("tokens.lookup").handler(
      {
        principal: "tokens-fixture",
        indexer: indexerFixture(),
        xrplRpc: { request },
      } as OpContext,
      { network: "mainnet", currency: "RLUSD", issuer: ISSUER },
    );

    await expect(promise).rejects.toThrow();
  });
});
