import { NextRequest, NextResponse } from "next/server";

import { createNearNep413FullAccessKeyVerifier } from "./near-nep413-verifier";
import {
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE_OPTIONS,
  NEAR_WALLET_CHALLENGE_COOKIE,
  NEAR_WALLET_CHALLENGE_COOKIE_OPTIONS,
  NearWalletProofError,
  readNearPrincipalAuthorization,
  resolveNearWalletProofRuntime,
  sealNearPrincipalAuthorization,
  type NearNep413FullAccessKeyVerifier,
  type NearWalletProofReplayConsumer,
  verifyNearWalletControlProof,
} from "./near-wallet-proof";
import {
  isNearPrincipalPreauthorization,
  upgradeNearPrincipalAuthorization,
} from "./near-principal-bootstrap";
import { readCookie } from "./openrouter-session";
import { resolvePilotRequestAuthority } from "./runtime-profile";
import { createHostedNearWalletProofReplayConsumer } from "./wallet-action-proof-consumer";
import { readWalletSession } from "./wallet-session";

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

export type NearSessionRouteDependencies = Readonly<{
  environment?: NodeJS.ProcessEnv;
  verifier?: NearNep413FullAccessKeyVerifier;
  replayConsumerFactory?: (binding: Readonly<{
    principalId: string;
    accountId: string;
    network: "near:mainnet";
    authorizationId: string;
    recipient: string;
  }>) => NearWalletProofReplayConsumer;
  clock?: () => number;
}>;

export function createNearSessionHandler(
  dependencies: NearSessionRouteDependencies = {},
): (request: NextRequest) => Promise<NextResponse> {
  return async function handleNearSession(request: NextRequest): Promise<NextResponse> {
    const environment = dependencies.environment ?? process.env;
    const clock = dependencies.clock ?? Date.now;
    let expectedOrigin: string;
    try {
      expectedOrigin = resolvePilotRequestAuthority(environment, request).origin;
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
      const runtimeConfiguration = resolveNearWalletProofRuntime(environment);
      const now = clock();
      const authorization = readNearPrincipalAuthorization(request, { environment, now });
      if (!authorization) {
        return NextResponse.json(
          { error: "An active server-issued NEAR principal authorization is required." },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }
      const binding = {
        principalId: authorization.principal_id,
        accountId: authorization.account_id,
        network: authorization.network,
        authorizationId: authorization.authorization_id,
        recipient: runtimeConfiguration.recipient,
      } as const;
      const replayConsumer = dependencies.replayConsumerFactory?.(binding) ??
        createHostedNearWalletProofReplayConsumer(binding, environment);
      const verified = await verifyNearWalletControlProof({
        challengeCookie: readCookie(request, NEAR_WALLET_CHALLENGE_COOKIE),
        currentAuthorization: authorization,
        proof: body,
        runtime: runtimeConfiguration,
        environment,
        verifier: dependencies.verifier ?? createNearNep413FullAccessKeyVerifier(),
        replayConsumer,
        now,
        clock,
      });
      const wallet = isNearPrincipalPreauthorization(verified.authorization)
        ? readWalletSession(request, environment)
        : null;
      if (isNearPrincipalPreauthorization(verified.authorization) && !wallet) {
        throw new NearWalletProofError(
          "PRINCIPAL_MISMATCH",
          "The Pilot wallet session changed during NEAR verification.",
        );
      }
      const upgraded = wallet
        ? upgradeNearPrincipalAuthorization({
            preauthorization: verified.authorization,
            wallet,
            environment,
            now: clock(),
          })
        : null;
      const response = NextResponse.json(
        {
          authenticated: true,
          wallet_control_verified: true,
          account_id: verified.account_id,
          network: verified.authorization.network,
          ...(upgraded ? {
            authorization_upgraded: true,
            operations: upgraded.operations,
          } : {}),
          execution_enabled: false,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
      response.cookies.set(NEAR_WALLET_CHALLENGE_COOKIE, "", {
        ...NEAR_WALLET_CHALLENGE_COOKIE_OPTIONS,
        maxAge: 0,
      });
      if (upgraded) {
        response.cookies.set(
          NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
          sealNearPrincipalAuthorization(upgraded, environment),
          {
            ...NEAR_PRINCIPAL_AUTHORIZATION_COOKIE_OPTIONS,
            maxAge: Math.max(
              1,
              Math.ceil((Date.parse(upgraded.expires_at) - clock()) / 1_000),
            ),
          },
        );
      }
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}
