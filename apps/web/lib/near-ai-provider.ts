import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import {
  discoverNearAiModels,
  verifyNearAiConfiguredChatModel,
  type NearAiCatalogModel,
  type NearAiServerConfig,
} from "./near-ai";

type EnabledNearAiConfig = Extract<NearAiServerConfig, { enabled: true }>;
type NearAiModelProvider = (modelId: string) => LanguageModel;
export type NearAiProviderFactory = (
  options: OpenAICompatibleProviderSettings,
) => NearAiModelProvider;

export type NearAiProviderDependencies = Readonly<{
  createProvider?: NearAiProviderFactory;
  discoverModels?: () => Promise<readonly NearAiCatalogModel[]>;
}>;

/**
 * Resolve the configured NEAR AI chat model only after the public catalog says
 * it is ready and supports native tools. This creates a model object; it does
 * not make a completion request.
 */
export async function createNearAiChatModel(
  config: EnabledNearAiConfig,
  dependencies: NearAiProviderDependencies = {},
): Promise<LanguageModel> {
  const models = await (dependencies.discoverModels ?? (() => discoverNearAiModels()))();
  verifyNearAiConfiguredChatModel(config, models);
  const createProvider = dependencies.createProvider ?? createOpenAICompatible;
  const provider = createProvider({
    name: "near-ai",
    baseURL: config.apiBase,
    apiKey: config.apiKey,
    includeUsage: true,
  });
  return provider(config.model);
}
