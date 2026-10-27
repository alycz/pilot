import {
  HarborResponseTooLargeError,
  HarborArgsSchemas,
  MAX_HARBOR_RESPONSE_BYTES,
  MAX_X402_RESPONSE_BYTES,
  isExactIsolatedLocalX402HarborUrl,
  isExactLocalX402HarborUrl,
  readBoundedResponseBytes,
  type HarborOpName,
} from "@pilot/harbor-client";
import type { NearPrincipalAuthorization } from "@pilot/contracts/near";
import { z } from "zod";

import {
  resolveCredentialedHarborUpstream,
  resolveCredentialedX402HarborUpstream,
  resolvePilotDeploymentProfile,
  resolvePilotRequestAuthority,
} from "../../../../lib/runtime-profile";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const OP_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NEAR_EXECUTABLE_QUOTE_REVIEW_OP =
  "near.intents.executable-quote.review" as const;
const DEDICATED_NEAR_OWNER_OPS = new Set<string>([
  "near.intents.owner-funded.reserve",
  "near.intents.owner-funded.reconcile",
]);

class HarborRequestTooLargeError extends Error {}

export interface HarborProxyEnvironment {
  EXEC_NETWORK?: string;
  HARBOR_API_KEY?: string;
  HARBOR_X402_API_KEY?: string;
  HARBOR_X402_URL?: string;
  HARBOR_MOCK?: string;
  HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED?: string;
  HARBOR_LOCAL_WORK_AGREEMENT_ENABLED?: string;
  HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED?: string;
  HARBOR_URL?: string;
  MAINNET_EXECUTION?: string;
  NEXT_PUBLIC_DEV_SIGNER?: string;
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_PUBLIC_ORIGIN?: string;
}

export const OWNER_REVIEW_PROXY_OPS = [
  "x402.ownerReviewPrepare",
  "x402.ownerReviewReject",
  "x402.ownerReviewSubmit",
  "x402.ownerReviewRecover",
] as const;
export type OwnerReviewProxyOp = (typeof OWNER_REVIEW_PROXY_OPS)[number];
export const CAPABILITY_PROXY_OPS = [
  "capability.prepare",
  "capability.activate",
  "capability.status",
  "capability.prepareRevoke",
  "capability.revoke",
  "capability.invoke",
] as const;
export type CapabilityProxyOp = (typeof CAPABILITY_PROXY_OPS)[number];
export const WORK_AGREEMENT_PROXY_OPS = [
  "workAgreement.prepare",
  "workAgreement.submit",
  "workAgreement.recover",
  "workAgreement.reject",
  "workAgreement.status",
] as const;
export type WorkAgreementProxyOp = (typeof WORK_AGREEMENT_PROXY_OPS)[number];
export type HarborProxyOpName = HarborOpName | OwnerReviewProxyOp | CapabilityProxyOp | WorkAgreementProxyOp;

const OwnerReviewIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const OwnerReviewBaseSchema = z.object({
  owner: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  network: z.literal("testnet"),
  idempotency_key: OwnerReviewIdSchema,
}).strict();
const OwnerReviewProxySchemas = Object.freeze({
  "x402.ownerReviewPrepare": OwnerReviewBaseSchema.extend({
    max_price_drops: z.literal("5000"),
  }).strict(),
  "x402.ownerReviewReject": OwnerReviewBaseSchema.extend({ approval_id: OwnerReviewIdSchema }).strict(),
  "x402.ownerReviewRecover": OwnerReviewBaseSchema.extend({ approval_id: OwnerReviewIdSchema }).strict(),
  "x402.ownerReviewSubmit": OwnerReviewBaseSchema.extend({
    approval_id: OwnerReviewIdSchema,
    approval_digest: z.string().regex(/^[A-F0-9]{64}$/),
    signed_blob: z.string().min(2).max(200_000).regex(/^[A-Fa-f0-9]+$/),
  }).strict(),
});

