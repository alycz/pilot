import type { Network } from "../contracts";

export const QUICKNODE_API_BASE = "https://api.quicknode.com/";

export type QuickNodeEnv = {
  QN_API_BASE?: string;
  QN_API_KEY?: string;
  EXEC_NETWORK?: Network;
  HARBOR_LOCAL_DEV?: string;
};

export type QuickNodeMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type QnRestOptions = {
  /** Worker bindings are explicit so secrets are never discovered ambiently. */
  env: QuickNodeEnv;
  /** True only when the runtime was independently identified as local dev. */
  runtimeLocal: boolean;
  /** True only for a request received through the local dev listener. */
  requestLocal: boolean;
  fetcher?: typeof fetch;
};

export type QuickNodeStartupContext = {
  /** Must come from runtime wiring, not from an environment value. */
  runtimeLocal: boolean;
};

export type QuickNodeErrorCode =
  | "QN_INVALID_REQUEST"
  | "QN_API_KEY_MISSING"
  | "QN_API_BASE_INVALID"
  | "QN_API_BASE_FORBIDDEN"
  | "QN_TRANSPORT_ERROR"
  | "QN_MALFORMED_RESPONSE"
  | `QN_HTTP_${number}`;

export class QuickNodeError extends Error {
  readonly service = "quicknode";

  constructor(
    readonly code: QuickNodeErrorCode,
    readonly retryable = false,
  ) {
    super(messageFor(code));
    this.name = "QuickNodeError";
  }
}

function messageFor(code: QuickNodeErrorCode): string {
  if (code === "QN_INVALID_REQUEST") return "QuickNode request is invalid";
  if (code === "QN_API_KEY_MISSING") return "QuickNode API key is unavailable";
  if (code === "QN_API_BASE_INVALID") return "QuickNode API base is invalid";
  if (code === "QN_API_BASE_FORBIDDEN") {
    return "QuickNode API base override is not allowed in this environment";
  }
  if (code === "QN_TRANSPORT_ERROR") return "QuickNode request failed";
  if (code === "QN_MALFORMED_RESPONSE") {
    return "QuickNode returned malformed JSON";
  }
  return "QuickNode returned an HTTP error";
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function apiBase(env: QuickNodeEnv, runtimeLocal: boolean): URL {
  if (!env.QN_API_BASE) return new URL(QUICKNODE_API_BASE);

  let base: URL;
  try {
    base = new URL(env.QN_API_BASE);
  } catch {
    throw new QuickNodeError("QN_API_BASE_INVALID");
  }
  if (base.username || base.password) {
    throw new QuickNodeError("QN_API_BASE_INVALID");
  }

  if (base.origin === new URL(QUICKNODE_API_BASE).origin) return base;

  if (
    !runtimeLocal ||
    env.HARBOR_LOCAL_DEV !== "true" ||
    (env.EXEC_NETWORK !== "testnet" && env.EXEC_NETWORK !== "devnet")
  ) {
    throw new QuickNodeError("QN_API_BASE_FORBIDDEN");
  }
  if (
    !isLoopback(base.hostname) ||
    (base.protocol !== "http:" && base.protocol !== "https:")
  ) {
    throw new QuickNodeError("QN_API_BASE_INVALID");
  }
  return base;
}

function hasUnsafePathSegment(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) {
    return true;
  }
  try {
    return path.split("/").some((raw) => {
      const decoded = decodeURIComponent(raw);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    });
  } catch {
    return true;
  }
}

function requestUrl(path: string, options: QnRestOptions): URL {
  if (hasUnsafePathSegment(path) || !/^\/(?:kv|webhooks|streams)\/rest\/v1(?:\/|$)/.test(path)) {
    throw new QuickNodeError("QN_INVALID_REQUEST");
  }
  const base = apiBase(options.env, options.runtimeLocal);
  const isOverride = base.origin !== new URL(QUICKNODE_API_BASE).origin;
  if (isOverride && !options.requestLocal) {
    throw new QuickNodeError("QN_API_BASE_FORBIDDEN");
  }
  const normalizedBase = base.toString().endsWith("/")
    ? base.toString()
    : `${base.toString()}/`;
  const result = new URL(path.slice(1), normalizedBase);
  if (
    result.origin !== base.origin ||
    !/^\/(?:kv|webhooks|streams)\/rest\/v1(?:\/|$)/.test(result.pathname)
  ) {
    throw new QuickNodeError("QN_INVALID_REQUEST");
  }
  return result;
}

/** Fail fast during Worker startup before a deployed runtime can accept traffic. */
export function validateQuickNodeStartup(
  env: QuickNodeEnv,
  context: QuickNodeStartupContext,
): void {
  apiBase(env, context.runtimeLocal);
}

/** Send one QuickNode REST request without retaining secrets or payloads in errors. */
export async function qnRest(
  method: QuickNodeMethod,
  path: string,
  body: Readonly<Record<string, unknown>> | undefined,
  options: QnRestOptions,
): Promise<unknown> {
  const apiKey = options.env.QN_API_KEY;
  if (!apiKey) throw new QuickNodeError("QN_API_KEY_MISSING");
  const url = requestUrl(path, options);
  const headers = new Headers({ accept: "application/json", "x-api-key": apiKey });
  let encodedBody: string | undefined;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    encodedBody = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      method,
      headers,
      body: encodedBody,
    });
  } catch {
    throw new QuickNodeError("QN_TRANSPORT_ERROR", true);
  }

  let payload: unknown = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      throw new QuickNodeError("QN_MALFORMED_RESPONSE");
    }
  }
  if (!response.ok) {
    throw new QuickNodeError(
      `QN_HTTP_${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  return payload;
}
