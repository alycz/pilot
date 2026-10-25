import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve, sep } from "node:path";

import type { AgentCoreRuntimeJwtResolver } from "./runtime";

type Env = Readonly<Record<string, string | undefined>>;

export interface AgentCoreSecretProvider {
  resolveSecret(
    reference: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<string>;
}

export type AgentCoreRuntimeOAuthConfig = Readonly<{
  tokenUrl: string;
  clientId: string;
  clientSecretReference: string;
  tenantId: string;
  audiences: readonly string[];
  scopes: readonly string[];
  timeoutMs: number;
  maxResponseBytes: number;
}>;

const SECRET_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATIC_SECRET_ENV = Object.freeze([
  "AGENTCORE_RUNTIME_OAUTH_CLIENT_SECRET",
  "AGENTCORE_RUNTIME_OAUTH_ACCESS_TOKEN",
  "AGENTCORE_RUNTIME_OAUTH_REFRESH_TOKEN",
]);

function required(env: Env, name: string, maximum = 2_048): string {
  const value = env[name];
  if (
    value === undefined || value.length < 1 || value.length > maximum || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is required and must be bounded`);
  }
  return value;
}

function exactList(env: Env, name: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(required(env, name, 8_192)) as unknown;
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
  if (
    !Array.isArray(value) || value.length < 1 || value.length > 8 ||
    value.some((entry) =>
      typeof entry !== "string" || entry.length < 1 || entry.length > 256 ||
      entry.trim() !== entry || /[\u0000-\u001f\u007f\s]/.test(entry)
    ) || new Set(value).size !== value.length
  ) {
    throw new Error(`${name} must contain unique bounded values`);
  }
  return Object.freeze([...value] as string[]);
}

function integer(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function exactPublicHttpsUrl(raw: string, name: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${name} must be an exact public HTTPS URL`);
  }
  if (
    value.protocol !== "https:" || value.username || value.password || value.search || value.hash ||
    value.hostname === "localhost" || value.hostname.endsWith(".localhost") || isIP(value.hostname) !== 0
  ) {
    throw new Error(`${name} must be an exact public HTTPS URL`);
  }
  return value.href;
}

export function readAgentCoreRuntimeOAuthConfig(env: Env = process.env): AgentCoreRuntimeOAuthConfig {
  const forbidden = STATIC_SECRET_ENV.find((name) => env[name] !== undefined);
  if (forbidden) throw new Error(`${forbidden} is unsupported; use a server-only secret provider`);
  if (required(env, "AGENTCORE_RUNTIME_OAUTH_GRANT_TYPE", 32) !== "client_credentials") {
    throw new Error("AGENTCORE_RUNTIME_OAUTH_GRANT_TYPE must be client_credentials");
  }
  if ((env.AGENTCORE_RUNTIME_OAUTH_TOKEN_AUTH_METHOD?.trim() || "client_secret_basic") !== "client_secret_basic") {
    throw new Error("AGENTCORE_RUNTIME_OAUTH_TOKEN_AUTH_METHOD must be client_secret_basic");
  }
  const reference = required(env, "AGENTCORE_RUNTIME_OAUTH_CLIENT_SECRET_REF", 128);
  if (!SECRET_REFERENCE.test(reference)) {
    throw new Error("AGENTCORE_RUNTIME_OAUTH_CLIENT_SECRET_REF must be a logical secret name");
  }
  if (required(env, "AGENTCORE_RUNTIME_JWT_CLIENT_CLAIM", 16) !== "client_id") {
    throw new Error("AgentCore Runtime OAuth requires the client_id JWT claim");
  }
  const clientId = required(env, "AGENTCORE_RUNTIME_OAUTH_CLIENT_ID", 256);
  const allowedClients = exactList(env, "AGENTCORE_RUNTIME_JWT_ALLOWED_CLIENTS_JSON");
  if (allowedClients.length !== 1 || allowedClients[0] !== clientId) {
    throw new Error("AgentCore Runtime OAuth client must equal the one allowed JWT client_id");
  }
  return Object.freeze({
    tokenUrl: exactPublicHttpsUrl(
      required(env, "AGENTCORE_RUNTIME_OAUTH_TOKEN_URL"),
      "AGENTCORE_RUNTIME_OAUTH_TOKEN_URL",
    ),
    clientId,
    clientSecretReference: reference,
    tenantId: required(env, "AGENTCORE_RUNTIME_JWT_TENANT_ID", 256),
    audiences: exactList(env, "AGENTCORE_RUNTIME_JWT_AUDIENCES_JSON"),
    scopes: exactList(env, "AGENTCORE_RUNTIME_JWT_REQUIRED_SCOPES_JSON"),
    timeoutMs: integer(env, "AGENTCORE_RUNTIME_OAUTH_TIMEOUT_MS", 10_000, 100, 30_000),
    maxResponseBytes: integer(env, "AGENTCORE_RUNTIME_OAUTH_MAX_RESPONSE_BYTES", 65_536, 1_024, 131_072),
  });
}

function exactValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("operation aborted");
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void work.catch(() => undefined);
  }
}