const CapabilityReferenceSchema = z.string().regex(/^cap_v1_[A-Za-z0-9_-]{32,128}$/);
const CapabilityDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CapabilityRequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const CapabilityScopeSchema = z.object({
  account: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  network: z.literal("testnet"),
}).strict();
const CapabilityAmountSchema = z.object({
  unit: z.literal("request"),
  value: z.literal("1"),
}).strict();
const CapabilityOwnerProofSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  approved_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  tx_blob: z.string().min(2).max(16_384).regex(/^[A-Fa-f0-9]+$/),
}).strict();
const CapabilityProxySchemas = Object.freeze({
  "capability.prepare": CapabilityScopeSchema.extend({
    service: z.literal("mock.catalog"),
    operation: z.literal("read"),
    amount: CapabilityAmountSchema,
    destination: z.literal("local-fixture-catalog"),
    not_before: z.string().datetime(),
    expires_at: z.string().datetime(),
    max_uses: z.number().int().min(1).max(100),
    rate_limit: z.object({
      window_seconds: z.number().int().min(1).max(3_600),
      max_calls: z.number().int().min(1).max(100),
    }).strict(),
  }).strict(),
  "capability.activate": CapabilityScopeSchema.extend({
    capability_ref: CapabilityReferenceSchema,
    generation: z.literal(1),
    approval_digest: CapabilityDigestSchema,
    owner_proof: CapabilityOwnerProofSchema,
  }).strict(),
  "capability.status": CapabilityScopeSchema.extend({
    capability_ref: CapabilityReferenceSchema,
  }).strict(),
  "capability.prepareRevoke": CapabilityScopeSchema.extend({
    capability_ref: CapabilityReferenceSchema,
    request_id: CapabilityRequestIdSchema,
  }).strict(),
  "capability.revoke": CapabilityScopeSchema.extend({
    capability_ref: CapabilityReferenceSchema,
    generation: z.number().int().min(2),
    approval_digest: CapabilityDigestSchema,
    owner_proof: CapabilityOwnerProofSchema,
  }).strict(),
  "capability.invoke": CapabilityScopeSchema.extend({
    capability_ref: CapabilityReferenceSchema,
    generation: z.number().int().min(1),
    request_id: CapabilityRequestIdSchema,
    service: z.literal("mock.catalog"),
    operation: z.literal("read"),
    amount: CapabilityAmountSchema,
    destination: z.literal("local-fixture-catalog"),
    input: z.object({
      resource: z.enum(["ledger-docs", "market-fixture"]),
    }).strict(),
  }).strict(),
});

const WorkAgreementIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const WorkAgreementBaseSchema = z.object({
  owner: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  network: z.literal("testnet"),
  agreement_id: WorkAgreementIdSchema,
}).strict();
const WorkAgreementHexSchema = z.string().max(1_024).regex(/^(?:[A-Fa-f0-9]{2})+$/);
const WorkAgreementTermsSchema = z.object({
  counterparty: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  amount_drops: z.string().regex(/^[1-9][0-9]{0,15}$/),
  finish_after: z.number().int().min(1).max(0xffff_ffff).optional(),
  cancel_after: z.number().int().min(1).max(0xffff_ffff).optional(),
  condition: WorkAgreementHexSchema.max(512).optional(),
}).strict().superRefine((terms, context) => {
  if (terms.finish_after === undefined && terms.cancel_after === undefined) {
    context.addIssue({ code: "custom", message: "An escrow time bound is required." });
  }
  if (terms.finish_after !== undefined && terms.cancel_after !== undefined &&
    terms.finish_after >= terms.cancel_after) {
    context.addIssue({ code: "custom", message: "finish_after must precede cancel_after." });
  }
  if (terms.condition !== undefined && terms.cancel_after === undefined) {
    context.addIssue({ code: "custom", message: "Conditioned escrow requires cancel_after." });
  }
});
const WorkAgreementProxySchemas = Object.freeze({
  "workAgreement.prepare": WorkAgreementBaseSchema.extend({
    action: z.enum(["create", "release", "cancel"]),
    idempotency_key: WorkAgreementIdSchema,
    approval_expires_at: z.string().datetime(),
    terms: WorkAgreementTermsSchema,
    fulfillment: WorkAgreementHexSchema.optional(),
  }).strict().superRefine((request, context) => {
    if (request.action !== "release" && request.fulfillment !== undefined) {
      context.addIssue({ code: "custom", message: "Only release can include fulfillment." });
    }
    if (request.action === "release" && request.terms.condition !== undefined &&
      request.fulfillment === undefined) {
      context.addIssue({ code: "custom", message: "Conditioned release requires fulfillment." });
    }
    if (request.action === "release" && request.terms.condition === undefined &&
      request.fulfillment !== undefined) {
      context.addIssue({ code: "custom", message: "Time-based release cannot include fulfillment." });
    }
  }),
  "workAgreement.submit": WorkAgreementBaseSchema.extend({
    approval_id: WorkAgreementIdSchema,
    idempotency_key: WorkAgreementIdSchema,
    attempt_id: WorkAgreementIdSchema,
    signed_blob: z.string().min(2).max(200_000).regex(/^[A-Fa-f0-9]+$/),
  }).strict(),
  "workAgreement.recover": WorkAgreementBaseSchema.extend({
    approval_id: WorkAgreementIdSchema,
    idempotency_key: WorkAgreementIdSchema,
  }).strict(),
  "workAgreement.reject": WorkAgreementBaseSchema.extend({
    approval_id: WorkAgreementIdSchema,
    idempotency_key: WorkAgreementIdSchema,
  }).strict(),
  "workAgreement.status": WorkAgreementBaseSchema,
});

