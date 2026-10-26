import { NextRequest, NextResponse } from "next/server";

import {
  NEAR_WALLET_CHALLENGE_COOKIE,
  NearWalletProofError,
  readNearPrincipalAuthorization,
  resolveNearWalletProofRuntime,
  verifyNearWalletControlProof,
} from "../../../../../lib/near-wallet-proof";
import { readCookie } from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";

export const runtime = "nodejs";

function sameOrigin(request: NextRequest, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === expectedOrigin;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof NearWalletProofError) {
    const status = error.code === "VERIFIER_UNAVAILABLE" ||
        error.code === "REPLAY_PROTECTION_UNAVAILABLE" ||
        error.code === "RUNTIME_DISABLED" || error.code === "RUNTIME_INVALID"
      ? 503
      : error.code === "PRINCIPAL_MISMATCH" || error.code === "ACCOUNT_MISMATCH"
        ? 403
        : 401;
    return NextResponse.json(
      { error: error.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { error: "NEAR wallet authorization failed." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let expectedOrigin: string;
  try {
    expectedOrigin = resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    return NextResponse.json(
      { error: "NEAR wallet authorization is unavailable for this request." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!sameOrigin(request, expectedOrigin)) {
    return NextResponse.json(
      { error: "Same-origin NEAR wallet authorization is required." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await request.json().catch(() => undefined);
  try {
    const runtimeConfiguration = resolveNearWalletProofRuntime(process.env);
    const authorization = readNearPrincipalAuthorization(request);
    if (!authorization) {
      return NextResponse.json(
        { error: "An active server-issued NEAR principal authorization is required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    await verifyNearWalletControlProof({
      challengeCookie: readCookie(request, NEAR_WALLET_CHALLENGE_COOKIE),
      currentAuthorization: authorization,
      proof: body,
      runtime: runtimeConfiguration,
    });
    // The current web dependency graph intentionally has no NEP-413 verifier,
    // so this response is unreachable until a reviewed verifier is injected.
    return NextResponse.json(
      { authenticated: true, execution_enabled: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

