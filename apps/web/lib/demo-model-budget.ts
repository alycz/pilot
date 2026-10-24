import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

import { resolveProfileHarborBaseUrl } from "./runtime-profile";
import {
  HarborDemoQuotaClient,
  HarborDemoQuotaClientError,
  type HarborDemoQuotaStatus,
} from "./demo-model-quota-client";

// Free-only mode intentionally uses a new ledger. The earlier inactive
// micro-USD schema cannot be reinterpreted as money-free quota accounting.
const DATABASE_NAME = "demo-model-quota.sqlite";
const MODEL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}:free$/;
const WALLET_ACCOUNT_PATTERN = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const SESSION_ID_PATTERN = /^[A-Fa-f0-9]{64}$/;

export type DemoModelAccessErrorCode =
  | "DEMO_DISABLED"
  | "DEMO_MISCONFIGURED"
  | "DEMO_STATE_UNAVAILABLE"
  | "DEMO_MODEL_NOT_ALLOWED"
  | "DEMO_INPUT_TOO_LARGE"
  | "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED"
  | "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED"
  | "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED"
  | "DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED"
  | "DEMO_RATE_LIMITED"
  | "DEMO_GLOBAL_BUSY"
  | "DEMO_WALLET_BUSY"
  | "DEMO_ZERO_COST_INTEGRITY_BLOCKED"
  | "DEMO_RESERVATION_NOT_FOUND";

export class DemoModelAccessError extends Error {
  constructor(
    readonly code: DemoModelAccessErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DemoModelAccessError";
  }
}
type DemoModelCommonConfig = Readonly<{
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

export type DemoModelConfig = DemoModelCommonConfig & Readonly<
  | {
    quotaBackend: "sqlite-single-host";
    stateDirectory: string;
  }
  | {
    quotaBackend: "harbor-d1";
    harborBaseUrl: string;
    policyVersion: string;
  }
>;

export type DemoModelPublicStatus = Readonly<{
  available: boolean;
  code?:
    | "DEMO_DISABLED"
    | "DEMO_MISCONFIGURED"
    | "DEMO_STATE_UNAVAILABLE"
    | "DEMO_ZERO_COST_INTEGRITY_BLOCKED";
  allowedModels?: readonly string[];
  costPolicy?: "free-only";
  maxInputBytes?: number;
  maxOutputTokens?: number;
  maxSteps?: number;
}>;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;

export type DemoModelBudgetBackend = Readonly<{
  maxInputBytes: number;
  assertRequest(model: string, inputBytes: number): void | Promise<void>;
  assertIntegrityHealthy(): void | Promise<void>;
  reserve(
    input: DemoModelReservationInput,
  ): DemoModelReservation | Promise<DemoModelReservation>;
  settle(
    reservationId: string,
    settlement: Readonly<{
      outcome: "completed" | "uncertain";
      actualInputTokens?: number;
      actualOutputTokens?: number;
      integrityFailure?: DemoModelIntegrityFailure;
      now?: number;
    }>,
  ): DemoModelSettlement | Promise<DemoModelSettlement>;
  close?(): void | Promise<void>;
}>;

function configurationError(message: string): never {
  throw new DemoModelAccessError(
    "DEMO_MISCONFIGURED",
    503,
    `Demo model access is misconfigured: ${message}`,
  );
}

function positiveInteger(environment: Environment, name: string): number {
  const value = environment[name];
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    return configurationError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return configurationError(`${name} exceeds the supported integer range`);
  }
  return parsed;
}

function rejectLegacyMoneyConfiguration(environment: Environment): void {
  for (const name of [
    "DEMO_MODEL_GLOBAL_BUDGET_MICRO_USD",
    "DEMO_MODEL_RESERVATION_MICRO_USD",
    "DEMO_MODEL_WALLET_DAILY_BUDGET_MICRO_USD",
  ]) {
    const value = environment[name];
    if (value !== undefined && value !== "" && value !== "0") {
      configurationError(`${name} is obsolete in free-only mode and must be unset or 0`);
    }
  }
}

function allowedModels(value: string | undefined): readonly string[] {
  if (!value) return configurationError("DEMO_MODEL_ALLOWED_MODELS is required");
  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry || !MODEL_ID_PATTERN.test(entry)) ||
    new Set(entries).size !== entries.length
  ) {
    return configurationError(
      "DEMO_MODEL_ALLOWED_MODELS must be a unique comma-separated list of exact :free model ids",
    );
  }
  return Object.freeze(entries);
}

function validatePrivateDirectory(value: string | undefined): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    return configurationError(
      "DEMO_MODEL_STATE_DIR must be a normalized absolute path to a pre-existing directory",
    );
  }
  let stat;
  try {
    stat = lstatSync(value);
  } catch {
    throw new DemoModelAccessError(
      "DEMO_STATE_UNAVAILABLE",
      503,
      "Demo model quota storage is unavailable",
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return configurationError("DEMO_MODEL_STATE_DIR must be a real directory, not a symlink");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    return configurationError("DEMO_MODEL_STATE_DIR must have exact mode 0700");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return configurationError("DEMO_MODEL_STATE_DIR must be owned by the current user");
  }
  return value;
}

