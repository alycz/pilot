import type { Envelope } from "@pilot/contracts";
import {
  NearNativeNearToArbitrumUsdcReconcileRequestSchema,
  NearNativeNearToArbitrumUsdcReconcileResultSchema,
  NearNativeNearToArbitrumUsdcReserveRequestSchema,
  type NearNativeNearToArbitrumUsdcReconcileRequest,
  type NearNativeNearToArbitrumUsdcReconcileResult,
  type NearPrincipalAuthorization,
} from "@pilot/contracts/near";
import { createHarborRestClient } from "@pilot/harbor-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  readNearPrincipalAuthorization,
  type NearWalletProofEnvironment,
} from "./near-wallet-proof";
import {
  resolveCredentialedHarborUpstream,
  resolvePilotRequestAuthority,
} from "./runtime-profile";

const MAX_BODY_BYTES = 256 * 1_024;
const RECONCILE_OPERATION = "near.intents.owner-funded.reconcile" as const;

const ReconcileBodySchema = z.object({
  reconciliation_context: NearNativeNearToArbitrumUsdcReserveRequestSchema,
  stage: z.enum(["source-funding", "settlement"]),
  transition_id: z.string().min(1).max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  expected_entry_revision: z.number().int().positive(),
  near_transaction_hash: z.string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{43,45}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.stage === "source-funding" && value.near_transaction_hash === undefined) {
    context.addIssue({
      code: "custom",
      path: ["near_transaction_hash"],
      message: "source-funding reconciliation requires the owner-reported NEAR transaction hash",
    });
  }
  if (value.stage === "settlement" && value.near_transaction_hash !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["near_transaction_hash"],
      message: "settlement reconciliation must use the source hash already bound in durable state",
    });
  }
});

type Environment = NearWalletProofEnvironment & Readonly<{
  HARBOR_API_KEY?: string;
  HARBOR_URL?: string;
  NEXT_PUBLIC_DEV_SIGNER?: string;
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_PUBLIC_ORIGIN?: string;
}>;

export type NearOwnerFundedReconcileClient = Readonly<{
  op(
    name: typeof RECONCILE_OPERATION,
    args: NearNativeNearToArbitrumUsdcReconcileRequest,
  ): Promise<Envelope<NearNativeNearToArbitrumUsdcReconcileResult>>;
}>;

export type NearOwnerFundedReconcileHandlerDependencies = Readonly<{
  environment?: Environment;
  clock?: () => number;
  reconcileClient?: NearOwnerFundedReconcileClient;
}>;

function fail(status: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function boundedJson(request: NextRequest): Promise<unknown> {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("unsupported-media-type");
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  ) {
    throw new Error("invalid-body");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error("invalid-body");
  }
  return JSON.parse(body) as unknown;
}

function activeAuthorization(
  request: NextRequest,
  environment: Environment,
  now: number,
): NearPrincipalAuthorization | null {
  const authorization = readNearPrincipalAuthorization(request, {
    environment,
    now,
  });
  return authorization?.network === "near:mainnet" &&
      authorization.operations.includes(RECONCILE_OPERATION)
    ? authorization
    : null;
}

export function createNearOwnerFundedReconcileHandler(
  dependencies: NearOwnerFundedReconcileHandlerDependencies = {},
): (request: NextRequest) => Promise<NextResponse> {
  return async function handleReconcile(request): Promise<NextResponse> {
    const environment = dependencies.environment ?? process.env;
    const now = dependencies.clock?.() ?? Date.now();
    try {
      const expectedOrigin = resolvePilotRequestAuthority(environment, request).origin;
      if (request.headers.get("origin") !== expectedOrigin) {
        return fail(403, "Same-origin NEAR reconciliation is required.");
      }
    } catch {
      return fail(403, "NEAR reconciliation is unavailable for this request.");
    }

    let authorization: NearPrincipalAuthorization | null;
    try {
      authorization = activeAuthorization(request, environment, now);
    } catch {
      return fail(503, "NEAR reconciliation authorization is unavailable.");
    }
    if (!authorization) {
      return fail(401, "An active principal-bound NEAR reconciliation authorization is required.");
    }

    let parsed: z.infer<typeof ReconcileBodySchema>;
    try {
      const result = ReconcileBodySchema.safeParse(await boundedJson(request));
      if (!result.success) return fail(400, "The NEAR reconciliation request is invalid.");
      parsed = result.data;
    } catch {
      return fail(400, "The NEAR reconciliation request is invalid.");
    }

    const reserve = parsed.reconciliation_context;
    if (
      reserve.approval.payload.principal_id !== authorization.principal_id ||
      reserve.approval.payload.near_account_id !== authorization.account_id ||
      reserve.approval.payload.network !== authorization.network ||
      reserve.quote_binding.refund_to !== authorization.account_id
    ) {
      return fail(403, "The NEAR reconciliation context does not match the active principal.");
    }

    const requestInput = NearNativeNearToArbitrumUsdcReconcileRequestSchema.safeParse({
      ...reserve,
      version: "pilot-near-native-to-arbitrum-usdc-reconcile-request-v1",
      account_id: authorization.account_id,
      stage: parsed.stage,
      transition_id: parsed.transition_id,
      expected_entry_revision: parsed.expected_entry_revision,
      ...(parsed.near_transaction_hash === undefined
        ? {}
        : { near_transaction_hash: parsed.near_transaction_hash }),
    });
    if (!requestInput.success) {
      return fail(400, "The NEAR reconciliation context is invalid.");
    }

    try {
      const client = dependencies.reconcileClient ?? (() => {
        const upstream = resolveCredentialedHarborUpstream(environment, request);
        return createHarborRestClient({
          ...upstream,
          mock: false,
          signal: request.signal,
          timeoutMs: 10_000,
        });
      })();
      const envelope = await client.op(RECONCILE_OPERATION, requestInput.data);
      if (!envelope.ok) {
        return fail(503, "NEAR reconciliation remains unavailable; its prior state is unchanged.");
      }
      const result = NearNativeNearToArbitrumUsdcReconcileResultSchema.safeParse(
        envelope.data,
      );
      if (
        !result.success ||
        result.data.attempt_id !== reserve.attempt_id ||
        result.data.execution_enabled !== false ||
        result.data.safe_to_resubmit !== false
      ) {
        return fail(503, "NEAR reconciliation returned an invalid state transition.");
      }
      return NextResponse.json(result.data, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      return fail(503, "NEAR reconciliation remains unknown; do not submit a replacement transfer.");
    }
  };
}
