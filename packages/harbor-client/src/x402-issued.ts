import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

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

function boundedJson(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const encoder = new TextEncoder();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 2_000 || current.depth > 16) return false;
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value === "string") {
      if (encoder.encode(current.value).byteLength > 16 * 1024) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) return false;
    const object = current.value as Record<string, unknown>;
    if (Object.getPrototypeOf(object) !== Object.prototype || Object.getOwnPropertySymbols(object).length > 0) return false;
    for (const [key, child] of Object.entries(object)) {
      if (encoder.encode(key).byteLength > 256) return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= 64 * 1024;
  } catch {
    return false;
  }
}

const AddressSchema = z.string().refine(isValidClassicAddress);
export const X402IssuedAmountSchema = z.string().refine(canonicalDecimal);
export const X402IssuedAssetSchema = z.object({
  kind: z.literal("xrpl-issued"),
  network: z.literal("xrpl:1"),
  currency: z.string().regex(CURRENCY),
  issuer: AddressSchema,
}).strict();
export const X402IssuedMerchantBindingSchema = z.object({
  id: z.string().regex(OPAQUE),
  resource_method: z.literal("POST"),
  resource_url: z.literal(X402_ISSUED_FIXTURE_RESOURCE_URL),
}).strict();

export const X402IssuedPayArgsSchema = z.object({
  owner: AddressSchema,
  network: z.literal("testnet"),
  resource: z.literal("compare"),
  session_scope: z.string().regex(OPAQUE),
  merchant: X402IssuedMerchantBindingSchema,
  asset: X402IssuedAssetSchema,
  max_amount: X402IssuedAmountSchema,
  pay_to: AddressSchema,
  idempotency_key: z.string().regex(OPAQUE),
}).strict().superRefine((request, context) => {
  if (request.asset.issuer === request.owner || request.asset.issuer === request.pay_to) {
    context.addIssue({ code: "custom", path: ["asset", "issuer"], message: "issuer must differ from payer and payee" });
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
  payer: AddressSchema,
  pay_to: AddressSchema,
  fee_drops: z.string().regex(DROPS).max(18),
  transaction_hash: z.string().regex(HASH),
  validated_ledger_index: z.number().int().safe().positive(),
  merchant_body: z.custom<Record<string, unknown>>(boundedJson),
}).strict();

export type X402IssuedPayArgs = z.infer<typeof X402IssuedPayArgsSchema>;
export type X402IssuedFixtureResult = z.infer<typeof X402IssuedFixtureResultSchema>;

function decimalParts(value: string): readonly [bigint, number] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(`${whole}${fraction}`), fraction.length];
}

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
