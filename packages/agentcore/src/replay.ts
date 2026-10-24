import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { AgentCoreRuntimeResponseSchema } from "./contracts";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const LeaseIdSchema = z.string().uuid();
export type AgentCoreRuntimeResponse = z.infer<typeof AgentCoreRuntimeResponseSchema>;

export type AgentCoreReplayClaim =
  | Readonly<{ status: "claimed"; leaseId: string; fence: number; leaseUntil: number }>
  | Readonly<{ status: "completed"; response: AgentCoreRuntimeResponse }>
  | Readonly<{ status: "busy"; retryAfterMs: number }>
  | Readonly<{ status: "uncertain" }>;

export interface AgentCoreReplayStore {
  claim(input: Readonly<{ namespaceDigest: string; requestDigest: string; bindingDigest: string; nowMs: number; leaseMs: number; retentionMs: number; signal?: AbortSignal }>): Promise<AgentCoreReplayClaim>;
  markDispatched(input: Readonly<{ namespaceDigest: string; requestDigest: string; bindingDigest: string; leaseId: string; fence: number; nowMs: number; retentionMs: number; signal?: AbortSignal }>): Promise<void>;
  complete(input: Readonly<{ namespaceDigest: string; requestDigest: string; bindingDigest: string; leaseId: string; fence: number; response: AgentCoreRuntimeResponse; nowMs: number; retentionMs: number; signal?: AbortSignal }>): Promise<void>;
  releaseClaim(input: Readonly<{ namespaceDigest: string; requestDigest: string; bindingDigest: string; leaseId: string; fence: number; nowMs: number; retentionMs: number; signal?: AbortSignal }>): Promise<void>;
}

export class AgentCoreReplayError extends Error {
  constructor(readonly code: "binding" | "busy" | "fenced" | "uncertain" | "invalid") {
    super(code === "binding" ? "AgentCore replay binding mismatch"
      : code === "busy" ? "AgentCore request is already in progress"
        : code === "fenced" ? "AgentCore replay lease is no longer owned"
          : code === "uncertain" ? "AgentCore replay outcome is uncertain"
            : "AgentCore replay input is invalid");
    this.name = "AgentCoreReplayError";
  }
}

function digest(value: string): string {
  const parsed = DigestSchema.safeParse(value);
  if (!parsed.success) throw new AgentCoreReplayError("invalid");
  return parsed.data;
}

function leaseId(value: string): string {
  const parsed = LeaseIdSchema.safeParse(value);
  if (!parsed.success) throw new AgentCoreReplayError("invalid");
  return parsed.data;
}

export function validateAgentCoreReplayDurations(input: Readonly<{ leaseMs: number; retentionMs: number }>): void {
  if (
    !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 120_000 ||
    !Number.isSafeInteger(input.retentionMs) || input.retentionMs < 60_000 ||
    input.retentionMs > 86_400_000 || input.retentionMs <= input.leaseMs
  ) throw new AgentCoreReplayError("invalid");
}

export function deriveAgentCoreReplayNamespace(input: Readonly<{ deploymentId: string; tenantId: string }>): string {
  const parsed = z.object({
    deploymentId: z.string().min(3).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    tenantId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  }).strict().safeParse(input);
  if (!parsed.success) throw new AgentCoreReplayError("invalid");
  return createHash("sha256").update(JSON.stringify(parsed.data), "utf8").digest("hex");
}

export function deriveAgentCoreReplayBinding(input: Readonly<{ requestDigest: string; scopeDigest: string; gatewayBindingDigest: string }>): string {
  const parsed = z.object({ requestDigest: DigestSchema, scopeDigest: DigestSchema, gatewayBindingDigest: DigestSchema }).strict().safeParse(input);
  if (!parsed.success) throw new AgentCoreReplayError("invalid");
  return createHash("sha256").update(JSON.stringify(parsed.data), "utf8").digest("hex");
}

