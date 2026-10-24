import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  ProposalRequestSchema,
  ProposalResultSchema,
  type ProposalCallOptions,
  type ProposalProvider,
  type ProposalRequest,
  type ProposalResult,
} from "./proposal-provider";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const REDACTED_CONTEXT_SCHEMA_VERSION =
  "pilot.redacted-proposal-context.v1" as const;

const RedactedTextFieldSchema = z.enum([
  "request_summary",
  "evidence_summary",
  "policy_summary",
  "portfolio_summary",
  "procedure_summary",
  "fixture_reference",
]);
const RedactedMetricFieldSchema = z.enum([
  "evidence_count",
  "quality_bps",
  "evidence_coverage_bps",
  "evaluation_latency_ms",
]);
const RedactedFlagFieldSchema = z.enum([
  "is_redacted_replay",
  "has_policy_caveat",
]);
const EXPLICIT_CREDENTIAL_MARKER =
  /\b(?:api[\s_-]*key|access[\s_-]*token|authorization|bearer|credential|password|private[\s_-]*key|secret|seed|signing[\s_-]*key)\b\s*[:=]/i;

const RedactedContextEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("redacted_text"),
      field: RedactedTextFieldSchema,
      value: z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .refine(
          (value) => !EXPLICIT_CREDENTIAL_MARKER.test(value),
          "Credential-labelled text is not accepted",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("metric"),
      field: RedactedMetricFieldSchema,
      value: z.number().finite().min(0).max(1_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("flag"),
      field: RedactedFlagFieldSchema,
      value: z.boolean(),
    })
    .strict(),
]);

export const RedactedProposalContextInputSchema = z
  .object({
    entries: z.array(RedactedContextEntrySchema).max(64),
  })
  .strict()
  .superRefine((context, refinement) => {
    const identities = context.entries.map(({ kind, field }) => `${kind}:${field}`);
    if (new Set(identities).size !== identities.length) {
      refinement.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Redacted context fields must not repeat",
      });
    }
  });

export type RedactedProposalContextInput = z.input<
  typeof RedactedProposalContextInputSchema
>;

declare const REDACTED_PROPOSAL_CONTEXT: unique symbol;
export type RedactedProposalContext = ProposalRequest["context"] &
  Readonly<{
    schema_version: typeof REDACTED_CONTEXT_SCHEMA_VERSION;
    entries: ReadonlyArray<z.output<typeof RedactedContextEntrySchema>>;
  }> & {
    readonly [REDACTED_PROPOSAL_CONTEXT]: true;
  };

const redactedProposalContexts = new WeakSet<object>();

const DisabledConfigSchema = z.object({ enabled: z.literal(false) }).strict();
const EnabledConfigSchema = z
  .object({
    enabled: z.literal(true),
    origin: z.string().url().max(2_048),
    profile: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .refine((value) => value !== "default", "A dedicated named profile is required"),
    profileBinding: z.string().regex(/^[0-9a-f]{64}$/),
    apiKey: z.string().min(16).max(512).regex(/^[^\r\n\0]+$/),
    model: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    timeoutMs: z.number().int().min(100).max(60_000).default(DEFAULT_TIMEOUT_MS),
    maxResponseBytes: z
      .number()
      .int()
      .min(1_024)
      .max(256 * 1024)
      .default(DEFAULT_MAX_RESPONSE_BYTES),
  })
  .strict();

export const HermesProposalConfigSchema = z.discriminatedUnion("enabled", [
  DisabledConfigSchema,
  EnabledConfigSchema,
]);

export type HermesProposalConfig = z.input<typeof HermesProposalConfigSchema>;

export const HermesServerScopeSchema = z
  .object({
    principalId: z.string().trim().min(1).max(256),
    tenantId: z.string().trim().min(1).max(256),
    channelId: z.string().trim().min(1).max(256),
  })
  .strict();

export type HermesServerScope = z.infer<typeof HermesServerScopeSchema>;
export type HermesFetch = typeof fetch;

export interface HermesProposalProvider extends ProposalProvider {
  /** Live zero-tool observation of the exact configured named profile. */
  attest(signal?: AbortSignal): Promise<void>;
}

const ToolsetRowSchema = z
  .object({
    name: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
    description: z.string().max(4_096),
    enabled: z.boolean(),
    configured: z.boolean(),
    tools: z
      .array(z.string().min(1).max(256))
      .max(1_000)
      .superRefine((tools, context) => {
        if (new Set(tools).size !== tools.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "tool names must be unique within a toolset",
          });
        }
      }),
  })
  .strict();

