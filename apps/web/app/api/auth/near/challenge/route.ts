import { NextRequest, NextResponse } from "next/server";

import {
  NEAR_WALLET_CHALLENGE_COOKIE,
  NEAR_WALLET_CHALLENGE_COOKIE_OPTIONS,
  issueNearWalletProofChallenge,
  readNearPrincipalAuthorization,
  resolveNearWalletProofRuntime,
} from "../../../../../lib/near-wallet-proof";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";

export const runtime = "nodejs";

function sameOrigin(request: NextRequest, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === expectedOrigin;
}

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "NEAR wallet authorization is unavailable." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export function POST(request: NextRequest): NextResponse {
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
  try {
    const runtimeConfiguration = resolveNearWalletProofRuntime(process.env);
    const authorization = readNearPrincipalAuthorization(request);
    if (!authorization) {
      return NextResponse.json(
        { error: "An active server-issued NEAR principal authorization is required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const challenge = issueNearWalletProofChallenge({
      authorization,
      runtime: runtimeConfiguration,
    });
    const response = NextResponse.json({
      account_id: authorization.account_id,
      network: authorization.network,
      provider: runtimeConfiguration.provider,
      expires_at: new Date(challenge.expiresAt).toISOString(),
      sign_message: challenge.signMessage,
      verification_available: false,
      execution_enabled: false,
    });
    response.cookies.set(
      NEAR_WALLET_CHALLENGE_COOKIE,
      challenge.cookie,
      NEAR_WALLET_CHALLENGE_COOKIE_OPTIONS,
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return unavailable();
  }
}

