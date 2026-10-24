import { describe, expect, it } from 'vitest';

import type { Ap4mReceipt, Mandate, Merchant } from '../src/contracts';
import { Ap4mEvidenceError, buildExactAp4mPublicEvidence } from '../src/exec/ap4m-evidence';
import type { Ap4mPreparedExecutionContext } from '../src/exec/ap4m-store';
import { viDigest } from '../src/exec/mandate-vi';

const TX_HASH = 'E'.repeat(64);

async function fixture() {
	const merchant: Merchant = {
		id: 'merchant-a', name: 'Merchant A', network: 'testnet', base_url: 'https://merchant.example',
		xrpl_address: 'rMerchant', src_dpa_id: 'dpa-a', schemes: ['exact'],
		settle_asset: { kind: 'iou', currency: 'RLUSD', issuer: 'rIssuer' },
		required_credential: { issuer: 'rIssuer', credential_type_hex: 'ABCD' },
		products: [{ sku: 'yield-report', name: 'Yield report', description: 'Report',
			price: { asset: { kind: 'iou', currency: 'RLUSD', issuer: 'rIssuer' }, value: '1.00' },
			response_schema_id: 'yield_report_v1' }], wba_required: true,
	};
	const intent = {
		intentId: 'demo-intent-00000000-0000-4000-8000-000000000001',
		intentSummary: 'Purchase yield report', intentStatus: 'ACTIVE' as const,
		orders: [{ orderId: 'order-1', orderExecutionType: 'DEFERRED' as const, orderExpiry: 1_800_000_000,
			orderTotalAmount: { amount: '1.00', currency: 'USD' },
			items: [{ itemId: 'yield-report', itemName: 'Yield report',
				itemUnitPrice: { amount: '1.00', currency: 'USD' }, itemQuantity: 1,
				itemDeliveryMethod: 'DIGITAL' as const }],
			merchants: [{ srcDpaId: 'dpa-a', merchantName: 'Merchant A' }] }],
	};
	const presentations = { l1: 'L1-INTERNAL', l2: 'L2-INTERNAL', l3a: 'L3A-INTERNAL', l3b: 'L3B-INTERNAL' };
	const [l1, l2, l3a, l3b] = await Promise.all(Object.values(presentations).map((value) => viDigest(value)));
	const context: Ap4mPreparedExecutionContext = {
		intent, vi: { ...presentations, l3aDigest: l3a!, l3bDigest: l3b! },
		challenge: {}, challengeState: 'opaque', payer: 'rPayer', merchantSnapshot: merchant,
		receiptAmount: { asset: { kind: 'iou', currency: 'RLUSD', issuer: 'rIssuer' }, value: '1.00' },
		acceptedRequirement: {}, resourceUrl: 'https://merchant.example/resource/yield-report',
		receiptId: 'receipt-1', retryHeaders: {
			'x-mastercard-intent': 'internal', 'x-vi-l1': presentations.l1,
			'x-vi-l2': presentations.l2, 'x-vi-l3b': presentations.l3b,
		},
	};
	const mandate: Mandate = {
		id: 'mandate-1', owner: 'rOwner', network: 'testnet', status: 'ACTIVE', execution_type: 'DEFERRED',
		not_before: '2026-10-23T00:00:00.000Z', expires_at: '2026-10-24T00:00:00.000Z',
		constraints: { currency: 'USD', per_payment_max: '1', total_max: '2', daily_max: '2', payees: ['merchant-a'] },
		agent_public_jwk: {}, l1_digest: l1!, l2_digest: 'F'.repeat(64),
		channels: [], spent_usd: '1',
	};
	const receipt: Ap4mReceipt = {
		receipt_id: 'receipt-1', mandate_id: mandate.id, merchant_id: merchant.id, sku: 'yield-report',
		intent_id: intent.intentId, l3a_digest: l3a!, l3b_digest: l3b!, scheme: 'exact',
		amount: context.receiptAmount, proof: { tx_hash: TX_HASH }, settlement: 'validated',
		merchant_validation: { intentId: intent.intentId, validated: true,
			checks: { agent_identity: 'pass', intent: 'pass', payment: 'pass', credential: 'pass' },
			validation_errors: [] }, at: '2026-10-23T12:00:00.000Z',
	};
	return { mandate, context, receipt, digests: { l1, l2, l3a, l3b } };
}

describe('exact AP4M public evidence', () => {
	it('projects five stable digest-only references without internal artifacts', async () => {
		const input = await fixture();
		const evidence = await buildExactAp4mPublicEvidence({ ...input, txHash: TX_HASH });
		expect(evidence.artifacts.map((artifact) => artifact.kind)).toEqual(['l1', 'l2', 'l3a', 'l3b', 'payment']);
		expect(evidence.artifacts.map((artifact) => artifact.digest)).toEqual([
			input.digests.l1.toUpperCase(), input.digests.l2.toUpperCase(),
			input.digests.l3a.toUpperCase(), input.digests.l3b.toUpperCase(), TX_HASH,
		]);
		const serialized = JSON.stringify(evidence);
		for (const forbidden of ['L1-INTERNAL', 'L2-INTERNAL', 'L3A-INTERNAL', 'L3B-INTERNAL',
			'tx_blob', 'credential_ids', 'private', 'signature', 'key_id', 'setup_tx_hashes']) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it('rejects tampered presentations and receipt bindings', async () => {
		const input = await fixture();
		await expect(buildExactAp4mPublicEvidence({
			...input, context: { ...input.context, vi: { ...input.context.vi, l3b: 'tampered' } }, txHash: TX_HASH,
		})).rejects.toBeInstanceOf(Ap4mEvidenceError);
		await expect(buildExactAp4mPublicEvidence({
			...input, receipt: { ...input.receipt, intent_id: 'another-intent' }, txHash: TX_HASH,
		})).rejects.toBeInstanceOf(Ap4mEvidenceError);
		await expect(buildExactAp4mPublicEvidence({ ...input, txHash: 'A'.repeat(64) }))
			.rejects.toBeInstanceOf(Ap4mEvidenceError);
	});
});
