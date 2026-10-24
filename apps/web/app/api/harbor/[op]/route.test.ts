import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@pilot/contracts";
import { Wallet, type Payment } from "xrpl";
import { sealWalletSession, WALLET_SESSION_COOKIE } from "../../../../lib/wallet-session";
import { authorizeBrowserHarborOperation } from "../../../../lib/wallet-authorization";

import {
  createHarborProxyHandler as createProductionHarborProxyHandler,
  type HarborProxyDependencies,
  type HarborProxyEnvironment,
} from "./handler";

const ENVIRONMENT: HarborProxyEnvironment = {
  HARBOR_API_KEY: "pilot:test-token",
  HARBOR_MOCK: "0",
  HARBOR_URL: "https://harbor.example/",
  NEXT_PUBLIC_DEV_SIGNER: "0",
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
};
const AUTH_ENVIRONMENT: HarborProxyEnvironment = {
  ...ENVIRONMENT,
  EXEC_NETWORK: "testnet",
};
const LOCAL_X402_ENVIRONMENT: HarborProxyEnvironment = {
  EXEC_NETWORK: "testnet",
  HARBOR_API_KEY: "pilot:test-token",
  HARBOR_MOCK: "0",
  HARBOR_URL: "http://127.0.0.1:8791",
  NEXT_PUBLIC_DEV_SIGNER: "1",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet",
};
const LOCAL_OWNER_REVIEW_ENVIRONMENT: HarborProxyEnvironment = {
  ...LOCAL_X402_ENVIRONMENT,
  HARBOR_MOCK: "1",
  HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED: "true",
  MAINNET_EXECUTION: "false",
};
const LOCAL_CAPABILITY_ENVIRONMENT: HarborProxyEnvironment = {
  ...LOCAL_X402_ENVIRONMENT,
  HARBOR_MOCK: "1",
  HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED: "true",
  MAINNET_EXECUTION: "false",
};
const LOCAL_WORK_AGREEMENT_ENVIRONMENT: HarborProxyEnvironment = {
  ...LOCAL_X402_ENVIRONMENT,
  HARBOR_MOCK: "1",
  HARBOR_LOCAL_WORK_AGREEMENT_ENABLED: "true",
  MAINNET_EXECUTION: "false",
};
const ISOLATED_X402_ENVIRONMENT: HarborProxyEnvironment = {
  EXEC_NETWORK: "testnet",
  HARBOR_API_KEY: `isolated-trading:${"T".repeat(32)}`,
  HARBOR_X402_API_KEY: `isolated-x402:${"X".repeat(32)}`,
  HARBOR_MOCK: "0",
  HARBOR_URL: "http://127.0.0.2:8791",
  HARBOR_X402_URL: "http://127.0.0.2:8792",
  NEXT_PUBLIC_DEV_SIGNER: "1",
  NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
  PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
};
const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const X402_PAY_TO = "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr";
const SESSION_SECRET = "route-test-session-secret-with-at-least-thirty-two-characters";
const HASH = "A".repeat(64);
const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const XRP = { currency: "XRP" } as const;
const RLUSD = { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER } as const;
const MANDATE_PREPARE_ARGS = {
  owner: ACCOUNT,
  network: "testnet",
  constraints: {
    currency: "USD",
    per_payment_max: "5.00",
    daily_max: "10.00",
    total_max: "25.00",
    payees: ["venue-yield-desk"],
  },
  payees: ["venue-yield-desk"],
  expires_at: "2026-10-24T08:00:00.000Z",
} as const;
const MANDATE_REGISTER_ARGS = {
  mandate_id: "mandate-1",
  l1: "l1~signed",
  l2: "l2~signed",
  setup_tx_hash: "A".repeat(64),
} as const;

function request(
  body: string,
  options: {
    authorization?: string;
    contentType?: string;
    omitOrigin?: boolean;
    origin?: string;
    url?: string;
    headers?: HeadersInit;
  } = {},
): Request {
  const headers = new Headers();
  if (options.contentType !== undefined) {
    headers.set("content-type", options.contentType);
  } else {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  if (options.authorization) headers.set("authorization", options.authorization);
  if (!options.omitOrigin) headers.set("origin", options.origin ?? "https://pilot.example");
  const url = options.url ?? "http://next-internal:3000/api/harbor/tx.execute";
  headers.set("host", new URL(url).host);
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);

  return new Request(url, {
    method: "POST",
    headers,
    body,
  });
}

function context(op: string) {
  return { params: Promise.resolve({ op }) };
}

function x402Request(body: string): Request {
  return request(body, {
    origin: "http://127.0.0.1:3003",
    url: "http://127.0.0.1:3003/api/harbor/x402.pay",
  });
}

function ownerReviewRequest(op: string, body: string, headers?: HeadersInit): Request {
  return request(body, {
    origin: "http://127.0.0.1:3003",
    url: `http://127.0.0.1:3003/api/harbor/${op}`,
    headers,
  });
}

function capabilityRequest(op: string, body: string, headers?: HeadersInit): Request {
  return request(body, {
    origin: "http://127.0.0.1:3003",
    url: `http://127.0.0.1:3003/api/harbor/${op}`,
    headers,
  });
}

function workAgreementRequest(op: string, body: string, headers?: HeadersInit): Request {
  return request(body, {
    origin: "http://127.0.0.1:3003",
    url: `http://127.0.0.1:3003/api/harbor/${op}`,
    headers,
  });
}

function capabilityBodies(owner: Wallet) {
  const scope = { account: owner.classicAddress, network: "testnet" } as const;
  const capabilityRef = `cap_v1_${"A".repeat(32)}`;
  const ownerProof = {
    nonce: "N".repeat(32),
    approved_at: "2026-10-24T12:00:00.000Z",
    expires_at: "2026-10-24T12:01:00.000Z",
    tx_blob: owner.sign({
      TransactionType: "AccountSet",
      Account: owner.classicAddress,
      Sequence: 0,
      Fee: "0",
      LastLedgerSequence: 0,
      Memos: [{ Memo: { MemoType: "70696C6F742D6361706162696C6974792D7631", MemoData: "AA" } }],
    }).tx_blob,
  };
  return [
    ["capability.prepare", {
      ...scope,
      service: "mock.catalog",
      operation: "read",
      amount: { unit: "request", value: "1" },
      destination: "local-fixture-catalog",
      not_before: "2026-10-24T12:00:00.000Z",
      expires_at: "2026-10-24T12:05:00.000Z",
      max_uses: 2,
      rate_limit: { window_seconds: 60, max_calls: 1 },
    }],
    ["capability.activate", {
      ...scope, capability_ref: capabilityRef, generation: 1,
      approval_digest: "a".repeat(64), owner_proof: ownerProof,
    }],
    ["capability.status", { ...scope, capability_ref: capabilityRef }],
    ["capability.prepareRevoke", {
      ...scope, capability_ref: capabilityRef, request_id: "capability-revoke-request-1",
    }],
    ["capability.revoke", {
      ...scope, capability_ref: capabilityRef, generation: 2,
      approval_digest: "b".repeat(64), owner_proof: ownerProof,
    }],
    ["capability.invoke", {
      ...scope,
      capability_ref: capabilityRef,
      generation: 1,
      request_id: "capability-invoke-request-1",
      service: "mock.catalog",
      operation: "read",
      amount: { unit: "request", value: "1" },
      destination: "local-fixture-catalog",
      input: { resource: "ledger-docs" },
    }],
  ] as const;
}

