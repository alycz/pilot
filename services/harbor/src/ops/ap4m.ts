import { z } from 'zod';
import { decode, type Payment } from 'xrpl';

import type { OpContext, OpDef } from '../catalog/registry';
import {
	Ap4mReceiptSchema,
	Ap4mPublicEvidenceSchema,
	PolicySchema,
	type Mandate,
	type Merchant,
	type Policy,
} from '../contracts';
import {
	D1ChannelPurchaseStore,
	type ExecuteChannelPurchaseResult,
} from '../exec/channel-purchase';
import {
	buildMcIntent,
	buildAp4mMerchantL2Presentation,
	canonicalAp4mJson,
	mintAp4mViPair,
	type Ap4mCompactJwtSigner,
	type Ap4mViPair,
} from '../exec/ap4m-intent';
import {
	buildAp4mExactPayment,
	selectAp4mL2Disclosures,
	validateAp4mSignedPayment,
	type Ap4mLedgerPreparation,
} from '../exec/ap4m-purchase';
import {
	buildExactAp4mPublicEvidence,
} from '../exec/ap4m-evidence';
import {
	Ap4mTypedDataSchema,
	validateAp4mMerchantResponse,
	validateAp4mMerchantResponseBinding,
	type ValidatedAp4mResponse,
} from '../exec/ap4m-response';
import {
	Ap4mPurchaseStore,
	type Ap4mPreparedExecutionContext,
	type Ap4mPurchaseAttempt,
} from '../exec/ap4m-store';
import {
	encodeMastercardIntentHeader,
	xrplCurrencyCodeForAp4m,
	type ValidatedAp4mX402Challenge,
} from '../exec/ap4m-x402';
import { evaluateMandateGate } from '../exec/mandate-gate';
import { classifyAp4mSettlement } from '../exec/ap4m-settlement';
import { MandateStore, type StoredMandate } from '../exec/mandate-store';
import type { SignedTransaction } from '../exec/keys';
import {
	exchangeAp4mMerchant,
	recoverAp4mMerchant,
	type Ap4mMerchantExchangeInput,
	type Ap4mMerchantExchangeResult,
	type Ap4mMerchantHttpDependencies,
} from '../exec/ap4m-merchant-http';
import { Store } from '../exec/store';
import { X402PayerStore } from '../exec/x402-payer-store';
import {
	type PayerSequenceLeaseAuthority,
	type PayerSequenceLeaseIdentity,
	type PayerSequenceLeaseRow,
} from '../exec/payer-sequence-lease';
import { getCatalogMerchant } from './merchants';
import { selectAp4mSettlementRailId } from '../exec/settlement-rail';

type JsonObject = Record<string, unknown>;

const Identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const Ap4mPurchaseArgsSchema = z.object({
	mandate_id: Identifier,
	merchant_id: Identifier,
	sku: Identifier,
	idempotency_key: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();
export type Ap4mPurchaseArgs = z.infer<typeof Ap4mPurchaseArgsSchema>;

export type Ap4mPurchaseResult = ValidatedAp4mResponse;

export type Ap4mPayerResolution =
	| { status: 'ready'; payer: string }
	| { status: 'disabled'; payer: string }
	| { status: 'unavailable' };

export class Ap4mPurchaseError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'INVALID_PURCHASE'
			| 'MANDATE_NOT_ACTIVE'
			| 'POLICY_BLOCKED'
			| 'IDEMPOTENCY_MISMATCH'
			| 'PURCHASE_IN_PROGRESS'
			| 'SETTLEMENT_UNKNOWN'
			| 'PURCHASE_FAILED'
			| 'PAYER_FROZEN'
			| 'AP4M_NOT_CONFIGURED',
	) {
		super(message);
		this.name = 'Ap4mPurchaseError';
	}
}

export interface Ap4mExecutionMaterial {
	l1: string;
	l2: string;
	payer: string;
	credentialIds: readonly string[];
	preparation: Ap4mLedgerPreparation;
	agentKid: string;
	agentIssuer: string;
	networkAudience: string;
	merchantAudience: string;
	recoveryKek: CryptoKey | string;
	withAgentSigner<T>(callback: (signer: Ap4mCompactJwtSigner) => Promise<T>): Promise<T>;
}

export type Ap4mSettlementResult =
	| { status: 'validated'; evidence: unknown }
	| { status: 'pending' }
	| { status: 'expired_absent'; lookupCode: string; validatedLedgerIndex: number;
		firstEligibleLedgerIndex: number; inclusionLedgersChecked: readonly number[] };

type PurchaseStore = Pick<Ap4mPurchaseStore,
	'get' | 'claim' | 'acquireClaimRecovery' | 'readPreparedContext' | 'reserve' | 'acquireSigningLease' |
	'markSigned' | 'markSettlementUnknown' | 'cacheMerchantResponse' |
	'markSettled' | 'markDelivered' | 'markSigningFailed' | 'markFailed' | 'markExpiredAbsentFailed' |
	'markValidatedFailed'>;

type SequenceAuthority = Pick<PayerSequenceLeaseAuthority,
	'acquire' | 'get' | 'markSigningStarted' | 'markSigned' | 'markSettlementUnknown' |
	'releasePreSign' | 'releaseValidatedTerminal' | 'releaseExpiredAbsent'>;

export interface Ap4mPurchaseServices {
	store?: PurchaseStore;
	sequenceAuthority?(ctx: OpContext): SequenceAuthority;
	getMerchant?(id: string): Merchant | undefined;
	getMandate?(ctx: OpContext, id: string): Promise<StoredMandate | null>;
	getPolicy?(ctx: OpContext, owner: string): Promise<Policy | null>;
	getDailySpentUsd?(ctx: OpContext, mandateId: string, day: string): Promise<string>;
	getBaseDailySpentUsd?(ctx: OpContext, owner: string): Promise<number>;
	channelStore?: Pick<D1ChannelPurchaseStore, 'read'>;
	executeChannelPurchase?(input: Ap4mChannelDispatchInput): Promise<ExecuteChannelPurchaseResult>;
	resolvePayer?(ctx: OpContext, owner: string): Promise<Ap4mPayerResolution>;
	/** Legacy test seam. New runtime integrations should use resolvePayer. */
	getPayer?(ctx: OpContext, owner: string): Promise<string | null>;
	prepareExecution?(input: {
		ctx: OpContext;
		mandate: StoredMandate;
		merchant: Merchant;
		sku: string;
		payer: string;
	}): Promise<Ap4mExecutionMaterial>;
	getRecoveryKek?(input: { ctx: OpContext; mandate: StoredMandate }): Promise<CryptoKey | string>;
	mintVi?(input: {
		intent: ReturnType<typeof buildMcIntent>;
		challenge: ValidatedAp4mX402Challenge;
		material: Ap4mExecutionMaterial;
		mandate: StoredMandate;
		merchant: Merchant;
		sku: string;
		itemName: string;
		amountMinorUnits: number;
		now: Date;
	}): Promise<Ap4mViPair>;
	signPayment?(input: { ctx: OpContext; payment: Payment; payer: string }): Promise<SignedTransaction>;
	exchangeMerchant?(input: Ap4mMerchantExchangeInput): Promise<Ap4mMerchantExchangeResult>;
	merchantHttp?: Ap4mMerchantHttpDependencies;
	expectedSourceTag?: number;
	reconcile?(input: {
		ctx: OpContext;
		attempt: Ap4mPurchaseAttempt;
		payment?: Payment;
	}): Promise<Ap4mSettlementResult>;
	recoverMerchant?(input: {
		ctx: OpContext;
		attempt: Ap4mPurchaseAttempt;
		preparedContext: Ap4mPreparedExecutionContext;
		signed: SignedTransaction;
		expectedPayment: Payment;
	}): Promise<unknown>;
	now?(): Date;
	uuid?(): string;
	nonce?(): string;
	disclosureSalt?(): string;
	claimStaleMs?: number;
}

