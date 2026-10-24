import { describe, expect, it } from 'vitest';

import { evaluateMandateGate } from '../src/exec/mandate-gate';
import type { Mandate, PolicyResult } from '../src/contracts';

const basePolicy: PolicyResult = { verdict: 'execute', reasons: [{ rule: 'network', pass: true, detail: 'testnet' }] };
const mandate: Mandate = {
	id: 'm-1', owner: 'rOwner', network: 'testnet', status: 'ACTIVE', execution_type: 'DEFERRED',
	not_before: '2026-10-21T00:00:00.000Z', expires_at: '2026-10-22T00:00:00.000Z',
	constraints: { currency: 'USD', per_payment_max: '25', daily_max: '40', total_max: '100', payees: ['merchant-a'], skus: ['sku-a'] },
	agent_public_jwk: {}, l1_digest: '', l2_digest: '', channels: [], spent_usd: '60',
};

function evaluate(overrides: Partial<Parameters<typeof evaluateMandateGate>[0]> = {}) {
	return evaluateMandateGate({
		policy: basePolicy, settings: { ap4m_enabled: true }, mandate, merchantId: 'merchant-a', sku: 'sku-a',
		amountUsd: '20', dailySpentUsd: '20', now: new Date('2026-10-21T12:00:00.000Z'), ...overrides,
	});
}

describe('AP4M mandate gate', () => {
	it('allows exact boundaries only when both gates pass', () => {
		const result = evaluate({ amountUsd: '20', dailySpentUsd: '20' });
		expect(result.verdict).toBe('execute');
		expect(result.reasons.every((entry) => entry.pass)).toBe(true);
	});

	it.each([
		['base_policy', { policy: { verdict: 'needs_approval', reasons: [] } }],
		['mandate_active', { mandate: { ...mandate, status: 'REVOKED' } }],
		['mandate_not_expired', { now: new Date('2026-10-22T00:00:00.000Z') }],
		['mandate_payee', { merchantId: 'merchant-b' }],
		['mandate_sku', { sku: 'sku-b' }],
		['mandate_per_payment', { amountUsd: '25.01' }],
		['mandate_daily', { dailySpentUsd: '20.01' }],
		['mandate_total', { mandate: { ...mandate, spent_usd: '80' }, amountUsd: '20.01' }],
		['ap4m_enabled', { settings: { ap4m_enabled: false } }],
	] as const)('blocks when %s fails', (rule, overrides) => {
		const result = evaluate(overrides as Partial<Parameters<typeof evaluateMandateGate>[0]>);
		expect(result.verdict).toBe('block');
		expect(result.reasons.find((entry) => entry.rule === rule)?.pass).toBe(false);
	});

	it('returns every failed reason and rejects malformed decimals', () => {
		const result = evaluate({ amountUsd: 'NaN', merchantId: 'wrong', sku: 'wrong', settings: { ap4m_enabled: false } });
		expect(result.reasons.filter((entry) => !entry.pass).map((entry) => entry.rule)).toEqual(
			expect.arrayContaining(['mandate_payee', 'mandate_sku', 'mandate_per_payment', 'mandate_daily', 'mandate_total', 'ap4m_enabled']),
		);
	});

	it('uses exact micro-USD arithmetic above Number.MAX_SAFE_INTEGER', () => {
		const huge = { ...mandate, spent_usd: '9007199254740992', constraints: { ...mandate.constraints, total_max: '9007199254740992.000001' } };
		const result = evaluate({ mandate: huge, amountUsd: '0.000002', dailySpentUsd: '0' });
		expect(result.reasons.find((entry) => entry.rule === 'mandate_total')?.pass).toBe(false);
	});
});
