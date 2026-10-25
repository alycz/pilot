import { EnvelopeSchema } from "@pilot/contracts";
import { MAX_HARBOR_RESPONSE_BYTES, readBoundedResponseText } from "@pilot/harbor-client";
import { z } from "zod";

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const ClassicAddressSchema = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
const HashSchema = z.string().regex(/^[A-F0-9]{64}$/);
const HexBytesSchema = z.string().regex(/^(?:[A-Fa-f0-9]{2})+$/);
const TransactionSchema = z.record(z.string(), z.unknown());
const TermsSchema = z.object({
  counterparty: ClassicAddressSchema,
  amount_drops: z.string().regex(/^[1-9][0-9]{0,15}$/),
  finish_after: z.number().int().min(1).max(0xffff_ffff).optional(),
  cancel_after: z.number().int().min(1).max(0xffff_ffff).optional(),
  condition: HexBytesSchema.max(512).optional(),
}).strict().superRefine((terms, context) => {
  if (terms.finish_after === undefined && terms.cancel_after === undefined) {
    context.addIssue({ code: "custom", message: "An escrow time bound is required." });
  }
  if (terms.finish_after !== undefined && terms.cancel_after !== undefined &&
    terms.finish_after >= terms.cancel_after) {
    context.addIssue({ code: "custom", message: "finish_after must precede cancel_after." });
  }
  if (terms.condition !== undefined && terms.cancel_after === undefined) {
    context.addIssue({ code: "custom", message: "Conditioned escrow requires cancel_after." });
  }
});
const EvidenceSchema = z.object({
  approval_id: IdentifierSchema,
  tx_hash: HashSchema,
  validated_ledger_index: z.number().int().positive(),
  validated: z.literal(true),
  engine_result: z.literal("tesSUCCESS"),
  tx_json: TransactionSchema,
}).strict();
const ApprovalSchema = z.object({
  action: z.enum(["create", "release", "cancel"]),
  approval_id: IdentifierSchema,
  expires_at: z.string().datetime(),
  idempotency_key: IdentifierSchema,
  require_owner_approval: z.literal(true),
  validated_ledger_index: z.number().int().positive(),
  validated_account_sequence: z.number().int().nonnegative(),
  max_fee_drops: z.string().regex(/^[1-9][0-9]{0,15}$/),
  tx_json: TransactionSchema,
}).strict();

export const WorkAgreementPublicStateSchema = z.object({
  profile: z.literal("local-testnet-mock-v1"),
  status: z.enum([
    "awaiting_approval", "submitting", "unknown", "active", "released", "cancelled",
    "rejected", "expired",
  ]),
  revision: z.number().int().nonnegative(),
  outcome: z.enum(["prepared", "replay", "submitted", "unknown", "rejected", "pending", "validated", "not_included", "status"]),
  simulation: z.literal(true),
  settlement_provenance: z.literal("local-mock-simulated-settlement"),
  live_validation_claimed: z.literal(false),
  physical_device_inferred: z.literal(false),
  speculos_conformance_claimed: z.literal(false),
  owner_key_custody: z.literal(false),
  network_requests_made: z.literal(0),
  agreement_id: IdentifierSchema,
  owner: ClassicAddressSchema,
  network: z.literal("testnet"),
  terms: TermsSchema,
  action: z.enum(["create", "release", "cancel"]).optional(),
  approval: ApprovalSchema.optional(),
  attempt_id: IdentifierSchema.optional(),
  tx_hash: HashSchema.optional(),
  offer_sequence: z.number().int().positive().optional(),
  create_evidence: EvidenceSchema.optional(),
  terminal_evidence: EvidenceSchema.optional(),
  last_resolution: z.object({
    approval_id: IdentifierSchema,
    idempotency_key: IdentifierSchema,
    action: z.enum(["create", "release", "cancel"]),
    outcome: z.enum(["validated", "rejected", "not_included"]),
  }).strict().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict().superRefine((state, context) => {
  if ((state.status === "awaiting_approval") !== (state.approval !== undefined)) {
    context.addIssue({ code: "custom", message: "Awaiting approval state must include exactly one approval." });
  }
  if (state.status === "unknown" && (
    state.approval === undefined || state.attempt_id === undefined || state.tx_hash === undefined
  )) context.addIssue({ code: "custom", message: "Unknown settlement state is incomplete." });
  if (["active", "released", "cancelled"].includes(state.status) && (
    state.create_evidence === undefined || state.offer_sequence === undefined
  )) context.addIssue({ code: "custom", message: "Validated agreement state is incomplete." });
  if (["released", "cancelled"].includes(state.status) && state.terminal_evidence === undefined) {
    context.addIssue({ code: "custom", message: "Terminal agreement state requires terminal evidence." });
  }
});

export type WorkAgreementPublicState = z.infer<typeof WorkAgreementPublicStateSchema>;
export type WorkAgreementTermsRequest = z.infer<typeof TermsSchema>;

export class WorkAgreementRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkAgreementRequestError";
  }
}

const OPERATION_PATHS = Object.freeze({
  prepare: "/api/harbor/workAgreement.prepare",
  submit: "/api/harbor/workAgreement.submit",
  recover: "/api/harbor/workAgreement.recover",
  reject: "/api/harbor/workAgreement.reject",
  status: "/api/harbor/workAgreement.status",
} as const);

