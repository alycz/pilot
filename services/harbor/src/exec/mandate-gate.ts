import type { Mandate, Policy, PolicyResult } from '../contracts';

export interface MandateGateInput {
	policy: PolicyResult;
	settings: Pick<Policy, 'ap4m_enabled'>;
	mandate: Mandate;
	merchantId: string;
	sku: string;
	amountUsd: string;
	dailySpentUsd: string;
	now?: Date;
}

function decimal(value: string): bigint | null {
	if (!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) return null;
	const [whole, fraction = ''] = value.split('.');
	return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function reason(rule: string, pass: boolean, detail: string) {
	return { rule, pass, detail };
}

/** Apply AP4M's second authorization gate after the ordinary Harbor policy. */
export function evaluateMandateGate(input: MandateGateInput): PolicyResult {
	const amount = decimal(input.amountUsd);
	const spentToday = decimal(input.dailySpentUsd);
	const spentTotal = decimal(input.mandate.spent_usd);
	const perPayment = decimal(input.mandate.constraints.per_payment_max);
	const daily = decimal(input.mandate.constraints.daily_max);
	const total = decimal(input.mandate.constraints.total_max);
	const now = (input.now ?? new Date()).getTime();
	const notBefore = Date.parse(input.mandate.not_before);
	const expires = Date.parse(input.mandate.expires_at);

	const reasons = [
		...input.policy.reasons,
		reason('base_policy', input.policy.verdict === 'execute', input.policy.verdict === 'execute'
			? 'Harbor policy allows autonomous execution.'
			: `Harbor policy returned ${input.policy.verdict}; AP4M cannot broaden it.`),
		reason('mandate_active', input.mandate.status === 'ACTIVE', input.mandate.status === 'ACTIVE'
			? 'Mandate is active.'
			: `Mandate status is ${input.mandate.status}.`),
		reason('mandate_not_expired', Number.isFinite(notBefore) && Number.isFinite(expires) && now >= notBefore && now < expires,
			Number.isFinite(notBefore) && Number.isFinite(expires) && now >= notBefore && now < expires
				? 'Mandate is within its authorized time window.'
				: 'Mandate is not currently within its authorized time window.'),
		reason('mandate_payee', input.mandate.constraints.payees.includes(input.merchantId),
			input.mandate.constraints.payees.includes(input.merchantId)
				? 'Merchant is an allowed payee.' : 'Merchant is not an allowed payee.'),
		reason('mandate_sku', input.mandate.constraints.skus === undefined || input.mandate.constraints.skus.includes(input.sku),
			input.mandate.constraints.skus === undefined || input.mandate.constraints.skus.includes(input.sku)
				? 'SKU is allowed by the mandate.' : 'SKU is not allowed by the mandate.'),
		reason('mandate_per_payment', amount !== null && perPayment !== null && amount <= perPayment,
			amount !== null && perPayment !== null && amount <= perPayment
				? 'Payment is within the per-payment maximum.' : 'Payment exceeds the per-payment maximum or has an invalid amount.'),
		reason('mandate_daily', amount !== null && spentToday !== null && daily !== null && spentToday + amount <= daily,
			amount !== null && spentToday !== null && daily !== null && spentToday + amount <= daily
				? 'Payment is within the daily maximum.' : 'Payment would exceed the daily maximum or has an invalid amount.'),
		reason('mandate_total', amount !== null && spentTotal !== null && total !== null && spentTotal + amount <= total,
			amount !== null && spentTotal !== null && total !== null && spentTotal + amount <= total
				? 'Payment is within the lifetime maximum.' : 'Payment would exceed the lifetime maximum or has an invalid amount.'),
		reason('ap4m_enabled', input.settings.ap4m_enabled, input.settings.ap4m_enabled
			? 'AP4M autonomous execution is enabled.' : 'AP4M autonomous execution is disabled by policy.'),
	];
	return { verdict: reasons.every((entry) => entry.pass) ? 'execute' : 'block', reasons };
}
