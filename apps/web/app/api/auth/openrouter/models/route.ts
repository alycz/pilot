import { NextRequest, NextResponse } from "next/server";

import {
  accountModelAllowlist,
  chooseDefaultModel,
  filterToolCallingModels,
} from "../../../../../lib/model-access";
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
  if (requestedMode !== "demo" && requestedMode !== "oauth") {
    return NextResponse.json({ error: "mode must be demo or oauth" }, { status: 400 });
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

  const models = filterToolCallingModels(payload, requestedMode, allowedModels);
  const response = NextResponse.json({
    models,
    defaultModel: models.length > 0 ? chooseDefaultModel(models) : null,
    ...(demoStatus ? { demo: demoStatus } : {}),
  });
  // Demo integrity may trip between requests; never cache an availability
  // result that could leave the wallet-first UI advertising a paused demo.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
