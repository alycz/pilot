import type { NearPrincipalAuthorization } from "@pilot/contracts/near";
import { describe, expect, it, vi } from "vitest";

import { NearNep413VerifierError } from "./near-nep413-verifier";
import {
  NearWalletProofError,
  issueNearWalletProofChallenge,
  openNearPrincipalAuthorization,
  resolveNearWalletProofRuntime,
  sealNearPrincipalAuthorization,
  verifyNearWalletControlProof,
  type NearNep413FullAccessKeyVerifier,
  type NearWalletProofEnvironment,
  type NearWalletProofReplayConsumer,
} from "./near-wallet-proof";

const NOW = Date.parse("2098-01-01T00:00:00.000Z");
const ENVIRONMENT: NearWalletProofEnvironment = {
  PILOT_NEAR_WALLET_PROOF_MODE: "verify",
  PILOT_NEAR_WALLET_PROOF_PROVIDER: "nep413-full-access-key",
  PILOT_NEAR_WALLET_PROOF_RECIPIENT: "pilot.near",
  SESSION_SECRET: "pilot-near-wallet-proof-test-secret-over-thirty-two-characters",
};

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
    issued_at: "2097-12-31T23:59:00.000Z",
    expires_at: "2098-01-01T01:00:00.000Z",
    ...input,
  };
}

function proof(accountId = "alice.near") {
  return {
    account_id: accountId,
    public_key: `ed25519:${"B".repeat(44)}`,
    signature: "A".repeat(88),
  };
}

function verifier(): NearNep413FullAccessKeyVerifier & {
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    verify: vi.fn(async (input) => ({
      accountId: input.accountId,
      publicKey: input.publicKey,
      signatureValid: true as const,
      fullAccessKeyVerified: true as const,
    })),
  };
}

function replayConsumer(): NearWalletProofReplayConsumer {
  const consumed = new Set<string>();
  return {
    consume(input) {
      const key = [input.principalId, input.accountId, input.nonce].join("\0");
      if (consumed.has(key) || input.expiresAt <= input.now) return false;
      consumed.add(key);
      return true;
    },
  };
}

function issued(current = authorization()) {
  const runtime = resolveNearWalletProofRuntime(ENVIRONMENT);
  const challenge = issueNearWalletProofChallenge({
    authorization: current,
    runtime,
    environment: ENVIRONMENT,
    now: NOW,
    nonce: Buffer.alloc(32, 7).toString("base64url"),
  });
  return { current, runtime, challenge };
}

