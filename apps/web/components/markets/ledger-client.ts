/**
 * Minimal read-only XRP Ledger WebSocket client for the browser.
 *
 * The Markets page talks to public rippled nodes directly from the visitor's
 * browser: no Pilot backend, no Harbor key, no server cost. The client can only
 * issue an allowlist of read commands; anything that could move funds
 * (submit, sign, path_find subscriptions, account streams…) throws before a
 * byte leaves the browser.
 */

export type LedgerNetwork = "mainnet" | "testnet";

/** Public rippled WebSocket endpoints, tried in order with fallback. */
export const LEDGER_ENDPOINTS: Record<LedgerNetwork, readonly string[]> = {
  // Community cluster first, then Ripple's public mainnet servers.
  mainnet: ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"],
  // Same testnet endpoint the Portfolio live view uses (portfolio/live-state.ts).
  testnet: ["wss://s.altnet.rippletest.net:51233"],
};

export const READ_ONLY_COMMANDS = [
  "server_info",
  "book_offers",
  "amm_info",
  "account_info",
  "gateway_balances",
] as const;

export type ReadCommand = (typeof READ_ONLY_COMMANDS)[number];
export type StreamCommand = "subscribe" | "unsubscribe";
export type LedgerCommand = ReadCommand | StreamCommand;

export class LedgerCommandNotAllowedError extends Error {
  constructor(command: string) {
    super(`Ledger command "${command}" is not allowed: the Markets client is read-only.`);
    this.name = "LedgerCommandNotAllowedError";
  }
}

export class LedgerRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LedgerRequestError";
  }
}

/**
 * Throws unless the command is a read in the allowlist, or a subscribe /
 * unsubscribe to exactly the `ledger` stream (no accounts, books or other
 * streams).
 */
export function assertReadOnly(command: string, params: Record<string, unknown> = {}): asserts command is LedgerCommand {
  if ((READ_ONLY_COMMANDS as readonly string[]).includes(command)) return;
  if (command === "subscribe" || command === "unsubscribe") {
    const keys = Object.keys(params);
    const streams = params.streams;
    const onlyLedger =
      keys.length === 1 &&
      keys[0] === "streams" &&
      Array.isArray(streams) &&
      streams.length === 1 &&
      streams[0] === "ledger";
    if (onlyLedger) return;
  }
  throw new LedgerCommandNotAllowedError(command);
}

export type LedgerStatus = "idle" | "connecting" | "open" | "reconnecting" | "paused" | "failed";

export type LedgerResponse<T = Record<string, unknown>> = {
  result: T;
  ms: number;
  endpoint: string;
};

