import {
  HarborArgsSchemas,
  HarborRestClient,
  type ArgsFor,
  type HarborOpName,
} from "@pilot/harbor-client";
import {
  StrategyKillSwitchSchema,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
} from "@pilot/contracts";

import { resolvePilotRequestAuthority } from "../../../../lib/runtime-profile";
import { verifyAndConsumeStrategyProof, type StrategyProofAction } from "../../../../lib/strategy-mandate-proof";
import { readWalletSession } from "../../../../lib/wallet-session";

const MAX_BODY_BYTES = 65_536;
const SAFE_ACTIONS = new Set([
  "validate", "simulate", "create", "list", "get", "audit", "activate", "pause", "resume", "stop", "kill",
  "global-kill-get", "global-kill-enable", "global-kill-clear",
]);

type Environment = Readonly<Record<string, string | undefined>>;
type Invoke = <K extends HarborOpName>(name: K, args: ArgsFor<K>) => Promise<unknown>;

export function createStrategyRouteHandler(overrides: { env?: Environment; invoke?: Invoke } = {}) {
  const env = overrides.env ?? process.env;
  const invoke: Invoke = overrides.invoke ?? (async (name, args) => {
    const client = new HarborRestClient({
      baseUrl: env.HARBOR_URL,
      apiKey: env.HARBOR_API_KEY,
      mock: env.HARBOR_MOCK === "1",
    });
    return client.op(name, args);
  });

  return async function handle(request: Request, action: string): Promise<Response> {
    if (!SAFE_ACTIONS.has(action)) return error(404, "STRATEGY_ACTION_NOT_FOUND", "Unknown strategy action.");
    if (request.method !== "POST") return error(405, "STRATEGY_METHOD_NOT_ALLOWED", "POST is required.");
    let origin: string;
    try { origin = resolvePilotRequestAuthority(env, request).origin; } catch { return error(403, "STRATEGY_FORBIDDEN_ORIGIN", "Same-origin access is required."); }
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") !== "same-origin") {
      return error(403, "STRATEGY_FORBIDDEN_ORIGIN", "Same-origin access is required.");
    }
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return error(415, "STRATEGY_UNSUPPORTED_MEDIA_TYPE", "A JSON body is required.");
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_BODY_BYTES) {
      return error(413, "STRATEGY_REQUEST_TOO_LARGE", "The strategy request is too large.");
    }
    const session = readWalletSession(request, env);
    if (!session || session.network !== "testnet" || env.EXEC_NETWORK?.trim() !== "testnet") {
      return error(401, "STRATEGY_TESTNET_SESSION_REQUIRED", "A wallet-bound Testnet session is required.");
    }
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error();
      const parsed = JSON.parse(text) as unknown;
      if (!safeObject(parsed)) throw new Error();
      body = parsed;
    } catch {
      return error(400, "STRATEGY_INVALID_BODY", "The strategy request body is invalid.");
    }
    if ("owner" in body || "account" in body || "network" in body || "principal" in body || "tenant" in body) {
      return error(400, "STRATEGY_SCOPE_IS_SERVER_BOUND", "Account and network are derived from the wallet session.");
    }

    let call: Call;
    try {
      call = await operation(action, body, session.account);
      if (call.proof) {
        const verified = await verifyAndConsumeStrategyProof(call.proof.input);
        if (verified.owner !== session.account) throw new Error("proof owner mismatch");
        call.args.authorization = {
          authorization_id: verified.authorizationId,
          method: "wallet_action_proof_v1",
          owner: session.account,
          mandate_digest: call.proof.input.mandateDigest.toUpperCase(),
          mandate_version: call.proof.input.mandateVersion,
          approved_at: verified.approvedAt,
          expires_at: verified.expiresAt,
        };
      }
      const schema = HarborArgsSchemas[call.op] as { parse(value: unknown): unknown };
      call.args = schema.parse(call.args) as Record<string, unknown>;
    } catch {
      return error(400, "STRATEGY_REQUEST_REJECTED", "The strategy request was rejected.");
    }
    try {
      const args = call.args as never;
      const result = await invoke(call.op, args);
      assertResponseScope(call.op, result, session.account, call.args);
      return Response.json(projectResponse(call.op, result, session.account), { headers: secureHeaders() });
    } catch {
      const requestId = typeof call.args.request_id === "string" ? call.args.request_id : undefined;
      if (requestId) {
        return Response.json({
          ok: false,
          error: {
            service: "pilot-strategy",
            kind: "error",
            code: "STRATEGY_UPSTREAM_OUTCOME_UNKNOWN",
            message: "Strategy mutation outcome is unknown. Refresh status before retrying.",
            request_id: requestId,
          },
        }, { status: 502, headers: secureHeaders() });
      }
      return error(502, "STRATEGY_STATUS_UNAVAILABLE", "Strategy status is temporarily unavailable.");
    }
  };
}