export interface Ap4mChannelDispatchInput {
	ctx: OpContext;
	mandate: StoredMandate;
	merchant: Merchant;
	product: Merchant['products'][number];
	payer: string;
	channel: Mandate['channels'][number];
	requestFingerprint: string;
	idempotencyKey: string;
}

type Ap4mContext = OpContext & {
	db?: D1Database;
	env?: unknown;
	ap4mServices?: Ap4mPurchaseServices;
};

function record(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function database(ctx: OpContext): D1Database {
	const typed = ctx as Ap4mContext;
	const db = typed.db ?? (record(typed.env) ? typed.env.DB as D1Database | undefined : undefined);
	if (!db) throw new Ap4mPurchaseError('AP4M storage is not configured', 'AP4M_NOT_CONFIGURED');
	return db;
}

function services(ctx: OpContext): Ap4mPurchaseServices {
	return (ctx as Ap4mContext).ap4mServices ?? {};
}

function sequenceAuthority(ctx: OpContext, deps: Ap4mPurchaseServices): SequenceAuthority {
	return required(deps.sequenceAuthority, 'AP4M shared payer-sequence authority')(ctx);
}

function sequenceIdentity(lease: PayerSequenceLeaseRow): PayerSequenceLeaseIdentity {
	if (lease.rail !== 'ap4m') {
		throw new Ap4mPurchaseError('Payer sequence is owned by another rail', 'PURCHASE_IN_PROGRESS');
	}
	return {
		network: lease.network,
		payer: lease.payer,
		generation: lease.generation,
		token: lease.token,
		rail: 'ap4m',
		attemptId: lease.attemptId,
	};
}

function expectedSourceTag(ctx: OpContext, deps: Ap4mPurchaseServices): number {
	const configured = deps.expectedSourceTag ?? (() => {
		const env = (ctx as Ap4mContext).env;
		const raw = record(env) ? env.HARBOR_SOURCE_TAG : undefined;
		if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw)) return Number.NaN;
		return Number(raw);
	})();
	if (!Number.isInteger(configured) || configured < 0 || configured > 0xffff_ffff) {
		throw new Ap4mPurchaseError('HARBOR_SOURCE_TAG is not configured', 'AP4M_NOT_CONFIGURED');
	}
	return configured;
}

function nowOf(value: Ap4mPurchaseServices): Date {
	const now = (value.now ?? (() => new Date()))();
	if (!Number.isFinite(now.getTime())) throw new Ap4mPurchaseError('AP4M clock is invalid', 'INVALID_PURCHASE');
	return now;
}

function uuidOf(value: Ap4mPurchaseServices): string {
	const uuid = (value.uuid ?? (() => crypto.randomUUID()))();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
		throw new Ap4mPurchaseError('AP4M identifier source is invalid', 'INVALID_PURCHASE');
	}
	return uuid.toLowerCase();
}

function dayOf(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function dollars(value: string): number {
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
		throw new Ap4mPurchaseError('Registry price is not a canonical USD amount', 'INVALID_PURCHASE');
	}
	const result = Number(value);
	if (!Number.isFinite(result) || result <= 0) throw new Ap4mPurchaseError('Registry price is invalid', 'INVALID_PURCHASE');
	return result;
}

function subtractReservedUsd(total: string, reserved: string): string {
	const parse = (value: string) => {
		if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) return null;
		const [whole, fraction = ''] = value.split('.');
		return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
	};
	const totalMicros = parse(total);
	const reservedMicros = parse(reserved);
	if (totalMicros === null || reservedMicros === null || reservedMicros <= 0n || totalMicros < reservedMicros) {
		throw new Ap4mPurchaseError('Durable payment-channel spend is inconsistent', 'PURCHASE_FAILED');
	}
	const remainder = totalMicros - reservedMicros;
	return `${remainder / 1_000_000n}.${(remainder % 1_000_000n).toString().padStart(6, '0')}`;
}

function minorUnits(value: string): number {
	const [whole, fraction = ''] = value.split('.');
	const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
	if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Ap4mPurchaseError('Registry price is outside the AP4M range', 'INVALID_PURCHASE');
	}
	return Number(result);
}

function product(merchant: Merchant, sku: string): Merchant['products'][number] {
	const matches = merchant.products.filter((candidate) => candidate.sku === sku);
	if (matches.length !== 1) throw new Ap4mPurchaseError('Registry does not contain exactly one requested product', 'INVALID_PURCHASE');
	const selected = matches[0]!;
	if (
		merchant.network !== 'testnet' ||
		canonicalAp4mJson(selected.price.asset) !== canonicalAp4mJson(merchant.settle_asset)
	) {
		throw new Ap4mPurchaseError('Product is not registered for Testnet settlement', 'INVALID_PURCHASE');
	}
	dollars(selected.price.value);
	return selected;
}

function requireExactProduct(merchant: Merchant, selected: Merchant['products'][number]): void {
	if (
		!merchant.schemes.includes('exact') || merchant.settle_asset.kind !== 'iou' ||
		selected.price.asset.kind !== 'iou'
	) {
		throw new Ap4mPurchaseError('Product is not registered for exact Testnet IOU settlement', 'INVALID_PURCHASE');
	}
}

function resourceUrl(merchant: Merchant, sku: string): string {
	return `${merchant.base_url.replace(/\/+$/, '')}/resource/${encodeURIComponent(sku)}`;
}

function basePolicy(policy: Policy, amount: number, baseDailySpent: number, currency: string) {
	const reasons = [
		{ rule: 'network', pass: policy.networks.includes('testnet'), detail: 'Policy must allow Testnet.' },
		{ rule: 'payment_type', pass: true, detail: 'This is the dedicated Harbor-self AP4M Payment path.' },
		{ rule: 'max_per_tx_usd', pass: amount <= policy.max_per_tx_usd, detail: 'Payment must remain within the policy per-transaction maximum.' },
		{ rule: 'daily_cap_usd', pass: Number.isFinite(baseDailySpent) && baseDailySpent >= 0 && baseDailySpent + amount <= policy.daily_cap_usd, detail: 'Payment must remain within the Harbor daily maximum.' },
		{ rule: 'issuer_allowlist', pass: policy.issuer_allowlist.includes(currency), detail: 'Stablecoin must be allowlisted by the policy.' },
	];
	return { verdict: reasons.every((reason) => reason.pass) ? 'execute' as const : 'block' as const, reasons };
}

async function sha256(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalAp4mJson(value)));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function strictReplay(row: Ap4mPurchaseAttempt): Ap4mPurchaseResult {
	if (!row.result) throw new Ap4mPurchaseError('Stored purchase result is missing', 'PURCHASE_FAILED');
	return {
		receipt: Ap4mReceiptSchema.parse(row.result.receipt),
		data: Ap4mTypedDataSchema.parse(row.result.data),
		...(row.result.evidence === undefined ? {} : {
			evidence: Ap4mPublicEvidenceSchema.parse(row.result.evidence),
		}),
	};
}

