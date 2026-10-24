import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BedrockDailyTurnLimitError,
  filterToolCallingModels,
  getModelAccess,
  requireAccountModel,
  requireDemoModel,
} from "./model-access";
import {
  createOpenRouterSession,
  OPENROUTER_SESSION_COOKIE,
  sealOpenRouterSession,
  walletModelBinding,
} from "./openrouter-session";
import {
  sealWalletSession,
  WALLET_SESSION_COOKIE,
  type WalletSession,
} from "./wallet-session";

const SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";
const ACCOUNT = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
let stateDirectory: string;

function modelRequest(
  session: { mode: "demo"; model: string } | { mode: "oauth"; model: string; apiKey: string },
): Request {
  const wallet: WalletSession = {
    version: 1,
    account: ACCOUNT,
    network: "testnet",
    expiresAt: Date.now() + 60 * 60 * 1_000,
  };
  const walletCookie = sealWalletSession(wallet);
  const walletRequest = new Request("https://pilot.example/api/chat", {
    headers: { Cookie: `${WALLET_SESSION_COOKIE}=${walletCookie}` },
  });
  const binding = walletModelBinding(walletRequest, wallet);
  if (!binding) throw new Error("test wallet binding was not created");
  const modelCookie = sealOpenRouterSession(createOpenRouterSession(session, binding));
  return new Request("https://pilot.example/api/chat", {
    headers: {
      Cookie: `${WALLET_SESSION_COOKIE}=${walletCookie}; ${OPENROUTER_SESSION_COOKIE}=${modelCookie}`,
    },
  });
}