/** Parse the complete fail-closed demo configuration. Disabled is represented by null. */
export function readDemoModelConfig(
  environment: Environment = process.env,
): DemoModelConfig | null {
  const enabled = environment.DEMO_MODEL_ENABLED;
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") {
    return configurationError("DEMO_MODEL_ENABLED must be exactly 0 or 1");
  }
  const quotaBackend = environment.DEMO_MODEL_QUOTA_BACKEND;
  if (quotaBackend !== "sqlite-single-host" && quotaBackend !== "harbor-d1") {
    return configurationError(
      "DEMO_MODEL_QUOTA_BACKEND must be exactly sqlite-single-host or harbor-d1",
    );
  }
  if (environment.DEMO_MODEL_COST_POLICY !== "free-only") {
    return configurationError("DEMO_MODEL_COST_POLICY must be exactly free-only");
  }
  if (environment.DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE !== "verified") {
    return configurationError(
      "DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE must be verified after operator-side no-charge acceptance",
    );
  }
  if (environment.DEMO_OPENROUTER_KEY_LIMIT_USD !== "0") {
    return configurationError("DEMO_OPENROUTER_KEY_LIMIT_USD must be exactly 0");
  }
  if (environment.DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT !== "1") {
    return configurationError("DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT must be exactly 1");
  }
  if (environment.DEMO_OPENROUTER_NO_BYOK !== "verified") {
    return configurationError("DEMO_OPENROUTER_NO_BYOK must be verified");
  }
  if (environment.DEMO_OPENROUTER_PAID_ADDONS_DISABLED !== "verified") {
    return configurationError("DEMO_OPENROUTER_PAID_ADDONS_DISABLED must be verified");
  }
  rejectLegacyMoneyConfiguration(environment);
  const common: DemoModelCommonConfig = Object.freeze({
    costPolicy: "free-only",
    allowedModels: allowedModels(environment.DEMO_MODEL_ALLOWED_MODELS),
    globalDailyOutputTokens: positiveInteger(
      environment,
      "DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS",
    ),
    globalDailyRequests: positiveInteger(
      environment,
      "DEMO_MODEL_GLOBAL_DAILY_REQUESTS",
    ),
    walletDailyOutputTokens: positiveInteger(
      environment,
      "DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS",
    ),
    walletDailyRequests: positiveInteger(
      environment,
      "DEMO_MODEL_WALLET_DAILY_REQUESTS",
    ),
    rateWindowSeconds: positiveInteger(
      environment,
      "DEMO_MODEL_RATE_WINDOW_SECONDS",
    ),
    rateRequests: positiveInteger(environment, "DEMO_MODEL_RATE_REQUESTS"),
    maxGlobalConcurrency: positiveInteger(
      environment,
      "DEMO_MODEL_MAX_GLOBAL_CONCURRENCY",
    ),
    maxWalletConcurrency: positiveInteger(
      environment,
      "DEMO_MODEL_MAX_WALLET_CONCURRENCY",
    ),
    reservationTtlSeconds: positiveInteger(
      environment,
      "DEMO_MODEL_RESERVATION_TTL_SECONDS",
    ),
    abortGraceSeconds: positiveInteger(
      environment,
      "DEMO_MODEL_ABORT_GRACE_SECONDS",
    ),
    maxInputBytes: positiveInteger(environment, "DEMO_MODEL_MAX_INPUT_BYTES"),
    maxOutputTokens: positiveInteger(
      environment,
      "DEMO_MODEL_MAX_OUTPUT_TOKENS",
    ),
    maxSteps: positiveInteger(environment, "DEMO_MODEL_MAX_STEPS"),
  });

  let config: DemoModelConfig;
  if (quotaBackend === "sqlite-single-host") {
    if (
      environment.VERCEL === "1" ||
      environment.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
      environment.AWS_EXECUTION_ENV?.startsWith("AWS_Lambda_")
    ) {
      return configurationError(
        "the sqlite-single-host demo quota cannot run on serverless instances",
      );
    }
    config = Object.freeze({
      ...common,
      quotaBackend,
      stateDirectory: validatePrivateDirectory(environment.DEMO_MODEL_STATE_DIR),
    });
  } else {
    let harborBaseUrl: string;
    try {
      harborBaseUrl = resolveProfileHarborBaseUrl(environment);
    } catch {
      return configurationError("the Harbor D1 quota endpoint is invalid");
    }
    if (!harborBaseUrl.startsWith("https://")) {
      return configurationError("the Harbor D1 quota endpoint must use HTTPS");
    }
    const apiKey = environment.HARBOR_API_KEY?.trim();
    if (!apiKey || /[\u0000-\u0020\u007f]/.test(apiKey)) {
      return configurationError("HARBOR_API_KEY is required for Harbor D1 quota access");
    }
    const sessionSecret = environment.SESSION_SECRET?.trim();
    if (!sessionSecret || sessionSecret.length < 32) {
      return configurationError("SESSION_SECRET must contain at least 32 characters");
    }
    const policyVersion = environment.DEMO_MODEL_QUOTA_POLICY_VERSION?.trim();
    if (!policyVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(policyVersion)) {
      return configurationError(
        "DEMO_MODEL_QUOTA_POLICY_VERSION must be a safe non-empty version",
      );
    }
    config = Object.freeze({
      ...common,
      quotaBackend,
      harborBaseUrl,
      policyVersion,
    });
  }

  if (config.maxOutputTokens > config.globalDailyOutputTokens) {
    return configurationError(
      "DEMO_MODEL_MAX_OUTPUT_TOKENS may not exceed the global daily output-token quota",
    );
  }
  if (config.maxOutputTokens > config.walletDailyOutputTokens) {
    return configurationError(
      "DEMO_MODEL_MAX_OUTPUT_TOKENS may not exceed the wallet daily output-token quota",
    );
  }
  if (config.maxWalletConcurrency > config.maxGlobalConcurrency) {
    return configurationError(
      "DEMO_MODEL_MAX_WALLET_CONCURRENCY may not exceed global concurrency",
    );
  }
  if (config.maxGlobalConcurrency !== 1 || config.maxWalletConcurrency !== 1) {
    return configurationError(
      "strict zero-cost mode requires global and wallet concurrency to be exactly 1",
    );
  }
  if (config.maxOutputTokens < config.maxSteps) {
    return configurationError(
      "DEMO_MODEL_MAX_OUTPUT_TOKENS must be at least DEMO_MODEL_MAX_STEPS",
    );
  }
  if (config.abortGraceSeconds >= config.reservationTtlSeconds) {
    return configurationError(
      "DEMO_MODEL_ABORT_GRACE_SECONDS must be smaller than DEMO_MODEL_RESERVATION_TTL_SECONDS",
    );
  }
  return config;
}

