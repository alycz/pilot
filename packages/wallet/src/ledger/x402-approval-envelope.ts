import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

export const X402_OWNER_APPROVAL_DOMAIN = "pilot.x402.owner-approval" as const;

const HashSchema = z.string().regex(/^[A-F0-9]{64}$/);
const ClassicAddressSchema = z.string().refine(isValidClassicAddress, "invalid classic XRPL address");
const CurrencySchema = z.string().regex(/^[A-F0-9]{40}$/);
const CanonicalDecimalSchema = z.string().refine(
  (value) => /^(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9])$/.test(value) &&
    value.replace(".", "").replace(/^0+/, "").length <= 15,
  "amount must be a positive canonical decimal with at most 15 significant digits",
);
const CanonicalDropsSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
const SafeTextSchema = z.string().min(1).max(200).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 200 && !/[\u0000-\u001F\u007F-\u009F]/u.test(value),
  "value must be at most 200 UTF-8 bytes without control characters",
);
const ScopedTextSchema = SafeTextSchema.refine(
  (value) => new TextEncoder().encode(value).byteLength >= 8,
  "value must be at least 8 UTF-8 bytes",
);
const ResourceUrlSchema = z.string().min(1).max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    const loopbackHttp = url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    return (url.protocol === "https:" || loopbackHttp) &&
      url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}, "resource URL must be HTTPS or loopback HTTP without credentials or a fragment");

export const IssuedX402OwnerApprovalEnvelopeSchema = z.object({
  version: z.literal(1),
  domain: z.literal(X402_OWNER_APPROVAL_DOMAIN),
  approval_id: ScopedTextSchema,
  network: z.literal("xrpl:1"),
  execution_network: z.literal("testnet"),
  session_scope: ScopedTextSchema,
  idempotency_key: SafeTextSchema,
  merchant: z.object({
    id: ScopedTextSchema,
    resource_method: z.literal("POST"),
    resource_url: ResourceUrlSchema,
    pay_to: ClassicAddressSchema,
  }).strict(),
  asset: z.object({
    kind: z.literal("issued"),
    network: z.literal("xrpl:1"),
    namespace: z.literal("token"),
    currency: CurrencySchema,
    issuer: ClassicAddressSchema,
  }).strict(),
  amount: CanonicalDecimalSchema,
  owner: ClassicAddressSchema,
  quote_expires_at: z.string().datetime(),
  merchant_invoice_id: SafeTextSchema,
  transaction: z.object({
    fee_drops: CanonicalDropsSchema,
    sequence: z.number().int().nonnegative(),
    validated_ledger_index: z.number().int().positive(),
    last_ledger_sequence: z.number().int().positive(),
    source_tag: z.number().int().nonnegative().max(0xffff_ffff),
  }).strict(),
}).strict();

export type IssuedX402OwnerApprovalEnvelope = z.infer<typeof IssuedX402OwnerApprovalEnvelopeSchema>;

export type X402ApprovalCommitmentErrorCode =
  | "INVALID_APPROVAL_ENVELOPE"
  | "APPROVAL_DIGEST_MISMATCH"
  | "INVOICE_COMMITMENT_MISMATCH";

export class X402ApprovalCommitmentError extends Error {
  constructor(readonly code: X402ApprovalCommitmentErrorCode, message: string) {
    super(message);
    this.name = "X402ApprovalCommitmentError";
  }
}

/**
 * Strict RFC-8785/JCS-compatible subset used by both Pilot and Harbor.
 * The validated envelope contains only fixed ASCII object keys, strings, and
 * safe integers. Arrays, nulls, booleans, floats, and extension fields never
 * enter this serializer.
 */
export function canonicalIssuedX402ApprovalEnvelope(input: unknown): string {
  const envelope = IssuedX402OwnerApprovalEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw new X402ApprovalCommitmentError(
      "INVALID_APPROVAL_ENVELOPE",
      "The x402 owner-approval envelope is invalid.",
    );
  }

  function canonical(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    throw new X402ApprovalCommitmentError(
      "INVALID_APPROVAL_ENVELOPE",
      "The x402 owner-approval envelope contains an unsupported value.",
    );
  }

  return canonical(envelope.data);
}

export async function digestIssuedX402ApprovalEnvelope(input: unknown): Promise<string> {
  const canonical = canonicalIssuedX402ApprovalEnvelope(input);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export async function verifyIssuedX402ApprovalCommitment(input: Readonly<{
  envelope: unknown;
  approvalDigest: string;
  invoiceId: unknown;
}>): Promise<string> {
  if (!HashSchema.safeParse(input.approvalDigest).success) {
    throw new X402ApprovalCommitmentError(
      "APPROVAL_DIGEST_MISMATCH",
      "The x402 approval digest is invalid.",
    );
  }
  const expected = await digestIssuedX402ApprovalEnvelope(input.envelope);
  if (input.approvalDigest !== expected) {
    throw new X402ApprovalCommitmentError(
      "APPROVAL_DIGEST_MISMATCH",
      "The x402 approval digest does not commit to the reviewed envelope.",
    );
  }
  if (input.invoiceId !== expected) {
    throw new X402ApprovalCommitmentError(
      "INVOICE_COMMITMENT_MISMATCH",
      "The signed Payment InvoiceID does not commit to the reviewed envelope.",
    );
  }
  return expected;
}
