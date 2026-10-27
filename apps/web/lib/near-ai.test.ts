import { describe, expect, it, vi } from "vitest";

import {
  discoverNearAiModels,
  nearAiOpenAiCompatibleOptions,
  nearAiPublicDescriptor,
  readNearAiServerConfig,
  verifyNearAiConfiguredChatModel,
  verifyNearAiConfiguredModel,
} from "./near-ai";

const enabled = {
  NEAR_AI_ENABLED: "1",
  NEAR_AI_API_KEY: "server-only-near-ai-key",
  NEAR_AI_MODEL: "z-ai/example-model",
  NEAR_AI_PRIVACY_TIER: "confidential-tee",
} as const;

describe("NEAR AI provider configuration", () => {
  it("defaults off", () => {
    expect(readNearAiServerConfig({})).toEqual({ enabled: false });
  });

  it("pins the official gateway and strips credentials from public provenance", () => {
    const config = readNearAiServerConfig(enabled);
    if (!config.enabled) throw new Error("expected enabled configuration");
    expect(nearAiOpenAiCompatibleOptions(config)).toEqual({
      baseURL: "https://cloud-api.near.ai/v1",
      apiKey: "server-only-near-ai-key",
    });
    const publicDescriptor = nearAiPublicDescriptor(config);
    expect(publicDescriptor).not.toHaveProperty("apiKey");
    expect(JSON.stringify(publicDescriptor)).not.toContain("server-only-near-ai-key");
    expect(publicDescriptor.privacy).toMatchObject({
      tier: "confidential-tee",
      declaredBy: "operator-configuration",
      attestationVerified: false,
    });
  });

  it("describes Incognito without extending TEE claims to the upstream model", () => {
    const config = readNearAiServerConfig({ ...enabled, NEAR_AI_PRIVACY_TIER: "incognito" });
    if (!config.enabled) throw new Error("expected enabled configuration");
    expect(config.privacy.summary).toContain("upstream model runs outside that TEE");
  });

  it.each([
    [{ ...enabled, NEAR_AI_ENABLED: "true" }, "NEAR_AI_ENABLED"],
    [{ ...enabled, NEAR_AI_BASE_URL: "https://example.com/v1" }, "NEAR_AI_BASE_URL"],
    [{ ...enabled, NEAR_AI_MODEL: "bad model" }, "NEAR_AI_MODEL"],
    [{ ...enabled, NEAR_AI_PRIVACY_TIER: "tee" }, "NEAR_AI_PRIVACY_TIER"],
  ])("fails closed for invalid configuration %#", (environment, expected) => {
    expect(() => readNearAiServerConfig(environment)).toThrow(expected);
  });
});

describe("NEAR AI model discovery", () => {
  it("uses the public models endpoint and preserves capability metadata", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: "z-ai/example-model",
        supported_features: ["tools", "structured_outputs"],
        supported_sampling_parameters: ["temperature"],
        is_ready: true,
      }],
    }))) as typeof globalThis.fetch;
    const models = await discoverNearAiModels({ fetch });
    expect(fetch).toHaveBeenCalledWith("https://cloud-api.near.ai/v1/models", expect.objectContaining({
      method: "GET",
      headers: { accept: "application/json" },
    }));
    expect(models).toEqual([{
      id: "z-ai/example-model",
      supportedFeatures: ["tools", "structured_outputs"],
      supportedSamplingParameters: ["temperature"],
      ready: true,
    }]);
    const config = readNearAiServerConfig(enabled);
    if (!config.enabled) throw new Error("expected enabled configuration");
    expect(verifyNearAiConfiguredModel(config, models).id).toBe("z-ai/example-model");
    expect(verifyNearAiConfiguredChatModel(config, models).id).toBe("z-ai/example-model");
  });

  it("rejects unavailable configured models and bounded-response failures", async () => {
    const config = readNearAiServerConfig(enabled);
    if (!config.enabled) throw new Error("expected enabled configuration");
    expect(() => verifyNearAiConfiguredModel(config, [{
      id: config.model,
      supportedFeatures: [],
      supportedSamplingParameters: [],
      ready: false,
    }])).toThrow("not ready");
    expect(() => verifyNearAiConfiguredChatModel(config, [{
      id: config.model,
      supportedFeatures: ["structured_outputs"],
      supportedSamplingParameters: [],
      ready: true,
    }])).toThrow("native tool support");
    await expect(discoverNearAiModels({
      maxResponseBytes: 1_024,
      fetch: vi.fn(async () => new Response("x".repeat(1_025), {
        headers: { "content-length": "1025" },
      })) as typeof globalThis.fetch,
    })).rejects.toThrow("too large");
  });
});