describe("NEAR wallet-control proof boundary", () => {
  it("seals the server principal authorization and rejects tampering", () => {
    const exact = authorization();
    const token = sealNearPrincipalAuthorization(exact, ENVIRONMENT);
    expect(openNearPrincipalAuthorization(token, {
      environment: ENVIRONMENT,
      now: NOW,
    })).toEqual(exact);
    expect(openNearPrincipalAuthorization(`${token}x`, {
      environment: ENVIRONMENT,
      now: NOW,
    })).toBeNull();
  });

  it("domain-separates and binds every principal/account/network challenge field", () => {
    const { challenge } = issued();
    const message = JSON.parse(challenge.signMessage.message) as Record<string, unknown>;
    expect(message).toMatchObject({
      domain: "pilot.near.wallet-control.v1",
      authorization_id: "authorization-principal-alice",
      principal_id: "principal-alice",
      account_id: "alice.near",
      network: "near:mainnet",
      recipient: "pilot.near",
      nonce: challenge.signMessage.nonce,
    });
    expect(Buffer.from(challenge.signMessage.nonce, "base64url")).toHaveLength(32);
  });

  it("requires an injected full-access-key verifier and never approximates NEP-413", async () => {
    const { current, runtime, challenge } = issued();
    const verify = verifier();
    await expect(verifyNearWalletControlProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: current,
      proof: proof(),
      runtime: { ...runtime, mode: "challenge-only" },
      environment: ENVIRONMENT,
      verifier: verify,
      replayConsumer: replayConsumer(),
      now: NOW,
    })).rejects.toMatchObject({ code: "VERIFIER_UNAVAILABLE" });
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("denies a challenge replay after exact proof verification", async () => {
    const { current, runtime, challenge } = issued();
    const consume = replayConsumer();
    const input = {
      challengeCookie: challenge.cookie,
      currentAuthorization: current,
      proof: proof(),
      runtime,
      environment: ENVIRONMENT,
      verifier: verifier(),
      replayConsumer: consume,
      now: NOW,
    };
    await expect(verifyNearWalletControlProof(input)).resolves.toMatchObject({
      account_id: "alice.near",
      provider: "nep413-full-access-key",
    });
    await expect(verifyNearWalletControlProof(input)).rejects.toMatchObject({
      code: "PROOF_REPLAYED",
    });
  });

  it("reports a cryptographically invalid or non-full-access proof as invalid", async () => {
    const { current, runtime, challenge } = issued();
    for (const code of [
      "SIGNATURE_INVALID",
      "FULL_ACCESS_KEY_REQUIRED",
    ] as const) {
      await expect(verifyNearWalletControlProof({
        challengeCookie: challenge.cookie,
        currentAuthorization: current,
        proof: proof(),
        runtime,
        environment: ENVIRONMENT,
        verifier: {
          async verify() {
            throw new NearNep413VerifierError(code, "rejected");
          },
        },
        replayConsumer: replayConsumer(),
        now: NOW,
      })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    }
  });

  it("binds durable replay consumption to the exact authorization and rechecks expiry", async () => {
    const { current, runtime, challenge } = issued();
    const consume = vi.fn().mockResolvedValue(true);
    await expect(verifyNearWalletControlProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: current,
      proof: proof(),
      runtime,
      environment: ENVIRONMENT,
      verifier: verifier(),
      replayConsumer: { consume },
      now: NOW,
      clock: () => challenge.expiresAt,
    })).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    expect(consume).toHaveBeenCalledWith({
      principalId: "principal-alice",
      accountId: "alice.near",
      network: "near:mainnet",
      authorizationId: "authorization-principal-alice",
      recipient: "pilot.near",
      nonce: challenge.signMessage.nonce,
      expiresAt: challenge.expiresAt,
      now: NOW,
    });
  });

  it("denies cross-principal challenge reuse before invoking a verifier", async () => {
    const { runtime, challenge } = issued();
    const verify = verifier();
    await expect(verifyNearWalletControlProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: authorization("principal-bob", "alice.near"),
      proof: proof(),
      runtime,
      environment: ENVIRONMENT,
      verifier: verify,
      replayConsumer: replayConsumer(),
      now: NOW,
    })).rejects.toMatchObject({ code: "PRINCIPAL_MISMATCH" });
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("denies cross-account proof reuse before invoking a verifier", async () => {
    const { current, runtime, challenge } = issued();
    const verify = verifier();
    await expect(verifyNearWalletControlProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: current,
      proof: proof("bob.near"),
      runtime,
      environment: ENVIRONMENT,
      verifier: verify,
      replayConsumer: replayConsumer(),
      now: NOW,
    })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("denies a changed authorization scope with the same principal and account", async () => {
    const { current, runtime, challenge } = issued();
    await expect(verifyNearWalletControlProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: {
        ...current,
        operations: ["near.intents.tokens", "near.intents.approval.review"],
      },
      proof: proof(),
      runtime,
      environment: ENVIRONMENT,
      verifier: verifier(),
      replayConsumer: replayConsumer(),
      now: NOW,
    })).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
  });

  it("fails closed at the exact challenge expiry boundary", async () => {
    const { current, runtime, challenge } = issued();
    await expect(verifyNearWalletControlProof({
      challengeCookie: challenge.cookie,
      currentAuthorization: current,
      proof: proof(),
      runtime,
      environment: ENVIRONMENT,
      verifier: verifier(),
      replayConsumer: replayConsumer(),
      now: challenge.expiresAt,
    })).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects invalid provider and mode flags", () => {
    expect(() => resolveNearWalletProofRuntime({
      ...ENVIRONMENT,
      PILOT_NEAR_WALLET_PROOF_PROVIDER: "generic-message-signing",
    })).toThrow(NearWalletProofError);
    expect(() => resolveNearWalletProofRuntime({
      ...ENVIRONMENT,
      PILOT_NEAR_WALLET_PROOF_MODE: "enabled",
    })).toThrow(NearWalletProofError);
  });
});