// Hermes v0.22.2 exposes the complete API-server toolset catalog in this
// envelope. Disabled rows still include their tool names as metadata, so the
// security assertion is the `enabled` flag rather than an empty catalog.
const ToolsetsSchema = z
  .object({
    object: z.literal("list"),
    platform: z.literal("api_server"),
    data: z.array(ToolsetRowSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((payload, context) => {
    const names = payload.data.map((toolset) => toolset.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: "toolset names must be unique",
      });
    }
  });

const CompletionUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().max(1_000_000),
    completion_tokens: z.number().int().nonnegative().max(1_000_000),
    total_tokens: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total_tokens"],
        message: "total_tokens must equal prompt_tokens plus completion_tokens",
      });
    }
  });

const ChatCompletionSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).passthrough(),
            finish_reason: z.literal("stop"),
          })
          .passthrough(),
      )
      .length(1),
    usage: CompletionUsageSchema.optional(),
  })
  .passthrough();

export type HermesCompletionUsage = Readonly<{
  requestId: string;
  profile: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

export type HermesProposalLeaseRequest = Readonly<{
  /** Opaque digest of the server-derived principal, tenant, channel and profile. */
  scopeDigest: string;
  /** Exact dedicated Hermes profile selected by the server. */
  profile: string;
  profileBinding: string;
  /** Trusted disclosure identifiers; neither value comes from the browser. */
  provider: string;
  model: string;
  requestId: string;
  /** Fresh explicit Hermes database session ID for this one proposal call. */
  sessionId: string;
  /** Exact bounded canonical user content; already validated and explicitly redacted. */
  userContent: string;
  /** Canonical digest of the fixed Pilot system message plus exact user content. */
  messageDigest: string;
  /** SHA-256 digest of the exact canonical user content. */
  payloadDigest: string;
}>;

export type HermesProposalLease = Readonly<{
  /** Single-use opaque model alias understood only by the bounded egress bridge. */
  leaseModel: string;
  scopeDigest: string;
  payloadDigest: string;
  messageDigest: string;
  profile: string;
  provider: string;
  model: string;
}>;

export type HermesProposalLeaseAuthority = Readonly<{
  /** Unforgeable process-local identity supplied by the concrete bounded bridge. */
  proof: object;
  issueLease(
    request: HermesProposalLeaseRequest,
    signal: AbortSignal,
  ): Promise<HermesProposalLease>;
}>;

export type HermesProposalProviderOptions = Readonly<{
  /** Trusted server-side disclosure identifier, never supplied by Hermes. */
  provider?: string;
  /** Receives aggregate counts only after the entire proposal is validated. */
  onUsage?: (usage: HermesCompletionUsage) => void | Promise<void>;
  /** Required by production composition; binds a one-call lease to this exact payload. */
  leaseAuthority?: HermesProposalLeaseAuthority;
  /**
   * Durable two-phase lifecycle for the fresh Hermes database session. The
   * preparation must finish before the POST; every attempted POST is settled
   * exactly once, including ambiguous failures.
   */
  sessionLifecycle?: Readonly<{
    prepare(session: Readonly<{
      requestId: string;
      profile: string;
      sessionId: string;
    }>, signal: AbortSignal): void | Promise<void>;
    settle(session: Readonly<{
      requestId: string;
      profile: string;
      sessionId: string;
      outcome: "created" | "uncertain";
    }>):
      | "active"
      | "pending_delete"
      | "uncertain"
      | Promise<"active" | "pending_delete" | "uncertain">;
  }>;
}>;

const ProviderIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const LeaseModelSchema = z
  .string()
  .regex(/^pilot-hermes-lease-[A-Za-z0-9_-]{43}$/);
const HermesSessionIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const leaseAuthorityByProvider = new WeakMap<object, object>();

/**
 * Confirms that an adapter was constructed with the exact bridge proof used by
 * its per-call lease hook. This prevents an unrelated valid gate proof from
 * being paired with an ungated or differently gated provider.
 */
export function isHermesProviderBoundToLeaseAuthority(
  provider: ProposalProvider,
  proof: object,
): boolean {
  return leaseAuthorityByProvider.get(provider as object) === proof;
}

class HermesResponseValidationError extends Error {}

export const HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS = [
  "Return exactly one JSON object matching the requested Pilot proposal schema.",
  "This is a read-only proposal surface. Do not execute actions or call tools.",
  "Never request, reveal, or reproduce credentials, signing material, shell commands, or tool calls.",
  "A procedure proposal is declarative review material only and cannot promote itself.",
].join(" ");

function invalidConfiguration(): Error {
  return new Error("Invalid Hermes proposal adapter configuration");
}

function validatedOrigin(rawOrigin: string): string {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw invalidConfiguration();
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw invalidConfiguration();
  }
  return url.origin;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestCanonicalHermesProposalPayload(value: unknown): string {
  return digest(stableJson(value));
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeJson(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the only context accepted by the Hermes transport.
 *
 * The fixed entry kinds and field names keep raw request objects, credentials,
 * wallet material, and Harbor payloads outside the transport contract. The
 * text check rejects common explicitly labelled credentials as defense in
 * depth; it is not a general secret detector and must not be treated as one.
 */
export function createRedactedProposalContext(
  input: RedactedProposalContextInput,
): RedactedProposalContext {
  const parsed = RedactedProposalContextInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid redacted Hermes proposal context");
  const context = freezeJson({
    schema_version: REDACTED_CONTEXT_SCHEMA_VERSION,
    entries: [...parsed.data.entries].sort((left, right) => {
      const identity = `${left.kind}:${left.field}:${stableJson(left.value)}`;
      const otherIdentity = `${right.kind}:${right.field}:${stableJson(right.value)}`;
      return compareOrdinal(identity, otherIdentity);
    }),
  }) as unknown as RedactedProposalContext;
  redactedProposalContexts.add(context);
  return context;
}

function isRedactedProposalContext(value: unknown): value is RedactedProposalContext {
  return value !== null && typeof value === "object" && redactedProposalContexts.has(value);
}

function containsExplicitCredentialMarker(value: unknown): boolean {
  if (typeof value === "string") return EXPLICIT_CREDENTIAL_MARKER.test(value);
  if (Array.isArray(value)) return value.some(containsExplicitCredentialMarker);
  return value !== null && typeof value === "object" &&
    Object.values(value as Record<string, unknown>).some(containsExplicitCredentialMarker);
}

export function deriveHermesProfileBinding(inputScope: HermesServerScope): string {
  const parsedScope = HermesServerScopeSchema.safeParse(inputScope);
  if (!parsedScope.success) throw new Error("Invalid server-derived Hermes scope");
  return digest(JSON.stringify(parsedScope.data));
}

function scopedHeaders(
  apiKey: string,
  sessionId?: string,
  idempotencyKey?: string,
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(sessionId ? { "X-Hermes-Session-Id": sessionId } : {}),
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  try {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new HermesResponseValidationError(
        "Hermes response exceeded the configured byte limit",
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new HermesResponseValidationError("Hermes response body is missing");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HermesResponseValidationError(
          "Hermes response exceeded the configured byte limit",
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HermesResponseValidationError("Hermes returned malformed JSON");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new HermesResponseValidationError("Hermes returned malformed JSON");
    }
  } catch (error) {
    if (error instanceof HermesResponseValidationError) throw error;
    throw new Error("Hermes response body read failed");
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (callerSignal?.aborted) throw new Error("Hermes request cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  callerSignal?.addEventListener("abort", cancel, { once: true });
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (callerSignal?.aborted) throw new Error("Hermes request cancelled");
    if (timedOut) throw new Error("Hermes request timed out");
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Hermes request cancelled");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

/**
 * Restricted adapter for Hermes' OpenAI-compatible API server.
 *
 * Hermes documents that frontend system prompts do not remove its core tools and
 * that the API server can expose terminal/file/MCP capabilities. This adapter
 * therefore attests the v0.22.2 /v1/toolsets envelope before every request and
 * requires every advertised toolset to be disabled, instead of treating prompt
 * text as a security boundary:
 * https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
 *
 * Named profile routes have profile-bound credentials, while memory homes are
 * profile-scoped. Pilot requires a dedicated named profile and supplies a fresh
 * explicit X-Hermes-Session-Id for every proposal so stored history or model
 * overrides cannot be reused across turns:
 * https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/
 */
export function createHermesProposalProvider(
  inputConfig: HermesProposalConfig,
  inputScope: HermesServerScope,
  transport: HermesFetch = globalThis.fetch,
  providerOptions: HermesProposalProviderOptions = {},
): HermesProposalProvider {
  const parsedConfig = HermesProposalConfigSchema.safeParse(inputConfig);
  if (!parsedConfig.success) throw invalidConfiguration();
  const config = parsedConfig.data;

  if (!config.enabled) {
    return {
      enabled: false,
      async attest() {
        throw new Error("Hermes proposal adapter is disabled");
      },
      async propose() {
        throw new Error("Hermes proposal adapter is disabled");
      },
    };
  }

  const parsedScope = HermesServerScopeSchema.safeParse(inputScope);
  if (!parsedScope.success) throw new Error("Invalid server-derived Hermes scope");
  if (config.profileBinding !== deriveHermesProfileBinding(parsedScope.data)) {
    throw new Error("Hermes profile binding does not match server authority");
  }
  const providerIdentifier = providerOptions.provider ?? "hermes";
  if (!ProviderIdentifierSchema.safeParse(providerIdentifier).success) {
    throw invalidConfiguration();
  }
  const origin = validatedOrigin(config.origin);
  const scopeIdentity = JSON.stringify({ profile: config.profile, ...parsedScope.data });
  const scopeDigest = digest(scopeIdentity);
  const profileBase = `${origin}/p/${encodeURIComponent(config.profile)}/v1`;

  const fetchJson = async (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Readonly<{ payload: unknown; sessionId: string | null }>> => {
    let response: Response;
    try {
      response = await transport(url, { ...init, redirect: "error", signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error("Hermes transport failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Hermes request failed with status ${response.status}`);
    }
    return {
      payload: await readBoundedJson(response, config.maxResponseBytes),
      sessionId: response.headers.get("x-hermes-session-id"),
    };
  };

  const attestNoTools = async (signal: AbortSignal): Promise<void> => {
    const { payload } = await fetchJson(
      `${profileBase}/toolsets`,
      { method: "GET", headers: scopedHeaders(config.apiKey) },
      signal,
    );
    const parsed = ToolsetsSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.some((toolset) => toolset.enabled)) {
      throw new Error("Hermes restricted profile tool attestation failed");
    }
  };

  const provider: HermesProposalProvider = {
    enabled: true,
    async attest(signal) {
      return withDeadline(config.timeoutMs, signal, attestNoTools);
    },
    async propose(
      inputRequest: ProposalRequest,
      options: ProposalCallOptions = {},
    ): Promise<ProposalResult> {
      if (!isRedactedProposalContext(inputRequest.context)) {
        throw new Error("Hermes proposal context must be explicitly redacted");
      }
      const parsedRequest = ProposalRequestSchema.safeParse(inputRequest);
      if (
        !parsedRequest.success ||
        EXPLICIT_CREDENTIAL_MARKER.test(inputRequest.prompt)
      ) {
        throw new Error("Invalid Hermes proposal request");
      }
      const request = parsedRequest.data;

      return withDeadline(config.timeoutMs, options.signal, async (signal) => {
        // A fresh opaque session prevents a prior Hermes turn or stored model
        // override from influencing this single proposal call.
        const sessionId = `pilot-${randomBytes(20).toString("hex")}`;
        await attestNoTools(signal);
        const requestIdentity = stableJson({
          purpose: request.purpose,
          prompt: request.prompt,
          context: request.context,
        });
        const idempotencyKey = `pilot-hermes:${digest(
          `${scopeDigest}:${request.requestId}:${digest(requestIdentity)}`,
        )}`;
        const userContent = JSON.stringify({
          purpose: request.purpose,
          prompt: request.prompt,
          context: request.context,
        });
        const messages = [
          { role: "system" as const, content: HERMES_PROPOSAL_SYSTEM_INSTRUCTIONS },
          {
            role: "user" as const,
            content: userContent,
          },
        ];
        const messageDigest = digestCanonicalHermesProposalPayload(messages);
        const payloadDigest = digest(userContent);
        let requestModel = config.model;
        if (providerOptions.leaseAuthority) {
          let lease: HermesProposalLease;
          try {
            lease = await providerOptions.leaseAuthority.issueLease(
              Object.freeze({
                scopeDigest,
                profile: config.profile,
                profileBinding: config.profileBinding,
                provider: providerIdentifier,
                model: config.model,
                requestId: request.requestId,
                sessionId,
                userContent,
                messageDigest,
                payloadDigest,
              }),
              signal,
            );
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            throw new Error("Hermes bounded lease authorization failed");
          }
          const parsedLease = LeaseModelSchema.safeParse(lease?.leaseModel);
          if (
            !parsedLease.success ||
            lease.scopeDigest !== scopeDigest ||
            lease.payloadDigest !== payloadDigest ||
            lease.messageDigest !== messageDigest ||
            lease.profile !== config.profile ||
            lease.provider !== providerIdentifier ||
            lease.model !== config.model
          ) {
            throw new Error("Hermes bounded lease authorization failed");
          }
          requestModel = parsedLease.data;
        }
        const lifecycleSession = Object.freeze({
          requestId: request.requestId,
          profile: config.profile,
          sessionId,
        });
        if (providerOptions.sessionLifecycle) {
          try {
            // Persist deletion intent before Hermes can create the session.
            await providerOptions.sessionLifecycle.prepare(lifecycleSession, signal);
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
          } catch (error) {
            if (
              signal.aborted ||
              (error instanceof Error && error.name === "AbortError")
            ) {
              throw new DOMException("aborted", "AbortError");
            }
            throw new Error("Hermes session preparation failed");
          }
        }
        let completion: z.infer<typeof ChatCompletionSchema> | undefined;
        let proposal: ProposalResult | undefined;
        let outcome: "created" | "uncertain" = "uncertain";
        let proposalFailure: unknown;
        try {
          const completionResponse = await fetchJson(
            `${profileBase}/chat/completions`,
            {
              method: "POST",
              headers: {
                ...scopedHeaders(config.apiKey, sessionId, idempotencyKey),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: requestModel,
                messages,
                stream: false,
                tools: [],
                tool_choice: "none",
              }),
            },
            signal,
          );
          if (
            !HermesSessionIdSchema.safeParse(completionResponse.sessionId).success ||
            completionResponse.sessionId !== sessionId
          ) {
            throw new Error("Hermes returned an invalid session identity");
          }
          const parsedCompletion = ChatCompletionSchema.safeParse(completionResponse.payload);
          if (!parsedCompletion.success) {
            throw new Error("Hermes returned an invalid completion");
          }
          completion = parsedCompletion.data;
          let candidate: unknown;
          try {
            candidate = JSON.parse(completion.choices[0]!.message.content);
          } catch {
            throw new Error("Hermes proposal content was not exact JSON");
          }
          const result = ProposalResultSchema.safeParse(candidate);
          if (!result.success) throw new Error("Hermes returned an invalid proposal schema");
          if (containsExplicitCredentialMarker(result.data)) {
            throw new Error("Hermes returned unsafe proposal text");
          }
          if (
            (request.purpose === "read" && result.data.kind !== "read_only") ||
            (request.purpose === "procedure_proposal" &&
              result.data.kind !== "procedure_proposal")
          ) {
            throw new Error("Hermes returned a proposal for the wrong purpose");
          }
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          proposal = result.data;
          outcome = "created";
        } catch (error) {
          proposalFailure = error;
        }
        if (providerOptions.sessionLifecycle) {
          try {
            const durableState = await providerOptions.sessionLifecycle.settle(Object.freeze({
              ...lifecycleSession,
              outcome,
            }));
            if (
              (outcome === "created" && durableState !== "active") ||
              (outcome === "uncertain" && durableState !== "uncertain")
            ) {
              throw new Error("Hermes session settlement was not durable");
            }
          } catch {
            throw new Error("Hermes session settlement failed");
          }
        }
        if (proposalFailure !== undefined) throw proposalFailure;
        if (!completion || !proposal) {
          throw new Error("Hermes returned an invalid proposal");
        }
        if (completion.usage && providerOptions.onUsage) {
          const usage = Object.freeze({
            requestId: request.requestId,
            profile: config.profile,
            provider: providerIdentifier,
            model: config.model,
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          });
          try {
            await providerOptions.onUsage(usage);
          } catch {
            throw new Error("Hermes usage observer failed");
          }
        }
        return proposal;
      });
    },
  };
  if (providerOptions.leaseAuthority) {
    if (
      typeof providerOptions.leaseAuthority.proof !== "object" ||
      providerOptions.leaseAuthority.proof === null ||
      !providerOptions.sessionLifecycle ||
      typeof providerOptions.sessionLifecycle.prepare !== "function" ||
      typeof providerOptions.sessionLifecycle.settle !== "function"
    ) {
      throw invalidConfiguration();
    }
    leaseAuthorityByProvider.set(provider as object, providerOptions.leaseAuthority.proof);
  }
  return provider;
}
