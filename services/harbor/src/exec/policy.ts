import type { AccountLink, Network, Policy, PolicyResult, TxBuild } from '../contracts';
import {
	NEVER_DELEGATED_PERMISSIONS,
	NON_DELEGABLE_PERMISSION_NAMES,
	NON_DELEGABLE_PERMISSION_PREFIXES,
} from './delegation';

export interface PolicyIssuerFact {
	currency: string;
	issuer: string;
	requireAuth: boolean;
}

export type PolicyStableAsset = Pick<PolicyIssuerFact, 'currency' | 'issuer'>;

export interface PolicyEvaluationContext {
	policy: Policy;
	linkStatus: AccountLink['status'] | null;
	grantedPermissions: readonly string[];
	issuerFacts: readonly PolicyIssuerFact[];
	/** Optional run-specific tUSD/RLUSD fallback resolved by the facts adapter. */
	stableAsset?: PolicyStableAsset;
	usdValue: number;
	dailyUsdTotal: number;
}

/** The Store methods needed to gather policy inputs. */
export interface PolicyContextStore {
	getLink(
		owner: string,
		network: Network,
	): Promise<Pick<AccountLink, 'status' | 'permissions'> | null>;
	dailyUsdTotal(owner: string, network: Network): Promise<number>;
}

/**
 * The read-only H-path seam for issuer flags relevant to a built transaction.
 * Its implementation may inspect the transaction and read issuer AccountRoot
 * flags, but policy evaluation itself never performs I/O.
 */
export interface PolicyFactsAdapter {
	getPolicyFacts(build: TxBuild): Promise<{
		usdValue: string | number;
		issuerFacts: readonly PolicyIssuerFact[];
			stableAsset?: PolicyStableAsset;
	}>;
}

export class PolicyContextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PolicyContextError';
	}
}

type Reason = PolicyResult['reasons'][number];

const TRANSACTION_TYPE = /^[A-Za-z][A-Za-z0-9]*$/;
const neverDelegated = new Set<string>(NEVER_DELEGATED_PERMISSIONS);
const nonDelegable = new Set<string>(NON_DELEGABLE_PERMISSION_NAMES);
const RLUSD_ISSUERS: Readonly<Partial<Record<Network, string>>> = Object.freeze({
	testnet: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
	mainnet: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
});

/**
 * Evaluate a completed build against already-gathered policy facts.
 *
 * The reason order is part of the policy contract. A failed transaction-type
 * rule requests an owner signature; failures in the other safety rules block.
 */