export function readDemoModelPublicStatus(
  environment: Environment = process.env,
): DemoModelPublicStatus {
  let budget: DemoModelBudget | undefined;
  try {
    const config = readDemoModelConfig(environment);
    if (!config) return { available: false, code: "DEMO_DISABLED" };
    if (config.quotaBackend !== "sqlite-single-host") {
      // Remote integrity is asynchronous. Keeping the legacy synchronous API
      // fail-closed prevents a caller from accidentally treating local config
      // alone as proof that the shared D1 ledger is healthy.
      return { available: false, code: "DEMO_STATE_UNAVAILABLE" };
    }
    budget = new DemoModelBudget(config);
    budget.assertIntegrityHealthy();
    return {
      available: true,
      costPolicy: config.costPolicy,
      allowedModels: config.allowedModels,
      maxInputBytes: config.maxInputBytes,
      maxOutputTokens: config.maxOutputTokens,
      maxSteps: config.maxSteps,
    };
  } catch (error) {
    if (error instanceof DemoModelAccessError) {
      return {
        available: false,
        code: error.code === "DEMO_STATE_UNAVAILABLE" ||
            error.code === "DEMO_ZERO_COST_INTEGRITY_BLOCKED"
          ? error.code
          : "DEMO_MISCONFIGURED",
      };
    }
    return { available: false, code: "DEMO_STATE_UNAVAILABLE" };
  } finally {
    budget?.close();
  }
}

export async function readDemoModelPublicStatusAsync(
  environment: Environment = process.env,
  options: Readonly<{ fetch?: Fetch }> = {},
): Promise<DemoModelPublicStatus> {
  let budget: DemoModelBudgetBackend | undefined;
  try {
    const config = readDemoModelConfig(environment);
    if (!config) return { available: false, code: "DEMO_DISABLED" };
    if (config.quotaBackend === "sqlite-single-host") {
      return readDemoModelPublicStatus(environment);
    }
    const remote = new HarborDemoModelBudget(
      config,
      remoteSecrets(environment),
      options,
    );
    budget = remote;
    return await remote.publicStatus();
  } catch (error) {
    if (error instanceof DemoModelAccessError) {
      return {
        available: false,
        code: error.code === "DEMO_STATE_UNAVAILABLE" ||
            error.code === "DEMO_ZERO_COST_INTEGRITY_BLOCKED"
          ? error.code
          : "DEMO_MISCONFIGURED",
      };
    }
    return { available: false, code: "DEMO_STATE_UNAVAILABLE" };
  } finally {
    await budget?.close?.();
  }
}

export type DemoModelReservationInput = Readonly<{
  walletAccount: string;
  network: "testnet" | "devnet";
  walletSessionId: string;
  model: string;
  inputBytes: number;
  now?: number;
}>;

export type DemoModelReservation = Readonly<{
  id: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxSteps: number;
  remainingGlobalDailyOutputTokens: number;
  remainingWalletDailyOutputTokens: number;
  remainingWalletDailyRequests: number;
}>;

export type DemoModelSettlement = Readonly<{
  id: string;
  outcome: "completed" | "uncertain";
  alreadySettled: boolean;
}>;

export type DemoModelIntegrityFailure =
  | "unexpected-model"
  | "missing-cost"
  | "nonzero-cost";

const DEMO_MODEL_INTEGRITY_FAILURES: readonly DemoModelIntegrityFailure[] = [
  "unexpected-model",
  "missing-cost",
  "nonzero-cost",
];

function validateNonnegativeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new DemoModelAccessError(
      "DEMO_MISCONFIGURED",
      500,
      `${field} must be a nonnegative integer`,
    );
  }
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function firstNumber(statement: StatementSync, ...values: SQLInputValue[]): number {
  const row = statement.get(...values) as Record<string, unknown> | undefined;
  const value = row?.value;
  return typeof value === "number" ? value : 0;
}

function retryAfterSeconds(now: number, oldest: number | undefined, windowSeconds: number): number {
  if (oldest === undefined) return windowSeconds;
  return Math.max(1, Math.ceil((oldest + windowSeconds * 1_000 - now) / 1_000));
}

