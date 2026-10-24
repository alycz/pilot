import { NextRequest, NextResponse } from "next/server";

import {
  generatePkce,
  OAUTH_COOKIE_OPTIONS,
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_RETURN_TO_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_VERIFIER_COOKIE,
  OPENROUTER_WALLET_BINDING_COOKIE,
  PENDING_SESSION_COOKIE_OPTIONS,
  safeReturnTo,
  sealPendingWalletBinding,
  walletModelBinding,
} from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../../lib/wallet-session";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  let publicOrigin: string;
  try {
    publicOrigin = resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    return NextResponse.json(
      { error: "OpenRouter authorization is unavailable for this request." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  let binding: ReturnType<typeof walletModelBinding>;
  try {
    const wallet = readWalletSession(request);
    binding = wallet && walletModelBinding(request, wallet);
  } catch {
    return NextResponse.json(
      { error: "OpenRouter authorization is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!binding) {
    return NextResponse.json(
      { error: "Authenticate a wallet before connecting OpenRouter." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { state, verifier, challenge } = generatePkce();
  const callbackUrl = new URL("/api/auth/openrouter/callback", publicOrigin);

  const authorizationUrl = new URL("https://openrouter.ai/auth");
  authorizationUrl.searchParams.set("callback_url", callbackUrl.toString());
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(OPENROUTER_STATE_COOKIE, state, OAUTH_COOKIE_OPTIONS);
  response.cookies.set(OPENROUTER_VERIFIER_COOKIE, verifier, OAUTH_COOKIE_OPTIONS);
  try {
    response.cookies.set(
      OPENROUTER_WALLET_BINDING_COOKIE,
      sealPendingWalletBinding(binding),
      OAUTH_COOKIE_OPTIONS,
    );
  } catch {
    return NextResponse.json(
      { error: "OpenRouter authorization is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  response.cookies.set(
    OPENROUTER_RETURN_TO_COOKIE,
    safeReturnTo(request.nextUrl.searchParams.get("returnTo"), publicOrigin),
    OAUTH_COOKIE_OPTIONS,
  );
  // A new authorization attempt supersedes any callback that reached the
  // same-origin promotion step but was never finalized.
  response.cookies.set(OPENROUTER_PENDING_SESSION_COOKIE, "", {
    ...PENDING_SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
