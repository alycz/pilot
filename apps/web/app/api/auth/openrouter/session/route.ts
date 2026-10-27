import { NextRequest, NextResponse } from "next/server";

import {
  getDefaultModel,
  requireDemoModel,
  requireOpenRouterAccountModel,
} from "../../../../../lib/model-access";
import {
  createDemoModelBudget,
  DemoModelAccessError,
  readDemoModelPublicStatusAsync,
} from "../../../../../lib/demo-model-budget";
import {
  createOpenRouterSession,
  OAUTH_COOKIE_OPTIONS,
  OPENROUTER_PENDING_SESSION_COOKIE,
  OPENROUTER_RETURN_TO_COOKIE,
  OPENROUTER_SESSION_COOKIE,
  OPENROUTER_STATE_COOKIE,
  OPENROUTER_VERIFIER_COOKIE,
  OPENROUTER_WALLET_BINDING_COOKIE,
  PENDING_SESSION_COOKIE_OPTIONS,
  readWalletBoundOpenRouterSession,
  sealOpenRouterSession,
  SESSION_COOKIE_OPTIONS,
  walletModelBinding,
} from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../../lib/wallet-session";
import {
  assertCurrentZeroPriceModel,
  OpenRouterFreePolicyError,
} from "../../../../../lib/openrouter-free-policy";
import {
  discoverNearAiModels,
  inspectNearAiServerConfig,
  NearAiUnavailableError,
  verifyNearAiConfiguredChatModel,
} from "../../../../../lib/near-ai";

export const runtime = "nodejs";

/**
 * Reading or sealing a session needs SESSION_SECRET. Without it, answer with a
 * readable JSON error instead of an empty 500 so the UI can explain the setup.
 */
