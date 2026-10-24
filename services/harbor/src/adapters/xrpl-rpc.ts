import { Client, RippledError } from "xrpl";

import type { OpContext } from "../catalog/registry";
import type { Network } from "../contracts";

export const XRPL_RPC_TIMEOUT_MS = 8_000;
export const XRPL_RPC_RETRIES = 1;

export type XrplTransportKind = "json-rpc" | "websocket";
export type XrplRequestIntent = "read" | "execute";

export type XrplRpcEnv = Partial<
  Record<
    | "XRPL_MAINNET_URL"
    | "XRPL_TESTNET_URL"
    | "XRPL_DEVNET_URL"
    | "XRPL_LENDING_DEVNET_URL",
    string
  >
>;

export type XrplNetworkConfig = {
  readonly jsonRpcUrl: string;
  readonly websocketUrl: string;
  readonly envKey: keyof XrplRpcEnv;
};

// Ripple's public endpoints and their supported protocols are documented at:
// https://xrpl.org/docs/tutorials/public-servers
export const XRPL_NETWORKS: Readonly<Record<Network, XrplNetworkConfig>> =
  Object.freeze({
    mainnet: Object.freeze({
      jsonRpcUrl: "https://s1.ripple.com:51234",
      websocketUrl: "wss://s1.ripple.com",
      envKey: "XRPL_MAINNET_URL",
    }),
    testnet: Object.freeze({
      jsonRpcUrl: "https://s.altnet.rippletest.net:51234",
      websocketUrl: "wss://s.altnet.rippletest.net:51233",
      envKey: "XRPL_TESTNET_URL",
    }),
    devnet: Object.freeze({
      jsonRpcUrl: "https://s.devnet.rippletest.net:51234",
      websocketUrl: "wss://s.devnet.rippletest.net:51233",
      envKey: "XRPL_DEVNET_URL",
    }),
    "lending-devnet": Object.freeze({
      jsonRpcUrl: "https://lend.devnet.rippletest.net:51234",
      websocketUrl: "wss://lend.devnet.rippletest.net:51233",
      envKey: "XRPL_LENDING_DEVNET_URL",
    }),
  });

export type XrplRequestOptions = {
  /** Force a transport. `path_find` otherwise selects WebSocket automatically. */
  transport?: XrplTransportKind;
  /** Mark requests that can execute ledger changes. Always rejected on mainnet. */
  intent?: XrplRequestIntent;
};

export type XrplTransportRequest = {
  readonly network: Network;
  readonly kind: XrplTransportKind;
  readonly url: string;
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

export interface XrplTransport {
  request(request: XrplTransportRequest): Promise<unknown>;
}

export interface XrplRpc {
  request(
    network: Network,
    command: string,
    params?: Readonly<Record<string, unknown>>,
    options?: XrplRequestOptions,
  ): Promise<Record<string, unknown>>;
}

export type XrplRpcErrorKind = "error" | "soft-empty";

/** A normalized, secret-safe error. It intentionally never retains the request. */
export class XrplRpcError extends Error {
  readonly service = "xrpl";

  constructor(
    message: string,
    readonly code: string,
    readonly kind: XrplRpcErrorKind = "error",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "XrplRpcError";
  }
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class JsonRpcTransport implements XrplTransport {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async request(request: XrplTransportRequest): Promise<unknown> {
    let response: Response;
    try {
      // JSON-RPC parameters are a one-item array, unlike WebSocket parameters,
      // which are top-level fields. See the official request convention:
      // https://xrpl.org/docs/references/http-websocket-apis/api-conventions/request-formatting
      response = await this.fetcher(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: request.command, params: [request.params] }),
        signal: request.signal,
      });
    } catch {
      throw new XrplRpcError(
        "XRPL transport request failed",
        "XRPL_TRANSPORT_ERROR",
        "error",
        true,
      );
    }

    if (!response.ok) {
      throw new XrplRpcError(
        `XRPL endpoint returned HTTP ${response.status}`,
        `HTTP_${response.status}`,
        "error",
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new XrplRpcError(
        "XRPL endpoint returned malformed JSON",
        "XRPL_MALFORMED_RESPONSE",
      );
    }
  }
}

