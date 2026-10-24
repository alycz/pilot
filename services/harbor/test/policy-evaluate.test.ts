import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLICY, type Policy, type TxBuild } from '../src/contracts';
import {
	NEVER_DELEGATED_PERMISSIONS,
	NON_DELEGABLE_PERMISSION_NAMES,
	NON_DELEGABLE_PERMISSION_PREFIXES,
} from '../src/exec/delegation';
import {
	PolicyContextError,
	evaluate,
	gatherPolicyContext,
	type PolicyContextStore,
	type PolicyEvaluationContext,
	type PolicyFactsAdapter,
} from '../src/exec/policy';

const RULES = [
	'network',
	'link_active',
	'transaction_type',
	'issuer_allowlist',
	'require_auth',
	'preflight',
	'simulation',
	'slippage',
	'max_per_tx_usd',
	'daily_cap_usd',
	'execute_under_usd',
];

const rlusdIssuer = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

function policy(patch: Partial<Policy> = {}): Policy {
	return {
		...DEFAULT_POLICY,
		allowed_tx_types: [...DEFAULT_POLICY.allowed_tx_types],
		issuer_allowlist: [...DEFAULT_POLICY.issuer_allowlist],
		networks: [...DEFAULT_POLICY.networks],
		...patch,
	};
}

function build(patch: Partial<TxBuild> = {}): TxBuild {
	const base: TxBuild = {
		build_id: 'build-1',
		network: 'testnet',
		tx_json: {
			TransactionType: 'OfferCreate',
			Account: 'rOwner',
			TakerPays: { currency: 'RLUSD', issuer: rlusdIssuer, value: '249' },
			TakerGets: '1000000',
		},
		delegable: true,
		simulate: { engine_result: 'tesSUCCESS', engine_result_message: 'success', applied: false },
		preflight: [{ check: 'offer_guardrails', pass: true }],
		summary: {
			action: 'swap',
			account: 'rOwner',
			amounts: ['249 RLUSD'],
			fee_drops: '12',
			reserve_delta_drops: '0',
			est_slippage_bps: 100,
			usd_value: '999999',
		},
	};
	return {
		...base,
		...patch,
		tx_json: { ...base.tx_json, ...patch.tx_json },
		summary: { ...base.summary, ...patch.summary },
	};
}

function context(patch: Partial<PolicyEvaluationContext> = {}): PolicyEvaluationContext {
	return {
		policy: policy(),
		linkStatus: 'active',
		grantedPermissions: ['OfferCreate'],
		issuerFacts: [{ currency: 'RLUSD', issuer: rlusdIssuer, requireAuth: false }],
		usdValue: 249,
		dailyUsdTotal: 100,
		...patch,
	};
}

function reason(result: ReturnType<typeof evaluate>, rule: string) {
	return result.reasons.find((candidate) => candidate.rule === rule);
}

function expectReasonShape(result: ReturnType<typeof evaluate>): void {
	expect(result.reasons).toHaveLength(11);
	expect(result.reasons.map((candidate) => candidate.rule)).toEqual(RULES);
	expect(result.reasons.every((candidate) => typeof candidate.detail === 'string' && candidate.detail.length > 0)).toBe(true);
}

