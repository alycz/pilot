import { describe, expect, it, vi } from "vitest";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
  assertCurrentZeroPriceModel,
  catalogHasExactZeroPriceModel,
  DEMO_OPENROUTER_MODEL_SETTINGS,
} from "./openrouter-free-policy";

const MODEL = "provider/free-tools:free";

function catalog(pricing: Record<string, unknown> = { prompt: "0", completion: "0" }) {
  return { data: [{ id: MODEL, pricing, supported_parameters: ["tools"] }] };
}

describe("OpenRouter free-only policy", () => {
  it("accepts exactly one allowlisted-style free model with complete zero pricing", () => {
    expect(catalogHasExactZeroPriceModel(catalog(), MODEL)).toBe(true);
  });

  it.each([
    ["paid prompt", { prompt: "0.000001", completion: "0" }],
    ["paid add-on", { prompt: "0", completion: "0", web_search: "0.01" }],
    ["conditional pricing", { prompt: "0", completion: "0", overrides: [] }],
    ["missing dimension", { prompt: "0" }],
    ["numeric rather than catalog string", { prompt: 0, completion: "0" }],
  ])("rejects %s", (_label, pricing) => {
    expect(catalogHasExactZeroPriceModel(catalog(pricing), MODEL)).toBe(false);
  });

  it.each([
    "provider/model:online:free",
    "openrouter/free",
    "provider/model:free:online",
    "provider/model",
  ])("rejects non-exact free variant %s", (model) => {
    expect(catalogHasExactZeroPriceModel({
      data: [{
        id: model,
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: ["tools"],
      }],
    }, model)).toBe(false);
  });

  it("fails closed when catalog lookup is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 429 }));
    await expect(assertCurrentZeroPriceModel(MODEL, fetchImpl)).rejects.toThrow("unavailable");
  });

  it("pins no fallback, no paid price, explicit disabled plugins, and usage accounting", () => {
    expect(DEMO_OPENROUTER_MODEL_SETTINGS).toMatchObject({
      usage: { include: true },
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: 0, completion: 0, image: 0, audio: 0, request: 0 },
      },
    });
    expect(DEMO_OPENROUTER_MODEL_SETTINGS).not.toHaveProperty("models");
    expect(DEMO_OPENROUTER_MODEL_SETTINGS.extraBody.plugins).toEqual([
      { id: "web", enabled: false },
      { id: "file-parser", enabled: false },
      { id: "response-healing", enabled: false },
      { id: "context-compression", enabled: false },
      { id: "alignment", enabled: false },
      { id: "armor", enabled: false },
      { id: "pareto-router", enabled: false },
    ]);
  });

  it("serializes the free-only controls into the actual provider request body", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "synthetic-free-response",
        model: MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "synthetic" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          cost: 0,
        },
      });
    });
    const provider = createOpenRouter({
      apiKey: "synthetic-not-a-real-key",
      fetch: fetchImpl,
    });

    await provider(MODEL, DEMO_OPENROUTER_MODEL_SETTINGS).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      maxOutputTokens: 1,
    });

    expect(requestBody).toMatchObject({
      model: MODEL,
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: 0, completion: 0, image: 0, audio: 0, request: 0 },
      },
      plugins: DEMO_OPENROUTER_MODEL_SETTINGS.extraBody.plugins,
    });
    expect(requestBody).not.toHaveProperty("models");
  });
});
