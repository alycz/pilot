import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import { LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO } from "./local-x402-isolated-v1";

export const X402_MAX_PRICE_DROPS = 100_000;
export const X402_MERCHANT_BODY_MAX_BYTES = 64 * 1024;
export const X402_MERCHANT_JSON_MAX_DEPTH = 16;
export const X402_MERCHANT_JSON_MAX_NODES = 2_000;
export const X402_MERCHANT_JSON_MAX_STRING_BYTES = 16 * 1024;
export const X402_MERCHANT_JSON_MAX_KEY_BYTES = 256;

const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const TRANSACTION_HASH = /^[A-F0-9]{64}$/;
const encoder = new TextEncoder();

export const X402ClassicAddressSchema = z
  .string()
  .refine(isValidClassicAddress, "must be a valid XRPL classic address");

export const X402IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(PRINTABLE_ASCII, "must contain only printable ASCII characters");

export const X402MaxPriceDropsSchema = z
  .string()
  .max(6)
  .regex(CANONICAL_POSITIVE_INTEGER, "must be a canonical positive integer")
  .refine(
    (value) => BigInt(value) <= BigInt(X402_MAX_PRICE_DROPS),
    `must be at most ${X402_MAX_PRICE_DROPS} drops`,
  );

export const X402PayRequestSchema = z
  .object({
    owner: X402ClassicAddressSchema,
    network: z.literal("testnet"),
    resource: z.literal("compare"),
    max_price_drops: X402MaxPriceDropsSchema,
    idempotency_key: X402IdempotencyKeySchema,
    pay_to: z.literal(LOCAL_X402_ISOLATED_V1_MERCHANT_PAY_TO).optional(),
  })
  .strict();

export const X402PayArgsSchema = X402PayRequestSchema;

const PaymentIdSchema = z.string().min(1).max(200);
const InvoiceIdSchema = z
  .string()
  .min(1)
  .refine((value) => encoder.encode(value).byteLength <= 200, "must be at most 200 UTF-8 bytes");
const AmountDropsSchema = z
  .string()
  .max(6)
  .regex(CANONICAL_POSITIVE_INTEGER, "must be a canonical positive integer")
  .refine((value) => BigInt(value) <= 100_000n, "must be at most 100000 drops");
const FeeDropsSchema = z
  .string()
  .max(3)
  .regex(CANONICAL_POSITIVE_INTEGER, "must be a canonical positive integer")
  .refine((value) => BigInt(value) <= 100n, "must be at most 100 drops");
const TransactionHashSchema = z.string().regex(TRANSACTION_HASH);
const LedgerIndexSchema = z.number().int().safe().positive();

function plainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate untrusted parsed JSON without recursive schema traversal. */
function boundedMerchantJson(value: unknown): value is Record<string, unknown> {
  if (!plainJsonObject(value)) return false;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (
      nodes > X402_MERCHANT_JSON_MAX_NODES ||
      current.depth > X402_MERCHANT_JSON_MAX_DEPTH
    ) {
      return false;
    }
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value === "string") {
      if (encoder.encode(current.value).byteLength > X402_MERCHANT_JSON_MAX_STRING_BYTES) {
        return false;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (!plainJsonObject(current.value) || Object.getOwnPropertySymbols(current.value).length > 0) {
      return false;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (encoder.encode(key).byteLength > X402_MERCHANT_JSON_MAX_KEY_BYTES) return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }

  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= X402_MERCHANT_BODY_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * The merchant body is untrusted JSON. The service enforces the raw byte cap
 * before decoding; this schema also bounds parsed complexity at every service
 * and durable-state seam.
 */
export const X402MerchantBodySchema = z.custom<Record<string, unknown>>(
  boundedMerchantJson,
  "merchant JSON exceeds the bounded object contract",
);

/**
 * Public compare responses are intentionally narrower than the merchant JSON
 * retained by the payment service for settlement recovery. The local merchant
 * contract has one fixed key and two fixed venue identifiers, so no arbitrary
 * merchant-controlled property name or value can cross the operation boundary.
 */
export const X402PublicCompareBodySchema = z
  .object({
    comparison: z.tuple([z.literal("dex"), z.literal("amm")]),
  })
  .strict();

export const X402DeliveredResponseSchema = z
  .object({
    status: z.literal("delivered"),
    payment_id: PaymentIdSchema,
    idempotency_key: X402IdempotencyKeySchema,
    owner: X402ClassicAddressSchema,
    network: z.literal("testnet"),
    resource: z.literal("compare"),
    invoice_id: InvoiceIdSchema,
    amount_drops: AmountDropsSchema,
    fee_drops: FeeDropsSchema,
    payer: X402ClassicAddressSchema,
    pay_to: X402ClassicAddressSchema,
    tx_hash: TransactionHashSchema,
    validated_ledger_index: LedgerIndexSchema,
    merchant: z
      .object({
        status: z.literal(200),
        content_type: z.literal("application/json"),
        body: X402MerchantBodySchema,
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.payer !== value.owner, {
    message: "payer must be a dedicated account distinct from owner",
    path: ["payer"],
  })
  .refine(
    (value) => BigInt(value.amount_drops) + BigInt(value.fee_drops) <= 100_100n,
    { message: "amount plus fee exceeds the approved payment budget" },
  );

export const X402PublicDeliveredResponseSchema = z
  .object({
    status: z.literal("delivered"),
    payment_id: PaymentIdSchema,
    idempotency_key: X402IdempotencyKeySchema,
    owner: X402ClassicAddressSchema,
    network: z.literal("testnet"),
    resource: z.literal("compare"),
    invoice_id: InvoiceIdSchema,
    amount_drops: AmountDropsSchema,
    fee_drops: FeeDropsSchema,
    payer: X402ClassicAddressSchema,
    pay_to: X402ClassicAddressSchema,
    tx_hash: TransactionHashSchema,
    validated_ledger_index: LedgerIndexSchema,
    merchant: z
      .object({
        status: z.literal(200),
        content_type: z.literal("application/json"),
        body: X402PublicCompareBodySchema,
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.payer !== value.owner, {
    message: "payer must be a dedicated account distinct from owner",
    path: ["payer"],
  })
  .refine(
    (value) => BigInt(value.amount_drops) + BigInt(value.fee_drops) <= 100_100n,
    { message: "amount plus fee exceeds the approved payment budget" },
  );

export const X402SettlementUnknownResponseSchema = z
  .object({
    status: z.literal("settlement_unknown"),
    payment_id: PaymentIdSchema,
    idempotency_key: X402IdempotencyKeySchema,
    network: z.literal("testnet"),
    owner: X402ClassicAddressSchema,
    resource: z.literal("compare"),
    request_fingerprint: TransactionHashSchema,
    tx_hash: TransactionHashSchema,
    last_ledger_sequence: LedgerIndexSchema,
    retry_after_seconds: z.number().int().safe().positive(),
  })
  .strict();

export const X402PayResponseSchema = z.discriminatedUnion("status", [
  X402DeliveredResponseSchema,
  X402SettlementUnknownResponseSchema,
]);

export const X402PublicPayResponseSchema = z.discriminatedUnion("status", [
  X402PublicDeliveredResponseSchema,
  X402SettlementUnknownResponseSchema,
]);

export type X402PayRequest = z.infer<typeof X402PayRequestSchema>;
export type X402PayArgs = X402PayRequest;
export type X402DeliveredResponse = z.infer<
  typeof X402DeliveredResponseSchema
>;
export type X402SettlementUnknownResponse = z.infer<
  typeof X402SettlementUnknownResponseSchema
>;
export type X402PayResponse = z.infer<typeof X402PayResponseSchema>;
export type X402PublicPayResponse = z.infer<
  typeof X402PublicPayResponseSchema
>;

export type X402Service = {
  pay(principal: string, request: X402PayRequest): Promise<X402PayResponse>;
};

/** Parse a merchant response only after checking its original byte length. */
export function parseX402MerchantJsonBody(
  raw: Uint8Array,
): z.infer<typeof X402MerchantBodySchema> {
  if (raw.byteLength > X402_MERCHANT_BODY_MAX_BYTES) {
    throw new RangeError(
      `Merchant response exceeds ${X402_MERCHANT_BODY_MAX_BYTES} bytes`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      raw,
    );
  } catch {
    throw new SyntaxError("Merchant response is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new SyntaxError("Merchant response is not valid JSON");
  }
  return X402MerchantBodySchema.parse(value);
}