function isOwnerReviewProxyOp(op: string): op is OwnerReviewProxyOp {
  return (OWNER_REVIEW_PROXY_OPS as readonly string[]).includes(op);
}

function isCapabilityProxyOp(op: string): op is CapabilityProxyOp {
  return (CAPABILITY_PROXY_OPS as readonly string[]).includes(op);
}

function isWorkAgreementProxyOp(op: string): op is WorkAgreementProxyOp {
  return (WORK_AGREEMENT_PROXY_OPS as readonly string[]).includes(op);
}

export interface HarborProxyDependencies {
  authorizeOperation: (
    request: Request,
    op: HarborProxyOpName,
    args: Record<string, unknown>,
  ) => boolean;
  operationResponseHeaders: (
    request: Request,
    op: HarborProxyOpName,
    args: Record<string, unknown>,
    body: ArrayBuffer,
    status: number,
  ) => Record<string, string>;
  readNearPrincipalAuthorization: (
    request: Request,
  ) => NearPrincipalAuthorization | null;
  env: HarborProxyEnvironment;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

export interface HarborRouteContext {
  params: Promise<{ op: string }>;
}

type ProxyErrorCode =
  | "HARBOR_PROXY_INVALID_BODY"
  | "HARBOR_PROXY_INVALID_CONFIG"
  | "HARBOR_PROXY_INVALID_JSON"
  | "HARBOR_PROXY_INVALID_ARGS"
  | "HARBOR_PROXY_INVALID_OP"
  | "HARBOR_PROXY_FORBIDDEN_ORIGIN"
  | "HARBOR_PROXY_UNAUTHORIZED"
  | "HARBOR_PROXY_MAINNET_MUTATION_BLOCKED"
  | "HARBOR_PROXY_MOCK_DISABLED"
  | "HARBOR_PROXY_REQUEST_TOO_LARGE"
  | "HARBOR_PROXY_RESPONSE_TOO_LARGE"
  | "HARBOR_PROXY_TIMEOUT"
  | "HARBOR_PROXY_UNSUPPORTED_MEDIA_TYPE"
  | "HARBOR_PROXY_UPSTREAM_UNAVAILABLE"
  | "HARBOR_PROXY_X402_LOCAL_TESTNET_REQUIRED"
  | "HARBOR_PROXY_CAPABILITY_LOCAL_TESTNET_REQUIRED"
  | "HARBOR_PROXY_WORK_AGREEMENT_LOCAL_TESTNET_REQUIRED";

function errorResponse(status: number, code: ProxyErrorCode, message: string): Response {
  return Response.json(
    {
      ok: false,
      error: {
        service: "pilot-harbor-proxy",
        kind: "error",
        code,
        message,
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function isJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json"))
  );
}

function isAllowedOrigin(request: Request, expectedOrigin: string): boolean {
  return request.headers.get("origin") === expectedOrigin;
}

function isHarborOpName(value: string): value is HarborProxyOpName {
  return isOwnerReviewProxyOp(value) || isCapabilityProxyOp(value) || isWorkAgreementProxyOp(value) ||
    Object.prototype.hasOwnProperty.call(HarborArgsSchemas, value);
}

const SPONSOR_MUTATION_OPS = new Set<string>([
  "mandate.prepare",
  "mandate.register",
  "mandate.revoke",
  "credential.payerAccept",
  "credential.revoke",
  "ap4m.purchase",
  "channel.settle",
  "quicknode.unfreeze",
  "quicknode.test.registerLink",
]);

function isMutation(op: HarborProxyOpName): boolean {
  return (
    op === "account.link" ||
    op === "account.revoke" ||
    op === "policy.set" ||
    op === "x402.pay" ||
    SPONSOR_MUTATION_OPS.has(op) ||
    isOwnerReviewProxyOp(op) ||
    isCapabilityProxyOp(op) ||
    (isWorkAgreementProxyOp(op) && op !== "workAgreement.status") ||
    (op.startsWith("tx.") && op !== "tx.status")
  );
}

function isApprovedLocalCapability(
  op: HarborProxyOpName,
  args: Record<string, unknown>,
  env: HarborProxyEnvironment,
): boolean {
  if (!isCapabilityProxyOp(op)) return true;
  return args.network === "testnet" && env.EXEC_NETWORK?.trim() === "testnet" &&
    env.HARBOR_MOCK === "1" && env.MAINNET_EXECUTION === "false" &&
    env.HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED === "true" &&
    resolvePilotDeploymentProfile(env) === "local-wallet" &&
    isExactLocalX402HarborUrl(env.HARBOR_URL);
}

function isApprovedLocalWorkAgreement(
  op: HarborProxyOpName,
  args: Record<string, unknown>,
  env: HarborProxyEnvironment,
): boolean {
  if (!isWorkAgreementProxyOp(op)) return true;
  return args.network === "testnet" && env.EXEC_NETWORK?.trim() === "testnet" &&
    env.HARBOR_MOCK === "1" && env.MAINNET_EXECUTION === "false" &&
    env.HARBOR_LOCAL_WORK_AGREEMENT_ENABLED === "true" &&
    resolvePilotDeploymentProfile(env) === "local-wallet" &&
    isExactLocalX402HarborUrl(env.HARBOR_URL);
}

function isApprovedLocalX402(
  op: HarborProxyOpName,
  args: Record<string, unknown>,
  env: HarborProxyEnvironment,
): boolean {
  if (isOwnerReviewProxyOp(op)) {
    return args.network === "testnet" && env.EXEC_NETWORK?.trim() === "testnet" &&
      env.HARBOR_MOCK === "1" && env.MAINNET_EXECUTION === "false" &&
      env.HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED === "true" &&
      resolvePilotDeploymentProfile(env) === "local-wallet" &&
      isExactLocalX402HarborUrl(env.HARBOR_URL);
  }
  if (op !== "x402.pay") return true;
  if (args.network !== "testnet" || env.EXEC_NETWORK?.trim() !== "testnet") return false;
  if (resolvePilotDeploymentProfile(env) === "local-wallet-isolated-v1") {
    return isExactIsolatedLocalX402HarborUrl(env.HARBOR_X402_URL);
  }
  return isExactLocalX402HarborUrl(env.HARBOR_URL);
}

function requiresWalletBinding(op: HarborProxyOpName): boolean {
  return isMutation(op) || isWorkAgreementProxyOp(op) ||
    op === "onboarding.readiness" || op === "account.status" ||
    op === "policy.get" || op === "tx.status";
}

function hasNearExecutableQuoteReviewAuthorization(
  request: Request,
  op: HarborProxyOpName,
  args: Record<string, unknown>,
  readAuthorization: HarborProxyDependencies["readNearPrincipalAuthorization"],
): boolean {
  if (op !== NEAR_EXECUTABLE_QUOTE_REVIEW_OP) return true;

  try {
    const authorization = readAuthorization(request);
    const nearAccount = args.route === "near-native-to-arbitrum-usdc-v1"
      ? args.refund_to
      : args.recipient;
    return authorization !== null &&
      authorization.network === "near:mainnet" &&
      authorization.operations.includes(NEAR_EXECUTABLE_QUOTE_REVIEW_OP) &&
      authorization.account_id === nearAccount;
  } catch {
    // Missing or invalid cookie-sealing configuration must fail closed.
    return false;
  }
}

function isBlockedMainnetMutation(
  op: HarborProxyOpName,
  args: Record<string, unknown>,
  env: HarborProxyEnvironment,
): boolean {
  return (
    isMutation(op) &&
    (args.network === "mainnet" || env.EXEC_NETWORK?.trim() === "mainnet")
  );
}

function isSafeJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;

    if (current.value === null || typeof current.value !== "object") continue;

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ depth: current.depth + 1, value: item });
      }
      continue;
    }

    for (const [key, item] of Object.entries(current.value)) {
      if (UNSAFE_KEYS.has(key)) return false;
      pending.push({ depth: current.depth + 1, value: item });
    }
  }

  return true;
}

