import { EnvelopeSchema } from "@pilot/contracts";
import {
  MAX_HARBOR_RESPONSE_BYTES,
  readBoundedResponseText,
} from "@pilot/harbor-client";
import { z } from "zod";

const ClassicAddressSchema = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
const ReferenceSchema = z.string().regex(/^cap_v1_[A-Za-z0-9_-]{32,128}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const TimestampSchema = z.string().datetime();
const AmountSchema = z.object({ unit: z.literal("request"), value: z.literal("1") }).strict();
const ScopeSchema = z.object({
  account: ClassicAddressSchema,
  network: z.literal("testnet"),
}).strict();

export const CapabilityGrantSchema = z.object({
  capabilityRef: ReferenceSchema,
  principal: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  account: ClassicAddressSchema,
  network: z.literal("testnet"),
  service: z.literal("mock.catalog"),
  operation: z.literal("read"),
  amount: AmountSchema,
  destination: z.literal("local-fixture-catalog"),
  notBefore: TimestampSchema,
  expiresAt: TimestampSchema,
  maxUses: z.number().int().min(1).max(100),
  uses: z.number().int().nonnegative(),
  rateLimit: z.object({
    windowSeconds: z.number().int().min(1).max(3_600),
    maxCalls: z.number().int().min(1).max(100),
  }).strict(),
  generation: z.number().int().min(1),
  state: z.enum(["prepared", "active", "revoked", "expired"]),
  approvalDigest: DigestSchema,
}).strict().superRefine((grant, context) => {
  if (grant.uses > grant.maxUses || grant.rateLimit.maxCalls > grant.maxUses) {
    context.addIssue({ code: "custom", message: "Capability quota is invalid." });
  }
});

export const CapabilityOwnerReviewSchema = z.object({
  action: z.enum(["activate", "revoke"]),
  capability_ref: ReferenceSchema,
  network: z.literal("testnet"),
  generation: z.number().int().min(1),
  approval_digest: DigestSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  approved_at: TimestampSchema,
  expires_at: TimestampSchema,
  tx_json: z.object({
    TransactionType: z.literal("AccountSet"),
    Account: ClassicAddressSchema,
    Sequence: z.literal(0),
    Fee: z.literal("0"),
    LastLedgerSequence: z.literal(0),
    Memos: z.array(z.object({
      Memo: z.object({
        MemoType: z.string().regex(/^[A-Fa-f0-9]+$/),
        MemoData: z.string().regex(/^[A-Fa-f0-9]+$/),
      }).strict(),
    }).strict()).length(1),
  }).strict(),
  verification_boundary: z.object({
    signature_proves: z.literal("owner-key-control-only"),
    runtime_provenance: z.literal("not-authenticated-by-signed-blob"),
    physical_device_inferred: z.literal(false),
  }).strict(),
}).strict();

const PreparedSchema = z.object({
  grant: CapabilityGrantSchema,
  owner_review: CapabilityOwnerReviewSchema,
}).strict().superRefine((value, context) => {
  const review = value.owner_review;
  if (
    review.action !== "activate" ||
    review.capability_ref !== value.grant.capabilityRef ||
    review.network !== value.grant.network ||
    review.generation !== value.grant.generation ||
    review.approval_digest !== value.grant.approvalDigest ||
    review.tx_json.Account !== value.grant.account
  ) {
    context.addIssue({ code: "custom", message: "Capability owner review is outside the prepared grant." });
  }
});

const PreparedRevocationSchema = z.object({
  request_id: RequestIdSchema,
  owner_review: CapabilityOwnerReviewSchema,
}).strict().superRefine((value, context) => {
  if (value.owner_review.action !== "revoke") {
    context.addIssue({ code: "custom", message: "Capability revocation review is invalid." });
  }
});

export const CapabilityInvocationSchema = z.object({
  capabilityRef: ReferenceSchema,
  requestId: RequestIdSchema,
  generation: z.number().int().min(1),
  status: z.enum(["completed", "unknown"]),
  replayed: z.boolean(),
  data: z.object({
    resource: z.enum(["ledger-docs", "market-fixture"]),
    entries: z.array(z.enum(["payments", "escrow", "dex", "amm"])).max(2),
    simulated: z.literal(true),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === "completed") !== (value.data !== undefined)) {
    context.addIssue({ code: "custom", message: "Capability invocation result is invalid." });
  }
});

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type CapabilityOwnerReview = z.infer<typeof CapabilityOwnerReviewSchema>;
export type PreparedCapability = z.infer<typeof PreparedSchema>;
export type PreparedCapabilityRevocation = z.infer<typeof PreparedRevocationSchema>;
export type CapabilityInvocation = z.infer<typeof CapabilityInvocationSchema>;

export type CapabilityOwnerProof = Readonly<{
  nonce: string;
  approved_at: string;
  expires_at: string;
  tx_blob: string;
}>;

export class CapabilityRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CapabilityRequestError";
  }
}

export class CapabilityTransportError extends Error {
  constructor(message = "The capability response is uncertain. Recover the exact operation; do not start a replacement.") {
    super(message);
    this.name = "CapabilityTransportError";
  }
}

const BROWSER_TIMEOUT_MS = 35_000;

const PATHS = Object.freeze({
  prepare: "/api/harbor/capability.prepare",
  activate: "/api/harbor/capability.activate",
  status: "/api/harbor/capability.status",
  prepareRevoke: "/api/harbor/capability.prepareRevoke",
  revoke: "/api/harbor/capability.revoke",
  invoke: "/api/harbor/capability.invoke",
} as const);