export interface XrplWebSocketClient {
  connect(): Promise<void>;
  request(request: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
}

export type XrplWebSocketClientFactory = (
  url: string,
  timeoutMs: number,
) => XrplWebSocketClient;

const defaultWebSocketClientFactory: XrplWebSocketClientFactory = (
  url,
  timeoutMs,
) => new Client(url, { timeout: timeoutMs }) as unknown as XrplWebSocketClient;

export class XrplWebSocketTransport implements XrplTransport {
  constructor(
    private readonly clientFactory: XrplWebSocketClientFactory =
      defaultWebSocketClientFactory,
  ) {}

  async request(request: XrplTransportRequest): Promise<unknown> {
    const client = this.clientFactory(request.url, request.timeoutMs);
    try {
      await client.connect();
      // WebSocket method parameters belong at the request's top level:
      // https://xrpl.org/docs/references/http-websocket-apis/api-conventions/request-formatting#websocket-format
      return await client.request({ command: request.command, ...request.params });
    } catch (error) {
      if (error instanceof XrplRpcError) throw error;
      if (error instanceof RippledError && isRecord(error.data)) {
        // xrpl.js rejects protocol-level WebSocket responses instead of
        // returning them. Retain only the documented code; RippledError.data
        // can also contain the echoed request and must never escape.
        // https://js.xrpl.org/classes/RippledError.html
        const normalized = protocolError(error.data);
        if (normalized) throw normalized;
      }
      // xrpl.js errors can contain a serialized request. Never expose them.
      throw new XrplRpcError(
        "XRPL WebSocket request failed",
        "XRPL_TRANSPORT_ERROR",
        "error",
        true,
      );
    } finally {
      try {
        await client.disconnect();
      } catch {
        // A failed cleanup must not replace the request outcome or disclose data.
      }
    }
  }
}

export type CreateXrplRpcOptions = {
  env?: XrplRpcEnv;
  /** A fixture transport can handle both protocols by inspecting request.kind. */
  transport?: XrplTransport;
  jsonRpcTransport?: XrplTransport;
  websocketTransport?: XrplTransport;
  timeoutMs?: number;
  retries?: number;
};

const WEBSOCKET_ONLY_COMMANDS = new Set(["path_find", "subscribe", "unsubscribe"]);
const EXECUTION_COMMANDS = new Set(["submit", "submit_multisigned"]);
const SECRET_BEARING_COMMANDS = new Set(["sign", "sign_for", "wallet_propose"]);
const SOFT_EMPTY_CODES = new Set([
  "actNotFound",
  "entryNotFound",
  "objectNotFound",
  "txnNotFound",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveXrplNetwork(
  network: Network,
  env: XrplRpcEnv = {},
): XrplNetworkConfig {
  const defaults = XRPL_NETWORKS[network];
  const override = env[defaults.envKey]?.trim();
  if (!override) return defaults;

  if (override.startsWith("ws://") || override.startsWith("wss://")) {
    return Object.freeze({ ...defaults, websocketUrl: override });
  }
  if (override.startsWith("http://") || override.startsWith("https://")) {
    return Object.freeze({ ...defaults, jsonRpcUrl: override });
  }
  throw new XrplRpcError(
    `Invalid endpoint override for ${network}`,
    "XRPL_INVALID_ENDPOINT",
  );
}

function protocolError(response: Record<string, unknown>): XrplRpcError | undefined {
  const nested = isRecord(response.result) ? response.result : response;
  const standardError = isRecord(response.error) ? response.error : undefined;
  const codeValue =
    (typeof nested.error === "string" && nested.error) ||
    (typeof standardError?.code === "string" && standardError.code) ||
    (typeof standardError?.code === "number" && String(standardError.code));
  const failed = nested.status === "error" || standardError !== undefined || codeValue;
  if (!failed) return undefined;

  const code = codeValue || "XRPL_PROTOCOL_ERROR";
  // XRPL error responses echo the request, which may contain credentials.
  // Only retain the documented code, never the response/request/message:
  // https://xrpl.org/docs/references/http-websocket-apis/api-conventions/error-formatting
  return new XrplRpcError(
    `XRPL request failed with ${code}`,
    code,
    SOFT_EMPTY_CODES.has(code) ? "soft-empty" : "error",
    code === "tooBusy" || code === "noCurrent" || code === "noNetwork",
  );
}

export function normalizeXrplResponse(
  response: unknown,
): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new XrplRpcError(
      "XRPL endpoint returned a malformed response",
      "XRPL_MALFORMED_RESPONSE",
    );
  }
  const error = protocolError(response);
  if (error) throw error;

  const result = "result" in response ? response.result : response;
  if (!isRecord(result)) {
    throw new XrplRpcError(
      "XRPL endpoint returned a malformed result",
      "XRPL_MALFORMED_RESPONSE",
    );
  }
  return result;
}

function normalizedThrownError(error: unknown): XrplRpcError {
  if (error instanceof XrplRpcError) return error;
  return new XrplRpcError(
    "XRPL transport request failed",
    "XRPL_TRANSPORT_ERROR",
    "error",
    true,
  );
}

async function requestWithTimeout(
  transport: XrplTransport,
  request: Omit<XrplTransportRequest, "signal">,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new XrplRpcError(
          `XRPL request timed out after ${request.timeoutMs}ms`,
          "XRPL_TIMEOUT",
          "error",
          true,
        ),
      );
    }, request.timeoutMs);
  });

  try {
    return await Promise.race([
      transport.request({ ...request, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createXrplRpc(options: CreateXrplRpcOptions = {}): XrplRpc {
  const timeoutMs = options.timeoutMs ?? XRPL_RPC_TIMEOUT_MS;
  const retries = options.retries ?? XRPL_RPC_RETRIES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new RangeError("retries must be a non-negative safe integer");
  }

  const jsonRpcTransport =
    options.transport ?? options.jsonRpcTransport ?? new JsonRpcTransport();
  const websocketTransport =
    options.transport ??
    options.websocketTransport ??
    new XrplWebSocketTransport();

  return Object.freeze({
    async request(
      network: Network,
      command: string,
      params: Readonly<Record<string, unknown>> = {},
      requestOptions: XrplRequestOptions = {},
    ): Promise<Record<string, unknown>> {
      if (!command.trim()) {
        throw new XrplRpcError("XRPL command is required", "XRPL_INVALID_COMMAND");
      }
      if (SECRET_BEARING_COMMANDS.has(command)) {
        throw new XrplRpcError(
          "Secret-bearing XRPL commands are disabled",
          "XRPL_UNSAFE_COMMAND",
        );
      }
      if (
        network === "mainnet" &&
        (requestOptions.intent === "execute" || EXECUTION_COMMANDS.has(command))
      ) {
        throw new XrplRpcError(
          "XRPL execution is disabled on mainnet",
          "MAINNET_EXECUTION_DISABLED",
        );
      }

      const endpoint = resolveXrplNetwork(network, options.env);
      const endpointOverride = options.env?.[endpoint.envKey]?.trim();
      const kind =
        requestOptions.transport ??
        (WEBSOCKET_ONLY_COMMANDS.has(command) ||
        endpointOverride?.startsWith("ws")
          ? "websocket"
          : "json-rpc");
      const url = kind === "websocket" ? endpoint.websocketUrl : endpoint.jsonRpcUrl;
      const transport =
        kind === "websocket" ? websocketTransport : jsonRpcTransport;

      let lastError: XrplRpcError | undefined;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const response = await requestWithTimeout(transport, {
            network,
            kind,
            url,
            command,
            params,
            timeoutMs,
          });
          return normalizeXrplResponse(response);
        } catch (error) {
          lastError = normalizedThrownError(error);
          if (!lastError.retryable || attempt === retries) throw lastError;
        }
      }
      throw lastError ?? new XrplRpcError("XRPL request failed", "XRPL_ERROR");
    },
  });
}

function contextEnv(ctx: OpContext): XrplRpcEnv {
  return isRecord(ctx.env) ? (ctx.env as XrplRpcEnv) : {};
}

/**
 * Operation-handler entry point. Tests inject `ctx.xrplRpc`; production
 * handlers receive Worker bindings through `ctx.env`.
 */
export function requestXrpl(
  ctx: OpContext,
  network: Network,
  command: string,
  params?: Readonly<Record<string, unknown>>,
  options?: XrplRequestOptions,
): Promise<Record<string, unknown>> {
  const injected = ctx.xrplRpc;
  const rpc =
    isRecord(injected) && typeof injected.request === "function"
      ? (injected as unknown as XrplRpc)
      : createXrplRpc({ env: contextEnv(ctx) });
  return rpc.request(network, command, params, options);
}
