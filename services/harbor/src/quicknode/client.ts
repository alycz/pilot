import type { Network } from "../contracts";

export const QUICKNODE_API_BASE = "https://api.quicknode.com/";
const QUICKNODE_TIMEOUT_MS = 10_000;
const QUICKNODE_MAX_RESPONSE_BYTES = 1_048_576;

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
  timeoutMs?: number;
  maxResponseBytes?: number;
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

  const timeoutMs = options.timeoutMs ?? QUICKNODE_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? QUICKNODE_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new QuickNodeError("QN_INVALID_REQUEST");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new QuickNodeError("QN_INVALID_REQUEST");
  }

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new QuickNodeError("QN_TRANSPORT_ERROR", true));
    }, timeoutMs);
  });
  let response: Response;
  try {
    response = await Promise.race([
      (options.fetcher ?? fetch)(url, {
        method,
        headers,
        body: encodedBody,
        redirect: "error",
        signal: controller.signal,
      }).catch(() => {
        throw new QuickNodeError("QN_TRANSPORT_ERROR", true);
      }),
      timeout,
    ]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new QuickNodeError(
        `QN_HTTP_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    if (response.status === 204) return null;

    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxResponseBytes)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new QuickNodeError("QN_MALFORMED_RESPONSE");
    }
    if (!response.body) throw new QuickNodeError("QN_MALFORMED_RESPONSE");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new QuickNodeError("QN_MALFORMED_RESPONSE");
      }
      chunks.push(value);
    }
    if (timedOut) throw new QuickNodeError("QN_TRANSPORT_ERROR", true);
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      ) as unknown;
    } catch {
      throw new QuickNodeError("QN_MALFORMED_RESPONSE");
    }
  } catch (error) {
    if (error instanceof QuickNodeError) throw error;
    throw new QuickNodeError("QN_TRANSPORT_ERROR", true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      reader?.releaseLock();
    } catch {
      // A timeout can race a pending body read. Cancellation owns cleanup;
      // retain the normalized transport error instead of leaking a stream error.
    }
  }
}
