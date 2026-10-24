import type {
  BlockedFieldKind,
  Envelope,
  Ok,
  TrustScreen,
} from "../contracts";
import {
  invokeGuardrailCheck,
  readGuardrailsMode,
  type GuardrailClientOptions,
  type GuardrailsEnv,
} from "../aws/guardrails";
import {
  collectUntrustedFields,
  redactUntrustedFields,
  type UntrustedField,
} from "./untrusted-fields";

export const BLOCKED_TEXT =
  "[blocked: possible prompt injection · screened by AWS Bedrock Guardrails]";
export const UNSCREENED_TEXT = "[unscreened text hidden]";

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_CONCURRENCY = 4;
const SCORE_CACHE_LIMIT = 2_000;

export type ScreenLatency = {
  operation: string;
  elapsed_ms: number;
  fields_checked: number;
  fields_blocked: number;
  provider: TrustScreen["provider"];
};

export type ScreenOptions = {
  env?: GuardrailsEnv;
  checkText?: (
    text: string,
    options: GuardrailClientOptions,
  ) => Promise<{ score: number }>;
  timeoutMs?: number;
  now?: () => number;
  log?: (entry: ScreenLatency) => void;
};

const scoreCache = new Map<string, Promise<number>>();

function parseThreshold(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_THRESHOLD;
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("GUARDRAILS_THRESHOLD must be between 0 and 1");
  }
  return threshold;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function remember(key: string, value: Promise<number>): void {
  scoreCache.delete(key);
  scoreCache.set(key, value);
  if (scoreCache.size > SCORE_CACHE_LIMIT) {
    const oldest = scoreCache.keys().next().value as string | undefined;
    if (oldest !== undefined) scoreCache.delete(oldest);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Guardrails request timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function scoreText(
  text: string,
  options: Required<Pick<ScreenOptions, "timeoutMs">> & ScreenOptions,
  env: GuardrailsEnv,
): Promise<number> {
  const key = await sha256(text);
  const cached = scoreCache.get(key);
  if (cached !== undefined) {
    remember(key, cached);
    return cached;
  }

  const pending = withTimeout(
    (options.checkText ?? invokeGuardrailCheck)(text, { env }),
    options.timeoutMs,
  ).then(({ score }) => score);
  remember(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (scoreCache.get(key) === pending) scoreCache.delete(key);
    throw error;
  }
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function withScreen<T>(
  envelope: Ok<T>,
  data: T,
  screen: TrustScreen,
  redacted: boolean,
): Ok<T> {
  const caveat = redacted
    ? [...new Set([...(envelope.caveat ?? []), "screened-redacted" as const])]
    : envelope.caveat;
  return {
    ...envelope,
    data,
    ...(caveat && caveat.length > 0 ? { caveat } : {}),
    trust: { ...(envelope.trust ?? {}), screen },
  };
}

function defaultLog(entry: ScreenLatency): void {
  console.info("guardrails_screen", entry);
}

function emitLatency(
  operation: string,
  startedAt: number,
  screen: TrustScreen,
  options: ScreenOptions,
): void {
  const now = options.now ?? Date.now;
  const logger = options.log ?? (screen.provider === "off" ? undefined : defaultLog);
  logger?.({
    operation,
    elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
    fields_checked: screen.fields_checked,
    fields_blocked: screen.fields_blocked,
    provider: screen.provider,
  });
}

function blockedFieldKinds(
  fields: readonly UntrustedField[],
): BlockedFieldKind[] {
  return [...new Set(fields.map(({ kind }) => kind))];
}

/** Screen successful operation envelopes before REST or MCP returns them. */
export async function screenEnvelope<T>(
  operationName: string,
  envelope: Envelope<T>,
  options: ScreenOptions = {},
): Promise<Envelope<T>> {
  if (!envelope.ok) return envelope;

  const now = options.now ?? Date.now;
  const startedAt = now();
  const env = options.env ?? {};
  const fields = collectUntrustedFields(operationName, envelope.data);
  const mode = readGuardrailsMode(env);

  if (mode === "off") {
    const screen: TrustScreen = {
      provider: "off",
      fields_checked: 0,
      fields_blocked: 0,
    };
    emitLatency(operationName, startedAt, screen, options);
    return withScreen(envelope, envelope.data, screen, false);
  }

  if (fields.length === 0) {
    const screen: TrustScreen = {
      provider: mode === "mock" ? "mock" : "aws-bedrock-guardrails",
      fields_checked: 0,
      fields_blocked: 0,
    };
    emitLatency(operationName, startedAt, screen, options);
    return withScreen(envelope, envelope.data, screen, false);
  }

  try {
    const threshold = parseThreshold(env.GUARDRAILS_THRESHOLD);
    const scores = await mapWithConcurrency(
      fields,
      MAX_CONCURRENCY,
      (field) =>
        scoreText(
          field.value,
          { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
          env,
        ),
    );
    const blocked = new Set<UntrustedField>(
      fields.filter((_field, index) => scores[index] >= threshold),
    );
    const data =
      blocked.size > 0
        ? (redactUntrustedFields(
            envelope.data,
            [...blocked],
            () => BLOCKED_TEXT,
          ) as T)
        : envelope.data;
    const screen: TrustScreen = {
      provider: mode === "mock" ? "mock" : "aws-bedrock-guardrails",
      fields_checked: fields.length,
      fields_blocked: blocked.size,
      max_score: Math.max(...scores),
      ...(blocked.size > 0
        ? { blocked_field_kinds: blockedFieldKinds([...blocked]) }
        : {}),
    };
    emitLatency(operationName, startedAt, screen, options);
    return withScreen(envelope, data, screen, blocked.size > 0);
  } catch {
    const data = redactUntrustedFields(
      envelope.data,
      fields,
      () => UNSCREENED_TEXT,
    ) as T;
    const screen: TrustScreen = {
      provider: "unavailable",
      fields_checked: fields.length,
      fields_blocked: fields.length,
      blocked_field_kinds: blockedFieldKinds(fields),
    };
    emitLatency(operationName, startedAt, screen, options);
    return withScreen(envelope, data, screen, true);
  }
}

/** Test-only reset for deterministic cache assertions. */
export function clearGuardrailScoreCache(): void {
  scoreCache.clear();
}
