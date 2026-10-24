import type { OpContext, OpDef } from "../catalog/registry";
import { z } from "zod";
import {
  X402ClassicAddressSchema,
  X402PayRequestSchema,
  X402PayResponseSchema,
  X402PublicPayResponseSchema,
  type X402PayRequest,
  type X402PublicPayResponse,
  type X402Service,
} from "../x402-contract";
import {
  isReviewedLocalX402IsolatedV1Context,
  localX402IsolatedV1MarkersPresent,
} from "../local-x402-isolated-v1";
import { LOCAL_X402_COMPARE_PRICE_DROPS } from "../local-x402";

const LocalX402IsolatedV1PayRequestSchema = X402PayRequestSchema.extend({
  max_price_drops: z.literal(LOCAL_X402_COMPARE_PRICE_DROPS),
  pay_to: X402PayRequestSchema.shape.pay_to.unwrap(),
});

const LegacyX402PayRequestSchema = X402PayRequestSchema.omit({
  pay_to: true,
});

export const X402_RUNTIME_DISABLED = "X402_RUNTIME_DISABLED";
export const X402_LOCAL_ONLY = "X402_LOCAL_ONLY";
export const X402_AUTH_REQUIRED = "X402_AUTH_REQUIRED";
export const X402_NOT_CONFIGURED = "X402_NOT_CONFIGURED";
export const X402_SIGNING_PROFILE = "reviewed-testnet-local-v1";

export type X402OperationErrorCode =
  | typeof X402_RUNTIME_DISABLED
  | typeof X402_LOCAL_ONLY
  | typeof X402_AUTH_REQUIRED
  | typeof X402_NOT_CONFIGURED;

const ERROR_MESSAGES = Object.freeze({
  [X402_RUNTIME_DISABLED]: "Local x402 runtime is disabled",
  [X402_LOCAL_ONLY]: "x402.pay is available only to local development requests",
  [X402_AUTH_REQUIRED]: "x402.pay requires an authenticated principal",
  [X402_NOT_CONFIGURED]: "Local x402 runtime is not configured",
} satisfies Record<X402OperationErrorCode, string>);

export class X402OperationError extends Error {
  constructor(readonly code: X402OperationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "X402OperationError";
  }
}

type X402Context = OpContext & {
  localDevRequest?: unknown;
  env?: unknown;
  x402Service?: unknown;
};

function requiredEnvironment(ctx: X402Context): Record<string, unknown> {
  if (typeof ctx.env !== "object" || ctx.env === null) {
    throw new X402OperationError(X402_RUNTIME_DISABLED);
  }
  const env = ctx.env as Record<string, unknown>;
  if (localX402IsolatedV1MarkersPresent(env)) {
    if (!isReviewedLocalX402IsolatedV1Context(ctx)) {
      throw new X402OperationError(X402_RUNTIME_DISABLED);
    }
    return env;
  }
  if (
    env.HARBOR_LOCAL_DEV !== "true" ||
    env.HARBOR_LOCAL_X402 !== "true" ||
    !X402ClassicAddressSchema.safeParse(env.HARBOR_LOCAL_X402_MERCHANT_PAY_TO).success ||
    env.HARBOR_LOCAL_X402_RUNTIME_ENABLED !== "true" ||
    env.HARBOR_LOCAL_X402_SIGNING_PROFILE !== X402_SIGNING_PROFILE ||
    env.HARBOR_LOCAL_READ_ONLY !== "true" ||
    env.EXEC_NETWORK !== "testnet" ||
    env.MAINNET_EXECUTION !== "false"
  ) {
    throw new X402OperationError(X402_RUNTIME_DISABLED);
  }
  return env;
}

function requiredService(ctx: X402Context): X402Service {
  const candidate = ctx.x402Service;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { pay?: unknown }).pay !== "function"
  ) {
    throw new X402OperationError(X402_NOT_CONFIGURED);
  }
  return candidate as X402Service;
}

async function pay(
  ctx: X402Context,
  request: X402PayRequest,
): Promise<X402PublicPayResponse> {
  const env = requiredEnvironment(ctx);
  if (ctx.localDevRequest !== true) {
    throw new X402OperationError(X402_LOCAL_ONLY);
  }
  if (
    typeof ctx.principal !== "string" ||
    ctx.principal.trim().length === 0 ||
    ctx.principal === "local-dev"
  ) {
    throw new X402OperationError(X402_AUTH_REQUIRED);
  }

  if (localX402IsolatedV1MarkersPresent(env)) {
    LocalX402IsolatedV1PayRequestSchema.parse(request);
  } else {
    LegacyX402PayRequestSchema.parse(request);
  }

  const service = requiredService(ctx);
  const response = X402PayResponseSchema.parse(
    await service.pay(ctx.principal, request),
  );
  return X402PublicPayResponseSchema.parse(response);
}

export const ops: OpDef[] = [
  {
    name: "x402.pay",
    family: "x402",
    summary: "Pay the fixed local XRPL Testnet merchant and return its compare resource.",
    tags: ["x402", "payment", "testnet", "local-only"],
    args: z.object({
      owner: X402PayRequestSchema.shape.owner,
      network: X402PayRequestSchema.shape.network,
      resource: X402PayRequestSchema.shape.resource,
      max_price_drops: X402PayRequestSchema.shape.max_price_drops,
      idempotency_key: X402PayRequestSchema.shape.idempotency_key,
      pay_to: X402PayRequestSchema.shape.pay_to,
    }).strict(),
    returns: "a delivered local compare resource or an ambiguous-settlement recovery record",
    caveats: [],
    example:
      'await harbor.x402.pay({ owner: "r...", network: "testnet", resource: "compare", max_price_drops: "5000", pay_to: "rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr", idempotency_key: "request-id" })',
    handler: async (ctx, rawRequest) =>
      pay(ctx as X402Context, rawRequest as X402PayRequest),
  },
];
