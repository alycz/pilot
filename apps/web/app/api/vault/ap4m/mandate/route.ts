import { scopedVaultPath, writeAp4mMandateNote } from "@pilot/vault";
import { z } from "zod";

import {
  assertWalletBoundVaultMutationAuthorized,
  errorResponse,
  json,
  objectBody,
} from "../../_lib/http";
import { getVaultService } from "../../_lib/service";

export const runtime = "nodejs";

const hashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const boundedNameSchema = z.string().trim().min(1).max(128).regex(/^[^\\/:\0\r\n]+$/);
const decimalSchema = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const dateSchema = z.string().max(35).refine((value) => !Number.isNaN(Date.parse(value)));
const openFinanceBase = {
  owner_name_hash: hashSchema,
  masked_account_label: z.string().trim().min(1).max(80).regex(/[•*…]/u).optional(),
  balance_snapshot: z.object({
    amount: decimalSchema,
    currency: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9]+$/),
  }).strict().optional(),
};

const mandateNoteRequestSchema = z.object({
  owner: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  mandate_id: boundedNameSchema,
  network: z.literal("testnet"),
  status: z.enum(["PENDING", "ACTIVE", "REVOKED", "EXPIRED"]),
  execution_type: z.literal("DEFERRED"),
  not_before: dateSchema,
  expires_at: dateSchema,
  constraints: z.object({
    currency: z.literal("USD"),
    per_payment_max: decimalSchema,
    total_max: decimalSchema,
    daily_max: decimalSchema,
    payees: z.array(boundedNameSchema).min(1).max(64),
    skus: z.array(boundedNameSchema).max(64).optional(),
  }).strict(),
  l1_digest: hashSchema,
  l2_digest: hashSchema,
  setup_tx_hashes: z.array(hashSchema).min(1).max(32),
  channels: z.array(z.object({
    merchant_id: boundedNameSchema,
    channel_id: hashSchema,
    amount_drops: decimalSchema,
  }).strict()).max(64),
  open_finance: z.discriminatedUnion("mode", [
    z.object({
      ...openFinanceBase,
      mode: z.literal("mock"),
      label: z.literal("Mastercard Open Finance · mock"),
    }).strict(),
    z.object({
      ...openFinanceBase,
      mode: z.literal("sandbox"),
      label: z.literal("Mastercard Open Finance · sandbox"),
    }).strict(),
  ]),
  recorded_at: dateSchema,
}).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const scope = assertWalletBoundVaultMutationAuthorized(request);
    const body = mandateNoteRequestSchema.parse(await objectBody(request));
    if (scope && (scope.owner !== body.owner || scope.network !== body.network)) {
      throw new Error("Vault wallet authorization does not match the mandate owner");
    }
    const { owner: _owner, ...noteInput } = body;
    const note = writeAp4mMandateNote(noteInput);
    const path = scope ? scopedVaultPath(scope, note.path) : note.path;
    await getVaultService().write(
      path,
      note.content,
      `vault: record AP4M mandate ${body.mandate_id}`,
    );
    return json({ ok: true, data: { path } });
  } catch (error) {
    return errorResponse(error);
  }
}
