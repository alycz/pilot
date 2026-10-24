import { randomUUID } from "node:crypto";

import {
  Ap4mReceiptSchema,
  MandateSchema,
  MerchantSchema,
  type Envelope,
  type Network,
} from "@pilot/contracts";
import { tool, type Tool } from "ai";
import { z } from "zod";

export interface Ap4mHarborRest {
  op(name: any, args: any): Promise<Envelope<unknown>>;
}

export interface ActiveAp4mMandate {
  mandate_id: string;
  owner: string;
}

export interface Ap4mToolContext {
  activeMandate?: ActiveAp4mMandate;
  createIdempotencyKey?: () => string;
  revokeCredential?: (input: {
    mandate_id: string;
    owner: string;
    network: "testnet";
  }) => Promise<{ status: "revoked" }>;
}

export interface CreateAp4mToolsOptions {
  account: { budget_account: string };
  network: Network;
  harborRest: Ap4mHarborRest;
  ap4m?: Ap4mToolContext;
}

const BoundedIdSchema = z.string().trim().min(1).max(128);

export const Ap4mPurchaseToolInputSchema = z
  .object({
    merchant_id: BoundedIdSchema,
    sku: BoundedIdSchema,
  })
  .strict();

export const MerchantsSearchToolInputSchema = z
  .object({ query: z.string().trim().min(1).max(200) })
  .strict();

const DataSummaryValueSchema = z.union([
  z.number().finite(),
  z.string().max(200),
]);

export const Ap4mModelResultSchema = z
  .object({
    status: z.enum(["completed", "pending"]),
    merchant: BoundedIdSchema,
    sku: BoundedIdSchema,
    amount: z
      .object({
        asset: z.record(z.string(), z.unknown()),
        value: z.string().max(128),
      })
      .strict(),
    settlement: z.enum([
      "validated",
      "claim_accepted",
      "redeemed",
      "settlement_unknown",
    ]),
    receipt_id: BoundedIdSchema,
    data_summary: z.record(z.string(), DataSummaryValueSchema),
  })
  .strict();
export type Ap4mModelResult = z.infer<typeof Ap4mModelResultSchema>;

const IdentifierSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const EnumSchema = z.string().max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/);
const DecimalStringSchema = z
  .string()
  .max(128)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const OmittedMerchantTextSchema = z.string().max(200);
const TransactionHashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const ChannelIdSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const PositiveDropsSchema = z.string().regex(/^[1-9]\d*$/);

const YieldReportDataSchema = z
  .object({
    schema_id: z.literal("yield_report_v1"),
    venue: IdentifierSchema,
    apr_percent: DecimalStringSchema,
    tvl_usd: DecimalStringSchema,
    risk: EnumSchema,
    as_of_basis: OmittedMerchantTextSchema.optional(),
  })
  .strict();

const RiskScoreDataSchema = z
  .object({
    schema_id: z.literal("risk_score_v1"),
    venue: IdentifierSchema,
    score: z.number().finite().min(0).max(100),
    rating: EnumSchema,
    factors: z.array(OmittedMerchantTextSchema).max(16).optional(),
    as_of_basis: OmittedMerchantTextSchema.optional(),
  })
  .strict();

/**
 * Parse one known merchant response schema and expose only its fixed scalar
 * projection. The explicitly accepted prose fields are omitted from model
 * context; hybrids, unknown fields, and type-invalid values fail closed.
 */
export function projectAp4mDataSummary(
  data: Record<string, unknown>,
): Record<string, string | number> {
  if (data.schema_id === "yield_report_v1") {
    const value = YieldReportDataSchema.parse(data);
    return {
      schema_id: value.schema_id,
      venue: value.venue,
      apr_percent: value.apr_percent,
      tvl_usd: value.tvl_usd,
      risk: value.risk,
    };
  }
  if (data.schema_id === "risk_score_v1") {
    const value = RiskScoreDataSchema.parse(data);
    return {
      schema_id: value.schema_id,
      venue: value.venue,
      score: value.score,
      rating: value.rating,
    };
  }
  throw new Error("Unsupported AP4M merchant response schema.");
}

function envelopeError(
  envelope: Extract<Envelope<unknown>, { ok: false }>,
): Error {
  const code = envelope.error.code ? ` (${envelope.error.code})` : "";
  return new Error(`${envelope.error.service}${code}: ${envelope.error.message}`);
}