export function evaluate(build: TxBuild, ctx: PolicyEvaluationContext): PolicyResult {
	const reasons: Reason[] = [];
	let hasBlockingFailure = false;
	let needsOwnerApproval = false;

	const networkAllowed = build.network !== 'mainnet' && ctx.policy.networks.includes(build.network);
	reasons.push({
		rule: 'network',
		pass: networkAllowed,
		detail:
			build.network === 'mainnet'
				? 'Mainnet execution is always blocked'
				: networkAllowed
					? `Network ${build.network} is allowed`
					: `Network ${build.network} is not allowed by policy`,
	});
	hasBlockingFailure ||= !networkAllowed;

	const transactionAccount = readTransactionAccount(build.tx_json);
	const accountMatches = transactionAccount !== null && transactionAccount === build.summary.account;
	const linkActive = ctx.linkStatus === 'active' && accountMatches;
	reasons.push({
		rule: 'link_active',
		pass: linkActive,
		detail: !accountMatches
			? 'Build summary account does not match transaction Account'
			: linkActive
				? 'Account link is active'
				: ctx.linkStatus === null
					? 'Account link is missing'
					: ctx.linkStatus === 'revoked'
						? 'Account link is revoked and requires owner approval'
						: `Account link is ${ctx.linkStatus}`,
	});
	if (!accountMatches || ctx.linkStatus === null || ctx.linkStatus === 'pending' || ctx.linkStatus === 'suspended') {
		hasBlockingFailure = true;
	} else if (ctx.linkStatus === 'revoked') {
		needsOwnerApproval = true;
	}

	const transactionType = readTransactionType(build.tx_json);
	const transactionTypeValid = transactionType !== null;
	const transactionTypeNeverDelegated = transactionTypeValid && neverDelegated.has(transactionType);
	const transactionTypeNonDelegable = transactionTypeValid && isNonDelegable(transactionType);
	const policyAllowsType = transactionTypeValid && ctx.policy.allowed_tx_types.includes(transactionType);
	const ledgerGrantsType = transactionTypeValid && ctx.grantedPermissions.includes(transactionType);
	const transactionTypePass =
		transactionTypeValid &&
		!transactionTypeNeverDelegated &&
		!transactionTypeNonDelegable &&
		policyAllowsType &&
		ledgerGrantsType;
	reasons.push({
		rule: 'transaction_type',
		pass: transactionTypePass,
		detail: transactionTypeDetail(
			transactionType,
			transactionTypeNeverDelegated,
			transactionTypeNonDelegable,
			policyAllowsType,
			ledgerGrantsType,
		),
	});
	needsOwnerApproval ||= !transactionTypePass;

	const issuedAssets = collectIssuedAssets(build.tx_json);
	const issuerFactsValid =
		ctx.issuerFacts.every(isIssuerFact) && hasExactIssuerFactCoverage(issuedAssets, ctx.issuerFacts);
	const disallowedIssuers = issuerFactsValid
		? ctx.issuerFacts.filter(
					(fact) => !isAllowlistedIssuer(build.network, fact, ctx.policy.issuer_allowlist, ctx.stableAsset),
			)
		: [];
	const issuersAllowed = issuerFactsValid && disallowedIssuers.length === 0;
	reasons.push({
		rule: 'issuer_allowlist',
		pass: issuersAllowed,
		detail: !issuerFactsValid
			? 'Issuer facts are invalid or incomplete for the transaction'
			: issuersAllowed
				? 'All transaction issuers are allowlisted'
				: `Issuer not allowlisted: ${disallowedIssuers.map(formatIssuer).join(', ')}`,
	});
	hasBlockingFailure ||= !issuersAllowed;

	const requireAuthIssuers = issuerFactsValid ? ctx.issuerFacts.filter((fact) => fact.requireAuth) : [];
	const requireAuthAllowed =
		issuerFactsValid && (!ctx.policy.block_requireauth_issuers || requireAuthIssuers.length === 0);
	reasons.push({
		rule: 'require_auth',
		pass: requireAuthAllowed,
		detail: !issuerFactsValid
			? 'Issuer facts are invalid or incomplete, so RequireAuth safety cannot be established'
			: !ctx.policy.block_requireauth_issuers
			? 'RequireAuth issuer blocking is disabled'
			: requireAuthAllowed
					? 'No transaction issuer requires authorization'
					: `RequireAuth issuer blocked: ${requireAuthIssuers.map(formatIssuer).join(', ')}`,
	});
	hasBlockingFailure ||= !requireAuthAllowed;

	const preflightFailures = readPreflightFailures(build.preflight);
	const preflightPassed = preflightFailures.length === 0 && build.preflight.length > 0;
	reasons.push({
		rule: 'preflight',
		pass: preflightPassed,
		detail:
			build.preflight.length === 0
				? 'Build contains no preflight checks'
				: preflightPassed
					? 'All build preflight checks passed'
					: `Preflight failed: ${preflightFailures.join(', ')}`,
	});
	hasBlockingFailure ||= !preflightPassed;

	const simulationPassed = build.simulate.engine_result === 'tesSUCCESS';
	reasons.push({
		rule: 'simulation',
		pass: simulationPassed,
		detail: simulationPassed ? 'Simulation returned tesSUCCESS' : `Simulation returned ${build.simulate.engine_result}`,
	});
	hasBlockingFailure ||= !simulationPassed;

	const slippage = build.summary.est_slippage_bps;
	const slippageLimitValid = isFiniteNonnegative(ctx.policy.max_slippage_bps);
	const slippageValid = slippage === undefined || isFiniteNonnegative(slippage);
	const slippagePassed = slippageLimitValid && slippageValid && (slippage === undefined || slippage <= ctx.policy.max_slippage_bps);
	reasons.push({
		rule: 'slippage',
		pass: slippagePassed,
		detail: !slippageLimitValid
			? 'Policy max_slippage_bps must be finite and nonnegative'
			: !slippageValid
				? 'Estimated slippage must be finite and nonnegative'
				: slippage === undefined
					? 'Build has no estimated slippage'
					: slippagePassed
						? `Estimated slippage ${slippage} bps is at or below ${ctx.policy.max_slippage_bps} bps`
						: `Estimated slippage ${slippage} bps exceeds ${ctx.policy.max_slippage_bps} bps`,
	});
	hasBlockingFailure ||= !slippagePassed;

	const usdValueValid = isFiniteNonnegative(ctx.usdValue);
	const maxPerTxValid = isFiniteNonnegative(ctx.policy.max_per_tx_usd);
	const perTransactionPassed = usdValueValid && maxPerTxValid && ctx.usdValue <= ctx.policy.max_per_tx_usd;
	reasons.push({
		rule: 'max_per_tx_usd',
		pass: perTransactionPassed,
		detail: !usdValueValid
			? 'USD value must be finite and nonnegative'
			: !maxPerTxValid
				? 'Policy max_per_tx_usd must be finite and nonnegative'
				: perTransactionPassed
					? `USD value ${ctx.usdValue} is at or below per-transaction maximum ${ctx.policy.max_per_tx_usd}`
					: `USD value ${ctx.usdValue} exceeds per-transaction maximum ${ctx.policy.max_per_tx_usd}`,
	});
	hasBlockingFailure ||= !perTransactionPassed;

	const dailyTotalValid = isFiniteNonnegative(ctx.dailyUsdTotal);
	const dailyCapValid = isFiniteNonnegative(ctx.policy.daily_cap_usd);
	const projectedDailyTotal = ctx.dailyUsdTotal + ctx.usdValue;
	const projectedDailyTotalValid = Number.isFinite(projectedDailyTotal) && projectedDailyTotal >= 0;
	const dailyCapPassed =
		usdValueValid && dailyTotalValid && dailyCapValid && projectedDailyTotalValid && projectedDailyTotal <= ctx.policy.daily_cap_usd;
	reasons.push({
		rule: 'daily_cap_usd',
		pass: dailyCapPassed,
		detail: !dailyTotalValid
			? 'Daily USD total must be finite and nonnegative'
			: !usdValueValid
				? 'USD value must be finite and nonnegative'
				: !dailyCapValid
					? 'Policy daily_cap_usd must be finite and nonnegative'
					: !projectedDailyTotalValid
						? 'Projected daily USD total must be finite and nonnegative'
						: dailyCapPassed
							? `Projected daily USD total ${projectedDailyTotal} is at or below cap ${ctx.policy.daily_cap_usd}`
							: `Projected daily USD total ${projectedDailyTotal} exceeds cap ${ctx.policy.daily_cap_usd}`,
	});
	hasBlockingFailure ||= !dailyCapPassed;

	const executeThresholdValid = isFiniteNonnegative(ctx.policy.execute_under_usd);
	const belowExecuteThreshold = usdValueValid && executeThresholdValid && ctx.usdValue < ctx.policy.execute_under_usd;
	reasons.push({
		rule: 'execute_under_usd',
		pass: belowExecuteThreshold,
		detail: !usdValueValid
			? 'USD value must be finite and nonnegative'
			: !executeThresholdValid
				? 'Policy execute_under_usd must be finite and nonnegative'
				: belowExecuteThreshold
					? `USD value ${ctx.usdValue} is below auto-execute threshold ${ctx.policy.execute_under_usd}`
					: maxPerTxValid && ctx.usdValue <= ctx.policy.max_per_tx_usd
						? `USD value ${ctx.usdValue} is at or above auto-execute threshold ${ctx.policy.execute_under_usd} and requires approval`
						: `USD value ${ctx.usdValue} exceeds per-transaction maximum ${ctx.policy.max_per_tx_usd}`,
	});
	hasBlockingFailure ||= !executeThresholdValid;
	needsOwnerApproval ||= !belowExecuteThreshold;

	return {
		verdict: hasBlockingFailure ? 'block' : needsOwnerApproval ? 'needs_approval' : 'execute',
		reasons,
	};
}

