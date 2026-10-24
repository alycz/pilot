import { DEFAULT_POLICY } from "@pilot/contracts";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashes, Wallet } from "xrpl";

import {
  authorizeWalletHarborOperation,
  authorizeWalletResource,
  walletHarborResponseHeaders,
} from "./wallet-authorization";
import {
  hasWalletSubmissionCapability,
  hasWalletPolicyCapability,
  hasWalletTransactionCapability,
  issueWalletHarborCapability,
  issueWalletChallenge,
  openWalletSession,
  sealWalletSession,
  verifyWalletChallenge,
  WALLET_SESSION_COOKIE,
  WALLET_SUBMISSIONS_COOKIE,
} from "./wallet-session";

const SECRET = "wallet-session-test-secret-with-at-least-thirty-two-characters";
const LEGACY_ENVIRONMENT = {};
const ISOLATED_ENVIRONMENT = {
  PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-v1",
  NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
} as const;

function request(cookie: string): Request {
  return new Request("https://pilot.example/api/test", {
    headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}` },
  });
}

function legacySubmissionCapability(value: object): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(SECRET, "utf8").digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("pilot.wallet.submissions.v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

describe("wallet-bound authorization", () => {
  it("keeps legacy and isolated wallet artifacts mutually unreadable with a reused secret", () => {
    const wallet = Wallet.generate();
    const base = {
      version: 1 as const,
      account: wallet.classicAddress,
      network: "testnet" as const,
      expiresAt: 60_000,
    };
    const legacy = sealWalletSession(base, SECRET, LEGACY_ENVIRONMENT);
    const isolatedSession = {
      ...base,
      deployment_profile: "local-wallet-isolated-v1" as const,
    };
    const isolated = sealWalletSession(isolatedSession, SECRET, ISOLATED_ENVIRONMENT);

    expect(openWalletSession(legacy, {
      now: 1,
      secret: SECRET,
      environment: LEGACY_ENVIRONMENT,
    })).toEqual(base);
    expect(openWalletSession(legacy, {
      now: 1,
      secret: SECRET,
      environment: ISOLATED_ENVIRONMENT,
    })).toBeNull();
    expect(openWalletSession(isolated, {
      now: 1,
      secret: SECRET,
      environment: LEGACY_ENVIRONMENT,
    })).toBeNull();
    expect(openWalletSession(isolated, {
      now: 1,
      secret: SECRET,
      environment: ISOLATED_ENVIRONMENT,
    })).toEqual(isolatedSession);
  });

  it("rejects missing, malformed, and mismatched wallet deployment tags", () => {
    const wallet = Wallet.generate();
    const base = {
      version: 1 as const,
      account: wallet.classicAddress,
      network: "testnet" as const,
      expiresAt: 60_000,
    };
    expect(() => sealWalletSession(base, SECRET, ISOLATED_ENVIRONMENT)).toThrow(
      "invalid for this deployment profile",
    );
    expect(() => sealWalletSession({
      ...base,
      deployment_profile: "wrong-isolated-profile" as never,
    }, SECRET, ISOLATED_ENVIRONMENT)).toThrow("invalid for this deployment profile");
    expect(() => sealWalletSession({
      ...base,
      deployment_profile: "local-wallet-isolated-v1",
    }, SECRET, LEGACY_ENVIRONMENT)).toThrow("invalid for this deployment profile");
    expect(() => sealWalletSession(base, SECRET, {
      NEXT_PUBLIC_PILOT_BUILD_MARKER: "pilot-local-wallet-isolated-v1",
    })).toThrow("build marker is misconfigured");
    expect(() => sealWalletSession(base, SECRET, {
      PILOT_DEPLOYMENT_PROFILE: "local-wallet-isolated-typo",
    })).toThrow("deployment profile is misconfigured");
  });

  it("binds one-time wallet challenges to the exact deployment profile", () => {
    const wallet = Wallet.generate();
    const legacy = issueWalletChallenge(wallet.classicAddress, "testnet", {
      now: 1_000,
      nonce: "L".repeat(43),
      secret: SECRET,
      environment: LEGACY_ENVIRONMENT,
    });
    const isolated = issueWalletChallenge(wallet.classicAddress, "testnet", {
      now: 1_000,
      nonce: "I".repeat(43),
      secret: SECRET,
      environment: ISOLATED_ENVIRONMENT,
    });
    const legacyBlob = wallet.sign(legacy.txJson as never).tx_blob;
    const isolatedBlob = wallet.sign(isolated.txJson as never).tx_blob;

    expect(() => verifyWalletChallenge(legacy.cookie, legacyBlob, {
      now: 2_000,
      secret: SECRET,
      environment: ISOLATED_ENVIRONMENT,
    })).toThrow("invalid or expired");
    expect(() => verifyWalletChallenge(isolated.cookie, isolatedBlob, {
      now: 2_000,
      secret: SECRET,
      environment: LEGACY_ENVIRONMENT,
    })).toThrow("invalid or expired");
    expect(verifyWalletChallenge(isolated.cookie, isolatedBlob, {
      now: 2_000,
      secret: SECRET,
      environment: ISOLATED_ENVIRONMENT,
    }).deployment_profile).toBe("local-wallet-isolated-v1");
  });

  it("keeps submission capabilities profile-bound even beside a valid opposite-profile session", () => {
    const wallet = Wallet.generate();
    const hash = "A".repeat(64);
    const expiresAt = Date.now() + 60_000;
    const legacySession = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt,
    }, SECRET, LEGACY_ENVIRONMENT);
    const isolatedSession = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt,
      deployment_profile: "local-wallet-isolated-v1",
    }, SECRET, ISOLATED_ENVIRONMENT);
    const prior = {
      SESSION_SECRET: process.env.SESSION_SECRET,
      PILOT_DEPLOYMENT_PROFILE: process.env.PILOT_DEPLOYMENT_PROFILE,
      NEXT_PUBLIC_PILOT_BUILD_MARKER: process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER,
    };
    const restore = (name: keyof typeof prior) => {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    };
    try {
      process.env.SESSION_SECRET = SECRET;
      process.env.PILOT_DEPLOYMENT_PROFILE = "local-wallet-isolated-v1";
      process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER = "pilot-local-wallet-isolated-v1";
      const isolatedCapability = issueWalletHarborCapability(
        request(isolatedSession),
        { hash },
      );
      expect(isolatedCapability).toBeDefined();

      process.env.PILOT_DEPLOYMENT_PROFILE = "local-wallet";
      delete process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER;
      const crossProfile = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(legacySession)}; ` +
            `${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(isolatedCapability!)}`,
        },
      });
      expect(hasWalletSubmissionCapability(crossProfile, hash)).toBe(false);

      const legacyCapability = issueWalletHarborCapability(
        request(legacySession),
        { hash },
      );
      expect(legacyCapability).toBeDefined();
      process.env.PILOT_DEPLOYMENT_PROFILE = "local-wallet-isolated-v1";
      process.env.NEXT_PUBLIC_PILOT_BUILD_MARKER = "pilot-local-wallet-isolated-v1";
      const reverseCrossProfile = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(isolatedSession)}; ` +
            `${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(legacyCapability!)}`,
        },
      });
      expect(hasWalletSubmissionCapability(reverseCrossProfile, hash)).toBe(false);
    } finally {
      restore("SESSION_SECRET");
      restore("PILOT_DEPLOYMENT_PROFILE");
      restore("NEXT_PUBLIC_PILOT_BUILD_MARKER");
    }
  });

  it("verifies a one-time non-submittable proof and seals only public identity", () => {
    const wallet = Wallet.generate();
    const issued = issueWalletChallenge(wallet.classicAddress, "testnet", {
      now: 1_000,
      nonce: "A".repeat(43),
      secret: SECRET,
    });
    expect(issued.txJson).toMatchObject({
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      Fee: "0",
      Sequence: 0,
      LastLedgerSequence: 0,
    });
    const session = verifyWalletChallenge(
      issued.cookie,
      wallet.sign(issued.txJson as never).tx_blob,
      { now: 2_000, secret: SECRET },
    );
    const sealed = sealWalletSession(session, SECRET);
    expect(sealed).not.toContain(wallet.classicAddress);
    expect(openWalletSession(sealed, { now: 2_001, secret: SECRET })).toEqual(session);
  });

  it("rejects challenge replay after expiry and any transaction mutation", () => {
    const wallet = Wallet.generate();
    const issued = issueWalletChallenge(wallet.classicAddress, "devnet", {
      now: 1_000,
      nonce: "B".repeat(43),
      secret: SECRET,
    });
    const mutated = { ...issued.txJson, Fee: "12" };
    expect(() => verifyWalletChallenge(
      issued.cookie,
      wallet.sign(mutated as never).tx_blob,
      { now: 2_000, secret: SECRET },
    )).toThrow("does not match");
    expect(() => verifyWalletChallenge(
      issued.cookie,
      wallet.sign(issued.txJson as never).tx_blob,
      { now: 1_000 + 5 * 60 * 1_000, secret: SECRET },
    )).toThrow("expired");
  });

  it("binds parsed owner/account/network and refuses opaque browser execution", () => {
    const wallet = Wallet.generate();
    const other = Wallet.generate();
    const cookie = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SECRET);
    const bound = request(cookie);
    process.env.SESSION_SECRET = SECRET;
    try {
      expect(authorizeWalletResource(bound, wallet.classicAddress, "testnet")).toBe(true);
      expect(authorizeWalletResource(bound, other.classicAddress, "testnet")).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "policy.get",
        { owner: wallet.classicAddress, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        bound,
        "policy.get",
        { owner: other.classicAddress, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "account.status",
        { owner: wallet.classicAddress, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        bound,
        "account.status",
        { owner: other.classicAddress, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const x402Args = {
        owner: wallet.classicAddress,
        network: "testnet",
        resource: "compare",
        pay_to: "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr",
        max_price_drops: "5000",
        idempotency_key: "pilot-x402:operation-402-wallet-1",
      };
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        x402Args,
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        { ...x402Args, owner: other.classicAddress },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        x402Args,
        { EXEC_NETWORK: "devnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "account.revoke",
        { owner: wallet.classicAddress, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        bound,
        "account.revoke",
        { owner: other.classicAddress, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.execute",
        { build_id: "opaque", idempotency_key: "opaque" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("does not treat a long-lived isolated wallet session as x402 payment authorization", () => {
    const wallet = Wallet.generate();
    const isolatedSession = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
      deployment_profile: "local-wallet-isolated-v1",
    }, SECRET, ISOLATED_ENVIRONMENT);
    const bound = request(isolatedSession);
    const priorSecret = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = SECRET;
      const environment = { ...ISOLATED_ENVIRONMENT, EXEC_NETWORK: "testnet" } as const;
      const exact = {
        owner: wallet.classicAddress,
        network: "testnet",
        resource: "compare",
        pay_to: "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr",
        max_price_drops: "5000",
        idempotency_key: "pilot-x402:isolated-wallet-1",
      };
      expect(authorizeWalletHarborOperation(bound, "x402.pay", exact, environment)).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        { ...exact, max_price_drops: "5001" },
        environment,
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        { ...exact, pay_to: wallet.classicAddress },
        environment,
      )).toBe(false);
      const { pay_to: _removed, ...legacy } = exact;
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        legacy,
        environment,
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "x402.pay",
        { ...exact, max_price_drops: "100000" },
        environment,
      )).toBe(false);
    } finally {
      if (priorSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = priorSecret;
    }
  });

  it("accepts only the exact account.link DelegateSet for direct submission", async () => {
    const wallet = Wallet.generate();
    const other = Wallet.generate();
    const cookie = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SECRET);
    const bound = request(cookie);
    const delegateSet = {
      TransactionType: "DelegateSet",
      Account: wallet.classicAddress,
      Authorize: other.classicAddress,
      Permissions: [{ Permission: { PermissionValue: "TrustSet" } }],
      Fee: "12",
      Sequence: 1,
      LastLedgerSequence: 100,
    };
    const blob = wallet.sign(delegateSet as never).tx_blob;
    process.env.SESSION_SECRET = SECRET;
    try {
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.submit",
        { tx_blob: blob, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const linkBody = await Response.json({
        ok: true,
        data: {
          owner: wallet.classicAddress,
          network: "testnet",
          delegate: other.classicAddress,
          permissions: ["TrustSet"],
          status: "pending",
          delegate_set_tx: delegateSet,
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      const headers = walletHarborResponseHeaders(bound, "account.link", {
        owner: wallet.classicAddress,
        network: "testnet",
        permissions: ["TrustSet"],
      }, linkBody, 200);
      const capability = headers["set-cookie"]?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(capability).toBeDefined();
      const linked = new Request("https://pilot.example/api/test", {
        headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${capability}` },
      });
      expect(authorizeWalletHarborOperation(
        linked,
        "tx.submit",
        { tx_blob: blob, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        linked,
        "tx.submit",
        { tx_blob: wallet.sign({ ...delegateSet, Fee: "13" } as never).tx_blob, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.submit",
        { tx_blob: other.sign({ TransactionType: "DelegateSet", Account: other.classicAddress, Authorize: wallet.classicAddress, Permissions: [{ Permission: { PermissionValue: "TrustSet" } }], Fee: "12", Sequence: 1 }).tx_blob, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.submit",
        { tx_blob: wallet.sign({ TransactionType: "TrustSet", Account: wallet.classicAddress, LimitAmount: { currency: "USD", issuer: other.classicAddress, value: "1" }, Fee: "12", Sequence: 1 }).tx_blob, network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("binds hash-only approval status to a capability recorded from submit", async () => {
    const wallet = Wallet.generate();
    const cookie = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "devnet",
      expiresAt: Date.now() + 60_000,
    }, SECRET);
    const bound = request(cookie);
    const txBlob = wallet.sign({
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      Fee: "12",
      Sequence: 1,
    }).tx_blob;
    const hash = hashes.hashSignedTx(txBlob).toUpperCase();
    process.env.SESSION_SECRET = SECRET;
    try {
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.status",
        { hash },
        { EXEC_NETWORK: "devnet" },
      )).toBe(false);
      const body = await Response.json({
        ok: true,
        data: { hash, ledger_index: 200, engine_result: "tesSUCCESS", validated: true },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      const headers = walletHarborResponseHeaders(
        bound,
        "tx.submit",
        { tx_blob: txBlob, network: "devnet" },
        body,
        200,
      );
      const match = headers["set-cookie"]?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`));
      expect(match?.[1]).toBeDefined();
      const capable = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${match![1]}`,
        },
      });
      expect(authorizeWalletHarborOperation(
        capable,
        "tx.status",
        { hash },
        { EXEC_NETWORK: "devnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        capable,
        "tx.status",
        { hash: "B".repeat(64) },
        { EXEC_NETWORK: "devnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("tracks build ownership before execute and account-binds approval submit", async () => {
    const wallet = Wallet.generate();
    const issuer = Wallet.generate();
    const cookie = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SECRET);
    const bound = request(cookie);
    process.env.SESSION_SECRET = SECRET;
    try {
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.execute",
        { build_id: "build-trust-1", idempotency_key: "intent-1" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const buildBody = await Response.json({
        ok: true,
        data: {
          build_id: "build-trust-1",
          network: "testnet",
          tx_json: {
            TransactionType: "TrustSet",
            Account: wallet.classicAddress,
            LimitAmount: { currency: "USD", issuer: issuer.classicAddress, value: "1" },
            Fee: "12",
            Sequence: 1,
          },
          delegable: true,
          simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: false },
          preflight: [{ check: "schema", pass: true }],
          summary: {
            action: "Trust",
            account: wallet.classicAddress,
            amounts: [],
            fee_drops: "12",
            reserve_delta_drops: "0",
          },
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      const unboundHeaders = walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
      }, buildBody, 200);
      const unboundCapability = unboundHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(unboundCapability).toBeDefined();
      const withoutIntent = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${unboundCapability}`,
        },
      });
      expect(authorizeWalletHarborOperation(
        withoutIntent,
        "tx.execute",
        { build_id: "build-trust-1", idempotency_key: "intent-1" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const buildHeaders = walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: "intent-1",
      }, buildBody, 200);
      const buildCapability = buildHeaders["set-cookie"]?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(buildCapability).toBeDefined();
      const withBuild = new Request("https://pilot.example/api/test", {
        headers: { cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${buildCapability}` },
      });
      expect(authorizeWalletHarborOperation(
        withBuild,
        "tx.execute",
        { build_id: "build-trust-1", idempotency_key: "intent-1" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        withBuild,
        "tx.execute",
        { build_id: "build-trust-1", idempotency_key: "intent-swapped" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      expect(authorizeWalletHarborOperation(
        withBuild,
        "tx.execute",
        { build_id: "build-swapped", idempotency_key: "intent-1" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      // Ordinary builders are exact non-forced tuples and cannot opt into the
      // acquisition-only forced-owner mode.
      expect(authorizeWalletHarborOperation(
        withBuild,
        "tx.execute",
        {
          build_id: "build-trust-1",
          idempotency_key: "intent-1",
          require_owner_approval: true,
        },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const builtTrustSet = {
        TransactionType: "TrustSet",
        Account: wallet.classicAddress,
        LimitAmount: { currency: "USD", issuer: issuer.classicAddress, value: "1" },
        Fee: "12",
        Sequence: 1,
      };
      expect(hasWalletTransactionCapability(withBuild, builtTrustSet)).toBe(true);
      expect(hasWalletTransactionCapability(withBuild, { ...builtTrustSet, Fee: "13" })).toBe(false);
      const offerBody = await Response.json({
        ok: true,
        data: {
          ...JSON.parse(new TextDecoder().decode(buildBody)).data,
          build_id: "build-offer-1",
          tx_json: {
            TransactionType: "OfferCreate",
            Account: wallet.classicAddress,
            TakerGets: "1000000",
            TakerPays: {
              currency: "USD",
              issuer: issuer.classicAddress,
              value: "1",
            },
            Fee: "12",
            Sequence: 1,
          },
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      const offerHeaders = walletHarborResponseHeaders(bound, "tx.offer", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: "intent-offer-1",
        sell: { currency: "XRP" },
        buy: { currency: "USD", issuer: issuer.classicAddress },
        sell_amount: "1",
        buy_amount: "1",
      }, offerBody, 200);
      const offerCapability = offerHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(offerCapability).toBeDefined();
      const withOffer = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${offerCapability}`,
        },
      });
      expect(authorizeWalletHarborOperation(
        withOffer,
        "tx.execute",
        { build_id: "build-offer-1", idempotency_key: "intent-offer-1" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      const onboardingIntent = "onboarding-trust-00000000-0000-4000-8000-000000000001";
      const onboardingTrustSet = {
        TransactionType: "TrustSet",
        Account: wallet.classicAddress,
        LimitAmount: {
          currency: "524C555344000000000000000000000000000000",
          issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
          value: "10000",
        },
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 100,
      };
      const onboardingBody = await Response.json({
        ok: true,
        data: {
          ...JSON.parse(new TextDecoder().decode(buildBody)).data,
          build_id: "build-onboarding-trust",
          tx_json: onboardingTrustSet,
          summary: {
            action: "Trust",
            account: wallet.classicAddress,
            amounts: [],
            fee_drops: "12",
            reserve_delta_drops: "0",
          },
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      const onboardingHeaders = walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: onboardingIntent,
        limit_amount: onboardingTrustSet.LimitAmount,
      }, onboardingBody, 200);
      const onboardingCapability = onboardingHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(onboardingCapability).toBeDefined();
      const preparedOnly = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${onboardingCapability}`,
        },
      });
      expect(hasWalletTransactionCapability(preparedOnly, onboardingTrustSet)).toBe(true);
      expect(authorizeWalletHarborOperation(
        preparedOnly,
        "tx.execute",
        { build_id: "build-onboarding-trust", idempotency_key: onboardingIntent },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const alternateIntent = "alternate-onboarding-trust-intent";
      const alternateHeaders = walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: alternateIntent,
        limit_amount: onboardingTrustSet.LimitAmount,
      }, onboardingBody, 200);
      const alternateCapability = alternateHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(alternateCapability).toBeDefined();
      const alternatePrepared = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${alternateCapability}`,
        },
      });
      expect(hasWalletTransactionCapability(alternatePrepared, onboardingTrustSet)).toBe(true);
      expect(authorizeWalletHarborOperation(
        alternatePrepared,
        "tx.execute",
        { build_id: "build-onboarding-trust", idempotency_key: alternateIntent },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const policyBody = await Response.json({
        ok: true,
        data: DEFAULT_POLICY,
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "policy",
      }).arrayBuffer();
      const policyHeaders = walletHarborResponseHeaders(bound, "policy.set", {
        owner: wallet.classicAddress,
        network: "testnet",
        policy: DEFAULT_POLICY,
      }, policyBody, 200);
      const policyCapability = policyHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(policyCapability).toBeDefined();
      const policyConfirmed = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${policyCapability}`,
        },
      });
      expect(hasWalletPolicyCapability(policyConfirmed, DEFAULT_POLICY)).toBe(true);
      expect(hasWalletPolicyCapability(
        policyConfirmed,
        { ...DEFAULT_POLICY, execute_under_usd: 1 },
      )).toBe(false);
      const changedPolicy = { ...DEFAULT_POLICY, execute_under_usd: 1 };
      const changedPolicyBody = await Response.json({
        ok: true,
        data: changedPolicy,
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "policy",
      }).arrayBuffer();
      const changedHeaders = walletHarborResponseHeaders(policyConfirmed, "policy.set", {
        owner: wallet.classicAddress,
        network: "testnet",
        policy: changedPolicy,
      }, changedPolicyBody, 200);
      const changedCapability = changedHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(changedCapability).toBeDefined();
      const changed = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(cookie)}; ${WALLET_SUBMISSIONS_COOKIE}=${changedCapability}`,
        },
      });
      expect(hasWalletPolicyCapability(changed, DEFAULT_POLICY)).toBe(false);
      expect(hasWalletPolicyCapability(changed, changedPolicy)).toBe(true);
      const unsafeBuildBody = await Response.json({
        ok: true,
        data: {
          ...JSON.parse(new TextDecoder().decode(buildBody)).data,
          preflight: [{ check: "schema", pass: false }],
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      expect(walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: "intent-unsafe",
      }, unsafeBuildBody, 200)).toEqual({});
      const appliedBuildBody = await Response.json({
        ok: true,
        data: {
          ...JSON.parse(new TextDecoder().decode(buildBody)).data,
          simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: true },
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      expect(walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: "intent-applied",
      }, appliedBuildBody, 200)).toEqual({});
      const missingAppliedBuildBody = await Response.json({
        ok: true,
        data: {
          ...JSON.parse(new TextDecoder().decode(buildBody)).data,
          simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok" },
        },
        asOf: "2026-10-18T00:00:00.000Z",
        asOfBasis: "ledger",
      }).arrayBuffer();
      expect(walletHarborResponseHeaders(bound, "tx.trustSet", {
        account: wallet.classicAddress,
        network: "testnet",
        intent_id: "intent-missing-applied",
      }, missingAppliedBuildBody, 200)).toEqual({});
      expect(authorizeWalletHarborOperation(
        bound,
        "tx.simulate",
        {
          account: wallet.classicAddress,
          network: "testnet",
          tx_json: { TransactionType: "TrustSet", Account: issuer.classicAddress },
        },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
      const trustBlob = wallet.sign({
        TransactionType: "TrustSet",
        Account: wallet.classicAddress,
        LimitAmount: { currency: "USD", issuer: issuer.classicAddress, value: "1" },
        Fee: "12",
        Sequence: 1,
      }).tx_blob;
      expect(authorizeWalletHarborOperation(
        withBuild,
        "tx.submit",
        { tx_blob: trustBlob, approval_id: "approval-trust-1", network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(true);
      expect(authorizeWalletHarborOperation(
        withBuild,
        "tx.submit",
        { tx_blob: issuer.sign({ TransactionType: "TrustSet", Account: issuer.classicAddress, LimitAmount: { currency: "USD", issuer: wallet.classicAddress, value: "1" }, Fee: "12", Sequence: 1 }).tx_blob, approval_id: "approval-trust-1", network: "testnet" },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("invalidates pre-fix generic TrustSet execution cookies", () => {
    const wallet = Wallet.generate();
    const expiresAt = Date.now() + 60_000;
    const session = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt,
    }, SECRET);
    const legacy = legacySubmissionCapability({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt,
      hashes: [],
      buildIds: [],
      transactionDigests: [],
      executions: [{
        buildId: "legacy-trust-build",
        idempotencyKey: "alternate-onboarding-trust-intent",
        requireOwnerApproval: false,
      }],
    });
    const legacyRequest = new Request("https://pilot.example/api/harbor/tx.execute", {
      headers: {
        cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}; ${WALLET_SUBMISSIONS_COOKIE}=${encodeURIComponent(legacy)}`,
      },
    });
    process.env.SESSION_SECRET = SECRET;
    try {
      expect(authorizeWalletHarborOperation(
        legacyRequest,
        "tx.execute",
        {
          build_id: "legacy-trust-build",
          idempotency_key: "alternate-onboarding-trust-intent",
        },
        { EXEC_NETWORK: "testnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });

  it("binds forced-owner RLUSD execution to the exact build and stable intent tuple", async () => {
    const wallet = Wallet.generate();
    const other = Wallet.generate();
    const session = sealWalletSession({
      version: 1,
      account: wallet.classicAddress,
      network: "testnet",
      expiresAt: Date.now() + 60_000,
    }, SECRET);
    const bound = request(session);
    const intentA = "p-live-acquire-rlusd-00000000-0000-4000-8000-000000000001";
    const intentB = "p-live-acquire-rlusd-00000000-0000-4000-8000-000000000002";
    const builderEnvelope = (buildId: string) => Response.json({
      ok: true,
      data: {
        build_id: buildId,
        network: "testnet",
        tx_json: {
          TransactionType: "OfferCreate",
          Account: wallet.classicAddress,
          TakerGets: "1000000",
          TakerPays: {
            currency: "524C555344000000000000000000000000000000",
            issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
            value: "75",
          },
          Flags: 0x0004_0000,
          Fee: "12",
          Sequence: 1,
        },
        delegable: false,
        simulate: { engine_result: "tesSUCCESS", engine_result_message: "ok", applied: false },
        preflight: [{ check: "schema", pass: true }],
        summary: {
          action: "Buy 75 RLUSD",
          account: wallet.classicAddress,
          amounts: [],
          fee_drops: "12",
          reserve_delta_drops: "0",
        },
      },
      asOf: "2026-10-18T00:00:00.000Z",
      asOfBasis: "ledger",
    }).arrayBuffer();
    const builderArgs = (intentId: string) => ({
      account: wallet.classicAddress,
      network: "testnet",
      intent_id: intentId,
      sell: { currency: "XRP" },
      buy: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
      },
      amount: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
        value: "75",
      },
      side: "buy",
      max_slippage_bps: 100,
      execution_mode: "fill_or_kill",
    });
    process.env.SESSION_SECRET = SECRET;
    try {
      const firstHeaders = walletHarborResponseHeaders(
        bound,
        "tx.swap",
        builderArgs(intentA),
        await builderEnvelope("build-rlusd-a"),
        200,
      );
      const firstCapability = firstHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(firstCapability).toBeDefined();
      const withFirst = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}; ${WALLET_SUBMISSIONS_COOKIE}=${firstCapability}`,
        },
      });
      const secondHeaders = walletHarborResponseHeaders(
        withFirst,
        "tx.swap",
        builderArgs(intentB),
        await builderEnvelope("build-rlusd-b"),
        200,
      );
      const capability = secondHeaders["set-cookie"]
        ?.match(new RegExp(`${WALLET_SUBMISSIONS_COOKIE}=([^;]+)`))?.[1];
      expect(capability).toBeDefined();
      const capable = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(session)}; ${WALLET_SUBMISSIONS_COOKIE}=${capability}`,
        },
      });
      const execute = (target: Request, buildId: string, intentId: string, forced = true) =>
        authorizeWalletHarborOperation(
          target,
          "tx.execute",
          {
            build_id: buildId,
            idempotency_key: intentId,
            ...(forced ? { require_owner_approval: true as const } : {}),
          },
          { EXEC_NETWORK: "testnet" },
        );

      expect(execute(capable, "build-rlusd-a", intentA)).toBe(true);
      expect(execute(capable, "build-rlusd-b", intentB)).toBe(true);
      expect(execute(capable, "build-rlusd-a", intentB)).toBe(false);
      expect(execute(capable, "build-rlusd-b", intentA)).toBe(false);
      expect(execute(capable, "build-rlusd-a", intentA, false)).toBe(false);
      expect(execute(capable, "build-not-issued", intentA)).toBe(false);

      const foreignAccount = sealWalletSession({
        version: 1,
        account: other.classicAddress,
        network: "testnet",
        expiresAt: Date.now() + 60_000,
      }, SECRET);
      const foreignAccountRequest = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(foreignAccount)}; ${WALLET_SUBMISSIONS_COOKIE}=${capability}`,
        },
      });
      expect(execute(foreignAccountRequest, "build-rlusd-a", intentA)).toBe(false);

      const foreignNetwork = sealWalletSession({
        version: 1,
        account: wallet.classicAddress,
        network: "devnet",
        expiresAt: Date.now() + 60_000,
      }, SECRET);
      const foreignNetworkRequest = new Request("https://pilot.example/api/test", {
        headers: {
          cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(foreignNetwork)}; ${WALLET_SUBMISSIONS_COOKIE}=${capability}`,
        },
      });
      expect(authorizeWalletHarborOperation(
        foreignNetworkRequest,
        "tx.execute",
        {
          build_id: "build-rlusd-a",
          idempotency_key: intentA,
          require_owner_approval: true,
        },
        { EXEC_NETWORK: "devnet" },
      )).toBe(false);
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });
});
