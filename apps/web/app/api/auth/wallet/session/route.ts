import { NextRequest, NextResponse } from "next/server";

import {
  resolvePilotRequestAuthority,
} from "../../../../../lib/runtime-profile";
import {
  readWalletSession,
  sealWalletSession,
  verifyWalletChallengeForConsumption,
  WALLET_CHALLENGE_COOKIE,
  WALLET_CHALLENGE_COOKIE_OPTIONS,
  WALLET_SESSION_COOKIE,
  WALLET_SESSION_COOKIE_OPTIONS,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../../lib/wallet-session";
import { createWalletActionProofConsumer } from "../../../../../lib/wallet-action-proof-consumer";
import {
  OAUTH_COOKIE_OPTIONS,
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_RETURN_TO_COOKIE,
  OPENROUTER_SESSION_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_VERIFIER_COOKIE,
  OPENROUTER_WALLET_BINDING_COOKIE,
  PENDING_SESSION_COOKIE_OPTIONS,
  SESSION_COOKIE_OPTIONS,
  readCookie,
} from "../../../../../lib/openrouter-session";

export const runtime = "nodejs";

function expectedRequestOrigin(request: NextRequest): string {
  return resolvePilotRequestAuthority(process.env, request).origin;
}

function boundaryError(): NextResponse {
  return NextResponse.json(
    { error: "Wallet authorization is unavailable for this request." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

function sameOrigin(request: NextRequest, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === expectedOrigin;
}

function clearModelCookies(response: NextResponse): void {
  response.cookies.set(OPENROUTER_SESSION_COOKIE, "", {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
  for (const name of [
    OPENROUTER_STATE_COOKIE,
    OPENROUTER_VERIFIER_COOKIE,
    OPENROUTER_RETURN_TO_COOKIE,
    OPENROUTER_WALLET_BINDING_COOKIE,
  ]) {
    response.cookies.set(name, "", { ...OAUTH_COOKIE_OPTIONS, maxAge: 0 });
  }
  response.cookies.set(OPENROUTER_PENDING_SESSION_COOKIE, "", {
    ...PENDING_SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
}

export function GET(request: NextRequest): NextResponse {
  try {
    expectedRequestOrigin(request);
  } catch {
    return boundaryError();
  }
  const session = readWalletSession(request);
  const response = NextResponse.json({
    authenticated: session !== null,
    ...(session ? {
      account: session.account,
      network: session.network,
      expiresAt: session.expiresAt,
    } : {}),
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let expectedOrigin: string;
  try {
    expectedOrigin = expectedRequestOrigin(request);
  } catch {
    return boundaryError();
  }
  if (!sameOrigin(request, expectedOrigin)) {
    return NextResponse.json({ error: "Same-origin wallet authorization is required." }, { status: 403 });
  }
  const body = await request.json().catch(() => undefined) as { tx_blob?: unknown } | undefined;
  if (!body || typeof body.tx_blob !== "string") {
    return NextResponse.json({ error: "A signed wallet authorization proof is required." }, { status: 400 });
  }
  try {
    const now = Date.now();
    const verified = verifyWalletChallengeForConsumption(
      readCookie(request, WALLET_CHALLENGE_COOKIE),
      body.tx_blob,
      { now },
    );
    let consumed: boolean;
    try {
      const consumer = createWalletActionProofConsumer(
        verified.session,
        "wallet-auth",
      );
      consumed = await consumer.consume(
        verified.nonce,
        verified.challengeExpiresAt,
        now,
      );
    } catch {
      return NextResponse.json(
        { error: "Wallet authorization replay protection is unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!consumed) {
      throw new Error("The wallet authorization proof was already used.");
    }
    if (Date.now() >= verified.challengeExpiresAt) {
      throw new Error("The wallet authorization challenge expired during verification.");
    }
    const session = verified.session;
    const response = NextResponse.json({
      authenticated: true,
      account: session.account,
      network: session.network,
      expiresAt: session.expiresAt,
    });
    response.cookies.set(
      WALLET_SESSION_COOKIE,
      sealWalletSession(session),
      WALLET_SESSION_COOKIE_OPTIONS,
    );
    response.cookies.set(
      WALLET_CHALLENGE_COOKIE,
      "",
      { ...WALLET_CHALLENGE_COOKIE_OPTIONS, maxAge: 0 },
    );
    // A replacement identity must never inherit build/hash capabilities from
    // the prior wallet session, even when the public account is the same.
    response.cookies.set(
      WALLET_SUBMISSIONS_COOKIE,
      "",
      { ...WALLET_SESSION_COOKIE_OPTIONS, maxAge: 0 },
    );
    clearModelCookies(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Wallet authorization failed." },
      { status: 401 },
    );
  }
}

export function DELETE(request: NextRequest): NextResponse {
  let expectedOrigin: string;
  try {
    expectedOrigin = expectedRequestOrigin(request);
  } catch {
    return boundaryError();
  }
  if (!sameOrigin(request, expectedOrigin)) {
    return NextResponse.json({ error: "Same-origin wallet authorization is required." }, { status: 403 });
  }
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(WALLET_SESSION_COOKIE, "", { ...WALLET_SESSION_COOKIE_OPTIONS, maxAge: 0 });
  response.cookies.set(WALLET_SUBMISSIONS_COOKIE, "", { ...WALLET_SESSION_COOKIE_OPTIONS, maxAge: 0 });
  response.cookies.set(WALLET_CHALLENGE_COOKIE, "", { ...WALLET_CHALLENGE_COOKIE_OPTIONS, maxAge: 0 });
  clearModelCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
