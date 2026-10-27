import type { NearPrincipalAuthorization } from "@pilot/contracts/near";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
  NEAR_WALLET_CHALLENGE_COOKIE,
  sealNearPrincipalAuthorization,
} from "../../../../lib/near-wallet-proof";
import { POST as issueChallenge } from "./challenge/route";
import { createNearSessionHandler } from "../../../../lib/near-session-handler";
import { POST as createSession } from "./session/route";

const ENVIRONMENT_KEYS = [
  "HARBOR_URL",
  "NEXT_PUBLIC_DEV_SIGNER",
  "PILOT_DEPLOYMENT_PROFILE",
  "PILOT_HOSTED_STATE_API_KEY",
  "PILOT_NEAR_WALLET_PROOF_MODE",
  "PILOT_NEAR_WALLET_PROOF_PROVIDER",
  "PILOT_NEAR_WALLET_PROOF_RECIPIENT",
  "PILOT_PUBLIC_ORIGIN",
  "SESSION_SECRET",
] as const;
const ORIGINAL_ENVIRONMENT = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

function authorization(
  principalId = "principal-alice",
  accountId = "alice.near",
  input: Partial<NearPrincipalAuthorization> = {},
): NearPrincipalAuthorization {
  return {
    version: "pilot-near-principal-authorization-v1",
    authorization_id: `authorization-${principalId}`,
    principal_id: principalId,
    account_id: accountId,
    network: "near:mainnet",
    operations: ["near.intents.approval.review"],
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    ...input,
  };
}

function request(
  path: string,
  input: Readonly<{
    body?: unknown;
    cookies?: Record<string, string>;
    origin?: string;
  }> = {},
): NextRequest {
  const origin = input.origin ?? "https://pilot.example";
  const headers = new Headers({
    "content-type": "application/json",
    host: new URL(origin).host,
    origin,
  });
  if (input.cookies) {
    headers.set("cookie", Object.entries(input.cookies)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; "));
  }
  return new NextRequest(`${origin}${path}`, {
    method: "POST",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

function proof(accountId = "alice.near") {
  return {
    account_id: accountId,
    public_key: `ed25519:${"B".repeat(44)}`,
    signature: "A".repeat(88),
  };
}

describe("NEAR wallet-control routes", () => {
  beforeEach(() => {
    process.env.PILOT_DEPLOYMENT_PROFILE = "hosted";
    process.env.NEXT_PUBLIC_DEV_SIGNER = "0";
    process.env.PILOT_PUBLIC_ORIGIN = "https://pilot.example";
    process.env.HARBOR_URL = "https://harbor.example";
    process.env.PILOT_HOSTED_STATE_API_KEY = `pilot-hosted-state:${"H".repeat(32)}`;
    process.env.SESSION_SECRET =
      "pilot-near-wallet-proof-route-test-secret-over-thirty-two-characters";
    process.env.PILOT_NEAR_WALLET_PROOF_MODE = "challenge-only";
    process.env.PILOT_NEAR_WALLET_PROOF_PROVIDER = "nep413-full-access-key";
    process.env.PILOT_NEAR_WALLET_PROOF_RECIPIENT = "pilot.near";
  });

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = ORIGINAL_ENVIRONMENT[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("issues only a sealed, server-authorized, non-executable challenge", async () => {
    const principal = sealNearPrincipalAuthorization(authorization());
    const response = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
    }));

    expect(response.status).toBe(200);
    expect(response.cookies.get(NEAR_WALLET_CHALLENGE_COOKIE)?.value).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      account_id: "alice.near",
      network: "near:mainnet",
      provider: "nep413-full-access-key",
      verification_available: false,
      execution_enabled: false,
      sign_message: {
        recipient: "pilot.near",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed on proof submission while the NEP-413 verifier is unavailable", async () => {
    const principal = sealNearPrincipalAuthorization(authorization());
    const challenge = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
    }));
    const challengeCookie = challenge.cookies.get(NEAR_WALLET_CHALLENGE_COOKIE)?.value;

    const response = await createSession(request("/api/auth/near/session", {
      cookies: {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_WALLET_CHALLENGE_COOKIE]: challengeCookie ?? "",
      },
      body: proof(),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "NEP-413 full-access-key verification is unavailable.",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts an exact proof only after verifier and durable replay consumption", async () => {
    process.env.PILOT_NEAR_WALLET_PROOF_MODE = "verify";
    const principal = sealNearPrincipalAuthorization(authorization());
    const challenge = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
    }));
    const consume = vi.fn().mockResolvedValue(true);
    const handler = createNearSessionHandler({
      environment: process.env,
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

    const response = await handler(request("/api/auth/near/session", {
      cookies: {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal,
        [NEAR_WALLET_CHALLENGE_COOKIE]:
          challenge.cookies.get(NEAR_WALLET_CHALLENGE_COOKIE)?.value ?? "",
      },
      body: proof(),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      wallet_control_verified: true,
      account_id: "alice.near",
      network: "near:mainnet",
      execution_enabled: false,
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(response.cookies.get(NEAR_WALLET_CHALLENGE_COOKIE)?.value).toBe("");
  });

  it("denies cross-principal challenge reuse before verifier availability", async () => {
    const alice = sealNearPrincipalAuthorization(authorization());
    const challenge = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: alice },
    }));
    const bob = sealNearPrincipalAuthorization(
      authorization("principal-bob", "alice.near"),
    );

    const response = await createSession(request("/api/auth/near/session", {
      cookies: {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: bob,
        [NEAR_WALLET_CHALLENGE_COOKIE]:
          challenge.cookies.get(NEAR_WALLET_CHALLENGE_COOKIE)?.value ?? "",
      },
      body: proof(),
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("denies cross-account challenge reuse before verifier availability", async () => {
    const exact = authorization();
    const alice = sealNearPrincipalAuthorization(exact);
    const challenge = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: alice },
    }));
    const changedAccount = sealNearPrincipalAuthorization(authorization(
      exact.principal_id,
      "bob.near",
      { authorization_id: exact.authorization_id },
    ));

    const response = await createSession(request("/api/auth/near/session", {
      cookies: {
        [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: changedAccount,
        [NEAR_WALLET_CHALLENGE_COOKIE]:
          challenge.cookies.get(NEAR_WALLET_CHALLENGE_COOKIE)?.value ?? "",
      },
      body: proof("bob.near"),
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("requires same-origin requests, an authorization cookie, and explicit flags", async () => {
    const principal = sealNearPrincipalAuthorization(authorization());
    const crossOrigin = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
      origin: "https://attacker.example",
    }));
    expect(crossOrigin.status).toBe(403);

    const missingAuthorization = issueChallenge(request("/api/auth/near/challenge"));
    expect(missingAuthorization.status).toBe(401);

    process.env.PILOT_NEAR_WALLET_PROOF_MODE = "disabled";
    const disabled = issueChallenge(request("/api/auth/near/challenge", {
      cookies: { [NEAR_PRINCIPAL_AUTHORIZATION_COOKIE]: principal },
    }));
    expect(disabled.status).toBe(503);
  });
});

