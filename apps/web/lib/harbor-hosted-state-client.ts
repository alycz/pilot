import { isIP } from "node:net";

import { z } from "zod";

export const HOSTED_STATE_WALLET_PROOF_PATH = "/internal/pilot-state/v1/wallet-proofs/consume";
export const HOSTED_STATE_PERSONALIZATION_READ_PATH = "/internal/pilot-state/v1/personalization/read";
export const HOSTED_STATE_PERSONALIZATION_CAS_PATH = "/internal/pilot-state/v1/personalization/compare-and-swap";
export const HOSTED_STATE_PERSONALIZATION_DELETE_PATH = "/internal/pilot-state/v1/personalization/delete";
export const HOSTED_STATE_RESEARCH_QUOTA_PATH = "/internal/pilot-state/v1/research/quota/reservations";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1_410_000;
const MAX_REQUEST_BYTES = 1_410_000;
const MAX_PERSONALIZATION_CIPHERTEXT_CHARS = 1_398_358;

const LOWER_HEX_64 = /^[a-f0-9]{64}$/;
const NAMED_CREDENTIAL = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-Za-z0-9_-]{32,128})$/;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ScopeIdSchema = z.string().regex(LOWER_HEX_64);
const DigestSchema = z.string().regex(LOWER_HEX_64);
const WalletProofConsumeRequestSchema = z.object({
  version: z.literal(1),
  namespace: z.enum(["chat", "wallet-auth", "near-wallet-auth"]),
  scopeId: ScopeIdSchema,
  nonceDigest: DigestSchema,
  expiresAtMs: z.number().int().safe().positive(),
}).strict();
const WalletProofConsumeResponseSchema = z.object({ consumed: z.boolean() }).strict();
const PersonalizationReadRequestSchema = z.object({
  version: z.literal(1), scopeId: ScopeIdSchema,
  resource: z.enum(["preferences", "workflow-lessons"]),
}).strict();
const PersonalizationReadResponseSchema = z.object({
  ciphertext: z.string().min(1).max(MAX_PERSONALIZATION_CIPHERTEXT_CHARS).nullable(),
  contentDigest: DigestSchema.nullable(),
}).strict().refine((value) => (value.ciphertext === null) === (value.contentDigest === null));
const PersonalizationCompareAndSwapRequestSchema = z.object({
  version: z.literal(1), scopeId: ScopeIdSchema,
  resource: z.enum(["preferences", "workflow-lessons"]),
  expectedDigest: DigestSchema.nullable(), contentDigest: DigestSchema,
  ciphertext: z.string().min(1).max(MAX_PERSONALIZATION_CIPHERTEXT_CHARS),
}).strict();
const PersonalizationCompareAndSwapResponseSchema = z.object({ swapped: z.boolean() }).strict();
const PersonalizationDeleteRequestSchema = z.object({
  version: z.literal(1), scopeId: ScopeIdSchema,
  resource: z.enum(["preferences", "workflow-lessons"]),
  expectedDigest: DigestSchema,
}).strict();
const PersonalizationDeleteResponseSchema = z.object({ deleted: z.boolean() }).strict();
const ResearchQuotaReserveRequestSchema = z.object({
  version: z.literal(1), requestId: z.string().uuid(),
  accountScopeId: ScopeIdSchema, sessionScopeId: ScopeIdSchema,
  network: z.enum(["testnet", "devnet"]),
  sessionExpiresAtMs: z.number().int().safe().positive(),
  policyVersion: z.string().regex(POLICY_VERSION),
  accountMaximum: z.number().int().min(1).max(24),
  sessionMaximum: z.number().int().min(1).max(12),
}).strict().refine((value) => value.sessionMaximum <= value.accountMaximum);
const ResearchQuotaReserveResponseSchema = z.object({
  reserved: z.literal(true), idempotent: z.boolean(),
  policyVersion: z.string().regex(POLICY_VERSION),
  windowExpiresAtMs: z.number().int().safe().positive(),
  remainingAccountRuns: z.number().int().nonnegative(),
  remainingSessionRuns: z.number().int().nonnegative(),
}).strict();
const RemoteErrorSchema = z.object({ error: z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  message: z.string().min(1).max(256),
  retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
}).strict() }).strict();

export type HostedStateEnvironment = Readonly<{
  HARBOR_API_KEY?: string; HARBOR_URL?: string; PILOT_DEPLOYMENT_PROFILE?: string;
  PILOT_HOSTED_STATE_API_KEY?: string;
}>;
export type WalletProofConsumeRequest = z.infer<typeof WalletProofConsumeRequestSchema>;
export type WalletProofConsumeResponse = z.infer<typeof WalletProofConsumeResponseSchema>;
export type PersonalizationReadRequest = z.infer<typeof PersonalizationReadRequestSchema>;
export type PersonalizationReadResponse = z.infer<typeof PersonalizationReadResponseSchema>;
export type PersonalizationCompareAndSwapRequest = z.infer<typeof PersonalizationCompareAndSwapRequestSchema>;
export type PersonalizationCompareAndSwapResponse = z.infer<typeof PersonalizationCompareAndSwapResponseSchema>;
export type PersonalizationDeleteRequest = z.infer<typeof PersonalizationDeleteRequestSchema>;
export type PersonalizationDeleteResponse = z.infer<typeof PersonalizationDeleteResponseSchema>;
export type ResearchQuotaReserveRequest = z.infer<typeof ResearchQuotaReserveRequestSchema>;
export type ResearchQuotaReserveResponse = z.infer<typeof ResearchQuotaReserveResponseSchema>;

