import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import { invokeOp } from "../src/guard";
import { ops } from "../src/ops/amendments";

const LENDING_ID = "A".repeat(64);
const VAULT_ID = "B".repeat(64);
const UNKNOWN_ID = "C".repeat(64);
const AS_OF = "2026-10-18T00:00:00.000Z";

function operation() {
  const op = ops.find(({ name }) => name === "amendments.status");
  if (!op) throw new Error("Missing amendments.status");
  return op;
}

describe("amendments.status", () => {
  it("accepts contract networks and strict amendment selectors", () => {
    const op = operation();
    expect(op.caveats).toEqual(["amendment-pending"]);
    expect(op.args.safeParse({ network: "mainnet" }).success).toBe(true);
    expect(
      op.args.safeParse({
        network: "lending-devnet",
        amendment: "LendingProtocolV1_1",
      }).success,
    ).toBe(true);
    expect(
      op.args.safeParse({ network: "testnet", amendment: LENDING_ID }).success,
    ).toBe(true);
    expect(op.args.safeParse({ network: "sidechain" }).success).toBe(false);
    expect(
      op.args.safeParse({ network: "devnet", amendment: "bad feature" })
        .success,
    ).toBe(false);
    expect(
      op.args.safeParse({ network: "devnet", unexpected: true }).success,
    ).toBe(false);
  });

  it("reports enabled separately from server support without inferring votes", async () => {
    const fixture = {
      [LENDING_ID]: {
        enabled: false,
        name: "LendingProtocolV1_1",
        supported: true,
      },
      [VAULT_ID]: {
        enabled: true,
        name: "SingleAssetVault",
        supported: true,
      },
      [UNKNOWN_ID]: {
        enabled: true,
        supported: false,
      },
    };
    const request = vi.fn().mockResolvedValue(fixture);
    const ctx = {
      principal: "amendments-fixture-test",
      xrplRpc: { request },
    } satisfies OpContext;

    const result = await invokeOp(
      operation(),
      ctx,
      { network: "devnet" },
      { asOf: AS_OF, asOfBasis: "recorded-fixture" },
    );

    expect(request).toHaveBeenCalledWith("devnet", "feature", {}, undefined);
    expect(result).toEqual({
      ok: true,
      data: {
        network: "devnet",
        amendments: [
          {
            id: UNKNOWN_ID,
            enabled: true,
            supported: false,
            status: "enabled-unsupported",
          },
          {
            id: LENDING_ID,
            name: "LendingProtocolV1_1",
            enabled: false,
            supported: true,
            status: "supported-not-enabled",
          },
          {
            id: VAULT_ID,
            name: "SingleAssetVault",
            enabled: true,
            supported: true,
            status: "enabled",
          },
        ],
      },
      asOf: AS_OF,
      asOfBasis: "recorded-fixture",
      caveat: ["amendment-pending"],
    });
  });

  it("supports the legacy wrapped response and sends no admin mutation field", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "success",
      features: {
        [LENDING_ID]: {
          enabled: false,
          name: "LendingProtocolV1_1",
          supported: false,
        },
      },
    });

    await expect(
      operation().handler(
        { principal: "amendments-fixture-test", xrplRpc: { request } },
        { network: "lending-devnet", amendment: "LendingProtocolV1_1" },
      ),
    ).resolves.toEqual({
      network: "lending-devnet",
      query: "LendingProtocolV1_1",
      amendments: [
        {
          id: LENDING_ID,
          name: "LendingProtocolV1_1",
          enabled: false,
          supported: false,
          status: "unsupported",
        },
      ],
    });
    expect(request).toHaveBeenCalledWith(
      "lending-devnet",
      "feature",
      { feature: "LendingProtocolV1_1" },
      undefined,
    );
    expect(request.mock.calls[0][2]).not.toHaveProperty("vetoed");
  });

  it("rejects malformed feature response fixtures", async () => {
    const request = vi.fn().mockResolvedValue({
      [LENDING_ID]: {
        enabled: "false",
        name: "LendingProtocolV1_1",
        supported: true,
      },
    });

    await expect(
      operation().handler(
        { principal: "amendments-fixture-test", xrplRpc: { request } },
        { network: "devnet" },
      ),
    ).rejects.toThrow();
  });
});