function sessionUnavailable(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "Session storage is unavailable";
  const response = NextResponse.json({ error: message, code: "SESSION_UNAVAILABLE" }, { status: 503 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function json(body: object, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function requestOrigin(request: NextRequest): string | null {
  try {
    return resolvePilotRequestAuthority(process.env, request).origin;
  } catch {
    return null;
  }
}

function hasExactOrigin(request: NextRequest, origin: string): boolean {
  return request.headers.get("origin") === origin;
}

function walletForRequest(request: NextRequest) {
  const wallet = readWalletSession(request);
  const binding = wallet && walletModelBinding(request, wallet);
  return wallet && binding ? { wallet, binding } : null;
}

async function publicDemoStatus() {
  if (!process.env.DEMO_OPENROUTER_API_KEY?.trim()) {
    return { available: false, code: "DEMO_MISCONFIGURED" as const };
  }
  const status = await readDemoModelPublicStatusAsync();
  return status;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!requestOrigin(request)) return json({ error: "Model access is unavailable for this request." }, 403);
  let wallet: ReturnType<typeof walletForRequest>;
  let session: ReturnType<typeof readWalletBoundOpenRouterSession>;
  try {
    wallet = walletForRequest(request);
    if (!wallet) return json({ error: "Authenticate a wallet before selecting a model." }, 401);
    session = readWalletBoundOpenRouterSession(request, wallet.wallet);
  } catch (error) {
    return sessionUnavailable(error);
  }
  let model: string;
  let demo: Awaited<ReturnType<typeof publicDemoStatus>>;
  try {
    model = session?.model ?? getDefaultModel();
    demo = await publicDemoStatus();
  } catch {
    return json({
      error: "Model access configuration is unavailable.",
      code: "MODEL_ACCESS_UNAVAILABLE",
    }, 503);
  }
  const response = NextResponse.json({
    mode: session?.mode ?? "demo",
    ...(session?.mode === "near-ai" ? { provider: "near-ai" as const } : {}),
    model,
    selected: session !== null,
    connected: session?.mode === "oauth",
    demo,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(request);
  if (!origin) return json({ error: "Model access is unavailable for this request." }, 403);
  if (!hasExactOrigin(request, origin)) {
    return json({ error: "Same-origin model access is required." }, 403);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid session body" }, 400);
  }

  const input = body as { mode?: unknown; provider?: unknown; model?: unknown };
  let wallet: ReturnType<typeof walletForRequest>;
  let current: ReturnType<typeof readWalletBoundOpenRouterSession>;
  try {
    wallet = walletForRequest(request);
    if (!wallet) return json({ error: "Authenticate a wallet before selecting a model." }, 401);
    current = readWalletBoundOpenRouterSession(request, wallet.wallet);
  } catch (error) {
    return sessionUnavailable(error);
  }

  try {
    if (input.mode === "demo") {
      if (input.provider !== undefined && input.provider !== "openrouter") {
        return json({ error: "Demo mode uses the OpenRouter provider" }, 400);
      }
      const model = requireDemoModel(input.model);
      if (!process.env.DEMO_OPENROUTER_API_KEY?.trim()) {
        throw new DemoModelAccessError(
          "DEMO_MISCONFIGURED",
          503,
          "The free demo is not configured",
        );
      }
      const budget = createDemoModelBudget();
      try {
        await budget.assertRequest(model, 0);
      } finally {
        await budget.close?.();
      }
      await assertCurrentZeroPriceModel(model);
      const demo = await publicDemoStatus();
      if (!demo.available) {
        throw new DemoModelAccessError(
          demo.code ?? "DEMO_STATE_UNAVAILABLE",
          503,
          "The free demo is unavailable",
        );
      }
      const response = NextResponse.json({
        mode: "demo",
        model,
        connected: false,
        demo,
      });
      response.cookies.set(
        OPENROUTER_SESSION_COOKIE,
        sealOpenRouterSession(createOpenRouterSession(
          { mode: "demo", model },
          wallet.binding,
        )),
        SESSION_COOKIE_OPTIONS,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    if (input.mode === "near-ai" || input.provider === "near-ai") {
      if (input.mode !== "near-ai" || input.provider !== "near-ai") {
        return json({ error: "NEAR AI selection requires explicit mode and provider" }, 400);
      }
      const nearAi = inspectNearAiServerConfig();
      if (nearAi.state !== "enabled" || input.model !== nearAi.config.model) {
        throw new NearAiUnavailableError();
      }
      try {
        verifyNearAiConfiguredChatModel(
          nearAi.config,
          await discoverNearAiModels({ signal: request.signal }),
        );
      } catch (error) {
        if (request.signal.aborted) throw error;
        throw new NearAiUnavailableError();
      }
      const response = NextResponse.json({
        mode: "near-ai",
        provider: "near-ai",
        model: nearAi.config.model,
        connected: false,
        selected: true,
      });
      response.cookies.set(
        OPENROUTER_SESSION_COOKIE,
        sealOpenRouterSession(createOpenRouterSession(
          { mode: "near-ai", provider: "near-ai", model: nearAi.config.model },
          wallet.binding,
        )),
        SESSION_COOKIE_OPTIONS,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    if (input.mode !== undefined || (input.provider !== undefined && input.provider !== "openrouter")) {
      return json({ error: "Unsupported model provider selection" }, 400);
    }

    if (current?.mode !== "oauth") {
      return json({ error: "Sign in with OpenRouter before selecting an account model" }, 401);
    }

    const model = requireOpenRouterAccountModel(input.model);
    const response = NextResponse.json({ mode: "oauth", model, connected: true });
    response.cookies.set(
      OPENROUTER_SESSION_COOKIE,
      sealOpenRouterSession({ ...current, model }),
      SESSION_COOKIE_OPTIONS,
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (request.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : "Invalid session";
    const status = error instanceof DemoModelAccessError ||
        error instanceof OpenRouterFreePolicyError ||
        error instanceof NearAiUnavailableError
      ? error.status
      : 400;
    const code = error instanceof DemoModelAccessError || error instanceof NearAiUnavailableError
      ? error.code
      : undefined;
    return json({ error: message, ...(code ? { code } : {}) }, status);
  }
}

export function DELETE(request: NextRequest): NextResponse {
  const origin = requestOrigin(request);
  if (!origin) return json({ error: "Model access is unavailable for this request." }, 403);
  if (!hasExactOrigin(request, origin)) {
    return json({ error: "Same-origin model access is required." }, 403);
  }
  let model: string | undefined;
  try {
    model = getDefaultModel();
  } catch {
    // Local credential cleanup must remain available even when model
    // configuration has expired or is temporarily invalid.
  }
  const response = NextResponse.json({
    mode: "demo",
    ...(model ? { model } : {}),
    connected: false,
  });
  const expiredSession = { ...SESSION_COOKIE_OPTIONS, maxAge: 0 };
  const expiredOauth = { ...OAUTH_COOKIE_OPTIONS, maxAge: 0 };
  response.cookies.set(OPENROUTER_SESSION_COOKIE, "", expiredSession);
  response.cookies.set(OPENROUTER_STATE_COOKIE, "", expiredOauth);
  response.cookies.set(OPENROUTER_VERIFIER_COOKIE, "", expiredOauth);
  response.cookies.set(OPENROUTER_RETURN_TO_COOKIE, "", expiredOauth);
  response.cookies.set(OPENROUTER_WALLET_BINDING_COOKIE, "", expiredOauth);
  response.cookies.set(OPENROUTER_PENDING_SESSION_COOKIE, "", {
    ...PENDING_SESSION_COOKIE_OPTIONS,
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