function assertConfiguredRequest(
  config: DemoModelConfig,
  model: string,
  inputBytes: number,
): void {
  if (!config.allowedModels.includes(model)) {
    throw new DemoModelAccessError(
      "DEMO_MODEL_NOT_ALLOWED",
      400,
      "The selected demo model is not available",
    );
  }
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
    throw new DemoModelAccessError(
      "DEMO_INPUT_TOO_LARGE",
      413,
      "The demo request size is invalid",
    );
  }
  if (inputBytes > config.maxInputBytes) {
    throw new DemoModelAccessError(
      "DEMO_INPUT_TOO_LARGE",
      413,
      "The demo request is too large",
    );
  }
}

function assertReservationScope(input: DemoModelReservationInput): void {
  if (!WALLET_ACCOUNT_PATTERN.test(input.walletAccount)) {
    throw new DemoModelAccessError(
      "DEMO_MISCONFIGURED",
      400,
      "A valid wallet account is required for demo model access",
    );
  }
  if (input.network !== "testnet" && input.network !== "devnet") {
    throw new DemoModelAccessError(
      "DEMO_MISCONFIGURED",
      400,
      "A test network is required for demo model access",
    );
  }
  if (!SESSION_ID_PATTERN.test(input.walletSessionId)) {
    throw new DemoModelAccessError(
      "DEMO_MISCONFIGURED",
      400,
      "A valid wallet session binding is required for demo model access",
    );
  }
  if (
    input.now !== undefined &&
    (!Number.isSafeInteger(input.now) || input.now < 0)
  ) {
    throw new DemoModelAccessError(
      "DEMO_MISCONFIGURED",
      500,
      "The demo model clock is invalid",
    );
  }
}

type RemoteSecrets = Readonly<{
  apiKey: string;
  sessionSecret: string;
}>;

function remoteSecrets(environment: Environment): RemoteSecrets {
  const apiKey = environment.HARBOR_API_KEY?.trim();
  const sessionSecret = environment.SESSION_SECRET?.trim();
  if (
    !apiKey ||
    /[\u0000-\u0020\u007f]/.test(apiKey) ||
    !sessionSecret ||
    sessionSecret.length < 32
  ) {
    return configurationError("Harbor D1 quota credentials are unavailable");
  }
  return { apiKey, sessionSecret };
}

function opaqueScope(
  secret: string,
  domain: "wallet" | "session",
  parts: readonly string[],
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`pilot-demo-quota-${domain}-scope-v1\0`, "utf8");
  for (const part of parts) {
    hmac.update(String(Buffer.byteLength(part, "utf8")), "ascii");
    hmac.update(":", "ascii");
    hmac.update(part, "utf8");
  }
  return hmac.digest("hex");
}

const REMOTE_CODES = new Set<DemoModelAccessErrorCode>([
  "DEMO_DISABLED",
  "DEMO_MISCONFIGURED",
  "DEMO_STATE_UNAVAILABLE",
  "DEMO_MODEL_NOT_ALLOWED",
  "DEMO_INPUT_TOO_LARGE",
  "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED",
  "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED",
  "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED",
  "DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED",
  "DEMO_RATE_LIMITED",
  "DEMO_GLOBAL_BUSY",
  "DEMO_WALLET_BUSY",
  "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
  "DEMO_RESERVATION_NOT_FOUND",
]);

function remoteFailure(error: unknown): DemoModelAccessError {
  if (
    error instanceof HarborDemoQuotaClientError &&
    REMOTE_CODES.has(error.code as DemoModelAccessErrorCode)
  ) {
    const code = error.code as DemoModelAccessErrorCode;
    const status = code === "DEMO_MODEL_NOT_ALLOWED" || code === "DEMO_MISCONFIGURED"
      ? 400
      : code === "DEMO_INPUT_TOO_LARGE"
        ? 413
        : code === "DEMO_RESERVATION_NOT_FOUND"
          ? 404
          : code === "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED" ||
              code === "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED" ||
              code === "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED" ||
              code === "DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED" ||
              code === "DEMO_RATE_LIMITED" ||
              code === "DEMO_GLOBAL_BUSY" ||
              code === "DEMO_WALLET_BUSY"
            ? 429
            : 503;
    return new DemoModelAccessError(
      code,
      status,
      "The shared free-demo quota service rejected this request",
      error.retryAfterSeconds,
    );
  }
  return new DemoModelAccessError(
    "DEMO_STATE_UNAVAILABLE",
    503,
    "Demo model quota storage is unavailable",
  );
}

