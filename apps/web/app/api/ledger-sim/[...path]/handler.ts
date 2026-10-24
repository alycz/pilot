import {
  resolvePilotRequestAuthority,
  resolveProfileLedgerConfig,
} from "../../../../lib/runtime-profile";

const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

type RouteContext = Readonly<{
  params: Promise<{ path: string[] }>;
}>;

export type LedgerSimProxyEnvironment = Parameters<
  typeof resolveProfileLedgerConfig
>[0];

export type LedgerSimProxyDependencies = Readonly<{
  env?: LedgerSimProxyEnvironment;
  fetch?: typeof globalThis.fetch;
}>;

type AllowedTarget = Readonly<{
  pathname: string;
  search: string;
}>;

function response(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: NO_STORE },
  );
}

function targetFor(
  method: "GET" | "POST",
  request: Request,
  path: readonly string[],
): AllowedTarget | "method-not-allowed" | undefined {
  const search = new URL(request.url).search;
  const queryAllowed = search === "" ||
    (path.length === 1 && path[0] === "events" &&
      (search === "?stream=true" || search === "?currentscreenonly=true"));
  if (!queryAllowed) return undefined;

  if (path.length === 1 && path[0] === "events") {
    return method === "GET"
      ? { pathname: "/events", search }
      : "method-not-allowed";
  }
  if (path.length === 1 && path[0] === "screenshot") {
    return method === "GET"
      ? { pathname: "/screenshot", search: "" }
      : "method-not-allowed";
  }
  if (path.length === 1 && path[0] === "apdu") {
    return method === "POST"
      ? { pathname: "/apdu", search: "" }
      : "method-not-allowed";
  }
  if (
    path.length === 2 && path[0] === "button" &&
    (path[1] === "left" || path[1] === "right" || path[1] === "both")
  ) {
    return method === "POST"
      ? { pathname: `/button/${path[1]}`, search: "" }
      : "method-not-allowed";
  }
  return undefined;
}

async function boundedBody(request: Request): Promise<string | undefined> {
  if (request.body === null) return "";
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers(NO_STORE);
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function isSameOriginBrowserRequest(
  request: Request,
  expectedOrigin: string,
  method: "GET" | "POST",
): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expectedOrigin;
  return method === "GET" &&
    new URL(request.url).origin === expectedOrigin &&
    request.headers.get("sec-fetch-site") === "same-origin";
}

export function createLedgerSimProxyHandlers(
  dependencies: LedgerSimProxyDependencies = {},
) {
  const environment = dependencies.env ?? process.env;
  const fetchUpstream = dependencies.fetch ?? globalThis.fetch;

  const handle = async (
    method: "GET" | "POST",
    request: Request,
    context: RouteContext,
  ): Promise<Response> => {
    let upstream: string | undefined;
    try {
      const ledger = resolveProfileLedgerConfig(environment, request);
      if (!ledger.enabled || !ledger.transports.includes("virtual")) {
        return response(404, "Not found.");
      }
      upstream = ledger.speculosUpstream;
    } catch {
      return response(404, "Not found.");
    }
    if (upstream === undefined) return response(404, "Not found.");

    let expectedOrigin: string;
    try {
      expectedOrigin = resolvePilotRequestAuthority(environment, request).origin;
    } catch {
      return response(404, "Not found.");
    }
    if (!isSameOriginBrowserRequest(request, expectedOrigin, method)) {
      return response(403, "Same-origin Ledger access is required.");
    }

    const { path } = await context.params;
    const target = targetFor(method, request, path);
    if (target === "method-not-allowed") {
      return response(405, "Method not allowed.");
    }
    if (target === undefined) return response(404, "Not found.");

    let body: string | undefined;
    if (method === "POST") {
      body = await boundedBody(request);
      if (body === undefined) return response(413, "Request body is too large.");
    }

    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType !== null) headers.set("Content-Type", contentType);
    try {
      const result = await fetchUpstream(
        `${upstream}${target.pathname}${target.search}`,
        {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          cache: "no-store",
          redirect: "error",
          signal: request.signal,
        },
      );
      return proxyResponse(result);
    } catch {
      return response(502, "The Virtual Ledger is unavailable.");
    }
  };

  return {
    GET: (request: Request, context: RouteContext) =>
      handle("GET", request, context),
    POST: (request: Request, context: RouteContext) =>
      handle("POST", request, context),
  };
}