function assertResponseScope(
  op: HarborOpName,
  result: unknown,
  account: string,
  args: Record<string, unknown>,
): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
  const envelope = result as { ok?: unknown; data?: unknown; error?: unknown };
  if (envelope.ok !== true) {
    if (envelope.ok !== false || !envelope.error || typeof envelope.error !== "object" || Array.isArray(envelope.error)) throw new Error();
    return;
  }
  if (op === "strategy.globalKill.get" || op === "strategy.globalKill.set") {
    StrategyKillSwitchSchema.parse(envelope.data);
    return;
  }
  if (op === "strategy.audit") {
    if (!Array.isArray(envelope.data) || envelope.data.some((event) =>
      !event || typeof event !== "object" || Array.isArray(event) ||
      (event as { strategy_id?: unknown }).strategy_id !== args.strategy_id)) throw new Error();
    return;
  }
  if (op === "strategy.validate") {
    if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) throw new Error();
    const normalized = (envelope.data as { normalized_proposal?: unknown }).normalized_proposal;
    if (normalized !== undefined && (!normalized || typeof normalized !== "object" || Array.isArray(normalized) ||
      (normalized as { account?: unknown }).account !== account ||
      (normalized as { network?: unknown }).network !== "testnet")) throw new Error();
    return;
  }
  if (op === "strategy.simulate") {
    if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data) ||
      (envelope.data as { boundary?: unknown }).boundary !== "paper_only" ||
      (envelope.data as { ledger_acceptance?: unknown }).ledger_acceptance !== "not_tested") throw new Error();
    return;
  }
  if (op !== "strategy.create" && op !== "strategy.list" && op !== "strategy.get" &&
    op !== "strategy.authorize" && op !== "strategy.pause" && op !== "strategy.resume" &&
    op !== "strategy.stop" && op !== "strategy.kill") return;
  const strategies = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  for (const strategy of strategies) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) throw new Error();
    const mandate = (strategy as { mandate?: unknown }).mandate;
    if (!mandate || typeof mandate !== "object" || Array.isArray(mandate) ||
      (mandate as { account?: unknown }).account !== account ||
      (mandate as { network?: unknown }).network !== "testnet") throw new Error();
    if (op !== "strategy.list" && op !== "strategy.create" &&
      (strategy as { strategy_id?: unknown }).strategy_id !== args.strategy_id) throw new Error();
  }
}

function projectResponse(op: HarborOpName, result: unknown, owner: string): unknown {
  if (op !== "strategy.globalKill.get" && op !== "strategy.globalKill.set") return result;
  const envelope = result as Record<string, unknown>;
  if (envelope.ok !== true) return result;
  return {
    ...envelope,
    data: { owner, network: "testnet", kill_switch: envelope.data },
  };
}

type Call = {
  op: HarborOpName;
  args: Record<string, unknown>;
  proof?: { input: {
    token: string; txBlob: string; action: StrategyProofAction; strategyId: string;
    mandateVersion: number; mandateDigest: string; mandateExpiresAt: string; requestId: string;
  } };
};