function sameModels(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

export class HarborDemoModelBudget implements DemoModelBudgetBackend {
  private readonly client: HarborDemoQuotaClient;

  get maxInputBytes(): number {
    return this.config.maxInputBytes;
  }

  constructor(
    readonly config: Extract<DemoModelConfig, { quotaBackend: "harbor-d1" }>,
    private readonly secrets: RemoteSecrets,
    options: Readonly<{ fetch?: Fetch }> = {},
  ) {
    this.client = new HarborDemoQuotaClient({
      baseUrl: config.harborBaseUrl,
      apiKey: secrets.apiKey,
      policyVersion: config.policyVersion,
    }, options);
  }

  private assertStatusContract(status: HarborDemoQuotaStatus): void {
    if (
      status.policyVersion !== this.config.policyVersion ||
      status.costPolicy !== "free-only" ||
      !sameModels(status.allowedModels, this.config.allowedModels) ||
      status.globalDailyOutputTokens !== this.config.globalDailyOutputTokens ||
      status.globalDailyRequests !== this.config.globalDailyRequests ||
      status.walletDailyOutputTokens !== this.config.walletDailyOutputTokens ||
      status.walletDailyRequests !== this.config.walletDailyRequests ||
      status.rateWindowSeconds !== this.config.rateWindowSeconds ||
      status.rateRequests !== this.config.rateRequests ||
      status.maxGlobalConcurrency !== this.config.maxGlobalConcurrency ||
      status.maxWalletConcurrency !== this.config.maxWalletConcurrency ||
      status.reservationTtlSeconds !== this.config.reservationTtlSeconds ||
      status.abortGraceSeconds !== this.config.abortGraceSeconds ||
      status.maxInputBytes !== this.config.maxInputBytes ||
      status.maxOutputTokens !== this.config.maxOutputTokens ||
      status.maxSteps !== this.config.maxSteps
    ) {
      throw new DemoModelAccessError(
        "DEMO_STATE_UNAVAILABLE",
        503,
        "The shared free-demo quota policy does not match Pilot",
      );
    }
    if (!status.available) {
      throw new DemoModelAccessError(
        "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
        503,
        "Free demo access is paused after a zero-cost integrity check failed",
      );
    }
  }

  async publicStatus(): Promise<DemoModelPublicStatus> {
    try {
      const status = await this.client.status();
      this.assertStatusContract(status);
      return {
        available: true,
        costPolicy: "free-only",
        allowedModels: this.config.allowedModels,
        maxInputBytes: this.config.maxInputBytes,
        maxOutputTokens: this.config.maxOutputTokens,
        maxSteps: this.config.maxSteps,
      };
    } catch (error) {
      if (error instanceof DemoModelAccessError) throw error;
      throw remoteFailure(error);
    }
  }

  async assertIntegrityHealthy(): Promise<void> {
    await this.publicStatus();
  }

  async assertRequest(model: string, inputBytes: number): Promise<void> {
    assertConfiguredRequest(this.config, model, inputBytes);
    await this.assertIntegrityHealthy();
  }

  async reserve(input: DemoModelReservationInput): Promise<DemoModelReservation> {
    assertConfiguredRequest(this.config, input.model, input.inputBytes);
    assertReservationScope(input);
    try {
      const reservation = await this.client.reserve({
        version: 1,
        requestId: randomBytes(32).toString("hex"),
        walletScopeId: opaqueScope(
          this.secrets.sessionSecret,
          "wallet",
          [input.network, input.walletAccount],
        ),
        sessionScopeId: opaqueScope(
          this.secrets.sessionSecret,
          "session",
          [input.network, input.walletSessionId.toLowerCase()],
        ),
        network: input.network,
        model: input.model,
        inputBytes: input.inputBytes,
      });
      const expectedTimeoutMs =
        (this.config.reservationTtlSeconds - this.config.abortGraceSeconds) * 1_000;
      const expectedPerStepOutput = Math.floor(
        this.config.maxOutputTokens / this.config.maxSteps,
      );
      if (
        reservation.timeoutMs !== expectedTimeoutMs ||
        reservation.maxOutputTokens !== expectedPerStepOutput ||
        reservation.maxSteps !== this.config.maxSteps ||
        reservation.remainingGlobalDailyOutputTokens >
          this.config.globalDailyOutputTokens - this.config.maxOutputTokens ||
        reservation.remainingWalletDailyOutputTokens >
          this.config.walletDailyOutputTokens - this.config.maxOutputTokens ||
        reservation.remainingWalletDailyRequests >= this.config.walletDailyRequests
      ) {
        throw new DemoModelAccessError(
          "DEMO_STATE_UNAVAILABLE",
          503,
          "The shared free-demo reservation does not match Pilot's policy",
        );
      }
      return {
        id: reservation.id,
        timeoutMs: reservation.timeoutMs,
        maxOutputTokens: reservation.maxOutputTokens,
        maxSteps: reservation.maxSteps,
        remainingGlobalDailyOutputTokens:
          reservation.remainingGlobalDailyOutputTokens,
        remainingWalletDailyOutputTokens:
          reservation.remainingWalletDailyOutputTokens,
        remainingWalletDailyRequests: reservation.remainingWalletDailyRequests,
      };
    } catch (error) {
      throw remoteFailure(error);
    }
  }

  async settle(
    reservationId: string,
    settlement: Readonly<{
      outcome: "completed" | "uncertain";
      actualInputTokens?: number;
      actualOutputTokens?: number;
      integrityFailure?: DemoModelIntegrityFailure;
      now?: number;
    }>,
  ): Promise<DemoModelSettlement> {
    validateNonnegativeInteger(settlement.actualInputTokens, "actualInputTokens");
    validateNonnegativeInteger(settlement.actualOutputTokens, "actualOutputTokens");
    if (
      settlement.integrityFailure !== undefined &&
      !DEMO_MODEL_INTEGRITY_FAILURES.includes(settlement.integrityFailure)
    ) {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        500,
        "The demo model integrity failure is invalid",
      );
    }
    if (settlement.integrityFailure !== undefined && settlement.outcome !== "uncertain") {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        500,
        "A zero-cost integrity failure must settle as uncertain",
      );
    }
    try {
      return await this.client.settle({
        version: 1,
        reservationId,
        outcome: settlement.outcome,
        ...(settlement.actualInputTokens === undefined
          ? {}
          : { actualInputTokens: settlement.actualInputTokens }),
        ...(settlement.actualOutputTokens === undefined
          ? {}
          : { actualOutputTokens: settlement.actualOutputTokens }),
        ...(settlement.integrityFailure === undefined
          ? {}
          : { integrityFailure: settlement.integrityFailure }),
      });
    } catch (error) {
      throw remoteFailure(error);
    }
  }

  close(): void {
    // Stateless HTTPS client. Present for parity with the SQLite backend.
  }
}

