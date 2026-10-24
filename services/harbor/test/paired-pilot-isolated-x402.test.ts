import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import {
  LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
  LOCAL_X402_ISOLATED_V1_SIGNING_PROFILE,
} from "../src/local-x402-isolated-v1";
import { ops as x402Ops } from "../src/ops/x402";
import { createWorker, type Env } from "../src/server";
import type { X402Service } from "../src/x402-contract";

const PILOT_ROOT = process.env.PILOT_X402_CHECKOUT;
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const PAYER = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const TOKEN = "I".repeat(32);
const ORIGIN = "http://127.0.0.2:8792";
const ARGS = {
  owner: OWNER,
  network: "testnet" as const,
  resource: "compare" as const,
  max_price_drops: "5000",
  idempotency_key: "paired-no-socket-1",
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

type PilotRequestModule = {
  createHarborRestDispatch(
    baseUrl: string,
    apiKey: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): { url: string; init: RequestInit };
};

async function pilotRequestModule(): Promise<PilotRequestModule> {
  if (!PILOT_ROOT) throw new Error("PILOT_X402_CHECKOUT is required");
  const url = pathToFileURL(join(
    PILOT_ROOT,
    "packages/harbor-client/src/request.ts",
  )).href;
  return import(/* @vite-ignore */ url) as Promise<PilotRequestModule>;
}

function service(): X402Service {
  return {
    pay: vi.fn(async (_principal, request) => ({
      status: "delivered" as const,
      payment_id: "paired-payment-1",
      idempotency_key: request.idempotency_key,
      owner: request.owner,
      network: "testnet" as const,
      resource: "compare" as const,
      invoice_id: "paired-invoice-1",
      amount_drops: "5000",
      fee_drops: "12",
      payer: PAYER,
      pay_to: LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO,
      tx_hash: "A".repeat(64),
      validated_ledger_index: 123,
      merchant: {
        status: 200 as const,
        content_type: "application/json" as const,
        body: { comparison: ["dex", "amm"] },
      },
    })),
  };
}

async function dispatch(
  operation = "x402.pay",
  mutate: (headers: Headers) => void = () => undefined,
  args: unknown = ARGS,
  env: Env = environment,
): Promise<{ response: Response; x402: X402Service }> {
  const pilot = await pilotRequestModule();
  const built = pilot.createHarborRestDispatch(
    ORIGIN,
    `isolated-x402:${TOKEN}`,
    operation,
    args,
    new AbortController().signal,
  );
  const headers = new Headers(built.init.headers);
  // This is the no-socket bridge: the transport synthesizes the raw Host that
  // the real fixed loopback listener would supply, then calls Worker.fetch.
  headers.set("host", "127.0.0.2:8792");
  mutate(headers);
  const request = new Request(built.url, { ...built.init, headers });
  const x402 = service();
  const response = await createWorker(
    new OpRegistry(x402Ops),
    () => x402,
  ).fetch!(request, env, {} as ExecutionContext);
  return { response, x402 };
}

describe.runIf(Boolean(PILOT_ROOT))("paired Pilot to Harbor no-socket transport", () => {
  it("dispatches the actual Pilot request builder into the isolated Harbor handler", async () => {
    const { response, x402 } = await dispatch();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { status: "delivered", resource: "compare", fee_drops: "12" },
    });
    expect(x402.pay).toHaveBeenCalledExactlyOnceWith("isolated-x402", ARGS);
  });

  it.each([
    ["wrong Host", (headers: Headers) => headers.set("host", "127.0.0.3:8791")],
    ["forwarding metadata", (headers: Headers) => headers.set("x-forwarded-host", "127.0.0.2:8792")],
    ["wrong credential", (headers: Headers) => headers.set("authorization", `Bearer wrong:${"W".repeat(32)}`)],
  ] as const)("rejects %s before x402 execution", async (_label, mutate) => {
    const { response, x402 } = await dispatch("x402.pay", mutate);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(x402.pay).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing",
      ({ pay_to: _payTo, ...args }: typeof ARGS) => args,
    ],
    ["wrong", (args: typeof ARGS) => ({
      ...args,
      pay_to: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    })],
  ] as const)(
    "rejects a %s pay_to before execution",
    async (_label, mutate) => {
      const { response, x402 } = await dispatch(
        "x402.pay",
        () => undefined,
        mutate(ARGS),
      );
      await expect(response.json()).resolves.toMatchObject({ ok: false });
      expect(x402.pay).not.toHaveBeenCalled();
    },
  );

  it.each(["4999", "5001", "100000"])(
    "rejects max_price_drops=%s before execution",
    async (maxPriceDrops) => {
      const { response, x402 } = await dispatch(
        "x402.pay",
        () => undefined,
        { ...ARGS, max_price_drops: maxPriceDrops },
      );
      await expect(response.json()).resolves.toMatchObject({ ok: false });
      expect(x402.pay).not.toHaveBeenCalled();
    },
  );

  it("rejects a substituted valid merchant before execution", async () => {
    const { response, x402 } = await dispatch(
      "x402.pay",
      () => undefined,
      ARGS,
      {
        ...environment,
        HARBOR_LOCAL_X402_MERCHANT_PAY_TO:
          "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      },
    );
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(x402.pay).not.toHaveBeenCalled();
  });

  it("rejects a non-x402 operation in the dedicated process", async () => {
    const { response, x402 } = await dispatch("venues.list");
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(x402.pay).not.toHaveBeenCalled();
  });
});
