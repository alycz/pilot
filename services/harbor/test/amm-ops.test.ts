import { describe, expect, it, vi } from "vitest";

import type { OpContext } from "../src/catalog/registry";
import { ops } from "../src/ops/amm";

const AMM_ACCOUNT = "rp9E3FN3gNmvePGhYnf414T2TkUuoxu8vM";
const ISSUER = "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd";
const PROVIDER = "rJVUeRqDFNs2xqA7ncVE6ZoAhPUoaJJSQm";
const LP_CURRENCY = "039C99CD9AB0B70B32ECDA51EAAE471625608EA2";

// Recorded from the public amm_info response shape documented at:
// https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info#response-format
const AMM_INFO_FIXTURE = {
  amm: {
    account: AMM_ACCOUNT,
    amount: "296890496",
    amount2: {
      currency: "TST",
      issuer: ISSUER,
      value: "25.81656470648473",
    },
    asset2_frozen: false,
    auction_slot: {
      account: PROVIDER,
      discounted_fee: 60,
      expiration: "2023-Jan-26 00:28:40.000000000 UTC",
      price: {
        currency: LP_CURRENCY,
        issuer: AMM_ACCOUNT,
        value: "0",
      },
      time_interval: 0,
    },
    lp_token: {
      currency: LP_CURRENCY,
      issuer: AMM_ACCOUNT,
      value: "87533.41976112682",
    },
    trading_fee: 600,
    vote_slots: [
      { account: PROVIDER, trading_fee: 600, vote_weight: 9684 },
    ],
  },
  ledger_index: 316725,
  validated: true,
};

const POSITION_FIXTURE = {
  ...AMM_INFO_FIXTURE,
  amm: {
    ...AMM_INFO_FIXTURE.amm,
    lp_token: {
      ...AMM_INFO_FIXTURE.amm.lp_token,
      value: "8476.117432506679",
    },
  },
};

function operation(name: string) {
  const op = ops.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`Missing operation ${name}`);
  return op;
}

function contextWith(result: Record<string, unknown>) {
  const request = vi.fn(async () => result);
  return {
    ctx: {
      principal: "amm-unit-test",
      xrplRpc: { request },
    } as OpContext,
    request,
  };
}

describe("AMM operations", () => {
  it("exports inline operation definitions", () => {
    expect(ops.map(({ name }) => name)).toEqual([
      "amm.info",
      "amm.position",
    ]);
  });

  it("reads AMM info with the protocol's XRP and issued-asset shapes", async () => {
    const { ctx, request } = contextWith(AMM_INFO_FIXTURE);
    const args = {
      network: "testnet",
      asset: { currency: "XRP" },
      asset2: { currency: "TST", issuer: ISSUER },
    };

    await expect(operation("amm.info").handler(ctx, args)).resolves.toEqual(
      AMM_INFO_FIXTURE,
    );
    expect(request).toHaveBeenCalledWith(
      "testnet",
      "amm_info",
      {
        asset: { currency: "XRP" },
        asset2: { currency: "TST", issuer: ISSUER },
        ledger_index: "validated",
      },
      undefined,
    );
  });

  it("uses amm_info's account filter for the provider's LP-token balance", async () => {
    const { ctx, request } = contextWith(POSITION_FIXTURE);
    const args = {
      network: "devnet",
      account: PROVIDER,
      asset: { currency: "XRP" },
      asset2: { currency: "TST", issuer: ISSUER },
    };

    await expect(
      operation("amm.position").handler(ctx, args),
    ).resolves.toEqual({ account: PROVIDER, ...POSITION_FIXTURE });
    expect(request).toHaveBeenCalledWith(
      "devnet",
      "amm_info",
      {
        account: PROVIDER,
        asset: { currency: "XRP" },
        asset2: { currency: "TST", issuer: ISSUER },
        ledger_index: "validated",
      },
      undefined,
    );
  });

  it("strictly validates networks, accounts, asset pairs, and extra keys", () => {
    const info = operation("amm.info");
    const position = operation("amm.position");
    const validPair = {
      network: "testnet",
      asset: { currency: "XRP" },
      asset2: { currency: "TST", issuer: ISSUER },
    };

    expect(info.args.safeParse(validPair).success).toBe(true);
    expect(
      info.args.safeParse({
        ...validPair,
        network: "sidechain",
      }).success,
    ).toBe(false);
    expect(
      info.args.safeParse({
        ...validPair,
        asset: { currency: "XRP", issuer: ISSUER },
      }).success,
    ).toBe(false);
    expect(
      info.args.safeParse({
        ...validPair,
        asset2: { currency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      info.args.safeParse({
        ...validPair,
        asset2: {
          currency: "RLUSD",
          issuer: ISSUER,
        },
      }).success,
    ).toBe(false);
    expect(
      info.args.safeParse({ ...validPair, unexpected: true }).success,
    ).toBe(false);
    expect(
      info.args.safeParse({
        ...validPair,
        asset2: { currency: "XRP" },
      }).success,
    ).toBe(false);
    expect(
      position.args.safeParse({ ...validPair, account: "not-an-address" })
        .success,
    ).toBe(false);
  });

  it("accepts 40-hex nonstandard currency codes for issued assets", () => {
    expect(
      operation("amm.info").args.safeParse({
        network: "mainnet",
        asset: { currency: "XRP" },
        asset2: {
          currency: "524C555344000000000000000000000000000000",
          issuer: ISSUER,
        },
      }).success,
    ).toBe(true);
  });
});