async function post<T>(
  action: keyof typeof PATHS,
  args: unknown,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROWSER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(PATHS[action], {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
  } catch {
    throw new CapabilityTransportError();
  } finally {
    clearTimeout(timeout);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedResponseText(response, MAX_HARBOR_RESPONSE_BYTES));
  } catch {
    throw new Error("The capability response was invalid or too large.");
  }
  const envelope = EnvelopeSchema(schema).safeParse(payload);
  if (envelope.success) {
    const parsed = envelope.data as
      | Readonly<{ ok: true; data: T }>
      | Readonly<{ ok: false; error: { code?: string; message: string } }>;
    if (response.ok && parsed.ok) return parsed.data;
    if (!parsed.ok) {
      throw new CapabilityRequestError(
        parsed.error.code ?? "CAPABILITY_OPERATION_FAILED",
        parsed.error.message,
      );
    }
  }
  throw new Error("The capability transition was rejected.");
}

function bindGrant(
  grant: CapabilityGrant,
  expected: Readonly<{
    account: string;
    capabilityRef: string;
    generation?: number;
    state?: CapabilityGrant["state"];
  }>,
): CapabilityGrant {
  if (
    grant.account !== expected.account || grant.network !== "testnet" ||
    grant.capabilityRef !== expected.capabilityRef ||
    (expected.generation !== undefined && grant.generation !== expected.generation) ||
    (expected.state !== undefined && grant.state !== expected.state)
  ) throw new Error("The capability response changed the pending account, network, reference, generation, or state.");
  return grant;
}

export function prepareCapability(
  account: string,
  now = new Date(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PreparedCapability> {
  if (!Number.isFinite(now.getTime())) throw new Error("Capability preparation time is invalid.");
  const notBefore = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  return post("prepare", {
    account,
    network: "testnet",
    service: "mock.catalog",
    operation: "read",
    amount: { unit: "request", value: "1" },
    destination: "local-fixture-catalog",
    not_before: notBefore,
    expires_at: expiresAt,
    max_uses: 3,
    rate_limit: { window_seconds: 60, max_calls: 3 },
  }, PreparedSchema, fetchImpl).then((prepared) => {
    const grant = bindGrant(prepared.grant, {
      account,
      capabilityRef: prepared.grant.capabilityRef,
      state: "prepared",
    });
    if (
      grant.notBefore !== notBefore || grant.expiresAt !== expiresAt ||
      grant.maxUses !== 3 || grant.uses !== 0 ||
      grant.rateLimit.windowSeconds !== 60 || grant.rateLimit.maxCalls !== 3
    ) {
      throw new Error("The capability response changed the requested time or quota bounds.");
    }
    return prepared;
  });
}

export function activateCapability(
  account: string,
  review: CapabilityOwnerReview,
  ownerProof: CapabilityOwnerProof,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CapabilityGrant> {
  return post("activate", {
    account,
    network: "testnet",
    capability_ref: review.capability_ref,
    generation: review.generation,
    approval_digest: review.approval_digest,
    owner_proof: ownerProof,
  }, CapabilityGrantSchema, fetchImpl).then((grant) => bindGrant(grant, {
    account,
    capabilityRef: review.capability_ref,
    generation: review.generation,
    state: "active",
  }));
}

export function readCapability(
  account: string,
  capabilityRef: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CapabilityGrant> {
  return post("status", {
    account,
    network: "testnet",
    capability_ref: capabilityRef,
  }, CapabilityGrantSchema, fetchImpl).then((grant) => bindGrant(grant, {
    account,
    capabilityRef,
  }));
}

export function prepareCapabilityRevocation(
  account: string,
  capabilityRef: string,
  requestId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PreparedCapabilityRevocation> {
  return post("prepareRevoke", {
    account,
    network: "testnet",
    capability_ref: capabilityRef,
    request_id: requestId,
  }, PreparedRevocationSchema, fetchImpl).then((prepared) => {
    if (prepared.request_id !== requestId || prepared.owner_review.capability_ref !== capabilityRef ||
      prepared.owner_review.tx_json.Account !== account || prepared.owner_review.network !== "testnet") {
      throw new Error("The capability revocation response changed the pending request binding.");
    }
    return prepared;
  });
}

export function revokeCapability(
  account: string,
  review: CapabilityOwnerReview,
  ownerProof: CapabilityOwnerProof,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CapabilityGrant> {
  return post("revoke", {
    account,
    network: "testnet",
    capability_ref: review.capability_ref,
    generation: review.generation,
    approval_digest: review.approval_digest,
    owner_proof: ownerProof,
  }, CapabilityGrantSchema, fetchImpl).then((grant) => bindGrant(grant, {
    account,
    capabilityRef: review.capability_ref,
    generation: review.generation,
    state: "revoked",
  }));
}

export function invokeCapability(
  account: string,
  capabilityRef: string,
  generation: number,
  requestId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CapabilityInvocation> {
  return post("invoke", {
    account,
    network: "testnet",
    capability_ref: capabilityRef,
    generation,
    request_id: requestId,
    service: "mock.catalog",
    operation: "read",
    amount: { unit: "request", value: "1" },
    destination: "local-fixture-catalog",
    input: { resource: "ledger-docs" },
  }, CapabilityInvocationSchema, fetchImpl).then((result) => {
    if (
      result.capabilityRef !== capabilityRef || result.generation !== generation ||
      result.requestId !== requestId || result.data?.resource === "market-fixture"
    ) {
      throw new Error("The capability invocation response changed the exact recovery tuple.");
    }
    return result;
  });
}

export const CAPABILITY_SCOPE = Object.freeze({
  service: "mock.catalog",
  operation: "read",
  destination: "local-fixture-catalog",
  amount: "1 request",
} as const);
