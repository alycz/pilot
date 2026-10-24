import { NextRequest, NextResponse } from "next/server";

import {
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_SESSION_COOKIE,
  PENDING_SESSION_COOKIE_OPTIONS,
  SESSION_COOKIE_OPTIONS,
  createOpenRouterSession,
  matchesState,
  matchesWalletModelBinding,
  openPendingOpenRouterSession,
  openRouterAttemptId,
  readCookie,
  readWalletBoundOpenRouterSession,
  safeReturnTo,
  sealOpenRouterSession,
} from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../../lib/wallet-session";

export const runtime = "nodejs";

function clearPending(response: NextResponse): void {
  response.cookies.set(OPENROUTER_PENDING_SESSION_COOKIE, "", {
    ...PENDING_SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
}

function failure(message: string, status: number): NextResponse {
  const response = NextResponse.json({ error: message }, { status });
  response.headers.set("Cache-Control", "no-store");
  clearPending(response);
  return response;
}

/**
 * Promote the callback's short-lived credential only from a fresh same-origin
 * request. This extra hop is required because the wallet cookie intentionally
 * remains SameSite=Strict and is therefore absent on OpenRouter's callback.
 */
export function POST(request: NextRequest): NextResponse {
  let origin: string;
  try {
    origin = resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    return failure("OpenRouter authorization is unavailable for this request", 403);
  }
  if (request.headers.get("origin") !== origin) {
    return failure("Same-origin OpenRouter finalization is required", 403);
  }

  try {
    const wallet = readWalletSession(request);
    if (!wallet) {
      return failure("Invalid or expired wallet-bound OpenRouter authorization", 400);
    }
    const pending = openPendingOpenRouterSession(
      readCookie(request, OPENROUTER_PENDING_SESSION_COOKIE),
    );
    if (!pending) {
      const current = readWalletBoundOpenRouterSession(request, wallet);
      if (current?.mode === "oauth") {
        const response = NextResponse.json({
          connected: true,
          returnTo: safeReturnTo(undefined, origin),
        });
        clearPending(response);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
      return failure("Invalid or expired wallet-bound OpenRouter authorization", 400);
    }
    const currentState = readCookie(request, OPENROUTER_STATE_COOKIE);
    if (
      !currentState ||
      !matchesState(pending.attemptId, openRouterAttemptId(currentState)) ||
      !matchesWalletModelBinding(pending.wallet, request, wallet)
    ) {
      return failure("Invalid or expired wallet-bound OpenRouter authorization", 400);
    }

    const response = NextResponse.json({
      connected: true,
      returnTo: safeReturnTo(pending.returnTo, origin),
    });
    response.cookies.set(
      OPENROUTER_SESSION_COOKIE,
      sealOpenRouterSession(createOpenRouterSession({
        mode: "oauth",
        apiKey: pending.apiKey,
        model: pending.model,
      }, pending.wallet)),
      SESSION_COOKIE_OPTIONS,
    );
    clearPending(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return failure("OpenRouter authorization could not create a wallet-bound session", 503);
  }
}