function redact(value: string, secret: string): string {
  return value.includes(secret) ? value.split(secret).join("[redacted]") : value;
}

function upstreamResponseHeaders(upstream: Response, apiKey: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  for (const name of [
    "content-type",
    "retry-after",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, redact(value, apiKey));
  }

  return headers;
}

function safeUpstreamBody(body: ArrayBuffer, apiKey: string): BodyInit | null {
  if (body.byteLength === 0) return null;

  const text = new TextDecoder().decode(body);
  if (!text.includes(apiKey)) return body;

  return redact(text, apiKey);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readBoundedRequestText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // Cancellation is best-effort cleanup. It must never delay or replace
          // the deterministic oversized-request response.
        }
        throw new HarborRequestTooLargeError("Harbor request body exceeded its byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Create the route handler with injectable dependencies so unit tests never need
 * a live Harbor. The proxy intentionally performs exactly one upstream request:
 * Harbor owns mutation idempotency and is the only layer allowed to retry it.
 */
export function createHarborProxyHandler(
  overrides: Partial<HarborProxyDependencies> = {},
): (request: Request, context: HarborRouteContext) => Promise<Response> {
  const dependencies: HarborProxyDependencies = {
    authorizeOperation: () => false,
    operationResponseHeaders: () => ({}),
    readNearPrincipalAuthorization: () => null,
    env: process.env,
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };

  return async function POST(request, context): Promise<Response> {
    let op: string;
    try {
      op = (await context.params).op;
    } catch {
      return errorResponse(400, "HARBOR_PROXY_INVALID_OP", "The Harbor operation is invalid.");
    }

    if (
      typeof op !== "string" || op.length > 128 ||
      (!OP_PATTERN.test(op) && op !== NEAR_EXECUTABLE_QUOTE_REVIEW_OP &&
        !DEDICATED_NEAR_OWNER_OPS.has(op))
    ) {
      return errorResponse(400, "HARBOR_PROXY_INVALID_OP", "The Harbor operation is invalid.");
    }

    if (!isHarborOpName(op)) {
      return errorResponse(404, "HARBOR_PROXY_INVALID_OP", "The Harbor operation is unknown.");
    }

    try {
      resolvePilotDeploymentProfile(dependencies.env);
    } catch {
      return errorResponse(
        503,
        "HARBOR_PROXY_INVALID_CONFIG",
        "The Pilot deployment profile is not configured.",
      );
    }

    let expectedOrigin: string;
    try {
      expectedOrigin = resolvePilotRequestAuthority(dependencies.env, request).origin;
    } catch {
      return errorResponse(
        403,
        "HARBOR_PROXY_FORBIDDEN_ORIGIN",
        "The Pilot request authority is not allowed.",
      );
    }

    if (!isAllowedOrigin(request, expectedOrigin)) {
      return errorResponse(
        403,
        "HARBOR_PROXY_FORBIDDEN_ORIGIN",
        "Cross-origin Harbor operation requests are not allowed.",
      );
    }

    if (DEDICATED_NEAR_OWNER_OPS.has(op)) {
      return errorResponse(
        403,
        "HARBOR_PROXY_UNAUTHORIZED",
        "This owner-controlled NEAR operation requires its dedicated principal-bound route.",
      );
    }

    if (!isJsonMediaType(request.headers.get("content-type"))) {
      return errorResponse(
        415,
        "HARBOR_PROXY_UNSUPPORTED_MEDIA_TYPE",
        "Harbor operation requests must use application/json.",
      );
    }

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const size = Number(declaredLength);
      if (Number.isFinite(size) && size > MAX_BODY_BYTES) {
        return errorResponse(
          413,
          "HARBOR_PROXY_REQUEST_TOO_LARGE",
          "The Harbor operation request is too large.",
        );
      }
    }

    let requestBody: string;
    try {
      requestBody = await readBoundedRequestText(request);
    } catch (error) {
      if (error instanceof HarborRequestTooLargeError) {
        return errorResponse(
          413,
          "HARBOR_PROXY_REQUEST_TOO_LARGE",
          "The Harbor operation request is too large.",
        );
      }
      return errorResponse(
        400,
        "HARBOR_PROXY_INVALID_BODY",
        "The Harbor operation request body could not be read.",
      );
    }

    if (byteLength(requestBody) > MAX_BODY_BYTES) {
      return errorResponse(
        413,
        "HARBOR_PROXY_REQUEST_TOO_LARGE",
        "The Harbor operation request is too large.",
      );
    }

    let args: unknown;
    try {
      args = JSON.parse(requestBody);
    } catch {
      return errorResponse(
        400,
        "HARBOR_PROXY_INVALID_JSON",
        "The Harbor operation request body must be valid JSON.",
      );
    }

    if (!isSafeJsonObject(args)) {
      return errorResponse(
        400,
        "HARBOR_PROXY_INVALID_BODY",
        "The Harbor operation arguments must be a safe JSON object.",
      );
    }

    const argsSchema = isOwnerReviewProxyOp(op)
      ? OwnerReviewProxySchemas[op]
      : isCapabilityProxyOp(op)
        ? CapabilityProxySchemas[op]
        : isWorkAgreementProxyOp(op)
          ? WorkAgreementProxySchemas[op]
          : HarborArgsSchemas[op];
    const parsedArgs = argsSchema.safeParse(args);
    if (!parsedArgs.success) {
      return errorResponse(
        400,
        "HARBOR_PROXY_INVALID_ARGS",
        "The Harbor operation arguments are invalid.",
      );
    }

    const validatedArgs = parsedArgs.data as Record<string, unknown>;
    if (!hasNearExecutableQuoteReviewAuthorization(
      request,
      op,
      validatedArgs,
      dependencies.readNearPrincipalAuthorization,
    )) {
      return errorResponse(
        401,
        "HARBOR_PROXY_UNAUTHORIZED",
        "Principal-bound NEAR authorization is required for this Harbor operation.",
      );
    }
    if (
      requiresWalletBinding(op) &&
      !dependencies.authorizeOperation(request, op, validatedArgs)
    ) {
      return errorResponse(
        401,
        "HARBOR_PROXY_UNAUTHORIZED",
        "Wallet-bound authorization is required for this Harbor operation.",
      );
    }
    if (isBlockedMainnetMutation(op, validatedArgs, dependencies.env)) {
      return errorResponse(
        403,
        "HARBOR_PROXY_MAINNET_MUTATION_BLOCKED",
        "Harbor mutations are disabled on mainnet.",
      );
    }
    if (!isApprovedLocalX402(op, validatedArgs, dependencies.env)) {
      return errorResponse(
        403,
        "HARBOR_PROXY_X402_LOCAL_TESTNET_REQUIRED",
        "x402.pay is restricted to the approved local Testnet Harbor mode.",
      );
    }
    if (!isApprovedLocalCapability(op, validatedArgs, dependencies.env)) {
      return errorResponse(
        403,
        "HARBOR_PROXY_CAPABILITY_LOCAL_TESTNET_REQUIRED",
        "Capability operations are restricted to the approved local Testnet mock mode.",
      );
    }
    if (!isApprovedLocalWorkAgreement(op, validatedArgs, dependencies.env)) {
      return errorResponse(
        403,
        "HARBOR_PROXY_WORK_AGREEMENT_LOCAL_TESTNET_REQUIRED",
        "Work-agreement operations are restricted to the approved local Testnet mock mode.",
      );
    }

    const localOwnerReviewMock = isOwnerReviewProxyOp(op) &&
      dependencies.env.HARBOR_MOCK === "1" &&
      dependencies.env.HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED === "true";
    const localCapabilityMock = isCapabilityProxyOp(op) &&
      dependencies.env.HARBOR_MOCK === "1" &&
      dependencies.env.HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED === "true";
    const localWorkAgreementMock = isWorkAgreementProxyOp(op) &&
      dependencies.env.HARBOR_MOCK === "1" &&
      dependencies.env.HARBOR_LOCAL_WORK_AGREEMENT_ENABLED === "true";
    if (dependencies.env.HARBOR_MOCK !== "0" && !localOwnerReviewMock && !localCapabilityMock && !localWorkAgreementMock) {
      return errorResponse(
        503,
        dependencies.env.HARBOR_MOCK === "1"
          ? "HARBOR_PROXY_MOCK_DISABLED"
          : "HARBOR_PROXY_INVALID_CONFIG",
        dependencies.env.HARBOR_MOCK === "1"
          ? "Live Harbor forwarding is disabled while Pilot is in mock mode."
          : "Harbor mode is not configured.",
      );
    }

    // Direct and approval-backed signed-blob submission carries an explicit
    // test network discriminator. Harbor derives the authenticated account
    // from the blob or stored approval and rejects mismatched routing.
    const upstreamBody = JSON.stringify(parsedArgs.data);

    let config: { apiKey: string; baseUrl: string };
    try {
      config = op === "x402.pay"
        ? resolveCredentialedX402HarborUpstream(dependencies.env, request)
        : resolveCredentialedHarborUpstream(dependencies.env, request);
    } catch {
      return errorResponse(
        503,
        "HARBOR_PROXY_INVALID_CONFIG",
        "The Harbor service is not configured.",
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, dependencies.timeoutMs);
    const abortUpstream = () => controller.abort();
    request.signal.addEventListener("abort", abortUpstream, { once: true });

    try {
      const upstream = await dependencies.fetch(
        `${config.baseUrl}/api/ops/${encodeURIComponent(op)}`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: upstreamBody,
          cache: "no-store",
          signal: controller.signal,
        },
      );
      const bytes = await readBoundedResponseBytes(
        upstream,
        op === "x402.pay" || isOwnerReviewProxyOp(op)
          ? MAX_X402_RESPONSE_BYTES
          : MAX_HARBOR_RESPONSE_BYTES,
      );
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const headers = upstreamResponseHeaders(upstream, config.apiKey);
      const additionalHeaders = dependencies.operationResponseHeaders(
        request,
        op,
        validatedArgs,
        body,
        upstream.status,
      );
      for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value);

      return new Response(safeUpstreamBody(body, config.apiKey), {
        status: upstream.status,
        headers,
      });
    } catch (error) {
      if (error instanceof HarborResponseTooLargeError) {
        return errorResponse(
          502,
          "HARBOR_PROXY_RESPONSE_TOO_LARGE",
          "The Harbor service returned an oversized or invalid-length response.",
        );
      }
      if (timedOut) {
        return errorResponse(
          504,
          "HARBOR_PROXY_TIMEOUT",
          "The Harbor service did not respond in time.",
        );
      }

      if (request.signal.aborted || isAbortError(error)) {
        return errorResponse(
          502,
          "HARBOR_PROXY_UPSTREAM_UNAVAILABLE",
          "The Harbor service request was interrupted.",
        );
      }

      return errorResponse(
        502,
        "HARBOR_PROXY_UPSTREAM_UNAVAILABLE",
        "The Harbor service is temporarily unavailable.",
      );
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortUpstream);
    }
  };
}
