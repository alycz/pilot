import { z } from 'zod';

import {
	Ap4mReceiptSchema,
	IntentValidationSchema,
	MerchantSchema,
	type Ap4mReceipt,
	type Merchant,
} from '../contracts';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENUM_VALUE = /^[a-z][a-z0-9_-]{0,63}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const HEX_256 = /^[A-Fa-f0-9]{64}$/;
const POSITIVE_INTEGER = /^[1-9]\d{0,31}$/;

const IdentifierSchema = z.string().regex(SAFE_IDENTIFIER);
const EnumSchema = z.string().regex(ENUM_VALUE);
const DecimalSchema = z
	.string()
	.max(128)
	.regex(DECIMAL)
	.refine((value) => Number.isFinite(Number(value)), 'decimal must be finite');
const PositiveDecimalSchema = DecimalSchema.refine(
	(value) => Number(value) > 0,
	'decimal must be positive',
);
const MerchantTextSchema = z.string().max(200);
const DigestSchema = z.string().regex(HEX_256);
const LedgerHashSchema = z.string().regex(HEX_256);
const CanonicalTimestampSchema = z.string().refine((value) => {
	const parsed = new Date(value);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, 'timestamp must be a canonical ISO-8601 UTC instant');

export const YieldReportDataSchema = z
	.object({
		schema_id: z.literal('yield_report_v1'),
		venue: IdentifierSchema,
		apr_percent: DecimalSchema,
		tvl_usd: DecimalSchema,
		risk: EnumSchema,
		as_of_basis: MerchantTextSchema.optional(),
	})
	.strict();

export const RiskScoreDataSchema = z
	.object({
		schema_id: z.literal('risk_score_v1'),
		venue: IdentifierSchema,
		score: z.number().finite().min(0).max(100),
		rating: EnumSchema,
		factors: z.array(MerchantTextSchema).max(16).optional(),
		as_of_basis: MerchantTextSchema.optional(),
	})
	.strict();

export const Ap4mTypedDataSchema = z.union([
	YieldReportDataSchema,
	RiskScoreDataSchema,
]);
export type Ap4mTypedData = z.infer<typeof Ap4mTypedDataSchema>;

const SuccessfulIntentValidationSchema = IntentValidationSchema.superRefine(
	(validation, context) => {
		if (!validation.validated) {
			context.addIssue({
				code: 'custom',
				message: 'merchant did not validate the intent',
				path: ['validated'],
			});
		}
		for (const [name, result] of Object.entries(validation.checks)) {
			if (result !== 'pass') {
				context.addIssue({
					code: 'custom',
					message: `${name} check did not pass`,
					path: ['checks', name],
				});
			}
		}
		if (validation.validation_errors.length !== 0) {
			context.addIssue({
				code: 'custom',
				message: 'successful merchant response contains validation errors',
				path: ['validation_errors'],
			});
		}
	},
);

export const Ap4mMerchantSuccessSchema = z.union([
	z
		.object({
			data: YieldReportDataSchema,
			intent_validation: SuccessfulIntentValidationSchema,
		})
		.strict(),
	z
		.object({
			data: RiskScoreDataSchema,
			intent_validation: SuccessfulIntentValidationSchema,
		})
		.strict(),
]);

export const Ap4mSettlementEvidenceSchema = z.discriminatedUnion('scheme', [
	z
		.object({
			scheme: z.literal('exact'),
			settlement: z.enum(['validated', 'settlement_unknown']),
			proof: z.object({ tx_hash: LedgerHashSchema }).strict(),
		})
		.strict(),
	z
		.object({
			scheme: z.literal('xrpl-paychan'),
			settlement: z.enum([
				'claim_accepted',
				'redeemed',
				'settlement_unknown',
			]),
			proof: z
				.object({
					channel_id: LedgerHashSchema,
					cumulative_drops: z.string().regex(POSITIVE_INTEGER),
				})
				.strict(),
		})
		.strict(),
]);
export type Ap4mSettlementEvidence = z.infer<
	typeof Ap4mSettlementEvidenceSchema
>;

export interface Ap4mResponseContext {
	receiptId: string;
	mandateId: string;
	merchant: Merchant;
	sku: string;
	intentId: string;
	l3aDigest: string;
	l3bDigest: string;
	/** Exact registry-bound amount challenged, reserved, signed and delivered. */
	paidAmount: Merchant['products'][number]['price'];
	settlement: Ap4mSettlementEvidence;
	at: string;
}

export interface ValidatedAp4mResponse {
	receipt: Ap4mReceipt;
	data: Ap4mTypedData;
}

export class Ap4mResponseError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_CONTEXT'
			| 'INVALID_RESPONSE'
			| 'SCHEMA_MISMATCH'
			| 'CROSS_BINDING_MISMATCH',
	) {
		super(message);
		this.name = 'Ap4mResponseError';
	}
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function decimalCoefficient(value: string): { coefficient: bigint; scale: number } {
	const [whole, fraction = ''] = value.split('.');
	return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function decimalLessThanOrEqual(left: string, right: string): boolean {
	const a = decimalCoefficient(left);
	const b = decimalCoefficient(right);
	const scale = Math.max(a.scale, b.scale);
	return a.coefficient * 10n ** BigInt(scale - a.scale) <=
		b.coefficient * 10n ** BigInt(scale - b.scale);
}

function productFor(merchant: Merchant, sku: string): Merchant['products'][number] {
	const matches = merchant.products.filter((product) => product.sku === sku);
	if (matches.length !== 1) {
		throw new Ap4mResponseError(
			'Merchant registry does not contain exactly one requested SKU',
			'INVALID_CONTEXT',
		);
	}
	return matches[0];
}

function parseContext(context: Ap4mResponseContext): {
	merchant: Merchant;
	product: Merchant['products'][number];
	settlement: Ap4mSettlementEvidence;
} {
	let merchant: Merchant;
	let settlement: Ap4mSettlementEvidence;
	try {
		merchant = MerchantSchema.parse(context.merchant);
		settlement = Ap4mSettlementEvidenceSchema.parse(context.settlement);
		IdentifierSchema.parse(context.receiptId);
		IdentifierSchema.parse(context.mandateId);
		IdentifierSchema.parse(context.sku);
		IdentifierSchema.parse(context.intentId);
		DigestSchema.parse(context.l3aDigest);
		DigestSchema.parse(context.l3bDigest);
		CanonicalTimestampSchema.parse(context.at);
		PositiveDecimalSchema.parse(context.paidAmount.value);
	} catch (error) {
		throw new Ap4mResponseError(
			`AP4M receipt context is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
			'INVALID_CONTEXT',
		);
	}
	if (merchant.network !== 'testnet') {
		throw new Ap4mResponseError(
			'AP4M merchant must be registered on Testnet',
			'INVALID_CONTEXT',
		);
	}
	if (!merchant.schemes.includes(settlement.scheme)) {
		throw new Ap4mResponseError(
			'Merchant registry does not allow the settlement scheme',
			'INVALID_CONTEXT',
		);
	}
	const product = productFor(merchant, context.sku);
	try {
		PositiveDecimalSchema.parse(product.price.value);
	} catch {
		throw new Ap4mResponseError(
			'Merchant registry contains an invalid product price',
			'INVALID_CONTEXT',
		);
	}
	if (!sameJson(product.price.asset, merchant.settle_asset)) {
		throw new Ap4mResponseError(
			'Product price asset does not match the merchant settlement asset',
			'INVALID_CONTEXT',
		);
	}
	if (
		!sameJson(context.paidAmount.asset, product.price.asset) ||
		!decimalLessThanOrEqual(context.paidAmount.value, product.price.value)
	) {
		throw new Ap4mResponseError(
			'Paid amount does not match the registered asset and price ceiling',
			'INVALID_CONTEXT',
		);
	}
	return { merchant, product, settlement };
}

/**
 * Validate the only merchant-controlled bytes that may cross the AP4M public
 * operation boundary. The receipt itself is assembled solely from registry,
 * request, VI and ledger values; every merchant-origin string remains under
 * `data.**`, which the operation screening layer treats as untrusted.
 */
export function validateAp4mMerchantResponse(
	raw: unknown,
	context: Ap4mResponseContext,
): ValidatedAp4mResponse {
	const { merchant, product, settlement } = parseContext(context);
	const response = validateAp4mMerchantResponseBinding(raw, {
		merchant,
		sku: product.sku,
		intentId: context.intentId,
	});

	const receipt = Ap4mReceiptSchema.parse({
		receipt_id: context.receiptId,
		mandate_id: context.mandateId,
		merchant_id: merchant.id,
		sku: product.sku,
		intent_id: context.intentId,
		l3a_digest: context.l3aDigest,
		l3b_digest: context.l3bDigest,
		scheme: settlement.scheme,
		amount: context.paidAmount,
		proof: settlement.proof,
		merchant_validation: response.intent_validation,
		settlement: settlement.settlement,
		at: context.at,
	});

	return { receipt, data: response.data };
}

/** Validate merchant-controlled data before it is admitted to durable recovery state. */
export function validateAp4mMerchantResponseBinding(
	raw: unknown,
	context: { merchant: Merchant; sku: string; intentId: string },
): z.infer<typeof Ap4mMerchantSuccessSchema> {
	let merchant: Merchant;
	try {
		merchant = MerchantSchema.parse(context.merchant);
	} catch (error) {
		throw new Ap4mResponseError(
			`AP4M merchant context is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
			'INVALID_CONTEXT',
		);
	}
	const product = productFor(merchant, context.sku);
	let response: z.infer<typeof Ap4mMerchantSuccessSchema>;
	try {
		response = Ap4mMerchantSuccessSchema.parse(raw);
	} catch (error) {
		throw new Ap4mResponseError(
			`AP4M merchant response is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
			'INVALID_RESPONSE',
		);
	}
	if (response.intent_validation.intentId !== context.intentId) {
		throw new Ap4mResponseError(
			'Merchant validation intent does not match the purchase intent',
			'CROSS_BINDING_MISMATCH',
		);
	}
	if (response.data.schema_id !== product.response_schema_id) {
		throw new Ap4mResponseError(
			'Merchant data schema does not match the registered SKU',
			'SCHEMA_MISMATCH',
		);
	}

	return response;
}
