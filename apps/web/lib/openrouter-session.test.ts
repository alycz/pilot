import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OPENROUTER_SESSION_COOKIE,
  createOpenRouterSession,
  generatePkce,
  matchesState,
  openPendingWalletBinding,
  openOpenRouterSession,
  readWalletBoundOpenRouterSession,
  safeReturnTo,
  sealPendingWalletBinding,
  sealOpenRouterSession,
  walletModelBinding,
  type WalletModelBinding,
} from "./openrouter-session";
import { WALLET_SESSION_COOKIE } from "./wallet-session";

const SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";
const PUBLIC_ORIGIN = "https://pilot.example";

describe("OpenRouter session encryption", () => {
  const NOW = Date.parse("2026-10-21T12:00:00.000Z");
  const wallet: WalletModelBinding = {
    account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
    network: "testnet",
    expiresAt: NOW + 60 * 60 * 1_000,
    sessionId: "a".repeat(64),
  };

  it("round-trips an OAuth session without exposing plaintext", () => {
    const session = createOpenRouterSession({
      mode: "oauth" as const,
      model: "anthropic/claude-sonnet-4",
      apiKey: "sk-or-secret-value",
    }, wallet, NOW);
    const encrypted = sealOpenRouterSession(session, SECRET);

    expect(encrypted).not.toContain("sk-or-secret-value");
    expect(openOpenRouterSession(encrypted, SECRET, NOW)).toEqual(session);
  });

  it("round-trips an explicit wallet-bound NEAR AI session without any provider credential", () => {
    const session = createOpenRouterSession({
      mode: "near-ai" as const,
      provider: "near-ai" as const,
      model: "z-ai/example-model",
    }, wallet, NOW);
    const encrypted = sealOpenRouterSession(session, SECRET);

    expect(openOpenRouterSession(encrypted, SECRET, NOW)).toEqual(session);
    expect(JSON.stringify(session)).not.toContain("apiKey");
  });

  it("rejects tampered ciphertext and the wrong secret", () => {
    const encrypted = sealOpenRouterSession(
      createOpenRouterSession(
        { mode: "demo", model: "provider/model:free" },
        wallet,
        NOW,
      ),
      SECRET,
    );
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("a") ? "b" : "a"}`;

    expect(openOpenRouterSession(tampered, SECRET, NOW)).toBeNull();
    expect(
      openOpenRouterSession(
        encrypted,
        "different-session-secret-that-is-also-at-least-thirty-two-chars",
        NOW,
      ),
    ).toBeNull();
  });

  it("enforces the sealed absolute expiry and rejects legacy session versions", () => {
    const session = createOpenRouterSession(
      { mode: "demo", model: "provider/model:free" },
      wallet,
      NOW,
    );
    const encrypted = sealOpenRouterSession(session, SECRET);
    expect(openOpenRouterSession(encrypted, SECRET, session.expiresAt)).toBeNull();
    expect(openOpenRouterSession("v1.invalid.invalid.invalid", SECRET, NOW)).toBeNull();
  });

  it("rejects an otherwise valid encrypted OAuth session after any exact wallet binding changes", () => {
    const originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = SECRET;
    try {
      const walletCookie = "sealed-wallet-session-a";
      const walletRequest = new Request(PUBLIC_ORIGIN, {
        headers: { Cookie: `${WALLET_SESSION_COOKIE}=${walletCookie}` },
      });
      const binding = walletModelBinding(walletRequest, wallet)!;
      const encrypted = sealOpenRouterSession(createOpenRouterSession({
        mode: "oauth",
        model: "provider/model",
        apiKey: "sk-or-valid-test-secret",
      }, binding, NOW), SECRET);
      const requestWithSession = (nextWalletCookie: string) => new Request(PUBLIC_ORIGIN, {
        headers: {
          Cookie: [
            `${WALLET_SESSION_COOKIE}=${nextWalletCookie}`,
            `${OPENROUTER_SESSION_COOKIE}=${encrypted}`,
          ].join("; "),
        },
      });

      expect(readWalletBoundOpenRouterSession(
        requestWithSession(walletCookie),
        wallet,
        NOW,
      )).toMatchObject({ mode: "oauth", wallet: binding });

      const changedBindings = [
        {
          name: "account",
          cookie: walletCookie,
          wallet: { ...wallet, account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" },
        },
        {
          name: "network",
          cookie: walletCookie,
          wallet: { ...wallet, network: "devnet" as const },
        },
        {
          name: "session id",
          cookie: "sealed-wallet-session-b",
          wallet,
        },
        {
          name: "expiry",
          cookie: walletCookie,
          wallet: { ...wallet, expiresAt: wallet.expiresAt + 1 },
        },
      ];

      for (const changed of changedBindings) {
        expect(
          readWalletBoundOpenRouterSession(
            requestWithSession(changed.cookie),
            changed.wallet,
            NOW,
          ),
          changed.name,
        ).toBeNull();
      }
    } finally {
      if (originalSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSecret;
    }
  });
});

describe("PKCE and callback safety", () => {
  it("creates an S256 challenge from a high-entropy verifier", () => {
    const { state, verifier, challenge } = generatePkce();

    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(
      createHash("sha256").update(verifier, "ascii").digest("base64url"),
    );
    expect(matchesState(state, state)).toBe(true);
    expect(matchesState(state, `${state}x`)).toBe(false);
  });

  it("enforces the signed OAuth-attempt expiry independently of cookie Max-Age", () => {
    const issuedAt = Date.parse("2026-10-21T12:00:00.000Z");
    const wallet: WalletModelBinding = {
      account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
      network: "testnet",
      expiresAt: issuedAt + 60 * 60 * 1_000,
      sessionId: "b".repeat(64),
    };
    const sealed = sealPendingWalletBinding(wallet, SECRET, issuedAt);

    expect(openPendingWalletBinding(sealed, SECRET, issuedAt + 9 * 60 * 1_000))
      .toEqual(wallet);
    expect(openPendingWalletBinding(sealed, SECRET, issuedAt + 10 * 60 * 1_000))
      .toBeNull();
  });

  it("allows only same-origin relative return paths", () => {
    expect(safeReturnTo("/settings?tab=ai#models", PUBLIC_ORIGIN)).toBe(
      "/settings?tab=ai#models",
    );
  });

  it.each([
    "https://evil.example/steal",
    "//evil.example/steal",
    String.raw`/\evil.example/steal`,
    String.raw`/\\evil.example/steal`,
    "/%5cevil.example/steal",
    "/%5Cevil.example/steal",
    "/settings\u0000/steal",
    "/settings\n/steal",
    "/settings/%0a/steal",
    "//pilot.example@evil.example/steal",
    "//user:password@pilot.example/settings",
  ])("rejects an unsafe return path %j", (returnTo) => {
    expect(safeReturnTo(returnTo, PUBLIC_ORIGIN)).toBe(
      "/onboarding?openrouter=connected",
    );
  });
});
