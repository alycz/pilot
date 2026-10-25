import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const AGENTCORE_RUNTIME_HOST = "0.0.0.0" as const;
export const AGENTCORE_RUNTIME_PORT = 8080 as const;

const JSON_MEDIA_TYPE = "application/json";
const WORKLOAD_ACCESS_TOKEN_HEADER = "workloadaccesstoken";

export type AgentCoreRuntimeInvocationContext = Readonly<{
  signal: AbortSignal;
  workloadAccessToken: string;
}>;

export interface AgentCoreRuntimeInvoker {
  invoke(raw: unknown, context: AgentCoreRuntimeInvocationContext): Promise<unknown>;
}

export type AgentCoreRuntimeHttpOptions = Readonly<{
  handler: AgentCoreRuntimeInvoker;
  host?: string;
  port?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
}>;

export type AgentCoreRuntimeHttpServer = Readonly<{
  server: Server;
  origin: string;
  close(): Promise<void>;
}>;

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function serializedJson(value: unknown): string {
  try {
    const body = JSON.stringify(value);
    if (typeof body !== "string") throw new Error("not serializable");
    return body;
  } catch {
    throw new RequestError(502, "runtime_response_invalid", "Runtime response is not JSON serializable");
  }
}

function jsonBody(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": `${JSON_MEDIA_TYPE}; charset=utf-8`,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  jsonBody(response, status, serializedJson(value));
}

function workloadAccessToken(request: IncomingMessage): string {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === WORKLOAD_ACCESS_TOKEN_HEADER) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const token = values[0];
  if (
    values.length !== 1 || !token || Buffer.byteLength(token, "utf8") > 65_536 ||
    /[\s\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new RequestError(401, "workload_identity_required", "Workload identity is unavailable");
  }
  return token;
}

async function invokeBeforeAbort(
  handler: AgentCoreRuntimeInvoker,
  value: unknown,
  context: AgentCoreRuntimeInvocationContext,
): Promise<unknown> {
  const { signal } = context;
  if (signal.aborted) throw signal.reason;
  const work = Promise.resolve().then(() => handler.invoke(value, context));
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("request_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // A dependency may ignore cancellation. Observe its eventual rejection and
    // release the HTTP concurrency slot as soon as the deadline wins the race.
    void work.catch(() => undefined);
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      throw new RequestError(400, "invalid_request", "Content-Length is invalid");
    }
    if (Number(declared) > maxBytes) {
      throw new RequestError(413, "request_too_large", "Request body exceeds the byte limit");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new RequestError(413, "request_too_large", "Request body exceeds the byte limit");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new RequestError(400, "invalid_request", "Request body is required");

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "invalid_request", "Request body must be valid JSON");
  }
}

function publicFailure(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "ZodError") {
    return new RequestError(400, "invalid_request", "Request does not match the Runtime contract");
  }
  return new RequestError(502, "runtime_dependency_failed", "Runtime dependency failed");
}

/**
 * Start the HTTP surface required by the AgentCore Runtime container contract.
 * Authentication is performed by AgentCore before this container is invoked;
 * the injected handler remains responsible for scoped Gateway authorization.
 */
export async function startAgentCoreRuntimeHttpServer(
  options: AgentCoreRuntimeHttpOptions,
): Promise<AgentCoreRuntimeHttpServer> {
  const host = options.host ?? AGENTCORE_RUNTIME_HOST;
  const port = options.port ?? AGENTCORE_RUNTIME_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const maxRequestBytes = positiveInteger(
    "maxRequestBytes",
    options.maxRequestBytes ?? 64 * 1024,
    1024 * 1024,
  );
  const maxResponseBytes = positiveInteger(
    "maxResponseBytes",
    options.maxResponseBytes ?? 256 * 1024,
    1024 * 1024,
  );
  const requestTimeoutMs = positiveInteger(
    "requestTimeoutMs",
    options.requestTimeoutMs ?? 30_000,
    60_000,
  );
  const maxConcurrentRequests = positiveInteger(
    "maxConcurrentRequests",
    options.maxConcurrentRequests ?? 1,
    32,
  );
  let inFlight = 0;

  const server = createServer(async (request, response) => {
    const rawTarget = request.url ?? "/";
    if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
      json(response, 400, { error: "invalid_request" });
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(rawTarget, "http://runtime.invalid");
    } catch {
      json(response, 400, { error: "invalid_request" });
      return;
    }
    if (requestUrl.search || requestUrl.hash) {
      json(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/ping") {
      json(response, 200, { status: inFlight >= maxConcurrentRequests ? "HealthyBusy" : "Healthy" });
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/invocations") {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (mediaType(request.headers["content-type"]) !== JSON_MEDIA_TYPE) {
      json(response, 415, { error: "unsupported_media_type" });
      return;
    }
    if (inFlight >= maxConcurrentRequests) {
      json(response, 429, { error: "runtime_busy" });
      return;
    }

    let platformToken: string;
    try {
      platformToken = workloadAccessToken(request);
    } catch (error) {
      const failure = publicFailure(error);
      json(response, failure.status, { error: failure.code });
      return;
    }

    inFlight += 1;
    const disconnect = new AbortController();
    const onAborted = () => disconnect.abort(new Error("request_aborted"));
    const onClosed = () => {
      if (!response.writableFinished) disconnect.abort(new Error("connection_closed"));
    };
    request.once("aborted", onAborted);
    response.once("close", onClosed);
    const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(requestTimeoutMs)]);
    try {
      const result = await invokeBeforeAbort(
        options.handler,
        await readJsonBody(request, maxRequestBytes),
        { signal, workloadAccessToken: platformToken },
      );
      if (signal.aborted) {
        throw new RequestError(504, "runtime_timeout", "Runtime request timed out");
      }
      const resultBody = serializedJson(result);
      if (Buffer.byteLength(resultBody) > maxResponseBytes) {
        throw new RequestError(502, "runtime_response_too_large", "Runtime response exceeds the byte limit");
      }
      jsonBody(response, 200, resultBody);
    } catch (error) {
      if (signal.aborted && !disconnect.signal.aborted) {
        json(response, 504, { error: "runtime_timeout" });
      } else if (!disconnect.signal.aborted) {
        const failure = publicFailure(error);
        json(response, failure.status, { error: failure.code });
      }
    } finally {
      request.off("aborted", onAborted);
      response.off("close", onClosed);
      inFlight -= 1;
    }
  });
  server.requestTimeout = requestTimeoutMs + 1_000;
  server.headersTimeout = Math.min(requestTimeoutMs, 10_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("AgentCore Runtime failed to bind");
  }
  const originHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const origin = `http://${originHost.includes(":") ? `[${originHost}]` : originHost}:${address.port}`;
  return {
    server,
    origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