function idempotencyKey(context: Ap4mToolContext): string {
  const value = context.createIdempotencyKey?.() ?? `ap4m-${randomUUID()}`;
  return BoundedIdSchema.max(256).parse(value);
}

async function purchase(
  input: z.infer<typeof Ap4mPurchaseToolInputSchema>,
  options: CreateAp4mToolsOptions,
  purchaseIdempotencyKey: string,
): Promise<Ap4mModelResult> {
  const context = options.ap4m;
  const active = context?.activeMandate;
  if (!active) throw new Error("AP4M purchase blocked: no active mandate is configured.");
  if (options.network !== "testnet") {
    throw new Error("AP4M purchase blocked: the demo is Testnet-only.");
  }
  if (active.owner !== options.account.budget_account) {
    throw new Error("AP4M purchase blocked: mandate owner does not match the connected budget account.");
  }

  const mandateEnvelope = await options.harborRest.op("mandate.status", {
    mandate_id: active.mandate_id,
  });
  if (!mandateEnvelope.ok) throw envelopeError(mandateEnvelope);
  const mandate = MandateSchema.parse(mandateEnvelope.data);
  if (
    mandate.id !== active.mandate_id ||
    mandate.owner !== active.owner ||
    mandate.network !== options.network ||
    mandate.status !== "ACTIVE"
  ) {
    throw new Error("AP4M purchase blocked by rule MANDATE_NOT_ACTIVE.");
  }

  const response = await options.harborRest.op("ap4m.purchase", {
    mandate_id: active.mandate_id,
    merchant_id: input.merchant_id,
    sku: input.sku,
    idempotency_key: purchaseIdempotencyKey,
  });
  if (!response.ok) throw envelopeError(response);

  const parsed = z
    .object({
      receipt: z.unknown(),
      data: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(response.data);
  const receipt = Ap4mReceiptSchema.parse(parsed.receipt);
  if (
    receipt.mandate_id !== active.mandate_id ||
    receipt.merchant_id !== input.merchant_id ||
    receipt.sku !== input.sku
  ) {
    throw new Error("AP4M purchase response did not match the server-bound request.");
  }

  const validation = receipt.merchant_validation;
  if (validation.intentId !== receipt.intent_id) {
    throw new Error("AP4M merchant validation intent did not match the receipt.");
  }
  const proof = receipt.proof;
  if (receipt.scheme === "exact") {
    if (
      !TransactionHashSchema.safeParse(proof.tx_hash).success ||
      proof.channel_id !== undefined ||
      proof.cumulative_drops !== undefined ||
      !["validated", "settlement_unknown"].includes(receipt.settlement)
    ) {
      throw new Error("AP4M exact receipt proof was inconsistent with settlement.");
    }
  } else if (
    proof.tx_hash !== undefined ||
    !ChannelIdSchema.safeParse(proof.channel_id).success ||
    !PositiveDropsSchema.safeParse(proof.cumulative_drops).success ||
    !["claim_accepted", "redeemed", "settlement_unknown"].includes(
      receipt.settlement,
    )
  ) {
    throw new Error("AP4M payment-channel receipt proof was inconsistent with settlement.");
  }

  const pending = receipt.settlement === "settlement_unknown";
  if (
    !pending &&
    (!validation.validated ||
      validation.intentId !== receipt.intent_id ||
      Object.values(validation.checks).some((check) => check !== "pass") ||
      validation.validation_errors.length !== 0)
  ) {
    throw new Error("AP4M merchant validation was not fully successful.");
  }
  const expectedSchema =
    receipt.merchant_id === "venue-yield-desk" && receipt.sku === "yield-report"
      ? "yield_report_v1"
      : receipt.merchant_id === "risk-oracle" && receipt.sku === "risk-score"
        ? "risk_score_v1"
        : undefined;
  const dataSummary = pending ? {} : projectAp4mDataSummary(parsed.data);
  if (!pending && dataSummary.schema_id !== expectedSchema) {
    throw new Error("AP4M merchant data schema did not match the purchased SKU.");
  }

  return Ap4mModelResultSchema.parse({
    status: pending ? "pending" : "completed",
    merchant: receipt.merchant_id,
    sku: receipt.sku,
    amount: receipt.amount,
    settlement: receipt.settlement,
    receipt_id: receipt.receipt_id,
    data_summary: dataSummary,
  });
}

async function merchantsSearch(
  query: string,
  options: CreateAp4mToolsOptions,
): Promise<unknown> {
  const [merchantEnvelope, mastercardEnvelope] = await Promise.all([
    options.harborRest.op("merchants.list", {}),
    options.harborRest.op("mastercard.search", { query }),
  ]);
  if (!merchantEnvelope.ok) throw envelopeError(merchantEnvelope);
  if (!mastercardEnvelope.ok) throw envelopeError(mastercardEnvelope);

  const merchants = z.array(z.unknown()).parse(merchantEnvelope.data).map((value) => {
    const merchant = MerchantSchema.parse(value);
    return {
      id: merchant.id,
      name: merchant.name,
      network: merchant.network,
      schemes: merchant.schemes,
      products: merchant.products.map((product) => ({
        sku: product.sku,
        name: product.name,
        price: product.price,
        response_schema_id: product.response_schema_id,
      })),
    };
  });

  return {
    sources: [
      { source: "Harbor merchant registry", results: merchants },
      {
        source: "Mastercard Developers",
        third_party: true,
        result: mastercardEnvelope.data,
      },
    ],
  };
}

/** Model-facing AP4M tools. No URL, amount, headers, network, mandate, or key input is exposed. */
export function createAp4mModelTools(
  options: CreateAp4mToolsOptions,
): Record<string, Tool<any, any>> {
  const attempts = new Map<
    string,
    {
      idempotencyKey: string;
      result?: Ap4mModelResult;
      blocked?: true;
    }
  >();
  const tools: Record<string, Tool<any, any>> = {
    merchants_search: tool({
      description:
        "Search the allowlisted Harbor merchant registry and public Mastercard Developers material. Results are labelled by source; merchant data is third-party.",
      inputSchema: MerchantsSearchToolInputSchema,
      execute: ({ query }) => merchantsSearch(query, options),
    }),
  };

  if (options.ap4m?.activeMandate) {
    tools.ap4m_purchase = tool({
      description:
        "Purchase one allowlisted typed merchant resource under the server-configured ACTIVE AP4M mandate. Merchant and SKU are the only model-controlled fields.",
      inputSchema: Ap4mPurchaseToolInputSchema,
      execute: async (input) => {
        const fingerprint = `${input.merchant_id}\u0000${input.sku}`;
        const previous = attempts.get(fingerprint);
        if (previous?.blocked) {
          throw new Error("AP4M purchase blocked: this request was already blocked in this run and was not retried.");
        }
        if (previous?.result) return previous.result;
        const attempt = previous ?? {
          idempotencyKey: idempotencyKey(options.ap4m!),
        };
        attempts.set(fingerprint, attempt);
        try {
          const result = await purchase(input, options, attempt.idempotencyKey);
          attempt.result = result;
          return result;
        } catch (error) {
          attempt.blocked = true;
          throw error;
        }
      },
    });
  }
  return tools;
}

/** Server action boundary for the kill switch. This is intentionally not a model tool. */
export async function revokeAp4mAgent(
  options: CreateAp4mToolsOptions,
): Promise<{ mandate_status: "REVOKED"; credential_status: "revoked" }> {
  const active = options.ap4m?.activeMandate;
  const revokeCredential = options.ap4m?.revokeCredential;
  if (!active || !revokeCredential) {
    throw new Error("AP4M revoke requires an active mandate and credential revoker.");
  }
  if (options.network !== "testnet" || active.owner !== options.account.budget_account) {
    throw new Error("AP4M revoke context does not match the Testnet budget account.");
  }

  const response = await options.harborRest.op("mandate.revoke", {
    mandate_id: active.mandate_id,
  });
  if (!response.ok) throw envelopeError(response);
  const mandate = MandateSchema.parse(response.data);
  if (
    mandate.id !== active.mandate_id ||
    mandate.owner !== active.owner ||
    mandate.network !== options.network ||
    mandate.status !== "REVOKED"
  ) {
    throw new Error("Harbor did not confirm the named MANDATE_REVOKED rule state.");
  }
  const credential = z
    .object({ status: z.literal("revoked") })
    .strict()
    .parse(
      await revokeCredential({
        mandate_id: active.mandate_id,
        owner: active.owner,
        network: "testnet",
      }),
    );
  return { mandate_status: "REVOKED", credential_status: credential.status };
}
