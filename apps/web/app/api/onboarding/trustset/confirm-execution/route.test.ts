import { DEFAULT_POLICY } from "@pilot/contracts";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";

import { authorizeWalletHarborOperation } from "../../../../../lib/wallet-authorization";
import {
  issueWalletHarborCapability,
  sealWalletSession,
  walletPolicyDigest,
  walletTransactionDigest,
  WALLET_SESSION_COOKIE,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../../lib/wallet-session";
import { createTrustSetExecutionConfirmationHandler } from "./handler";

const SECRET = "trustset-confirmation-secret-with-at-least-thirty-two-characters";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CURRENCY = "524C555344000000000000000000000000000000";
const INTENT = "onboarding-trust-00000000-0000-4000-8000-000000000001";
const ENVIRONMENT = {
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_PUBLIC_ORIGIN: "https://pilot.example",
  NEXT_PUBLIC_DEV_SIGNER: "0",
  EXEC_NETWORK: "testnet",
} as const;

function transaction(account: string, overrides: Record<string, unknown> = {}) {
  return {
    TransactionType: "TrustSet",
    Account: account,
    LimitAmount: { currency: CURRENCY, issuer: ISSUER, value: "10000" },
    Fee: "12",
    Sequence: 42,
    LastLedgerSequence: 1_020,
    ...overrides,
  };
}

function cookies(wallet: Wallet, includeBuild = true, includePolicy = true): string {
  const session = sealWalletSession({
    version: 1,
    account: wallet.classicAddress,
    network: "testnet",
    expiresAt: Date.now() + 60_000,
  }, SECRET);
  const sessionCookie = `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}`;
  if (!includeBuild) return sessionCookie;
  const source = new Request("https://pilot.example/api/harbor/tx.trustSet", {
    headers: { cookie: sessionCookie },
  });
  const digest = walletTransactionDigest(transaction(wallet.classicAddress));
  const prepared = issueWalletHarborCapability(source, {
    transactionDigest: digest,
    preparedExecution: {
      buildId: "build-trust-1",
      idempotencyKey: INTENT,
      transactionDigest: digest,
    },
    ...(includePolicy ? { policyDigest: walletPolicyDigest(DEFAULT_POLICY) } : {}),
  });
  if (!prepared) throw new Error("prepared transaction capability fixture failed");
  return `${sessionCookie}; ${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(prepared)}`;
}

function request(wallet: Wallet, overrides: Record<string, unknown> = {}, options: {
  includeBuild?: boolean;
  includePolicy?: boolean;
  origin?: string;
} = {}) {
  return new Request("http://next-internal:3000/api/onboarding/trustset/confirm-execution", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookies(wallet, options.includeBuild ?? true, options.includePolicy ?? true),
      origin: options.origin ?? "https://pilot.example",
    },
    body: JSON.stringify({
      build_id: "build-trust-1",
      idempotency_key: INTENT,
      tx_json: transaction(wallet.classicAddress),
      ...overrides,
    }),
  });
}

describe("POST /api/onboarding/trustset/confirm-execution", () => {
  it("mints the exact execution tuple only after explicit wallet-bound confirmation", async () => {
    const wallet = Wallet.generate();
    const handler = createTrustSetExecutionConfirmationHandler({ env: ENVIRONMENT });
    process.env.SESSION_SECRET = SECRET;
    try {
      const result = await handler(request(wallet));
      expect(result.status).toBe(200);
      expect(await result.clone().json()).toEqual({
        confirmed: true,
        build_id: "build-trust-1",
        idempotency_key: INTENT,
      });
      const capability = result.headers.get("set-cookie")
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(capability).toBeDefined();
      const session = cookies(wallet, false);
      const confirmed = new Request("https://pilot.example/api/harbor/tx.execute", {
        headers: { cookie: `${session}; ${WALLET_SUBMISSIONS_COOKIE}=${capability}` },
      });
      expect(authorizeWalletHarborOperation(
        confirmed,
        "tx.execute",
        { build_id: "build-trust-1", idempotency_key: INTENT },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        confirmed,
        "tx.execute",
        { build_id: "build-trust-2", idempotency_key: INTENT },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("rejects confirmation without the exact prior build digest", async () => {
    const wallet = Wallet.generate();
    const handler = createTrustSetExecutionConfirmationHandler({ env: ENVIRONMENT });
    process.env.SESSION_SECRET = SECRET;
    try {
      expect((await handler(request(wallet, {}, { includeBuild: false }))).status).toBe(403);
      expect((await handler(request(wallet, {}, { includePolicy: false }))).status).toBe(403);
      expect((await handler(request(wallet, {
        tx_json: transaction(wallet.classicAddress, { Fee: "13" }),
      }))).status).toBe(403);
      expect((await handler(request(wallet, { build_id: "build-trust-swapped" }))).status)
        .toBe(403);
      expect((await handler(request(wallet, { unexpected: true }))).status).toBe(400);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("rejects foreign origins and non-Testnet execution profiles", async () => {
    const wallet = Wallet.generate();
    process.env.SESSION_SECRET = SECRET;
    try {
      const handler = createTrustSetExecutionConfirmationHandler({ env: ENVIRONMENT });
      expect((await handler(request(wallet, {}, { origin: "https://attacker.example" }))).status)
        .toBe(403);
      const devnet = createTrustSetExecutionConfirmationHandler({
        env: { ...ENVIRONMENT, EXEC_NETWORK: "devnet" },
      });
      expect((await devnet(request(wallet))).status).toBe(401);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });
});
