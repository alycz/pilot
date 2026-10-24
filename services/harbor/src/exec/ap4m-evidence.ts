import {
	Ap4mPublicEvidenceSchema,
	type Ap4mPublicEvidence,
	type Ap4mReceipt,
	type Mandate,
} from '../contracts';
import { canonicalAp4mJson } from './ap4m-intent';
import type { Ap4mPreparedExecutionContext } from './ap4m-store';
import { viDigest } from './mandate-vi';

const HEX_64 = /^[A-F0-9]{64}$/;

export class Ap4mEvidenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Ap4mEvidenceError';
	}
}

function same(left: unknown, right: unknown): boolean {
	return canonicalAp4mJson(left) === canonicalAp4mJson(right);
}

/**
 * Project only bounded public references from Harbor-owned exact-rail state.
 * Compact VI presentations, disclosures, transaction blobs and credentials
 * remain encrypted/internal and are never copied into the returned bundle.
 */
export async function buildExactAp4mPublicEvidence(input: {
	mandate: Mandate;
	context: Ap4mPreparedExecutionContext;
	receipt: Ap4mReceipt;
	txHash: string;
	crypto?: Crypto;
}): Promise<Ap4mPublicEvidence> {
	const { mandate, context, receipt } = input;
	const txHash = input.txHash.toUpperCase();
	if (mandate.network !== 'testnet' || receipt.scheme !== 'exact' || receipt.settlement !== 'validated' ||
		!HEX_64.test(txHash) || receipt.proof.tx_hash?.toUpperCase() !== txHash ||
		receipt.proof.channel_id !== undefined || receipt.proof.cumulative_drops !== undefined) {
		throw new Ap4mEvidenceError('Finalized exact settlement evidence is invalid');
	}
	const product = context.merchantSnapshot.products[0];
	const order = context.intent.orders[0];
	const item = order?.items[0];
	const merchant = order?.merchants[0];
	if (
		receipt.mandate_id !== mandate.id || receipt.intent_id !== context.intent.intentId ||
		receipt.merchant_id !== context.merchantSnapshot.id || receipt.sku !== product?.sku ||
		!same(receipt.amount, context.receiptAmount) ||
		context.intent.intentStatus !== 'ACTIVE' || context.intent.orders.length !== 1 ||
		order?.orderExecutionType !== 'DEFERRED' || order.items.length !== 1 || order.merchants.length !== 1 ||
		order.orderTotalAmount.amount !== product?.price.value || order.orderTotalAmount.currency !== 'USD' ||
		item?.itemId !== product?.sku || item.itemName !== product.name ||
		item.itemUnitPrice.amount !== product.price.value || item.itemUnitPrice.currency !== 'USD' ||
		item.itemQuantity !== 1 || merchant?.srcDpaId !== context.merchantSnapshot.src_dpa_id ||
		merchant.merchantName !== context.merchantSnapshot.name ||
		!receipt.merchant_validation.validated ||
		receipt.merchant_validation.intentId !== context.intent.intentId ||
		Object.values(receipt.merchant_validation.checks).some((check) => check !== 'pass') ||
		receipt.merchant_validation.validation_errors.length !== 0
	) {
		throw new Ap4mEvidenceError('Receipt, mandate and intent bindings do not match');
	}

	const cryptoImpl = input.crypto ?? crypto;
	const [l1, l2, l3a, l3b] = await Promise.all([
		viDigest(context.vi.l1, cryptoImpl),
		viDigest(context.vi.l2, cryptoImpl),
		viDigest(context.vi.l3a, cryptoImpl),
		viDigest(context.vi.l3b, cryptoImpl),
	]);
	if (
		l1 !== mandate.l1_digest.toLowerCase() ||
		l3a !== context.vi.l3aDigest || l3b !== context.vi.l3bDigest ||
		l3a !== receipt.l3a_digest || l3b !== receipt.l3b_digest
	) {
		throw new Ap4mEvidenceError('Stored AP4M presentation digest does not match its binding');
	}

	return Ap4mPublicEvidenceSchema.parse({
		version: 'ap4m-public-evidence-v1',
		provenance: 'live-testnet',
		network: 'testnet',
		rail: 'exact',
		intent: context.intent,
		artifacts: [
			{ kind: 'l1', digest: l1.toUpperCase(), digest_basis: 'sha256-utf8/vi-l1-presentation' },
			{ kind: 'l2', digest: l2.toUpperCase(), digest_basis: 'sha256-utf8/vi-l2-merchant-presentation' },
			{ kind: 'l3a', digest: l3a.toUpperCase(), digest_basis: 'sha256-utf8/vi-l3a-presentation' },
			{ kind: 'l3b', digest: l3b.toUpperCase(), digest_basis: 'sha256-utf8/vi-l3b-presentation' },
			{ kind: 'payment', digest: txHash, digest_basis: 'xrpl/signed-transaction-hash' },
		],
	});
}
