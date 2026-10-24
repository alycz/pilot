import { NextRequest, NextResponse } from "next/server";

import { getDefaultModel } from "../../../../../lib/model-access";
import {
  matchesState,
  OPENROUTER_RETURN_TO_COOKIE,
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_VERIFIER_COOKIE,
  OPENROUTER_WALLET_BINDING_COOKIE,
  createPendingOpenRouterSession,
  openPendingWalletBinding,
  openRouterAttemptId,
  readCookie,
  safeReturnTo,
  sealPendingOpenRouterSession,
  PENDING_SESSION_COOKIE_OPTIONS,
} from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";

export const runtime = "nodejs";

const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

function errorResponse(
  message: string,
  status: number,
  publicOrigin?: string,
): NextResponse {
  const response = publicOrigin
    ? NextResponse.redirect(
        new URL("/onboarding?openrouter=error", publicOrigin),
        303,
      )
    : NextResponse.json({ error: message }, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let publicOrigin: string;
  try {
    publicOrigin = resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    return errorResponse("OpenRouter authorization is unavailable for this request", 403);
  }
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = readCookie(request, OPENROUTER_STATE_COOKIE);
  const verifier = readCookie(request, OPENROUTER_VERIFIER_COOKIE);
  const ownsCurrentAttempt = matchesState(expectedState, state);
  let pendingBinding: ReturnType<typeof openPendingWalletBinding>;
  try {
    pendingBinding = openPendingWalletBinding(
      readCookie(request, OPENROUTER_WALLET_BINDING_COOKIE),
    );
  } catch {
    return errorResponse(
      "OpenRouter authorization is not configured",
      503,
      publicOrigin,
    );
  }

  if (
    !code ||
    !verifier ||
    !ownsCurrentAttempt ||
    !pendingBinding ||
    pendingBinding.expiresAt <= Date.now()
  ) {
    return errorResponse(
      "Invalid or expired OpenRouter authorization",
      400,
      publicOrigin,
    );
  }

  let defaultModel: string;
  try {
    defaultModel = getDefaultModel();
  } catch {
    return errorResponse("OpenRouter model access is not configured", 503, publicOrigin);
  }

  let exchangeResponse: Response;
  try {
    exchangeResponse = await fetch(OPENROUTER_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return errorResponse(
      "OpenRouter authorization is temporarily unavailable",
      502,
      publicOrigin,
    );
  }

  if (
    !exchangeResponse.ok ||
    exchangeResponse.redirected ||
    (exchangeResponse.url && exchangeResponse.url !== OPENROUTER_EXCHANGE_URL)
  ) {
    return errorResponse("OpenRouter authorization was rejected", 502, publicOrigin);
  }

  let exchange: unknown;
  try {
    exchange = await exchangeResponse.json();
  } catch {
    return errorResponse(
      "OpenRouter returned an invalid authorization response",
      502,
      publicOrigin,
    );
  }

  const apiKey =
    exchange && typeof exchange === "object"
      ? (exchange as { key?: unknown }).key
      : undefined;
  if (
    typeof apiKey !== "string" ||
    apiKey.trim().length < 16 ||
    apiKey.trim().length > 512 ||
    /[\u0000-\u001f\u007f]/.test(apiKey)
  ) {
    return errorResponse(
      "OpenRouter returned an invalid authorization response",
      502,
      publicOrigin,
    );
  }

  const returnTo = safeReturnTo(
    readCookie(request, OPENROUTER_RETURN_TO_COOKIE),
    publicOrigin,
  );
  const finalizeUrl = new URL("/openrouter/finalize", publicOrigin);
  const response = NextResponse.redirect(finalizeUrl);
  try {
    response.cookies.set(
      OPENROUTER_PENDING_SESSION_COOKIE,
      sealPendingOpenRouterSession(createPendingOpenRouterSession({
        apiKey: apiKey.trim(),
        model: defaultModel,
        returnTo,
        attemptId: openRouterAttemptId(expectedState!),
      }, pendingBinding)),
      PENDING_SESSION_COOKIE_OPTIONS,
    );
  } catch {
    return errorResponse(
      "OpenRouter authorization could not create a session",
      503,
      publicOrigin,
    );
  }
  // Do not mutate attempt cookies from the cross-site callback response. A
  // reordered older callback must not clear a newer /start attempt. The
  // same-origin finalizer verifies the sealed attempt id before promotion;
  // attempt cookies expire after ten minutes or are overwritten by /start.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