function strictChannelResult(
	value: ExecuteChannelPurchaseResult,
	input: Pick<Ap4mChannelDispatchInput, 'merchant' | 'product' | 'channel'> & { mandateId: string },
): Ap4mPurchaseResult {
	const receipt = Ap4mReceiptSchema.parse(value.result.receipt);
	const data = Ap4mTypedDataSchema.parse(value.result.data);
	const cumulative = receipt.proof.cumulative_drops;
	const channelAmount = input.channel.amount_drops;
	const checks = receipt.merchant_validation.checks;
	const proof = value.proof;
	if (
		receipt.mandate_id !== input.mandateId ||
		receipt.merchant_id !== input.merchant.id || receipt.sku !== input.product.sku ||
		receipt.scheme !== 'xrpl-paychan' || receipt.settlement !== 'claim_accepted' ||
		canonicalAp4mJson(receipt.amount) !== canonicalAp4mJson(input.product.price) ||
		receipt.proof.tx_hash !== undefined || receipt.proof.channel_id !== input.channel.channel_id ||
		!/^[A-F0-9]{64}$/.test(receipt.proof.channel_id ?? '') ||
		typeof cumulative !== 'string' || cumulative.length > 18 || !/^[1-9]\d*$/.test(cumulative) ||
		typeof channelAmount !== 'string' || channelAmount.length > 18 || !/^[1-9]\d*$/.test(channelAmount) ||
		BigInt(cumulative) > 100_000_000_000_000_000n ||
		BigInt(channelAmount) > 100_000_000_000_000_000n || BigInt(cumulative) > BigInt(channelAmount) ||
		!record(proof) || Object.keys(proof).sort().join(',') !==
			'channel_id,cumulative_drops,public_key,scheme,signature' ||
		proof.scheme !== 'xrpl-paychan' || proof.channel_id !== receipt.proof.channel_id ||
		proof.cumulative_drops !== cumulative ||
		typeof proof.signature !== 'string' || !/^[A-F0-9]+$/.test(proof.signature) ||
		proof.signature.length > 256 || proof.signature.length % 2 !== 0 ||
		typeof proof.public_key !== 'string' || !/^(?:ED|02|03)[A-F0-9]{64}$/.test(proof.public_key) ||
		data.schema_id !== input.product.response_schema_id ||
		!receipt.merchant_validation.validated || checks.agent_identity !== 'pass' ||
		checks.intent !== 'pass' || checks.credential !== 'pass' || checks.payment !== 'pass' ||
		receipt.merchant_validation.validation_errors.length !== 0 ||
		receipt.merchant_validation.intentId !== receipt.intent_id ||
		!Identifier.safeParse(receipt.receipt_id).success || !Identifier.safeParse(receipt.intent_id).success ||
		!/^[0-9a-f]{64}$/.test(receipt.l3a_digest) || !/^[0-9a-f]{64}$/.test(receipt.l3b_digest) ||
		!Number.isFinite(Date.parse(receipt.at)) || new Date(receipt.at).toISOString() !== receipt.at
	) {
		throw new Ap4mPurchaseError('Payment-channel result does not match the purchase', 'PURCHASE_FAILED');
	}
	return { receipt, data };
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Ap4mPurchaseError(`${label} is not configured`, 'AP4M_NOT_CONFIGURED');
	return value;
}

async function localMandate(ctx: OpContext, id: string): Promise<StoredMandate | null> {
	return new MandateStore(database(ctx), ctx.principal).get(id);
}

async function localPolicy(ctx: OpContext, owner: string): Promise<Policy | null> {
	return (await new Store(database(ctx), ctx.principal).getPolicy(owner, 'testnet'))?.json ?? null;
}

async function localDaily(ctx: OpContext, mandateId: string, day: string): Promise<string> {
	return (await new MandateStore(database(ctx), ctx.principal).dailySpentUsd(mandateId, day)).toFixed(6);
}

async function localBaseDaily(ctx: OpContext, owner: string): Promise<number> {
	return new Store(database(ctx), ctx.principal).dailyUsdTotal(owner, 'testnet');
}

async function localPayer(ctx: OpContext, owner: string): Promise<Ap4mPayerResolution> {
	const payer = await new X402PayerStore(database(ctx), ctx.principal).get(owner, 'testnet');
	if (payer?.status === 'ready') return { status: 'ready', payer: payer.payer };
	if (payer?.status === 'disabled') return { status: 'disabled', payer: payer.payer };
	return { status: 'unavailable' };
}

async function resolvePayer(
	ctx: OpContext,
	owner: string,
	deps: Ap4mPurchaseServices,
): Promise<Ap4mPayerResolution> {
	if (deps.resolvePayer) return deps.resolvePayer(ctx, owner);
	if (deps.getPayer) {
		const payer = await deps.getPayer(ctx, owner);
		return payer === null ? { status: 'unavailable' } : { status: 'ready', payer };
	}
	return localPayer(ctx, owner);
}

function exactChallenge(
	challenge: ValidatedAp4mX402Challenge,
	merchant: Merchant,
	price: Merchant['products'][number]['price'],
	url: string,
	sourceTag: number,
): void {
	if (
		challenge.resource.url !== url || challenge.network !== 'xrpl:1' || challenge.scheme !== 'exact' ||
		challenge.payTo !== merchant.xrpl_address || price.asset.kind !== 'iou' ||
		challenge.currency !== xrplCurrencyCodeForAp4m(price.asset.currency) ||
		challenge.issuer !== price.asset.issuer || challenge.sourceTag !== sourceTag ||
		Number(challenge.amount) > Number(price.value)
	) {
		throw new Ap4mPurchaseError('Merchant challenge does not match the registry purchase', 'INVALID_PURCHASE');
	}
}

function pendingError(): never {
	throw new Ap4mPurchaseError('Purchase settlement is not yet independently confirmed', 'SETTLEMENT_UNKNOWN');
}

function decodedPayment(row: Ap4mPurchaseAttempt): Payment {
	if (!row.signedBlob || !row.txHash) {
		throw new Ap4mPurchaseError('Signed recovery state is incomplete', 'PURCHASE_FAILED');
	}
	try {
		const payment = decode(row.signedBlob) as Payment & { SigningPubKey?: string; TxnSignature?: string };
		delete payment.SigningPubKey;
		delete payment.TxnSignature;
		return payment;
	} catch {
		throw new Ap4mPurchaseError('Signed recovery payment is invalid', 'SETTLEMENT_UNKNOWN');
	}
}

function persistedChallenge(context: Ap4mPreparedExecutionContext): ValidatedAp4mX402Challenge {
	return context.challenge as unknown as ValidatedAp4mX402Challenge;
}

function paidRequest(
	row: Ap4mPurchaseAttempt,
	context: Ap4mPreparedExecutionContext,
	expectedPayment: Payment,
) {
	if (!row.signedBlob || !row.txHash) {
		throw new Ap4mPurchaseError('Signed recovery state is incomplete', 'PURCHASE_FAILED');
	}
	return {
		signedPayment: { hash: row.txHash, tx_blob: row.signedBlob },
		expectedPayment,
		mastercardIntent: context.intent,
		viL1: context.vi.l1,
		viL2: context.vi.l2,
		viL3b: context.vi.l3b,
	};
}

