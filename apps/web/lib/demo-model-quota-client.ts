const RESERVE_PATH = "internal/demo-model/v1/reservations";
const STATUS_PATH = "internal/demo-model/v1/status";
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const RESERVATION_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MODEL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}:free$/;

type Fetch = typeof fetch;

export type HarborDemoQuotaClientConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  policyVersion: string;
}>;

export type HarborDemoQuotaReserveInput = Readonly<{
  version: 1;
  requestId: string;
  walletScopeId: string;
  sessionScopeId: string;
  network: "testnet" | "devnet";
  model: string;
  inputBytes: number;
}>;

export type HarborDemoQuotaReservation = Readonly<{
  id: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxSteps: number;
  remainingGlobalDailyOutputTokens: number;
  remainingWalletDailyOutputTokens: number;
  remainingWalletDailyRequests: number;
  policyVersion: string;
}>;

export type HarborDemoQuotaSettleInput = Readonly<{
  version: 1;
  reservationId: string;
  outcome: "completed" | "uncertain";
  actualInputTokens?: number;
  actualOutputTokens?: number;
  integrityFailure?: "unexpected-model" | "missing-cost" | "nonzero-cost";
}>;

export type HarborDemoQuotaSettlement = Readonly<{
  id: string;
  outcome: "completed" | "uncertain";
  alreadySettled: boolean;
}>;

export type HarborDemoQuotaStatus = Readonly<{
  available: boolean;
  policyVersion: string;
  costPolicy: "free-only";
  allowedModels: readonly string[];
  globalDailyOutputTokens: number;
  globalDailyRequests: number;
  walletDailyOutputTokens: number;
  walletDailyRequests: number;
  rateWindowSeconds: number;
  rateRequests: number;
  maxGlobalConcurrency: number;
  maxWalletConcurrency: number;
  reservationTtlSeconds: number;
  abortGraceSeconds: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxSteps: number;
}>;

export class HarborDemoQuotaClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HarborDemoQuotaClientError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index]);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function protocolFailure(): never {
  throw new HarborDemoQuotaClientError(
    "DEMO_STATE_UNAVAILABLE",
    503,
    "Demo model quota storage is unavailable",
  );
}

function endpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  // `path` is deliberately relative: a configured base path is a trust
  // boundary and must never be discarded by a leading slash.
  const target = new URL(path, base);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(base.pathname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    return protocolFailure();
  }
  return target;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES) {
      return protocolFailure();
    }
  }
  if (!response.body) return protocolFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return protocolFailure();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return protocolFailure();
  }
}

function remoteError(payload: unknown, status: number): never {
  if (!record(payload) || !exactKeys(payload, ["ok", "error"]) || payload.ok !== false) {
    return protocolFailure();
  }
  const error = payload.error;
  if (!record(error)) return protocolFailure();
  const keys = error.retryAfterSeconds === undefined
    ? ["code", "message"]
    : ["code", "message", "retryAfterSeconds"];
  if (
    !exactKeys(error, keys) ||
    typeof error.code !== "string" ||
    !/^DEMO_[A-Z0-9_]+$/.test(error.code) ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > 256 ||
    (error.retryAfterSeconds !== undefined && !positiveInteger(error.retryAfterSeconds))
  ) {
    return protocolFailure();
  }
  throw new HarborDemoQuotaClientError(
    error.code,
    status,
    error.message,
    error.retryAfterSeconds as number | undefined,
  );
}

function parseReservation(payload: unknown, policyVersion: string): HarborDemoQuotaReservation {
  if (!record(payload) || !exactKeys(payload, ["ok", "reservation"]) || payload.ok !== true) {
    return protocolFailure();
  }
  const value = payload.reservation;
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "timeoutMs",
      "maxOutputTokens",
      "maxSteps",
      "remainingGlobalDailyOutputTokens",
      "remainingWalletDailyOutputTokens",
      "remainingWalletDailyRequests",
      "policyVersion",
    ]) ||
    typeof value.id !== "string" ||
    !RESERVATION_ID_PATTERN.test(value.id) ||
    !positiveInteger(value.timeoutMs) ||
    !positiveInteger(value.maxOutputTokens) ||
    !positiveInteger(value.maxSteps) ||
    !nonnegativeInteger(value.remainingGlobalDailyOutputTokens) ||
    !nonnegativeInteger(value.remainingWalletDailyOutputTokens) ||
    !nonnegativeInteger(value.remainingWalletDailyRequests) ||
    value.policyVersion !== policyVersion
  ) {
    return protocolFailure();
  }
  return value as HarborDemoQuotaReservation;
}

function parseSettlement(payload: unknown): HarborDemoQuotaSettlement {
  if (!record(payload) || !exactKeys(payload, ["ok", "settlement"]) || payload.ok !== true) {
    return protocolFailure();
  }
  const value = payload.settlement;
  if (
    !record(value) ||
    !exactKeys(value, ["id", "outcome", "alreadySettled"]) ||
    typeof value.id !== "string" ||
    !RESERVATION_ID_PATTERN.test(value.id) ||
    (value.outcome !== "completed" && value.outcome !== "uncertain") ||
    typeof value.alreadySettled !== "boolean"
  ) {
    return protocolFailure();
  }
  return value as HarborDemoQuotaSettlement;
}