type Base = Readonly<{
  owner: string;
  network: "testnet";
  agreement_id: string;
}>;
export type WorkAgreementPrepareRequest = Base & Readonly<{
  action: "create" | "release" | "cancel";
  idempotency_key: string;
  approval_expires_at: string;
  terms: WorkAgreementTermsRequest;
  fulfillment?: string;
}>;
export type WorkAgreementDecisionRequest = Base & Readonly<{
  approval_id: string;
  idempotency_key: string;
}>;
export type WorkAgreementSubmitRequest = WorkAgreementDecisionRequest & Readonly<{
  attempt_id: string;
  signed_blob: string;
}>;
export type WorkAgreementRequest =
  | Readonly<{ action: "prepare"; args: WorkAgreementPrepareRequest }>
  | Readonly<{ action: "submit"; args: WorkAgreementSubmitRequest }>
  | Readonly<{ action: "recover" | "reject"; args: WorkAgreementDecisionRequest }>
  | Readonly<{ action: "status"; args: Base }>;

const Envelope = EnvelopeSchema(WorkAgreementPublicStateSchema);

/** Fixed same-origin client; callers cannot choose a URL, header, network, or relay. */
export async function requestWorkAgreement(
  request: WorkAgreementRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkAgreementPublicState> {
  const response = await fetchImpl(OPERATION_PATHS[request.action], {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(request.args),
    cache: "no-store",
    credentials: "same-origin",
  });
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedResponseText(response, MAX_HARBOR_RESPONSE_BYTES));
  } catch {
    throw new Error("The work-agreement response was invalid or too large.");
  }
  const envelope = Envelope.safeParse(payload);
  if (envelope.success) {
    if (response.ok && envelope.data.ok) return envelope.data.data;
    if (!envelope.data.ok) {
      throw new WorkAgreementRequestError(
        envelope.data.error.code ?? "WORK_AGREEMENT_OPERATION_FAILED",
        envelope.data.error.message,
      );
    }
  }
  throw new Error("The work-agreement transition was rejected.");
}

export const WORK_AGREEMENT_RECOVERY_KEY = "pilot.work-agreement.recovery.v1";
export function workAgreementRecoveryKey(owner: string, network: "testnet"): string {
  return `${WORK_AGREEMENT_RECOVERY_KEY}:${network}:${ClassicAddressSchema.parse(owner)}`;
}
const WorkAgreementRecoveryBaseSchema = z.object({
  version: z.literal(1),
  owner: ClassicAddressSchema,
  network: z.literal("testnet"),
  agreement_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  retain_until: z.string().datetime(),
}).strict();
const WorkAgreementTrackingRecoverySchema = WorkAgreementRecoveryBaseSchema.extend({
  phase: z.enum(["prepare_pending", "prepare_unknown", "tracking"]),
}).strict();
const WorkAgreementSubmissionRecoverySchema = WorkAgreementRecoveryBaseSchema.extend({
  phase: z.enum(["submission_pending", "submission_unknown"]),
  approval_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  action: z.enum(["create", "release", "cancel"]),
  expires_at: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const expiry = Date.parse(value.expires_at);
  const retained = Date.parse(value.retain_until);
  if (retained <= expiry || retained > expiry + 7 * 24 * 60 * 60_000) {
    context.addIssue({ code: "custom", message: "Recovery retention must be after approval expiry and at most seven days." });
  }
});
export const WorkAgreementRecoverySchema = z.union([
  WorkAgreementTrackingRecoverySchema,
  WorkAgreementSubmissionRecoverySchema,
]);
export type WorkAgreementRecovery = z.infer<typeof WorkAgreementRecoverySchema>;
export type WorkAgreementRecoveryInspection =
  | Readonly<{ status: "absent" | "expired" | "invalid" }>
  | Readonly<{ status: "valid"; value: WorkAgreementRecovery }>;

export function isWorkAgreementSubmissionRecovery(
  value: WorkAgreementRecovery | null | undefined,
): value is z.infer<typeof WorkAgreementSubmissionRecoverySchema> {
  return value?.phase === "submission_pending" || value?.phase === "submission_unknown";
}

/** Persists only bounded recovery references—never a signed blob or owner key. */
export function saveWorkAgreementRecovery(storage: Storage, value: WorkAgreementRecovery): void {
  const parsed = WorkAgreementRecoverySchema.parse(value);
  storage.setItem(
    workAgreementRecoveryKey(parsed.owner, parsed.network),
    JSON.stringify(parsed),
  );
}

export function loadWorkAgreementRecovery(
  storage: Storage,
  owner: string,
  network: "testnet",
  now = Date.now(),
): WorkAgreementRecovery | null {
  const inspected = inspectWorkAgreementRecovery(storage, owner, network, now);
  return inspected.status === "valid" ? inspected.value : null;
}

export function inspectWorkAgreementRecovery(
  storage: Storage,
  owner: string,
  network: "testnet",
  now = Date.now(),
): WorkAgreementRecoveryInspection {
  const raw = storage.getItem(workAgreementRecoveryKey(owner, network));
  if (raw === null) return { status: "absent" };
  if (raw.length > 4_096) return { status: "invalid" };
  try {
    const parsed = WorkAgreementRecoverySchema.parse(JSON.parse(raw));
    if (parsed.owner !== owner || parsed.network !== network) return { status: "invalid" };
    if (Date.parse(parsed.retain_until) <= now) return { status: "expired" };
    return { status: "valid", value: parsed };
  } catch {
    return { status: "invalid" };
  }
}

export function clearWorkAgreementRecovery(
  storage: Storage,
  owner: string,
  network: "testnet",
): void {
  storage.removeItem(workAgreementRecoveryKey(owner, network));
}
