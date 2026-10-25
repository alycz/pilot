import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import type { X402IssuedAsset } from "./exec/x402-issued-offline";
import { X402MerchantBodySchema } from "./x402-contract";

const CURRENCY = /^[0-9A-F]{40}$/;
const DECIMAL = /^(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?)$/;
const DROPS = /^[1-9][0-9]*$/;
const HASH = /^[A-F0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
export const X402_ISSUED_FIXTURE_RESOURCE_URL =
  "http://127.0.0.1:8000/api/x402/compare" as const;

function canonicalDecimal(value: string): boolean {
  return value.length <= 128 && DECIMAL.test(value) &&
    value.replace(".", "").replace(/^0+/, "").length <= 15;
}

const ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");
export const X402IssuedAmountSchema = z
  .string()
  .refine(canonicalDecimal, "must be a canonical positive XRPL issued amount");
export const X402IssuedAssetSchema: z.ZodType<X402IssuedAsset> = z.object({
  kind: z.literal("xrpl-issued"),
  network: z.literal("xrpl:1"),
  currency: z.string().regex(CURRENCY),
  issuer: ClassicAddressSchema,
}).strict();
export const X402IssuedMerchantBindingSchema = z.object({
  id: z.string().regex(OPAQUE),
  resource_method: z.literal("POST"),
  resource_url: z.literal(X402_ISSUED_FIXTURE_RESOURCE_URL),
}).strict();

export const X402IssuedPayRequestSchema = z.object({
  owner: ClassicAddressSchema,
  network: z.literal("testnet"),
  resource: z.literal("compare"),
  session_scope: z.string().regex(OPAQUE),
  merchant: X402IssuedMerchantBindingSchema,
  asset: X402IssuedAssetSchema,
  max_amount: X402IssuedAmountSchema,
  pay_to: ClassicAddressSchema,
  idempotency_key: z.string().regex(OPAQUE),
}).strict().superRefine((request, context) => {
  if (request.asset.issuer === request.owner || request.asset.issuer === request.pay_to) {
    context.addIssue({ code: "custom", path: ["asset", "issuer"], message: "issuer must be distinct from payer and payee" });
  }
  if (request.owner === request.pay_to) {
    context.addIssue({ code: "custom", path: ["pay_to"], message: "payer and payee must differ" });
  }
});

export const X402IssuedFixtureResultSchema = z.object({
  status: z.literal("fixture_delivered"),
  evidence: z.literal("deterministic-offline-fixture"),
  session_scope: z.string().regex(OPAQUE),
  merchant: X402IssuedMerchantBindingSchema,
  merchant_invoice_id: z.string().trim().min(1).max(200),
  idempotency_key: z.string().regex(OPAQUE),
  approval_digest: z.string().regex(HASH),
  asset: X402IssuedAssetSchema,
  amount: X402IssuedAmountSchema,
  payer: ClassicAddressSchema,
  pay_to: ClassicAddressSchema,
  fee_drops: z.string().regex(DROPS).max(18),
  transaction_hash: z.string().regex(HASH),
  validated_ledger_index: z.number().int().safe().positive(),
  merchant_body: X402MerchantBodySchema,
}).strict();

export type X402IssuedPayRequest = z.infer<typeof X402IssuedPayRequestSchema>;
export type X402IssuedFixtureResult = z.infer<typeof X402IssuedFixtureResultSchema>;
export type X402IssuedFixtureService = Readonly<{
  pay(principal: string, request: X402IssuedPayRequest): Promise<X402IssuedFixtureResult>;
}>;

function decimalParts(value: string): readonly [bigint, number] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(`${whole}${fraction}`), fraction.length];
}

/** Exact decimal comparison without IEEE-754 conversion. */
export function compareX402IssuedAmounts(left: string, right: string): number {
  const validatedLeft = X402IssuedAmountSchema.parse(left);
  const validatedRight = X402IssuedAmountSchema.parse(right);
  const [leftValue, leftScale] = decimalParts(validatedLeft);
  const [rightValue, rightScale] = decimalParts(validatedRight);
  const scale = Math.max(leftScale, rightScale);
  const normalizedLeft = leftValue * 10n ** BigInt(scale - leftScale);
  const normalizedRight = rightValue * 10n ** BigInt(scale - rightScale);
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}
