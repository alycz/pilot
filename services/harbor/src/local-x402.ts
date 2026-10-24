export const LOCAL_X402_ORIGIN = "http://127.0.0.1:8000";
export const LOCAL_X402_PROBE_URL = `${LOCAL_X402_ORIGIN}/api/x402/compare`;
export const LOCAL_X402_COMPARE_PRICE_DROPS = "5000" as const;
export const LOCAL_X402_PROBE_TIMEOUT_MS = 3_000;
export const LOCAL_HARBOR_ORIGIN = "http://127.0.0.1:8791";

const MAX_TARGET_LENGTH = 2_048;
const CANONICAL_LOCAL_TARGET =
  /^http:\/\/127\.0\.0\.1:8000(?:[/?]|$)/;

export type LocalDevEnv = {
  HARBOR_LOCAL_DEV?: string;
};

export type LocalX402ProbeResult = {
  reachable: boolean;
  status: number | null;
  contentType: string | null;
};

export class LocalX402TargetError extends Error {
  readonly code = "LOCAL_X402_TARGET_BLOCKED";

  constructor() {
    super("Local x402 target is not allowed");
    this.name = "LocalX402TargetError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1";
}

function hasSafeOrigin(request: Request, requestUrl: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;

  try {
    return new URL(origin).origin === requestUrl.origin;
  } catch {
    return false;
  }
}

function hasSafeFetchSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === null) return true;
  const normalized = fetchSite.trim().toLowerCase();
  return normalized === "same-origin" || normalized === "none";
}

/**
 * Identify an explicitly enabled local Wrangler request. Both browser signals
 * are checked when present so a cross-origin page cannot use the auth bypass or
 * local-only network capability. Non-browser local clients omit both headers.
 */
export function isLocalDevRequest(
  request: Request,
  env: LocalDevEnv,
): boolean {
  if (env.HARBOR_LOCAL_DEV !== "true") return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }

  return (
    requestUrl.origin === LOCAL_HARBOR_ORIGIN &&
    isLoopbackHostname(requestUrl.hostname) &&
    hasSafeOrigin(request, requestUrl) &&
    hasSafeFetchSite(request)
  );
}

/**
 * Validate the sole local x402 origin without weakening the deployed URL
 * policy. Requiring the raw URL to already equal its WHATWG serialization
 * rejects alternate IPv4 spellings, whitespace and other parser aliases.
 */
export function validateLocalX402Target(
  rawTarget: string,
  localDevRequest: boolean,
  redirected = false,
): URL {
  if (
    !localDevRequest ||
    redirected ||
    rawTarget.length === 0 ||
    rawTarget.length > MAX_TARGET_LENGTH ||
    !CANONICAL_LOCAL_TARGET.test(rawTarget)
  ) {
    throw new LocalX402TargetError();
  }

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new LocalX402TargetError();
  }

  const canonicalRawTarget =
    rawTarget === LOCAL_X402_ORIGIN ? `${rawTarget}/` : rawTarget;
  if (
    target.href !== canonicalRawTarget ||
    target.origin !== LOCAL_X402_ORIGIN ||
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.port !== "8000" ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== ""
  ) {
    throw new LocalX402TargetError();
  }

  return target;
}

export type LocalX402ProbeOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * Make one credential-free, non-redirecting request to the fixed local
 * merchant. There is no payment retry, response body read, or caller-selected
 * destination, so this capability can only establish local reachability.
 */
export async function probeLocalX402(
  localDevRequest: boolean,
  options: LocalX402ProbeOptions = {},
): Promise<LocalX402ProbeResult> {
  const fetcher =
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? LOCAL_X402_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }

  const target = validateLocalX402Target(
    LOCAL_X402_PROBE_URL,
    localDevRequest,
  );
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const unreachable: LocalX402ProbeResult = {
    reachable: false,
    status: null,
    contentType: null,
  };
  const timeoutResult = new Promise<LocalX402ProbeResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(unreachable);
    }, timeoutMs);
  });
  const requestResult = (async (): Promise<LocalX402ProbeResult> => {
    try {
      const response = await fetcher(target, {
        method: "GET",
        headers: new Headers(),
        redirect: "manual",
        signal: controller.signal,
      });
      const result: LocalX402ProbeResult = {
        reachable: response.status < 300 || response.status >= 400,
        status: response.status,
        contentType: response.headers.get("content-type"),
      };
      await response.body?.cancel().catch(() => undefined);
      return result;
    } catch {
      return unreachable;
    }
  })();

  try {
    return await Promise.race([requestResult, timeoutResult]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
