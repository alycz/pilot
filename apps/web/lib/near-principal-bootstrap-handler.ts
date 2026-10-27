import { NearAccountIdSchema } from "@pilot/contracts/near";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isHarborHostedStateConfigured } from "./harbor-hosted-state-client";
import {
  createNearPrincipalPreauthorization,
  type NearPrincipalBootstrapEnvironment,
} from "./near-principal-bootstrap";
import {
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
  NEAR_PRINCIPAL_AUTHORIZATION_COOKIE_OPTIONS,
  resolveNearWalletProofRuntime,
  sealNearPrincipalAuthorization,
} from "./near-wallet-proof";
import { resolvePilotRequestAuthority } from "./runtime-profile";
import { readWalletSession } from "./wallet-session";

const MAX_BODY_BYTES = 4_096;
const BootstrapRequestSchema = z.object({
  bootstrap: z.literal(true),
  account_id: NearAccountIdSchema,
  network: z.literal("near:mainnet"),
}).strict();

type Environment = NodeJS.ProcessEnv & NearPrincipalBootstrapEnvironment;

export type NearPrincipalBootstrapHandlerDependencies = Readonly<{
  environment?: Environment;
  clock?: () => number;
  replayProtectionConfigured?: (environment: Environment) => boolean;
}>;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function boundedJson(request: NextRequest): Promise<unknown> {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new Error("invalid body");
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  ) throw new Error("invalid body");
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error("invalid body");
  }
  return JSON.parse(body) as unknown;
}

export function createNearPrincipalBootstrapHandler(
  dependencies: NearPrincipalBootstrapHandlerDependencies = {},
): (request: NextRequest) => Promise<NextResponse> {
  return async function handleBootstrap(request): Promise<NextResponse> {
    const environment = dependencies.environment ?? process.env;
    let expectedOrigin: string;
    try {
      expectedOrigin = resolvePilotRequestAuthority(environment, request).origin;
    } catch {
      return jsonError(403, "NEAR principal bootstrap is unavailable for this request.");
    }
    if (request.headers.get("origin") !== expectedOrigin) {
      return jsonError(403, "Same-origin NEAR principal bootstrap is required.");
    }
    try {
      if (
        environment.PILOT_DEPLOYMENT_PROFILE !== "hosted" ||
        environment.PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED !== "true" ||
        resolveNearWalletProofRuntime(environment).mode !== "verify" ||
        !(dependencies.replayProtectionConfigured ??
          isHarborHostedStateConfigured)(environment)
      ) {
        return jsonError(503, "NEAR principal bootstrap is unavailable.");
      }
      const body = BootstrapRequestSchema.safeParse(await boundedJson(request));
      if (!body.success) {
        return jsonError(400, "A valid explicit NEAR mainnet bootstrap request is required.");
      }
      const wallet = readWalletSession(request, environment);
      if (!wallet) {
        return jsonError(401, "An active Pilot wallet session is required.");
      }
      const now = (dependencies.clock ?? Date.now)();
      const authorization = createNearPrincipalPreauthorization({
        accountId: body.data.account_id,
        wallet,
        environment,
        now,
      });
      const maxAge = Math.max(
        1,
        Math.ceil((Date.parse(authorization.expires_at) - now) / 1_000),
      );
      const response = NextResponse.json({
        preauthorized: true,
        account_id: authorization.account_id,
        network: authorization.network,
        operations: authorization.operations,
        expires_at: authorization.expires_at,
        wallet_control_verified: false,
        execution_enabled: false,
      }, { headers: { "Cache-Control": "no-store" } });
      response.cookies.set(
        NEAR_PRINCIPAL_AUTHORIZATION_COOKIE,
        sealNearPrincipalAuthorization(authorization, environment),
        { ...NEAR_PRINCIPAL_AUTHORIZATION_COOKIE_OPTIONS, maxAge },
      );
      return response;
    } catch {
      return jsonError(503, "NEAR principal bootstrap is unavailable.");
    }
  };
}