describe("getModelAccess", () => {
  beforeEach(() => {
    stateDirectory = mkdtempSync(join(tmpdir(), "pilot-model-access-"));
    chmodSync(stateDirectory, 0o700);
    process.env.SESSION_SECRET = SECRET;
    process.env.DEMO_OPENROUTER_API_KEY = "demo-server-only-key";
    process.env.DEMO_MODEL_ENABLED = "1";
    process.env.DEMO_MODEL_QUOTA_BACKEND = "sqlite-single-host";
    process.env.DEMO_MODEL_COST_POLICY = "free-only";
    process.env.DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE = "verified";
    process.env.DEMO_OPENROUTER_KEY_LIMIT_USD = "0";
    process.env.DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT = "1";
    process.env.DEMO_OPENROUTER_NO_BYOK = "verified";
    process.env.DEMO_OPENROUTER_PAID_ADDONS_DISABLED = "verified";
    process.env.DEMO_MODEL_STATE_DIR = stateDirectory;
    process.env.DEMO_MODEL_ALLOWED_MODELS = "provider/default:free,provider/demo:free";
    process.env.DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS = "4096";
    process.env.DEMO_MODEL_GLOBAL_DAILY_REQUESTS = "20";
    process.env.DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS = "2048";
    process.env.DEMO_MODEL_WALLET_DAILY_REQUESTS = "10";
    process.env.DEMO_MODEL_RATE_WINDOW_SECONDS = "60";
    process.env.DEMO_MODEL_RATE_REQUESTS = "10";
    process.env.DEMO_MODEL_MAX_GLOBAL_CONCURRENCY = "1";
    process.env.DEMO_MODEL_MAX_WALLET_CONCURRENCY = "1";
    process.env.DEMO_MODEL_RESERVATION_TTL_SECONDS = "60";
    process.env.DEMO_MODEL_ABORT_GRACE_SECONDS = "2";
    process.env.DEMO_MODEL_MAX_INPUT_BYTES = "4096";
    process.env.DEMO_MODEL_MAX_OUTPUT_TOKENS = "256";
    process.env.DEMO_MODEL_MAX_STEPS = "4";
    process.env.MODEL_DEFAULT = "provider/default:free";
    process.env.OPENROUTER_ALLOWED_MODELS = "provider/account-model";
    process.env.AWS_REGION = "us-east-1";
    process.env.BEDROCK_MODELS = "amazon.nova-lite-v1:0";
    process.env.BEDROCK_DAILY_TURN_CAP = "50";
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.SESSION_SECRET;
    delete process.env.DEMO_OPENROUTER_API_KEY;
    delete process.env.DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE;
    delete process.env.DEMO_OPENROUTER_KEY_LIMIT_USD;
    delete process.env.DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT;
    delete process.env.DEMO_OPENROUTER_NO_BYOK;
    delete process.env.DEMO_OPENROUTER_PAID_ADDONS_DISABLED;
    for (const name of Object.keys(process.env).filter((name) => name.startsWith("DEMO_MODEL_"))) {
      delete process.env[name];
    }
    delete process.env.MODEL_DEFAULT;
    delete process.env.OPENROUTER_ALLOWED_MODELS;
    delete process.env.AWS_REGION;
    delete process.env.BEDROCK_MODE;
    delete process.env.BEDROCK_MODELS;
    delete process.env.BEDROCK_DAILY_TURN_CAP;
  });

  it("requires a wallet-bound demo session and enforces its exact allowlist", () => {
    expect(() => getModelAccess(new Request("https://pilot.example/api/chat"))).toThrow(
      "wallet-bound model session",
    );
    expect(getModelAccess(modelRequest({ mode: "demo", model: "provider/default:free" }))).toMatchObject({
      provider: "openrouter",
      apiKey: "demo-server-only-key",
      model: "provider/default:free",
      mode: "demo",
    });

    process.env.DEMO_MODEL_ALLOWED_MODELS = "provider/demo:free";
    expect(() =>
      getModelAccess(modelRequest({ mode: "demo", model: "provider/default:free" })),
    ).toThrow("not enabled");
  });

  it("returns a decrypted OAuth key only to server code", () => {
    const request = modelRequest({
      mode: "oauth",
      model: "provider/account-model",
      apiKey: "user-owned-openrouter-key",
    });

    expect(getModelAccess(request)).toMatchObject({
      provider: "openrouter",
      apiKey: "user-owned-openrouter-key",
      model: "provider/account-model",
      mode: "oauth",
    });
  });

  it.each(["off", "mock", "aws"] as const)(
    "keeps logged-out and demo visitors on free OpenRouter models in %s mode",
    (bedrockMode) => {
      process.env.BEDROCK_MODE = bedrockMode;

      expect(() => getModelAccess(new Request("https://pilot.example/api/chat"))).toThrow();

      expect(getModelAccess(modelRequest({
        mode: "demo",
        model: "provider/demo:free",
      }))).toMatchObject({
        provider: "openrouter",
        apiKey: "demo-server-only-key",
        model: "provider/demo:free",
        mode: "demo",
      });
    },
  );

  it.each([
    ["off", "openrouter"],
    ["mock", "bedrock"],
    ["aws", "bedrock"],
  ] as const)(
    "resolves an OAuth Bedrock selection in %s mode to %s",
    (bedrockMode, provider) => {
      process.env.BEDROCK_MODE = bedrockMode;
      const access = getModelAccess(modelRequest({
        mode: "oauth",
        model: "amazon.nova-lite-v1:0",
        apiKey: `oauth-${bedrockMode}-matrix-key`,
      }));

      expect(access.provider).toBe(provider);
      expect(access.model).toBe("amazon.nova-lite-v1:0");
      if (bedrockMode === "aws") {
        expect(access).not.toHaveProperty("apiKey");
      } else {
        expect(access).toHaveProperty("apiKey", `oauth-${bedrockMode}-matrix-key`);
      }
    },
  );

  it("enforces the process-local Bedrock daily turn cap per OAuth user", () => {
    process.env.BEDROCK_MODE = "mock";
    process.env.BEDROCK_DAILY_TURN_CAP = "1";
    const request = modelRequest({
      mode: "oauth",
      model: "amazon.nova-lite-v1:0",
      apiKey: "oauth-cap-test-key",
    });

    expect(getModelAccess(request)).toMatchObject({
      provider: "bedrock",
      model: "amazon.nova-lite-v1:0",
      mode: "oauth",
    });
    expect(() => getModelAccess(request)).toThrow(BedrockDailyTurnLimitError);
  });

  it("isolates Bedrock turn caps between OAuth users", () => {
    process.env.BEDROCK_MODE = "mock";
    process.env.BEDROCK_DAILY_TURN_CAP = "1";
    const requestFor = (apiKey: string) => {
      return modelRequest({
        mode: "oauth",
        model: "amazon.nova-lite-v1:0",
        apiKey,
      });
    };
    const firstUser = requestFor("oauth-isolation-user-a");
    const secondUser = requestFor("oauth-isolation-user-b");

    expect(getModelAccess(firstUser).provider).toBe("bedrock");
    expect(() => getModelAccess(firstUser)).toThrow(BedrockDailyTurnLimitError);
    expect(getModelAccess(secondUser).provider).toBe("bedrock");
  });

  it("resets a Bedrock user's fixed window after 24 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    process.env.BEDROCK_MODE = "mock";
    process.env.BEDROCK_DAILY_TURN_CAP = "1";
    const request = modelRequest({
      mode: "oauth",
      model: "amazon.nova-lite-v1:0",
      apiKey: "oauth-window-reset-user",
    });

    expect(getModelAccess(request).provider).toBe("bedrock");
    expect(() => getModelAccess(request)).toThrow(BedrockDailyTurnLimitError);

    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(() => getModelAccess(request)).toThrow(/wallet-bound/i);
    const renewedSession = modelRequest({
      mode: "oauth",
      model: "amazon.nova-lite-v1:0",
      apiKey: "oauth-window-reset-user",
    });
    expect(getModelAccess(renewedSession).provider).toBe("bedrock");
  });
});