async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" || !response.body) throw new Error("invalid token response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("token request aborted");
      const { done, value } = await beforeAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("token response exceeded the byte limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort cleanup */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function authorization(value: unknown, expectedScopes: readonly string[]): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid token response");
  const record = value as Record<string, unknown>;
  if (
    record.token_type !== "Bearer" || typeof record.access_token !== "string" ||
    record.access_token.length < 1 || record.access_token.length > 131_072 || /\s/.test(record.access_token) ||
    record.refresh_token !== undefined || record.id_token !== undefined
  ) {
    throw new Error("invalid token response");
  }
  if (record.scope !== undefined) {
    if (typeof record.scope !== "string") throw new Error("invalid token response");
    const scopes = record.scope.split(" ").filter(Boolean);
    if (!exactValues(scopes, expectedScopes)) throw new Error("invalid token response");
  }
  return `Bearer ${record.access_token}`;
}

function formEncodedComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

/**
 * Resolve one short-lived OAuth access token per Runtime call. This implements
 * only the standards-based client_credentials + client_secret_basic contract.
 * Provider-specific audience/resource extensions are deliberately unsupported;
 * the returned JWT is independently verified by the Runtime adapter.
 */
export function createAgentCoreRuntimeOAuthJwtResolver(
  config: AgentCoreRuntimeOAuthConfig,
  dependencies: Readonly<{
    secretProvider: AgentCoreSecretProvider;
    fetch?: typeof fetch;
  }>,
): AgentCoreRuntimeJwtResolver {
  const transport = dependencies.fetch ?? globalThis.fetch;
  return Object.freeze({
    async resolveAuthorization(
      request: Parameters<AgentCoreRuntimeJwtResolver["resolveAuthorization"]>[0],
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) {
      if (
        request.tenantId !== config.tenantId ||
        !exactValues(request.audiences, config.audiences) ||
        !exactValues(request.requiredScopes, config.scopes)
      ) {
        throw new Error("AgentCore Runtime OAuth scope binding failed");
      }
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(config.timeoutMs)])
        : AbortSignal.timeout(config.timeoutMs);
      let secret = "";
      try {
        secret = await beforeAbort(
          dependencies.secretProvider.resolveSecret(config.clientSecretReference, { signal }),
          signal,
        );
        if (secret.length < 1 || secret.length > 8_192 || /[\r\n\u0000]/.test(secret)) {
          throw new Error("AgentCore Runtime OAuth secret is unavailable");
        }
        const body = new URLSearchParams({
          grant_type: "client_credentials",
          scope: config.scopes.join(" "),
        });
        const basic = Buffer.from(
          `${formEncodedComponent(config.clientId)}:${formEncodedComponent(secret)}`,
          "utf8",
        )
          .toString("base64");
        const response = await beforeAbort(transport(config.tokenUrl, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/json",
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        }), signal);
        if (!response.ok || response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("AgentCore Runtime OAuth token request was rejected");
        }
        return authorization(await boundedJson(response, config.maxResponseBytes, signal), config.scopes);
      } catch {
        throw new Error("AgentCore Runtime OAuth authorization is unavailable");
      } finally {
        secret = "";
      }
    },
  });
}

export function createAgentCoreRuntimeOAuthJwtResolverFromEnv(input: Readonly<{
  env?: Env;
  secretProvider: AgentCoreSecretProvider;
  fetch?: typeof fetch;
}>): AgentCoreRuntimeJwtResolver {
  return createAgentCoreRuntimeOAuthJwtResolver(readAgentCoreRuntimeOAuthConfig(input.env), {
    secretProvider: input.secretProvider,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

/** Read a named secret from a read-only mount without accepting a path from callers. */
export function createMountedFileAgentCoreSecretProvider(input: Readonly<{
  root: string;
}>): AgentCoreSecretProvider {
  const root = resolve(input.root);
  if (!root.startsWith(`${sep}run${sep}secrets${sep}`) && root !== `${sep}run${sep}secrets`) {
    throw new Error("AgentCore secret mount root must be under /run/secrets");
  }
  return Object.freeze({
    async resolveSecret(
      reference: string,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) {
      if (!SECRET_REFERENCE.test(reference) || options.signal?.aborted) {
        throw new Error("AgentCore secret reference is invalid");
      }
      const canonicalRoot = await realpath(root);
      if (
        !canonicalRoot.startsWith(`${sep}run${sep}secrets${sep}`) &&
        canonicalRoot !== `${sep}run${sep}secrets`
      ) {
        throw new Error("AgentCore secret mount escaped /run/secrets");
      }
      const path = join(canonicalRoot, reference);
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > 8_192 || (stat.mode & 0o022) !== 0) {
          throw new Error("AgentCore secret file is invalid");
        }
        const canonicalPath = await realpath(path);
        if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
          throw new Error("AgentCore secret path escaped its mount");
        }
        const value = await handle.readFile({ encoding: "utf8", signal: options.signal });
        const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
        if (normalized.trim() !== normalized || normalized.length < 1 || /[\r\n\u0000]/.test(normalized)) {
          throw new Error("AgentCore secret file is invalid");
        }
        return normalized;
      } finally {
        await handle.close();
      }
    },
  });
}