describe('evaluate rule order and details', () => {
	it('returns one ordered reason per rule for an executable build', () => {
		const result = evaluate(build(), context());
		expect(result).toEqual({
			verdict: 'execute',
			reasons: [
				{ rule: 'network', pass: true, detail: 'Network testnet is allowed' },
				{ rule: 'link_active', pass: true, detail: 'Account link is active' },
				{
					rule: 'transaction_type',
					pass: true,
					detail: 'OfferCreate is allowed by policy and granted on-ledger',
				},
				{ rule: 'issuer_allowlist', pass: true, detail: 'All transaction issuers are allowlisted' },
				{ rule: 'require_auth', pass: true, detail: 'No transaction issuer requires authorization' },
					{ rule: 'preflight', pass: true, detail: 'All build preflight checks passed' },
				{ rule: 'simulation', pass: true, detail: 'Simulation returned tesSUCCESS' },
				{ rule: 'slippage', pass: true, detail: 'Estimated slippage 100 bps is at or below 100 bps' },
				{
					rule: 'max_per_tx_usd',
					pass: true,
					detail: 'USD value 249 is at or below per-transaction maximum 2000',
				},
				{
					rule: 'daily_cap_usd',
					pass: true,
					detail: 'Projected daily USD total 349 is at or below cap 5000',
				},
				{
					rule: 'execute_under_usd',
					pass: true,
					detail: 'USD value 249 is below auto-execute threshold 250',
				},
			],
		});
	});

	it.each([
		{
			name: 'mainnet remains blocked even when policy lists it',
			build: build({ network: 'mainnet' }),
			ctx: context({ policy: policy({ networks: ['mainnet'] }) }),
			verdict: 'block',
			rule: 'network',
			detail: 'Mainnet execution is always blocked',
		},
		{
			name: 'a non-mainnet network excluded by policy blocks',
			build: build({ network: 'lending-devnet' }),
			ctx: context(),
			verdict: 'block',
			rule: 'network',
			detail: 'Network lending-devnet is not allowed by policy',
		},
		{
			name: 'a suspended link blocks',
			build: build(),
			ctx: context({ linkStatus: 'suspended' }),
			verdict: 'block',
			rule: 'link_active',
			detail: 'Account link is suspended',
		},
		{
			name: 'a missing link blocks',
			build: build(),
			ctx: context({ linkStatus: null, grantedPermissions: [] }),
			verdict: 'block',
			rule: 'link_active',
			detail: 'Account link is missing',
		},
		{
				name: 'a revoked link requires owner approval',
				build: build(),
				ctx: context({ linkStatus: 'revoked', grantedPermissions: [] }),
				verdict: 'needs_approval',
				rule: 'link_active',
				detail: 'Account link is revoked and requires owner approval',
			},
			{
				name: 'a transaction account mismatch blocks',
				build: build({ summary: { ...build().summary, account: 'rDifferentOwner' } }),
				ctx: context(),
				verdict: 'block',
				rule: 'link_active',
				detail: 'Build summary account does not match transaction Account',
			},
			{
			name: 'a type omitted from policy requires approval',
			build: build(),
			ctx: context({ policy: policy({ allowed_tx_types: ['TrustSet'] }) }),
			verdict: 'needs_approval',
			rule: 'transaction_type',
			detail: 'OfferCreate is not allowed by policy',
		},
		{
			name: 'a type omitted from the on-ledger grant requires approval',
			build: build(),
			ctx: context({ grantedPermissions: ['TrustSet'] }),
			verdict: 'needs_approval',
			rule: 'transaction_type',
			detail: 'OfferCreate is not granted on-ledger',
		},
		{
			name: 'a type absent from both lists requires approval',
			build: build({ tx_json: { TransactionType: 'CheckCancel' } }),
			ctx: context(),
			verdict: 'needs_approval',
			rule: 'transaction_type',
			detail: 'CheckCancel is neither allowed by policy nor granted on-ledger',
		},
		{
			name: 'an invalid transaction type requires approval',
			build: build({ tx_json: { TransactionType: ' OfferCreate' } }),
			ctx: context(),
			verdict: 'needs_approval',
			rule: 'transaction_type',
			detail: 'TransactionType must be a non-empty transaction type string',
		},
		{
			name: 'a disallowed issuer blocks',
				build: build({
					tx_json: { TakerPays: { currency: 'FREEMONEY', issuer: 'rBadIssuer', value: '249' } },
				}),
			ctx: context({ issuerFacts: [{ currency: 'FREEMONEY', issuer: 'rBadIssuer', requireAuth: false }] }),
			verdict: 'block',
			rule: 'issuer_allowlist',
			detail: 'Issuer not allowlisted: FREEMONEY/rBadIssuer',
		},
		{
			name: 'an allowlisted issuer with RequireAuth blocks when configured',
			build: build(),
			ctx: context({ issuerFacts: [{ currency: 'RLUSD', issuer: rlusdIssuer, requireAuth: true }] }),
			verdict: 'block',
			rule: 'require_auth',
			detail: `RequireAuth issuer blocked: RLUSD/${rlusdIssuer}`,
		},
		{
				name: 'a failed preflight blocks',
				build: build({ preflight: [{ check: 'destination_safety', pass: false, detail: 'unsafe destination' }] }),
				ctx: context(),
				verdict: 'block',
				rule: 'preflight',
				detail: 'Preflight failed: destination_safety (unsafe destination)',
			},
			{
			name: 'a failed simulation blocks',
			build: build({ simulate: { engine_result: 'tecPATH_DRY', engine_result_message: 'dry', applied: false } }),
			ctx: context(),
			verdict: 'block',
			rule: 'simulation',
			detail: 'Simulation returned tecPATH_DRY',
		},
		{
			name: 'slippage over the limit blocks',
			build: build({ summary: { ...build().summary, est_slippage_bps: 101 } }),
			ctx: context(),
			verdict: 'block',
			rule: 'slippage',
			detail: 'Estimated slippage 101 bps exceeds 100 bps',
		},
		{
			name: 'value over the per-transaction limit blocks',
			build: build(),
			ctx: context({ usdValue: 2000.01 }),
			verdict: 'block',
			rule: 'max_per_tx_usd',
			detail: 'USD value 2000.01 exceeds per-transaction maximum 2000',
		},
		{
			name: 'projected daily value over the cap blocks',
			build: build(),
			ctx: context({ usdValue: 249, dailyUsdTotal: 4751.01 }),
			verdict: 'block',
			rule: 'daily_cap_usd',
			detail: 'Projected daily USD total 5000.01 exceeds cap 5000',
		},
	])('$name', ({ build: candidate, ctx, verdict, rule, detail }) => {
		const result = evaluate(candidate, ctx);
		expect(result.verdict).toBe(verdict);
		expect(reason(result, rule)).toEqual({ rule, pass: false, detail });
		expectReasonShape(result);
	});
});