/** Gather the I/O-backed inputs once, then hand the immutable facts to evaluate. */
export async function gatherPolicyContext(
	build: TxBuild,
	policy: Policy,
	store: PolicyContextStore,
	adapter: PolicyFactsAdapter,
): Promise<PolicyEvaluationContext> {
	const owner = build.summary.account;
	if (typeof owner !== 'string' || owner.length === 0 || owner.trim() !== owner) {
		throw new PolicyContextError('Build summary account must be a non-empty string');
	}
	if (readTransactionAccount(build.tx_json) !== owner) {
		throw new PolicyContextError('Build summary account must match transaction Account');
	}
	const [link, dailyUsdTotal, policyFacts] = await Promise.all([
		store.getLink(owner, build.network),
		store.dailyUsdTotal(owner, build.network),
		adapter.getPolicyFacts(build),
	]);
	const usdValue = parseUsdValue(policyFacts.usdValue);
	if (!isFiniteNonnegative(dailyUsdTotal)) {
		throw new PolicyContextError('Store daily USD total must be finite and nonnegative');
	}
	if (!Array.isArray(policyFacts.issuerFacts)) {
		throw new PolicyContextError('XRPL issuer facts must be an array');
	}

	return {
		policy,
		linkStatus: link?.status ?? null,
		grantedPermissions: link === null ? [] : [...link.permissions],
		issuerFacts: policyFacts.issuerFacts.map((fact) => ({ ...fact })),
		...(policyFacts.stableAsset ? { stableAsset: { ...policyFacts.stableAsset } } : {}),
		usdValue,
		dailyUsdTotal,
	};
}