/** Execute the fixed, registry-bound AP4M exact-payment state machine. */
export async function handleAp4mPurchase(ctx: OpContext, raw: Ap4mPurchaseArgs): Promise<Ap4mPurchaseResult> {
	const args = Ap4mPurchaseArgsSchema.parse(raw);
	const deps = services(ctx);
	const purchaseStore = deps.store ?? new Ap4mPurchaseStore(database(ctx), ctx.principal);
	const typedContext = ctx as Ap4mContext;
	const boundDatabase = typedContext.db ??
		(record(typedContext.env) ? typedContext.env.DB as D1Database | undefined : undefined);
	const channelStore = deps.channelStore ??
		(boundDatabase ? new D1ChannelPurchaseStore(boundDatabase, ctx.principal) : undefined);
	let payerSequenceIdentity: PayerSequenceLeaseIdentity | undefined;
	let payerSequenceSigningStarted = false;
	let payerSequenceAuthority: SequenceAuthority | undefined;
	const sequenceStore = () => payerSequenceAuthority ??= sequenceAuthority(ctx, deps);
	const persistSigned = async (
		token: string,
		signed: SignedTransaction,
		expectedPayment: Payment,
		at: string,
	): Promise<Ap4mPurchaseAttempt> => {
		const value = { hash: signed.hash, signedBlob: signed.tx_blob,
			lastLedgerSequence: expectedPayment.LastLedgerSequence!, at };
		const matches = (row: Ap4mPurchaseAttempt) =>
			(row.status === 'signed' || row.status === 'settlement_unknown' || row.status === 'settled' || row.status === 'delivered') &&
			row.txHash === value.hash && row.signedBlob === value.signedBlob &&
			row.lastLedgerSequence === value.lastLedgerSequence;
		let row: Ap4mPurchaseAttempt;
		try {
			const saved = await purchaseStore.markSigned(args.mandate_id, args.idempotency_key, token, value);
			if (saved.outcome === 'transitioned' || saved.outcome === 'replay' || matches(saved.row)) return saved.row;
			row = saved.row;
		} catch {
			try {
				const reread = await purchaseStore.get(args.mandate_id, args.idempotency_key);
				if (!reread) pendingError();
				row = reread;
			} catch {
				pendingError();
			}
			if (matches(row)) return row;
		}
		if (row.status !== 'prepared' || payerSequenceSigningStarted) pendingError();
		let failed;
		try {
			failed = await purchaseStore.markSigningFailed(args.mandate_id, args.idempotency_key, token, {
				code: 'signed_persistence_failed', signed_blob_persisted: false, hash_persisted: false,
			}, at);
		} catch {
			pendingError();
		}
		if (matches(failed.row)) return failed.row;
		if (failed.outcome === 'transitioned' || failed.outcome === 'replay') {
			throw new Ap4mPurchaseError('Signed payment could not be durably persisted', 'PURCHASE_FAILED');
		}
		pendingError();
	};
	const [initialExactAttempt, initialChannelRead] = await Promise.all([
		purchaseStore.get(args.mandate_id, args.idempotency_key),
		channelStore?.read(args.mandate_id, args.idempotency_key) ?? Promise.resolve({ outcome: 'absent' as const }),
	]);
	if (initialExactAttempt && initialChannelRead.outcome !== 'absent') {
		throw new Ap4mPurchaseError('Idempotency key belongs to multiple settlement rails', 'IDEMPOTENCY_MISMATCH');
	}
	let attempt = initialExactAttempt;
	if (attempt && (attempt.merchantId !== args.merchant_id || attempt.sku !== args.sku)) {
		throw new Ap4mPurchaseError('Idempotency key belongs to another purchase', 'IDEMPOTENCY_MISMATCH');
	}
	if (
		initialChannelRead.outcome !== 'absent' &&
		(initialChannelRead.attempt.merchantId !== args.merchant_id || initialChannelRead.attempt.sku !== args.sku)
	) {
		throw new Ap4mPurchaseError('Idempotency key belongs to another purchase', 'IDEMPOTENCY_MISMATCH');
	}
	if (attempt?.status === 'delivered') return strictReplay(attempt);
	if (initialChannelRead.outcome === 'delivered') {
		const snapshot = initialChannelRead.attempt.merchantSnapshot;
		const snapshotProduct = product(snapshot, args.sku);
		return strictChannelResult({
			result: initialChannelRead.result,
			proof: {
				scheme: 'xrpl-paychan',
				channel_id: initialChannelRead.attempt.channelId,
				cumulative_drops: initialChannelRead.attempt.cumulativeDrops,
				signature: initialChannelRead.attempt.signature!,
				public_key: initialChannelRead.attempt.publicKey,
			},
			replayed: true,
		}, {
			mandateId: args.mandate_id,
			merchant: snapshot,
			product: snapshotProduct,
			channel: {
				merchant_id: initialChannelRead.attempt.merchantId,
				channel_id: initialChannelRead.attempt.channelId,
				amount_drops: initialChannelRead.attempt.channelAmountDrops,
			},
		});
	}

	const getMandate = deps.getMandate ?? localMandate;
	const mandate = await getMandate(ctx, args.mandate_id);
	if (!mandate) {
		throw new Ap4mPurchaseError('Mandate is unavailable', 'MANDATE_NOT_ACTIVE');
	}

	let preparedContext: Ap4mPreparedExecutionContext | undefined;
	let recoveryKek: CryptoKey | string | undefined;
	const contextFor = async () => {
		recoveryKek ??= await required(deps.getRecoveryKek, 'AP4M recovery key')({ ctx, mandate });
		preparedContext ??= await purchaseStore.readPreparedContext(
			args.mandate_id, args.idempotency_key, recoveryKek,
		);
		return preparedContext;
	};
	const rememberSequenceLease = (lease: PayerSequenceLeaseRow) => {
		if (lease.rail !== 'ap4m' || !attempt || lease.attemptId !== attempt.id) {
			throw new Ap4mPurchaseError('Payer sequence lease does not match the AP4M attempt', 'SETTLEMENT_UNKNOWN');
		}
		payerSequenceIdentity = sequenceIdentity(lease);
		payerSequenceSigningStarted = lease.signingStartedAt !== null;
		return lease;
	};
	const requireSignedSequenceLease = async (context: Ap4mPreparedExecutionContext) => {
		if (!attempt?.txHash) pendingError();
		let lease = payerSequenceIdentity
			? await sequenceStore().get({ network: payerSequenceIdentity.network, payer: payerSequenceIdentity.payer })
			: await sequenceStore().get({ network: 'testnet', payer: context.payer });
		if (!lease || lease.rail !== 'ap4m' || lease.attemptId !== attempt.id) pendingError();
		lease = rememberSequenceLease(lease);
		if (lease.state === 'signing') {
			const bound = await sequenceStore().markSigned({
				...payerSequenceIdentity!, hash: attempt.txHash, at: nowOf(deps).toISOString(),
			});
			if (bound.outcome === 'blocked') pendingError();
			lease = rememberSequenceLease(bound.lease);
		}
		if (!['signed', 'settlement_unknown'].includes(lease.state) || lease.hash !== attempt.txHash) {
			pendingError();
		}
		return payerSequenceIdentity!;
	};
	const markSettlementUnknown = async (context: Ap4mPreparedExecutionContext, at: string) => {
		const identity = await requireSignedSequenceLease(context);
		const fenced = await sequenceStore().markSettlementUnknown({ ...identity, hash: attempt!.txHash!, at });
		if (fenced.outcome === 'blocked') pendingError();
		const stored = await purchaseStore.markSettlementUnknown(args.mandate_id, args.idempotency_key, at);
		if (stored.outcome !== 'transitioned' && stored.outcome !== 'replay') pendingError();
		attempt = stored.row;
	};
	const releasePersistedTerminalSequence = async (
		context: Ap4mPreparedExecutionContext,
		terminal: Ap4mPurchaseAttempt,
	) => {
		if (!terminal.txHash) return;
		const current = await sequenceStore().get({ network: 'testnet', payer: context.payer });
		if (!current || current.state === 'released' || current.rail !== 'ap4m' || current.attemptId !== terminal.id) {
			return;
		}
		if (!['signed', 'settlement_unknown'].includes(current.state) || current.hash !== terminal.txHash) {
			pendingError();
		}
		const identity = sequenceIdentity(current);
		const at = nowOf(deps).toISOString();
		if (terminal.status === 'settled' || terminal.status === 'delivered') {
			if (terminal.ledgerIndex === null) pendingError();
			const released = await sequenceStore().releaseValidatedTerminal({
				...identity,
				hash: terminal.txHash,
				at,
				evidence: { validated: true, transactionFound: true, ledgerIndex: terminal.ledgerIndex },
			});
			if (released.outcome === 'blocked') pendingError();
			return;
		}
		if (terminal.status !== 'failed' || !terminal.failure || terminal.lastLedgerSequence === null) pendingError();
		if (
			terminal.failure.code === 'validated_transaction_failure' &&
			typeof terminal.failure.validated_ledger_index === 'number'
		) {
			const released = await sequenceStore().releaseValidatedTerminal({
				...identity,
				hash: terminal.txHash,
				at,
				evidence: {
					validated: true,
					transactionFound: true,
					ledgerIndex: terminal.failure.validated_ledger_index,
				},
			});
			if (released.outcome === 'blocked') pendingError();
			return;
		}
		if (
			terminal.failure.code === 'expired_absent' &&
			typeof terminal.failure.validated_ledger_index === 'number' &&
			terminal.firstEligibleLedgerIndex !== null &&
			terminal.failure.checked_from === terminal.firstEligibleLedgerIndex &&
			terminal.failure.checked_through === terminal.lastLedgerSequence
		) {
			const checked = Array.from(
				{ length: terminal.lastLedgerSequence - terminal.firstEligibleLedgerIndex + 1 },
				(_, index) => terminal.firstEligibleLedgerIndex! + index,
			);
			const released = await sequenceStore().releaseExpiredAbsent({
				...identity,
				hash: terminal.txHash,
				lastLedgerSequence: terminal.lastLedgerSequence,
				at,
				evidence: {
					validated: true,
					transactionFound: false,
					validatedLedgerIndex: terminal.failure.validated_ledger_index,
					inclusionLedgersChecked: checked,
				},
			});
			if (released.outcome === 'blocked') pendingError();
			return;
		}
		pendingError();
	};
	let merchant: Merchant;
	let selected: Merchant['products'][number];
	if (initialChannelRead.outcome !== 'absent') {
		merchant = initialChannelRead.attempt.merchantSnapshot;
		selected = product(merchant, args.sku);
	} else if (attempt && attempt.status !== 'claimed') {
		const persisted = await contextFor();
		merchant = persisted.merchantSnapshot;
		selected = product(merchant, args.sku);
	} else {
		const catalogMerchant = (deps.getMerchant ?? getCatalogMerchant)(args.merchant_id);
		if (!catalogMerchant) throw new Ap4mPurchaseError('Merchant is not allowlisted', 'INVALID_PURCHASE');
		merchant = catalogMerchant;
		selected = product(merchant, args.sku);
	}
	const settlementRail = attempt
		? 'xrpl-exact' as const
		: initialChannelRead.outcome !== 'absent'
			? 'xrpl-paychan' as const
			: selectAp4mSettlementRailId({ merchant, channels: mandate.mandate.channels });
	if (settlementRail === 'xrpl-exact') requireExactProduct(merchant, selected);
	if (attempt?.status === 'failed') {
		if (attempt.txHash) await releasePersistedTerminalSequence(await contextFor(), attempt);
		throw new Ap4mPurchaseError('Purchase previously failed', 'PURCHASE_FAILED');
	}
	if (attempt?.status === 'prepared' && attempt.signingStartedAt !== null && attempt.txHash === null) {
		// A signer may have completed before crashing. Neither elapsed time nor a
		// missing blob/hash proves the sequence is reusable, so recovery is manual.
		pendingError();
	}
	const reconcileSigned = async () => {
		if (!attempt || !['signed', 'settlement_unknown', 'settled'].includes(attempt.status)) return;
		const at = nowOf(deps).toISOString();
		const context = await contextFor();
		if (attempt.status === 'settled') await releasePersistedTerminalSequence(context, attempt);
		const expectedPayment = decodedPayment(attempt);
		const recoverExactPaidRequest = async () => {
			let response: unknown;
			try {
				response = deps.recoverMerchant
					? await deps.recoverMerchant({ ctx, attempt: attempt!, preparedContext: context,
						signed: { hash: attempt!.txHash!, tx_blob: attempt!.signedBlob! }, expectedPayment })
					: await recoverAp4mMerchant({
						trustedRegistryUrl: context.resourceUrl,
						challenge: persistedChallenge(context), challengeState: context.challengeState,
						paidRequest: paidRequest(attempt!, context, expectedPayment), txHash: attempt!.txHash!,
					}, required(deps.merchantHttp, 'AP4M merchant HTTP recovery'));
			} catch {
				await markSettlementUnknown(context, at);
				pendingError();
			}
			let boundResponse;
			try {
				boundResponse = validateAp4mMerchantResponseBinding(response, {
					merchant: context.merchantSnapshot, sku: args.sku, intentId: context.intent.intentId,
				});
			} catch {
				await markSettlementUnknown(context, at);
				pendingError();
			}
			const cached = await purchaseStore.cacheMerchantResponse(args.mandate_id, args.idempotency_key, {
				response: boundResponse, at,
			});
			if (cached.outcome !== 'transitioned' && cached.outcome !== 'replay') pendingError();
			attempt = cached.row;
		};
		const reconcileOnce = async () => {
			try {
				return await required(deps.reconcile, 'AP4M settlement reconciliation')({
					ctx, attempt: attempt!, payment: expectedPayment,
				});
			} catch {
				await markSettlementUnknown(context, at);
				pendingError();
			}
		};
		if (attempt.status !== 'settled') {
			let settlement = await reconcileOnce();
			if (settlement.status === 'pending' && !attempt.merchantResponse) {
				await recoverExactPaidRequest();
				settlement = await reconcileOnce();
			}
			if (settlement.status === 'pending') {
				await markSettlementUnknown(context, at);
				pendingError();
			}
			if (settlement.status === 'expired_absent') {
				if (
					settlement.lookupCode === undefined || settlement.validatedLedgerIndex === undefined ||
					settlement.firstEligibleLedgerIndex === undefined || settlement.inclusionLedgersChecked === undefined
				) {
					await markSettlementUnknown(context, at);
					pendingError();
				}
				const identity = await requireSignedSequenceLease(context);
				const failed = await purchaseStore.markExpiredAbsentFailed(args.mandate_id, args.idempotency_key, {
					hash: attempt.txHash!, lookupCode: settlement.lookupCode,
					validatedLedgerIndex: settlement.validatedLedgerIndex,
					inclusionLedgersChecked: settlement.inclusionLedgersChecked, at,
				});
				if (failed.outcome !== 'transitioned' && failed.outcome !== 'replay') pendingError();
				attempt = failed.row;
				const released = await sequenceStore().releaseExpiredAbsent({
					...identity,
					hash: attempt.txHash!,
					lastLedgerSequence: attempt.lastLedgerSequence!,
					at,
					evidence: {
						validated: true,
						transactionFound: false,
						validatedLedgerIndex: settlement.validatedLedgerIndex,
						inclusionLedgersChecked: settlement.inclusionLedgersChecked,
					},
				});
				if (released.outcome === 'blocked') pendingError();
				throw new Ap4mPurchaseError('Purchase payment expired without ledger inclusion', 'PURCHASE_FAILED');
			}
			let classified;
			try {
				classified = classifyAp4mSettlement({
					signed: { hash: attempt.txHash!, tx_blob: attempt.signedBlob! },
					expectedPayment,
					evidence: settlement.evidence,
				});
			} catch {
				await markSettlementUnknown(context, at);
				pendingError();
			}
			if (classified.status === 'failed') {
				const identity = await requireSignedSequenceLease(context);
				const failed = await purchaseStore.markValidatedFailed(args.mandate_id, args.idempotency_key, {
					hash: classified.hash, validated: true, transactionFound: true,
					validatedLedgerIndex: classified.ledgerIndex,
					transactionResult: classified.transactionResult, at,
				});
				if (failed.outcome !== 'transitioned' && failed.outcome !== 'replay') pendingError();
				attempt = failed.row;
				const released = await sequenceStore().releaseValidatedTerminal({
					...identity,
					hash: classified.hash,
					at,
					evidence: { validated: true, transactionFound: true, ledgerIndex: classified.ledgerIndex },
				});
				if (released.outcome === 'blocked') pendingError();
				throw new Ap4mPurchaseError('Validated AP4M Payment failed', 'PURCHASE_FAILED');
			}
			const validated = classified.settlement;
			const identity = await requireSignedSequenceLease(context);
			const settled = await purchaseStore.markSettled(args.mandate_id, args.idempotency_key, {
				hash: validated.hash, ledgerIndex: validated.ledgerIndex,
				deliveredAmount: validated.deliveredAmount.value, at,
			});
			if (settled.outcome !== 'transitioned' && settled.outcome !== 'replay') {
				throw new Ap4mPurchaseError('Settlement state conflicted', 'PURCHASE_FAILED');
			}
			attempt = settled.row;
			const released = await sequenceStore().releaseValidatedTerminal({
				...identity,
				hash: validated.hash,
				at,
				evidence: { validated: true, transactionFound: true, ledgerIndex: validated.ledgerIndex },
			});
			if (released.outcome === 'blocked') pendingError();
		}
		if (!attempt.merchantResponse) {
			await recoverExactPaidRequest();
		}
		const result = validateAp4mMerchantResponse(attempt.merchantResponse, {
			receiptId: context.receiptId, mandateId: args.mandate_id,
			merchant: context.merchantSnapshot, sku: args.sku, intentId: context.intent.intentId,
			l3aDigest: context.vi.l3aDigest, l3bDigest: context.vi.l3bDigest,
			paidAmount: context.receiptAmount,
			settlement: { scheme: 'exact', settlement: 'validated', proof: { tx_hash: attempt.txHash! } }, at,
		});
		const evidence = await buildExactAp4mPublicEvidence({
			mandate: mandate.mandate,
			context,
			receipt: result.receipt,
			txHash: attempt.txHash!,
		});
		const delivered = await purchaseStore.markDelivered(args.mandate_id, args.idempotency_key, {
			result: { ...result, evidence },
			at,
		});
		if (delivered.outcome !== 'transitioned' && delivered.outcome !== 'replay') {
			throw new Ap4mPurchaseError('Purchase receipt could not be persisted', 'PURCHASE_FAILED');
		}
		return strictReplay(delivered.row);
	};

	if (attempt && ['signed', 'settlement_unknown', 'settled'].includes(attempt.status)) {
		return (await reconcileSigned())!;
	}
	if (mandate.mandate.status !== 'ACTIVE') {
		throw new Ap4mPurchaseError('Mandate is not active', 'MANDATE_NOT_ACTIVE');
	}
	const now = nowOf(deps);
	const at = now.toISOString();
	const day = dayOf(now);
	const getPolicy = deps.getPolicy ?? localPolicy;
	const policyValue = await getPolicy(ctx, mandate.mandate.owner);
	if (!policyValue) throw new Ap4mPurchaseError('AP4M policy is not configured', 'POLICY_BLOCKED');
	const policy = PolicySchema.parse(policyValue);
	const getDaily = deps.getDailySpentUsd ?? localDaily;
	const getBaseDaily = deps.getBaseDailySpentUsd ?? localBaseDaily;
	const [dailySpentUsd, baseDailySpentUsd] = await Promise.all([
		getDaily(ctx, args.mandate_id, day),
		getBaseDaily(ctx, mandate.mandate.owner),
	]);
	const asset = selected.price.asset;
	if (asset.kind !== 'iou') throw new Ap4mPurchaseError('Exact settlement asset is invalid', 'INVALID_PURCHASE');
	const reservedChannelAmount = initialChannelRead.outcome === 'pending'
		? initialChannelRead.attempt.amountUsd
		: undefined;
	const gateMandate = reservedChannelAmount === undefined ? mandate.mandate : {
		...mandate.mandate,
		spent_usd: subtractReservedUsd(mandate.mandate.spent_usd, reservedChannelAmount),
	};
	const gateDailySpent = reservedChannelAmount === undefined
		? dailySpentUsd
		: subtractReservedUsd(dailySpentUsd, reservedChannelAmount);
	const gate = evaluateMandateGate({
		policy: basePolicy(policy, dollars(selected.price.value), baseDailySpentUsd, asset.currency),
		settings: policy,
		mandate: gateMandate,
		merchantId: merchant.id,
		sku: selected.sku,
		amountUsd: selected.price.value,
		dailySpentUsd: gateDailySpent,
		now,
	});
	if (gate.verdict !== 'execute') throw new Ap4mPurchaseError('Harbor policy or mandate blocked the purchase', 'POLICY_BLOCKED');

	const existingContext = attempt?.status === 'prepared' ? await contextFor() : undefined;
	const payerResolution = await resolvePayer(ctx, mandate.mandate.owner, deps);
	if (payerResolution.status === 'disabled') {
		throw new Ap4mPurchaseError('AP4M payer is frozen', 'PAYER_FROZEN');
	}
	if (payerResolution.status !== 'ready') {
		throw new Ap4mPurchaseError('AP4M payer is not ready', 'AP4M_NOT_CONFIGURED');
	}
	const payer = existingContext?.payer ?? payerResolution.payer;
	if (payer !== payerResolution.payer) {
		throw new Ap4mPurchaseError('Prepared AP4M payer no longer matches the configured payer', 'AP4M_NOT_CONFIGURED');
	}
	const fingerprint = await sha256({
		principal: ctx.principal,
		mandate_id: args.mandate_id,
		merchant_id: merchant.id,
		sku: selected.sku,
	});
	if (settlementRail === 'xrpl-paychan') {
		const channels = initialChannelRead.outcome === 'pending'
			? [{
				merchant_id: initialChannelRead.attempt.merchantId,
				channel_id: initialChannelRead.attempt.channelId,
				amount_drops: initialChannelRead.attempt.channelAmountDrops,
			}]
			: mandate.mandate.channels.filter((channel) => channel.merchant_id === merchant.id);
		if (channels.length !== 1 || channels[0]!.merchant_id !== merchant.id) {
			throw new Ap4mPurchaseError('Mandate does not contain exactly one merchant channel', 'INVALID_PURCHASE');
		}
		const executed = await required(
			deps.executeChannelPurchase,
			'AP4M payment-channel executor',
		)({
			ctx,
			mandate,
			merchant,
			product: selected,
			payer,
			channel: channels[0]!,
			requestFingerprint: fingerprint,
			idempotencyKey: args.idempotency_key,
		});
		return strictChannelResult(executed, {
			mandateId: mandate.mandate.id,
			merchant,
			product: selected,
			channel: channels[0]!,
		});
	}
	let claim: Awaited<ReturnType<PurchaseStore['claim']>>;
	if (!attempt) {
		claim = await purchaseStore.claim({
			id: `ap4m-attempt-${uuidOf(deps)}`, mandateId: args.mandate_id,
			idempotencyKey: args.idempotency_key, requestFingerprint: fingerprint,
			merchantId: merchant.id, sku: selected.sku, createdAt: at,
		});
		if (claim.outcome === 'mismatch') throw new Ap4mPurchaseError('Idempotency key belongs to another purchase', 'IDEMPOTENCY_MISMATCH');
		attempt = claim.row;
	} else {
		claim = { outcome: 'replay', row: attempt };
	}
	if (attempt.status === 'delivered') return strictReplay(attempt);
	if (attempt.status === 'failed') throw new Ap4mPurchaseError('Purchase previously failed', 'PURCHASE_FAILED');
	if (claim.outcome === 'replay' && attempt.status === 'claimed') {
		const staleMs = deps.claimStaleMs ?? 30_000;
		const staleBefore = new Date(now.getTime() - staleMs).toISOString();
		const recovery = await purchaseStore.acquireClaimRecovery(
			args.mandate_id, args.idempotency_key, attempt.leaseAcquiredAt, staleBefore, at,
		);
		if (recovery.outcome !== 'transitioned') {
			throw new Ap4mPurchaseError('Purchase is already in progress', 'PURCHASE_IN_PROGRESS');
		}
		claim = { outcome: 'claimed', row: recovery.row };
	}
	const acquirePayerSequence = async () => {
		if (payerSequenceIdentity) return payerSequenceIdentity;
		const acquired = await sequenceStore().acquire({
			network: 'testnet',
			payer,
			rail: 'ap4m',
			attemptId: attempt!.id,
			token: await sha256({ kind: 'ap4m-payer-sequence', attempt_id: attempt!.id, nonce: uuidOf(deps) }),
			at: nowOf(deps).toISOString(),
		});
		if (acquired.outcome === 'blocked') {
			throw new Ap4mPurchaseError('Payer sequence is already reserved', 'PURCHASE_IN_PROGRESS');
		}
		const lease = rememberSequenceLease(acquired.lease);
		if (lease.state !== 'preparing') pendingError();
		return payerSequenceIdentity!;
	};
	const releasePayerPreSign = async (releaseAt: string) => {
		if (!payerSequenceIdentity || payerSequenceSigningStarted) return;
		const released = await sequenceStore().releasePreSign({
			...payerSequenceIdentity,
			at: releaseAt,
			proof: {
				code: 'signing_never_began',
				signingStarted: false,
				signedBlobPersisted: false,
				hashPersisted: false,
			},
		});
		if (released.outcome === 'blocked') pendingError();
	};
	const markPayerSigningStarted = async (
		execution: Ap4mExecutionMaterial,
		payment: Payment,
		signingAt: string,
	) => {
		const identity = await acquirePayerSequence();
		const lastLedgerSequence = payment.LastLedgerSequence;
		if (typeof lastLedgerSequence !== 'number') pendingError();
		const started = await sequenceStore().markSigningStarted({
			...identity,
			sequence: execution.preparation.sequence,
			firstEligibleLedgerIndex: execution.preparation.validatedLedgerIndex + 1,
			lastLedgerSequence,
			at: signingAt,
		});
		if (started.outcome === 'blocked') pendingError();
		rememberSequenceLease(started.lease);
		payerSequenceSigningStarted = true;
	};
	const markPayerSigned = async (hash: string, signedAt: string) => {
		if (!payerSequenceIdentity || !payerSequenceSigningStarted) pendingError();
		const signed = await sequenceStore().markSigned({ ...payerSequenceIdentity, hash, at: signedAt });
		if (signed.outcome === 'blocked') pendingError();
		rememberSequenceLease(signed.lease);
	};

	let material: Ap4mExecutionMaterial | undefined;
	let expectedPayment: Payment | undefined;
	const prepare = async () => {
		await acquirePayerSequence();
		material ??= await required(deps.prepareExecution, 'AP4M execution preparation')({
			ctx, mandate, merchant, sku: selected.sku, payer,
		});
		if (material.payer !== payer) throw new Ap4mPurchaseError('Prepared payer does not match the claimed payer', 'INVALID_PURCHASE');
		return material;
	};

	const newIntent = attempt.status === 'claimed' ? buildMcIntent({
			merchantId: merchant.id,
			merchantName: merchant.name,
			srcDpaId: merchant.src_dpa_id,
			sku: selected.sku,
			itemName: selected.name,
			priceUsd: selected.price.value,
		}, { now: () => now, uuid: () => uuidOf(deps) }) : undefined;
	const url = resourceUrl(merchant, selected.sku);
	const exchange = deps.exchangeMerchant ?? (deps.merchantHttp
		? (input: Ap4mMerchantExchangeInput) => exchangeAp4mMerchant(input, deps.merchantHttp!)
		: undefined);
	if (attempt.status === 'claimed') {
		let reservedWithoutHash = false;
		try {
			const exchanged = await required(exchange, 'AP4M merchant HTTP exchange')({
				trustedRegistryUrl: url,
				challenge: {
					network: 'testnet', merchantPayTo: merchant.xrpl_address,
					expectedAsset: { currency: asset.currency, issuer: asset.issuer },
					maxAmount: selected.price.value, expectedSourceTag: expectedSourceTag(ctx, deps),
				},
				preparePaidRequest: async (challenge, challengeState) => {
					exactChallenge(challenge, merchant, selected.price, url, expectedSourceTag(ctx, deps));
					const execution = await prepare();
					const intent = newIntent!;
					const l2 = selectAp4mL2Disclosures({ l2: execution.l2, merchantId: merchant.id, sku: selected.sku });
					const merchantL2 = buildAp4mMerchantL2Presentation(l2);
					const pair = deps.mintVi ? await deps.mintVi({
						intent, challenge, material: execution, mandate, merchant,
						sku: selected.sku, itemName: selected.name,
						amountMinorUnits: minorUnits(challenge.amount), now,
					}) : await execution.withAgentSigner((signer) => mintAp4mViPair({
						intent,
						paymentTerms: { scheme: 'exact', network: 'testnet', currency: challenge.currency,
							issuer: challenge.issuer, amount: challenge.amount, payTo: challenge.payTo },
						merchant: { id: merchant.id, name: merchant.name, website: execution.merchantAudience },
						sku: selected.sku, itemName: selected.name, amountMinorUnits: minorUnits(challenge.amount),
						paymentInstrument: { type: 'xrpl.ap4m', id: payer },
						agentKid: execution.agentKid,
						agentPublicJwk: mandate.mandate.agent_public_jwk as unknown as JsonWebKey,
						agentIssuer: execution.agentIssuer, networkAudience: execution.networkAudience,
						merchantAudience: execution.merchantAudience, l2,
					}, { now: () => now, nonce: deps.nonce ?? (() => uuidOf(deps)),
						disclosureSalt: deps.disclosureSalt ?? (() => uuidOf(deps)), signCompactJwt: signer }));
					preparedContext = {
						intent,
						merchantSnapshot: { ...merchant, products: [selected] },
						vi: { l1: execution.l1, l2: merchantL2, l3a: pair.l3a, l3b: pair.l3b,
							l3aDigest: pair.l3aDigest, l3bDigest: pair.l3bDigest },
						challenge: challenge as unknown as JsonObject,
						challengeState,
						payer,
						acceptedRequirement: challenge.accepted as unknown as JsonObject,
						resourceUrl: url,
						receiptId: `ap4m-receipt-${uuidOf(deps)}`,
						receiptAmount: { asset, value: challenge.amount },
						retryHeaders: { 'x-mastercard-intent': encodeMastercardIntentHeader(intent),
							'x-vi-l1': execution.l1, 'x-vi-l2': merchantL2, 'x-vi-l3b': pair.l3b },
					};
					const reserveNow = nowOf(deps);
					const reserveAt = reserveNow.toISOString();
					const reserved = await purchaseStore.reserve({
						mandateId: args.mandate_id, idempotencyKey: args.idempotency_key,
						requestFingerprint: fingerprint, leaseAcquiredAt: attempt!.leaseAcquiredAt,
						spendId: `ap4m-spend-${uuidOf(deps)}`, spendDay: dayOf(reserveNow),
						amountUsd: challenge.amount, preparedContext: preparedContext!, preparedAt: reserveAt,
					}, execution.recoveryKek);
					if (reserved.outcome === 'spend-limit') throw new Ap4mPurchaseError('Mandate spend limit was exceeded', 'POLICY_BLOCKED');
					if (reserved.outcome !== 'reserved' && reserved.outcome !== 'replay') throw new Ap4mPurchaseError('Purchase reservation conflicted', 'IDEMPOTENCY_MISMATCH');
					attempt = reserved.row;
					reservedWithoutHash = true;
					if (attempt.status === 'prepared') {
						expectedPayment = await buildAp4mExactPayment({ payer, challenge,
							credentialIds: execution.credentialIds, intentId: preparedContext!.intent.intentId,
							l3aDigest: preparedContext!.vi.l3aDigest, preparation: execution.preparation });
						const signingToken = uuidOf(deps);
						const lease = await purchaseStore.acquireSigningLease(args.mandate_id, args.idempotency_key, {
							token: signingToken,
							firstEligibleLedgerIndex: execution.preparation.validatedLedgerIndex + 1,
							staleBefore: new Date(reserveNow.getTime() - (deps.claimStaleMs ?? 30_000)).toISOString(),
							at: reserveAt,
						});
						if (lease.outcome !== 'acquired' && lease.outcome !== 'owner') {
							throw new Ap4mPurchaseError('Purchase signing is already in progress', 'PURCHASE_IN_PROGRESS');
						}
						const signPayment = required(deps.signPayment, 'AP4M payment signer');
						await markPayerSigningStarted(execution, expectedPayment, reserveAt);
						let signed: SignedTransaction;
						try {
							signed = validateAp4mSignedPayment(await signPayment({ ctx, payment: expectedPayment, payer }), expectedPayment);
						} catch (error) {
							if (error instanceof Ap4mPurchaseError && error.code === 'PAYER_FROZEN') throw error;
							pendingError();
						}
						attempt = await persistSigned(signingToken, signed, expectedPayment, reserveAt);
						await markPayerSigned(signed.hash, reserveAt);
						reservedWithoutHash = false;
					}
					if (!preparedContext || !attempt.signedBlob || !attempt.txHash) throw new Ap4mPurchaseError('Signed recovery state is incomplete', 'PURCHASE_FAILED');
					if (!expectedPayment) {
						const decoded = decode(attempt.signedBlob) as Payment & { SigningPubKey?: string; TxnSignature?: string };
						delete decoded.SigningPubKey;
						delete decoded.TxnSignature;
						expectedPayment = decoded;
					}
					return { signedPayment: { hash: attempt.txHash, tx_blob: attempt.signedBlob }, expectedPayment,
						mastercardIntent: preparedContext.intent, viL1: preparedContext.vi.l1,
						viL2: preparedContext.vi.l2, viL3b: preparedContext.vi.l3b };
				},
			});
			if (exchanged.txHash !== attempt.txHash) throw new Ap4mPurchaseError('Merchant exchange hash does not match persisted payment', 'SETTLEMENT_UNKNOWN');
			const cached = await purchaseStore.cacheMerchantResponse(args.mandate_id, args.idempotency_key, {
				response: validateAp4mMerchantResponseBinding(exchanged.merchantResponse, {
					merchant: preparedContext!.merchantSnapshot,
					sku: args.sku,
					intentId: preparedContext!.intent.intentId,
				}), at,
			});
			if (cached.outcome !== 'transitioned' && cached.outcome !== 'replay') throw new Ap4mPurchaseError('Merchant response conflicts with prior state', 'SETTLEMENT_UNKNOWN');
			attempt = cached.row;
		} catch (error) {
			if (attempt.txHash) {
				const context = preparedContext ?? await contextFor();
				await markSettlementUnknown(context, at);
				pendingError();
			}
			await releasePayerPreSign(nowOf(deps).toISOString());
			if (reservedWithoutHash && !payerSequenceSigningStarted) {
				await purchaseStore.markFailed(args.mandate_id, args.idempotency_key, {
					code: 'pre_hash_failure', signed_blob_persisted: false, hash_persisted: false,
				}, nowOf(deps).toISOString());
			}
			throw error;
		}
	}
	if (attempt.status === 'prepared') {
		// A persisted challenge is never reacquired. Recovery signs only after the
		// active/policy gates above and uses the exact encrypted payer/challenge.
		try {
			const context = await contextFor();
			const execution = await prepare();
			const challenge = persistedChallenge(context);
			expectedPayment = await buildAp4mExactPayment({ payer: context.payer, challenge,
				credentialIds: execution.credentialIds, intentId: context.intent.intentId,
				l3aDigest: context.vi.l3aDigest, preparation: execution.preparation });
			const leaseAt = nowOf(deps).toISOString();
			const signingToken = uuidOf(deps);
			const leaseNow = new Date(leaseAt);
			const lease = await purchaseStore.acquireSigningLease(args.mandate_id, args.idempotency_key, {
				token: signingToken,
				firstEligibleLedgerIndex: execution.preparation.validatedLedgerIndex + 1,
				staleBefore: new Date(leaseNow.getTime() - (deps.claimStaleMs ?? 30_000)).toISOString(),
				at: leaseAt,
			});
			if (lease.outcome !== 'acquired' && lease.outcome !== 'owner') {
				throw new Ap4mPurchaseError('Purchase signing is already in progress', 'PURCHASE_IN_PROGRESS');
			}
			const signPayment = required(deps.signPayment, 'AP4M payment signer');
			await markPayerSigningStarted(execution, expectedPayment, leaseAt);
			let signed: SignedTransaction;
			try {
				signed = validateAp4mSignedPayment(await signPayment({
					ctx, payment: expectedPayment, payer: context.payer,
				}), expectedPayment);
			} catch (error) {
				if (error instanceof Ap4mPurchaseError && error.code === 'PAYER_FROZEN') throw error;
				pendingError();
			}
			attempt = await persistSigned(signingToken, signed, expectedPayment, leaseAt);
			await markPayerSigned(signed.hash, leaseAt);
		} catch (error) {
			await releasePayerPreSign(nowOf(deps).toISOString());
			throw error;
		}
	}
	return (await reconcileSigned())!;
}

export const ops: OpDef[] = [{
	name: 'ap4m.purchase',
	family: 'ap4m',
	summary: 'Purchase one allowlisted AP4M product under an active Testnet mandate.',
	tags: ['ap4m', 'mastercard', 'x402', 'requires-credential', 'testnet'],
	args: Ap4mPurchaseArgsSchema,
	returns: '{ receipt: Ap4mReceipt, data: Ap4mTypedData, evidence?: Ap4mPublicEvidence }',
	caveats: [],
	example: 'await harbor.ap4m.purchase({ mandate_id: "...", merchant_id: "venue-yield-desk", sku: "yield-report", idempotency_key: "request-uuid" })',
	handler: (ctx, args) => handleAp4mPurchase(ctx, args as Ap4mPurchaseArgs),
}];
