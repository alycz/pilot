import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const LEASE_MODEL = /^pilot-lease-[A-Za-z0-9_-]{32,128}$/;
const MAX_LEASE_TTL_MS = 60_000;
const MAX_OUTSTANDING_LEASES = 1_024;
const MAX_USAGE_SCOPES = 1_024;
const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type HermesEgressTokenParameter = "max_tokens" | "max_completion_tokens";

export type HermesEgressGateConfig = Readonly<{
  ingressOrigin: string;
  ingressBearer: string;
  upstreamUrl: string;
  upstreamCredential: string;
  provider: string;
  model: string;
  tokenParameter: HermesEgressTokenParameter;
  outputTokens: number;
  maxInputBytes: number;
  maxMessages: number;
  maxResponseBytes: number;
  timeoutMs: number;
  framingTokenAllowance: number;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
  maxCallMicrousd: number;
}>;

export type HermesEgressMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type HermesEgressLeaseInput = Readonly<{
  scopeDigest: string;
  requestDigest: string;
  ttlMs?: number;
}>;

export type HermesEgressLease = Readonly<{
  model: string;
  expiresAt: number;
}>;

export type HermesEgressCaller = Readonly<{
  remoteAddress: string;
}>;

export type HermesEgressUsage = Readonly<{
  attempts: number;
  completed: number;
  uncertain: number;
  promptTokens: number;
  completionTokens: number;
  chargedMicrousd: number;
}>;

declare const HERMES_EGRESS_GATE_PROOF: unique symbol;
export type HermesEgressGateProof = Readonly<{
  readonly [HERMES_EGRESS_GATE_PROOF]: true;
}>;

const issuedGateProofs = new WeakSet<object>();

export function isHermesEgressGateProof(value: unknown): value is HermesEgressGateProof {
  return typeof value === "object" && value !== null && issuedGateProofs.has(value);
}

export type HermesEgressGate = Readonly<{
  proof: HermesEgressGateProof;
  issueLease(input: HermesEgressLeaseInput): HermesEgressLease;
  handle(request: Request, caller: HermesEgressCaller): Promise<Response>;
  usage(scopeDigest: string): HermesEgressUsage;
}>;

export class HermesEgressGateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(`Hermes egress gate rejected the request (${code})`);
    this.name = "HermesEgressGateError";
    this.code = code;
    this.status = status;
  }
}

type LeaseState = {
  scopeDigest: string;
  requestDigest: string;
  expiresAt: number;
  state: "armed" | "spent";
};

type MutableUsage = {
  attempts: number;
  completed: number;
  uncertain: number;
  promptTokens: number;
  completionTokens: number;
  chargedMicrousd: number;
  updatedAt: number;
};

type GateDependencies = Readonly<{
  fetch?: typeof fetch;
  now?: () => number;
  random?: (size: number) => Uint8Array;
}>;

type ParsedIngress = {
  model: string;
  messages: HermesEgressMessage[];
  byteLength: number;
};

type ParsedCompletion = {
  id?: string;
  created?: number;
  message: { role: "assistant"; content: string };
  finishReason: "stop";
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

function reject(code: string, status = 400): never {
  throw new HermesEgressGateError(code, status);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

/** Digest only the strict message list that the gate will send upstream. */
export function digestHermesEgressMessages(
  messages: readonly HermesEgressMessage[],
): string {
  return sha256(stableJson(messages));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum &&
    (value as number) <= maximum;
}

function configuredOrigin(raw: string, loopback: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("invalid_configuration", 500);
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (loopback ? !isLoopback || url.protocol !== "http:" : url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return reject("invalid_configuration", 500);
  }
  return url.origin;
}

function configuredUpstream(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("invalid_configuration", 500);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/chat/completions")
  ) {
    return reject("invalid_configuration", 500);
  }
  return url.toString();
}

function validateConfig(input: HermesEgressGateConfig): HermesEgressGateConfig & {
  ingressOrigin: string;
  upstreamUrl: string;
} {
  const ingressOrigin = configuredOrigin(input.ingressOrigin, true);
  const upstreamUrl = configuredUpstream(input.upstreamUrl);
  if (
    typeof input.ingressBearer !== "string" ||
    input.ingressBearer.length < 32 ||
    input.ingressBearer.length > 512 ||
    typeof input.upstreamCredential !== "string" ||
    input.upstreamCredential.length < 16 ||
    input.upstreamCredential.length > 512 ||
    /[\0\r\n]/.test(input.ingressBearer) ||
    /[\0\r\n]/.test(input.upstreamCredential) ||
    !SAFE_IDENTIFIER.test(input.provider) ||
    input.provider.length > 64 ||
    !SAFE_IDENTIFIER.test(input.model) ||
    input.model.length > 128 ||
    (input.tokenParameter !== "max_tokens" &&
      input.tokenParameter !== "max_completion_tokens") ||
    !safeInteger(input.outputTokens, 1, 2_048) ||
    !safeInteger(input.maxInputBytes, 512, 128 * 1024) ||
    !safeInteger(input.maxMessages, 1, 32) ||
    !safeInteger(input.maxResponseBytes, 512, 256 * 1024) ||
    !safeInteger(input.timeoutMs, 100, 60_000) ||
    !safeInteger(input.framingTokenAllowance, 1, 4_096) ||
    !safeInteger(input.inputMicrousdPerMillionTokens, 1, 1_000_000_000) ||
    !safeInteger(input.outputMicrousdPerMillionTokens, 1, 1_000_000_000) ||
    !safeInteger(input.maxCallMicrousd, 1, 1_000_000_000)
  ) {
    return reject("invalid_configuration", 500);
  }
  return { ...input, ingressOrigin, upstreamUrl };
}

function parseAuthorization(header: string | null, expected: string): void {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    reject("unauthorized", 401);
  }
}

