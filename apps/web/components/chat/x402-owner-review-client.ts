import {
  MAX_X402_RESPONSE_BYTES,
  readBoundedResponseText,
} from "@pilot/harbor-client";
import { EnvelopeSchema } from "@pilot/contracts";
import { z } from "zod";

import {
  X402_APPROVED_RECEIVER,
  X402_MAX_PRICE_DROPS,
} from "./x402-operation-state";

const ClassicAddressSchema = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
const HashSchema = z.string().regex(/^[A-F0-9]{64}$/);
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const UnsignedTransactionSchema = z.record(z.string(), z.unknown());

export const OwnerReviewPublicStateSchema = z.object({
  status: z.enum([
    "awaiting_approval",
    "relaying",
    "settlement_unknown",
    "settled",
    "delivering",
    "delivered",
    "rejected",
    "expired",
  ]),
  approval_id: IdentifierSchema,
  approval_digest: HashSchema,
  idempotency_key: IdentifierSchema,
  owner: ClassicAddressSchema,
  network: z.literal("testnet"),
  resource_url: z.literal("http://127.0.0.1:8000/api/x402/compare"),
  pay_to: z.literal(X402_APPROVED_RECEIVER),
  asset: z.literal("XRP"),
  amount_drops: z.literal(X402_MAX_PRICE_DROPS),
  quote_expires_at: z.string().datetime(),
  validated_ledger_index: z.number().int().positive(),
  validated_account_sequence: z.number().int().nonnegative(),
  expected_source_tag: z.number().int().nonnegative().max(0xffff_ffff),
  tx_json: UnsignedTransactionSchema.optional(),
  tx_hash: HashSchema.optional(),
  reason: z.string().min(1).max(128).optional(),
  receipt: z.object({
    status: z.literal("delivered"),
    simulation: z.literal(true),
    approval_id: IdentifierSchema,
    idempotency_key: IdentifierSchema,
    owner: ClassicAddressSchema,
    network: z.literal("testnet"),
    resource_url: z.string().min(1).max(256),
    pay_to: z.literal(X402_APPROVED_RECEIVER),
    asset: z.literal("XRP"),
    amount_drops: z.literal(X402_MAX_PRICE_DROPS),
    tx_hash: HashSchema,
    validated_ledger_index: z.number().int().positive(),
    body: z.unknown(),
    provenance: z.literal("local-mock-simulated-settlement"),
  }).strict().optional(),
}).strict().superRefine((state, context) => {
  if ((state.status === "delivered") !== (state.receipt !== undefined)) {
    context.addIssue({ code: "custom", message: "Delivered x402 state must include one receipt." });
  }
  if (state.receipt && (
    state.receipt.approval_id !== state.approval_id ||
    state.receipt.idempotency_key !== state.idempotency_key ||
    state.receipt.owner !== state.owner ||
    state.receipt.tx_hash !== state.tx_hash
  )) {
    context.addIssue({ code: "custom", message: "The x402 receipt is outside the reviewed approval." });
  }
});

export type OwnerReviewPublicState = z.infer<typeof OwnerReviewPublicStateSchema>;

export class OwnerReviewRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OwnerReviewRequestError";
  }
}

export function isMissingOwnerReviewApproval(error: unknown): boolean {
  return error instanceof OwnerReviewRequestError && error.code === "APPROVAL_NOT_FOUND";
}

const OwnerReviewEnvelopeSchema = EnvelopeSchema(OwnerReviewPublicStateSchema);

const OPERATION_PATHS = Object.freeze({
  prepare: "/api/harbor/x402.ownerReviewPrepare",
  reject: "/api/harbor/x402.ownerReviewReject",
  submit: "/api/harbor/x402.ownerReviewSubmit",
  recover: "/api/harbor/x402.ownerReviewRecover",
} as const);

type OwnerReviewAction = keyof typeof OPERATION_PATHS;

export type OwnerReviewPrepareRequest = Readonly<{
  owner: string;
  network: "testnet";
  max_price_drops: typeof X402_MAX_PRICE_DROPS;
  idempotency_key: string;
}>;

export type OwnerReviewDecisionRequest = Readonly<{
  owner: string;
  network: "testnet";
  idempotency_key: string;
  approval_id: string;
}>;

export type OwnerReviewSubmitRequest = OwnerReviewDecisionRequest & Readonly<{
  approval_digest: string;
  signed_blob: string;
}>;

export type OwnerReviewRequest =
  | Readonly<{ action: "prepare"; args: OwnerReviewPrepareRequest }>
  | Readonly<{ action: "reject" | "recover"; args: OwnerReviewDecisionRequest }>
  | Readonly<{ action: "submit"; args: OwnerReviewSubmitRequest }>;

/**
 * Fixed same-origin client: callers choose one named transition, never a URL,
 * method, credential, header, merchant, amount, asset, or network.
 */
export async function requestOwnerReviewedX402(
  request: OwnerReviewRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OwnerReviewPublicState> {
  const response = await fetchImpl(OPERATION_PATHS[request.action], {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(request.args),
    cache: "no-store",
    credentials: "same-origin",
  });
  let payload: unknown;
  try {
    const text = await readBoundedResponseText(response, MAX_X402_RESPONSE_BYTES);
    payload = JSON.parse(text);
  } catch {
    throw new Error("The owner-reviewed x402 response was invalid or too large.");
  }
  const envelope = OwnerReviewEnvelopeSchema.safeParse(payload);
  if (envelope.success) {
    if (response.ok && envelope.data.ok) return envelope.data.data;
    if (!envelope.data.ok) {
      throw new OwnerReviewRequestError(
        envelope.data.error.code ?? "OWNER_REVIEW_OPERATION_FAILED",
        envelope.data.error.message,
      );
    }
  }
  throw new Error("The owner-reviewed x402 transition was rejected.");
}
