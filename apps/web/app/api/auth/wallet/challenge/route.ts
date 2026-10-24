import { NextRequest, NextResponse } from "next/server";
import { isValidClassicAddress } from "xrpl";

import {
  resolvePilotRequestAuthority,
} from "../../../../../lib/runtime-profile";
import {
  issueWalletChallenge,
  WALLET_CHALLENGE_COOKIE,
  WALLET_CHALLENGE_COOKIE_OPTIONS,
  type WalletSessionNetwork,
} from "../../../../../lib/wallet-session";

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
  const body = await request.json().catch(() => undefined) as
    | { account?: unknown; network?: unknown }
    | undefined;
  if (
    !body ||
    typeof body.account !== "string" ||
    !isValidClassicAddress(body.account) ||
    (body.network !== "testnet" && body.network !== "devnet")
  ) {
    return NextResponse.json({ error: "A valid test-network wallet is required." }, { status: 400 });
  }
  try {
    const challenge = issueWalletChallenge(
      body.account,
      body.network as WalletSessionNetwork,
    );
    const response = NextResponse.json({
      account: body.account,
      network: body.network,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      tx_json: challenge.txJson,
    });
    response.cookies.set(
      WALLET_CHALLENGE_COOKIE,
      challenge.cookie,
      WALLET_CHALLENGE_COOKIE_OPTIONS,
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Wallet authorization is not configured." }, { status: 503 });
  }
}