function assertLoopback(address: string): void {
  if (
    address !== "127.0.0.1" &&
    address !== "::1" &&
    address !== "::ffff:127.0.0.1"
  ) {
    reject("non_loopback_ingress", 403);
  }
}

async function readBoundedBody(request: Request, maximum: number): Promise<{
  value: unknown;
  byteLength: number;
}> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    reject("request_too_large", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) reject("missing_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      reject("request_too_large", 413);
    }
    chunks.push(next.value);
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
    return reject("invalid_json");
  }
  try {
    return { value: JSON.parse(text), byteLength: total };
  } catch {
    return reject("invalid_json");
  }
}

function parseIngress(value: unknown, byteLength: number, maxMessages: number): ParsedIngress {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid_request");
  const body = value as Record<string, unknown>;
  const allowed = ["messages", "model", "stream", "tool_choice", "tools"] as const;
  if (Object.keys(body).some((key) => !allowed.includes(key as typeof allowed[number]))) {
    reject("unsupported_request_field");
  }
  if (typeof body.model !== "string" || !LEASE_MODEL.test(body.model)) {
    reject("invalid_lease");
  }
  if (body.stream !== false) reject("streaming_not_allowed");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) {
    reject("tools_not_allowed");
  }
  if (body.tool_choice !== undefined && body.tool_choice !== "none") {
    reject("tools_not_allowed");
  }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > maxMessages) {
    reject("invalid_messages");
  }
  const messages = body.messages.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return reject("invalid_messages");
    }
    const message = candidate as Record<string, unknown>;
    if (!exactKeys(message, ["content", "role"])) reject("invalid_messages");
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      reject("invalid_messages");
    }
    if (
      typeof message.content !== "string" ||
      message.content.length < 1 ||
      message.content.length > 32_000 ||
      /\0/.test(message.content)
    ) {
      reject("invalid_messages");
    }
    return { role: message.role, content: message.content } as HermesEgressMessage;
  });
  return { model: body.model, messages, byteLength };
}

function ceilMicrousd(tokens: number, pricePerMillion: number): number {
  return Math.ceil((tokens * pricePerMillion) / 1_000_000);
}

function costCeiling(
  config: HermesEgressGateConfig,
  requestBytes: number,
): { inputTokenCeiling: number; costMicrousd: number } {
  // One UTF-8 byte per token is deliberately conservative and framing covers
  // provider wrappers that are not represented in the JSON request body.
  const inputTokenCeiling = requestBytes + config.framingTokenAllowance;
  const costMicrousd = ceilMicrousd(
    inputTokenCeiling,
    config.inputMicrousdPerMillionTokens,
  ) + ceilMicrousd(config.outputTokens, config.outputMicrousdPerMillionTokens);
  if (!Number.isSafeInteger(costMicrousd) || costMicrousd > config.maxCallMicrousd) {
    reject("cost_ceiling_exceeded", 402);
  }
  return { inputTokenCeiling, costMicrousd };
}