async function withLocalWalletProcessEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const priorEnvironment = {
    EXEC_NETWORK: process.env.EXEC_NETWORK,
    NEXT_PUBLIC_PILOT_BUILD_MARKER: process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER,
    PILOT_DEPLOYMENT_PROFILE: process.env.PILOT_DEPLOYMENT_PROFILE,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
  try {
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.EXEC_NETWORK = "testnet";
    process.env.PILOT_DEPLOYMENT_PROFILE = "local-wallet";
    delete process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER;
    return await run();
  } finally {
    for (const [name, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function isolatedX402Request(body: string, options: { headers?: HeadersInit } = {}): Request {
  return request(body, {
    origin: "http://127.0.0.2:3003",
    url: "http://127.0.0.2:3003/api/harbor/x402.pay",
    ...options,
  });
}

function fetchDependency(mock: ReturnType<typeof vi.fn>): typeof globalThis.fetch {
  return mock as unknown as typeof globalThis.fetch;
}

function createHarborProxyHandler(
  overrides: Partial<HarborProxyDependencies> = {},
) {
  return createProductionHarborProxyHandler({
    authorizeOperation: () => true,
    ...overrides,
  });
}

describe("POST /api/harbor/[op]", () => {
  it("requires wallet-bound authorization for mutations", async () => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => false,
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request(JSON.stringify({ build_id: "build-1", idempotency_key: "intent-1" })),
      context("tx.execute"),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["mandate.prepare", MANDATE_PREPARE_ARGS],
    ["mandate.register", MANDATE_REGISTER_ARGS],
    ["mandate.revoke", { mandate_id: "mandate-1" }],
    ["credential.payerAccept", {}],
    ["ap4m.purchase", {
      mandate_id: "mandate-1",
      merchant_id: "venue-yield-desk",
      sku: "yield-report",
      idempotency_key: "purchase-1",
    }],
  ] as const)("rejects unauthorized sponsor mutation %s before Harbor dispatch", async (op, args) => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => false,
      env: AUTH_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request(JSON.stringify(args)), context(op));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["credential.revoke", { subject: ACCOUNT }],
    ["channel.settle", { channel_id: "channel-1" }],
    ["quicknode.unfreeze", {}],
    ["quicknode.test.registerLink", {}],
  ] as const)("does not expose unavailable privileged sponsor operation %s", async (op, args) => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => true,
      env: AUTH_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request(JSON.stringify(args)), context(op));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_OP");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["mandate.prepare", MANDATE_PREPARE_ARGS],
    ["mandate.register", MANDATE_REGISTER_ARGS],
  ] as const)("allows wallet-bound onboarding operation %s", async (op, args) => {
    const session = sealWalletSession({
      version: 1,
      account: ACCOUNT,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, AUTH_ENVIRONMENT);
    const upstreamFetch = vi.fn(async () => Response.json({ ok: true }));
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: AUTH_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const priorEnvironment = {
      EXEC_NETWORK: process.env.EXEC_NETWORK,
      PILOT_DEPLOYMENT_PROFILE: process.env.PILOT_DEPLOYMENT_PROFILE,
      PILOT_PUBLIC_ORIGIN: process.env.PILOT_PUBLIC_ORIGIN,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };
    try {
      process.env.EXEC_NETWORK = "testnet";
      process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
      process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
      process.env.SESSION_SECRET = SESSION_SECRET;
      const response = await handler(request(JSON.stringify(args), {
        headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      }), context(op));

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    } finally {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it.each([
    ["owner", { ...MANDATE_PREPARE_ARGS, owner: X402_PAY_TO }, "testnet"],
    ["network", MANDATE_PREPARE_ARGS, "devnet"],
  ] as const)("rejects mandate.prepare with a wallet-session %s mismatch", async (_scope, args, sessionNetwork) => {
    const session = sealWalletSession({
      version: 1,
      account: ACCOUNT,
      network: sessionNetwork,
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, AUTH_ENVIRONMENT);
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: AUTH_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const priorEnvironment = {
      EXEC_NETWORK: process.env.EXEC_NETWORK,
      PILOT_DEPLOYMENT_PROFILE: process.env.PILOT_DEPLOYMENT_PROFILE,
      PILOT_PUBLIC_ORIGIN: process.env.PILOT_PUBLIC_ORIGIN,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };
    try {
      process.env.EXEC_NETWORK = "testnet";
      process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
      process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
      process.env.SESSION_SECRET = SESSION_SECRET;
      const response = await handler(request(JSON.stringify(args), {
        headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      }), context("mandate.prepare"));

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it.each([
    ["mandate.revoke", { mandate_id: "mandate-1" }],
    ["credential.payerAccept", {}],
    ["ap4m.purchase", {
      mandate_id: "mandate-1",
      merchant_id: "venue-yield-desk",
      sku: "yield-report",
      idempotency_key: "purchase-1",
    }],
  ] as const)("keeps privileged sponsor operation %s browser-denied", async (op, args) => {
    const session = sealWalletSession({
      version: 1,
      account: ACCOUNT,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, AUTH_ENVIRONMENT);
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: AUTH_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const priorEnvironment = {
      EXEC_NETWORK: process.env.EXEC_NETWORK,
      PILOT_DEPLOYMENT_PROFILE: process.env.PILOT_DEPLOYMENT_PROFILE,
      PILOT_PUBLIC_ORIGIN: process.env.PILOT_PUBLIC_ORIGIN,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };
    try {
      process.env.EXEC_NETWORK = "testnet";
      process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
      process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
      process.env.SESSION_SECRET = SESSION_SECRET;
      const response = await handler(request(JSON.stringify(args), {
        headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      }), context(op));

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects unauthorized x402.pay before any local Harbor fetch", async () => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => false,
      env: LOCAL_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(x402Request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:unauthorized-wallet-1",
    })), context("x402.pay"));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects spoofed forwarding authority on x402.pay before any fetch", async () => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => true,
      env: LOCAL_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:spoofed-authority-1",
    }), {
      origin: "http://127.0.0.1:3003",
      url: "http://127.0.0.1:3003/api/harbor/x402.pay",
      headers: { "x-forwarded-host": "attacker.example" },
    }), context("x402.pay"));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_FORBIDDEN_ORIGIN");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(["account.status", "policy.get"] as const)("requires wallet-bound authorization for %s reads", async (op) => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => false,
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request(JSON.stringify({ owner: ACCOUNT, network: "testnet" })),
      context(op),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("requires wallet-bound authorization for onboarding readiness", async () => {
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => false,
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request(JSON.stringify({
        owner: ACCOUNT,
        network: "testnet",
        expected_policy: DEFAULT_POLICY,
        trust_set_hash: "A".repeat(64),
      })),
      context("onboarding.readiness"),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects mutation requests that omit browser Origin metadata", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request(
        JSON.stringify({ build_id: "build-1", idempotency_key: "intent-1" }),
        { omitOrigin: true },
      ),
      context("tx.execute"),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_FORBIDDEN_ORIGIN");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(["venues.list", "account.status"] as const)(
    "rejects %s reads that omit browser Origin metadata",
    async (op) => {
      const upstreamFetch = vi.fn();
      const handler = createHarborProxyHandler({
        env: ENVIRONMENT,
        fetch: fetchDependency(upstreamFetch),
      });
      const body = op === "account.status"
        ? JSON.stringify({ owner: ACCOUNT, network: "testnet" })
        : "{}";

      const response = await handler(
        request(body, { omitOrigin: true }),
        context(op),
      );

      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_FORBIDDEN_ORIGIN");
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("keeps non-account public reads available without wallet binding", async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        ok: true,
        data: [],
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "registry",
      }),
    );
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: () => false,
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}"), context("venues.list"));

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("never forwards to live Harbor while the shared server mode is mock", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, HARBOR_MOCK: "1" },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request("{}"), context("venues.list"));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_MOCK_DISABLED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("adds only the server-side key and preserves the upstream envelope", async () => {
    const envelope = {
      ok: true,
      data: { status: "validated", hash: "ABC123" },
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "ledger:123",
    };
    const upstreamBody = JSON.stringify(envelope);
    const upstreamFetch = vi.fn(async () =>
      new Response(upstreamBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "harbor-request-1",
        },
      }),
    );
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const body = JSON.stringify({ build_id: "build-1", idempotency_key: "intent-1" });

    const response = await handler(
      request(body, { authorization: "Bearer browser-supplied-key" }),
      context("tx.execute"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("harbor-request-1");
    expect(await response.text()).toBe(upstreamBody);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://harbor.example/api/ops/tx.execute");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer pilot:test-token",
    );
    expect(new Headers(init.headers).get("authorization")).not.toContain(
      "browser-supplied-key",
    );
  });

  it("uses the configured public origin behind an internal HTTP reverse proxy", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({ ok: true, data: [] }));
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}", {
      url: "http://next-internal:3000/api/harbor/venues.list",
      origin: "https://pilot.example",
      headers: {
        forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    }), context("venues.list"));

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, "https://pilot.example"],
    ["", "https://pilot.example"],
    ["http://pilot.example", "https://pilot.example"],
    ["https://127.0.0.1", "https://pilot.example"],
    ["https://pilot.example/path", "https://pilot.example"],
    ["https://pilot.example/", "https://pilot.example"],
    ["https://pilot.example", "https://foreign.example"],
  ] as const)(
    "does not forward for hosted public origin config %s and request Origin %s",
    async (publicOrigin, origin) => {
      const upstreamFetch = vi.fn();
      const handler = createHarborProxyHandler({
        env: { ...ENVIRONMENT, PILOT_PUBLIC_ORIGIN: publicOrigin },
        fetch: fetchDependency(upstreamFetch),
      });
      const response = await handler(request("{}", {
        url: "http://next-internal:3000/api/harbor/venues.list",
        origin,
        headers: {
          forwarded: "for=203.0.113.7;proto=https;host=pilot.example",
          "x-forwarded-host": "pilot.example",
          "x-forwarded-proto": "https",
        },
      }), context("venues.list"));

      expect([403, 503]).toContain(response.status);
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("pins local-wallet forwarding to the reviewed Harbor and Pilot origins", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: true,
      data: [],
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "registry",
    }));
    const handler = createHarborProxyHandler({
      env: {
        HARBOR_API_KEY: "pilot:test-token",
        HARBOR_MOCK: "0",
        HARBOR_URL: "http://127.0.0.1:8791",
        NEXT_PUBLIC_DEV_SIGNER: "1",
        PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      },
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}", {
      origin: "http://127.0.0.1:3003",
      url: "http://127.0.0.1:3003/api/harbor/venues.list",
    }), context("venues.list"));

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const forwarded = upstreamFetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(forwarded[0]?.[0]).toBe(
      "http://127.0.0.1:8791/api/ops/venues.list",
    );
  });

  it("pins the isolated profile to only the fixed .2 Pilot and Harbor origins", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: true,
      data: [],
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "registry",
    }));
    const environment: HarborProxyEnvironment = {
      HARBOR_API_KEY: "pilot:isolated-token",
      HARBOR_MOCK: "0",
      HARBOR_URL: "http://127.0.0.2:8791",
      NEXT_PUBLIC_DEV_SIGNER: "1",
      NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
    };
    const handler = createHarborProxyHandler({
      env: environment,
      fetch: fetchDependency(upstreamFetch),
    });

    const accepted = await handler(request("{}", {
      origin: "http://127.0.0.2:3003",
      url: "http://127.0.0.2:3003/api/harbor/venues.list",
    }), context("venues.list"));
    expect(accepted.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect((upstreamFetch.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0]).toBe(
      "http://127.0.0.2:8791/api/ops/venues.list",
    );

    upstreamFetch.mockClear();
    const crossed = await handler(request("{}", {
      origin: "http://127.0.0.1:3003",
      url: "http://127.0.0.1:3003/api/harbor/venues.list",
    }), context("venues.list"));
    expect(crossed.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { forwarded: "for=127.0.0.1,for=203.0.113.7" },
    { "x-forwarded-host": "127.0.0.1:3003,pilot.example" },
    { "x-forwarded-proto": "http,https" },
    { "x-forwarded-port": "3003,443" },
  ])("rejects ambiguous local forwarding metadata before Harbor access: %o", async (headers) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: {
        HARBOR_API_KEY: "pilot:test-token",
        HARBOR_MOCK: "0",
        HARBOR_URL: "http://127.0.0.1:8791",
        NEXT_PUBLIC_DEV_SIGNER: "1",
        PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request("{}", {
      origin: "http://127.0.0.1:3003",
      url: "http://127.0.0.1:3003/api/harbor/venues.list",
      headers,
    }), context("venues.list"));
    expect(response.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://harbor.example",
    "http://localhost:8791",
    "http://[::1]:8791",
    "https://127.0.0.1:8791",
    "http://127.0.0.1:8792",
    "http://127.0.0.1:8791/api",
    "http://127.0.0.1:8791?key=bad",
    "http://127.0.0.1:8791/#bad",
    "http://user:password@127.0.0.1:8791",
    "http://169.254.169.254:8791",
    "not a url",
  ])("does not forward the local key to an unreviewed Harbor URL: %s", async (harborUrl) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: {
        HARBOR_API_KEY: "pilot:test-token",
        HARBOR_MOCK: "0",
        HARBOR_URL: harborUrl,
        NEXT_PUBLIC_DEV_SIGNER: "1",
        PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request("{}", {
      origin: "http://127.0.0.1:3003",
      url: "http://127.0.0.1:3003/api/harbor/venues.list",
    }), context("venues.list"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("pilot:test-token");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://pilot.example/api/harbor/venues.list",
    "http://127.0.0.1:3002/api/harbor/venues.list",
    "http://127.0.0.1:3004/api/harbor/venues.list",
    "http://127.0.0.1:3005/api/harbor/venues.list",
    "http://localhost:3003/api/harbor/venues.list",
  ])("does not forward from an unreviewed local-wallet request URL: %s", async (url) => {
    const upstreamFetch = vi.fn();
    const requestUrl = new URL(url);
    const handler = createHarborProxyHandler({
      env: {
        HARBOR_API_KEY: "pilot:test-token",
        HARBOR_MOCK: "0",
        HARBOR_URL: "http://127.0.0.1:8791",
        NEXT_PUBLIC_DEV_SIGNER: "1",
        PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request("{}", {
      origin: requestUrl.origin,
      url,
    }), context("venues.list"));
    expect(response.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    { HARBOR_URL: "http://harbor.example", NEXT_PUBLIC_DEV_SIGNER: "0" },
    { HARBOR_URL: "https://127.0.0.1:8791", NEXT_PUBLIC_DEV_SIGNER: "0" },
    { HARBOR_URL: "https://harbor.example", NEXT_PUBLIC_DEV_SIGNER: "1" },
  ])("does not forward an invalid hosted profile: %o", async (profile) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, ...profile },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request("{}"), context("venues.list"));
    expect(response.status).toBe(503);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "local", "HOSTED"])(
    "does not forward when the deployment profile is missing or unknown: %s",
    async (profile) => {
      const upstreamFetch = vi.fn();
      const handler = createHarborProxyHandler({
        env: { ...ENVIRONMENT, PILOT_DEPLOYMENT_PROFILE: profile },
        fetch: fetchDependency(upstreamFetch),
      });
      const response = await handler(request("{}"), context("venues.list"));
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain("pilot:test-token");
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("forwards the exact Devnet owner and approval relay shapes", async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { status: "pending", hash: HASH },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }),
    );
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, EXEC_NETWORK: "devnet" },
      fetch: fetchDependency(upstreamFetch),
    });
    const calls = [
      ["tx.submit", { tx_blob: "1200002280000000", network: "devnet" }],
      ["tx.status", { hash: HASH, network: "devnet", account: ACCOUNT }],
      ["tx.submit", { tx_blob: "1200002280000001", approval_id: "approval-vault-1", network: "devnet" }],
      ["tx.status", { hash: HASH }],
    ] as const;

    for (const [op, args] of calls) {
      const response = await handler(request(JSON.stringify(args)), context(op));
      expect(response.status).toBe(200);
    }

    const forwarded = upstreamFetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(forwarded.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual(
      calls.map(([op, args]) => [
        `https://harbor.example/api/ops/${op}`,
        args,
      ]),
    );
  });

  it("rejects missing or client-invented direct-submit routing fields", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, EXEC_NETWORK: "devnet" },
      fetch: fetchDependency(upstreamFetch),
    });

    for (const args of [
      { tx_blob: "DIRECT-DELEGATESET" },
      { tx_blob: "DIRECT-DELEGATESET", network: "devnet", account: ACCOUNT },
    ]) {
      const response = await handler(request(JSON.stringify(args)), context("tx.submit"));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401 },
    { status: 404 },
    { status: 409 },
    { status: 429 },
  ])("preserves Harbor's $status status", async ({ status }) => {
    const envelope = JSON.stringify({
      ok: false,
      error: { service: "harbor", kind: "error", message: "upstream response" },
    });
    const upstreamFetch = vi.fn(async () =>
      new Response(envelope, {
        status,
        headers: { "content-type": "application/json", "retry-after": "3" },
      }),
    );
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}"), context("venues.list"));

    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe(envelope);
  });

  it.each(["tx", ".execute", "tx.", "tx/execute", "tx%2Fexecute", "../tx.execute"])(
    "rejects unsafe operation path %s before calling Harbor",
    async (op) => {
      const upstreamFetch = vi.fn();
      const handler = createHarborProxyHandler({
        env: ENVIRONMENT,
        fetch: fetchDependency(upstreamFetch),
      });

      const response = await handler(request("{}"), context(op));

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_OP");
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects syntactically valid but unknown operations before calling Harbor", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}"), context("unknown.operation"));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_OP");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("validates operation arguments with the shared Harbor schema", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const missing = await handler(request("{}"), context("tx.execute"));
    const extra = await handler(
      request(JSON.stringify({ build_id: "build-1", idempotency_key: "intent-1", extra: true })),
      context("tx.execute"),
    );

    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
    expect(extra.status).toBe(400);
    expect((await extra.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("lets the lower-level proxy forward an exact authorized local Testnet x402 contract", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: true,
      data: {
        status: "settlement_unknown",
        payment_id: "payment-unknown",
        idempotency_key: "pilot-x402:operation-402-0001",
        owner: ACCOUNT,
        network: "testnet",
        resource: "compare",
        request_fingerprint: "x402-v1:proxy-fixture",
        tx_hash: "B".repeat(64),
        last_ledger_sequence: 12_400,
        retry_after_seconds: 5,
      },
      asOf: "2026-10-19T12:00:00.000Z",
      asOfBasis: "local Testnet worker",
    }));
    const authorizeOperation = vi.fn(() => true);
    const handler = createProductionHarborProxyHandler({
      authorizeOperation,
      env: LOCAL_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const args = {
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:operation-402-0001",
    };
    const response = await handler(x402Request(JSON.stringify(args)), context("x402.pay"));
    expect(response.status).toBe(200);
    expect(authorizeOperation).toHaveBeenCalledWith(expect.any(Request), "x402.pay", args);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8791/api/ops/x402.pay");
    expect(JSON.parse(String(init.body))).toEqual(args);
  });

  it("lets the lower-level proxy route an authorized isolated x402 contract", async () => {
    const args = {
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:isolated-paired-fixture-1",
    };
    const verified = {
      ok: true,
      data: {
        status: "delivered",
        payment_id: "payment-isolated-1",
        idempotency_key: args.idempotency_key,
        owner: ACCOUNT,
        network: "testnet",
        resource: "compare",
        invoice_id: "invoice-isolated-1",
        amount_drops: "5000",
        fee_drops: "12",
        payer: "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn",
        pay_to: X402_PAY_TO,
        tx_hash: "B".repeat(64),
        validated_ledger_index: 123,
        merchant: {
          status: 200,
          content_type: "application/json",
          body: { comparison: ["dex", "amm"] },
        },
      },
      asOf: "2026-10-20T12:00:00.000Z",
      asOfBasis: "validated Testnet fixture",
    };
    const upstreamFetch = vi.fn(async () => Response.json(verified));
    const authorizeOperation = vi.fn(() => true);
    const handler = createProductionHarborProxyHandler({
      authorizeOperation,
      env: ISOLATED_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      isolatedX402Request(JSON.stringify(args)),
      context("x402.pay"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(verified);
    expect(authorizeOperation).toHaveBeenCalledWith(expect.any(Request), "x402.pay", args);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.2:8792/api/ops/x402.pay");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${ISOLATED_X402_ENVIRONMENT.HARBOR_X402_API_KEY}`,
    );
    expect(new Headers(init.headers).get("authorization")).not.toContain(
      String(ISOLATED_X402_ENVIRONMENT.HARBOR_API_KEY),
    );
    expect(JSON.parse(String(init.body))).toEqual(args);
  });

  it("does not dispatch exact x402 args from a valid isolated wallet session", async () => {
    const session = sealWalletSession({
      version: 1,
      account: ACCOUNT,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
      deployment_profile: "local-wallet-isolated-v1",
    }, SESSION_SECRET, ISOLATED_X402_ENVIRONMENT);
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: ISOLATED_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const priorSecret = process.env.SESSION_SECRET;
    const priorNetwork = process.env.EXEC_NETWORK;
    const priorProfile = process.env.PILOT_DEPLOYMENT_PROFILE;
    try {
      process.env.SESSION_SECRET = SESSION_SECRET;
      process.env.EXEC_NETWORK = "testnet";
      process.env.PILOT_DEPLOYMENT_PROFILE = "local-wallet";
      const response = await handler(isolatedX402Request(JSON.stringify({
        owner: ACCOUNT,
        network: "testnet",
        resource: "compare",
        pay_to: X402_PAY_TO,
        max_price_drops: "5000",
        idempotency_key: "pilot-x402:isolated-session-must-not-authorize-1",
      }), {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}`,
        },
      }), context("x402.pay"));

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_UNAUTHORIZED");
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      if (priorSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = priorSecret;
      if (priorNetwork === undefined) delete process.env.EXEC_NETWORK;
      else process.env.EXEC_NETWORK = priorNetwork;
      if (priorProfile === undefined) delete process.env.PILOT_DEPLOYMENT_PROFILE;
      else process.env.PILOT_DEPLOYMENT_PROFILE = priorProfile;
    }
  });

  it("forwards default-off owner-review prepare only in the exact local mock profile", async () => {
    const wallet = Wallet.generate();
    const body = {
      owner: wallet.classicAddress,
      network: "testnet",
      max_price_drops: "5000",
      idempotency_key: "owner-review-operation-proxy-1",
    };
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: true,
      data: { status: "awaiting_approval" },
      asOf: "2026-10-24T12:00:00.000Z",
      asOfBasis: "local-mock-owner-review",
    }));
    const handler = createHarborProxyHandler({
      env: LOCAL_OWNER_REVIEW_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(
      ownerReviewRequest("x402.ownerReviewPrepare", JSON.stringify(body)),
      context("x402.ownerReviewPrepare"),
    );
    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8791/api/ops/x402.ownerReviewPrepare");
    expect(JSON.parse(String(init.body))).toEqual(body);

    const disabledFetch = vi.fn();
    const disabled = createHarborProxyHandler({
      env: { ...LOCAL_OWNER_REVIEW_ENVIRONMENT, HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED: "false" },
      fetch: fetchDependency(disabledFetch),
    });
    const blocked = await disabled(
      ownerReviewRequest("x402.ownerReviewPrepare", JSON.stringify(body)),
      context("x402.ownerReviewPrepare"),
    );
    expect(blocked.status).toBe(403);
    expect(disabledFetch).not.toHaveBeenCalled();
  });

  it("binds owner-review submission to the wallet session and signed Payment account", async () => {
    const owner = Wallet.generate();
    const impostor = Wallet.generate();
    const session = sealWalletSession({
      version: 1,
      account: owner.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, LOCAL_OWNER_REVIEW_ENVIRONMENT);
    const payment = {
      TransactionType: "Payment",
      Account: owner.classicAddress,
      Destination: X402_PAY_TO,
      Amount: "5000",
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 1_015,
    } satisfies Payment;
    const base = {
      owner: owner.classicAddress,
      network: "testnet",
      idempotency_key: "owner-review-operation-proxy-2",
      approval_id: "owner-review-approval-proxy-2",
      approval_digest: "A".repeat(64),
    };
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: true,
      data: { status: "settlement_unknown" },
      asOf: "2026-10-24T12:00:00.000Z",
      asOfBasis: "local-mock-owner-review",
    }));
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: LOCAL_OWNER_REVIEW_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const priorEnvironment = {
      EXEC_NETWORK: process.env.EXEC_NETWORK,
      NEXT_PUBLIC_PILOT_BUILD_MARKER: process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER,
      PILOT_DEPLOYMENT_PROFILE: process.env.PILOT_DEPLOYMENT_PROFILE,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };
    try {
      process.env.SESSION_SECRET = SESSION_SECRET;
      process.env.EXEC_NETWORK = "testnet";
      process.env.PILOT_DEPLOYMENT_PROFILE = "local-wallet";
      delete process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER;
      for (const [blob, expected] of [
        [impostor.sign({ ...payment, Account: impostor.classicAddress }).tx_blob, 401],
        [owner.sign(payment).tx_blob, 200],
      ] as const) {
        const response = await handler(ownerReviewRequest(
          "x402.ownerReviewSubmit",
          JSON.stringify({ ...base, signed_blob: blob }),
          { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
        ), context("x402.ownerReviewSubmit"));
        expect(response.status).toBe(expected);
      }
      expect(upstreamFetch).toHaveBeenCalledTimes(1);
    } finally {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("forwards only the six exact local capability operations for the wallet session", async () => {
    const owner = Wallet.generate();
    const session = sealWalletSession({
      version: 1,
      account: owner.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, LOCAL_CAPABILITY_ENVIRONMENT);
    const operations = capabilityBodies(owner);
    const upstreamFetch = vi.fn(async () => Response.json({ ok: true, data: { simulated: true } }));
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: LOCAL_CAPABILITY_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    await withLocalWalletProcessEnvironment(async () => {
      for (const [op, body] of operations) {
        const response = await handler(capabilityRequest(
          op,
          JSON.stringify(body),
          { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
        ), context(op));
        expect(response.status, op).toBe(200);
      }
    });

    expect(upstreamFetch).toHaveBeenCalledTimes(operations.length);
    for (const [index, [op, body]] of operations.entries()) {
      const [url, init] = upstreamFetch.mock.calls[index] as unknown as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:8791/api/ops/${op}`);
      expect(JSON.parse(String(init.body))).toEqual(body);
    }
  });

  it.each([
    ["account switch", "testnet", Wallet.generate().classicAddress],
    ["network switch", "devnet", ACCOUNT],
  ])("blocks a capability %s before Harbor forwarding", async (_label, sessionNetwork, requestAccount) => {
    const session = sealWalletSession({
      version: 1,
      account: ACCOUNT,
      network: sessionNetwork as "testnet" | "devnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, LOCAL_CAPABILITY_ENVIRONMENT);
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: LOCAL_CAPABILITY_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    await withLocalWalletProcessEnvironment(async () => {
      const response = await handler(capabilityRequest(
        "capability.status",
        JSON.stringify({
          account: requestAccount,
          network: "testnet",
          capability_ref: `cap_v1_${"A".repeat(32)}`,
        }),
        { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      ), context("capability.status"));
      expect(response.status).toBe(401);
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects a capability owner proof from a switched account", async () => {
    const owner = Wallet.generate();
    const impostor = Wallet.generate();
    const session = sealWalletSession({
      version: 1,
      account: owner.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, LOCAL_CAPABILITY_ENVIRONMENT);
    const impostorActivation = capabilityBodies(impostor)[1][1];
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: LOCAL_CAPABILITY_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    await withLocalWalletProcessEnvironment(async () => {
      const response = await handler(capabilityRequest(
        "capability.activate",
        JSON.stringify({ ...impostorActivation, account: owner.classicAddress }),
        { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      ), context("capability.activate"));
      expect(response.status).toBe(401);
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects widened capability scope before authorization or forwarding", async () => {
    const authorizeOperation = vi.fn(() => true);
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation,
      env: LOCAL_CAPABILITY_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const body = capabilityBodies(Wallet.generate())[0][1];
    const response = await handler(capabilityRequest(
      "capability.prepare",
      JSON.stringify({ ...body, service: "external.catalog", url: "http://127.0.0.1:9999" }),
    ), context("capability.prepare"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("fails closed for disabled and unsupported capability operations", async () => {
    const body = JSON.stringify({
      account: ACCOUNT,
      network: "testnet",
      capability_ref: `cap_v1_${"A".repeat(32)}`,
    });
    const upstreamFetch = vi.fn();
    const disabled = createHarborProxyHandler({
      env: { ...LOCAL_CAPABILITY_ENVIRONMENT, HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED: "false" },
      fetch: fetchDependency(upstreamFetch),
    });
    const disabledResponse = await disabled(
      capabilityRequest("capability.status", body),
      context("capability.status"),
    );
    expect(disabledResponse.status).toBe(403);
    expect((await disabledResponse.json()).error.code)
      .toBe("HARBOR_PROXY_CAPABILITY_LOCAL_TESTNET_REQUIRED");

    const unsupported = await disabled(
      capabilityRequest("capability.delete", body),
      context("capability.delete"),
    );
    expect(unsupported.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("forwards only exact local work-agreement operations bound to the wallet session", async () => {
    const owner = Wallet.generate();
    const counterparty = Wallet.generate();
    const session = sealWalletSession({
      version: 1,
      account: owner.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, LOCAL_WORK_AGREEMENT_ENVIRONMENT);
    const base = {
      owner: owner.classicAddress,
      network: "testnet",
      agreement_id: "agreement-proxy-0001",
    } as const;
    const signedBlob = owner.sign({
      TransactionType: "EscrowCreate",
      Account: owner.classicAddress,
      Destination: counterparty.classicAddress,
      Amount: "2500000",
      FinishAfter: 900_000_000,
      CancelAfter: 900_000_600,
      Fee: "12",
      Sequence: 42,
      LastLedgerSequence: 1_050,
    }).tx_blob;
    const operations = [
      ["workAgreement.prepare", {
        ...base,
        action: "create",
        idempotency_key: "agreement-idempotency-0001",
        approval_expires_at: "2026-10-24T12:05:00.000Z",
        terms: {
          counterparty: counterparty.classicAddress,
          amount_drops: "2500000",
          finish_after: 900_000_000,
          cancel_after: 900_000_600,
        },
      }],
      ["workAgreement.submit", {
        ...base,
        approval_id: "agreement-approval-0001",
        idempotency_key: "agreement-idempotency-0001",
        attempt_id: "agreement-attempt-0001",
        signed_blob: signedBlob,
      }],
      ["workAgreement.recover", {
        ...base,
        approval_id: "agreement-approval-0001",
        idempotency_key: "agreement-idempotency-0001",
      }],
      ["workAgreement.reject", {
        ...base,
        approval_id: "agreement-approval-0001",
        idempotency_key: "agreement-idempotency-0001",
      }],
      ["workAgreement.status", base],
    ] as const;
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: true,
      data: { simulation: true, provenance: "local-mock-simulated-settlement" },
    }));
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: LOCAL_WORK_AGREEMENT_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    await withLocalWalletProcessEnvironment(async () => {
      for (const [op, body] of operations) {
        const response = await handler(workAgreementRequest(
          op,
          JSON.stringify(body),
          { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
        ), context(op));
        expect(response.status, op).toBe(200);
      }
    });

    expect(upstreamFetch).toHaveBeenCalledTimes(operations.length);
    for (const [index, [op, body]] of operations.entries()) {
      const [url, init] = upstreamFetch.mock.calls[index] as unknown as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:8791/api/ops/${op}`);
      expect(JSON.parse(String(init.body))).toEqual(body);
    }
  });

  it("rejects switched accounts, non-escrow blobs, widened fields, and disabled agreement mode", async () => {
    const owner = Wallet.generate();
    const counterparty = Wallet.generate();
    const session = sealWalletSession({
      version: 1,
      account: owner.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SESSION_SECRET, LOCAL_WORK_AGREEMENT_ENVIRONMENT);
    const base = {
      owner: owner.classicAddress,
      network: "testnet",
      agreement_id: "agreement-proxy-0002",
    } as const;
    const paymentBlob = owner.sign({
      TransactionType: "Payment",
      Account: owner.classicAddress,
      Destination: counterparty.classicAddress,
      Amount: "2500000",
      Fee: "12",
      Sequence: 42,
      LastLedgerSequence: 1_050,
    }).tx_blob;
    const upstreamFetch = vi.fn();
    const handler = createProductionHarborProxyHandler({
      authorizeOperation: authorizeBrowserHarborOperation,
      env: LOCAL_WORK_AGREEMENT_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    await withLocalWalletProcessEnvironment(async () => {
      const nonEscrow = await handler(workAgreementRequest(
        "workAgreement.submit",
        JSON.stringify({
          ...base,
          approval_id: "agreement-approval-0002",
          idempotency_key: "agreement-idempotency-0002",
          attempt_id: "agreement-attempt-0002",
          signed_blob: paymentBlob,
        }),
        { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      ), context("workAgreement.submit"));
      expect(nonEscrow.status).toBe(401);

      const widened = await handler(workAgreementRequest(
        "workAgreement.status",
        JSON.stringify({ ...base, relay_url: "http://127.0.0.1:9999" }),
        { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      ), context("workAgreement.status"));
      expect(widened.status).toBe(400);

      const switched = await handler(workAgreementRequest(
        "workAgreement.status",
        JSON.stringify({ ...base, owner: counterparty.classicAddress }),
        { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      ), context("workAgreement.status"));
      expect(switched.status).toBe(401);
    });

    const disabled = createHarborProxyHandler({
      env: { ...LOCAL_WORK_AGREEMENT_ENVIRONMENT, HARBOR_LOCAL_WORK_AGREEMENT_ENABLED: "false" },
      fetch: fetchDependency(upstreamFetch),
    });
    const blocked = await disabled(
      workAgreementRequest("workAgreement.status", JSON.stringify(base)),
      context("workAgreement.status"),
    );
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code)
      .toBe("HARBOR_PROXY_WORK_AGREEMENT_LOCAL_TESTNET_REQUIRED");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(["4999", "5001", "100000"])(
    "rejects the isolated x402 %s-drop authorization before Harbor dispatch",
    async (maxPriceDrops) => {
      const upstreamFetch = vi.fn();
      const authorizeOperation = vi.fn(() => true);
      const handler = createProductionHarborProxyHandler({
        authorizeOperation,
        env: ISOLATED_X402_ENVIRONMENT,
        fetch: fetchDependency(upstreamFetch),
      });

      const response = await handler(isolatedX402Request(JSON.stringify({
        owner: ACCOUNT,
        network: "testnet",
        resource: "compare",
        pay_to: X402_PAY_TO,
        max_price_drops: maxPriceDrops,
        idempotency_key: `pilot-x402:isolated-price-${maxPriceDrops}`,
      })), context("x402.pay"));

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
      expect(authorizeOperation).not.toHaveBeenCalled();
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a changed receiver", { pay_to: ACCOUNT }],
    ["the legacy request without a receiver", {}],
  ])("rejects isolated x402 with %s before Harbor dispatch", async (_label, receiver) => {
    const upstreamFetch = vi.fn();
    const authorizeOperation = vi.fn(() => true);
    const handler = createProductionHarborProxyHandler({
      authorizeOperation,
      env: ISOLATED_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(isolatedX402Request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:isolated-receiver-denial-1",
      ...receiver,
    })), context("x402.pay"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing x402 key", { HARBOR_X402_API_KEY: undefined }],
    ["same principal", { HARBOR_X402_API_KEY: `isolated-trading:${"X".repeat(32)}` }],
    ["same bearer token", { HARBOR_X402_API_KEY: `isolated-x402:${"T".repeat(32)}` }],
    ["legacy target", { HARBOR_X402_URL: "http://127.0.0.1:8791" }],
    ["trading target", { HARBOR_X402_URL: "http://127.0.0.2:8791" }],
    ["mainnet process", { EXEC_NETWORK: "mainnet" }],
  ] as const)("does not dispatch isolated x402 with %s", async (_label, patch) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ISOLATED_X402_ENVIRONMENT, ...patch },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(isolatedX402Request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:isolated-denial-1",
    })), context("x402.pay"));
    expect([403, 503]).toContain(response.status);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["remote Harbor", { ...ENVIRONMENT, EXEC_NETWORK: "testnet" }, undefined],
    ["wrong server network", { ...ENVIRONMENT, HARBOR_URL: "http://127.0.0.1:8791", EXEC_NETWORK: "devnet" }, undefined],
    ["missing browser origin", { ...ENVIRONMENT, HARBOR_URL: "http://127.0.0.1:8791", EXEC_NETWORK: "testnet" }, true],
  ])("blocks x402 with %s before any upstream request", async (_label, env, omitOrigin) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({ env, fetch: fetchDependency(upstreamFetch) });
    const response = await handler(request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:operation-402-0001",
    }), { omitOrigin }), context("x402.pay"));
    expect(response.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects client-supplied x402 URL, headers, or body fields", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, HARBOR_URL: "http://127.0.0.1:8791", EXEC_NETWORK: "testnet" },
      fetch: fetchDependency(upstreamFetch),
    });
    for (const extra of [
      { url: "https://merchant.invalid" },
      { headers: { authorization: "attacker" } },
      { body: { arbitrary: true } },
    ]) {
      const response = await handler(request(JSON.stringify({
        owner: ACCOUNT,
        network: "testnet",
        resource: "compare",
        pay_to: X402_PAY_TO,
        max_price_drops: "5000",
        idempotency_key: "pilot-x402:operation-402-0001",
        ...extra,
      })), context("x402.pay"));
      expect(response.status).toBe(400);
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:8791",
    "http://127.0.0.1:8790",
    "https://127.0.0.1:8791",
    "http://127.0.0.1:8791/worker",
    "http://127.0.0.1:8791/?query=1",
    "http://127.0.0.1:8791/#fragment",
    "http://user@127.0.0.1:8791",
  ])("rejects non-canonical x402 worker URL %s before forwarding", async (url) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, HARBOR_URL: url, EXEC_NETWORK: "testnet" },
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:operation-402-0001",
    })), context("x402.pay"));
    expect(response.status).toBe(403);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized content-length", () => new Response("{}", { headers: { "content-length": "262145" } })],
    ["corrupt content-length", () => new Response("{}", { headers: { "content-length": "invalid" } })],
    ["underreported content-length", () => new Response("{}", { headers: { "content-length": "1" } })],
    ["chunked overflow", () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200_000));
        controller.enqueue(new Uint8Array(70_000));
        controller.close();
      },
    }))],
  ] as const)("rejects x402 upstream %s without returning its body", async (_label, responseFactory) => {
    const upstreamFetch = vi.fn(async () => responseFactory());
    const handler = createHarborProxyHandler({
      env: LOCAL_X402_ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const response = await handler(x402Request(JSON.stringify({
      owner: ACCOUNT,
      network: "testnet",
      resource: "compare",
      pay_to: X402_PAY_TO,
      max_price_drops: "5000",
      idempotency_key: "pilot-x402:operation-402-0001",
    })), context("x402.pay"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_RESPONSE_TOO_LARGE");
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("forwards the forced-owner execute contract with its stable idempotency key", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({
      ok: false,
      error: {
        service: "tx.execute",
        kind: "error",
        message: "fixture refusal",
        code: "FIXTURE_REFUSAL",
      },
    }, { status: 409 }));
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const args = {
      build_id: "build-1",
      idempotency_key: "p-live-acquire-rlusd-00000000-0000-4000-8000-000000000001",
      require_owner_approval: true,
    };

    const response = await handler(request(JSON.stringify(args)), context("tx.execute"));

    expect(response.status).toBe(409);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [, init] = upstreamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(args);
  });

  it("accepts same-origin requests and rejects a foreign Origin", async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        ok: true,
        data: [],
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "registry",
      }),
    );
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const sameOrigin = await handler(
      request("{}", { origin: "https://pilot.example" }),
      context("venues.list"),
    );
    const foreignOrigin = await handler(
      request("{}", { origin: "https://attacker.example" }),
      context("venues.list"),
    );

    expect(sameOrigin.status).toBe(200);
    expect(foreignOrigin.status).toBe(403);
    expect((await foreignOrigin.json()).error.code).toBe(
      "HARBOR_PROXY_FORBIDDEN_ORIGIN",
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["account.link", { owner: ACCOUNT, network: "mainnet" }, 400, "HARBOR_PROXY_INVALID_ARGS"],
    ["account.revoke", { owner: ACCOUNT, network: "mainnet" }, 400, "HARBOR_PROXY_INVALID_ARGS"],
    ["policy.set", { owner: ACCOUNT, network: "mainnet", policy: DEFAULT_POLICY }, 400, "HARBOR_PROXY_INVALID_ARGS"],
    [
      "tx.swap",
      {
        account: ACCOUNT,
        network: "mainnet",
        sell: RLUSD,
        buy: XRP,
        amount: { ...RLUSD, value: "50" },
        side: "sell",
        max_slippage_bps: 100,
      }, 403, "HARBOR_PROXY_MAINNET_MUTATION_BLOCKED",
    ],
  ])("blocks mainnet mutation %s before calling Harbor", async (op, args, expectedStatus, expectedCode) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request(JSON.stringify(args)), context(op as string));

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.code).toBe(expectedCode);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("allows a read-only mainnet operation", async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { account: ACCOUNT },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger:123",
      }),
    );
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, EXEC_NETWORK: "mainnet" },
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request(JSON.stringify({ account: ACCOUNT, network: "mainnet" })),
      context("ledger.account.info"),
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tx.execute", { build_id: "build-1", idempotency_key: "intent-1" }, 403, "HARBOR_PROXY_MAINNET_MUTATION_BLOCKED"],
    ["tx.submit", { tx_blob: "1200002280000000", network: "mainnet" }, 400, "HARBOR_PROXY_INVALID_ARGS"],
  ])("blocks opaque mutation %s when the server execution network is mainnet", async (op, args, expectedStatus, expectedCode) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: { ...ENVIRONMENT, EXEC_NETWORK: "mainnet" },
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request(JSON.stringify(args)), context(op as string));

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.code).toBe(expectedCode);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["tx.execute", "mainnet"],
    ["tx.execute", "testnet"],
    ["tx.execute", "devnet"],
    ["tx.execute", "lending-devnet"],
  ])(
    "%s rejects unsupported browser-supplied network %s",
    async (op, network) => {
      const upstreamFetch = vi.fn();
      const handler = createHarborProxyHandler({
        env: ENVIRONMENT,
        fetch: fetchDependency(upstreamFetch),
      });
      const args = { build_id: "build-1", idempotency_key: "intent-1", network };

      const response = await handler(request(JSON.stringify(args)), context(op));

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("HARBOR_PROXY_INVALID_ARGS");
      expect(upstreamFetch).not.toHaveBeenCalled();
    },
  );

  it("requires JSON object arguments", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    for (const body of ["", "not-json", "null", "[]", '{"__proto__":{"polluted":true}}']) {
      const response = await handler(request(body), context("tx.execute"));
      expect(response.status).toBe(400);
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("requires an application/json media type", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request("{}", { contentType: "text/plain" }),
      context("venues.list"),
    );

    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe(
      "HARBOR_PROXY_UNSUPPORTED_MEDIA_TYPE",
    );
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized requests without forwarding them", async () => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const oversized = JSON.stringify({ value: "x".repeat(1_048_576) });

    const response = await handler(request(oversized), context("policy.set"));

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_REQUEST_TOO_LARGE");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("returns promptly when oversized Harbor stream cancellation never settles", async () => {
    const upstreamFetch = vi.fn();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel,
    });
    const streamed = new Request("https://pilot.example/api/harbor/policy.set", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://pilot.example",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await handler(streamed, context("policy.set"));

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_REQUEST_TOO_LARGE");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { HARBOR_URL: "https://harbor.example" },
    { HARBOR_API_KEY: "pilot:test-token" },
    {
      HARBOR_API_KEY: "pilot:test-token",
      HARBOR_URL: "file:///tmp/not-an-upstream",
    },
  ])("fails closed when server-side Harbor configuration is invalid", async (env) => {
    const upstreamFetch = vi.fn();
    const handler = createHarborProxyHandler({
      env,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}"), context("venues.list"));
    const responseBody = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(responseBody).not.toContain("pilot:test-token");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("sanitizes upstream failures and does not retry a mutation", async () => {
    const upstreamFetch = vi.fn(async () => {
      throw new Error("failed with Bearer pilot:test-token at https://harbor.example");
    });
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(
      request(JSON.stringify({ build_id: "build-1", idempotency_key: "intent-1" })),
      context("tx.execute"),
    );
    const responseBody = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(responseBody).not.toContain("pilot:test-token");
    expect(responseBody).not.toContain("harbor.example");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("redacts the server key if a faulty upstream reflects it", async () => {
    const upstreamFetch = vi.fn(async () =>
      new Response(
        JSON.stringify(
        {
          ok: false,
          error: {
            service: "harbor",
            kind: "error",
            message: "received pilot:test-token",
          },
        }),
        { status: 500, statusText: "Pilot pilot:test-token failure", headers: { "x-request-id": "pilot:test-token" } },
      ),
    );
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });

    const response = await handler(request("{}"), context("venues.list"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("pilot:test-token");
    expect(body).toContain("[redacted]");
    expect(response.headers.get("x-request-id")).toBe("[redacted]");
    expect(response.statusText).not.toContain("pilot:test-token");
  });

  it("forwards repeated idempotent requests independently without caching", async () => {
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { status: "validated", hash: "SAME_RESULT" },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger:123",
      }),
    );
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
    });
    const body = JSON.stringify({ build_id: "build-1", idempotency_key: "intent-1" });

    const first = await handler(request(body), context("tx.execute"));
    const repeated = await handler(request(body), context("tx.execute"));

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(await first.json()).toEqual(await repeated.json());
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a slow upstream and returns a gateway timeout", async () => {
    const upstreamFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const handler = createHarborProxyHandler({
      env: ENVIRONMENT,
      fetch: fetchDependency(upstreamFetch),
      timeoutMs: 1,
    });

    const response = await handler(request("{}"), context("venues.list"));

    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("HARBOR_PROXY_TIMEOUT");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});
