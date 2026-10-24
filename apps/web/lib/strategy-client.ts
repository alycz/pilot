import {
  StrategyAuditEventSchema,
  StrategyKillSwitchSchema,
  StrategySchema,
  type Strategy,
  type StrategyAuditEvent,
  type StrategyKillSwitch,
} from "@pilot/contracts";
import { z } from "zod";

// The proposal is untrusted input. Harbor's versioned schema/compiler remains
// authoritative; Pilot deliberately does not turn a client-side shape into
// execution authority.
export type StrategyDraftInput = Record<string, unknown>;
export type StrategyProofInput = {
  strategy_id: string;
  mandate_version: number;
  mandate_digest: string;
  mandate_expires_at: string;
  request_id: string;
  challenge_token: string;
  tx_blob: string;
};
export type ScopedStrategyKillSwitch = {
  owner: string;
  network: "testnet";
  kill_switch: StrategyKillSwitch;
};

export class StrategyMutationUnknownError extends Error {
  constructor(readonly requestId: string) {
    super("Strategy mutation outcome is unknown. Refresh status before taking another action.");
  }
}

const Envelope = <T extends z.ZodTypeAny>(data: T) => z.union([
  z.object({ ok: z.literal(true), data, asOf: z.string(), asOfBasis: z.string(), caveat: z.array(z.string()).optional() }).passthrough(),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string(), code: z.string().optional() }).passthrough() }).passthrough(),
]);
const TestnetStrategySchema = StrategySchema.refine(
  (strategy) => /^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/.test(strategy.mandate.issued_asset.currency),
  { path: ["mandate", "issued_asset", "currency"], message: "invalid XRPL currency code" },
);
const ScopedStrategyKillSwitchSchema = z.object({
  owner: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  network: z.literal("testnet"),
  kill_switch: StrategyKillSwitchSchema,
}).strict();

export function createStrategyClient(fetcher: typeof fetch = globalThis.fetch) {
  async function request<T>(action: string, body: Record<string, unknown>, schema: z.ZodType<T>, requestId?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`/api/strategy/${action}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, ...(requestId ? { request_id: requestId } : {}) }),
      });
    } catch {
      if (requestId) throw new StrategyMutationUnknownError(requestId);
      throw new Error("Strategy status is unavailable.");
    }
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const upstreamCode = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { error?: { code?: unknown; request_id?: unknown } }).error : undefined;
      if (requestId && upstreamCode?.code === "STRATEGY_UPSTREAM_OUTCOME_UNKNOWN" &&
        upstreamCode.request_id === requestId) throw new StrategyMutationUnknownError(requestId);
      if (requestId && response.status >= 500) throw new StrategyMutationUnknownError(requestId);
      const message = payload && typeof payload === "object" && !Array.isArray(payload) &&
        typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message : "Strategy request failed.";
      throw new Error(message);
    }
    const parsed = Envelope(schema).safeParse(payload);
    if (!parsed.success) {
      if (requestId) throw new StrategyMutationUnknownError(requestId);
      throw new Error("Strategy response was invalid.");
    }
    const result = parsed.data as
      | { ok: true; data: T }
      | { ok: false; error: { message: string } };
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }

  return {
    list: () => request("list", {}, z.array(TestnetStrategySchema)),
    create: (draft: StrategyDraftInput, requestId = crypto.randomUUID()) =>
      request("create", draft as Record<string, unknown>, TestnetStrategySchema, requestId),
    get: (strategyId: string) => request("get", { strategy_id: strategyId }, TestnetStrategySchema),
    activate: (proof: StrategyProofInput) =>
      request("activate", proof, TestnetStrategySchema, proof.request_id),
    pause: (strategyId: string, reason = "Paused by owner", requestId = crypto.randomUUID()) =>
      request("pause", { strategy_id: strategyId, reason }, TestnetStrategySchema, requestId),
    resume: (proof: StrategyProofInput) =>
      request("resume", proof, TestnetStrategySchema, proof.request_id),
    stop: (strategyId: string, reason = "Stopped by owner", requestId = crypto.randomUUID()) =>
      request("stop", { strategy_id: strategyId, reason }, TestnetStrategySchema, requestId),
    kill: (strategyId: string, reason = "Killed by owner", requestId = crypto.randomUUID()) =>
      request("kill", { strategy_id: strategyId, reason }, TestnetStrategySchema, requestId),
    globalKillGet: () => request("global-kill-get", {}, ScopedStrategyKillSwitchSchema),
    globalKillEnable: (reason = "Enabled by owner", requestId = crypto.randomUUID()) =>
      request("global-kill-enable", { reason }, ScopedStrategyKillSwitchSchema, requestId),
    globalKillClear: (proof: StrategyProofInput) =>
      request("global-kill-clear", proof, ScopedStrategyKillSwitchSchema, proof.request_id),
    audit: (strategyId: string): Promise<StrategyAuditEvent[]> =>
      request("audit", { strategy_id: strategyId }, z.array(StrategyAuditEventSchema)),
  } satisfies {
    list(): Promise<Strategy[]>; create(draft: StrategyDraftInput, requestId?: string): Promise<Strategy>;
    get(id: string): Promise<Strategy>; activate(proof: StrategyProofInput): Promise<Strategy>;
    pause(id: string, reason?: string, requestId?: string): Promise<Strategy>; resume(proof: StrategyProofInput): Promise<Strategy>;
    stop(id: string, reason?: string, requestId?: string): Promise<Strategy>; kill(id: string, reason?: string, requestId?: string): Promise<Strategy>;
    globalKillGet(): Promise<ScopedStrategyKillSwitch>;
    globalKillEnable(reason?: string, requestId?: string): Promise<ScopedStrategyKillSwitch>;
    globalKillClear(proof: StrategyProofInput): Promise<ScopedStrategyKillSwitch>;
    audit(id: string): Promise<StrategyAuditEvent[]>;
  };
}
