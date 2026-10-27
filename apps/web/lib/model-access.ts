import {
  readWalletBoundOpenRouterSession,
  type OpenRouterSession,
  type WalletModelBinding,
} from "./openrouter-session";
import { readPilotAwsConfig } from "./aws/config";
import { readDemoModelConfig } from "./demo-model-budget";
import { readWalletSession } from "./wallet-session";
import { isExactZeroPriceCatalogModel } from "./openrouter-free-policy";
import {
  readNearAiServerConfig,
  type NearAiPrivacyDisclosure,
  type NearAiServerConfig,
} from "./near-ai";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export type ModelAccess =
  | {
      provider: "openrouter";
      apiKey: string;
      model: string;
      /** Present for production access; optional only for injected test providers. */
      mode?: "demo" | "oauth";
      wallet?: WalletModelBinding;
    }
  | {
      provider: "bedrock";
      model: string;
      mode?: "oauth";
      /** User OAuth credential used only by the explicit local Bedrock mock stand-in. */
      apiKey?: string;
      wallet?: WalletModelBinding;
    }
  | {
      provider: "near-ai";
      apiKey: string;
      apiBase: Extract<NearAiServerConfig, { enabled: true }>["apiBase"];
      model: string;
      mode: "oauth";
      privacy: NearAiPrivacyDisclosure;
      wallet: WalletModelBinding;
    };

export type PublicModel = {
  id: string;
  name: string;
  description?: string;
  provider?: "near-ai";
  privacy?: NearAiPrivacyDisclosure;
};

type OpenRouterModelRecord = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  supported_parameters?: unknown;
  pricing?: unknown;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const bedrockTurnBuckets = new Map<
  string,
  { count: number; resetAt: number }
>();

export class BedrockDailyTurnLimitError extends Error {
  readonly status = 429;

  constructor(readonly retryAfterSeconds: number) {
    super("AWS Bedrock daily turn cap exceeded");
    this.name = "BedrockDailyTurnLimitError";
  }
}

function takeBedrockTurn(
  wallet: WalletModelBinding,
  limit: number,
  now = Date.now(),
): void {
  // Account + network is the stable authenticated principal. API keys can be
  // rotated and wallet-session cookies can be renewed without resetting caps.
  const userKey = `${wallet.network}\0${wallet.account}`;
  const current = bedrockTurnBuckets.get(userKey);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + DAY_MS };
  bucket.count += 1;
  bedrockTurnBuckets.set(userKey, bucket);

  if (bucket.count > limit) {
    throw new BedrockDailyTurnLimitError(
      Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    );
  }
}

/** Test isolation only; production never resets authenticated wallet caps. */
export function resetBedrockTurnBucketsForTest(): void {
  bedrockTurnBuckets.clear();
}

export function getDefaultModel(): string {
  const model = process.env.MODEL_DEFAULT?.trim();
  if (!model) throw new Error("MODEL_DEFAULT is not configured");
  return requireValidModelId(model);
}

export function isFreeModel(model: string): boolean {
  return model.endsWith(":free");
}

export function requireValidModelId(value: unknown): string {
  if (typeof value !== "string") throw new Error("A model id is required");
  const model = value.trim();
  if (!MODEL_ID_PATTERN.test(model)) throw new Error("Invalid model id");
  return model;
}

export function requireDemoModel(value: unknown): string {
  const model = requireValidModelId(value);
  if (!isFreeModel(model)) {
    throw new Error("Demo mode only supports :free models");
  }
  return model;
}

function configuredIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => requireValidModelId(entry));
}

/** Exact account-model allowlist; arbitrary browser-supplied model ids never pass. */
export function accountModelAllowlist(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const nearAi = readNearAiServerConfig(environment);
  const models = new Set<string>([
    requireValidModelId(environment.MODEL_DEFAULT),
    ...configuredIds(environment.OPENROUTER_ALLOWED_MODELS),
    ...configuredIds(environment.BEDROCK_MODELS),
    ...(nearAi.enabled ? [requireValidModelId(nearAi.model)] : []),
  ]);
  return [...models];
}

export function requireAccountModel(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const model = requireValidModelId(value);
  if (!accountModelAllowlist(environment).includes(model)) {
    throw new Error("The selected account model is not in Pilot's server allowlist");
  }
  return model;
}

export function resolveSessionModel(session: OpenRouterSession | null): string {
  if (!session) throw new Error("A wallet-bound model session is required");
  if (session.mode === "demo") {
    const model = requireDemoModel(session.model);
    const config = readDemoModelConfig();
    if (!config || !config.allowedModels.includes(model)) {
      throw new Error("The selected demo model is not enabled");
    }
    return model;
  }
  return requireAccountModel(session.model);
}

/**
 * Server-only model credentials for the chat route. This function must never be
 * imported into a Client Component or serialized into a response.
 */
export function getModelAccess(request: Request): ModelAccess {
  const walletSession = readWalletSession(request);
  const session = readWalletBoundOpenRouterSession(request, walletSession);
  if (!session) throw new Error("A wallet-bound model session is required");
  const model = resolveSessionModel(session);

  if (session.mode === "oauth") {
    if (!session.apiKey) throw new Error("OpenRouter session is disconnected");

    const nearAi = readNearAiServerConfig();
    if (nearAi.enabled && nearAi.model === model) {
      return {
        provider: "near-ai",
        apiKey: nearAi.apiKey,
        apiBase: nearAi.apiBase,
        model,
        mode: "oauth",
        privacy: nearAi.privacy,
        wallet: session.wallet,
      };
    }

    const aws = readPilotAwsConfig();
    if (
      aws.bedrockMode !== "off" &&
      aws.bedrockModels.includes(model)
    ) {
      takeBedrockTurn(session.wallet, aws.bedrockDailyTurnCap);
      return {
        provider: "bedrock",
        model,
        mode: "oauth",
        ...(aws.bedrockMode === "mock" ? { apiKey: session.apiKey } : {}),
        wallet: session.wallet,
      };
    }

    return {
      provider: "openrouter",
      apiKey: session.apiKey,
      model,
      mode: "oauth",
      wallet: session.wallet,
    };
  }

  const apiKey = process.env.DEMO_OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("DEMO_OPENROUTER_API_KEY is not configured");
  return {
    provider: "openrouter",
    apiKey,
    model,
    mode: "demo",
    wallet: session.wallet,
  };
}

export function filterToolCallingModels(
  payload: unknown,
  mode: "demo" | "oauth",
  allowedModelIds: readonly string[] = mode === "demo"
    ? (readDemoModelConfig()?.allowedModels ?? [])
    : accountModelAllowlist(),
): PublicModel[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const models: PublicModel[] = [];
  for (const rawEntry of data) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as OpenRouterModelRecord;
    if (typeof entry.id !== "string" || !MODEL_ID_PATTERN.test(entry.id)) continue;
    if (
      !Array.isArray(entry.supported_parameters) ||
      !entry.supported_parameters.includes("tools")
    ) {
      continue;
    }
    if (mode === "demo" && !isExactZeroPriceCatalogModel(entry, entry.id)) continue;
    if (!allowedModelIds.includes(entry.id)) continue;

    models.push({
      id: entry.id,
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : entry.id,
      ...(typeof entry.description === "string" && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
    });
  }

  return models.sort((left, right) => left.name.localeCompare(right.name));
}

export function chooseDefaultModel(models: PublicModel[]): string {
  const configured = getDefaultModel();
  return models.some((model) => model.id === configured)
    ? configured
    : (models[0]?.id ?? configured);
}
