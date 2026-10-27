import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import { readNearAiServerConfig } from "./near-ai";
import { createNearAiChatModel } from "./near-ai-provider";

const fakeModel = { specificationVersion: "v2" } as unknown as LanguageModel;

function config() {
  const value = readNearAiServerConfig({
    NEAR_AI_ENABLED: "1",
    NEAR_AI_API_KEY: "server-only-near-ai-key",
    NEAR_AI_MODEL: "z-ai/example-model",
    NEAR_AI_PRIVACY_TIER: "confidential-tee",
  });
  if (!value.enabled) throw new Error("expected enabled NEAR AI configuration");
  return value;
}

describe("createNearAiChatModel", () => {
  it("uses the fixed OpenAI-compatible gateway only after catalog verification", async () => {
    const modelProvider = vi.fn(() => fakeModel);
    const createProvider = vi.fn(() => modelProvider);
    const discoverModels = vi.fn(async () => [{
      id: "z-ai/example-model",
      supportedFeatures: ["tools"],
      supportedSamplingParameters: ["temperature"],
      ready: true,
    }]);

    await expect(createNearAiChatModel(config(), {
      createProvider,
      discoverModels,
    })).resolves.toBe(fakeModel);

    expect(createProvider).toHaveBeenCalledWith({
      name: "near-ai",
      baseURL: "https://cloud-api.near.ai/v1",
      apiKey: "server-only-near-ai-key",
      includeUsage: true,
    });
    expect(modelProvider).toHaveBeenCalledWith("z-ai/example-model");
  });

  it.each([
    [false, ["tools"]],
    [true, ["structured_outputs"]],
  ])("fails closed when ready=%s features=%j", async (ready, supportedFeatures) => {
    const createProvider = vi.fn(() => vi.fn(() => fakeModel));
    await expect(createNearAiChatModel(config(), {
      createProvider,
      discoverModels: async () => [{
        id: "z-ai/example-model",
        supportedFeatures,
        supportedSamplingParameters: [],
        ready,
      }],
    })).rejects.toThrow(ready ? "native tool support" : "not ready");
    expect(createProvider).not.toHaveBeenCalled();
  });
});