async function readBoundedResponse(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    reject("response_too_large", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) reject("invalid_upstream_response", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      reject("response_too_large", 502);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return reject("invalid_upstream_response", 502);
  }
}

function parseCompletion(
  value: unknown,
  inputTokenCeiling: number,
  outputTokenCeiling: number,
): ParsedCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("invalid_upstream_response", 502);
  }
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.choices) || body.choices.length !== 1) {
    reject("invalid_upstream_response", 502);
  }
  const choice = body.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    reject("invalid_upstream_response", 502);
  }
  const choiceRecord = choice as Record<string, unknown>;
  if (choiceRecord.finish_reason !== "stop") reject("incomplete_upstream_response", 502);
  const message = choiceRecord.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    reject("invalid_upstream_response", 502);
  }
  const messageRecord = message as Record<string, unknown>;
  if (
    messageRecord.role !== "assistant" ||
    typeof messageRecord.content !== "string" ||
    messageRecord.content.length < 1 ||
    messageRecord.content.length > 32_000 ||
    Object.hasOwn(messageRecord, "tool_calls") ||
    Object.hasOwn(messageRecord, "function_call")
  ) {
    reject("invalid_upstream_response", 502);
  }
  const usage = body.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    reject("invalid_upstream_usage", 502);
  }
  const usageRecord = usage as Record<string, unknown>;
  const promptTokens = usageRecord.prompt_tokens;
  const completionTokens = usageRecord.completion_tokens;
  const totalTokens = usageRecord.total_tokens;
  if (
    !safeInteger(promptTokens, 0, inputTokenCeiling) ||
    !safeInteger(completionTokens, 0, outputTokenCeiling) ||
    !safeInteger(totalTokens, 0, inputTokenCeiling + outputTokenCeiling) ||
    totalTokens !== promptTokens + completionTokens
  ) {
    reject("invalid_upstream_usage", 502);
  }
  return {
    ...(typeof body.id === "string" && body.id.length <= 256 ? { id: body.id } : {}),
    ...(safeInteger(body.created, 0, Number.MAX_SAFE_INTEGER) ? { created: body.created } : {}),
    message: { role: "assistant", content: messageRecord.content },
    finishReason: "stop",
    usage: { promptTokens, completionTokens, totalTokens },
  };
}

function responseJson(completion: ParsedCompletion, model: string): Response {
  return Response.json({
    ...(completion.id ? { id: completion.id } : {}),
    object: "chat.completion",
    ...(completion.created !== undefined ? { created: completion.created } : {}),
    model,
    choices: [{
      index: 0,
      message: completion.message,
      finish_reason: completion.finishReason,
    }],
    usage: {
      prompt_tokens: completion.usage.promptTokens,
      completion_tokens: completion.usage.completionTokens,
      total_tokens: completion.usage.totalTokens,
    },
  }, { headers: { "cache-control": "no-store", "content-type": "application/json" } });
}

