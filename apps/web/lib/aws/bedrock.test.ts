import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import { resolveChatModel } from "./bedrock";
import type { PilotAwsConfig } from "./config";

const fakeModel = { specificationVersion: "v2" } as unknown as LanguageModel;

function config(
  bedrockMode: PilotAwsConfig["bedrockMode"],
  region: PilotAwsConfig["region"] = "us-east-2",
): PilotAwsConfig {
  return {
    region,
    bedrockMode,
    bedrockModels: ["amazon.nova-lite-v1:0"],
    bedrockDailyTurnCap: 50,
  };
}

describe("resolveChatModel", () => {
  it("creates an OpenRouter model and records only non-secret trust metadata", async () => {
    const createOpenRouter = vi.fn(() => vi.fn(() => fakeModel));

    const resolved = await resolveChatModel(
      {
        provider: "openrouter",
        apiKey: "openrouter-test-secret",
        model: "openai/test:free",
      },
      { config: config("mock"), createOpenRouter },
    );

    expect(createOpenRouter).toHaveBeenCalledWith({
      apiKey: "openrouter-test-secret",
    });
    expect(resolved).toEqual({
      model: fakeModel,
      trust: { provider: "openrouter", id: "openai/test:free" },
    });
    expect(JSON.stringify(resolved.trust)).not.toContain("secret");
  });

  it("pins free-demo requests to zero-price routing with no plugin or model fallback", async () => {
    const modelProvider = vi.fn((_modelId: string, _settings?: unknown) => fakeModel);
    const createOpenRouter = vi.fn(() => modelProvider);

    await resolveChatModel(
      {
        provider: "openrouter",
        apiKey: "server-demo-secret",
        model: "openai/test:free",
        mode: "demo",
      },
      { config: config("off"), createOpenRouter },
    );

    expect(modelProvider).toHaveBeenCalledWith(
      "openai/test:free",
      expect.objectContaining({
        provider: expect.objectContaining({
          allow_fallbacks: false,
          require_parameters: true,
          max_price: { prompt: 0, completion: 0, image: 0, audio: 0, request: 0 },
        }),
        usage: { include: true },
      }),
    );
    const settings = modelProvider.mock.calls[0]![1] as Record<string, unknown>;
    expect(settings).not.toHaveProperty("models");
  });

  it("uses the existing free OpenRouter default for Bedrock mock mode", async () => {
    const createOpenRouter = vi.fn(() => vi.fn(() => fakeModel));

    const resolved = await resolveChatModel(
      {
        provider: "bedrock",
        model: "amazon.nova-lite-v1:0",
        mode: "oauth",
        apiKey: "oauth-test-secret",
      },
      {
        config: config("mock"),
        env: {
          MODEL_DEFAULT: "openai/test:free",
        },
        createOpenRouter,
      },
    );

    expect(createOpenRouter).toHaveBeenCalledWith({
      apiKey: "oauth-test-secret",
    });
    expect(resolved).toEqual({
      model: fakeModel,
      trust: { provider: "bedrock-mock", id: "openai/test:free" },
    });
  });

  it("creates the AWS model with a server-only bearer token", async () => {
    const modelProvider = vi.fn(() => fakeModel);
    const createAmazonBedrock = vi.fn(() => modelProvider);

    const resolved = await resolveChatModel(
      { provider: "bedrock", model: "amazon.nova-lite-v1:0" },
      {
        config: config("aws"),
        env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-test-secret" },
        createAmazonBedrock,
      },
    );

    expect(createAmazonBedrock).toHaveBeenCalledWith({
      apiKey: "bedrock-test-secret",
      region: "us-east-2",
    });
    expect(modelProvider).toHaveBeenCalledWith("amazon.nova-lite-v1:0");
    expect(resolved.trust).toEqual({
      provider: "bedrock",
      id: "amazon.nova-lite-v1:0",
    });
    expect(JSON.stringify(resolved.trust)).not.toContain("secret");
  });

  it("creates a catalog-verified NEAR AI model with truthful privacy trust", async () => {
    const modelProvider = vi.fn(() => fakeModel);
    const createProvider = vi.fn(() => modelProvider);
    const privacy = {
      tier: "incognito" as const,
      declaredBy: "operator-configuration" as const,
      attestationVerified: false as const,
      summary: "The upstream model runs outside the gateway TEE.",
    };

    const resolved = await resolveChatModel(
      {
        provider: "near-ai",
        apiKey: "near-ai-server-secret",
        apiBase: "https://cloud-api.near.ai/v1",
        model: "z-ai/example-model",
        mode: "near-ai",
        privacy,
        wallet: {
          account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
          network: "testnet",
          expiresAt: Date.now() + 60_000,
          sessionId: "near-ai-test-session",
        },
      },
      {
        nearAi: {
          createProvider,
          discoverModels: async () => [{
            id: "z-ai/example-model",
            supportedFeatures: ["tools"],
            supportedSamplingParameters: [],
            ready: true,
          }],
        },
      },
    );

    expect(resolved.model).toBe(fakeModel);
    expect(resolved.trust).toEqual({
      provider: "near-ai",
      id: "z-ai/example-model",
      privacy,
    });
    expect(JSON.stringify(resolved.trust)).not.toContain("near-ai-server-secret");
  });

  it("propagates request cancellation through NEAR AI catalog preflight", async () => {
    const abort = new AbortController();
    abort.abort(new DOMException("cancelled", "AbortError"));
    const privacy = {
      tier: "incognito" as const,
      declaredBy: "operator-configuration" as const,
      attestationVerified: false as const,
      summary: "The upstream model runs outside the gateway TEE.",
    };
    const discoverModels = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBe(abort.signal);
      throw signal?.reason;
    });

    await expect(resolveChatModel({
      provider: "near-ai",
      apiKey: "near-ai-server-secret",
      apiBase: "https://cloud-api.near.ai/v1",
      model: "z-ai/example-model",
      mode: "near-ai",
      privacy,
      wallet: {
        account: "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59",
        network: "testnet",
        expiresAt: Date.now() + 60_000,
        sessionId: "near-ai-test-session",
      },
    }, {
      signal: abort.signal,
      nearAi: { discoverModels },
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes an explicitly selected legacy region to the live provider unchanged", async () => {
    const modelProvider = vi.fn(() => fakeModel);
    const createAmazonBedrock = vi.fn(() => modelProvider);

    await resolveChatModel(
      { provider: "bedrock", model: "amazon.nova-lite-v1:0" },
      {
        config: config("aws", "us-east-1"),
        env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-test-secret" },
        createAmazonBedrock,
      },
    );

    expect(createAmazonBedrock).toHaveBeenCalledWith({
      apiKey: "bedrock-test-secret",
      region: "us-east-1",
    });
  });

  it("fails closed when Bedrock is off or its server token is absent", async () => {
    await expect(
      resolveChatModel(
        { provider: "bedrock", model: "amazon.nova-lite-v1:0" },
        { config: config("off") },
      ),
    ).rejects.toThrow("disabled");

    await expect(
      resolveChatModel(
        { provider: "bedrock", model: "amazon.nova-lite-v1:0" },
        { config: config("aws"), env: {} },
      ),
    ).rejects.toThrow("AWS_BEARER_TOKEN_BEDROCK is not configured");
  });
});