export class HarborHostedStateClientError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super("Hosted Pilot state is unavailable.");
    this.name = "HarborHostedStateClientError";
  }
}
export type HostedStateClientDependencies = Readonly<{ fetch?: typeof fetch; timeoutMs?: number }>;
function unavailable(): never { throw new HarborHostedStateClientError("HOSTED_STATE_UNAVAILABLE", 503); }
function transportUncertain(): never {
  throw new HarborHostedStateClientError("HOSTED_STATE_TRANSPORT_UNCERTAIN", 503);
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}
function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return isIP(normalized) === 6 && normalized === "::1";
}
function resolveBaseUrl(environment: HostedStateEnvironment): URL {
  const raw = environment.HARBOR_URL?.trim();
  if (!raw || raw !== environment.HARBOR_URL) return unavailable();
  let url: URL;
  try { url = new URL(raw); } catch { return unavailable(); }
  const loopback = isLoopback(normalizedHostname(url));
  if ((raw !== url.origin && raw !== `${url.origin}/`) || url.pathname !== "/" ||
    url.username || url.password || url.search || url.hash ||
    (environment.PILOT_DEPLOYMENT_PROFILE === "hosted"
      ? url.protocol !== "https:" || loopback
      : url.protocol !== "http:" || !loopback)) return unavailable();
  return new URL(url.origin);
}
function resolveCredential(environment: HostedStateEnvironment): string {
  const key = environment.PILOT_HOSTED_STATE_API_KEY;
  const dedicated = key?.match(NAMED_CREDENTIAL);
  if (!key || key !== key.trim() || !dedicated) return unavailable();
  if (environment.HARBOR_API_KEY !== undefined) {
    const broadKey = environment.HARBOR_API_KEY;
    const broad = broadKey.match(NAMED_CREDENTIAL);
    if (
      broadKey !== broadKey.trim() || !broad ||
      broad[1] === dedicated[1] || broad[2] === dedicated[2]
    ) return unavailable();
  }
  return key;
}
export function isHarborHostedStateConfigured(environment: HostedStateEnvironment = process.env): boolean {
  try { resolveBaseUrl(environment); resolveCredential(environment); return true; } catch { return false; }
}

function exactEndpoint(baseUrl: URL, path: string): URL {
  const target = new URL(path, baseUrl);
  if (target.origin !== baseUrl.origin || target.pathname !== path || target.search || target.hash) {
    return unavailable();
  }
  return target;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return unavailable();
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    return unavailable();
  }
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return unavailable();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { return unavailable(); }
}

function remoteError(payload: unknown, status: number): never {
  const parsed = RemoteErrorSchema.safeParse(payload);
  if (!parsed.success) return unavailable();
  throw new HarborHostedStateClientError(
    parsed.data.error.code, status, parsed.data.error.retryAfterSeconds,
  );
}

export class HarborHostedStateClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
    dependencies: HostedStateClientDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      unavailable();
    }
  }

  private async request<T>(
    path: string,
    input: unknown,
    requestSchema: z.ZodType<unknown>,
    responseSchema: z.ZodType<T>,
  ): Promise<T> {
    const parsedInput = requestSchema.safeParse(input);
    if (!parsedInput.success) return unavailable();
    const body = JSON.stringify(parsedInput.data);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return unavailable();
    const endpoint = exactEndpoint(this.baseUrl, path);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json" },
        body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { return transportUncertain(); }
    if (response.redirected || (response.url && response.url !== endpoint.toString())) {
      return unavailable();
    }
    const payload = await boundedJson(response);
    if (!response.ok) return remoteError(payload, response.status);
    const parsedResponse = responseSchema.safeParse(payload);
    if (!parsedResponse.success) return unavailable();
    return parsedResponse.data;
  }

  consumeWalletProof(input: WalletProofConsumeRequest): Promise<WalletProofConsumeResponse> {
    return this.request(HOSTED_STATE_WALLET_PROOF_PATH, input,
      WalletProofConsumeRequestSchema, WalletProofConsumeResponseSchema);
  }

  readPersonalization(input: PersonalizationReadRequest): Promise<PersonalizationReadResponse> {
    return this.request(HOSTED_STATE_PERSONALIZATION_READ_PATH, input,
      PersonalizationReadRequestSchema, PersonalizationReadResponseSchema);
  }

  compareAndSwapPersonalization(input: PersonalizationCompareAndSwapRequest):
    Promise<PersonalizationCompareAndSwapResponse> {
    return this.request(HOSTED_STATE_PERSONALIZATION_CAS_PATH, input,
      PersonalizationCompareAndSwapRequestSchema, PersonalizationCompareAndSwapResponseSchema);
  }

  deletePersonalization(input: PersonalizationDeleteRequest): Promise<PersonalizationDeleteResponse> {
    return this.request(HOSTED_STATE_PERSONALIZATION_DELETE_PATH, input,
      PersonalizationDeleteRequestSchema, PersonalizationDeleteResponseSchema);
  }

  async reserveResearchQuota(input: ResearchQuotaReserveRequest): Promise<ResearchQuotaReserveResponse> {
    const parsed = ResearchQuotaReserveRequestSchema.safeParse(input);
    if (!parsed.success) return unavailable();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.request(HOSTED_STATE_RESEARCH_QUOTA_PATH, parsed.data,
          ResearchQuotaReserveRequestSchema, ResearchQuotaReserveResponseSchema);
      } catch (error) {
        if (attempt === 0 && error instanceof HarborHostedStateClientError &&
          error.code === "HOSTED_STATE_TRANSPORT_UNCERTAIN") continue;
        throw error;
      }
    }
    return unavailable();
  }
}

export function createHarborHostedStateClientFromEnv(
  environment: HostedStateEnvironment = process.env,
  dependencies: HostedStateClientDependencies = {},
): HarborHostedStateClient {
  return new HarborHostedStateClient(resolveBaseUrl(environment), resolveCredential(environment), dependencies);
}