export function createDemoModelBudget(
  environment: Environment = process.env,
  options: Readonly<{ fetch?: Fetch }> = {},
): DemoModelBudgetBackend {
  const config = readDemoModelConfig(environment);
  if (!config) {
    throw new DemoModelAccessError(
      "DEMO_DISABLED",
      503,
      "Demo model access is not enabled",
    );
  }
  return config.quotaBackend === "sqlite-single-host"
    ? new DemoModelBudget(config)
    : new HarborDemoModelBudget(config, remoteSecrets(environment), options);
}

export class DemoModelBudget implements DemoModelBudgetBackend {
  readonly config: Extract<DemoModelConfig, { quotaBackend: "sqlite-single-host" }>;
  private readonly database: DatabaseSync;

  get maxInputBytes(): number {
    return this.config.maxInputBytes;
  }

  constructor(config: Extract<DemoModelConfig, { quotaBackend: "sqlite-single-host" }>) {
    this.config = config;
    const databasePath = join(config.stateDirectory, DATABASE_NAME);
    try {
      let existing;
      try {
        existing = lstatSync(databasePath);
      } catch {
        existing = undefined;
      }
      if (existing && (
        existing.isSymbolicLink() ||
        !existing.isFile() ||
        (typeof process.getuid === "function" && existing.uid !== process.getuid())
      )) {
        throw new Error("unsafe database path");
      }
      this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
      chmodSync(databasePath, 0o600);
      this.database.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS demo_model_reservations (
          id TEXT PRIMARY KEY,
          wallet_account TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
          wallet_session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens > 0),
          status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'uncertain')),
          created_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          settled_at_ms INTEGER,
          actual_input_tokens INTEGER,
          actual_output_tokens INTEGER
        );
        CREATE INDEX IF NOT EXISTS demo_model_reservations_wallet_day
          ON demo_model_reservations(wallet_account, utc_day);
        CREATE INDEX IF NOT EXISTS demo_model_reservations_session_day
          ON demo_model_reservations(wallet_session_id, utc_day);
        CREATE INDEX IF NOT EXISTS demo_model_reservations_active
          ON demo_model_reservations(status, expires_at_ms);
        CREATE TABLE IF NOT EXISTS demo_model_zero_cost_integrity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          tripped_at_ms INTEGER NOT NULL,
          failure TEXT NOT NULL CHECK (
            failure IN ('unexpected-model', 'missing-cost', 'nonzero-cost')
          )
        );
      `);
    } catch {
      throw new DemoModelAccessError(
        "DEMO_STATE_UNAVAILABLE",
        503,
        "Demo model quota storage is unavailable",
      );
    }
  }

  static fromEnvironment(environment: Environment = process.env): DemoModelBudget {
    const config = readDemoModelConfig(environment);
    if (!config) {
      throw new DemoModelAccessError(
        "DEMO_DISABLED",
        503,
        "Demo model access is not enabled",
      );
    }
    if (config.quotaBackend !== "sqlite-single-host") {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        503,
        "Use createDemoModelBudget for the Harbor D1 quota backend",
      );
    }
    return new DemoModelBudget(config);
  }

  close(): void {
    this.database.close();
  }

  assertIntegrityHealthy(now = Date.now()): void {
    try {
      const integrityFailure = this.database.prepare(`
        SELECT failure FROM demo_model_zero_cost_integrity WHERE singleton = 1
        UNION ALL
        SELECT 'unverified-cost' AS failure FROM demo_model_reservations
        WHERE status = 'uncertain' OR (status = 'active' AND expires_at_ms <= ?)
        LIMIT 1
      `).get(now) as { failure?: string } | undefined;
      if (integrityFailure) {
        throw new DemoModelAccessError(
          "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
          503,
          "Free demo access is paused after a zero-cost integrity check failed",
        );
      }
    } catch (error) {
      if (error instanceof DemoModelAccessError) throw error;
      throw new DemoModelAccessError(
        "DEMO_STATE_UNAVAILABLE",
        503,
        "Demo model quota storage is unavailable",
      );
    }
  }

  assertRequest(model: string, inputBytes: number): void {
    this.assertIntegrityHealthy();
    assertConfiguredRequest(this.config, model, inputBytes);
  }

  reserve(input: DemoModelReservationInput): DemoModelReservation {
    assertConfiguredRequest(this.config, input.model, input.inputBytes);
    assertReservationScope(input);
    const walletSessionId = input.walletSessionId.toLowerCase();
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        500,
        "The demo model clock is invalid",
      );
    }
    this.assertIntegrityHealthy(now);

    const day = utcDay(now);
    const rateStart = now - this.config.rateWindowSeconds * 1_000;
    const reservationId = randomUUID();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database.prepare(`
        UPDATE demo_model_reservations
        SET status = 'uncertain', settled_at_ms = ?
        WHERE status = 'active' AND expires_at_ms <= ?
      `).run(now, now);

      // Recheck under the write lock so a concurrent integrity trip cannot
      // race between the public/preflight read and reservation creation.
      const integrityFailure = this.database.prepare(`
        SELECT failure FROM demo_model_zero_cost_integrity WHERE singleton = 1
        UNION ALL
        SELECT 'unverified-cost' AS failure FROM demo_model_reservations
        WHERE status = 'uncertain'
        LIMIT 1
      `).get() as { failure?: string } | undefined;
      if (integrityFailure) {
        throw new DemoModelAccessError(
          "DEMO_ZERO_COST_INTEGRITY_BLOCKED",
          503,
          "Free demo access is paused after a zero-cost integrity check failed",
        );
      }

      const priorSession = this.database.prepare(`
        SELECT wallet_account, network FROM demo_model_reservations
        WHERE wallet_session_id = ? LIMIT 1
      `).get(walletSessionId) as {
        wallet_account?: string;
        network?: string;
      } | undefined;
      if (priorSession && (
        priorSession.wallet_account !== input.walletAccount ||
        priorSession.network !== input.network
      )) {
        throw new DemoModelAccessError(
          "DEMO_MISCONFIGURED",
          400,
          "The wallet session binding does not match its original wallet scope",
        );
      }

      const globalUsed = firstNumber(this.database.prepare(`
        SELECT COALESCE(SUM(reserved_output_tokens), 0) AS value
        FROM demo_model_reservations WHERE utc_day = ?
      `), day);
      if (globalUsed + this.config.maxOutputTokens > this.config.globalDailyOutputTokens) {
        throw new DemoModelAccessError(
          "DEMO_GLOBAL_DAILY_OUTPUT_TOKENS_EXHAUSTED",
          429,
          "The shared free-demo output quota is exhausted for today",
        );
      }
      const globalRequests = firstNumber(this.database.prepare(`
        SELECT COUNT(*) AS value FROM demo_model_reservations WHERE utc_day = ?
      `), day);
      if (globalRequests >= this.config.globalDailyRequests) {
        throw new DemoModelAccessError(
          "DEMO_GLOBAL_DAILY_REQUESTS_EXHAUSTED",
          429,
          "The shared free-demo request quota is exhausted for today",
        );
      }

      const walletUsed = firstNumber(this.database.prepare(`
        SELECT COALESCE(SUM(reserved_output_tokens), 0) AS value
        FROM demo_model_reservations
        WHERE wallet_account = ? AND utc_day = ?
      `), input.walletAccount, day);
      const sessionUsed = firstNumber(this.database.prepare(`
        SELECT COALESCE(SUM(reserved_output_tokens), 0) AS value
        FROM demo_model_reservations
        WHERE wallet_session_id = ? AND utc_day = ?
      `), walletSessionId, day);
      if (
        walletUsed + this.config.maxOutputTokens > this.config.walletDailyOutputTokens ||
        sessionUsed + this.config.maxOutputTokens > this.config.walletDailyOutputTokens
      ) {
        throw new DemoModelAccessError(
          "DEMO_WALLET_DAILY_OUTPUT_TOKENS_EXHAUSTED",
          429,
          "The wallet free-demo output quota is exhausted for today",
        );
      }

      const walletRequests = firstNumber(this.database.prepare(`
        SELECT COUNT(*) AS value FROM demo_model_reservations
        WHERE wallet_account = ? AND utc_day = ?
      `), input.walletAccount, day);
      const sessionRequests = firstNumber(this.database.prepare(`
        SELECT COUNT(*) AS value FROM demo_model_reservations
        WHERE wallet_session_id = ? AND utc_day = ?
      `), walletSessionId, day);
      if (
        walletRequests >= this.config.walletDailyRequests ||
        sessionRequests >= this.config.walletDailyRequests
      ) {
        throw new DemoModelAccessError(
          "DEMO_WALLET_DAILY_REQUESTS_EXHAUSTED",
          429,
          "The wallet demo request quota is exhausted for today",
        );
      }

      const rateStatement = this.database.prepare(`
        SELECT COUNT(*) AS value FROM demo_model_reservations
        WHERE wallet_session_id = ? AND created_at_ms > ?
      `);
      const rateCount = firstNumber(rateStatement, walletSessionId, rateStart);
      if (rateCount >= this.config.rateRequests) {
        const oldest = this.database.prepare(`
          SELECT MIN(created_at_ms) AS oldest FROM demo_model_reservations
          WHERE wallet_session_id = ? AND created_at_ms > ?
        `).get(walletSessionId, rateStart) as { oldest?: number } | undefined;
        const retry = retryAfterSeconds(
          now,
          typeof oldest?.oldest === "number" ? oldest.oldest : undefined,
          this.config.rateWindowSeconds,
        );
        throw new DemoModelAccessError(
          "DEMO_RATE_LIMITED",
          429,
          "The demo model rate limit was reached",
          retry,
        );
      }

      const globalActive = firstNumber(this.database.prepare(`
        SELECT COUNT(*) AS value FROM demo_model_reservations WHERE status = 'active'
      `));
      if (globalActive >= this.config.maxGlobalConcurrency) {
        throw new DemoModelAccessError(
          "DEMO_GLOBAL_BUSY",
          429,
          "The shared demo is busy",
          1,
        );
      }
      const walletActive = firstNumber(this.database.prepare(`
        SELECT COUNT(*) AS value FROM demo_model_reservations
        WHERE status = 'active' AND (wallet_account = ? OR wallet_session_id = ?)
      `), input.walletAccount, walletSessionId);
      if (walletActive >= this.config.maxWalletConcurrency) {
        throw new DemoModelAccessError(
          "DEMO_WALLET_BUSY",
          429,
          "This wallet already has the maximum number of demo requests running",
          1,
        );
      }

      this.database.prepare(`
        INSERT INTO demo_model_reservations (
          id, wallet_account, network, wallet_session_id, model, utc_day,
          reserved_output_tokens, status, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        reservationId,
        input.walletAccount,
        input.network,
        walletSessionId,
        input.model,
        day,
        this.config.maxOutputTokens,
        now,
        now + this.config.reservationTtlSeconds * 1_000,
      );
      this.database.exec("COMMIT");

      return {
        id: reservationId,
        timeoutMs:
          (this.config.reservationTtlSeconds - this.config.abortGraceSeconds) * 1_000,
        // AI SDK caps each model step separately. Divide the configured
        // request-wide ceiling across the maximum number of steps.
        maxOutputTokens: Math.floor(
          this.config.maxOutputTokens / this.config.maxSteps,
        ),
        maxSteps: this.config.maxSteps,
        remainingGlobalDailyOutputTokens:
          this.config.globalDailyOutputTokens - globalUsed - this.config.maxOutputTokens,
        remainingWalletDailyOutputTokens:
          this.config.walletDailyOutputTokens -
          Math.max(walletUsed, sessionUsed) -
          this.config.maxOutputTokens,
        remainingWalletDailyRequests:
          this.config.walletDailyRequests -
          Math.max(walletRequests, sessionRequests) -
          1,
      };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed; never mask the original failure.
      }
      if (error instanceof DemoModelAccessError) throw error;
      throw new DemoModelAccessError(
        "DEMO_STATE_UNAVAILABLE",
        503,
        "Demo model quota storage is unavailable",
      );
    }
  }

  settle(
    reservationId: string,
    settlement: Readonly<{
      outcome: "completed" | "uncertain";
      actualInputTokens?: number;
      actualOutputTokens?: number;
      integrityFailure?: DemoModelIntegrityFailure;
      now?: number;
    }>,
  ): DemoModelSettlement {
    validateNonnegativeInteger(settlement.actualInputTokens, "actualInputTokens");
    validateNonnegativeInteger(settlement.actualOutputTokens, "actualOutputTokens");
    if (
      settlement.integrityFailure !== undefined &&
      !DEMO_MODEL_INTEGRITY_FAILURES.includes(settlement.integrityFailure)
    ) {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        500,
        "The demo model integrity failure is invalid",
      );
    }
    if (settlement.integrityFailure !== undefined && settlement.outcome !== "uncertain") {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        500,
        "A zero-cost integrity failure must settle as uncertain",
      );
    }
    const now = settlement.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new DemoModelAccessError(
        "DEMO_MISCONFIGURED",
        500,
        "The demo model clock is invalid",
      );
    }
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const row = this.database.prepare(`
        SELECT status, expires_at_ms, reserved_output_tokens
        FROM demo_model_reservations WHERE id = ?
      `).get(reservationId) as {
        status?: string;
        expires_at_ms?: number;
        reserved_output_tokens?: number;
      } | undefined;
      if (!row) {
        throw new DemoModelAccessError(
          "DEMO_RESERVATION_NOT_FOUND",
          404,
          "The demo model reservation was not found",
        );
      }
      if (settlement.integrityFailure !== undefined) {
        // Preserve the first failure as operator evidence. This write is in the
        // same transaction as settlement, and remains effective even if a
        // concurrent/late callback already marked the reservation uncertain.
        this.database.prepare(`
          INSERT OR IGNORE INTO demo_model_zero_cost_integrity (
            singleton, tripped_at_ms, failure
          ) VALUES (1, ?, ?)
        `).run(now, settlement.integrityFailure);
      }
      if (row.status !== "active") {
        this.database.exec("COMMIT");
        return {
          id: reservationId,
          outcome: row.status === "completed" ? "completed" : "uncertain",
          alreadySettled: true,
        };
      }
      const outputExceeded =
        settlement.actualOutputTokens !== undefined &&
        typeof row.reserved_output_tokens === "number" &&
        settlement.actualOutputTokens > row.reserved_output_tokens;
      const outcome =
        (typeof row.expires_at_ms === "number" && row.expires_at_ms <= now) ||
          outputExceeded
        ? "uncertain"
        : settlement.outcome;
      this.database.prepare(`
        UPDATE demo_model_reservations
        SET status = ?, settled_at_ms = ?, actual_input_tokens = ?, actual_output_tokens = ?
        WHERE id = ? AND status = 'active'
      `).run(
        outcome,
        now,
        settlement.actualInputTokens ?? null,
        settlement.actualOutputTokens ?? null,
        reservationId,
      );
      this.database.exec("COMMIT");
      return {
        id: reservationId,
        outcome,
        alreadySettled: false,
      };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed; never mask the original failure.
      }
      if (error instanceof DemoModelAccessError) throw error;
      throw new DemoModelAccessError(
        "DEMO_STATE_UNAVAILABLE",
        503,
        "Demo model quota storage is unavailable",
      );
    }
  }
}