describe('evaluate exact boundaries', () => {
	it.each([
		{ name: 'slippage equals the maximum', usdValue: 249, dailyUsdTotal: 100, slippage: 100, verdict: 'execute' },
		{ name: 'value is one unit below the execution threshold', usdValue: 249.999, dailyUsdTotal: 100, slippage: 0, verdict: 'execute' },
		{ name: 'value equals the execution threshold', usdValue: 250, dailyUsdTotal: 100, slippage: 0, verdict: 'needs_approval' },
		{ name: 'value lies between threshold and maximum', usdValue: 1000, dailyUsdTotal: 100, slippage: 0, verdict: 'needs_approval' },
		{ name: 'value equals the per-transaction maximum', usdValue: 2000, dailyUsdTotal: 100, slippage: 0, verdict: 'needs_approval' },
		{ name: 'projected daily total equals the cap', usdValue: 250, dailyUsdTotal: 4750, slippage: 0, verdict: 'needs_approval' },
		{ name: 'value exceeds the per-transaction maximum', usdValue: 2000.001, dailyUsdTotal: 0, slippage: 0, verdict: 'block' },
	])('$name', ({ usdValue, dailyUsdTotal, slippage, verdict }) => {
		const candidate = build({ summary: { ...build().summary, est_slippage_bps: slippage } });
		const result = evaluate(candidate, context({ usdValue, dailyUsdTotal }));
		expect(result.verdict).toBe(verdict);
		expect(reason(result, 'slippage')?.pass).toBe(true);
		expect(reason(result, 'max_per_tx_usd')?.pass).toBe(usdValue <= DEFAULT_POLICY.max_per_tx_usd);
		expect(reason(result, 'daily_cap_usd')?.pass).toBe(dailyUsdTotal + usdValue <= DEFAULT_POLICY.daily_cap_usd);
		expect(reason(result, 'execute_under_usd')?.pass).toBe(usdValue < DEFAULT_POLICY.execute_under_usd);
		expectReasonShape(result);
	});

	it('permits a RequireAuth issuer when blocking is explicitly disabled', () => {
		const result = evaluate(
			build(),
			context({
				policy: policy({ block_requireauth_issuers: false }),
				issuerFacts: [{ currency: 'RLUSD', issuer: rlusdIssuer, requireAuth: true }],
			}),
		);
		expect(result.verdict).toBe('execute');
		expect(reason(result, 'require_auth')).toEqual({
			rule: 'require_auth',
			pass: true,
			detail: 'RequireAuth issuer blocking is disabled',
		});
	});

	it('treats an XRP-only transaction with no issuer facts or slippage as passing those rules', () => {
		const candidate = build({
			tx_json: { TakerPays: undefined },
			summary: { ...build().summary, est_slippage_bps: undefined },
		});
		const result = evaluate(candidate, context({ issuerFacts: [] }));
		expect(result.verdict).toBe('execute');
		expect(reason(result, 'issuer_allowlist')?.pass).toBe(true);
		expect(reason(result, 'require_auth')?.pass).toBe(true);
		expect(reason(result, 'slippage')).toEqual({ rule: 'slippage', pass: true, detail: 'Build has no estimated slippage' });
	});

	it('blocks an arbitrary issuer that copies the RLUSD currency code', () => {
		const impostor = 'rArbitraryIssuer';
		const candidate = build({
			tx_json: { TakerPays: { currency: 'RLUSD', issuer: impostor, value: '249' } },
		});
		const result = evaluate(
			candidate,
			context({ issuerFacts: [{ currency: 'RLUSD', issuer: impostor, requireAuth: false }] }),
		);
		expect(result.verdict).toBe('block');
		expect(reason(result, 'issuer_allowlist')).toEqual({
			rule: 'issuer_allowlist',
			pass: false,
			detail: `Issuer not allowlisted: RLUSD/${impostor}`,
		});
	});

	it('resolves symbolic RLUSD to the configured devnet stablecoin fallback', () => {
		const tusdIssuer = 'rConfiguredTusdIssuer';
		const candidate = build({
			network: 'devnet',
			tx_json: { TakerPays: { currency: 'tUSD', issuer: tusdIssuer, value: '249' } },
		});
		const result = evaluate(
			candidate,
			context({
				issuerFacts: [{ currency: 'tUSD', issuer: tusdIssuer, requireAuth: false }],
				stableAsset: { currency: 'tUSD', issuer: tusdIssuer },
			}),
		);
		expect(result.verdict).toBe('execute');
		expect(reason(result, 'issuer_allowlist')?.pass).toBe(true);
	});

	it('blocks missing issuer facts for an issued asset in the transaction', () => {
		const result = evaluate(build(), context({ issuerFacts: [] }));
		expect(result.verdict).toBe('block');
		expect(reason(result, 'issuer_allowlist')).toEqual({
			rule: 'issuer_allowlist',
			pass: false,
			detail: 'Issuer facts are invalid or incomplete for the transaction',
		});
		expect(reason(result, 'require_auth')?.pass).toBe(false);
	});

	it('blocks an empty preflight instead of treating it as green', () => {
		const result = evaluate(build({ preflight: [] }), context());
		expect(result.verdict).toBe('block');
		expect(reason(result, 'preflight')).toEqual({
			rule: 'preflight',
			pass: false,
			detail: 'Build contains no preflight checks',
		});
	});
});

