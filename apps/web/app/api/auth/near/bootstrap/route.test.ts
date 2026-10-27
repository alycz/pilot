import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";

import { POST as issueNearChallenge } from "../challenge/route";
import { createNearPrincipalBootstrapHandler } from "../../../../../lib/near-principal-bootstrap-handler";
import { createNearSessionHandler } from "../../../../../lib/near-session-handler";
import {
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
  NEAR_WALLET_CHALLENGE_COOKIE,
  openNearPrincipalAuthorization,
  readNearPrincipalAuthorization,
} from "../../../../../lib/near-wallet-proof";
import {
  NEAR_UPGRADED_AUTHORIZED_OPERATIONS,
} from "../../../../../lib/near-principal-bootstrap";
import {
  WALLET_SESSION_COOKIE,
  sealWalletSession,
  type WalletSession,
} from "../../../../../lib/wallet-session";

const NOW = Date.parse("2098-01-01T00:00:00.000Z");
const ENVIRONMENT_KEYS = [
  "HARBOR_API_KEY",
  "HARBOR_URL",
  "NEXT_PUBLIC_DEV_SIGNER",
  "PILOT_DEPLOYMENT_PROFILE",
  "PILOT_HOSTED_STATE_API_KEY",
  "PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED",
  "PILOT_NEAR_WALLET_PROOF_MODE",
  "PILOT_NEAR_WALLET_PROOF_PROVIDER",
  "PILOT_NEAR_WALLET_PROOF_RECIPIENT",
  "PILOT_PUBLIC_ORIGIN",
  "SESSION_SECRET",
] as const;
const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