export function createHermesEgressGate(
  inputConfig: HermesEgressGateConfig,
  dependencies: GateDependencies = {},
): HermesEgressGate {
  const config = validateConfig(inputConfig);
  const requestFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? randomBytes;
  const leases = new Map<string, LeaseState>();
  const usageByScope = new Map<string, MutableUsage>();
  const proof = Object.freeze({}) as HermesEgressGateProof;
  issuedGateProofs.add(proof);

  const usage = (scopeDigest: string): HermesEgressUsage => {
    if (!SHA256_HEX.test(scopeDigest)) reject("invalid_scope");
    const current = usageByScope.get(scopeDigest);
    return Object.freeze(current
      ? {
          attempts: current.attempts,
          completed: current.completed,
          uncertain: current.uncertain,
          promptTokens: current.promptTokens,
          completionTokens: current.completionTokens,
          chargedMicrousd: current.chargedMicrousd,
        }
      : {
          attempts: 0,
          completed: 0,
          uncertain: 0,
          promptTokens: 0,
          completionTokens: 0,
          chargedMicrousd: 0,
        });
  };

  return Object.freeze({
    proof,
    issueLease(input: HermesEgressLeaseInput): HermesEgressLease {
      if (!SHA256_HEX.test(input.scopeDigest) || !SHA256_HEX.test(input.requestDigest)) {
        reject("invalid_lease_binding");
      }
      const ttlMs = input.ttlMs ?? 30_000;
      if (!safeInteger(ttlMs, 1, MAX_LEASE_TTL_MS)) reject("invalid_lease_ttl");
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) reject("invalid_clock", 500);
      for (const [model, lease] of leases) {
        if (lease.state === "spent" || lease.expiresAt <= issuedAt) leases.delete(model);
      }
      if (leases.size >= MAX_OUTSTANDING_LEASES) reject("lease_capacity_reached", 503);
      let token: string;
      do {
        token = `pilot-lease-${Buffer.from(random(32)).toString("base64url")}`;
      } while (leases.has(token));
      const expiresAt = issuedAt + ttlMs;
      leases.set(token, {
        scopeDigest: input.scopeDigest,
        requestDigest: input.requestDigest,
        expiresAt,
        state: "armed",
      });
      return Object.freeze({ model: token, expiresAt });
    },

    async handle(request: Request, caller: HermesEgressCaller): Promise<Response> {
      assertLoopback(caller.remoteAddress);
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url);
      } catch {
        return reject("invalid_ingress", 403);
      }
      if (
        requestUrl.origin !== config.ingressOrigin ||
        requestUrl.pathname !== "/v1/chat/completions" ||
        requestUrl.search !== "" ||
        requestUrl.hash !== "" ||
        request.method !== "POST"
      ) {
        reject("invalid_ingress", 403);
      }
      parseAuthorization(request.headers.get("authorization"), config.ingressBearer);
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") reject("invalid_content_type", 415);

      const bounded = await readBoundedBody(request, config.maxInputBytes);
      const parsed = parseIngress(bounded.value, bounded.byteLength, config.maxMessages);
      const lease = leases.get(parsed.model);
      const currentTime = now();
      if (!lease || lease.state !== "armed") reject("invalid_or_spent_lease", 409);
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) reject("invalid_clock", 500);
      if (currentTime >= lease.expiresAt) {
        lease.state = "spent";
        reject("expired_lease", 409);
      }
      if (digestHermesEgressMessages(parsed.messages) !== lease.requestDigest) {
        reject("request_binding_mismatch", 403);
      }

      const ceiling = costCeiling(config, parsed.byteLength);
      // This synchronous transition is the concurrency boundary. No await may
      // occur between the final binding/cost checks and consuming the lease.
      lease.state = "spent";
      leases.delete(parsed.model);
      for (const [identity, existing] of usageByScope) {
        if (existing.updatedAt + USAGE_RETENTION_MS <= currentTime) {
          usageByScope.delete(identity);
        }
      }
      if (!usageByScope.has(lease.scopeDigest) && usageByScope.size >= MAX_USAGE_SCOPES) {
        reject("usage_capacity_reached", 503);
      }
      const aggregate = usageByScope.get(lease.scopeDigest) ?? {
        attempts: 0,
        completed: 0,
        uncertain: 0,
        promptTokens: 0,
        completionTokens: 0,
        chargedMicrousd: 0,
        updatedAt: currentTime,
      };
      aggregate.attempts += 1;
      aggregate.updatedAt = currentTime;
      usageByScope.set(lease.scopeDigest, aggregate);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      let response: Response;
      try {
        response = await requestFetch(config.upstreamUrl, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.upstreamCredential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            messages: parsed.messages,
            stream: false,
            [config.tokenParameter]: config.outputTokens,
          }),
        });
      } catch {
        aggregate.uncertain += 1;
        reject("upstream_outcome_uncertain", 502);
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        aggregate.uncertain += 1;
        reject("upstream_outcome_uncertain", 502);
      }
      let completion: ParsedCompletion;
      try {
        const raw = await readBoundedResponse(response, config.maxResponseBytes);
        completion = parseCompletion(raw, ceiling.inputTokenCeiling, config.outputTokens);
      } catch (error) {
        aggregate.uncertain += 1;
        throw error;
      }
      const chargedMicrousd = ceilMicrousd(
        completion.usage.promptTokens,
        config.inputMicrousdPerMillionTokens,
      ) + ceilMicrousd(
        completion.usage.completionTokens,
        config.outputMicrousdPerMillionTokens,
      );
      if (chargedMicrousd > config.maxCallMicrousd || chargedMicrousd > ceiling.costMicrousd) {
        aggregate.uncertain += 1;
        reject("upstream_cost_violation", 502);
      }
      aggregate.completed += 1;
      aggregate.promptTokens += completion.usage.promptTokens;
      aggregate.completionTokens += completion.usage.completionTokens;
      aggregate.chargedMicrousd += chargedMicrousd;
      return responseJson(completion, config.model);
    },

    usage,
  });
}