describe('never-delegated and non-delegable transactions', () => {
	it.each([
		...NEVER_DELEGATED_PERMISSIONS.map((transactionType) => ({ transactionType, category: 'never delegated' })),
		...NON_DELEGABLE_PERMISSION_NAMES.map((transactionType) => ({ transactionType, category: 'non-delegable' })),
		...NON_DELEGABLE_PERMISSION_PREFIXES.map((prefix) => ({ transactionType: `${prefix}Deposit`, category: 'non-delegable' })),
	])('$transactionType is always owner-signed ($category)', ({ transactionType, category }) => {
		const result = evaluate(
			build({ tx_json: { TransactionType: transactionType }, delegable: true }),
			context({
				policy: policy({ allowed_tx_types: [transactionType] }),
				grantedPermissions: [transactionType],
			}),
		);
		expect(result.verdict).toBe('needs_approval');
		expect(reason(result, 'transaction_type')).toEqual({
			rule: 'transaction_type',
			pass: false,
			detail:
				category === 'never delegated'
					? `${transactionType} is never delegated and requires owner approval`
					: `${transactionType} is non-delegable and requires owner approval`,
		});
		expectReasonShape(result);
	});

	it('a blocking rule wins over the owner-approval verdict', () => {
		const transactionType = 'Payment';
		const result = evaluate(
			build({
				tx_json: { TransactionType: transactionType },
				simulate: { engine_result: 'tecNO_DST', engine_result_message: 'missing destination', applied: false },
			}),
			context({
				policy: policy({ allowed_tx_types: [transactionType] }),
				grantedPermissions: [transactionType],
			}),
		);
		expect(result.verdict).toBe('block');
		expect(reason(result, 'transaction_type')?.pass).toBe(false);
		expect(reason(result, 'simulation')?.pass).toBe(false);
	});
});