async function operation(action: string, body: Record<string, unknown>, owner: string): Promise<Call> {
  const scoped = { owner, network: "testnet" as const };
  if (action === "validate") {
    const proposal = bindProposalScope(body, owner);
    return { op: "strategy.validate", args: proposal };
  }
  if (action === "simulate") {
    exactKeys(body, ["proposal", "observation", "at"]);
    if (!safeObject(body.proposal) || !safeObject(body.observation) || typeof body.at !== "string") throw new Error();
    return {
      op: "strategy.simulate",
      args: {
        proposal: bindProposalScope(body.proposal, owner),
        observation: bindObservationScope(body.observation, owner),
        at: body.at,
      },
    };
  }
  if (action === "create") {
    const requestId = requestIdFrom(body);
    const { request_id: _requestId, ...draft } = body;
    return { op: "strategy.create", args: { ...draft, account: owner, network: "testnet", request_id: requestId } };
  }
  if (action === "list") { exactKeys(body, []); return { op: "strategy.list", args: scoped }; }
  if (action === "get") return { op: "strategy.get", args: { ...pick(body, ["strategy_id"]), ...scoped } };
  if (action === "audit") return { op: "strategy.audit", args: { ...pick(body, ["strategy_id", "limit"]), ...scoped } };
  if (action === "global-kill-get") {
    exactKeys(body, []);
    return { op: "strategy.globalKill.get", args: scoped };
  }
  if (action === "global-kill-enable") {
    return {
      op: "strategy.globalKill.set",
      args: { ...pick(body, ["reason", "request_id"]), ...scoped, enabled: true },
    };
  }
  if (action === "global-kill-clear") {
    exactKeys(body, ["strategy_id", "mandate_version", "mandate_digest", "mandate_expires_at", "challenge_token", "tx_blob", "request_id"]);
    const input = proofInput(body, "clear_global_kill");
    return {
      op: "strategy.globalKill.set",
      args: {
        strategy_id: input.strategyId, mandate_version: input.mandateVersion,
        mandate_digest: input.mandateDigest, request_id: input.requestId,
        reason: "Cleared by owner wallet proof", enabled: false, ...scoped,
      },
      proof: { input },
    };
  }
  if (["pause", "stop", "kill"].includes(action)) {
    return { op: `strategy.${action}` as HarborOpName, args: { ...pick(body, ["strategy_id", "reason", "request_id"]), ...scoped } };
  }
  if (action === "activate" || action === "resume") {
    exactKeys(body, ["strategy_id", "mandate_version", "mandate_digest", "mandate_expires_at", "challenge_token", "tx_blob", "request_id"]);
    const input = proofInput(body, action === "activate" ? "activate" : "resume");
    return {
      op: action === "activate" ? "strategy.authorize" : "strategy.resume",
      args: {
        strategy_id: input.strategyId, mandate_version: input.mandateVersion,
        mandate_digest: input.mandateDigest, request_id: input.requestId, ...scoped,
      },
      proof: { input },
    };
  }
  throw new Error();
}

function bindObservationScope(body: Record<string, unknown>, owner: string): Record<string, unknown> {
  if (["owner", "account", "network", "principal", "tenant", "issued_asset"].some((key) => key in body)) {
    throw new Error();
  }
  return {
    ...body,
    account: owner,
    network: "testnet",
    issued_asset: { currency: TESTNET_RLUSD_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
  };
}

function bindProposalScope(body: Record<string, unknown>, owner: string): Record<string, unknown> {
  if (["owner", "account", "network", "principal", "tenant", "authorization"].some((key) => key in body)) {
    throw new Error();
  }
  return { ...body, account: owner, network: "testnet" };
}

function proofInput(body: Record<string, unknown>, action: StrategyProofAction) {
  if (typeof body.challenge_token !== "string" || typeof body.tx_blob !== "string" ||
    typeof body.strategy_id !== "string" || typeof body.mandate_version !== "number" ||
    typeof body.mandate_digest !== "string" || typeof body.mandate_expires_at !== "string") throw new Error();
  return {
    token: body.challenge_token, txBlob: body.tx_blob, action,
    strategyId: body.strategy_id, mandateVersion: body.mandate_version,
    mandateDigest: body.mandate_digest, mandateExpiresAt: body.mandate_expires_at,
    requestId: requestIdFrom(body),
  };
}

function pick(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  exactKeys(body, keys);
  return Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new Error();
}

function requestIdFrom(body: Record<string, unknown>): string {
  if (typeof body.request_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(body.request_id)) throw new Error();
  return body.request_id;
}

function safeObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stack: unknown[] = [value]; let count = 0;
  while (stack.length) {
    const item = stack.pop(); if (++count > 2_000) return false;
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return true;
}

function secureHeaders(): Record<string, string> {
  return { "cache-control": "no-store", "x-content-type-options": "nosniff" };
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { service: "pilot-strategy", kind: "error", code, message } }, { status, headers: secureHeaders() });
}
