import { describe, expect, it, vi } from "vitest";

import { ops } from "../src/ops/server";

const serverInfoFixture = {
  info: {
    build_version: "3.1.0",
    validated_ledger: {
      age: 2,
      base_fee_xrp: 0.00001,
      hash: "ABCDEF0123456789",
      reserve_base_xrp: 1,
      reserve_inc_xrp: 0.2,
      seq: 99_123_456,
    },
  },
};

function injectedContext(result: Record<string, unknown> = serverInfoFixture) {
  const request = vi.fn(async () => result);
  return {
    ctx: {
      principal: "server-ops-test",
      xrplRpc: { request },
    },
    request,
  };
}

describe("server.reserves", () => {
  const op = ops.find(({ name }) => name === "server.reserves");

  it("has strict network arguments", () => {
    expect(op).toBeDefined();
    expect(op!.args.parse({ network: "testnet" })).toEqual({
      network: "testnet",
    });
    expect(() => op!.args.parse({ network: "sidechain" })).toThrow();
    expect(() =>
      op!.args.parse({ network: "testnet", unexpected: true }),
    ).toThrow();
  });

  it("reads reserve values from the server_info validated ledger", async () => {
    const { ctx, request } = injectedContext();

    await expect(op!.handler(ctx, { network: "testnet" })).resolves.toEqual({
      network: "testnet",
      reserve_base_xrp: 1,
      reserve_inc_xrp: 0.2,
      ledger_index: 99_123_456,
      ledger_hash: "ABCDEF0123456789",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "server_info",
      undefined,
      undefined,
    );
  });

  it("does not substitute hard-coded reserves when validated data is absent", async () => {
    const { ctx } = injectedContext({
      info: {
        closed_ledger: {
          hash: "CLOSED",
          reserve_base_xrp: 10,
          reserve_inc_xrp: 2,
          seq: 123,
        },
      },
    });

    await expect(op!.handler(ctx, { network: "devnet" })).rejects.toThrow(
      /validated_ledger/,
    );
  });

  it.each([
    ["reserve_base_xrp", undefined],
    ["reserve_inc_xrp", "0.2"],
    ["reserve_base_xrp", -1],
  ])("rejects invalid %s values", async (field, value) => {
    const fixture = structuredClone(serverInfoFixture);
    fixture.info.validated_ledger[field as "reserve_base_xrp"] = value as number;
    const { ctx } = injectedContext(fixture);

    await expect(op!.handler(ctx, { network: "mainnet" })).rejects.toThrow(
      new RegExp(field),
    );
  });
});
