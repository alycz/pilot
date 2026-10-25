import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  LEDGER_COMPANION_HOST,
  LEDGER_COMPANION_ORIGIN,
  LEDGER_COMPANION_PORT,
  type LedgerCompanionService,
} from "./service";

const MAX_BODY_BYTES = 32 * 1024;

function rejected(response: ServerResponse, status: number, error: string): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "close");
  response.end(JSON.stringify({ error }));
}

function earlyBoundaryCheck(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::ffff:127.0.0.1";
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]
    .some((name) => request.headers[name] !== undefined);
  return loopback && request.headers.host === new URL(LEDGER_COMPANION_ORIGIN).host && !forwarded;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw Object.assign(new Error("request_too_large"), { status: 413 });
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) {
      request.destroy();
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function writeResponse(target: ServerResponse, source: Response): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, key) => target.setHeader(key, value));
  target.end(Buffer.from(await source.arrayBuffer()));
}

export function createLedgerCompanionListener(service: LedgerCompanionService): Readonly<{
  server: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
}> {
  let started = false;
  const server = createServer((incoming, outgoing) => {
    if (!earlyBoundaryCheck(incoming)) {
      incoming.resume();
      rejected(outgoing, 403, "loopback_boundary_denied");
      return;
    }
    void (async () => {
      try {
        const bytes = await readBody(incoming);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        }
        const request = new Request(`${LEDGER_COMPANION_ORIGIN}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers,
          body: bytes.length === 0 ? undefined : Uint8Array.from(bytes).buffer,
          signal: AbortSignal.timeout(5 * 60_000),
        });
        const response = await service.handle(request, {
          remoteAddress: incoming.socket.remoteAddress ?? "",
        });
        if (!outgoing.destroyed) await writeResponse(outgoing, response);
      } catch (error) {
        if (!outgoing.headersSent && !outgoing.destroyed) {
          const status = typeof error === "object" && error !== null && "status" in error &&
            Number.isInteger((error as { status: unknown }).status)
            ? Number((error as { status: number }).status)
            : 503;
          rejected(outgoing, status, status === 413 ? "request_too_large" : "companion_unavailable");
        } else {
          outgoing.destroy();
        }
      }
    })();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 5 * 60_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;

  return Object.freeze({
    server,
    start() {
      if (started) return Promise.reject(new Error("The Ledger companion listener is already started."));
      started = true;
      return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          host: LEDGER_COMPANION_HOST,
          port: LEDGER_COMPANION_PORT,
          exclusive: true,
        });
      });
    },
    stop() {
      if (!server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  });
}
