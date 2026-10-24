import { NextRequest, NextResponse } from "next/server";

import {
  issueWalletActionChallenge,
} from "../../../../../lib/wallet-action-proof";
import {
  isLocalWalletProfile,
  resolvePilotRequestAuthority,
} from "../../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../../lib/wallet-session";

export const runtime = "nodejs";

function error(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let authority;
  try {
    authority = resolvePilotRequestAuthority(process.env, request);
  } catch {
    return error("Wallet action authorization is unavailable for this request.", 403);
  }
  if (
    !isLocalWalletProfile(authority.profile) ||
    request.headers.get("origin") !== authority.origin
  ) {
    return error("Same-origin local wallet authorization is required.", 403);
  }

  const session = readWalletSession(request);
  if (!session) return error("A wallet-bound session is required.", 401);
  const body = await request.json().catch(() => undefined) as
    | { action?: unknown; request_digest?: unknown }
    | undefined;
  if (
    !body ||
    Object.keys(body).sort().join("\0") !== "action\0request_digest" ||
    body.action !== "chat" ||
    typeof body.request_digest !== "string" ||
    !/^[A-Fa-f0-9]{64}$/.test(body.request_digest)
  ) {
    return error("A valid wallet action request digest is required.", 400);
  }

  try {
    const challenge = issueWalletActionChallenge(
      session,
      "chat",
      body.request_digest,
    );
    return NextResponse.json({
      account: session.account,
      network: session.network,
      challenge: challenge.token,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      tx_json: challenge.txJson,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return error("Wallet action authorization is not configured.", 503);
  }
}