describe('defensive numeric validation and purity', () => {
	it.each([
		{ name: 'NaN USD value', patch: { usdValue: Number.NaN }, rule: 'max_per_tx_usd' },
		{ name: 'negative USD value', patch: { usdValue: -1 }, rule: 'max_per_tx_usd' },
		{ name: 'infinite daily total', patch: { dailyUsdTotal: Number.POSITIVE_INFINITY }, rule: 'daily_cap_usd' },
		{ name: 'negative daily total', patch: { dailyUsdTotal: -1 }, rule: 'daily_cap_usd' },
	])('blocks $name', ({ patch, rule }) => {
		const result = evaluate(build(), context(patch));
		expect(result.verdict).toBe('block');
		expect(reason(result, rule)?.pass).toBe(false);
		expectReasonShape(result);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('blocks invalid estimated slippage %s', (estSlippage) => {
		const candidate = build({ summary: { ...build().summary, est_slippage_bps: estSlippage } });
		const result = evaluate(candidate, context());
		expect(result.verdict).toBe('block');
		expect(reason(result, 'slippage')).toEqual({
			rule: 'slippage',
			pass: false,
			detail: 'Estimated slippage must be finite and nonnegative',
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('blocks invalid execution threshold %s', (threshold) => {
		const result = evaluate(
			build(),
			context({ policy: policy({ execute_under_usd: threshold }) }),
		);
		expect(result.verdict).toBe('block');
		expect(reason(result, 'execute_under_usd')?.pass).toBe(false);
	});

	it('does not mutate the build, policy, link grants, or issuer facts', () => {
		const candidate = build();
		const ctx = context();
		const beforeBuild = structuredClone(candidate);
		const beforeContext = structuredClone(ctx);
		deepFreeze(candidate);
		deepFreeze(ctx);

		expect(evaluate(candidate, ctx).verdict).toBe('execute');
		expect(candidate).toEqual(beforeBuild);
		expect(ctx).toEqual(beforeContext);
	});
});

describe('gatherPolicyContext', () => {
	it('gathers link, daily total, issuer flags, and adapter-supplied USD valuation', async () => {
		const candidate = build({ summary: { ...build().summary, usd_value: '999999' } });
		const getLink = vi.fn(async () => ({ status: 'active' as const, permissions: ['OfferCreate'] }));
		const dailyUsdTotal = vi.fn(async () => 125.5);
		const getPolicyFacts = vi.fn(async () => ({
			usdValue: '24.50',
			issuerFacts: [{ currency: 'RLUSD', issuer: rlusdIssuer, requireAuth: false }],
			stableAsset: { currency: 'RLUSD', issuer: rlusdIssuer },
		}));
		const store: PolicyContextStore = { getLink, dailyUsdTotal };
		const adapter: PolicyFactsAdapter = { getPolicyFacts };

		const gathered = await gatherPolicyContext(candidate, policy(), store, adapter);
		expect(gathered).toEqual({
			policy: policy(),
			linkStatus: 'active',
			grantedPermissions: ['OfferCreate'],
			issuerFacts: [{ currency: 'RLUSD', issuer: rlusdIssuer, requireAuth: false }],
			stableAsset: { currency: 'RLUSD', issuer: rlusdIssuer },
			usdValue: 24.5,
			dailyUsdTotal: 125.5,
		});
		expect(getLink).toHaveBeenCalledOnce();
		expect(getLink).toHaveBeenCalledWith('rOwner', 'testnet');
		expect(dailyUsdTotal).toHaveBeenCalledWith('rOwner', 'testnet');
		expect(getPolicyFacts).toHaveBeenCalledWith(candidate);
		expect(evaluate(candidate, gathered).verdict).toBe('execute');
	});

	it('represents an absent link without inventing grants and accepts numeric USD valuation', async () => {
		const store: PolicyContextStore = {
			getLink: vi.fn(async () => null),
			dailyUsdTotal: vi.fn(async () => 0),
		};
		const adapter: PolicyFactsAdapter = {
			getPolicyFacts: vi.fn(async () => ({ usdValue: 0, issuerFacts: [] })),
		};
		const gathered = await gatherPolicyContext(build(), policy(), store, adapter);
		expect(gathered.linkStatus).toBeNull();
		expect(gathered.grantedPermissions).toEqual([]);
		expect(gathered.usdValue).toBe(0);
	});

	it('rejects an account mismatch before reading principal-scoped state', async () => {
		const store: PolicyContextStore = {
			getLink: vi.fn(async () => null),
			dailyUsdTotal: vi.fn(async () => 0),
		};
		const adapter: PolicyFactsAdapter = {
			getPolicyFacts: vi.fn(async () => ({ usdValue: 0, issuerFacts: [] })),
		};
		await expect(
			gatherPolicyContext(
				build({ summary: { ...build().summary, account: 'rDifferentOwner' } }),
				policy(),
				store,
				adapter,
			),
		).rejects.toThrow('Build summary account must match transaction Account');
		expect(store.getLink).not.toHaveBeenCalled();
		expect(store.dailyUsdTotal).not.toHaveBeenCalled();
		expect(adapter.getPolicyFacts).not.toHaveBeenCalled();
	});

	it.each(['', ' 1', '-1', 'NaN', 'Infinity'])('rejects invalid adapter USD string %j', async (usdValue) => {
		const store: PolicyContextStore = {
			getLink: vi.fn(async () => null),
			dailyUsdTotal: vi.fn(async () => 0),
		};
		const adapter: PolicyFactsAdapter = {
			getPolicyFacts: vi.fn(async () => ({ usdValue, issuerFacts: [] })),
		};
		await expect(gatherPolicyContext(build(), policy(), store, adapter)).rejects.toThrow(PolicyContextError);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid numeric adapter USD value %s', async (usdValue) => {
		const store: PolicyContextStore = {
			getLink: vi.fn(async () => null),
			dailyUsdTotal: vi.fn(async () => 0),
		};
		const adapter: PolicyFactsAdapter = {
			getPolicyFacts: vi.fn(async () => ({ usdValue, issuerFacts: [] })),
		};
		await expect(gatherPolicyContext(build(), policy(), store, adapter)).rejects.toThrow(PolicyContextError);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid stored daily total %s', async (total) => {
		const store: PolicyContextStore = {
			getLink: vi.fn(async () => null),
			dailyUsdTotal: vi.fn(async () => total),
		};
		const adapter: PolicyFactsAdapter = {
			getPolicyFacts: vi.fn(async () => ({ usdValue: '0', issuerFacts: [] })),
		};
		await expect(gatherPolicyContext(build(), policy(), store, adapter)).rejects.toThrow(PolicyContextError);
	});
});

function deepFreeze(value: unknown): void {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
}