type MemoryRecord = {
  bindingDigest: string;
  state: "claimed" | "dispatched" | "completed" | "released";
  leaseId: string;
  fence: number;
  leaseUntil: number;
  expiresAt: number;
  response?: AgentCoreRuntimeResponse;
};

/** Deterministic local/test store. Never use this as a production fallback. */
export function createInMemoryAgentCoreReplayStore(dependencies: Readonly<{ nextLeaseId?: () => string }> = {}): AgentCoreReplayStore {
  const records = new Map<string, MemoryRecord>();
  const nextLeaseId = dependencies.nextLeaseId ?? randomUUID;
  const key = (namespace: string, request: string) => `${namespace}:${request}`;
  const read = (namespace: string, request: string) => records.get(key(namespace, request));
  const requireOwned = (input: Readonly<{ namespaceDigest: string; requestDigest: string; bindingDigest: string; leaseId: string; fence: number }>, state: MemoryRecord["state"]): MemoryRecord => {
    const current = read(input.namespaceDigest, input.requestDigest);
    if (!current || current.state !== state || current.bindingDigest !== input.bindingDigest || current.leaseId !== input.leaseId || current.fence !== input.fence) {
      throw new AgentCoreReplayError("fenced");
    }
    return current;
  };

  const store: AgentCoreReplayStore = {
    async claim(input) {
      if (input.signal?.aborted) throw new AgentCoreReplayError("uncertain");
      digest(input.namespaceDigest); digest(input.requestDigest); digest(input.bindingDigest);
      validateAgentCoreReplayDurations(input);
      const current = read(input.namespaceDigest, input.requestDigest);
      if (current) {
        if (current.bindingDigest !== input.bindingDigest) throw new AgentCoreReplayError("binding");
        if (current.state === "completed") {
          if (current.expiresAt <= Math.floor(input.nowMs / 1_000)) return { status: "uncertain" };
          if (!current.response) return { status: "uncertain" };
          return { status: "completed", response: structuredClone(current.response) };
        }
        if (current.state === "dispatched") return { status: "uncertain" };
        if (current.state === "claimed" && current.leaseUntil > input.nowMs) {
          return { status: "busy", retryAfterMs: Math.max(1, current.leaseUntil - input.nowMs) };
        }
      }
      const next = {
        bindingDigest: input.bindingDigest,
        state: "claimed" as const,
        leaseId: leaseId(nextLeaseId()),
        fence: (current?.fence ?? 0) + 1,
        leaseUntil: input.nowMs + input.leaseMs,
        expiresAt: Math.ceil((input.nowMs + input.retentionMs) / 1_000),
      };
      records.set(key(input.namespaceDigest, input.requestDigest), next);
      return { status: "claimed", leaseId: next.leaseId, fence: next.fence, leaseUntil: next.leaseUntil };
    },
    async markDispatched(input) {
      if (input.signal?.aborted) throw new AgentCoreReplayError("uncertain");
      const current = requireOwned(input, "claimed");
      if (current.leaseUntil <= input.nowMs) throw new AgentCoreReplayError("fenced");
      current.state = "dispatched";
      current.expiresAt = Math.ceil((input.nowMs + input.retentionMs) / 1_000);
    },
    async complete(input) {
      if (input.signal?.aborted) throw new AgentCoreReplayError("uncertain");
      const current = requireOwned(input, "dispatched");
      current.state = "completed";
      current.response = structuredClone(AgentCoreRuntimeResponseSchema.parse(input.response));
      current.expiresAt = Math.ceil((input.nowMs + input.retentionMs) / 1_000);
    },
    async releaseClaim(input) {
      if (input.signal?.aborted) throw new AgentCoreReplayError("uncertain");
      const current = requireOwned(input, "claimed");
      current.state = "released";
      current.leaseUntil = input.nowMs;
      current.expiresAt = Math.ceil((input.nowMs + input.retentionMs) / 1_000);
    },
  };
  return Object.freeze(store);
}
