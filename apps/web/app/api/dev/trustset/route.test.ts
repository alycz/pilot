import { describe, expect, it, vi } from "vitest";
import { hashes, Wallet } from "xrpl";

import {
  issueWalletHarborCapability,
  sealWalletSession,
  walletTransactionDigest,
  WALLET_SESSION_COOKIE,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../lib/wallet-session";
import { createTrustSetRelayHandler } from "./handler";

const SECRET = "trustset-route-secret-with-at-least-thirty-two-characters";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CURRENCY = "524C555344000000000000000000000000000000";
const HOSTED_ENV = {
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
  NEXT_PUBLIC_DEV_SIGNER: "0",
} as const;

function trustSet(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    TransactionType: "TrustSet",
    Account: wallet.classicAddress,
    LimitAmount: { currency: CURRENCY, issuer: ISSUER, value: "10000" },
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 100,
    ...overrides,
  };
}

function signedTrustSet(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return wallet.sign(trustSet(wallet, overrides) as never).tx_blob;
}

function request(body: object, cookie: string, origin = "https://pilot.example") {
  return new Request("http://next-internal:3000/api/dev/trustset", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
      forwarded: "for=203.0.113.7;proto=http;host=attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(wallet: Wallet) {
  return `${WALLET_SESSION_COOKIE}=${encodeURIComponent(sealWalletSession({
    version: 1,
    account: wallet.classicAddress,
    network: "testnet",
    expiresAt: Date.now() + 60_000,
  }, SECRET))}`;
}

function buildBoundCookie(wallet: Wallet) {
  const session = sessionCookie(wallet);
  const source = new Request("https://pilot.example/api/harbor/tx.trustSet", {
    headers: { cookie: session },
  });
  const capability = issueWalletHarborCapability(source, {
    transactionDigest: walletTransactionDigest(trustSet(wallet)),
  });
  if (!capability) throw new Error("test capability could not be created");
  return `${session}; ${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(capability)}`;
}

describe("POST /api/dev/trustset", () => {
  it.each([
    "https://attacker.example",
    "https://PILOT.example",
    "https://pilot.example:443",
  ])("requires literal configured Origin equality before provider access: %s", async (origin) => {
    const wallet = Wallet.generate();
    const fetchImpl = vi.fn();
    const handler = createTrustSetRelayHandler({
      env: {
        ...HOSTED_ENV,
        HARBOR_MOCK: "0",
        EXEC_NETWORK: "testnet",
      },
      fetch: fetchImpl as typeof fetch,
    });

    const result = await handler(request(
      { action: "status", hash: "A".repeat(64) },
      sessionCookie(wallet),
      origin,
    ));

    expect(result.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a trailing-dot loopback public origin before provider access", async () => {
    const wallet = Wallet.generate();
    const fetchImpl = vi.fn();
    const handler = createTrustSetRelayHandler({
      env: {
        ...HOSTED_ENV,
        PILOT_PUBLIC_ORIGIN: "https://localhost.",
        HARBOR_MOCK: "0",
        EXEC_NETWORK: "testnet",
      },
      fetch: fetchImpl as typeof fetch,
    });

    const result = await handler(request(
      { action: "status", hash: "A".repeat(64) },
      sessionCookie(wallet),
      "https://localhost.",
    ));

    expect(result.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("submits only the exact signed TrustSet and capability-binds status", async () => {
    const wallet = Wallet.generate();
    const blob = signedTrustSet(wallet);
    const hash = hashes.hashSignedTx(blob).toUpperCase();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ result: {
        validated: true,
        ledger_index: 90,
        account_data: { Account: wallet.classicAddress },
      } }))
      .mockResolvedValueOnce(Response.json({ result: {
        validated: true,
        ledger_index: 90,
        account_data: { Account: wallet.classicAddress },
      } }))
      .mockResolvedValueOnce(Response.json({ result: { engine_result: "tesSUCCESS", tx_json: { hash } } }))
      .mockResolvedValueOnce(Response.json({ result: {
        hash,
        validated: true,
        ledger_index: 99,
        tx_json: {
          TransactionType: "TrustSet",
          Account: wallet.classicAddress,
          LimitAmount: { currency: CURRENCY, issuer: ISSUER, value: "10000" },
        },
        meta: { TransactionResult: "tesSUCCESS" },
      } }));
    const handler = createTrustSetRelayHandler({
      env: {
        ...HOSTED_ENV,
        HARBOR_MOCK: "0",
        EXEC_NETWORK: "testnet",
      },
      fetch: fetchImpl as typeof fetch,
    });
    process.env.SESSION_SECRET = SECRET;
    try {
      const authorized = await handler(request({ action: "authorize", tx_blob: blob }, buildBoundCookie(wallet)));
      expect(authorized.status).toBe(200);
      expect(await authorized.clone().json()).toEqual({ hash, network: "testnet", validated: false });
      const capability = authorized.headers.get("set-cookie")?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(capability).toBeDefined();
      const capableCookie = `${sessionCookie(wallet)}; ${WALLET_SUBMISSIONS_COOKIE}=${capability}`;
      const submitted = await handler(request({ action: "submit", tx_blob: blob }, capableCookie));
      expect(submitted.status).toBe(200);
      expect(await submitted.json()).toEqual({ hash, network: "testnet", validated: false, engine_result: "tesSUCCESS" });
      const status = await handler(request(
        { action: "status", hash },
        capableCookie,
      ));
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ hash, network: "testnet", validated: true, ledger_index: 99, engine_result: "tesSUCCESS" });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
        method: "account_info",
        api_version: 2,
        params: [{ account: wallet.classicAddress, ledger_index: "validated", strict: true }],
      });
      expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
        method: "account_info",
        api_version: 2,
      });
      expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toMatchObject({
        method: "submit",
        api_version: 2,
        params: [{ tx_blob: blob, fail_hard: false }],
      });
      expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toMatchObject({
        method: "tx",
        api_version: 2,
        params: [{ transaction: hash, binary: false }],
      });
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("refuses submission when the validated ledger reaches the signed expiry", async () => {
    const wallet = Wallet.generate();
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ result: {
      validated: true,
      ledger_index: 100,
      account_data: { Account: wallet.classicAddress },
    } }));
    const handler = createTrustSetRelayHandler({
      env: {
        ...HOSTED_ENV,
        HARBOR_MOCK: "0",
        EXEC_NETWORK: "testnet",
        STABLE_CODE_TESTNET: "RLUSD",
        STABLE_ISSUER_TESTNET: ISSUER,
      },
      fetch: fetchImpl as typeof fetch,
    });
    process.env.SESSION_SECRET = SECRET;
    try {
      const result = await handler(request(
        { action: "authorize", tx_blob: signedTrustSet(wallet) },
        buildBoundCookie(wallet),
      ));
      expect(result.status).toBe(422);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
        method: "account_info",
        api_version: 2,
      });
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("rejects mismatched TrustSets, untracked hashes, and non-test server networks", async () => {
    const wallet = Wallet.generate();
    const other = Wallet.generate();
    const fetchImpl = vi.fn();
    process.env.SESSION_SECRET = SECRET;
    try {
      const base = {
        env: { ...HOSTED_ENV, HARBOR_MOCK: "0", EXEC_NETWORK: "testnet", STABLE_CODE_TESTNET: "RLUSD", STABLE_ISSUER_TESTNET: ISSUER },
        fetch: fetchImpl as typeof fetch,
      };
      const handler = createTrustSetRelayHandler(base);
      expect((await handler(request(
        { action: "submit", tx_blob: signedTrustSet(wallet) },
        buildBoundCookie(wallet),
      ))).status).toBe(401);
      expect((await handler(request(
        { action: "submit", tx_blob: signedTrustSet(wallet) },
        sessionCookie(wallet),
      ))).status).toBe(400);
      expect((await handler(request(
        { action: "submit", tx_blob: signedTrustSet(wallet, { Account: other.classicAddress }) },
        sessionCookie(wallet),
      ))).status).toBe(400);
      expect((await handler(request(
        { action: "status", hash: "A".repeat(64) },
        sessionCookie(wallet),
      ))).status).toBe(401);
      const mainnet = createTrustSetRelayHandler({ ...base, env: { ...base.env, EXEC_NETWORK: "mainnet" } });
      expect((await mainnet(request({ action: "submit", tx_blob: signedTrustSet(wallet) }, sessionCookie(wallet)))).status).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("makes no provider call when live mode is disabled", async () => {
    const wallet = Wallet.generate();
    const fetchImpl = vi.fn();
    process.env.SESSION_SECRET = SECRET;
    try {
      const handler = createTrustSetRelayHandler({
        env: {
          ...HOSTED_ENV,
          HARBOR_MOCK: "1",
          EXEC_NETWORK: "testnet",
          STABLE_CODE_TESTNET: "RLUSD",
          STABLE_ISSUER_TESTNET: ISSUER,
        },
        fetch: fetchImpl as typeof fetch,
      });
      const result = await handler(request(
        { action: "submit", tx_blob: signedTrustSet(wallet) },
        sessionCookie(wallet),
      ));
      expect(result.status).toBe(503);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });
});
