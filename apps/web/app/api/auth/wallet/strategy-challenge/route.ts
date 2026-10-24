import { readWalletSession } from "../../../../../lib/wallet-session";
import { issueStrategyChallenge, type StrategyProofAction } from "../../../../../lib/strategy-mandate-proof";
import { resolvePilotRequestAuthority } from "../../../../../lib/runtime-profile";

const ACTIONS = new Set<StrategyProofAction>(["activate", "resume", "clear_global_kill"]);

export async function POST(request: Request): Promise<Response> {
  let expectedOrigin: string;
  try { expectedOrigin = resolvePilotRequestAuthority(process.env, request).origin; } catch { return Response.json({ error: "Invalid origin." }, { status: 403 }); }
  if (request.headers.get("origin") !== expectedOrigin || request.headers.get("sec-fetch-site") !== "same-origin") {
    return Response.json({ error: "Same-origin strategy authorization is required." }, { status: 403 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "A JSON body is required." }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declaredLength) || declaredLength > 16_384) {
    return Response.json({ error: "The strategy challenge request is too large." }, { status: 413 });
  }
  const session = readWalletSession(request);
  if (!session || session.network !== "testnet" || process.env.EXEC_NETWORK?.trim() !== "testnet") {
    return Response.json({ error: "A Testnet wallet session is required." }, { status: 401 });
  }
  const body = await request.text().then((text) => {
    if (new TextEncoder().encode(text).byteLength > 16_384) return null;
    return JSON.parse(text) as unknown;
  }).catch(() => null) as Record<string, unknown> | null;
  if (!body || Object.keys(body).sort().join("\0") !== "action\0mandate_digest\0mandate_expires_at\0mandate_version\0request_id\0strategy_id" ||
    typeof body.action !== "string" || !ACTIONS.has(body.action as StrategyProofAction) ||
    typeof body.strategy_id !== "string" || typeof body.mandate_digest !== "string" ||
    typeof body.mandate_version !== "number" || typeof body.mandate_expires_at !== "string" ||
    typeof body.request_id !== "string") {
    return Response.json({ error: "An exact strategy mandate challenge is required." }, { status: 400 });
  }
  try {
    const challenge = issueStrategyChallenge(session, {
      action: body.action as StrategyProofAction,
      strategyId: body.strategy_id,
      mandateVersion: body.mandate_version,
      mandateDigest: body.mandate_digest,
      mandateExpiresAt: body.mandate_expires_at,
      requestId: body.request_id,
    });
    return Response.json({
      account: session.account, network: "testnet", challenge_token: challenge.token,
      expires_at: new Date(challenge.expiresAt).toISOString(), mandate_digest: body.mandate_digest,
      mandate_expires_at: body.mandate_expires_at, mandate_version: body.mandate_version,
      request_id: body.request_id, tx_json: challenge.txJson,
    }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return Response.json({ error: "The strategy challenge could not be issued." }, { status: 400 });
  }
}
