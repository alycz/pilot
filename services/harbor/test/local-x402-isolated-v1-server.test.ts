import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpRegistry, type OpDef } from "../src/catalog/registry";
import { LOCAL_X402_COMPARE_PRICE_DROPS } from "../src/local-x402";
import {
  LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN,
  LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
  LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
  isLocalX402IsolatedV1Request,
} from "../src/local-x402-isolated-v1";
import { ops as x402Ops } from "../src/ops/x402";
import { createWorker, type Env } from "../src/server";
import type { X402Service } from "../src/x402-contract";

const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const HASH = "A".repeat(64);
const TOKEN = "I".repeat(32);
const BEARER = `Bearer isolated-x402:${TOKEN}`;
const REQUEST = {
  owner: OWNER,
  network: "testnet" as const,
  resource: "compare" as const,
  max_price_drops: LOCAL_X402_COMPARE_PRICE_DROPS,
  idempotency_key: "isolated-paired-fixture-1",
  pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
};

const environment: Env = {
  DB: {} as D1Database,
  HARBOR_API_KEYS: `isolated-x402:${TOKEN}`,
  HARBOR_KEK: "fixture-never-used",
  HARBOR_SOURCE_TAG: "2610240",
  EXEC_NETWORK: "testnet",
  EXECUTOR: "quickjs",
  MAINNET_EXECUTION: "false",
  HARBOR_LOCAL_DEV: "true",
  HARBOR_LOCAL_READ_ONLY: "true",
  HARBOR_LOCAL_AUTH_REQUIRED: "true",
  HARBOR_LOCAL_CRON_DISABLED: "true",
  HARBOR_LOCAL_X402: "true",
  HARBOR_LOCAL_X402_MERCHANT_PAY_TO:
    LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
  HARBOR_LOCAL_X402_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_X402_SIGNING_PROFILE: LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
  HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: "true",
  HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE:
    LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
};