function request(
  path: string,
  body: unknown,
  cookies: Record<string, string> = {},
  origin = "https://pilot.example",
): NextRequest {
  return new NextRequest(`https://pilot.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "pilot.example",
      origin,
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    },
    body: JSON.stringify(body),
  });
}

function walletSession(
  wallet: Wallet,
  input: Partial<WalletSession> = {},
): WalletSession {
  return {
    version: 1,
    account: wallet.classicAddress,
    network: "testnet",
    expiresAt: NOW + 60 * 60_000,
    ...input,
  };
}

function walletCookie(session: WalletSession): string {
  return sealWalletSession(session, process.env.SESSION_SECRET, process.env);
}

function proof(accountId = "alice.near") {
  return {
    account_id: accountId,
    public_key: `ed25519:${"B".repeat(44)}`,
    signature: "A".repeat(88),
  };
}

describe("wallet-bound NEAR principal bootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.HARBOR_URL = "https://harbor.example";
    process.env.HARBOR_API_KEY = `pilot:${"A".repeat(32)}`;
    process.env.PILOT_HOSTED_STATE_API_KEY = `state:${"H".repeat(32)}`;
    process.env.PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED = "true";
    process.env.PILOT_NEAR_WALLET_PROOF_MODE = "verify";
    process.env.PILOT_NEAR_WALLET_PROOF_PROVIDER = "nep413-full-access-key";
    process.env.PILOT_NEAR_WALLET_PROOF_RECIPIENT = "pilot.near";
    process.env.SESSION_SECRET =
      "near-principal-bootstrap-test-secret-over-thirty-two-characters";
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of ENVIRONMENT_KEYS) {
      const value = ORIGINAL_ENVIRONMENT[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("issues a short approval-only preauthorization from an active wallet session", async () => {
    const wallet = walletSession(Wallet.generate());
    const handler = createNearPrincipalBootstrapHandler({
      environment: process.env,
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const response = await handler(request(
      "/api/auth/near/bootstrap",
      { bootstrap: true, account_id: "alice.near", network: "near:mainnet" },
      { [WALLET_SESSION_COOKIE]: walletCookie(wallet) },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preauthorized: true,
      account_id: "alice.near",
      network: "near:mainnet",
      operations: ["near.intents.approval.review"],
      wallet_control_verified: false,
      execution_enabled: false,
    });
    const sealed = response.cookies.get(
      NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
    )?.value;
    const authorization = openNearPrincipalAuthorization(sealed, {
      environment: process.env,
      now: NOW,
    });
    expect(authorization?.principal_id).toMatch(/^near-wallet-principal-v1-/);
    expect(authorization?.authorization_id).toMatch(/^near-preauthorization-v1-/);
    expect(Date.parse(authorization?.expires_at ?? "")).toBe(NOW + 5 * 60_000);
  });

  it("upgrades only after exact NEP-413 proof and durable nonce consumption", async () => {
    const wallet = walletSession(Wallet.generate());
    const walletToken = walletCookie(wallet);
    const bootstrap = createNearPrincipalBootstrapHandler({
      environment: process.env,
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const preauthorized = await bootstrap(request(
      "/api/auth/near/bootstrap",
      { bootstrap: true, account_id: "alice.near", network: "near:mainnet" },
      { [WALLET_SESSION_COOKIE]: walletToken },
    ));
    const principalToken = preauthorized.cookies.get(
      NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
    )?.value ?? "";
    const challenge = issueNearChallenge(request(
      "/api/auth/near/challenge",
      {},
      {
        [WALLET_SESSION_COOKIE]: walletToken,
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
      },
    ));
    expect(challenge.status).toBe(200);
    const consume = vi.fn(async () => true);
    const session = createNearSessionHandler({
      environment: process.env,
      clock: () => NOW + 2,
      verifier: {
        async verify(input) {
          return {
            accountId: input.accountId,
            publicKey: input.publicKey,
            signatureValid: true,
            fullAccessKeyVerified: true,
          };
        },
      },
      replayConsumerFactory: () => ({ consume }),
    });
    const response = await session(request(
      "/api/auth/near/session",
      proof(),
      {
        [WALLET_SESSION_COOKIE]: walletToken,
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
        [NEAR_WALLET_CHALLENGE_COOKIE]: challenge.cookies.get(
          NEAR_WALLET_CHALLENGE_COOKIE,
        )?.value ?? "",
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      wallet_control_verified: true,
      authorization_upgraded: true,
      operations: NEAR_UPGRADED_AUTHORIZED_OPERATIONS,
      execution_enabled: false,
    });
    expect(consume).toHaveBeenCalledOnce();
    const upgradedToken = response.cookies.get(
      NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
    )?.value;
    expect(readNearPrincipalAuthorization(request("/test", {}, {
      [WALLET_SESSION_COOKIE]: walletToken,
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: upgradedToken ?? "",
    }), { environment: process.env, now: NOW + 3 })?.operations)
      .toEqual(NEAR_UPGRADED_AUTHORIZED_OPERATIONS);
  });

  it("rejects cross-wallet, renewed-session, account-change, and replay attempts", async () => {
    const firstWallet = walletSession(Wallet.generate());
    const firstWalletToken = walletCookie(firstWallet);
    const bootstrap = createNearPrincipalBootstrapHandler({
      environment: process.env,
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const preauthorized = await bootstrap(request(
      "/api/auth/near/bootstrap",
      { bootstrap: true, account_id: "alice.near", network: "near:mainnet" },
      { [WALLET_SESSION_COOKIE]: firstWalletToken },
    ));
    const principalToken = preauthorized.cookies.get(
      NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
    )?.value ?? "";

    const otherWalletToken = walletCookie(walletSession(Wallet.generate()));
    expect(issueNearChallenge(request("/api/auth/near/challenge", {}, {
      [WALLET_SESSION_COOKIE]: otherWalletToken,
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
    })).status).toBe(401);
    const renewedWalletToken = walletCookie({
      ...firstWallet,
      expiresAt: firstWallet.expiresAt + 1,
    });
    expect(issueNearChallenge(request("/api/auth/near/challenge", {}, {
      [WALLET_SESSION_COOKIE]: renewedWalletToken,
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
    })).status).toBe(401);

    const challenge = issueNearChallenge(request("/api/auth/near/challenge", {}, {
      [WALLET_SESSION_COOKIE]: firstWalletToken,
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
    }));
    const verifier = vi.fn(async (input) => ({
      accountId: input.accountId,
      publicKey: input.publicKey,
      signatureValid: true as const,
      fullAccessKeyVerified: true as const,
    }));
    const changedAccount = createNearSessionHandler({
      environment: process.env,
      clock: () => NOW + 1,
      verifier: { verify: verifier },
      replayConsumerFactory: () => ({ consume: async () => true }),
    });
    expect((await changedAccount(request("/api/auth/near/session", proof("bob.near"), {
      [WALLET_SESSION_COOKIE]: firstWalletToken,
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
      [NEAR_WALLET_CHALLENGE_COOKIE]: challenge.cookies.get(
        NEAR_WALLET_CHALLENGE_COOKIE,
      )?.value ?? "",
    }))).status).toBe(403);
    expect(verifier).not.toHaveBeenCalled();

    const replay = createNearSessionHandler({
      environment: process.env,
      clock: () => NOW + 1,
      verifier: { verify: verifier },
      replayConsumerFactory: () => ({ consume: async () => false }),
    });
    expect((await replay(request("/api/auth/near/session", proof(), {
      [WALLET_SESSION_COOKIE]: firstWalletToken,
      [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principalToken,
      [NEAR_WALLET_CHALLENGE_COOKIE]: challenge.cookies.get(
        NEAR_WALLET_CHALLENGE_COOKIE,
      )?.value ?? "",
    }))).status).toBe(401);
  });

  it("is default-off and requires same-origin, explicit intent, and a wallet session", async () => {
    const wallet = walletSession(Wallet.generate());
    const handler = createNearPrincipalBootstrapHandler({
      environment: process.env,
      clock: () => NOW,
      replayProtectionConfigured: () => true,
    });
    const baseBody = {
      bootstrap: true,
      account_id: "alice.near",
      network: "near:mainnet",
    };
    expect((await handler(request("/api/auth/near/bootstrap", baseBody, {
      [WALLET_SESSION_COOKIE]: walletCookie(wallet),
    }, "https://attacker.example"))).status).toBe(403);
    expect((await handler(request("/api/auth/near/bootstrap", {
      ...baseBody,
      bootstrap: false,
    }, { [WALLET_SESSION_COOKIE]: walletCookie(wallet) }))).status).toBe(400);
    expect((await handler(request("/api/auth/near/bootstrap", baseBody))).status)
      .toBe(401);
    process.env.PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED = "false";
    const disabled = await handler(request("/api/auth/near/bootstrap", baseBody, {
      [WALLET_SESSION_COOKIE]: walletCookie(wallet),
    }));
    expect(disabled.status).toBe(503);
    expect(disabled.headers.get("set-cookie")).toBeNull();
  });
});
