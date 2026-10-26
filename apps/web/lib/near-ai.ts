const NEAR_AI_GATEWAY = "https://cloud-api.near.ai/v1" as const;

export const NEAR_AI_PRIVACY_TIERS = [
  "confidential-tee",
  "third-party-confidential-tee",
  "incognito",
] as const;

export type NearAiPrivacyTier = (typeof NEAR_AI_PRIVACY_TIERS)[number];
export type NearAiPrivacyDisclosure = Readonly<{
  tier: NearAiPrivacyTier;
  declaredBy: "operator-configuration";
  attestationVerified: false;
  summary: string;
}>;

export type NearAiServerConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      provider: "near-ai";
      apiBase: typeof NEAR_AI_GATEWAY;
      apiKey: string;
      model: string;
      privacy: NearAiPrivacyDisclosure;
    }>;

export type NearAiPublicDescriptor = Readonly<{
  enabled: boolean;
  provider: "near-ai";
  apiBase: typeof NEAR_AI_GATEWAY;
  model?: string;
  privacy?: NearAiPrivacyDisclosure;
}>;

export type NearAiCatalogModel = Readonly<{
  id: string;
  supportedFeatures: readonly string[];
  supportedSamplingParameters: readonly string[];
  ready: boolean;
}>;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof globalThis.fetch;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,199}$/;

function configuredValue(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${name} is required when NEAR AI is enabled`);
  }
  return value;
}

function privacySummary(tier: NearAiPrivacyTier): string {
  switch (tier) {
    case "confidential-tee":
      return "Inference is declared to use NEAR AI's own TEE fleet; runtime attestation is not verified by this adapter.";
    case "third-party-confidential-tee":
      return "Inference is declared to use a third-party TEE; provider-specific attestation is not verified by this adapter.";
    case "incognito":
      return "The NEAR AI gateway runs in a TEE, but the upstream model runs outside that TEE on the provider's infrastructure.";
  }
}

function privacyDisclosure(value: string): NearAiPrivacyDisclosure {
  if (!(NEAR_AI_PRIVACY_TIERS as readonly string[]).includes(value)) {
    throw new Error("NEAR_AI_PRIVACY_TIER must be confidential-tee, third-party-confidential-tee, or incognito");
  }
  const tier = value as NearAiPrivacyTier;
  return Object.freeze({
    tier,
    declaredBy: "operator-configuration",
    attestationVerified: false,
    summary: privacySummary(tier),
  });
}

/** Resolve server-only OpenAI-compatible settings. No provider request occurs. */
export function readNearAiServerConfig(environment: Environment = process.env): NearAiServerConfig {
  const enabled = environment.NEAR_AI_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "0") {
    return Object.freeze({ enabled: false });
  }
  if (enabled !== "1") throw new Error("NEAR_AI_ENABLED must be exactly 0 or 1");
  const configuredBase = environment.NEAR_AI_BASE_URL?.trim();
  if (configuredBase && configuredBase !== NEAR_AI_GATEWAY) {
    throw new Error(`NEAR_AI_BASE_URL must be exactly ${NEAR_AI_GATEWAY}`);
  }
  const apiKey = configuredValue(environment, "NEAR_AI_API_KEY");
  if (apiKey.length > 4_096) throw new Error("NEAR_AI_API_KEY is too long");
  const model = configuredValue(environment, "NEAR_AI_MODEL");
  if (!MODEL_ID.test(model)) throw new Error("NEAR_AI_MODEL is invalid");
  return Object.freeze({
    enabled: true,
    provider: "near-ai",
    apiBase: NEAR_AI_GATEWAY,
    apiKey,
    model,
    privacy: privacyDisclosure(configuredValue(environment, "NEAR_AI_PRIVACY_TIER")),
  });
}

/** Strip the server credential before returning provider provenance to a UI. */
export function nearAiPublicDescriptor(config: NearAiServerConfig): NearAiPublicDescriptor {
  if (!config.enabled) {
    return Object.freeze({ enabled: false, provider: "near-ai", apiBase: NEAR_AI_GATEWAY });
  }
  return Object.freeze({
    enabled: true,
    provider: config.provider,
    apiBase: config.apiBase,
    model: config.model,
    privacy: config.privacy,
  });
}

export function nearAiOpenAiCompatibleOptions(
  config: Extract<NearAiServerConfig, { enabled: true }>,
): Readonly<{ baseURL: typeof NEAR_AI_GATEWAY; apiKey: string }> {
  return Object.freeze({ baseURL: config.apiBase, apiKey: config.apiKey });
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("NEAR AI catalog response is too large");
  if (!response.body) throw new Error("NEAR AI catalog returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("NEAR AI catalog response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("NEAR AI catalog returned invalid JSON");
  }
}

/** Discover current model ids and capabilities from the public official catalog. */
export async function discoverNearAiModels(options: Readonly<{
  fetch?: Fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}> = {}): Promise<readonly NearAiCatalogModel[]> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("NEAR AI catalog timeout is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 4_194_304) {
    throw new Error("NEAR AI catalog response limit is invalid");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetch ?? globalThis.fetch)(`${NEAR_AI_GATEWAY}/models`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`NEAR AI catalog request failed with HTTP ${response.status}`);
  const payload = await boundedJson(response, maxBytes);
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data)) throw new Error("NEAR AI catalog response is invalid");
  const models: NearAiCatalogModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !MODEL_ID.test(record.id)) continue;
    if (!Array.isArray(record.supported_features) || !record.supported_features.every((item) => typeof item === "string")) continue;
    if (!Array.isArray(record.supported_sampling_parameters) || !record.supported_sampling_parameters.every((item) => typeof item === "string")) continue;
    if (typeof record.is_ready !== "boolean") continue;
    models.push(Object.freeze({
      id: record.id,
      supportedFeatures: Object.freeze([...record.supported_features] as string[]),
      supportedSamplingParameters: Object.freeze([...record.supported_sampling_parameters] as string[]),
      ready: record.is_ready,
    }));
  }
  return Object.freeze(models);
}

/** Require the configured model to be a current ready catalog entry. */
export function verifyNearAiConfiguredModel(
  config: Extract<NearAiServerConfig, { enabled: true }>,
  models: readonly NearAiCatalogModel[],
): NearAiCatalogModel {
  const model = models.find((candidate) => candidate.id === config.model);
  if (!model || !model.ready) throw new Error("The configured NEAR AI model is not ready in the current catalog");
  return model;
}

