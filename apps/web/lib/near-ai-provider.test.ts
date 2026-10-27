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

  it("propagates caller cancellation into catalog discovery before model construction", async () => {
    const abort = new AbortController();
    const createProvider = vi.fn(() => vi.fn(() => fakeModel));
    const discoverModels = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBe(abort.signal);
      throw signal?.reason;
    });
    abort.abort(new DOMException("cancelled", "AbortError"));

    await expect(createNearAiChatModel(
      config(),
      { createProvider, discoverModels },
      abort.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(createProvider).not.toHaveBeenCalled();
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

  it("preserves generate, stream, tool, and cancellation options on the provider model", async () => {
    const doGenerate = vi.fn(async (_options: unknown) => ({
      content: [{ type: "text", text: "generated" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }));
    const doStream = vi.fn(async (_options: unknown) => ({
      stream: new ReadableStream(),
      warnings: [],
    }));
    const dualModeModel = {
      specificationVersion: "v2",
      provider: "near-ai",
      modelId: "z-ai/example-model",
      supportedUrls: {},
      doGenerate,
      doStream,
    } as unknown as LanguageModel;
    const modelProvider = vi.fn(() => dualModeModel);
    const abort = new AbortController();
    const model = await createNearAiChatModel(config(), {
      createProvider: vi.fn(() => modelProvider),
      discoverModels: async () => [{
        id: "z-ai/example-model",
        supportedFeatures: ["tools"],
        supportedSamplingParameters: ["temperature"],
        ready: true,
      }],
    });
    const request = {
      prompt: [],
      tools: [{ type: "function", name: "harbor_search", inputSchema: {} }],
      abortSignal: abort.signal,
    };

    await (model as unknown as { doGenerate: (options: unknown) => Promise<unknown> })
      .doGenerate(request);
    await (model as unknown as { doStream: (options: unknown) => Promise<unknown> })
      .doStream(request);

    expect(doGenerate).toHaveBeenCalledWith(request);
    expect(doStream).toHaveBeenCalledWith(request);
    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({
      tools: [expect.objectContaining({ name: "harbor_search" })],
      abortSignal: abort.signal,
    });
  });
});