type Pending = {
  resolve: (value: LedgerResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  started: number;
};

const RETRYABLE_READ_CODES = new Set(["HTTP_429", "rateLimit", "rateLimited", "slowDown", "tooBusy"]);

/** Capacity errors are safe to retry because this client only permits reads. */
export function isRetryableLedgerReadError(cause: unknown): cause is LedgerRequestError {
  if (!(cause instanceof LedgerRequestError)) return false;
  return RETRYABLE_READ_CODES.has(cause.code) || /rate[ -]?limit|quota|too busy|temporarily unavailable/i.test(cause.message);
}

/** Provider retry hint, when the response includes one (for example "~189064ms"). */
export function ledgerRetryAfterMs(cause: unknown): number | null {
  if (!(cause instanceof Error)) return null;
  const milliseconds = cause.message.match(/retry\s+in\s+~?(\d+)\s*ms/i);
  if (milliseconds) return Number(milliseconds[1]);
  const seconds = cause.message.match(/retry\s+in\s+~?(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  return seconds ? Math.round(Number(seconds[1]) * 1_000) : null;
}

/** The subset of the WebSocket API the client needs (injectable in tests). */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type LedgerClientOptions = {
  endpoints: readonly string[];
  createSocket?: (url: string) => SocketLike;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  onStatus?: (status: LedgerStatus, endpoint: string | null) => void;
  onLedgerClosed?: (ledgerIndex: number, ledgerTime: number | null) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

const OPEN = 1;
const MAX_BACKOFF_MS = 30_000;

export class LedgerClient {
  private socket: SocketLike | null = null;
  private endpointIndex = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private status: LedgerStatus = "idle";
  private wantLedgerStream = false;
  private stopped = true;
  private failedAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failoverPromise: Promise<void> | null = null;
  private connectWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly options: Required<Omit<LedgerClientOptions, "onStatus" | "onLedgerClosed">> &
    Pick<LedgerClientOptions, "onStatus" | "onLedgerClosed">;

  constructor(options: LedgerClientOptions) {
    if (!options.endpoints.length) throw new Error("At least one ledger endpoint is required.");
    this.options = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      requestTimeoutMs: 8_000,
      connectTimeoutMs: 8_000,
      now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle),
      ...options,
    };
  }

  get endpoint(): string | null {
    return this.socket ? this.options.endpoints[this.endpointIndex] ?? null : null;
  }

  get currentStatus(): LedgerStatus {
    return this.status;
  }

  /** Opens a connection (no-op when already open or connecting). */
  connect(): Promise<void> {
    this.stopped = false;
    if (this.status === "open") return Promise.resolve();
    const waiter = new Promise<void>((resolve, reject) => this.connectWaiters.push({ resolve, reject }));
    if (this.status !== "connecting" && this.status !== "reconnecting") this.open();
    return waiter;
  }

  /**
   * Sends one allowlisted request. Read-only calls retry capacity failures on
   * the next configured public node; semantic rippled errors return directly.
   */
  request<T = Record<string, unknown>>(command: LedgerCommand, params: Record<string, unknown> = {}): Promise<LedgerResponse<T>> {
    assertReadOnly(command, params);
    const isRead = (READ_ONLY_COMMANDS as readonly string[]).includes(command);
    return this.requestWithFailover<T>(command, params, isRead);
  }

  private async requestWithFailover<T>(
    command: LedgerCommand,
    params: Record<string, unknown>,
    isRead: boolean,
  ): Promise<LedgerResponse<T>> {
    const attempts = isRead ? this.options.endpoints.length : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.requestOnce<T>(command, params);
      } catch (cause) {
        if (!isRead || !isRetryableLedgerReadError(cause) || attempt === attempts - 1) throw cause;
        await this.failOver(cause);
      }
    }
    throw new LedgerRequestError("The ledger read failed.", "error");
  }

  private requestOnce<T = Record<string, unknown>>(command: LedgerCommand, params: Record<string, unknown>): Promise<LedgerResponse<T>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.status !== "open") {
      return Promise.reject(new LedgerRequestError("The ledger connection is not open.", "notConnected"));
    }
    const id = this.nextId++;
    return new Promise<LedgerResponse<T>>((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pending.delete(id);
        reject(new LedgerRequestError(`${command} timed out.`, "timeout"));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: LedgerResponse) => void,
        reject,
        timer,
        started: this.options.now(),
      });
      socket.send(JSON.stringify({ id, command, ...params }));
    });
  }

  /** Move all in-flight reads together so one quota response causes one reconnect. */
  private failOver(reason: LedgerRequestError): Promise<void> {
    if (this.failoverPromise) return this.failoverPromise;
    this.failoverPromise = (async () => {
      this.teardown(reason);
      this.endpointIndex = (this.endpointIndex + 1) % this.options.endpoints.length;
      this.failedAttempts = 1;
      // connect() starts only from an idle state; open() immediately reports
      // the externally visible reconnecting transition.
      this.status = "idle";
      await this.connect();
    })().finally(() => {
      this.failoverPromise = null;
    });
    return this.failoverPromise;
  }

  /**
   * Marks the ledger stream as wanted so every (re)connection subscribes on
   * open, even if the first connection attempt failed.
   */
  followLedger(): void {
    this.wantLedgerStream = true;
  }

  /** Subscribes to validated-ledger closes; re-subscribes after reconnects. */
  async subscribeLedger(): Promise<number | null> {
    this.wantLedgerStream = true;
    const response = await this.request<{ ledger_index?: number }>("subscribe", { streams: ["ledger"] });
    return typeof response.result.ledger_index === "number" ? response.result.ledger_index : null;
  }

  /** Closes the socket and stops reconnecting until `connect()` is called again. */
  pause(): void {
    this.stopped = true;
    this.teardown(new LedgerRequestError("The ledger connection was paused.", "paused"));
    this.setStatus("paused");
  }

  close(): void {
    this.stopped = true;
    this.wantLedgerStream = false;
    this.teardown(new LedgerRequestError("The ledger connection was closed.", "closed"));
    this.setStatus("idle");
  }

  private setStatus(status: LedgerStatus): void {
    this.status = status;
    this.options.onStatus?.(status, status === "open" ? this.endpoint : null);
  }

  private open(): void {
    this.clearReconnect();
    const url = this.options.endpoints[this.endpointIndex]!;
    this.setStatus(this.failedAttempts === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(url);
    } catch {
      this.onSocketFailed();
      return;
    }
    this.socket = socket;
    const connectTimer = this.options.setTimer(() => {
      if (this.socket === socket && this.status !== "open") {
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          // ignore
        }
        this.onSocketFailed();
      }
    }, this.options.connectTimeoutMs);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.options.clearTimer(connectTimer);
      this.failedAttempts = 0;
      this.setStatus("open");
      for (const waiter of this.connectWaiters.splice(0)) waiter.resolve();
      if (this.wantLedgerStream) void this.subscribeLedger().catch(() => undefined);
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => {
      // onclose always follows; handled there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.options.clearTimer(connectTimer);
      const wasOpen = this.status === "open";
      this.teardown(new LedgerRequestError("The ledger connection closed.", "disconnected"));
      if (this.stopped) return;
      if (wasOpen) {
        // A healthy socket dropped: retry the same endpoint first.
        this.scheduleReconnect(1_000);
      } else {
        this.onSocketFailed();
      }
    };
  }

  private onSocketFailed(): void {
    this.socket = null;
    if (this.stopped) return;
    this.failedAttempts += 1;
    this.endpointIndex = (this.endpointIndex + 1) % this.options.endpoints.length;
    // After a full pass over every endpoint without a connection, report failure
    // to anyone waiting, but keep retrying in the background with backoff.
    if (this.failedAttempts % this.options.endpoints.length === 0) {
      const error = new LedgerRequestError("Could not reach any public XRP Ledger node.", "unreachable");
      for (const waiter of this.connectWaiters.splice(0)) waiter.reject(error);
      this.setStatus("failed");
    }
    const pass = Math.floor(this.failedAttempts / this.options.endpoints.length);
    const delay = this.failedAttempts % this.options.endpoints.length === 0 ? Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, pass - 1)) : 250;
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(ms: number): void {
    this.clearReconnect();
    if (this.status !== "failed") this.setStatus("reconnecting");
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, ms);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      this.options.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardown(reason: Error): void {
    this.clearReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    for (const [id, entry] of this.pending) {
      this.options.clearTimer(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
    if (this.stopped) {
      for (const waiter of this.connectWaiters.splice(0)) waiter.reject(reason);
    }
  }

  private onMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "ledgerClosed") {
      const index = Number(message.ledger_index);
      if (Number.isFinite(index)) {
        const time = Number(message.ledger_time);
        this.options.onLedgerClosed?.(index, Number.isFinite(time) ? time : null);
      }
      return;
    }

    const id = typeof message.id === "number" ? message.id : Number.NaN;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.options.clearTimer(entry.timer);
    if (message.status === "success" && message.result && typeof message.result === "object") {
      entry.resolve({
        result: message.result as Record<string, unknown>,
        ms: Math.round(this.options.now() - entry.started),
        endpoint: this.options.endpoints[this.endpointIndex] ?? "",
      });
      return;
    }
    const code = typeof message.error === "string" ? message.error : "error";
    const text = typeof message.error_message === "string" ? message.error_message : code;
    entry.reject(new LedgerRequestError(text, code));
  }
}

/** Host part of a WebSocket URL for display ("xrplcluster.com"). */
export function endpointHost(url: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
