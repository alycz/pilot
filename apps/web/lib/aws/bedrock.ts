import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import {
  requireDemoModel,
  type ModelAccess,
} from "../model-access";

import { readPilotAwsConfig, type PilotAwsConfig } from "./config";
import { DEMO_OPENROUTER_MODEL_SETTINGS } from "../openrouter-free-policy";
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

export type ModelTrust = {
  provider: "bedrock" | "bedrock-mock" | "openrouter";
  id: string;
};

export type ResolvedChatModel = {
  model: LanguageModel;
  trust: ModelTrust;
};

export type BedrockModelDependencies = {
  config?: PilotAwsConfig;
  env?: Readonly<Record<string, string | undefined>>;
  createOpenRouter?: OpenRouterFactory;
  createAmazonBedrock?: AmazonBedrockFactory;
};

export function modelTrustForAccess(
  access: ModelAccess,
  config: PilotAwsConfig = readPilotAwsConfig(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelTrust {
  if (access.provider === "openrouter") {
    return { provider: "openrouter", id: access.model };
  }
  if (config.bedrockMode === "off") {
    throw new Error("AWS Bedrock model access is disabled");
  }
  if (config.bedrockMode === "mock") {
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
  const config = dependencies.config ?? readPilotAwsConfig(env);

  if (access.provider === "openrouter") {
    const factory = dependencies.createOpenRouter ?? createOpenRouter;
    const provider = factory({ apiKey: access.apiKey });
    return {
      model: access.mode === "demo"
        ? provider(access.model, DEMO_OPENROUTER_MODEL_SETTINGS as OpenRouterChatSettings)
        : provider(access.model),
      trust: modelTrustForAccess(access, config, env),
    };
  }

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
