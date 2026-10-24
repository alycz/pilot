import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  activateHermesBridgeServiceAfterPortClaim,
  activateHermesBridgeServiceForTest,
  deactivateHermesBridgeServiceBeforePortRelease,
  deactivateHermesBridgeServiceForTest,
  type HermesBridgeService,
} from "./hermes-bridge-service";

export type HermesBridgeListenerConfig = Readonly<{
  controlOrigin: string;
  ingressOrigin: string;
  maxControlBodyBytes: number;
  maxIngressBodyBytes: number;
}>;

export type HermesBridgeListeners = Readonly<{
  /** Claims both fixed ports before the first journal read or write. */
  start(): Promise<void>;
  /** Keeps both ports claimed while active handlers abort and durably drain. */
  stop(): Promise<void>;
}>;

type Release = () => Promise<void>;

/** Test-only bind seam for deterministic ownership-race coverage. */
export type HermesBridgeListenerTestDependencies = Readonly<{
  bind?: (server: Server, origin: URL) => Promise<Release>;
}>;

type Phase = "idle" | "claiming" | "initializing" | "ready" | "quiescing" | "stopped";

function listenerOrigin(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
    url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Invalid Hermes bridge listener origin");
  }
  return url;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw Object.assign(new Error("request_too_large"), { status: 413 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) {
      request.destroy();
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function unavailable(target: ServerResponse): void {
  target.statusCode = 503;
  target.setHeader("cache-control", "no-store");
  target.setHeader("content-type", "application/json");
  target.setHeader("connection", "close");
  target.end(JSON.stringify({ error: "bridge_unavailable" }));
}

async function writeResponse(target: ServerResponse, response: Response): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

function makeServer(
  origin: URL,
  bodyLimit: number,
  handler: HermesBridgeService["handleControl"] | HermesBridgeService["handleIngress"],
  lifecycle: {
    phase(): Phase;
    enter(controller: AbortController, task: Promise<void>): void;
    leave(controller: AbortController, task: Promise<void>): void;
  },
): Server {
  const server = createServer((incoming, outgoing) => {
    if (lifecycle.phase() !== "ready") {
      incoming.resume();
      unavailable(outgoing);
      return;
    }
    const shutdown = new AbortController();
    const disconnected = new AbortController();
    const abortDisconnected = () => disconnected.abort(new Error("bridge_client_disconnected"));
    incoming.once("aborted", abortDisconnected);
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) abortDisconnected();
    });
    const task = (async () => {
      try {
        const body = await readBody(incoming, bodyLimit);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        }
        const request = new Request(`${origin.origin}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers,
          body: body.length === 0 ? undefined : Uint8Array.from(body).buffer,
          signal: AbortSignal.any([
            AbortSignal.timeout(65_000),
            disconnected.signal,
            shutdown.signal,
          ]),
        });
        const response = await handler(request, {
          remoteAddress: incoming.socket.remoteAddress ?? "",
        });
        if (!outgoing.destroyed) await writeResponse(outgoing, response);
      } catch (error) {
        if (outgoing.headersSent || outgoing.destroyed) {
          outgoing.destroy();
          return;
        }
        const status = typeof error === "object" && error !== null && "status" in error &&
          Number.isInteger((error as { status: unknown }).status)
          ? (error as { status: number }).status
          : 500;
        outgoing.statusCode = status;
        outgoing.setHeader("cache-control", "no-store");
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify({ error: status >= 500 ? "bridge_unavailable" : "bridge_rejected" }));
      }
    })();
    lifecycle.enter(shutdown, task);
    void task.finally(() => lifecycle.leave(shutdown, task));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 65_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;
  return server;
}

function listen(server: Server, origin: URL): Promise<Release> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise(() => close(server));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: Number(origin.port), exclusive: true });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
    server.closeIdleConnections();
  });
}

export function createHermesBridgeListeners(
  service: HermesBridgeService,
  config: HermesBridgeListenerConfig,
  dependencies: HermesBridgeListenerTestDependencies = {},
): HermesBridgeListeners {
  const control = listenerOrigin(config.controlOrigin);
  const ingress = listenerOrigin(config.ingressOrigin);
  if (control.origin === ingress.origin ||
    !Number.isSafeInteger(config.maxControlBodyBytes) || config.maxControlBodyBytes < 512 || config.maxControlBodyBytes > 64 * 1024 ||
    !Number.isSafeInteger(config.maxIngressBodyBytes) || config.maxIngressBodyBytes < 512 || config.maxIngressBodyBytes > 128 * 1024) {
    throw new Error("Invalid Hermes bridge listener configuration");
  }
  const bind = dependencies.bind ?? listen;
  let phase: Phase = "idle";
  const activeTasks = new Set<Promise<void>>();
  const activeControllers = new Set<AbortController>();
  const lifecycle = {
    phase: () => phase,
    enter(controller: AbortController, task: Promise<void>) {
      activeControllers.add(controller);
      activeTasks.add(task);
    },
    leave(controller: AbortController, task: Promise<void>) {
      activeControllers.delete(controller);
      activeTasks.delete(task);
    },
  };
  const controlServer = makeServer(control, config.maxControlBodyBytes, service.handleControl, lifecycle);
  const ingressServer = makeServer(ingress, config.maxIngressBodyBytes, service.handleIngress, lifecycle);
  let controlRelease: Release | undefined;
  let ingressRelease: Release | undefined;

  const releaseBoth = async () => {
    const releases = [ingressRelease, controlRelease].filter((release): release is Release => release !== undefined);
    ingressRelease = undefined;
    controlRelease = undefined;
    const results = await Promise.allSettled(releases.map((release) => release()));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  };

  return Object.freeze({
    async start() {
      if (phase !== "idle") throw new Error("Hermes bridge listeners cannot be restarted");
      phase = "claiming";
      try {
        // Fixed order prevents split control/ingress ownership between contenders.
        controlRelease = await bind(controlServer, control);
        ingressRelease = await bind(ingressServer, ingress);
        phase = "initializing";
        if (dependencies.bind) {
          await activateHermesBridgeServiceForTest(service);
        } else {
          await activateHermesBridgeServiceAfterPortClaim(
            service,
            controlServer,
            ingressServer,
          );
        }
        phase = "ready";
      } catch (error) {
        phase = "quiescing";
        await releaseBoth().catch(() => undefined);
        phase = "stopped";
        throw error;
      }
    },
    async stop() {
      if (phase === "idle" || phase === "stopped") return;
      if (phase === "claiming" || phase === "initializing") {
        throw new Error("Hermes bridge listeners are still starting");
      }
      phase = "quiescing";
      // Revoke all new service/journal entry while both exclusive ports are
      // still held. Already-entered handlers retain their own tracked drain.
      if (dependencies.bind) {
        deactivateHermesBridgeServiceForTest(service);
      } else {
        deactivateHermesBridgeServiceBeforePortRelease(service, controlServer, ingressServer);
      }
      // Ports remain bound while every active handler is forced through its
      // durable completed/uncertain transition.
      for (const controller of activeControllers) {
        controller.abort(new Error("bridge_shutting_down"));
      }
      await Promise.allSettled([...activeTasks]);
      await releaseBoth();
      phase = "stopped";
    },
  });
}
