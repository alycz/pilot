import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import type { AgentCoreGatewayAuth } from "./gateway";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "invalid identifier");
const ClaimNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const AlgorithmSchema = z.enum(["RS256", "ES256"]);

export type AgentCoreJwtAlgorithm = z.infer<typeof AlgorithmSchema>;

export type AgentCoreJwtPolicy = Readonly<{
  issuer: string;
  /** Exact same-origin jwks_uri reviewed from the IdP discovery document. */
  jwksUrl: string;
  audiences: readonly string[];
  allowedSubjects: readonly string[];
  allowedClients: readonly string[];
  requiredScopes: readonly string[];
  clientClaim: "client_id" | "azp";
  tenantClaim: string;
  algorithms: readonly AgentCoreJwtAlgorithm[];
  clockToleranceSeconds?: number;
  maxTokenAgeSeconds?: number;
  maxTokenLifetimeSeconds?: number;
  cacheTtlMs?: number;
  jwksTimeoutMs?: number;
  maxTokenBytes?: number;
  maxJwksBytes?: number;
  maxJwksKeys?: number;
  jwksRefreshCooldownMs?: number;
}>;

export type AgentCoreVerifiedJwt = Readonly<{
  issuer: string;
  subject: string;
  audience: readonly string[];
  tenantId: string;
  keyId: string;
  algorithm: AgentCoreJwtAlgorithm;
  issuedAt: string;
  expiresAt: string;
}>;

/** Account-specific token acquisition remains an injected, server-only seam. */
export interface AgentCoreWorkloadJwtResolver {
  resolveAuthorization(
    request: Readonly<{
      tenantId: string;
      audiences: readonly string[];
      requiredScopes: readonly string[];
      workloadIdentityToken?: string;
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<string>;
}

export class AgentCoreJwtError extends Error {
  constructor(readonly code: "configuration" | "authorization" | "jwks_unavailable") {
    super(code === "jwks_unavailable"
      ? "AgentCore JWT verification keys are unavailable"
      : code === "configuration"
        ? "AgentCore JWT verification is not configured"
        : "AgentCore workload authorization is invalid");
    this.name = "AgentCoreJwtError";
  }
}

type NormalizedPolicy = Readonly<{
  issuer: string;
  jwksUrl: string;
  audiences: readonly string[];
  allowedSubjects: ReadonlySet<string>;
  allowedClients: ReadonlySet<string>;
  requiredScopes: readonly string[];
  clientClaim: "client_id" | "azp";
  tenantClaim: string;
  algorithms: ReadonlySet<AgentCoreJwtAlgorithm>;
  clockToleranceSeconds: number;
  maxTokenAgeSeconds: number;
  maxTokenLifetimeSeconds: number;
  cacheTtlMs: number;
  jwksTimeoutMs: number;
  maxTokenBytes: number;
  maxJwksBytes: number;
  maxJwksKeys: number;
  jwksRefreshCooldownMs: number;
}>;

type JsonRecord = Record<string, unknown>;
type CachedJwks = Readonly<{ expiresAt: number; keys: readonly JsonWebKey[] }>;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AgentCoreJwtError("configuration");
  }
  return result;
}

function exactHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentCoreJwtError("configuration");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
    isIP(url.hostname) !== 0
  ) {
    throw new AgentCoreJwtError("configuration");
  }
  return url.href;
}

