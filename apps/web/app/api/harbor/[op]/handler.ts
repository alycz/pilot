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

export interface HarborProxyEnvironment {
  EXEC_NETWORK?: string;
  HARBOR_API_KEY?: string;
  HARBOR_X402_API_KEY?: string;
  HARBOR_X402_URL?: string;
  HARBOR_MOCK?: string;
  HARBOR_URL?: string;
  NEXT_PUBLIC_DEV_SIGNER?: string;
  NEXT_PUBLIC_PILOT_BUILD_MARKER?: string;
  PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_PUBLIC_ORIGIN?: string;
}

export interface HarborProxyDependencies {
  authorizeOperation: (
    request: Request,
    op: HarborOpName,
    args: Record<string, unknown>,
  ) => boolean;
  operationResponseHeaders: (
    request: Request,
    op: HarborOpName,
    args: Record<string, unknown>,
    body: ArrayBuffer,
    status: number,
  ) => Record<string, string>;
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
  | "HARBOR_PROXY_X402_LOCAL_TESTNET_REQUIRED";

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

function isHarborOpName(value: string): value is HarborOpName {
  return Object.prototype.hasOwnProperty.call(HarborArgsSchemas, value);
}

function isMutation(op: HarborOpName): boolean {
  return (
    op === "account.link" ||
    op === "account.revoke" ||
    op === "policy.set" ||
    op === "x402.pay" ||
    (op.startsWith("tx.") && op !== "tx.status")
  );
}

function isApprovedLocalX402(
  op: HarborOpName,
  args: Record<string, unknown>,
  env: HarborProxyEnvironment,
): boolean {
  if (op !== "x402.pay") return true;
  if (args.network !== "testnet" || env.EXEC_NETWORK?.trim() !== "testnet") return false;
  if (resolvePilotDeploymentProfile(env) === "local-wallet-isolated-v1") {
    return isExactIsolatedLocalX402HarborUrl(env.HARBOR_X402_URL);
  }
  return isExactLocalX402HarborUrl(env.HARBOR_URL);
}

function requiresWalletBinding(op: HarborOpName): boolean {
  return isMutation(op) || op === "onboarding.readiness" || op === "account.status" ||
    op === "policy.get" || op === "tx.status";
}

function isBlockedMainnetMutation(
  op: HarborOpName,
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

    if (typeof op !== "string" || op.length > 128 || !OP_PATTERN.test(op)) {
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
      requestBody = await request.text();
    } catch {
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

    const parsedArgs = HarborArgsSchemas[op].safeParse(args);
    if (!parsedArgs.success) {
      return errorResponse(
        400,
        "HARBOR_PROXY_INVALID_ARGS",
        "The Harbor operation arguments are invalid.",
      );
    }

    const validatedArgs = parsedArgs.data as Record<string, unknown>;
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

    if (dependencies.env.HARBOR_MOCK !== "0") {
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
        op === "x402.pay" ? MAX_X402_RESPONSE_BYTES : MAX_HARBOR_RESPONSE_BYTES,
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