function parseStatus(payload: unknown, policyVersion: string): HarborDemoQuotaStatus {
  if (!record(payload) || !exactKeys(payload, ["ok", "status"]) || payload.ok !== true) {
    return protocolFailure();
  }
  const value = payload.status;
  if (
    !record(value) ||
    !exactKeys(value, [
      "available",
      "policyVersion",
      "costPolicy",
      "allowedModels",
      "globalDailyOutputTokens",
      "globalDailyRequests",
      "walletDailyOutputTokens",
      "walletDailyRequests",
      "rateWindowSeconds",
      "rateRequests",
      "maxGlobalConcurrency",
      "maxWalletConcurrency",
      "reservationTtlSeconds",
      "abortGraceSeconds",
      "maxInputBytes",
      "maxOutputTokens",
      "maxSteps",
    ]) ||
    typeof value.available !== "boolean" ||
    value.policyVersion !== policyVersion ||
    value.costPolicy !== "free-only" ||
    !Array.isArray(value.allowedModels) ||
    value.allowedModels.length < 1 ||
    value.allowedModels.some((model) => typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) ||
    new Set(value.allowedModels).size !== value.allowedModels.length ||
    !positiveInteger(value.globalDailyOutputTokens) ||
    !positiveInteger(value.globalDailyRequests) ||
    !positiveInteger(value.walletDailyOutputTokens) ||
    !positiveInteger(value.walletDailyRequests) ||
    !positiveInteger(value.rateWindowSeconds) ||
    !positiveInteger(value.rateRequests) ||
    !positiveInteger(value.maxGlobalConcurrency) ||
    !positiveInteger(value.maxWalletConcurrency) ||
    !positiveInteger(value.reservationTtlSeconds) ||
    !positiveInteger(value.abortGraceSeconds) ||
    !positiveInteger(value.maxInputBytes) ||
    !positiveInteger(value.maxOutputTokens) ||
    !positiveInteger(value.maxSteps)
  ) {
    return protocolFailure();
  }
  return value as unknown as HarborDemoQuotaStatus;
}

export class HarborDemoQuotaClient {
  private readonly fetch: Fetch;

  constructor(
    private readonly config: HarborDemoQuotaClientConfig,
    options: Readonly<{ fetch?: Fetch }> = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private async request(path: string, init: RequestInit): Promise<{
    payload: unknown;
    response: Response;
  }> {
    const url = endpoint(this.config.baseUrl, path);
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return protocolFailure();
    }
    if (response.redirected || response.url !== url.toString()) return protocolFailure();
    const payload = await boundedJson(response);
    if (!response.ok) remoteError(payload, response.status);
    return { payload, response };
  }

  async reserve(input: HarborDemoQuotaReserveInput): Promise<HarborDemoQuotaReservation> {
    if (
      input.version !== 1 ||
      !HEX_64_PATTERN.test(input.requestId) ||
      !HEX_64_PATTERN.test(input.walletScopeId) ||
      !HEX_64_PATTERN.test(input.sessionScopeId) ||
      (input.network !== "testnet" && input.network !== "devnet") ||
      !MODEL_ID_PATTERN.test(input.model) ||
      !nonnegativeInteger(input.inputBytes)
    ) {
      return protocolFailure();
    }
    const body = JSON.stringify(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { payload } = await this.request(RESERVE_PATH, {
          method: "POST",
          body,
        });
        return parseReservation(payload, this.config.policyVersion);
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof HarborDemoQuotaClientError &&
          error.code === "DEMO_STATE_UNAVAILABLE"
        ) {
          // The first response may have been lost after D1 committed. Retry the
          // identical idempotency key and body; never mint another reservation.
          continue;
        }
        throw error;
      }
    }
    return protocolFailure();
  }

  async settle(input: HarborDemoQuotaSettleInput): Promise<HarborDemoQuotaSettlement> {
    const optionalUsageValid =
      (input.actualInputTokens === undefined || nonnegativeInteger(input.actualInputTokens)) &&
      (input.actualOutputTokens === undefined || nonnegativeInteger(input.actualOutputTokens));
    if (
      input.version !== 1 ||
      !RESERVATION_ID_PATTERN.test(input.reservationId) ||
      (input.outcome !== "completed" && input.outcome !== "uncertain") ||
      !optionalUsageValid ||
      (input.integrityFailure !== undefined &&
        !["unexpected-model", "missing-cost", "nonzero-cost"].includes(input.integrityFailure)) ||
      (input.integrityFailure !== undefined && input.outcome !== "uncertain")
    ) {
      return protocolFailure();
    }
    const path = `${RESERVE_PATH}/${encodeURIComponent(input.reservationId)}/settle`;
    const body = JSON.stringify(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { payload } = await this.request(path, {
          method: "POST",
          body,
        });
        return parseSettlement(payload);
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof HarborDemoQuotaClientError &&
          error.code === "DEMO_STATE_UNAVAILABLE"
        ) {
          continue;
        }
        throw error;
      }
    }
    return protocolFailure();
  }

  async status(): Promise<HarborDemoQuotaStatus> {
    const { payload } = await this.request(STATUS_PATH, { method: "GET" });
    return parseStatus(payload, this.config.policyVersion);
  }
}