function normalizePolicy(raw: AgentCoreJwtPolicy): NormalizedPolicy {
  const audiencesResult = z.array(IdentifierSchema).min(1).max(8).safeParse(raw.audiences);
  const subjectsResult = z.array(IdentifierSchema).min(1).max(64).safeParse(raw.allowedSubjects);
  const clientsResult = z.array(IdentifierSchema).min(1).max(16).safeParse(raw.allowedClients);
  const scopesResult = z.array(IdentifierSchema).min(1).max(16).safeParse(raw.requiredScopes);
  const algorithmsResult = z.array(AlgorithmSchema).min(1).max(2).safeParse(raw.algorithms);
  const clientClaimResult = z.enum(["client_id", "azp"]).safeParse(raw.clientClaim);
  const tenantClaimResult = ClaimNameSchema.safeParse(raw.tenantClaim);
  if (
    !audiencesResult.success || !subjectsResult.success || !clientsResult.success ||
    !scopesResult.success || !algorithmsResult.success || !clientClaimResult.success ||
    !tenantClaimResult.success
  ) {
    throw new AgentCoreJwtError("configuration");
  }
  const audiences = audiencesResult.data;
  const subjects = subjectsResult.data;
  const clients = clientsResult.data;
  const scopes = scopesResult.data;
  const algorithms = algorithmsResult.data;
  if (
    new Set(audiences).size !== audiences.length || new Set(subjects).size !== subjects.length ||
    new Set(clients).size !== clients.length || new Set(scopes).size !== scopes.length
  ) {
    throw new AgentCoreJwtError("configuration");
  }
  const issuer = exactHttpsUrl(raw.issuer);
  const jwksUrl = exactHttpsUrl(raw.jwksUrl);
  if (new URL(issuer).origin !== new URL(jwksUrl).origin) {
    throw new AgentCoreJwtError("configuration");
  }
  return {
    issuer,
    jwksUrl,
    audiences,
    allowedSubjects: new Set(subjects),
    allowedClients: new Set(clients),
    requiredScopes: scopes,
    clientClaim: clientClaimResult.data,
    tenantClaim: tenantClaimResult.data,
    algorithms: new Set(algorithms),
    clockToleranceSeconds: boundedInteger(raw.clockToleranceSeconds, 30, 0, 60),
    maxTokenAgeSeconds: boundedInteger(raw.maxTokenAgeSeconds, 300, 30, 3_600),
    maxTokenLifetimeSeconds: boundedInteger(raw.maxTokenLifetimeSeconds, 600, 30, 3_600),
    cacheTtlMs: boundedInteger(raw.cacheTtlMs, 300_000, 1_000, 900_000),
    jwksTimeoutMs: boundedInteger(raw.jwksTimeoutMs, 3_000, 100, 10_000),
    maxTokenBytes: boundedInteger(raw.maxTokenBytes, 16_384, 1_024, 65_536),
    maxJwksBytes: boundedInteger(raw.maxJwksBytes, 65_536, 1_024, 262_144),
    maxJwksKeys: boundedInteger(raw.maxJwksKeys, 16, 1, 64),
    jwksRefreshCooldownMs: boundedInteger(raw.jwksRefreshCooldownMs, 10_000, 1_000, 60_000),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new AgentCoreJwtError("authorization");
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || bytes.toString("base64url") !== segment) {
    throw new AgentCoreJwtError("authorization");
  }
  return bytes;
}

function parseJsonSegment(segment: string, maxBytes: number): JsonRecord {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(decodeSegment(segment, maxBytes)));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    if (error instanceof AgentCoreJwtError) throw error;
    throw new AgentCoreJwtError("authorization");
  }
}

function numericDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentCoreJwtError("authorization");
  }
  return value;
}

function audience(value: unknown): readonly string[] {
  const result = typeof value === "string" ? [value] : value;
  const parsed = z.array(IdentifierSchema).min(1).max(8).safeParse(result);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new AgentCoreJwtError("authorization");
  }
  return parsed.data;
}

function scopes(value: unknown): readonly string[] {
  const candidate = typeof value === "string"
    ? value.split(" ").filter(Boolean)
    : value;
  const parsed = z.array(IdentifierSchema).min(1).max(64).safeParse(candidate);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new AgentCoreJwtError("authorization");
  }
  return parsed.data;
}