function readTransactionType(txJson: Record<string, unknown>): string | null {
	const value = txJson.TransactionType;
	return typeof value === 'string' && value.trim() === value && TRANSACTION_TYPE.test(value) ? value : null;
}

function readTransactionAccount(txJson: Record<string, unknown>): string | null {
	const value = txJson.Account;
	return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function transactionTypeDetail(
	type: string | null,
	isNeverDelegatedType: boolean,
	isNonDelegableType: boolean,
	policyAllows: boolean,
	ledgerGrants: boolean,
): string {
	if (type === null) return 'TransactionType must be a non-empty transaction type string';
	if (isNeverDelegatedType) return `${type} is never delegated and requires owner approval`;
	if (isNonDelegableType) return `${type} is non-delegable and requires owner approval`;
	if (!policyAllows && !ledgerGrants) return `${type} is neither allowed by policy nor granted on-ledger`;
	if (!policyAllows) return `${type} is not allowed by policy`;
	if (!ledgerGrants) return `${type} is not granted on-ledger`;
	return `${type} is allowed by policy and granted on-ledger`;
}

function isNonDelegable(type: string): boolean {
	return nonDelegable.has(type) || NON_DELEGABLE_PERMISSION_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function isIssuerFact(value: unknown): value is PolicyIssuerFact {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const fact = value as Partial<PolicyIssuerFact>;
	return (
		typeof fact.currency === 'string' &&
		fact.currency.length > 0 &&
		fact.currency.trim() === fact.currency &&
		typeof fact.issuer === 'string' &&
		fact.issuer.length > 0 &&
		fact.issuer.trim() === fact.issuer &&
		typeof fact.requireAuth === 'boolean'
	);
}

type IssuedAsset = Pick<PolicyIssuerFact, 'currency' | 'issuer'>;

function collectIssuedAssets(value: unknown): IssuedAsset[] {
	const assets = new Map<string, IssuedAsset>();
	const visit = (candidate: unknown): void => {
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (typeof candidate !== 'object' || candidate === null) return;
		const record = candidate as Record<string, unknown>;
		if (typeof record.currency === 'string' && typeof record.issuer === 'string') {
			const asset = { currency: record.currency, issuer: record.issuer };
			assets.set(formatIssuer({ ...asset, requireAuth: false }), asset);
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(value);
	return [...assets.values()];
}

function hasExactIssuerFactCoverage(
	assets: readonly IssuedAsset[],
	facts: readonly PolicyIssuerFact[],
): boolean {
	const assetKeys = new Set(assets.map((asset) => `${asset.currency}\u0000${asset.issuer}`));
	const factKeys = new Set(facts.map((fact) => `${fact.currency}\u0000${fact.issuer}`));
	return assetKeys.size === factKeys.size && [...assetKeys].every((key) => factKeys.has(key));
}

function isAllowlistedIssuer(
	network: Network,
	fact: PolicyIssuerFact,
	allowlist: readonly string[],
	stableAsset?: PolicyStableAsset,
): boolean {
	if (allowlist.includes(fact.issuer)) return true;
	const resolvedStableAsset =
		stableAsset ??
		(RLUSD_ISSUERS[network]
			? { currency: 'RLUSD', issuer: RLUSD_ISSUERS[network] }
			: undefined);
	return (
		allowlist.includes('RLUSD') &&
		resolvedStableAsset !== undefined &&
		fact.currency === resolvedStableAsset.currency &&
		fact.issuer === resolvedStableAsset.issuer
	);
}

function readPreflightFailures(
	checks: TxBuild['preflight'],
): string[] {
	return checks.flatMap((check) => {
		if (typeof check.check !== 'string' || check.check.length === 0 || check.check.trim() !== check.check) {
			return ['invalid preflight check'];
		}
		return check.pass ? [] : [check.detail ? `${check.check} (${check.detail})` : check.check];
	});
}

function formatIssuer(fact: PolicyIssuerFact): string {
	return `${fact.currency}/${fact.issuer}`;
}

function isFiniteNonnegative(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function parseUsdValue(value: string | number): number {
	if (typeof value === 'number') {
		if (!isFiniteNonnegative(value)) {
			throw new PolicyContextError('XRPL USD value must be finite and nonnegative');
		}
		return value;
	}
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new PolicyContextError('XRPL USD value must be a finite nonnegative numeric string');
	}
	const parsed = Number(value);
	if (!isFiniteNonnegative(parsed)) {
		throw new PolicyContextError('XRPL USD value must be a finite nonnegative numeric string');
	}
	return parsed;
}
