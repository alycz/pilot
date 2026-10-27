import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { TrustModel } from "@pilot/contracts";

import {
  requireDemoModel,
  type ModelAccess,
} from "../model-access";

import { readPilotAwsConfig, type PilotAwsConfig } from "./config";
import { DEMO_OPENROUTER_MODEL_SETTINGS } from "../openrouter-free-policy";
import {
  createNearAiChatModel,
  type NearAiProviderDependencies,
} from "../near-ai-provider";
import { NearAiUnavailableError } from "../near-ai";
import type { OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";

type ModelProvider = (
  modelId: string,
  settings?: OpenRouterChatSettings,
) => LanguageModel;
type OpenRouterFactory = (options: { apiKey: string }) => ModelProvider;
type AmazonBedrockFactory = (options: {
  apiKey: string;
  region: string;
}) => ModelProvider;

export type ModelTrust = TrustModel;

export type ResolvedChatModel = {
  model: LanguageModel;
  trust: ModelTrust;
};

export type BedrockModelDependencies = {
  config?: PilotAwsConfig;
  env?: Readonly<Record<string, string | undefined>>;
  createOpenRouter?: OpenRouterFactory;
  createAmazonBedrock?: AmazonBedrockFactory;
  nearAi?: NearAiProviderDependencies;
  signal?: AbortSignal;
};

export function modelTrustForAccess(
  access: ModelAccess,
  config?: PilotAwsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelTrust {
  if (access.provider === "openrouter") {
    return { provider: "openrouter", id: access.model };
  }
  if (access.provider === "near-ai") {
    return {
      provider: "near-ai",
      id: access.model,
      privacy: access.privacy,
    };
  }
  const bedrockConfig = config ?? readPilotAwsConfig(env);
  if (bedrockConfig.bedrockMode === "off") {
    throw new Error("AWS Bedrock model access is disabled");
  }
  if (bedrockConfig.bedrockMode === "mock") {
    return {
      provider: "bedrock-mock",
      id: requireDemoModel(nonEmpty("MODEL_DEFAULT", env.MODEL_DEFAULT)),
    };
  }
  return { provider: "bedrock", id: access.model };
}

async function loadAmazonBedrockFactory(): Promise<AmazonBedrockFactory> {
  // Keep the optional provider out of the mock path. The package is loaded only
  // for explicit AWS mode, never while local/offline checks use the stand-in.
  const provider = (await import("@ai-sdk/amazon-bedrock")) as {
    createAmazonBedrock?: AmazonBedrockFactory;
  };
  if (typeof provider.createAmazonBedrock !== "function") {
    throw new Error("The Amazon Bedrock model provider is unavailable");
  }
  return provider.createAmazonBedrock;
}

function nonEmpty(name: string, value: string | undefined): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is not configured`);
  return result;
}

/**
 * Creates the server-side model and the receipt metadata describing the model
 * that actually handled the turn. No credential is returned in that metadata.
 */
export async function resolveChatModel(
  access: ModelAccess,
  dependencies: BedrockModelDependencies = {},
): Promise<ResolvedChatModel> {
  const env = dependencies.env ?? process.env;

  if (access.provider === "openrouter") {
    const factory = dependencies.createOpenRouter ?? createOpenRouter;
    const provider = factory({ apiKey: access.apiKey });
    return {
      model: access.mode === "demo"
        ? provider(access.model, DEMO_OPENROUTER_MODEL_SETTINGS as OpenRouterChatSettings)
        : provider(access.model),
      trust: modelTrustForAccess(access, dependencies.config, env),
    };
  }

  if (access.provider === "near-ai") {
    const config = {
      enabled: true,
      provider: "near-ai",
      apiBase: access.apiBase,
      apiKey: access.apiKey,
      model: access.model,
      privacy: access.privacy,
    } as const;
    try {
      return {
        model: await createNearAiChatModel(config, dependencies.nearAi, dependencies.signal),
        trust: modelTrustForAccess(access, dependencies.config, env),
      };
    } catch (error) {
      if (dependencies.signal?.aborted) throw error;
      throw new NearAiUnavailableError();
    }
  }

  const config = dependencies.config ?? readPilotAwsConfig(env);

  if (config.bedrockMode === "off") {
    throw new Error("AWS Bedrock model access is disabled");
  }

  if (config.bedrockMode === "mock") {
    const modelId = requireDemoModel(nonEmpty("MODEL_DEFAULT", env.MODEL_DEFAULT));
    const apiKey = nonEmpty(
      "OpenRouter OAuth credential",
      access.apiKey,
    );
    const factory = dependencies.createOpenRouter ?? createOpenRouter;
    return {
      model: factory({ apiKey })(
        modelId,
        DEMO_OPENROUTER_MODEL_SETTINGS as OpenRouterChatSettings,
      ),
      trust: modelTrustForAccess(access, config, env),
    };
  }

  const apiKey = nonEmpty(
    "AWS_BEARER_TOKEN_BEDROCK",
    env.AWS_BEARER_TOKEN_BEDROCK,
  );
  const factory =
    dependencies.createAmazonBedrock ?? (await loadAmazonBedrockFactory());
  return {
    model: factory({ apiKey, region: config.region })(access.model),
    trust: modelTrustForAccess(access, config, env),
  };
}
