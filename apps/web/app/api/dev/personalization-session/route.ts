import { NextRequest, NextResponse } from "next/server";

import {
  WALLET_CHALLENGE_COOKIE,
  WALLET_CHALLENGE_COOKIE_OPTIONS,
  WALLET_SESSION_COOKIE,
  WALLET_SESSION_COOKIE_OPTIONS,
  WALLET_SUBMISSIONS_COOKIE,
} from "../../../../lib/wallet-session";
import {
  isPersonalizationFixtureBrowserRequest,
  PERSONALIZATION_FIXTURE_COOKIE,
  PERSONALIZATION_FIXTURE_COOKIE_OPTIONS,
  readPersonalizationFixtureSession,
  resolvePersonalizationFixtureScope,
  sealPersonalizationFixtureSession,
} from "../../../../lib/personalization-fixture-session";
import { getVaultService } from "../../vault/_lib/service";

export const runtime = "nodejs";

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "Personalization fixture session is unavailable." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

function payload(
  scope: { owner: string; network: "testnet" | "devnet" },
  expiresAt?: number,
) {
  return {
    enabled: true as const,
    authenticated: expiresAt !== undefined,
    ...(expiresAt === undefined ? {} : {
      account: scope.owner,
      network: scope.network,
      expiresAt,
    }),
  };
}

export function GET(request: NextRequest): NextResponse {
  const scope = resolvePersonalizationFixtureScope();
  if (!scope) return unavailable();
  const fixtureSession = readPersonalizationFixtureSession(request);
  const response = NextResponse.json(payload(
    scope,
    fixtureSession?.expiresAt,
  ));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const scope = resolvePersonalizationFixtureScope();
  if (!scope) return unavailable();
  if (!isPersonalizationFixtureBrowserRequest(request)) {
    return NextResponse.json(
      { error: "Same-origin personalization fixture authorization is required." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    await getVaultService().ensureScopedProfile(
      { ...scope, mainAccount: scope.owner },
      {
        main_account: scope.owner,
        budget_account: scope.owner,
        network: scope.network,
        risk: "low",
        preferences: [],
      },
    );
  } catch {
    return NextResponse.json(
      { error: "Personalization fixture storage is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const sealed = sealPersonalizationFixtureSession(scope);
  const expiresAt = sealed.expiresAt;
  const response = NextResponse.json(payload(scope, expiresAt));
  response.cookies.set(
    PERSONALIZATION_FIXTURE_COOKIE,
    sealed.token,
    PERSONALIZATION_FIXTURE_COOKIE_OPTIONS,
  );
  // The synthetic fixture identity is deliberately not a wallet session and
  // clears any unrelated wallet capabilities before the browser uses it.
  response.cookies.set(
    WALLET_SESSION_COOKIE,
    "",
    { ...WALLET_SESSION_COOKIE_OPTIONS, maxAge: 0 },
  );
  response.cookies.set(
    WALLET_SUBMISSIONS_COOKIE,
    "",
    { ...WALLET_SESSION_COOKIE_OPTIONS, maxAge: 0 },
  );
  response.cookies.set(
    WALLET_CHALLENGE_COOKIE,
    "",
    { ...WALLET_CHALLENGE_COOKIE_OPTIONS, maxAge: 0 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