function x402Request(
  origin = LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN,
  headers: HeadersInit = {},
  body: unknown = REQUEST,
): Request {
  return new Request(`${origin}/api/ops/x402.pay`, {
    method: "POST",
    headers: {
      authorization: BEARER,
      "content-type": "application/json",
      host: "127.0.0.2:8792",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function fixtureService(): X402Service {
  return {
    pay: vi.fn(async (principal, request) => ({
      status: "delivered" as const,
      payment_id: "payment-isolated-1",
      idempotency_key: request.idempotency_key,
      owner: request.owner,
      network: "testnet" as const,
      resource: "compare" as const,
      invoice_id: "invoice-isolated-1",
      amount_drops: LOCAL_X402_COMPARE_PRICE_DROPS,
      fee_drops: "12",
      payer: PAYER,
      pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      tx_hash: HASH,
      validated_ledger_index: 123,
      merchant: {
        status: 200 as const,
        content_type: "application/json" as const,
        body: { comparison: ["dex", "amm"] },
      },
    })),
  };
}

async function invoke(
  request: Request,
  env: Env = environment,
  service: X402Service = fixtureService(),
): Promise<Response> {
  return createWorker(new OpRegistry(x402Ops), () => service).fetch!(
    request,
    env,
    {} as ExecutionContext,
  );
}

describe("local x402 isolated v1 server boundary", () => {
  it("processes one authenticated fixed-resource request through the dedicated profile", async () => {
    const service = fixtureService();
    const response = await invoke(x402Request(), environment, service);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        status: "delivered",
        owner: OWNER,
        network: "testnet",
        resource: "compare",
        amount_drops: LOCAL_X402_COMPARE_PRICE_DROPS,
        fee_drops: "12",
        tx_hash: HASH,
        validated_ledger_index: 123,
        merchant: {
          status: 200,
          content_type: "application/json",
          body: { comparison: ["dex", "amm"] },
        },
      },
    });
    expect(service.pay).toHaveBeenCalledExactlyOnceWith("isolated-x402", REQUEST);
  });

  it.each(["4999", "5001", "100000"])(
    "rejects isolated max_price_drops=%s before calling the service",
    async (maxPriceDrops) => {
      const service = fixtureService();
      const response = await invoke(
        x402Request(undefined, {}, {
          ...REQUEST,
          max_price_drops: maxPriceDrops,
        }),
        environment,
        service,
      );
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "OPERATION_FAILED" },
      });
      expect(service.pay).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "missing",
      ({ pay_to: _payTo, ...request }: typeof REQUEST) => request,
      "OPERATION_FAILED",
    ],
    [
      "wrong",
      (request: typeof REQUEST) => ({
        ...request,
        pay_to: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      }),
      "INVALID_ARGUMENTS",
    ],
  ] as const)(
    "rejects an isolated request with a %s pay_to before calling the service",
    async (_label, mutate, errorCode) => {
      const service = fixtureService();
      const response = await invoke(
        x402Request(undefined, {}, mutate(REQUEST)),
        environment,
        service,
      );
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: errorCode },
      });
      expect(service.pay).not.toHaveBeenCalled();
    },
  );

  it("rejects a substituted valid merchant before calling the service", async () => {
    const service = fixtureService();
    const response = await invoke(
      x402Request(),
      {
        ...environment,
        HARBOR_LOCAL_X402_MERCHANT_PAY_TO:
          "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      },
      service,
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "X402_RUNTIME_DISABLED" },
    });
    expect(service.pay).not.toHaveBeenCalled();
  });

  it("requires the exact origin, Host, named bearer, and absent forwarding metadata", async () => {
    expect(isLocalX402IsolatedV1Request(x402Request(), environment)).toBe(true);
    const noBearer = x402Request();
    noBearer.headers.delete("authorization");
    expect((await invoke(noBearer)).status).toBe(401);

    for (const request of [
      x402Request("http://127.0.0.1:8791"),
      x402Request("http://127.0.0.2:8791"),
      x402Request("http://127.0.0.3:8791"),
      x402Request(undefined, { host: "localhost:8792" }),
      x402Request(undefined, { "x-forwarded-host": "127.0.0.2:8792" }),
      x402Request(undefined, { origin: "http://127.0.0.2:3003" }),
    ]) {
      expect(isLocalX402IsolatedV1Request(request, environment)).toBe(false);
      const body = await (await invoke(request)).json() as { ok: boolean };
      expect(body.ok).toBe(false);
    }
  });

  it("fails closed for partial, mixed, mainnet, or legacy profile markers", async () => {
    const patches: Array<Partial<Env>> = [
      { HARBOR_LOCAL_X402_ISOLATED_V1_RUNTIME_ENABLED: undefined },
      { HARBOR_LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE: undefined },
      { HARBOR_LOCAL_X402_SIGNING_PROFILE: "reviewed-testnet-local-v1" },
      { EXEC_NETWORK: "mainnet" },
      { MAINNET_EXECUTION: "true" },
      { HARBOR_LOCAL_X402_MERCHANT_PAY_TO: "rInvalid" },
      { HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED: "true" },
      { HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE: "local-wallet-isolated-v1" },
    ];
    for (const patch of patches) {
      const response = await invoke(x402Request(), { ...environment, ...patch });
      const body = await response.json() as { ok: boolean };
      expect(body.ok).toBe(false);
    }
  });

  it("keeps every non-x402 operation unavailable in the isolated process", async () => {
    const txFixture: OpDef = {
      name: "tx.status",
      family: "tx",
      summary: "must remain unavailable",
      args: z.object({ hash: z.string() }).strict(),
      returns: "never",
      caveats: [],
      example: "never",
      handler: vi.fn(() => ({ unexpected: true })),
    };
    const response = await createWorker(
      new OpRegistry([...x402Ops, txFixture]),
      () => fixtureService(),
    ).fetch!(
      new Request(`${LOCAL_X402_ISOLATED_V1_HARBOR_ORIGIN}/api/ops/tx.status`, {
        method: "POST",
        headers: {
          authorization: BEARER,
          "content-type": "application/json",
          host: "127.0.0.2:8792",
        },
        body: JSON.stringify({ hash: HASH }),
      }),
      environment,
      {} as ExecutionContext,
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "LOCAL_X402_OPERATION_DISABLED" },
    });
    expect(txFixture.handler).not.toHaveBeenCalled();
  });
});