function publicVerificationKey(
  jwk: JsonWebKey,
  algorithm: AgentCoreJwtAlgorithm,
): KeyObject {
  const raw = jwk as JsonRecord;
  if (
    raw.d !== undefined || raw.p !== undefined || raw.q !== undefined ||
    raw.dp !== undefined || raw.dq !== undefined || raw.qi !== undefined ||
    raw.oth !== undefined || raw.k !== undefined ||
    (raw.use !== undefined && raw.use !== "sig") ||
    (raw.alg !== undefined && raw.alg !== algorithm) ||
    (raw.key_ops !== undefined &&
      (!Array.isArray(raw.key_ops) || raw.key_ops.length !== 1 || raw.key_ops[0] !== "verify"))
  ) {
    throw new AgentCoreJwtError("authorization");
  }
  if (
    (algorithm === "RS256" && (raw.kty !== "RSA" || typeof raw.n !== "string" || typeof raw.e !== "string")) ||
    (algorithm === "ES256" &&
      (raw.kty !== "EC" || raw.crv !== "P-256" || typeof raw.x !== "string" || typeof raw.y !== "string"))
  ) {
    throw new AgentCoreJwtError("authorization");
  }
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (algorithm === "RS256" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) {
      throw new Error("weak key");
    }
    return key;
  } catch {
    throw new AgentCoreJwtError("authorization");
  }
}

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new AgentCoreJwtError("jwks_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((error: AgentCoreJwtError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(new AgentCoreJwtError("jwks_unavailable"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw new AgentCoreJwtError("jwks_unavailable");
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new AgentCoreJwtError("jwks_unavailable");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJwks(bytes: Uint8Array, maximum: number): readonly JsonWebKey[] {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > maximum) {
      throw new Error("invalid JWKS");
    }
    return value.keys.map((key) => {
      if (!isRecord(key) || typeof key.kid !== "string" || !IdentifierSchema.safeParse(key.kid).success) {
        throw new Error("invalid JWK");
      }
      return key as JsonWebKey;
    });
  } catch {
    throw new AgentCoreJwtError("jwks_unavailable");
  }
}

