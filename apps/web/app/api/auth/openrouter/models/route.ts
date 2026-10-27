import { NextRequest, NextResponse } from "next/server";

import {
  accountModelAllowlist,
  chooseDefaultModel,
  filterToolCallingModels,
  type PublicModel,
} from "../../../../../lib/model-access";
import {
  discoverNearAiModels,
  inspectNearAiServerConfig,
  NearAiUnavailableError,
  nearAiPublicDescriptor,
  verifyNearAiConfiguredChatModel,
} from "../../../../../lib/near-ai";
import { readDemoModelPublicStatusAsync } from "../../../../../lib/demo-model-budget";
import { readWalletBoundOpenRouterSession } from "../../../../../lib/openrouter-session";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";
import { readWalletSession } from "../../../../../lib/wallet-session";

export const runtime = "nodejs";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    resolvePilotRequestAuthority(process.env, request);
  } catch {
    return NextResponse.json(
      { error: "Model access is unavailable for this request." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  let wallet: ReturnType<typeof readWalletSession>;
  try {
    wallet = readWalletSession(request);
  } catch {
    return NextResponse.json(
      { error: "Model access session storage is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!wallet) {
    return NextResponse.json(
      { error: "Authenticate a wallet before choosing a model." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const requestedMode = request.nextUrl.searchParams.get("mode") ?? "demo";
  if (requestedMode !== "demo" && requestedMode !== "oauth" && requestedMode !== "near-ai") {
    return NextResponse.json({ error: "mode must be demo, oauth, or near-ai" }, { status: 400 });
  }

  if (requestedMode === "near-ai") {
    const nearAi = inspectNearAiServerConfig();
    if (nearAi.state !== "enabled") {
      return NextResponse.json(
        { error: "The selected NEAR AI provider is unavailable", code: "NEAR_AI_UNAVAILABLE" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      const model = verifyNearAiConfiguredChatModel(
        nearAi.config,
        await discoverNearAiModels({ signal: request.signal }),
      );
      const descriptor = nearAiPublicDescriptor(nearAi.config);
      return NextResponse.json({
        models: [{
          id: model.id,
          name: model.id,
          description: "NEAR AI Cloud model with native tool support",
          provider: "near-ai",
          privacy: descriptor.privacy,
        } satisfies PublicModel],
        defaultModel: model.id,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const unavailable = new NearAiUnavailableError();
      return NextResponse.json(
        { error: unavailable.message, code: unavailable.code },
        { status: unavailable.status, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  let allowedModels: readonly string[];
  let demoStatus: Awaited<ReturnType<typeof readDemoModelPublicStatusAsync>> | undefined;
  if (requestedMode === "demo") {
    if (!process.env.DEMO_OPENROUTER_API_KEY?.trim()) {
      return NextResponse.json(
        { error: "The free demo is not configured.", code: "DEMO_MISCONFIGURED" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    demoStatus = await readDemoModelPublicStatusAsync();
    if (!demoStatus.available) {
      return NextResponse.json(
        {
          error: "The free demo is not configured.",
          code: demoStatus.code ?? "DEMO_MISCONFIGURED",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    allowedModels = demoStatus.allowedModels ?? [];
  } else {
    const session = readWalletBoundOpenRouterSession(request, wallet);
    if (session?.mode !== "oauth") {
      return NextResponse.json(
        { error: "Connect OpenRouter before choosing an account model." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    allowedModels = accountModelAllowlist();
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json(
      { error: "The OpenRouter model list is temporarily unavailable" },
      { status: 502 },
    );
  }

  if (!upstream.ok || upstream.redirected || (
    upstream.url && upstream.url !== OPENROUTER_MODELS_URL
  )) {
    return NextResponse.json(
      { error: "The OpenRouter model list is temporarily unavailable" },
      { status: 502 },
    );
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return NextResponse.json(
      { error: "OpenRouter returned an invalid model list" },
      { status: 502 },
    );
  }

  let models: PublicModel[] = filterToolCallingModels(payload, requestedMode, allowedModels);
  const nearAi = inspectNearAiServerConfig();
  // A configured NEAR AI id is provider-owned even while its optional
  // configuration is unavailable. Never advertise an identically named
  // OpenRouter entry as a silent cross-provider fallback.
  if (nearAi.state !== "disabled" && nearAi.modelHint) {
    models = models.filter((candidate) => candidate.id !== nearAi.modelHint);
  }
  const response = NextResponse.json({
    models,
    defaultModel: chooseDefaultModel(models),
    ...(demoStatus ? { demo: demoStatus } : {}),
  });
  // Demo integrity may trip between requests; never cache an availability
  // result that could leave the wallet-first UI advertising a paused demo.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