describe("model filtering", () => {
  const payload = {
    data: [
      {
        id: "provider/free-tools:free",
        name: "Free Tools",
        description: "Free and capable",
        supported_parameters: ["tools", "temperature"],
        pricing: { prompt: "0", completion: "0" },
      },
      {
        id: "provider/paid-tools",
        name: "Paid Tools",
        supported_parameters: ["tools"],
      },
      {
        id: "provider/no-tools:free",
        name: "No Tools",
        supported_parameters: ["temperature"],
      },
    ],
  };

  it("requires tool calling and restricts demo mode to :free ids", () => {
    expect(filterToolCallingModels(payload, "demo", ["provider/free-tools:free"]).map((model) => model.id)).toEqual([
      "provider/free-tools:free",
    ]);
    expect(filterToolCallingModels(payload, "oauth", ["provider/free-tools:free", "provider/paid-tools"]).map((model) => model.id)).toEqual([
      "provider/free-tools:free",
      "provider/paid-tools",
    ]);
    expect(() => requireDemoModel("provider/paid-tools")).toThrow(":free");
  });

  it("rejects allowlisted free-suffix models with paid, missing, or unknown pricing", () => {
    const unsafe = {
      data: [
        { id: "provider/paid:free", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0.1" } },
        { id: "provider/missing:free", supported_parameters: ["tools"] },
        { id: "provider/addon:free", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0", overrides: [] } },
      ],
    };
    expect(filterToolCallingModels(unsafe, "demo", unsafe.data.map(({ id }) => id))).toEqual([]);
  });

  it("rejects syntactically valid account models outside the server allowlist", () => {
    process.env.MODEL_DEFAULT = "provider/free-tools:free";
    process.env.OPENROUTER_ALLOWED_MODELS = "provider/paid-tools";
    expect(requireAccountModel("provider/paid-tools")).toBe("provider/paid-tools");
    expect(() => requireAccountModel("provider/other-paid")).toThrow("allowlist");
  });
});