async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new AgentCoreJwtError("authorization");
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AgentCoreJwtError("authorization"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createAgentCoreJwtVerifier(
  rawPolicy: AgentCoreJwtPolicy,
  dependencies: Readonly<{ fetch?: typeof fetch; now?: () => number }> = {},
) {
  const policy = normalizePolicy(rawPolicy);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  let cache: CachedJwks | undefined;
  let pending: Promise<CachedJwks> | undefined;
  let lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

  const loadJwks = async (force: boolean, callerSignal?: AbortSignal): Promise<CachedJwks> => {
    const current = now();
    if (!force && cache && cache.expiresAt > current) return cache;
    if (!pending) {
      pending = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), policy.jwksTimeoutMs);
        try {
          const response = await fetcher(policy.jwksUrl, {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
            headers: { accept: "application/jwk-set+json, application/json" },
          });
          const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
          if (!response.ok || response.redirected || !["application/json", "application/jwk-set+json"].includes(mediaType ?? "")) {
            void response.body?.cancel().catch(() => undefined);
            throw new AgentCoreJwtError("jwks_unavailable");
          }
          const loaded = {
            keys: parseJwks(
              await readBoundedBody(response, policy.maxJwksBytes, controller.signal),
              policy.maxJwksKeys,
            ),
            expiresAt: now() + policy.cacheTtlMs,
          } satisfies CachedJwks;
          cache = loaded;
          return loaded;
        } catch {
          throw new AgentCoreJwtError("jwks_unavailable");
        } finally {
          clearTimeout(timer);
        }
      })().finally(() => {
        pending = undefined;
      });
    }
    return waitWithAbort(pending, callerSignal);
  };

  const findKey = async (
    kid: string,
    algorithm: AgentCoreJwtAlgorithm,
    signal?: AbortSignal,
  ): Promise<KeyObject> => {
    let jwks = await loadJwks(false, signal);
    let matches = jwks.keys.filter((key) => key.kid === kid && (key.alg === undefined || key.alg === algorithm));
    if (matches.length === 0 && now() - lastForcedRefreshAt >= policy.jwksRefreshCooldownMs) {
      lastForcedRefreshAt = now();
      jwks = await loadJwks(true, signal);
      matches = jwks.keys.filter((key) => key.kid === kid && (key.alg === undefined || key.alg === algorithm));
    }
    if (matches.length !== 1) throw new AgentCoreJwtError("authorization");
    return publicVerificationKey(matches[0]!, algorithm);
  };

  return Object.freeze({
    policy: Object.freeze({
      issuer: policy.issuer,
      audiences: policy.audiences,
      requiredScopes: policy.requiredScopes,
      tenantClaim: policy.tenantClaim,
    }),
    async verifyAuthorization(
      authorization: string,
      context: Readonly<{ tenantId: string; signal?: AbortSignal }>,
    ): Promise<AgentCoreVerifiedJwt> {
      const tenantResult = IdentifierSchema.safeParse(context.tenantId);
      if (!tenantResult.success) throw new AgentCoreJwtError("authorization");
      const tenantId = tenantResult.data;
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
      if (!match || Buffer.byteLength(match[1]!, "utf8") > policy.maxTokenBytes) {
        throw new AgentCoreJwtError("authorization");
      }
      const [encodedHeader, encodedPayload, encodedSignature] = match[1]!.split(".") as [string, string, string];
      const header = parseJsonSegment(encodedHeader, 4_096);
      if (
        typeof header.alg !== "string" || !AlgorithmSchema.safeParse(header.alg).success ||
        !policy.algorithms.has(header.alg as AgentCoreJwtAlgorithm) ||
        typeof header.kid !== "string" || !IdentifierSchema.safeParse(header.kid).success ||
        (header.typ !== "at+jwt" && header.typ !== "JWT") ||
        header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined ||
        header.jwk !== undefined
      ) {
        throw new AgentCoreJwtError("authorization");
      }
      const algorithm = header.alg as AgentCoreJwtAlgorithm;
      const key = await findKey(header.kid, algorithm, context.signal);
      const signature = decodeSegment(encodedSignature, 1_024);
      if (algorithm === "ES256" && signature.byteLength !== 64) {
        throw new AgentCoreJwtError("authorization");
      }
      const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
      const verified = algorithm === "RS256"
        ? verifySignature("RSA-SHA256", signed, key, signature)
        : verifySignature("SHA256", signed, { key, dsaEncoding: "ieee-p1363" }, signature);
      if (!verified) throw new AgentCoreJwtError("authorization");

      const claims = parseJsonSegment(encodedPayload, policy.maxTokenBytes);
      if (claims.iss !== policy.issuer || typeof claims.sub !== "string" || !policy.allowedSubjects.has(claims.sub)) {
        throw new AgentCoreJwtError("authorization");
      }
      const tokenAudience = audience(claims.aud);
      if (!policy.audiences.some((allowed) => tokenAudience.includes(allowed))) {
        throw new AgentCoreJwtError("authorization");
      }
      const client = claims[policy.clientClaim];
      if (typeof client !== "string" || !policy.allowedClients.has(client)) {
        throw new AgentCoreJwtError("authorization");
      }
      const tokenScopes = scopes(claims.scope);
      if (!policy.requiredScopes.every((required) => tokenScopes.includes(required))) {
        throw new AgentCoreJwtError("authorization");
      }
      if (claims[policy.tenantClaim] !== tenantId) throw new AgentCoreJwtError("authorization");

      const issuedAt = numericDate(claims.iat);
      const notBefore = numericDate(claims.nbf);
      const expiresAt = numericDate(claims.exp);
      const nowSeconds = Math.floor(now() / 1_000);
      const tolerance = policy.clockToleranceSeconds;
      if (
        issuedAt > nowSeconds + tolerance || notBefore > nowSeconds + tolerance ||
        expiresAt <= nowSeconds - tolerance || expiresAt <= issuedAt ||
        nowSeconds - issuedAt > policy.maxTokenAgeSeconds + tolerance ||
        expiresAt - issuedAt > policy.maxTokenLifetimeSeconds
      ) {
        throw new AgentCoreJwtError("authorization");
      }
      return Object.freeze({
        issuer: policy.issuer,
        subject: claims.sub,
        audience: Object.freeze([...tokenAudience]),
        tenantId,
        keyId: header.kid,
        algorithm,
        issuedAt: new Date(issuedAt * 1_000).toISOString(),
        expiresAt: new Date(expiresAt * 1_000).toISOString(),
      });
    },
  });
}

export function createVerifiedJwtGatewayAuth(input: Readonly<{
  resolver: AgentCoreWorkloadJwtResolver;
  verifier: ReturnType<typeof createAgentCoreJwtVerifier>;
  tenantId: string;
  workloadIdentityToken?: string;
}>): AgentCoreGatewayAuth {
  const tenantResult = IdentifierSchema.safeParse(input.tenantId);
  if (!tenantResult.success) throw new AgentCoreJwtError("configuration");
  const tenantId = tenantResult.data;
  return {
    async authorization(signal) {
      let authorization: string;
      try {
        authorization = await input.resolver.resolveAuthorization({
          tenantId,
          audiences: input.verifier.policy.audiences,
          requiredScopes: input.verifier.policy.requiredScopes,
          workloadIdentityToken: input.workloadIdentityToken,
        }, { signal });
      } catch {
        throw new AgentCoreJwtError("authorization");
      }
      await input.verifier.verifyAuthorization(authorization, { tenantId, signal });
      return authorization;
    },
  };
}
